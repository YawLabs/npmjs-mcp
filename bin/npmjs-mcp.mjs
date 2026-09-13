#!/usr/bin/env node
/**
 * Runtime launcher for @yawlabs/npmjs-mcp.
 *
 * Prefers the newest usable oam runtime (https://oamjs.org) and falls back to
 * Node. It never serves on an oam older than the floor below. The server
 * itself (`dist/index.js`) is runtime-agnostic -- a pre-bundled ESM file using
 * only `node:` builtins that oam implements -- so neither path changes
 * behavior. Verified against the real MCP surface on both: initialize,
 * tools/list (64 tools), and a live registry call all return identically.
 *
 * WHY THE FALLBACK COSTS NOTHING
 * The fallback does NOT re-exec node. npm already started a node process to
 * run this launcher, so falling back is a plain `import()` of the server into
 * THIS process: zero extra spawn, zero extra startup, byte-identical to
 * invoking `dist/index.js` directly. Finding the candidates is stat-only, so a
 * machine without oam pays only a handful of `existsSync` calls.
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
 * so reaching oam through one means paying node's startup, a `--version`
 * probe of every oam binary found, and THEN oam's startup, which costs more
 * than oam saves. (The 243 ms figure predates the version probes, which now add
 * a subprocess per oam binary found.) The launcher exists so `npx` users get
 * oam automatically; it is not the fast path.
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
 * WHICH OAM
 * OAM_BIN, when set and usable, is used as given. Otherwise every oam binary
 * discovery can see -- the installed locations, then PATH -- is asked for its
 * version, and the NEWEST one at or above the floor wins; a tie keeps search
 * order. Taking the first binary found instead let a stale copy early in the
 * search order hide a current one later: with oam 0.9.0 installed in ~/.oam/bin
 * and 0.15.2 on PATH, the launcher bound to 0.9.0 because installed locations
 * are searched first.
 *
 * An OAM_BIN that does not exist, is below the floor, or will not run is always
 * named on stderr and discovery carries on. It used to stop everything: a typo
 * in OAM_BIN meant Node, with no hint why. Discovered binaries that are passed
 * over, and an oam .cmd/.bat shim, are named only when NO usable oam is found:
 * an older copy losing to a newer one is the selection working, not a problem.
 *
 * ALREADY RUNNING ON OAM
 * A host can resolve this package's `bin` and launch `oam run <this file>`
 * instead of `node <this file>` -- Yaw MCP does, and so does oam's sidecar
 * regression matrix. This launcher used to discover oam and spawn it anyway,
 * so one server cost two runtime boots: measured on Windows, oam.exe with a
 * NESTED oam.exe + conhost.exe underneath it. Now, when `process.versions.oam`
 * clears the same MINIMUM OAM VERSION a discovered binary has to, the server is
 * imported into THIS process exactly as the Node fallback is -- no discovery,
 * no `oam --version` probe, no second oam. OAM_BIN is a discovery input, so it
 * is not consulted on that path: the host has already chosen which oam runs.
 *
 * NPMJS_MCP_SANDBOX=1 still takes the discovery path on such a host,
 * deliberately: `--permission` is a process-level flag that only a FRESH oam
 * can apply, so taking the in-process shortcut there would drop the sandbox
 * without a word -- a security downgrade dressed up as an optimisation, in a
 * process that may be holding an NPM_TOKEN.
 *
 * The discovery path is not a guaranteed spawn. A sandboxed oam is spawned only
 * when a runnable oam at or above the floor is found. When none is -- no oam
 * found, every one too old or unrunnable, or a spawn that fails to launch --
 * NPMJS_MCP_RUNTIME=oam exits with an error, but the default `auto` falls back
 * WITHOUT `--permission`: in THIS process on Node or on a host oam at the floor,
 * handed off to Node on a host oam below it. It says so on stderr. So under
 * `auto` a requested sandbox is best-effort, not enforced; pair
 * NPMJS_MCP_SANDBOX=1 with NPMJS_MCP_RUNTIME=oam to make an unavailable sandbox
 * fatal instead.
 *
 * A host oam BELOW the floor never serves. It hands the server off to the
 * newest usable oam, or to Node found on PATH, or exits with an error when
 * there is neither.
 *
 * Any handoff FROM an oam host -- below the floor, spawning a fresh oam for the
 * sandbox, or handing off to Node under NPMJS_MCP_RUNTIME=node -- PIPES stdio
 * rather than inheriting it. Before 0.9.0 oam treated `stdio: 'inherit'` as
 * `'pipe'`, so an inherited handoff from such a host connected the child to
 * pipes nobody reads, and the MCP handshake never answered (measured with a
 * real oam 0.8.2 host). Piping the streams explicitly completes it, to both oam
 * and Node. A Node host keeps `inherit`, which hands over the same fds
 * untouched.
 *
 * THE `--permission` SANDBOX (opt-in)
 * This used to be a "deliberately not done" note: oam's `--permission` denied
 * network with no grant to open it, so the server completed the MCP handshake
 * and then failed every tool call. oam 0.8.3 added `--allow-net` / `--allow-env`
 * and the note is now obsolete -- `NPMJS_MCP_SANDBOX=1` opts in. Like every oam
 * path here it needs an oam at or above the floor.
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
 * The latest oam release, 0.15.2 -- bump OAM_MIN when oam ships a newer one.
 * Only the current oam is used and verified; an older one is never served on.
 * Below 0.9.0 `child_process.execFile` ran its arguments through a SHELL,
 * `exec`'s `timeout` was accepted and ignored, `spawnSync` truncated at
 * `maxBuffer` while reporting success, and `stdio: 'inherit'` behaved as
 * `'pipe'`. This server spawns nothing, so the child_process bugs are not
 * reachable from it; the floor is the release the server and its sandbox grants
 * are verified on, enforced alongside the rest of @yawlabs/*-mcp.
 *
 * SELECTION
 *   NPMJS_MCP_RUNTIME=auto   newest usable oam, else Node (default)
 *   NPMJS_MCP_RUNTIME=oam    newest usable oam, else exit with an error
 *                            (already running on oam at the floor satisfies
 *                            it, unless the sandbox is requested)
 *   NPMJS_MCP_RUNTIME=node   Node: in THIS process on Node, handed off to Node
 *                            on PATH when THIS process is oam. Never sandboxed.
 *   NPMJS_MCP_SANDBOX=1      spawn oam under --permission (see above)
 *   OAM_BIN=/path/to/oam     use this oam when it is usable, before discovery
 * The runtime value is case-insensitive; anything else behaves like `auto`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Oldest oam this launcher will run on. See MINIMUM OAM VERSION above. */
