#!/usr/bin/env node
/**
 * Runtime launcher for @yawlabs/npmjs-mcp.
 *
 * Prefers the oam runtime (https://oamjs.org) and falls back to the Node
 * process already running this file. The server itself (`dist/index.js`) is
 * runtime-agnostic -- a pre-bundled ESM file using only `node:` builtins that
 * oam implements -- so neither path changes behavior. Verified against the
 * real MCP surface on both: initialize, tools/list (64 tools), and a live
 * registry call all return identically.
 *
 * WHY THE FALLBACK COSTS NOTHING
 * The fallback does NOT re-exec node. npm already started a node process to
 * run this launcher, so falling back is a plain `import()` of the server into
 * THIS process: zero extra spawn, zero extra startup, byte-identical to
 * invoking `dist/index.js` directly. Users without oam pay only a handful of
 * `existsSync` calls.
 *
 * WHAT THE OAM PATH COSTS -- AND WHY YOU PROBABLY WANT TO SKIP THIS LAUNCHER
 * oam itself is FASTER than node for this server. Measured windows-arm64,
 * n=12 medians, spawn->first MCP `initialize` response over stdio:
 *
 *   oam dist/index.js .................. 116 ms   (0.67x node)
 *   node dist/index.js ................. 172 ms
 *   this launcher (node -> spawn oam) .. 243 ms   (1.41x node)
 *
 * The launcher is the slowest of the three. npm bin entries are node scripts,
 * so reaching oam through one means paying node's startup and THEN oam's,
 * which costs more than oam saves. The launcher exists so `npx` users get oam
 * automatically; it is not the fast path.
 *
 * For an MCP host config -- how this server is actually run -- point the host
 * straight at oam and skip this file entirely:
 *   { "command": "oam", "args": ["run", "<abs>/dist/index.js"] }
 *
 * MEASURING THIS YOURSELF: use an INSTALLED oam (~/.oam/bin), never one out of
 * a cargo `target/` directory. A build directory is not a stable place to
 * measure from -- a concurrent `cargo build` replaces the binary mid-run, and
 * fresh bytes are cold where the installed `node.exe` you are comparing against
 * is warm.
 *
 * Two corrections are baked into that sentence, both mine. An early revision
 * claimed oam was a cold-start REGRESSION; that was measured through a shell
 * wrapper whose fork/exec floor buried the signal. A later revision blamed an
 * on-access virus scanner rescanning build outputs on every exec, citing a 5.0x
 * penalty; that does not reproduce either -- the same comparison on a settled
 * tree gives 1.03x, and the original was taken while a sibling session was
 * rebuilding oam underneath it.
 *
 * The numbers above are the ones that survive: installed binary, quiet machine,
 * interleaved, n=12. oam is pre-alpha -- re-measure on your own hardware.
 *
 * THE `--permission` SANDBOX (oam 0.9.0+, opt-in)
 * This used to be a "deliberately not done" note: oam's `--permission` denied
 * network with no grant to open it, so the server completed the MCP handshake
 * and then failed every tool call. oam 0.8.3 added `--allow-net` / `--allow-env`
 * and the note is now obsolete -- `NPMJS_MCP_SANDBOX=1` opts in.
 *
 * It is opt-in rather than default because a wrong grant list does NOT fail
 * loudly. Measured on 0.9.0 with `--allow-net=registry.npmjs.org` alone:
 * `npm_downloads` failed outright, but `npm_health` returned HTTP 200 with
 * `weeklyDownloads: null` and no error at all -- the download counts come from
 * api.npmjs.org, a second host. A silently half-populated answer is worse than
 * a refusal, so the grant list below is derived from the shipped bundle rather
 * than guessed, and a private registry has to be declared via NPM_REGISTRY.
 *
 * Same hazard, worse, for the environment: oam denies a non-granted variable by
 * making it ABSENT from process.env rather than throwing (its divergence notes
 * call this out -- process.env is a snapshot with no per-property hook). An
 * under-granted NPM_TOKEN therefore reads as "unauthenticated", not "denied".
 * The env list is the exact set the bundle reads.
 *
 * What the sandbox buys: filesystem and subprocess are denied outright. This
 * server reads no files at runtime (its version is baked in at build time) and
 * spawns nothing, so a dependency that suddenly wants either is stopped by the
 * runtime rather than trusted -- meaningful for a process holding an NPM_TOKEN.
 *
 * MINIMUM OAM VERSION
 * 0.9.0. Below it `child_process.execFile` ran its arguments through a SHELL,
 * `exec`'s `timeout` was accepted and ignored, and `spawnSync` truncated at
 * `maxBuffer` while reporting success. This server spawns nothing, so the floor
 * is enforced here for consistency with the rest of @yawlabs/*-mcp rather than
 * because this launcher is exposed. An older oam is not an error: the launcher
 * falls back to Node and says why on stderr.
 *
 * SELECTION
 *   NPMJS_MCP_RUNTIME=oam    require oam; fail loudly if it is missing
 *   NPMJS_MCP_RUNTIME=node   never use oam
 *   NPMJS_MCP_RUNTIME=auto   prefer oam, silently fall back (default)
 *   NPMJS_MCP_SANDBOX=1      run oam under --permission (oam 0.9.0+)
 *   OAM_BIN=/path/to/oam     explicit binary, checked before any discovery
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Oldest oam whose `child_process` matches Node. See MINIMUM OAM VERSION above. */
const OAM_MIN = [0, 9, 0];

