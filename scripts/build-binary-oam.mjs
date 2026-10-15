#!/usr/bin/env node
// Build a self-contained single-file binary of this MCP server on an oam
// carrier.
//
// Strategy: esbuild bundles src/index.ts + ALL its dependencies (including
// the externals tsup leaves out -- @modelcontextprotocol/sdk and undici)
// into ONE CommonJS file with zero remaining node_modules resolution, then
// that bundle is appended to an oam runtime binary as a tail-trailer payload
// (see appendOamPayload). The result runs with no Node, no node_modules, and
// no PATH dependency.
//
// The bundle MUST be CJS: oam runs the embedded file as CommonJS, so the ESM
// bundle build.mjs writes to dist/index.js would die at startup on its
// `import` banner. We re-bundle here rather than reuse dist/index.js.
//
// This script ONLY reads node_modules (via esbuild's resolver) and writes to
// build-tmp/ and bin/<platform>-<arch>/. It does NOT mutate package.json,
// package-lock.json, src/, or node_modules, and it never runs `npm install`.
//
// Usage:
//   node scripts/build-binary-oam.mjs                                  # host build
//   NPMJS_MCP_BINARY_TARGET=linux-x64 node scripts/build-binary-oam.mjs  # cross build

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { fetchVerifiedSums } from './oam-release-verify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
const { version } = pkg;
// Binary name = the package's first `bin` command, so this script is
// copy-paste generic across @yawlabs/* servers -- no per-repo rename.
const binName = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.split('/').pop();

// Release assets published at github.com/YawLabs/oam/releases, keyed by the
// `${process.platform}-${process.arch}` shape this script already uses.
const OAM_ASSETS = {
  'win32-x64': 'oam-x86_64-pc-windows-msvc.exe',
  'win32-arm64': 'oam-aarch64-pc-windows-msvc.exe',
  'darwin-arm64': 'oam-aarch64-apple-darwin',
  'darwin-x64': 'oam-x86_64-apple-darwin',
  'linux-x64': 'oam-x86_64-unknown-linux-gnu',
};

// NPMJS_MCP_BINARY_TARGET cross-builds for another platform. The carrier for
// the target is fetched from the oam release; the payload is the same bytes
// on every target.
const TARGET = (process.env.NPMJS_MCP_BINARY_TARGET ?? `${process.platform}-${process.arch}`).toLowerCase();
const isCross = TARGET !== `${process.platform}-${process.arch}`;
const targetIsWin = TARGET.startsWith('win32');

const platformDir = TARGET;
const binDir = join(repoRoot, 'bin', platformDir);
const tmpDir = join(repoRoot, 'build-tmp');
const bundlePath = join(tmpDir, 'oam-bundle.cjs');
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
 * WHY THIS CAN CROSS-BUILD
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
 * itself falls back to. The cost is losing the first-run parse skip.
 */
async function appendOamPayload(carrier, jsPath, outPath) {
  const js = readFileSync(jsPath);
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(js.length));
  const magic = Buffer.from('OAMEXEC\0', 'binary');
  writeFileSync(outPath, Buffer.concat([readFileSync(carrier), js, len, magic]));
  if (!targetIsWin) chmodSync(outPath, 0o755);
}

/**
 * The oam release to fetch a carrier from: OAM_VERSION when set, else the
 * launcher's floor (OAM_MIN in bin/npmjs-mcp.mjs) -- the one release this server
 * is verified on. Never 'latest': the signed manifest binds its signature to
 * ONE tag, so verification needs to know which tag it asked for, and a moving
 * 'latest' would also build on a release nobody verified the server on.
 */