const OAM_MIN = [0, 15, 2];

/**
 * Bound on each `oam --version` probe. A healthy oam answers in milliseconds;
 * the bound only exists so a wedged binary on PATH cannot hang the launch.
 */
const VERSION_PROBE_TIMEOUT_MS = 5_000;

// Two forms, deliberately. `import()` on Windows REJECTS a bare `C:\...` path
// with ERR_UNSUPPORTED_ESM_URL_SCHEME (it reads `c:` as a protocol), so the
// in-process fallback must use the file:// URL. spawn(), conversely, needs a
// real filesystem path.
const SERVER_URL = new URL("../dist/index.js", import.meta.url);
const SERVER_ENTRY = fileURLToPath(SERVER_URL);
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

/** Identity for de-duplicating paths: resolved, and case-folded on Windows. */
function pathKey(p) {
  let key = p;
  try {
    key = realpathSync(p);
  } catch {
    // Unresolvable: fall back to the literal path.
  }
  return isWin ? key.toLowerCase() : key;
}

/**
 * Every oam binary discovery can see, in search order, de-duplicated. Stat-only,
 * never a subprocess -- PATH is resolved manually rather than by spawning
 * `which`/`where`.
 *
 * Installed locations come BEFORE PATH, so when two binaries report the same
 * version the installed copy wins the tie. Someone who develops oam itself
 * usually has oam/target/release on PATH, and cargo replaces that binary
 * underneath running processes; OAM_BIN remains the way to point deliberately
 * at a dev build. Both forms are checked on Windows: the installer defaults to
 * %LOCALAPPDATA%\oam\bin there, but oam's docs name ~/.oam/bin first and
 * OAM_INSTALL_DIR can pick either.
 *
 * Windows: `.exe` ONLY -- deliberately narrower than PATHEXT. Node refuses to
 * run a .cmd/.bat through execFile/spawn without `shell: true` (EINVAL, and for
 * spawn it throws SYNCHRONOUSLY rather than emitting 'error'), so walking the
 * full PATHEXT list would hand back a path this launcher cannot execute.
 * Discovery has to agree with execution. A skipped shim is still named on
 * stderr when no usable oam is found -- see findOamShim.
 */
