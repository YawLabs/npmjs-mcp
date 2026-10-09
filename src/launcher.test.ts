import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Resolve via import.meta.url so this works regardless of process.cwd(). The
// file lives one level below the repo root in both layouts -- src/ as written,
// dist/ for the compiled node:test run -- so the same hop reaches the root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = resolve(repoRoot, "bin", "npmjs-mcp.mjs");
const DIST_BIN = resolve(repoRoot, "dist", "index.js");
const PACKAGE_VERSION = (JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as { version: string })
  .version;

type Plan = "in-process" | "discover" | "handoff-node";
type RuntimePlan = (ctx: { mode: string; hostOam: string | undefined; sandbox: boolean }) => Plan;
type Candidate = { path: string; version: number[] | null };
type PickNewest = (candidates: Candidate[]) => Candidate | null;

/** Pull named declarations out of the launcher source, loudly. */
function extract(patterns: RegExp[]): string {
  const source = readFileSync(LAUNCHER, "utf-8");
  return patterns
    .map((pattern) => {
      const match = source.match(pattern);
      if (!match) throw new Error(`could not extract ${pattern} from bin/npmjs-mcp.mjs -- renamed or reformatted?`);
      return match[0];
    })
    .join("\n");
}

const OAM_MIN_DECL = /const OAM_MIN = \[[^\]]*\];/;
const PARSE_VERSION_DECL = /function parseVersion\(text\) \{[\s\S]*?\n\}/;
const ATLEAST_DECL = /function atLeast\(v, min\) \{[\s\S]*?\n\}/;

/**
 * Evaluate the REAL `runtimePlan` source, together with the declarations it
 * closes over, without importing the launcher.
 *
 * Why not import it: the launcher's module body resolves a runtime at import
 * time and either spawns oam or imports the server, so importing it from a
 * test would launch a server. Making it importable would mean gating that body
 * behind an entry-point check -- a behaviour change to a shipped runtime
 * artifact whose failure mode (the guard reads false under an npm shim, and the
 * launcher silently does nothing) is worse than the gap this closes. This is
 * the same idiom tailscale-mcp's launcher test uses.
 *
 * Extracting the text exercises the shipped logic rather than a copy that can
 * drift, and a failed extraction is a loud assertion, not a silent skip.
 */
function loadRuntimePlan(): RuntimePlan {
  const pieces = extract([
    OAM_MIN_DECL,
    PARSE_VERSION_DECL,
    ATLEAST_DECL,
    /function runtimePlan\(\{ mode, hostOam, sandbox \}\) \{[\s\S]*?\n\}/,
  ]);
  return new Function(`${pieces}\nreturn runtimePlan;`)() as RuntimePlan;
}

function loadPickNewest(): { pickNewest: PickNewest; floor: number[] } {
  const pieces = extract([OAM_MIN_DECL, ATLEAST_DECL, /function pickNewest\(candidates\) \{[\s\S]*?\n\}/]);
  return new Function(`${pieces}\nreturn { pickNewest, floor: OAM_MIN };`)() as {
    pickNewest: PickNewest;
    floor: number[];
  };
}