function oamReleaseTag() {
  const requested = process.env.OAM_VERSION;
  if (requested) {
    const m = /^v?(\d+\.\d+\.\d+)$/.exec(requested.trim());
    if (!m) {
      console.error(`build-binary-oam: OAM_VERSION=${requested} is not a plain release version (e.g. 0.18.0 or v0.18.0).`);
      process.exit(1);
    }
    return `v${m[1]}`;
  }
  const launcher = readFileSync(join(repoRoot, 'bin', `${binName}.mjs`), 'utf-8');
  const floor = /const OAM_MIN = \[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(launcher);
  if (!floor) {
    console.error(`build-binary-oam: could not read OAM_MIN from bin/${binName}.mjs; set OAM_VERSION.`);
    process.exit(1);
  }
  return `v${floor[1]}.${floor[2]}.${floor[3]}`;
}

/**
 * Fetch the published oam release binary for TARGET, verified against the
 * release's signed RELEASE-MANIFEST (see scripts/oam-release-verify.mjs).
 */
async function fetchOamCarrier(target) {
  const asset = OAM_ASSETS[target];
  if (!asset) {
    console.error(
      `build-binary-oam: no oam release asset known for target '${target}'.\n` +
        `Known targets: ${Object.keys(OAM_ASSETS).join(', ')}`,
    );
    process.exit(1);
  }
  const tag = oamReleaseTag();
  const base = `https://github.com/YawLabs/oam/releases/download/${tag}`;
  const dest = join(tmpDir, asset);

  // Integrity is not optional for a binary we are about to ship inside our own,
  // and a SHA256SUMS served beside the binary proves nothing about who uploaded
  // both. So the expected hash comes from the release's SIGNED manifest, checked
  // against oam's release keys (vendored in scripts/oam-release-keys/), BEFORE
  // the binary is downloaded. Pre-v0.18.0 tags have no manifest and are held to
  // a pinned digest of their SHA256SUMS instead. Every failure stops the build.
  let want;
  try {
    const { sums, how } = await fetchVerifiedSums(base, tag);
    want = sums.get(asset);
    if (!want) throw new Error(`${asset} is not listed in the ${how} for ${tag}`);
    console.log(`  ${tag}: ${how} verified`);
  } catch (err) {
    console.error(`build-binary-oam: refusing an unverified oam carrier: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(`> fetch ${base}/${asset}`);
  const res = await fetch(`${base}/${asset}`);
  if (!res.ok) {
    console.error(`build-binary-oam: downloading ${asset} failed (HTTP ${res.status})`);
    process.exit(1);
  }
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));

  const got = createHash('sha256').update(readFileSync(dest)).digest('hex');
  if (got !== want) {
    console.error(`build-binary-oam: SHA256 mismatch for ${asset}\n  expected ${want}\n  got      ${got}`);
    process.exit(1);
  }
  console.log(`  sha256 ok (${got.slice(0, 16)}...)`);
  return dest;
}

/**
 * The Windows oam binaries are Authenticode-signed from oam 0.18.0 on, and the
 * signature does not survive the append. Measured on the v0.18.0
 * oam-x86_64-pc-windows-msvc.exe carrier: Get-AuthenticodeSignature reports the
 * carrier Valid and the appended artifact NotSigned, although the artifact still
 * holds the carrier's certificate table. So the artifact ships unsigned in
 * effect. Nothing here strips or re-signs it -- say so, the way the macOS note
 * does for Mach-O.
 */
function windowsSignatureNote() {
  if (!targetIsWin) return;
  console.log('    Windows: the oam carrier is Authenticode-signed, but the appended artifact is not');
  console.log('    (Get-AuthenticodeSignature: NotSigned). To ship it signed, remove the carrier\'s');
  console.log('    signature BEFORE appending (signtool remove /s) and sign the finished artifact;');
  console.log('    this script automates neither.');
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
    windowsSignatureNote();
    return;
  }

  // `--version` is the only subcommand src/index.ts implements; anything else
  // falls through to starting the stdio MCP server, which just blocks on stdin.
  run(outExe, ['--version']);
  console.log('');
  console.log(`OK  ${outExe}  (oam carrier)`);
  console.log(`    ${fmtSize(outExe)}`);
  windowsSignatureNote();
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
  banner: { js: "const __oamImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { __VERSION__: JSON.stringify(version), 'import.meta.url': '__oamImportMetaUrl' },
  outfile: bundlePath,
});
console.log(`bundle: ${fmtSize(bundlePath)}`);

// 2. Append the bundle to the oam carrier.
await buildViaOam();