function discoverOamPaths() {
  const installed = [join(homedir(), ".oam", "bin", exe)];
  if (isWin) {
    installed.unshift(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe));
  }
  const onPath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, exe));
  const seen = new Set();
  const found = [];
  for (const candidate of [...installed, ...onPath]) {
    if (!existsSync(candidate)) continue;
    const key = pathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(candidate);
  }
  return found;
}

/**
 * Version text -> [major, minor, patch], or null when it holds no version.
 * A pre-release suffix (`0.9.0-rc.1`) truncates to its base version.
 *
 * Shared by the two places a version is read -- a discovered binary's
 * `oam --version` output (`oam 0.15.2`) and the host's own
 * `process.versions.oam` (`0.15.2`) -- so they cannot disagree about what a
 * version string means, or which floor it has to clear.
 */
function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `oam --version` -> [major, minor, patch], or null when it cannot be read. */
function oamVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseVersion(out);
  } catch {
    // Not executable, wrong arch, wedged, or deleted since the stat. Caller degrades.
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
 * The newest candidate at or above the floor, or null. `candidates` is
 * `{ path, version }[]` in search order, `version` null when unreadable.
 * Strictly-greater replaces, so a tie keeps the earlier candidate.
 *
 * Pure on purpose, like runtimePlan: the choice is testable without binaries.
 */
function pickNewest(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!atLeast(candidate.version, OAM_MIN)) continue;
    if (!best || !atLeast(best.version, candidate.version)) best = candidate;
  }
  return best;
}

/**
 * Where the server runs, decided BEFORE any discovery:
 *   "in-process"   import it into THIS process
 *   "discover"     choose an oam and spawn it, or fall back
 *   "handoff-node" hand it off to Node on PATH: THIS process is an oam and
 *                  NPMJS_MCP_RUNTIME=node was asked for
 *
 * `hostOam` is `process.versions.oam`: oam's own key, absent on Node. An oam
 * host whose version cannot be read is treated as below the floor -- it never
 * proved it is a supported oam. `sandbox` is whether a spawn would carry flags
 * only a fresh oam can apply; see ALREADY RUNNING ON OAM above for why that
 * alone forces the discovery path, and for why that path can still end without
 * the sandbox. `node` outranks the sandbox: Node has no `--permission` to apply.
 * The floor is OAM_MIN itself, not a parameter, so a host oam and a discovered
 * one can never be held to different minimums.
 *
 * Pure on purpose: every input is passed in, so the whole decision is testable
 * without booting a runtime.
 */