describe("launcher runtimePlan()", () => {
  const runtimePlan = loadRuntimePlan();

  it("serves in-process when already hosted on an oam at or above the floor", () => {
    // The bug this exists for: a host that launches `oam run bin/npmjs-mcp.mjs`
    // got a SECOND oam, because the launcher discovered and spawned one without
    // asking what it was already running on. `auto` and `oam` both have to take
    // the shortcut -- `oam` demands oam, and the host already is one.
    //
    // 0.18.0 pins the floor as inclusive (it IS the supported release), and
    // 0.100.0 pins a numeric compare: it sorts BEFORE 0.18.0 as a string, so a
    // compare over the raw text would treat a newer oam as too old.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.18.0", "0.19.0", "0.100.0", "1.0.0", "0.19.0-dev"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "in-process", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("keeps spawning a fresh oam when the sandbox is requested, even on oam", () => {
    // `--permission` is a process-level flag: only a FRESH oam can apply it.
    // Serving in-process here would silently drop the sandbox the user asked
    // for -- a security downgrade that no other symptom would reveal, in a
    // process that may be holding an NPM_TOKEN.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of [undefined, "0.18.0", "0.19.0", "1.0.0", "0.17.0", "dev"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: true }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("never serves in-process on a host oam below the floor", () => {
    // Below the floor the host must hand off. Serving there was the bug: an oam
    // older than the latest release is not what the server is verified on, and
    // one older than 0.9.0 does not even hand over inherited stdio.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.17.0", "0.15.2", "0.9.0", "0.8.2", "0.0.1"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("discovers as before on Node, where process.versions has no oam key", () => {
    // An unreadable value must not count as "new enough" either: that would
    // skip discovery on a host that never proved it is a supported oam.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of [undefined, "", "dev"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("runs NPMJS_MCP_RUNTIME=node on Node: in-process on a Node host, handed off from any oam host", () => {
    // `node` outranks the sandbox: Node has no --permission to apply.
    for (const sandbox of [false, true]) {
      assert.equal(runtimePlan({ mode: "node", hostOam: undefined, sandbox }), "in-process", `sandbox=${sandbox}`);
      for (const hostOam of ["0.8.2", "0.18.0", "1.0.0", "dev"]) {
        assert.equal(
          runtimePlan({ mode: "node", hostOam, sandbox }),
          "handoff-node",
          `hostOam=${hostOam} sandbox=${sandbox}`,
        );
      }
    }
  });
});

describe("launcher pickNewest()", () => {
  const { pickNewest, floor } = loadPickNewest();
  const at = (path: string, version: number[] | null): Candidate => ({ path, version });

  it("pins the floor to the latest oam release", () => {
    assert.deepEqual(floor, [0, 18, 0]);
  });

  it("takes the newest usable oam, not the first one found", () => {
    // The bug: discovery stopped at the first binary that existed, so an older
    // copy in an earlier location (the installed dir is searched before PATH)
    // hid a newer one later.
    const chosen = pickNewest([at("installed", [0, 18, 0]), at("path-a", [0, 19, 0]), at("path-b", [0, 18, 9])]);
    assert.equal(chosen?.path, "path-a");
  });

  it("compares numerically and keeps search order on a tie", () => {
    assert.equal(pickNewest([at("a", [0, 19, 0]), at("b", [0, 100, 0])])?.path, "b");
    assert.equal(pickNewest([at("first", [0, 18, 0]), at("second", [0, 18, 0])])?.path, "first");
  });

  it("skips binaries below the floor or with no readable version", () => {
    assert.equal(pickNewest([at("old", [0, 9, 0]), at("broken", null), at("good", [0, 18, 0])])?.path, "good");
    assert.equal(pickNewest([at("old", [0, 17, 0]), at("broken", null)]), null);
    assert.equal(pickNewest([]), null);
  });
});

describe("launcher pipesStdio()", () => {
  const pipesStdio = new Function(
    `${extract([PARSE_VERSION_DECL, ATLEAST_DECL, /function pipesStdio\(hostOam\) \{[\s\S]*?\n\}/])}\nreturn pipesStdio;`,
  )() as (hostOam: string | undefined) => boolean;

  it("pipes only from an oam host from before 0.9.0, or one whose version cannot be read", () => {
    // Before 0.9.0 oam treated `stdio: 'inherit'` as 'pipe'. Every oam at the
    // floor hands the fds over, so the sandbox spawn and the NPMJS_MCP_RUNTIME=node
    // handoff -- both from an oam at the floor -- must not relay every byte.
    for (const hostOam of ["0.8.2", "0.0.1", "dev", ""]) assert.equal(pipesStdio(hostOam), true, hostOam);
    for (const hostOam of [undefined, "0.9.0", "0.17.0", "0.18.0", "1.0.0"]) {
      assert.equal(pipesStdio(hostOam), false, String(hostOam));
    }
  });
});

