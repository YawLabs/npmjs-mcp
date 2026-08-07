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
 * MEASURING THIS YOURSELF: do not benchmark a binary sitting in a cargo
 * `target/` directory. On this machine an active AV (McAfee; Defender is
 * passive) rescans it on EVERY exec -- the identical bytes copied elsewhere and
 * run once to absorb the scan start 5.0x faster (306 ms -> 61 ms, interleaved,
 * reproducible). An earlier revision of this comment claimed oam was a
 * regression; that number was measuring the virus scanner. oam is pre-alpha,
 * so re-measure regardless -- but measure an installed binary.
 *
 * WHAT WE DELIBERATELY DO NOT DO
 * oam's `--permission` model is not used. Its own divergence notes record that
 * `--permission` denies filesystem, environment AND network access, and the
 * only grants it implements are `--allow-fs-read/write`, `--allow-child-process`,
 * `--allow-worker` and `--allow-addons`. There is no network grant, and this
 * server exists to talk to the npm registry -- so enabling it produces a
 * process that completes the MCP handshake and then fails every tool call.
 * Confirmed empirically before it was ruled out.
 *
 * SELECTION
 *   NPMJS_MCP_RUNTIME=oam    require oam; fail loudly if it is missing
 *   NPMJS_MCP_RUNTIME=node   never use oam
 *   NPMJS_MCP_RUNTIME=auto   prefer oam, silently fall back (default)
 *   OAM_BIN=/path/to/oam     explicit binary, checked before any discovery
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

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

  // 2. PATH, resolved manually rather than by spawning `which`/`where`, which
  //    would cost a subprocess on every launch just to decide whether to spawn.
  const pathExt = isWin ? (process.env.PATHEXT ?? ".EXE").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of isWin ? pathExt : [""]) {
      const candidate = join(dir, isWin ? `oam${ext.toLowerCase()}` : "oam");
      if (existsSync(candidate)) return candidate;
    }
  }

  // 3. The per-user locations oamjs.org's installers write to. Checked because
  //    an MCP host launched from a GUI often has a PATH that omits them, so
  //    PATH-only discovery would miss an oam the user really has.
  const installed = isWin
    ? [join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe)]
    : [join(homedir(), ".oam", "bin", exe)];
  for (const candidate of installed) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/** Run the server in THIS process. The zero-overhead fallback. */
async function runInProcess() {
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
  } else {
    // `--` separates oam's own flags from the script's argv. Everything after
    // it lands in process.argv for the server, so `npmjs-mcp --version` and any
    // host-supplied flags survive the hop unchanged.
    const child = spawn(oam, ["run", SERVER_ENTRY, "--", ...process.argv.slice(2)], {
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