function runtimePlan({ mode, hostOam, sandbox }) {
  const onOam = hostOam !== undefined;
  if (mode === "node") return onOam ? "handoff-node" : "in-process";
  if (sandbox) return "discover";
  return atLeast(parseVersion(hostOam ?? ""), OAM_MIN) ? "in-process" : "discover";
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

/**
 * Write a diagnostic to stderr synchronously, so a following process.exit
 * cannot truncate it.
 *
 * Not a bare writeSync: that call can short-write (it returns a byte count) and
 * on macOS it can throw EAGAIN, because Node makes a piped stderr non-blocking
 * there rather than blocking the write. Loop over the remaining bytes, and if
 * stderr turns out to be unusable give up quietly -- failing to print a
 * diagnostic is not worth crashing a stdio server over.
 */
async function errSync(message) {
  const { writeSync } = await import("node:fs");
  const buf = Buffer.from(message);
  let off = 0;
  for (let attempts = 0; off < buf.length && attempts < 1000; attempts++) {
    try {
      off += writeSync(2, buf, off, buf.length - off);
    } catch (err) {
      if (err?.code !== "EAGAIN") return;
      // Pipe is full and the reader has not drained yet -- retry.
    }
  }
}

/**
 * An oam-named .cmd/.bat on PATH: a real install in a shape this launcher
 * cannot spawn. Looked for only when no usable oam was found, and then
 * reported rather than ignored, because "no usable oam was found" reads as
 * "install oam" -- the one thing that will not help. Windows only; there is no
 * such shim concept on POSIX.
 */
function findOamShim() {
  if (!isWin) return null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of [".cmd", ".bat"]) {
      const candidate = join(dir, `oam${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** A Node binary on PATH, or null. Stat-only; used only when THIS process is oam. */
function findNodeOnPath() {
  const name = isWin ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Why a candidate was passed over, for stderr. */
function unusableReason(path, version, label = path) {
  const min = OAM_MIN.join(".");
  return version
    ? `${label} is oam ${version.join(".")}, older than ${min}`
    : `${label} could not be run, or did not report a version this launcher understands`;
}

/**
 * Choose the oam to spawn: a usable OAM_BIN, else the newest usable discovered
 * binary. Returns the choice (or null) plus stderr notes: `overrideNote` about
 * an unusable OAM_BIN, and `skipped` describing what was found and rejected
 * when nothing was usable.
 */
function chooseOam() {
  const override = process.env.OAM_BIN;
  let overrideNote = null;
  if (override) {
    if (!existsSync(override)) {
      overrideNote = `OAM_BIN=${override} does not exist`;
    } else {
      const version = oamVersion(override);
      if (atLeast(version, OAM_MIN)) return { chosen: { path: override, version }, overrideNote, skipped: [] };
      overrideNote = unusableReason(override, version, `OAM_BIN=${override}`);
    }
  }
  const overrideKey = override ? pathKey(override) : null;
  const candidates = discoverOamPaths()
    .filter((path) => pathKey(path) !== overrideKey)
    .map((path) => ({ path, version: oamVersion(path) }));
  const chosen = pickNewest(candidates);
  const skipped = chosen ? [] : candidates.map((c) => unusableReason(c.path, c.version));
  return { chosen, overrideNote, skipped };
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

// ONE reporter for every failed fallback. runInProcess() is a bare import()
// that rejects when dist/index.js is missing, and at ESM top level an unhandled
// rejection is an uncaught exception -- replacing this launcher's diagnostic
// with a raw stack trace. Not "fallback to Node": on a host oam at the floor the
// fallback serves on that oam.
const fallbackFailed = (e) => {
  process.stderr.write(`npmjs-mcp: fallback failed (${e?.message ?? e})\n`);
  process.exitCode = 1;
};

/**
 * Spawn the server in a child runtime and mirror its lifetime.
 *
 * `onLaunchFailed(err)` runs when the child could not be started at all; it is
 * never called once the child is running, which would double-start the server
 * on the same stdio.
 */
async function launchChild(cmd, args, onLaunchFailed) {
  // THIS process being an oam means one below the floor, one spawning a fresh
  // oam to apply the sandbox, or one handing off to Node under
  // NPMJS_MCP_RUNTIME=node. An oam older than 0.9.0 does not hand over the fds
  // for `stdio: 'inherit'`, so pipe explicitly from every oam host; see
  // ALREADY RUNNING ON OAM.
  const piped = process.versions.oam !== undefined;
  let child = null;
  try {
    child = spawn(cmd, args, {
      // inherit keeps the SAME fds, so MCP's newline-delimited JSON framing on
      // stdin/stdout is untouched and the host's stdin-close still reaches the
      // server's shutdown path. Piping preserves both as well: bytes are copied
      // unchanged, and stdin's end propagates to the child.
      stdio: piped ? ["pipe", "pipe", "pipe"] : "inherit",
      env: process.env,
      windowsHide: true,
    });
  } catch (err) {
    // spawn() THROWS for some failures instead of emitting 'error', and the
    // 'error' listener is registered AFTER this call, so it can never observe
    // one -- an uncaught throw here kills the launcher with a raw stack trace
    // instead of falling back.
    await onLaunchFailed(err).catch(fallbackFailed);
    return;
  }

  // If the runtime cannot be executed at all (deleted between the version probe
  // and the spawn, wrong arch, permission), fall back rather than failing the
  // whole server. `spawned` prevents falling back AFTER the child started.
  //
  // Everything that assumes a live child waits for 'spawn'. A failed spawn
  // still emits 'close' (after 'error', with the negative errno as its code), so
  // an unguarded close handler would process.exit() out from under the fallback
  // onLaunchFailed has just started -- a Node handoff, or the unsandboxed
  // in-process server on a host oam at the floor. That exit is the failure the
  // launcher tests reproduce.
  //
  // The pipes wait too, defensively. A pipe into a dead child's stdin writes
  // into a destroyed stream, and when it unpipes it leaves process.stdin
  // explicitly paused, which a later 'data' listener -- the in-process server's
  // -- does not resume. A standalone script with that ordering never read stdin
  // again; through this launcher the request still arrived in every timing
  // tried, so treat this half as a guard rather than a reproduced bug. Until
  // 'spawn', process.stdin has no reader and stays in its initial state.
  let spawned = false;
  child.on("spawn", () => {
    spawned = true;
    if (piped) {
      process.stdin.pipe(child.stdin);
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    }
    forwardSignals();
  });
  child.on("error", (err) => {
    if (spawned) return;
    onLaunchFailed(err).catch(fallbackFailed);
  });
  // A child that exits before reading everything closes its stdin; the
  // resulting EPIPE is not worth crashing over.
  child.stdin?.on("error", () => {});

  // Forward termination so the server's own shutdown path runs in the child
  // rather than the child being orphaned.
  //
  // Registering ANY handler for these suppresses Node's default
  // terminate-on-signal, so the parent's exit has to be arranged explicitly.
  // `child.killed` only records that kill() was CALLED, never that the child
  // is gone, so gating on it swallows every signal after the first and wedges
  // the launcher with no escape hatch.
  //
  // Escalation is driven by a TIMER, not by counting signals. Counting is
  // ambiguous: a supervisor routinely sends SIGINT then SIGTERM milliseconds
  // apart, and a terminal Ctrl-C reaches the whole process group, so reading
  // "a second signal" as impatience hard-kills a child that is already
  // shutting down cleanly. A timer makes the count irrelevant -- ONE press is
  // enough, and a wedged child dies on schedule. setTimeout is monotonic, so
  // a wall-clock step cannot mis-gate the window either.
  //
  // POSIX vs Windows, and why we do NOT forward on Windows.
  // On POSIX child.kill(sig) delivers a real, catchable signal, so forwarding
  // is what lets the child run its shutdown. On Windows there are no POSIX
  // signals: child.kill IGNORES the name and calls TerminateProcess -- an
  // immediate hard kill (verified: a child with a SIGTERM handler never runs
  // it and dies with code=null, signal=SIGTERM). Forwarding there ABORTS the
  // graceful shutdown the console's own Ctrl-C just started, skipping the
  // child's process.on("exit") cleanup. The console has already notified the
  // child, so on Windows the timer below is the only kill we issue.
  const ESCALATE_AFTER_MS = 2000;
  let escalation = null;
  function forwardSignals() {
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        // No try/catch: kill() on an already-exited child returns false, it does
        // not throw. It throws only for a signal the platform does not know,
        // which SIGINT/SIGTERM/SIGKILL never are.
        if (!isWin) child.kill(sig);
        if (escalation) return; // already counting down; further signals are noise
        escalation = setTimeout(() => {
          // Still here after its grace window. Stop waiting on it.
          child.kill("SIGKILL");
          process.exit(128 + (constants.signals[sig] ?? 15));
        }, ESCALATE_AFTER_MS);
      });
    }
  }

  // Piped: wait for 'close', so the child's last stdout bytes are copied out
  // before this process exits. Inherited: 'exit' is enough, the fds were never
  // ours to drain. Either way, only for a child that actually ran -- see the
  // 'spawn' handler above.
  child.on(piped ? "close" : "exit", (code, signal) => {
    if (!spawned) return;
    if (escalation) clearTimeout(escalation);
    // Mirror the child's fate: a signal death becomes 128+n so callers see a
    // conventional shell exit status rather than a bare 0.
    if (signal) {
      process.exit(128 + (constants.signals[signal] ?? 15));
    }
    process.exit(code ?? 0);
  });
}

/**
 * Hand the server to Node on PATH. Only reachable when THIS process is oam --
 * one below the floor with no usable oam, or any oam under
 * NPMJS_MCP_RUNTIME=node -- so there is no in-process option left. `reason` is
 * empty for the latter, which is a choice rather than a problem to report.
 */
async function handOffToNode(reason) {
  const node = findNodeOnPath();
  if (!node) {
    await errSync(
      reason
        ? `npmjs-mcp: ${reason}, and no Node was found on PATH to run the server instead.\n` +
            `Run \`oam self-update\` to get oam ${OAM_MIN.join(".")} or newer, or launch this command with node.\n`
        : "npmjs-mcp: NPMJS_MCP_RUNTIME=node, but no Node was found on PATH to run the server.\n" +
            "Put Node on PATH, or launch this command with node.\n",
    );
    process.exit(1);
  }
  if (reason) await errSync(`npmjs-mcp: ${reason}; running on ${node} instead.\n`);
  await launchChild(node, [SERVER_ENTRY, ...process.argv.slice(2)], async (err) => {
    await errSync(`npmjs-mcp: failed to launch Node at ${node} (${err?.message ?? err})\n`);
    process.exit(1);
  });
}