describe("launcher childEnv()", () => {
  type Env = Record<string, string | undefined>;
  const childEnv = new Function(
    `${extract([/function stripPermissionOptions\(value\) \{[\s\S]*?\n\}/, /function childEnv\(env, hostOam\) \{[\s\S]*?\n\}/])}\nreturn childEnv;`,
  )() as (env: Env, hostOam: string | undefined) => Env;

  it("drops --permission and every --allow-* from NODE_OPTIONS on an oam host, keeping the rest", () => {
    // oam 0.18.0 hands its permission flags to every child in NODE_OPTIONS. A
    // Node child refuses to start on oam's --allow-net (exit 9), and the sandboxed
    // oam would fold an inherited --allow-fs-read under its own grant list.
    const env = {
      PATH: "p",
      NODE_OPTIONS: "--no-warnings --permission --allow-fs-read=* --allow-net=x:443 --expose-gc",
    };
    const out = childEnv(env, "0.18.0");
    assert.equal(out.NODE_OPTIONS, "--no-warnings --expose-gc");
    assert.equal(out.PATH, "p");
    assert.equal(env.NODE_OPTIONS, "--no-warnings --permission --allow-fs-read=* --allow-net=x:443 --expose-gc");
  });

  it("removes NODE_OPTIONS entirely when only permission tokens were in it", () => {
    const out = childEnv({ NODE_OPTIONS: "--permission --allow-env=NPM_TOKEN" }, "0.18.0");
    assert.equal("NODE_OPTIONS" in out, false);
  });

  it("passes the environment through untouched on Node, or when there is nothing to strip", () => {
    const env = { NODE_OPTIONS: "--permission --allow-fs-read=*" };
    assert.equal(childEnv(env, undefined), env);
    const clean = { NODE_OPTIONS: "--no-warnings" };
    assert.equal(childEnv(clean, "0.18.0"), clean);
    const none = { PATH: "p" };
    assert.equal(childEnv(none, "0.18.0"), none);
  });
});

