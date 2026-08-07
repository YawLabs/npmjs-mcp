#!/usr/bin/env node
// Build a self-contained single-file binary of this MCP server.
//
// Strategy: esbuild bundles src/index.ts + ALL its dependencies (including
// the externals tsup leaves out -- @modelcontextprotocol/sdk and undici)
// into ONE CommonJS file with zero remaining node_modules resolution, then
// Node's Single Executable Application (SEA) feature embeds that bundle as a
// resource inside a copy of the node binary. The result runs with no Node,
// no node_modules, and no PATH dependency.
//
// Why not `deno compile`? Deno was not installed on the build host at authoring
// time (`deno --version` -> command not found). The project itself is fully
// Deno-compatible in principle (clean ESM, no native addons), but the node:
// builtin imports in the bundle are bare (`fs`, not `node:fs`), which Deno
// rejects without a compat shim. Node SEA needs no such rewrite and ships with
// the Node already on the box, so it is the zero-friction path here. (An
// earlier version of this comment pointed at a BINARY_DISTRIBUTION.md for the
// deno/bun fallbacks; that document does not exist in this repo.)
//
// This script ONLY reads node_modules (via esbuild's resolver) and writes to
// build-tmp/ and bin/<platform>-<arch>/. It does NOT mutate package.json,
// package-lock.json, src/, or node_modules, and it never runs `npm install`.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { inject } from 'postject';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
const { version } = pkg;
// Binary name = the package's first `bin` command, so this script is
// copy-paste generic across @yawlabs/* servers -- no per-repo rename.
const binName = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.split('/').pop();

// ── Which toolchain, and for which target ────────────────────────────────
//   node (default) -- Node SEA: blob + postject injection + macOS re-sign.
//                     Host-only, because it uses THIS node as the carrier.
//   oam            -- append the payload to an oam binary. Can CROSS-BUILD,
//                     because oam's embed format is a tail trailer rather
//                     than section surgery (see appendOamPayload).
//
// Default stays `node`: SEA is what the shipped Scoop/Homebrew binaries were
// built with and is proven on all five targets. The oam path is verified to
// produce a running binary on windows-arm64 only -- appending is proven for
// every target, executing is not.
const BINARY_RUNTIME = (process.env.NPMJS_MCP_BINARY_RUNTIME ?? 'node').toLowerCase();

// Release assets published at github.com/YawLabs/oam/releases, keyed by the
// `${process.platform}-${process.arch}` shape this script already uses.
const OAM_ASSETS = {
  'win32-x64': 'oam-x86_64-pc-windows-msvc.exe',
  'win32-arm64': 'oam-aarch64-pc-windows-msvc.exe',
  'darwin-arm64': 'oam-aarch64-apple-darwin',
  'darwin-x64': 'oam-x86_64-apple-darwin',
  'linux-x64': 'oam-x86_64-unknown-linux-gnu',
};

// NPMJS_MCP_BINARY_TARGET cross-builds for another platform. Only meaningful
// on the oam path; the SEA path has no equivalent because it carries the
// running node.
const TARGET = (process.env.NPMJS_MCP_BINARY_TARGET ?? `${process.platform}-${process.arch}`).toLowerCase();
const isCross = TARGET !== `${process.platform}-${process.arch}`;
const targetIsWin = TARGET.startsWith('win32');

const platformDir = TARGET;
const binDir = join(repoRoot, 'bin', platformDir);
const tmpDir = join(repoRoot, 'build-tmp');
const bundlePath = join(tmpDir, 'sea-bundle.cjs');
const blobPath = join(tmpDir, 'sea-bundle.blob');
// Name the artifact for the TARGET, not the host -- a cross-built win32 binary
// still needs its .exe suffix.
const exeName = targetIsWin ? `${binName}.exe` : binName;
const outExe = join(binDir, exeName);

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
}