/**
 * No usable oam to spawn, under a mode that allows falling back.
 *
 * On Node the server runs in THIS process. So it does on a host oam at or above
 * the floor, which reaches discovery only because NPMJS_MCP_SANDBOX=1 asked for
 * a fresh oam: the host is itself a supported oam, and under `auto` the sandbox
 * is best-effort (see ALREADY RUNNING ON OAM). A host oam below the floor never
 * serves, so the server is handed off to Node on PATH.
 *
 * `why` finishes the handoff note: nothing usable was found, or the oam that
 * was found could not be launched.
 */
async function fallBack(hostOam, why = "no newer oam was found") {
  if (hostOam === undefined || atLeast(parseVersion(hostOam), OAM_MIN)) {
    await runInProcess();
    return;
  }
  await handOffToNode(`this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}, and ${why}`);
}

/** What fallBack will do, in the words of a stderr note. */
function fallbackTarget(hostOam) {
  return hostOam !== undefined && atLeast(parseVersion(hostOam), OAM_MIN)
    ? `serving on this oam ${hostOam} process instead`
    : "using Node instead";
}

const mode = (process.env.NPMJS_MCP_RUNTIME ?? "auto").toLowerCase();
const hostOam = process.versions.oam;
// The sandbox is read off the grant list rather than NPMJS_MCP_SANDBOX, so
// "would the spawn carry --permission" cannot drift from what the spawn below
// actually passes.
const sandbox = sandboxFlags();
const plan = runtimePlan({ mode, hostOam, sandbox: sandbox.length > 0 });
// Falling back never carries --permission. Said out loud, because the whole
// hazard of a dropped sandbox is that nothing else reveals it.
const sandboxDropped =
  sandbox.length > 0 ? [`NPMJS_MCP_SANDBOX=1 is not applied (it needs an oam ${OAM_MIN.join(".")}+ to spawn)`] : [];