describe("launcher sandboxFlags()", () => {
  const sandboxFlags = new Function(
    `${extract([/function sandboxFlags\(\) \{[\s\S]*?\n\}/, /function netGrant\(url\) \{[\s\S]*?\n\}/])}\nreturn sandboxFlags;`,
  )() as () => string[];

  function flagsWith(env: Record<string, string>): string[] {
    const saved = { ...process.env };
    try {
      delete process.env.NPM_REGISTRY;
      Object.assign(process.env, { NPMJS_MCP_SANDBOX: "1" }, env);
      return sandboxFlags();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }
  const net = (flags: string[]) => flags.find((f) => f.startsWith("--allow-net="));

  it("port-scopes every grant: oam compares host:port exactly, and the server only speaks https", () => {
    assert.equal(net(flagsWith({})), "--allow-net=registry.npmjs.org:443,api.npmjs.org:443,replicate.npmjs.com:443");
  });

  it("grants a private registry its own port, or its scheme's default", () => {
    assert.match(net(flagsWith({ NPM_REGISTRY: "https://npm.corp.example:8443/" })) ?? "", /,npm\.corp\.example:8443$/);
    assert.match(net(flagsWith({ NPM_REGISTRY: "http://verdaccio.local/" })) ?? "", /,verdaccio\.local:80$/);
    assert.match(net(flagsWith({ NPM_REGISTRY: "https://npm.corp.example:443" })) ?? "", /,npm\.corp\.example:443$/);
    // The public registry by URL is already granted, so it is not repeated.
    assert.equal(net(flagsWith({ NPM_REGISTRY: "https://registry.npmjs.org/" }))?.split(",").length, 3);
    // A malformed one adds nothing: api.ts falls back to the public registry.
    assert.equal(net(flagsWith({ NPM_REGISTRY: "not a url" }))?.split(",").length, 3);
  });
});

describe("launcher remedyFor()", () => {
  type Remedy = (
    ctx: { passedOver: (number[] | null)[]; overrideMissing: boolean; shim: string | null },
    platform?: string,
    arch?: string,
  ) => string;
  const remedyFor = new Function(
    `${extract([OAM_MIN_DECL, /function remedyFor\([^)]*\) \{[\s\S]*?\n\}/])}\nreturn remedyFor;`,
  )() as Remedy;
  const none = { passedOver: [], overrideMissing: false, shim: null };

  it("tells an outdated oam to self-update, not to visit the website", () => {
    const text = remedyFor({ ...none, passedOver: [[0, 17, 0]] }, "win32", "arm64");
    assert.match(text, /Run `oam self-update` to get oam 0\.18\.0 or newer/);
    assert.doesNotMatch(text, /oamjs\.org/);
  });

  it("tells an unrunnable oam to check the binary, not to update it", () => {
    const text = remedyFor({ ...none, passedOver: [null] }, "linux", "x64");
    assert.match(text, /executable oam binary/);
    assert.doesNotMatch(text, /self-update|oamjs\.org/);
  });

  it("points a missing OAM_BIN somewhere real", () => {
    assert.match(remedyFor({ ...none, overrideMissing: true }, "darwin", "arm64"), /Point OAM_BIN at an existing/);
  });

  it("sends someone with no oam at all to install it, except where no build exists", () => {
    assert.match(remedyFor(none, "darwin", "arm64"), /Install oam from https:\/\/oamjs\.org/);
    assert.match(remedyFor(none, "linux", "x64"), /Install oam from https:\/\/oamjs\.org/);
    const arm = remedyFor(none, "linux", "arm64");
    assert.match(arm, /no build for linux-arm64/);
    assert.doesNotMatch(arm, /oamjs\.org/);
  });

  it("always offers Node", () => {
    for (const ctx of [none, { ...none, passedOver: [[0, 1, 0]] }]) {
      assert.match(remedyFor(ctx, "win32", "x64"), /NPMJS_MCP_RUNTIME=node/);
    }
  });
});

describe("launcher discoverOamPaths()", () => {
  it("searches OAM_INSTALL_DIR first", () => {
    const source = readFileSync(LAUNCHER, "utf-8");
    const isWinDecl = source.match(/const isWin = [^;]*;/)?.[0];
    const exeDecl = source.match(/const exe = [^;]*;/)?.[0];
    assert.ok(isWinDecl && exeDecl, "could not extract isWin / exe");
    const discoverOamPaths = new Function(
      "existsSync",
      "realpathSync",
      "homedir",
      "join",
      "delimiter",
      `${isWinDecl}\n${exeDecl}\n${extract([/function pathKey\(p\) \{[\s\S]*?\n\}/, /function discoverOamPaths\(\) \{[\s\S]*?\n\}/])}\nreturn discoverOamPaths;`,
    )(existsSync, realpathSync, homedir, join, delimiter) as () => string[];

    const installDir = mkdtempSync(join(tmpdir(), "npmjs-mcp-install-dir-"));
    const binary = join(installDir, process.platform === "win32" ? "oam.exe" : "oam");
    writeFileSync(binary, "");
    const saved = process.env.OAM_INSTALL_DIR;
    try {
      process.env.OAM_INSTALL_DIR = installDir;
      assert.equal(discoverOamPaths()[0], binary);
      delete process.env.OAM_INSTALL_DIR;
      assert.equal(discoverOamPaths().includes(binary), false);
    } finally {
      if (saved === undefined) delete process.env.OAM_INSTALL_DIR;
      else process.env.OAM_INSTALL_DIR = saved;
      rmSync(installDir, { recursive: true, force: true });
    }
  });
});

type LauncherRun = { stdout: string; stderr: string; code: number | null };

/**
 * Run the REAL bin under Node, optionally posing as oam by preloading a
 * `process.versions.oam` key, and return what it wrote.
 *
 * The unit tests above prove the decision; these prove the launcher WIRES it
 * -- that the call site actually reads `process.versions.oam` and the sandbox
 * grant list -- which no amount of testing `runtimePlan` in isolation can. A
 * real oam cannot be assumed on every box this suite runs on, and the preload
 * changes exactly the one fact the launcher branches on.
 *
 * OAM_BIN is pinned to the Node binary running this test, which makes the two
 * outcomes unmistakable without a real oam. In-process, `--version` reaches
 * dist/index.js and prints the package version with exit 0. On the discovery
 * path, the pinned Node answers `--version` with v20+, which clears the floor,
 * so it is chosen and the launcher spawns `node [flags] run <entry>` -- which
 * has no `run` subcommand, prints no version and exits non-zero. A usable
 * OAM_BIN is taken before discovery runs, so a real oam on the developer's box
 * is never reached either.
 *
 * Env is a whitelist so an NPMJS_MCP_* var exported by the developer's shell
 * cannot change what is being asserted.
 */
function launcherCommand(
  hostOam: string | undefined,
  extraEnv: Record<string, string>,
  extraPreload: string,
  args: string[],
): { argv: string[]; env: Record<string, string> } {
  // Every run also reports, at exit, what the LAUNCHER process's argv[1] ended
  // up as. runInProcess points it at dist/index.js; a handoff leaves it on the
  // launcher. That is the only way to tell "served in-process" from "handed
  // off to a child that printed the same version".
  const exitMarker = `import { writeSync } from "node:fs"; process.on("exit", () => { try { writeSync(2, "LAUNCHER_ARGV1=" + process.argv[1] + "\\n"); } catch {} });`;
  const posing =
    hostOam === undefined
      ? ""
      : `Object.defineProperty(process.versions, "oam", { value: ${JSON.stringify(hostOam)}, enumerable: true });`;
  const preload = ["--import", `data:text/javascript,${encodeURIComponent(`${exitMarker}${posing}${extraPreload}`)}`];
  return {
    argv: [...preload, LAUNCHER, ...args],
    env: { PATH: process.env.PATH ?? "", OAM_BIN: process.execPath, ...extraEnv },
  };
}

function runLauncher(
  hostOam: string | undefined,
  extraEnv: Record<string, string> = {},
  extraPreload = "",
): Promise<LauncherRun> {
  return new Promise((resolvePromise, reject) => {
    const { argv, env } = launcherCommand(hostOam, extraEnv, extraPreload, ["--version"]);
    const child = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    // `close` rather than `exit`, so both pipes have drained before asserting.
    child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
  });
}

type ServedRun = LauncherRun & { answered: boolean; exitedBeforeStdinEnd: boolean };

/**
 * Run the REAL bin the way a host does -- no `--version`, stdin held open, one
 * MCP `initialize` sent at once -- then, `holdMs` after the answer, end stdin
 * and wait for the launcher to exit.
 *
 * runLauncher cannot show a launcher that dies AFTER an in-process server has
 * started: the server handles `--version` during its own module evaluation and
 * exits before anything else queued on the event loop runs. A session held open
 * can.
 */
function serveLauncher(
  hostOam: string | undefined,
  extraEnv: Record<string, string>,
  extraPreload: string,
  holdMs: number,
): Promise<ServedRun> {
  return new Promise((resolvePromise, reject) => {
    const { argv, env } = launcherCommand(hostOam, extraEnv, extraPreload, []);
    const child = spawn(process.execPath, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let answered = false;
    let stdinEnded = false;
    // Never leave a server behind when it neither answers nor exits.
    const deadline = setTimeout(() => child.kill(), 30_000);
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "launcher-test", version: "0" } },
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (answered || !/"id":1[,}]/.test(stdout)) return;
      answered = true;
      setTimeout(() => {
        stdinEnded = true;
        child.stdin.end();
      }, holdMs);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolvePromise({ stdout, stderr, code, answered, exitedBeforeStdinEnd: !stdinEnded });
    });
    child.stdin.write(`${JSON.stringify(initialize)}\n`);
  });
}