// Two forms, deliberately. `import()` on Windows REJECTS a bare `C:\...` path
// with ERR_UNSUPPORTED_ESM_URL_SCHEME (it reads `c:` as a protocol), so the
// in-process fallback must use the file:// URL. spawn(), conversely, needs a
// real filesystem path.
const SERVER_URL = new URL("../dist/index.js", import.meta.url);
const SERVER_ENTRY = fileURLToPath(SERVER_URL);
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

/**
 * Locate an oam binary, or null. Ordered most-explicit-first; every branch is
 * a stat, never a subprocess, so the miss case -- the common one for users who
 * have never heard of oam -- stays sub-millisecond.
 */
function findOam() {
  // 1. Explicit override wins and is never second-guessed.
  const override = process.env.OAM_BIN;
  if (override) return existsSync(override) ? override : null;

  // 2. Installed locations, BEFORE PATH. Someone who develops oam itself
  //    usually has oam/target/release on PATH, and a build directory is the
  //    wrong thing for a user-facing launcher to bind to: cargo replaces the
  //    binary underneath running processes, and the dev build is not the
  //    release the user installed. Preferring the installed copy makes the
  //    default path "what a normal user has", and OAM_BIN remains the way to
  //    point deliberately at a dev build.
  //
  //    Both forms are checked on Windows: the installer defaults to
  //    %LOCALAPPDATA%oamin there, but oam's docs name ~/.oam/bin first and
  //    OAM_INSTALL_DIR can pick either, so checking one silently misses a real
  //    install.
  const installed = [join(homedir(), ".oam", "bin", exe)];
  if (isWin) {
    installed.unshift(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe));
  }
  for (const candidate of installed) {
    if (existsSync(candidate)) return candidate;
  }

  // 3. PATH, resolved manually rather than by spawning `which`/`where`, which
  //    would cost a subprocess on every launch just to decide whether to spawn.
  const pathExt = isWin ? (process.env.PATHEXT ?? ".EXE").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of isWin ? pathExt : [""]) {
      const candidate = join(dir, isWin ? `oam${ext.toLowerCase()}` : "oam");
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * `oam --version` -> [major, minor, patch], or null when it cannot be read.
 * The output is `oam 0.9.0`; a pre-release suffix (`0.9.0-rc.1`) is truncated
 * at the first non-numeric character so it compares as its base version.
 */
function oamVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    // Not executable, wrong arch, or deleted since the stat. Caller degrades.
    return null;
  }
}

/** True when `v` is at least `min`, comparing major/minor/patch in order. */
function atLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

/**
 * The `--permission` grant list, or [] when the sandbox is not requested.
 *
 * These are oam's PROCESS-level flags: they go before the `run` subcommand, not
 * after it. `oam run --permission file.js` is rejected outright ("unexpected
 * argument '--permission' found"), which is a good failure -- but only because
 * it is loud. Ordering here is load-bearing.
 *
 * Net grants are matched by prefix against `host` for fetch and `host:port` for
 * sockets, so a bare hostname covers both.
 */
function sandboxFlags() {
  if (process.env.NPMJS_MCP_SANDBOX !== "1") return [];

  // Every host the shipped bundle can reach. api.npmjs.org is NOT optional --
  // it serves the download counts that npm_health folds into its result, and
  // omitting it produces a null-populated answer with no error (see the header).
  const hosts = ["registry.npmjs.org", "api.npmjs.org", "replicate.npmjs.com"];
  // A private registry is a different host, so the grant has to learn about it.
  // Parsed rather than pasted: NPM_REGISTRY is a URL, the grant wants a host.
  const registry = process.env.NPM_REGISTRY;
  if (registry) {
    try {
      const { hostname } = new URL(registry);
      if (hostname && !hosts.includes(hostname)) hosts.push(hostname);
    } catch {
      // Malformed NPM_REGISTRY: api.ts falls back to the public registry, which
      // is already granted. Nothing to add, and this is not the place to warn.
    }
  }

  // Exactly the variables the bundle reads. A denied variable is ABSENT rather
  // than throwing, so this list being short is a correctness risk, not just a
  // tightness one -- keep it in step with `grep process.env dist/index.js`.
  const env = ["NPM_TOKEN", "NPM_REGISTRY", "NPM_REQUEST_TIMEOUT_MS", "NPM_RETRY_BACKOFF_MS", "DEBUG"];

  // No --allow-fs-read/write and no --allow-child-process: denying both is the
  // entire point. The server reads no files at runtime and spawns nothing.
  return ["--permission", `--allow-net=${hosts.join(",")}`, `--allow-env=${env.join(",")}`];
}