if (plan === "in-process") {
  await runInProcess();
} else if (plan === "handoff-node") {
  const belowFloor = !atLeast(parseVersion(hostOam), OAM_MIN);
  await handOffToNode(belowFloor ? `this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}` : "");
} else {
  const { chosen, overrideNote, skipped } = chooseOam();

  if (chosen) {
    if (overrideNote) {
      await errSync(`npmjs-mcp: ${overrideNote}; using ${chosen.path} (oam ${chosen.version.join(".")}).\n`);
    }
    // `--` separates oam's own flags from the script's argv. Everything after
    // it lands in process.argv for the server, so `npmjs-mcp --version` and any
    // host-supplied flags survive the hop unchanged. The sandbox flags go
    // BEFORE `run`; see sandboxFlags.
    await launchChild(chosen.path, [...sandbox, "run", SERVER_ENTRY, "--", ...process.argv.slice(2)], async (err) => {
      const failed = `failed to launch oam at ${chosen.path} (${err?.message ?? err})`;
      if (mode === "oam") {
        await errSync(`npmjs-mcp: ${failed}\n`);
        process.exit(1);
      }
      await errSync(`npmjs-mcp: ${[failed, ...sandboxDropped].join("; ")}; ${fallbackTarget(hostOam)}.\n`);
      await fallBack(hostOam, "the oam chosen to replace it failed to launch");
    });
  } else {
    const shim = findOamShim();
    const notes = [
      ...(overrideNote ? [overrideNote] : []),
      ...skipped,
      ...(shim
        ? [
            `found ${shim}, but Node cannot execute a .cmd/.bat directly -- install the native oam binary, or point OAM_BIN at one`,
          ]
        : []),
    ];
    if (mode === "oam") {
      // Explicitly demanded, so this is a real misconfiguration -- do not
      // silently do something else.
      await errSync(
        `npmjs-mcp: NPMJS_MCP_RUNTIME=oam but no usable oam (${OAM_MIN.join(".")} or newer) was found.\n` +
          notes.map((note) => `  ${note}\n`).join("") +
          "Install or update from https://oamjs.org, set OAM_BIN=/path/to/oam, or use NPMJS_MCP_RUNTIME=node.\n",
      );
      process.exit(1);
    }
    // auto: falling back is correct, but silence is how someone never learns
    // their OAM_BIN is wrong, their oam is too old to use, or their sandbox
    // was never applied.
    notes.push(...sandboxDropped);
    if (notes.length > 0) await errSync(`npmjs-mcp: ${notes.join("; ")}; ${fallbackTarget(hostOam)}.\n`);
    await fallBack(hostOam).catch(fallbackFailed);
  }
}