function fmtSize(p) {
  const bytes = statSync(p).size;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes} bytes)`;
}

/**
 * Append a pre-bundled CJS file to an oam carrier binary, producing a
 * standalone executable.
 *
 * WHY THIS CAN CROSS-BUILD AND NODE SEA CANNOT
 * oam's embed format is a TAIL TRAILER, documented in the runtime source
 * (crates/oam_cli/src/main.rs, `COMPILE_MAGIC`):
 *
 *   v1: [JS][u64 LE js_len][b"OAMEXEC\0"]                      16-byte trailer
 *   v2: [JS][bytecode][u64 LE js_len][u64 LE bc_len][b"OAMEXC2\0"]
 *
 * Appending bytes to the end of an executable is tolerated identically by PE,
 * ELF and Mach-O, so the payload is platform-independent -- only the carrier
 * is not. `oam compile` is host-only purely because it uses the RUNNING oam as
 * the carrier (std::env::current_exe()); nothing about the format requires it.
 * Supplying a downloaded release binary for another target is all it takes.
 *
 * WE WRITE v1, DELIBERATELY. v2 embeds V8 bytecode, which is architecture- and
 * V8-version-specific -- appending arm64 bytecode to an x86_64 carrier would be
 * wrong. v1 is a first-class format the runtime reads and that `oam compile`
 * itself falls back to. The cost is losing the first-run parse skip, the same
 * trade the SEA path makes when `useCodeCache` is off for a cross-build.
 */
async function appendOamPayload(carrier, jsPath, outPath) {
  const js = readFileSync(jsPath);
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(js.length));
  const magic = Buffer.from('OAMEXEC\0', 'binary');
  writeFileSync(outPath, Buffer.concat([readFileSync(carrier), js, len, magic]));
  if (!targetIsWin) chmodSync(outPath, 0o755);
}

/** Fetch the published oam release binary for TARGET, verified against SHA256SUMS. */
async function fetchOamCarrier(target) {
  const asset = OAM_ASSETS[target];
  if (!asset) {
    console.error(
      `build-binary: no oam release asset known for target '${target}'.\n` +
        `Known targets: ${Object.keys(OAM_ASSETS).join(', ')}`,
    );
    process.exit(1);
  }
  const tag = process.env.OAM_VERSION ?? 'latest';
  const base =
    tag === 'latest'
      ? 'https://github.com/YawLabs/oam/releases/latest/download'
      : `https://github.com/YawLabs/oam/releases/download/${tag}`;
  const dest = join(tmpDir, asset);

  console.log(`> fetch ${base}/${asset}`);
  const res = await fetch(`${base}/${asset}`);
  if (!res.ok) {
    console.error(`build-binary: downloading ${asset} failed (HTTP ${res.status})`);
    process.exit(1);
  }
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));

  // Integrity is not optional for a binary we are about to ship inside our own.
  const sumsRes = await fetch(`${base}/SHA256SUMS`);
  if (!sumsRes.ok) {
    console.error(`build-binary: could not fetch SHA256SUMS (HTTP ${sumsRes.status}); refusing to use an unverified carrier`);
    process.exit(1);
  }
  const sums = await sumsRes.text();
  const want = sums
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name?.replace(/^\*/, '') === asset)?.[0];
  if (!want) {
    console.error(`build-binary: ${asset} has no entry in SHA256SUMS; refusing to use an unverified carrier`);
    process.exit(1);
  }
  const got = createHash('sha256').update(readFileSync(dest)).digest('hex');
  if (got !== want) {
    console.error(`build-binary: SHA256 mismatch for ${asset}\n  expected ${want}\n  got      ${got}`);
    process.exit(1);
  }
  console.log(`  sha256 ok (${got.slice(0, 16)}...)`);
  return dest;
}

async function buildViaOam() {
  // Host build can use the local oam; a cross build must fetch the target's.
  let carrier;
  if (isCross) {
    carrier = await fetchOamCarrier(TARGET);
  } else {
    carrier =
      process.env.OAM_BIN ??
      (isWin
        ? join(process.env.LOCALAPPDATA ?? '', 'oam', 'bin', 'oam.exe')
        : join(process.env.HOME ?? '', '.oam', 'bin', 'oam'));
    if (!existsSync(carrier)) carrier = await fetchOamCarrier(TARGET);
  }

  rmSync(outExe, { force: true });
  await appendOamPayload(carrier, bundlePath, outExe);
  console.log(`carrier: ${fmtSize(carrier)}`);

  if (isCross) {
    // Appending is proven for every target; EXECUTING is only proven where we
    // can run it. Do not pretend otherwise -- postgres-mcp's build script runs
    // the artifact for exactly this reason, and we cannot here.
    console.log('');
    console.log(`OK  ${outExe}  (oam carrier, cross-built for ${TARGET})`);
    console.log(`    ${fmtSize(outExe)}`);
    console.log('    NOT smoke-tested. Appending is proven for every target; EXECUTING is only');
    console.log('    proven where the artifact can be run. Verify before shipping, via any of:');
    console.log(`      - a ${TARGET} machine or CI runner`);
    console.log(`      - WSL, if its arch matches (\`wsl uname -m\`) -- an aarch64 WSL cannot run`);
    console.log('        an x86-64 build; it fails with "Exec format error"');
    console.log('      - docker run --rm -v ...:/b <image> /b --version   (needs a running daemon,');
    console.log('        and qemu binfmt for a foreign arch)');
    if (TARGET.startsWith('darwin')) {
      console.log('    macOS: appending invalidates any Mach-O signature and arm64 refuses to exec an');
      console.log('    unsigned/invalid one. Ad-hoc sign on a mac (codesign -s -) or with rcodesign.');
    }
    return;
  }

  run(outExe, ['--version']);
  console.log('');
  console.log(`OK  ${outExe}  (oam carrier)`);
  console.log(`    ${fmtSize(outExe)}`);
}