/** Run the server in THIS process. The zero-overhead fallback. */
async function runInProcess() {
  // A server may gate its bootstrap on being the process ENTRY POINT --
  // `import.meta.url === pathToFileURL(process.argv[1]).href` -- so that its own
  // test file can import the module for unit tests without connecting a stdio
  // transport. aws-mcp does exactly this. Importing the server here would leave
  // argv[1] pointing at THIS launcher, the guard would read false, and the
  // server would load but never serve: the MCP handshake just hangs.
  //
  // Point argv[1] at the server first, so the in-process path is
  // indistinguishable from having executed the file directly. The spawn path
  // needs no equivalent -- there argv[1] is already the server.
  process.argv[1] = SERVER_ENTRY;
  await import(SERVER_URL.href);
}

const mode = (process.env.NPMJS_MCP_RUNTIME ?? "auto").toLowerCase();

if (mode === "node") {
  await runInProcess();
} else {
  const oam = findOam();

  if (!oam) {
    if (mode === "oam") {
      // Explicitly demanded, so this is a real misconfiguration -- do not
      // silently do something else. writeSync because stderr is async for
      // TTYs/pipes on Windows and process.exit truncates pending writes.
      const { writeSync } = await import("node:fs");
      writeSync(
        2,
        "npmjs-mcp: NPMJS_MCP_RUNTIME=oam but no oam binary was found.\n" +
          "Install from https://oamjs.org, set OAM_BIN=/path/to/oam, or use NPMJS_MCP_RUNTIME=node.\n",
      );
      process.exit(1);
    }
    await runInProcess();
  } else if (!atLeast(oamVersion(oam), OAM_MIN)) {
    // Discovery itself stays stat-only; this is the first subprocess, and it
    // runs only once we have already decided to spawn oam anyway. Measured
    // 26ms median (n=12, windows-arm64) against a launch that was going to
    // spawn a process regardless, and it is paid once per MCP session.
    const min = OAM_MIN.join(".");
    if (mode === "oam") {
      const { writeSync } = await import("node:fs");
      writeSync(
        2,
        `npmjs-mcp: NPMJS_MCP_RUNTIME=oam but ${oam} is older than oam ${min}.\n` +
          `Run \`oam self-update\`, or use NPMJS_MCP_RUNTIME=node.\n`,
      );
      process.exit(1);
    }
    // auto: an old oam is a reason to prefer Node, not to fail. Say so, because
    // a silent downgrade is how someone keeps running an oam they meant to
    // update. stderr is safe -- MCP frames travel on stdout.
    process.stderr.write(`npmjs-mcp: oam at ${oam} is older than ${min}; using Node instead.\n`);
    await runInProcess();
  } else {
    // `--` separates oam's own flags from the script's argv. Everything after
    // it lands in process.argv for the server, so `npmjs-mcp --version` and any
    // host-supplied flags survive the hop unchanged.
    const child = spawn(oam, [...sandboxFlags(), "run", SERVER_ENTRY, "--", ...process.argv.slice(2)], {
      // inherit keeps the SAME fds, so MCP's newline-delimited JSON framing on
      // stdin/stdout is untouched and the host's stdin-close still reaches the
      // server's shutdown path.
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });

    // If oam cannot be executed at all (deleted between the stat and the spawn,
    // wrong arch, permission), fall back rather than failing the whole server.
    // `spawned` guards against falling back AFTER the child has begun running,
    // which would double-start the server on the same stdio.
    let spawned = false;
    child.on("spawn", () => {
      spawned = true;
    });
    child.on("error", (err) => {
      if (spawned) return;
      if (mode === "oam") {
        process.stderr.write(`npmjs-mcp: failed to launch oam (${err.message})\n`);
        process.exit(1);
      }
      void runInProcess();
    });

    // Forward termination so the server's own shutdown path runs in the child
    // rather than the child being orphaned. Signals are a no-op on Windows but
    // harmless to register.
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        if (!child.killed) child.kill(sig);
      });
    }

    child.on("exit", (code, signal) => {
      // Mirror the child's fate: a signal death becomes 128+n so callers see a
      // conventional shell exit status rather than a bare 0.
      if (signal) {
        process.exit(128 + (constants.signals[signal] ?? 15));
      }
      process.exit(code ?? 0);
    });
  }
}