// The in-process path imports dist/index.js, so the process-level tests need a
// build. `npm test` always builds first; skip rather than fail when the compiled
// test file is run on its own against a tree without one.
const skip = existsSync(DIST_BIN) ? false : "dist/index.js is not built";
// Each case boots one to three Node processes, and a bare Node start has been
// measured at ~11s on a contended Windows box.
const timeout = 45_000;

const servedInProcess = (run: LauncherRun) =>
  run.code === 0 && run.stdout.trim() === PACKAGE_VERSION && /LAUNCHER_ARGV1=.*dist[\\/]index\.js/.test(run.stderr);

describe("launcher on an oam host", () => {
  it("control: on plain Node the launcher still discovers and spawns", { skip, timeout }, async () => {
    // Without this, the in-process cases below would also pass for a launcher
    // that ALWAYS runs in-process and never uses oam at all.
    const run = await runLauncher(undefined);
    assert.equal(servedInProcess(run), false, `expected a spawn, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
  });

  it("serves in-process instead of spawning a nested oam", { skip, timeout }, async () => {
    const envs: Record<string, string>[] = [{}, { NPMJS_MCP_RUNTIME: "oam" }];
    for (const extraEnv of envs) {
      const run = await runLauncher("0.18.0", extraEnv);
      assert.equal(servedInProcess(run), true, `${JSON.stringify(extraEnv)} -> ${JSON.stringify(run)}`);
    }
  });

  it("still spawns under NPMJS_MCP_SANDBOX=1, so --permission is not dropped", { skip, timeout }, async () => {
    const run = await runLauncher("0.18.0", { NPMJS_MCP_SANDBOX: "1" });
    assert.equal(servedInProcess(run), false, `the sandbox must force a spawn, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
    // A spawned child failing, not the launcher diagnosing: every launcher
    // message starts with `npmjs-mcp: `.
    assert.doesNotMatch(run.stderr, /^npmjs-mcp: /m);
  });

  // Records what the launcher hands spawn(), and gives it the NODE_OPTIONS a
  // sandboxed oam parent would: oam 0.18.0 copies --permission / --allow-* there.
  // (writeSync is already imported by the exit marker launcherCommand prepends.)
  const recordSpawn = [
    'import childProcess from "node:child_process";',
    'import { syncBuiltinESMExports } from "node:module";',
    'process.env.NODE_OPTIONS = "--no-warnings --permission --allow-fs-read=* --allow-net=evil.example";',
    "const realSpawn = childProcess.spawn;",
    "childProcess.spawn = function (cmd, args, opts) {",
    '  writeSync(2, "SPAWN_STDIO=" + JSON.stringify(opts.stdio) + "\\n");',
    '  writeSync(2, "SPAWN_NODE_OPTIONS=" + JSON.stringify(opts.env.NODE_OPTIONS ?? null) + "\\n");',
    "  return realSpawn.call(this, cmd, args, opts);",
    "};",
    "syncBuiltinESMExports();",
  ].join("\n");

  it("inherits stdio for the sandbox spawn on an oam 0.18.0 host, with the permission tokens stripped", {
    skip,
    timeout,
  }, async () => {
    const run = await runLauncher("0.18.0", { NPMJS_MCP_SANDBOX: "1" }, recordSpawn);
    assert.match(run.stderr, /^SPAWN_STDIO="inherit"$/m, JSON.stringify(run));
    assert.match(run.stderr, /^SPAWN_NODE_OPTIONS="--no-warnings"$/m, JSON.stringify(run));
  });

  it("control: still pipes stdio from an oam host predating 0.9.0", { skip, timeout }, async () => {
    const run = await runLauncher("0.8.2", {}, recordSpawn);
    assert.match(run.stderr, /^SPAWN_STDIO=\["pipe","pipe","pipe"\]$/m, JSON.stringify(run));
  });

  it("still discovers when the host oam is below the floor", { skip, timeout }, async () => {
    const run = await runLauncher("0.17.0");
    assert.equal(servedInProcess(run), false, `a below-floor host must not shortcut, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
    assert.doesNotMatch(run.stderr, /^npmjs-mcp: /m);
  });
});

describe("launcher with no usable oam", () => {
  /**
   * An environment with no oam anywhere: HOME and LOCALAPPDATA point at an
   * empty directory, so the installed locations are empty, and PATH holds only
   * the directory of the Node running this test. Keeps a real oam on the
   * developer's box out of reach.
   */
  function isolated(extra: Record<string, string> = {}): Record<string, string> {
    const empty = mkdtempSync(join(tmpdir(), "npmjs-mcp-launcher-home-"));
    return {
      PATH: dirname(process.execPath),
      USERPROFILE: empty,
      HOME: empty,
      LOCALAPPDATA: empty,
      ...extra,
    };
  }
  const missingOamBin = join(tmpdir(), "no-such-dir", "oam.exe");

  it("names an OAM_BIN that does not exist instead of falling back silently", { skip, timeout }, async () => {
    const run = await runLauncher(undefined, isolated({ OAM_BIN: missingOamBin }));
    assert.equal(servedInProcess(run), true, JSON.stringify(run));
    assert.match(run.stderr, /^npmjs-mcp: OAM_BIN=.*does not exist; using Node instead\.$/m);
  });

  it("hands a below-floor oam host off to Node rather than serving on it", { skip, timeout }, async () => {
    const run = await runLauncher("0.9.0", isolated({ OAM_BIN: missingOamBin }));
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION, "the Node child must still serve");
    assert.match(
      run.stderr,
      /this process is oam 0\.9\.0, older than 0\.18\.0, and no newer oam was found; running on .*node/,
    );
    // Served by the child, not in the launcher process: argv[1] was never
    // pointed at dist/index.js.
    assert.match(run.stderr, /LAUNCHER_ARGV1=.*npmjs-mcp\.mjs/);
  });

  it("refuses to serve on a below-floor oam host when there is no Node either", { skip, timeout }, async () => {
    const empty = isolated();
    const noNode = mkdtempSync(join(tmpdir(), "npmjs-mcp-launcher-nopath-"));
    const run = await runLauncher("0.9.0", { ...empty, PATH: noNode, OAM_BIN: join(noNode, "oam.exe") });
    assert.equal(run.code, 1, JSON.stringify(run));
    assert.equal(run.stdout.trim(), "", "nothing may be served");
    assert.match(run.stderr, /no Node was found on PATH/);
  });

  it("hands NPMJS_MCP_RUNTIME=node off to Node even on a supported oam host", { skip, timeout }, async () => {
    // The host sits AT the floor, so this exercises the "node was asked for"
    // branch, not the below-floor handoff: no below-floor reason may appear.
    const run = await runLauncher("0.18.0", isolated({ NPMJS_MCP_RUNTIME: "node", NPMJS_MCP_SANDBOX: "1" }));
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION);
    assert.match(run.stderr, /LAUNCHER_ARGV1=.*npmjs-mcp\.mjs/);
    assert.doesNotMatch(run.stderr, /older than \d+\.\d+\.\d+/);
  });

  it("says a requested sandbox was dropped when auto falls back to Node", { skip, timeout }, async () => {
    const run = await runLauncher(undefined, isolated({ NPMJS_MCP_SANDBOX: "1", OAM_BIN: missingOamBin }));
    assert.equal(servedInProcess(run), true, JSON.stringify(run));
    assert.match(
      run.stderr,
      /^npmjs-mcp: OAM_BIN=.*does not exist; NPMJS_MCP_SANDBOX=1 is not applied .*; using Node instead\.$/m,
    );
  });

  it("serves on a supported oam host, unsandboxed and said so, when the sandbox finds no oam", {
    skip,
    timeout,
  }, async () => {
    // The host is itself a supported oam, so under `auto` the best-effort
    // sandbox degrades to the in-process shortcut -- not to a Node handoff.
    const run = await runLauncher("0.18.0", isolated({ NPMJS_MCP_SANDBOX: "1", OAM_BIN: missingOamBin }));
    assert.equal(servedInProcess(run), true, JSON.stringify(run));
    assert.match(run.stderr, /NPMJS_MCP_SANDBOX=1 is not applied .*; serving on this oam 0\.18\.0 process instead\.$/m);
  });

  it("makes an unavailable sandbox fatal under NPMJS_MCP_RUNTIME=oam", { skip, timeout }, async () => {
    const run = await runLauncher(
      "0.18.0",
      isolated({ NPMJS_MCP_SANDBOX: "1", NPMJS_MCP_RUNTIME: "oam", OAM_BIN: missingOamBin }),
    );
    assert.equal(run.code, 1, JSON.stringify(run));
    assert.equal(run.stdout.trim(), "", "nothing may be served");
    assert.match(run.stderr, /^npmjs-mcp: NPMJS_MCP_RUNTIME=oam but no usable oam \(0\.18\.0 or newer\) was found\.$/m);
    // The remedy names the cause that was seen -- a missing OAM_BIN -- and not a
    // reinstall nobody needs.
    assert.match(run.stderr, /^Point OAM_BIN at an existing oam binary, or unset it\.$/m);
    assert.doesNotMatch(run.stderr, /oamjs\.org/);
  });

  /**
   * The chosen binary passed its --version probe and then could not be spawned
   * (deleted or replaced in between). A failed spawn emits 'error' and then
   * 'close' with the negative errno, and on an oam host the launcher waits for
   * 'close' -- so an unguarded close handler exited the launcher mid-fallback
   * and nothing served. This preload makes the FIRST spawn target a path that
   * does not exist; any later spawn (the Node handoff) runs normally.
   */
  const failFirstSpawn = [
    'import childProcess from "node:child_process";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const realSpawn = childProcess.spawn;",
    "let failed = false;",
    "childProcess.spawn = function (cmd, args, opts) {",
    "  if (failed) return realSpawn.call(this, cmd, args, opts);",
    "  failed = true;",
    '  return realSpawn.call(this, cmd + ".does-not-exist", args, opts);',
    "};",
    "syncBuiltinESMExports();",
  ].join("\n");

  it("still falls back when the chosen oam fails to spawn on an oam host", { skip, timeout }, async () => {
    const run = await runLauncher("0.9.0", isolated({ OAM_BIN: process.execPath }), failFirstSpawn);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION, "the Node fallback must still serve");
    assert.match(run.stderr, /failed to launch oam at .*using Node instead/);
    // A failed launch is not "no newer oam was found": one was found.
    assert.match(
      run.stderr,
      /this process is oam 0\.9\.0, older than 0\.18\.0, and the oam chosen to replace it failed/,
    );
    assert.doesNotMatch(run.stderr, /no newer oam was found/);
    assert.match(run.stderr, /LAUNCHER_ARGV1=.*npmjs-mcp\.mjs/);
  });

  it("keeps serving on a supported oam host when the sandboxed oam fails to spawn", { skip, timeout }, async () => {
    // The same failure on the path only this server has: a supported oam host
    // reaches discovery because NPMJS_MCP_SANDBOX=1 needs a fresh oam, and the
    // documented `auto` fallback is to serve unsandboxed in THIS process. The
    // dead child's 'close' lands within milliseconds of its 'error'; the hold
    // gives it far longer than that to kill a session that is already serving.
    const run = await serveLauncher(
      "0.18.0",
      isolated({ NPMJS_MCP_SANDBOX: "1", OAM_BIN: process.execPath }),
      failFirstSpawn,
      1_500,
    );
    assert.equal(run.answered, true, `initialize must be answered: ${JSON.stringify(run)}`);
    assert.equal(run.exitedBeforeStdinEnd, false, `the launcher must outlive the dead child: ${JSON.stringify(run)}`);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.match(
      run.stderr,
      /^npmjs-mcp: failed to launch oam at .*; NPMJS_MCP_SANDBOX=1 is not applied .*; serving on this oam 0\.18\.0 process instead\.$/m,
    );
    assert.match(run.stderr, /LAUNCHER_ARGV1=.*dist[\\/]index\.js/);
  });
});
