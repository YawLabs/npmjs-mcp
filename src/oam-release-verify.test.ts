import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// One level below the repo root in both layouts (src/ as written, dist/ when
// run), like src/oam-floor.test.ts. The subject lives in scripts/, which
// tsconfig does not include, so it is driven through its CLI.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFIER = join(repoRoot, "scripts", "oam-release-verify.mjs");
const KEYS = join(repoRoot, "scripts", "oam-release-keys");
// The real v0.18.0 release's RELEASE-MANIFEST and .sig, and v0.17.1's
// SHA256SUMS, captured from github.com/YawLabs/oam/releases and committed so
// the signature path is exercised offline.
const FIXTURES = join(repoRoot, "scripts", "fixtures", "oam-release");
const MANIFEST = join(FIXTURES, "v0.18.0", "RELEASE-MANIFEST");
const SIG = join(FIXTURES, "v0.18.0", "RELEASE-MANIFEST.sig");
const SUMS_0171 = join(FIXTURES, "v0.17.1", "SHA256SUMS");

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "npmjs-mcp-oam-verify-"));
  dirs.push(d);
  return d;
}

function verify(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [VERIFIER, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// The signature cases need ssh-keygen; skip them, loudly, on a box without one.
// The pinned-SHA256SUMS cases below do not.
// Same lookup as the verifier's findSshKeygen: SSH_KEYGEN, PATH, then Windows'
// inbox OpenSSH.
const inboxKeygen = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh-keygen.exe");
const probe = spawnSync(process.env.SSH_KEYGEN ?? "ssh-keygen", ["-?"], { encoding: "utf8" });
const haveKeygen = !probe.error || (process.platform === "win32" && existsSync(inboxKeygen));
const noKeygen = haveKeygen ? false : "ssh-keygen was not found; signature verification untested";

describe("oam release verification: signed RELEASE-MANIFEST", { skip: noKeygen }, () => {
  it("accepts the real v0.18.0 manifest and takes the asset hashes from it", () => {
    const r = verify(["--tag", "v0.18.0", "--manifest", MANIFEST, "--sig", SIG]);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /^80adb2a2e390080752191ea59430af397461a742dc985d1b24ca9c8f6cf37f6e oam-aarch64-pc-windows-msvc\.exe$/m,
    );
    assert.match(
      r.out,
      /^c80692bb070bdea33f56eaa3986b80e2596df0d1ef10bc85aa115cc511a4ab0e oam-x86_64-unknown-linux-gnu$/m,
    );
  });

  it("refuses a manifest signed for another tag -- a replayed release", () => {
    const r = verify(["--tag", "v0.18.1", "--manifest", MANIFEST, "--sig", SIG]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /signed for v0\.18\.0, not v0\.18\.1/);
  });

  it("refuses a manifest whose bytes were changed after signing", () => {
    const d = tempDir();
    const tampered = join(d, "RELEASE-MANIFEST");
    // Swap one binary's hash for another's: still a well-formed manifest.
    writeFileSync(tampered, readFileSync(MANIFEST, "utf8").replace("80adb2a2", "c9fc1210"));
    const r = verify(["--tag", "v0.18.0", "--manifest", tampered, "--sig", SIG]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /does not verify against any oam release key/);
    assert.doesNotMatch(r.out, /^[0-9a-f]{64} /m, "nothing may be printed as verified");
  });

  it("refuses a valid signature from a key whose range does not cover the tag", () => {
    const d = tempDir();
    copyFileSync(join(KEYS, "allowed_signers"), join(d, "allowed_signers"));
    copyFileSync(join(KEYS, "presigning-sums"), join(d, "presigning-sums"));
    writeFileSync(join(d, "ranges"), "k1 v0.19.0 -\n");
    const r = verify(["--tag", "v0.18.0", "--manifest", MANIFEST, "--sig", SIG, "--keys", d]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /oam-release-k1 may not sign v0\.18\.0/);
  });
});

describe("oam release verification: pre-signing SHA256SUMS", () => {
  it("accepts a pre-v0.18.0 SHA256SUMS whose digest is pinned for its tag", () => {
    const r = verify(["--tag", "v0.17.1", "--sums", SUMS_0171]);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /^9140fa0eabde83eef13c02aed871dbd2ea852f7283e238115c01ca4c57f21298 oam-x86_64-unknown-linux-gnu$/m,
    );
  });

  it("refuses a SHA256SUMS that is not the pinned one for the tag", () => {
    const r = verify(["--tag", "v0.17.0", "--sums", SUMS_0171]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not the pinned/);
  });

  it("refuses SHA256SUMS for a signed-era tag: it must come with a manifest", () => {
    const r = verify(["--tag", "v0.18.0", "--sums", SUMS_0171]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /signed-era release/);
  });

  it("refuses a pre-signing tag that is not pinned", () => {
    const r = verify(["--tag", "v0.5.0", "--sums", SUMS_0171]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not in release-keys\/presigning-sums/);
  });
});