mkdirSync(tmpDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

// 1. Bundle everything into one CJS file (externals included) via esbuild's
// JS API. NOT the CLI bin: on Linux/macOS esbuild swaps node_modules/esbuild/
// bin/esbuild for the NATIVE binary (only Windows keeps it a JS shim), so
// `node bin/esbuild` would feed a binary to the JS parser and die. The API
// also takes the __VERSION__ define as data -- no shell-quoting games.
await esbuild.build({
  entryPoints: [join(repoRoot, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // src/index.ts reads `import.meta.url` in its version fallback, which does
  // not exist in a CJS bundle -- esbuild warns and would emit something that
  // throws if that branch were ever reached. The __VERSION__ define normally
  // makes the branch dead code, but relying on dead-code elimination for
  // correctness is how the top-level-await footgun got in here before. Shim it
  // instead, so the bundle is sound whether or not the branch is eliminated.
  banner: { js: "const __seaImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { __VERSION__: JSON.stringify(version), 'import.meta.url': '__seaImportMetaUrl' },
  outfile: bundlePath,
});
console.log(`bundle: ${fmtSize(bundlePath)}`);

// ── oam path: one append replaces steps 2-5 below ────────────────────────
if (BINARY_RUNTIME === 'oam') {
  await buildViaOam();
  process.exit(0);
}

if (isCross) {
  console.error(
    `build-binary: NPMJS_MCP_BINARY_TARGET=${TARGET} only works with NPMJS_MCP_BINARY_RUNTIME=oam.\n` +
      'The SEA path embeds the running node as its carrier and cannot cross-build.',
  );
  process.exit(1);
}

// 2. Generate the SEA blob from sea-config.json.
run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);
console.log(`blob:   ${fmtSize(blobPath)}`);

// 3. Copy the running node binary as the carrier.
rmSync(outExe, { force: true });
copyFileSync(process.execPath, outExe);
// copyFileSync does not reliably carry the executable bit on Unix; the macOS
// exec-check below and the CI smoke test both need to run this file.
if (!isWin) chmodSync(outExe, 0o755);

// macOS: strip the carrier node binary's existing signature BEFORE injecting,
// so postject doesn't leave a CORRUPT signature (which is worse than none --
// arm64 SIGKILLs a bad-sig binary at exec). We ad-hoc re-sign after step 4.
// Best-effort: an already-unsigned carrier makes `--remove-signature` exit
// non-zero, which must NOT abort the build -- the --force re-sign is what
// actually matters.
if (process.platform === 'darwin') {
  try {
    run('codesign', ['--remove-signature', outExe]);
  } catch {
    console.log('(carrier had no signature to remove -- continuing)');
  }
}

// 4. Inject the SEA blob via postject's JS API (pinned devDep). NOT the npx
//    CLI: locating npx-cli.js off the node binary is Windows-only (Unix keeps
//    npm under ../lib/node_modules, not ./node_modules), and npx-on-demand
//    adds a network dependency to every CI build. The API is cross-platform.
await inject(outExe, 'NODE_SEA_BLOB', readFileSync(blobPath), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined,
});
console.log('injection done');

// 5. macOS: ad-hoc re-sign AFTER injection. Apple Silicon refuses to exec a
//    Mach-O with no/invalid signature ("killed: 9"); `--sign -` is the free
//    ad-hoc identity (no cert, no notarization). Distribution is via the
//    Homebrew TAP (a formula), whose curl fetch sets no com.apple.quarantine,
//    so Gatekeeper never blocks it -- ad-hoc is sufficient. `--force` replaces
//    any residual signature; `--timestamp=none` keeps it offline/reproducible.
if (process.platform === 'darwin') {
  run('codesign', ['--sign', '-', '--force', '--timestamp=none', outExe]);
  run('codesign', ['--verify', '--verbose', outExe]);
  // --verify proves the signature is intact, NOT that the binary launches.
  // arm64 SIGKILLs a bad-sig Mach-O only at exec, so actually run it -- this
  // is the real check the whole remove/re-sign dance defends. (CI also smoke-
  // tests, but a standalone `node scripts/build-binary.mjs` on a Mac should
  // catch a non-launching binary too.)
  run(outExe, ['--version']);
}

console.log('');
console.log(`OK  ${outExe}`);
console.log(`    ${fmtSize(outExe)}`);
console.log('');
// `--version` is the only subcommand src/index.ts implements; anything else
// falls through to starting the stdio MCP server, which just blocks on stdin.
console.log('Verify with:');
console.log(`    "${outExe}" --version`);
