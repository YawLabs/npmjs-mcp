#!/usr/bin/env node
/**
 * Verify an oam release the way oam's own installers do, before a downloaded
 * oam binary is trusted as a carrier (scripts/build-binary.mjs).
 *
 * WHY NOT SHA256SUMS
 * SHA256SUMS proves a download matches the release it came from. It cannot
 * prove the release came from oam: whoever can upload to the release uploads a
 * matching SHA256SUMS beside the binary. From v0.18.0 every oam release also
 * carries
 *
 *   RELEASE-MANIFEST      "oam-release-manifest v1\n" + "tag <tag>\n" + the
 *                         SHA256SUMS bytes, verbatim
 *   RELEASE-MANIFEST.sig  an SSH signature over it (namespace "oam-release")
 *                         by a key in oam's release-keys/allowed_signers
 *
 * and the checksum is taken from the SIGNED manifest, never from an unsigned
 * SHA256SUMS. The tag line binds the signature to one release, so an old,
 * correctly signed release cannot be replayed as another.
 *
 * WHAT IS CHECKED, in this order (content only after the signature, because
 * until it verifies the content is attacker-controlled):
 *   1. the signature verifies, with `ssh-keygen -Y verify`, for a principal in
 *      the vendored allowed_signers, namespace oam-release
 *   2. the manifest starts with exactly the v1 header and "tag <expected>"
 *   3. the signing key's range in the vendored `ranges` covers that tag
 * Tags before the first range (pre-v0.18.0, cut before signing existed) have no
 * manifest; their SHA256SUMS is accepted only when its SHA-256 is the one
 * pinned for that tag in the vendored `presigning-sums`. A pre-signing tag that
 * is not pinned, and a signing-era tag with no manifest, are refused. Every
 * failure throws: there is no skip knob.
 *
 * THE TRUST ROOT is scripts/oam-release-keys/, a verbatim copy of oam's
 * release-keys/{allowed_signers,ranges,presigning-sums}. When oam rotates a key
 * (a new line in allowed_signers, a closed range), copy the three files again.
 *
 * ssh-keygen 8.1+ is needed (macOS and Linux ship it; on Windows the inbox
 * OpenSSH client in System32\OpenSSH). SSH_KEYGEN overrides the lookup.
 *
 * CLI (for tests and by hand):
 *   node scripts/oam-release-verify.mjs --tag v0.18.0 --manifest M --sig S [--keys DIR]
 *   node scripts/oam-release-verify.mjs --tag v0.17.1 --sums SHA256SUMS [--keys DIR]
 * prints "<sha256> <asset>" per binary and exits 0, or names the failure and
 * exits 1.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_KEYS_DIR = join(dirname(fileURLToPath(import.meta.url)), "oam-release-keys");
const MANIFEST_HEADER = "oam-release-manifest v1";
const NAMESPACE = "oam-release";

/** "v0.18.0" or "0.18.0" -> [0, 18, 0]; null for anything that is not a plain tag. */
export function parseTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareTags(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Non-comment, non-blank lines of a release-keys file, split on whitespace. */
function rows(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
}

function readKeys(keysDir) {
  const read = (name) => {
    const path = join(keysDir, name);
    if (!existsSync(path)) throw new Error(`oam release trust root is incomplete: ${path} is missing`);
    return readFileSync(path, "utf8");
  };
  const principals = rows(read("allowed_signers")).map(([principal]) => principal);
  if (principals.length === 0) throw new Error(`${join(keysDir, "allowed_signers")} names no key`);
  const ranges = new Map();
  for (const row of rows(read("ranges"))) {
    const [id, from, to] = row;
    if (row.length !== 3 || !parseTag(from) || (to !== "-" && !parseTag(to))) {
      throw new Error(`malformed line in ${join(keysDir, "ranges")}: '${row.join(" ")}'`);
    }
    ranges.set(`oam-release-${id}`, { from: parseTag(from), to: to === "-" ? null : parseTag(to) });
  }
  const presigning = new Map(rows(read("presigning-sums")).map(([tag, sha]) => [tag, sha?.toLowerCase()]));
  return { principals, ranges, presigning };
}

/** True when `tag` comes before every key's range: cut before signing existed. */
function predatesSigning(tag, ranges) {
  const v = parseTag(tag);
  return [...ranges.values()].every((r) => compareTags(v, r.from) < 0);
}

/** SHA256SUMS text -> Map(asset -> lowercase sha256). Accepts "<sha> *name" and "<sha>  name". */
export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

/** ssh-keygen to verify with: SSH_KEYGEN, else PATH, else Windows' inbox OpenSSH. */
export function findSshKeygen() {
  if (process.env.SSH_KEYGEN) return process.env.SSH_KEYGEN;
  const candidates = ["ssh-keygen"];
  if (process.platform === "win32") {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    candidates.push(join(root, "Sysnative", "OpenSSH", "ssh-keygen.exe"), join(root, "System32", "OpenSSH", "ssh-keygen.exe"));
  }
  for (const candidate of candidates) {
    if (candidate !== "ssh-keygen" && !existsSync(candidate)) continue;
    try {
      // `-?` prints usage and exits non-zero on every ssh-keygen. The probe only
      // proves the binary can be executed; an ssh-keygen too old for `-Y verify`
      // fails the verify itself, which is fail-closed.
      execFileSync(candidate, ["-?"], { stdio: "ignore", windowsHide: true });
      return candidate;
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      return candidate; // it ran and exited non-zero, which `-?` does
    }
  }
  throw new Error(
    "ssh-keygen was not found, and it is required to verify the oam release signature. " +
      "Install OpenSSH 8.1+ (on Windows: Settings > Optional features > OpenSSH Client), or set SSH_KEYGEN.",
  );
}

/**
 * Verify a signed manifest for `tag`. Returns Map(asset -> sha256) from the
 * signed SUMS section. Throws on any failure.
 */
export function verifyManifest({ manifest, sig, tag, keysDir = DEFAULT_KEYS_DIR, sshKeygen = findSshKeygen() }) {
  const v = parseTag(tag);
  if (!v) throw new Error(`'${tag}' is not a plain vX.Y.Z tag`);
  const want = `v${v.join(".")}`;
  const { principals, ranges } = readKeys(keysDir);

  const dir = mkdtempSync(join(tmpdir(), "oam-release-verify-"));
  let signer = null;
  let last = "";
  try {
    const sigPath = join(dir, "RELEASE-MANIFEST.sig");
    writeFileSync(sigPath, sig);
    for (const principal of principals) {
      try {
        execFileSync(
          sshKeygen,
          ["-Y", "verify", "-f", join(keysDir, "allowed_signers"), "-I", principal, "-n", NAMESPACE, "-s", sigPath],
          { input: manifest, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
        );
        signer = principal;
        break;
      } catch (err) {
        last = `${err?.stderr ?? ""}${err?.stdout ?? ""}`.trim() || String(err?.message ?? err);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!signer) {
    throw new Error(`RELEASE-MANIFEST.sig does not verify against any oam release key (namespace ${NAMESPACE}): ${last}`);
  }

  const prefix = Buffer.from(`${MANIFEST_HEADER}\ntag ${want}\n`, "utf8");
  const buf = Buffer.from(manifest);
  if (buf.length < prefix.length || !buf.subarray(0, prefix.length).equals(prefix)) {
    const [line1 = "", line2 = ""] = buf.toString("utf8").split("\n");
    if (line1.replace(/\r$/, "") !== MANIFEST_HEADER) throw new Error(`RELEASE-MANIFEST line 1 is '${line1}', not '${MANIFEST_HEADER}'`);
    if (line2.startsWith("tag ") && line2.replace(/\r$/, "") !== `tag ${want}`) {
      throw new Error(`RELEASE-MANIFEST is signed for ${line2.slice(4).trim()}, not ${want} -- a replayed or misfiled release`);
    }
    throw new Error(`RELEASE-MANIFEST's header is not byte-exact for ${want}`);
  }

  const range = ranges.get(signer);
  if (!range) throw new Error(`key ${signer} has no range in release-keys/ranges, so it may sign nothing yet`);
  if (compareTags(v, range.from) < 0 || (range.to && compareTags(v, range.to) > 0)) {
    throw new Error(`key ${signer} may not sign ${want} (release-keys/ranges)`);
  }

  const sums = parseSums(buf.subarray(prefix.length).toString("utf8"));
  if (sums.size === 0) throw new Error("RELEASE-MANIFEST's SUMS section lists no binary");
  return sums;
}

/**
 * Verify a pre-signing release's SHA256SUMS against the pinned table. Returns
 * Map(asset -> sha256). Throws when `tag` is in the signing era (it must carry a
 * manifest) or is not pinned, or when the digest differs.
 */
export function verifyPresigningSums({ sums, tag, keysDir = DEFAULT_KEYS_DIR }) {
  const v = parseTag(tag);
  if (!v) throw new Error(`'${tag}' is not a plain vX.Y.Z tag`);
  const want = `v${v.join(".")}`;
  const { ranges, presigning } = readKeys(keysDir);
  if (!predatesSigning(want, ranges)) {
    throw new Error(`${want} is a signed-era release, so it must be verified against its RELEASE-MANIFEST, not SHA256SUMS`);
  }
  const pinned = presigning.get(want);
  if (!pinned) throw new Error(`${want} predates release signing and is not in release-keys/presigning-sums; refusing it`);
  const got = createHash("sha256").update(sums).digest("hex");
  if (got !== pinned) throw new Error(`SHA256SUMS for ${want} hashes to ${got}, not the pinned ${pinned}`);
  return parseSums(Buffer.from(sums).toString("utf8"));
}

/**
 * Fetch and verify the checksum table of oam release `tag` from `base`
 * (https://github.com/YawLabs/oam/releases/download/<tag>). Signed-era tags
 * use RELEASE-MANIFEST(.sig); earlier ones the pinned SHA256SUMS.
 */
export async function fetchVerifiedSums(base, tag, keysDir = DEFAULT_KEYS_DIR) {
  const get = async (name) => {
    const res = await fetch(`${base}/${name}`);
    if (!res.ok) throw new Error(`could not fetch ${name} (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  };
  const { ranges } = readKeys(keysDir);
  if (predatesSigning(tag, ranges)) {
    return { sums: verifyPresigningSums({ sums: await get("SHA256SUMS"), tag, keysDir }), how: "pinned SHA256SUMS" };
  }
  const sums = verifyManifest({ manifest: await get("RELEASE-MANIFEST"), sig: await get("RELEASE-MANIFEST.sig"), tag, keysDir });
  return { sums, how: "signed RELEASE-MANIFEST" };
}

async function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const tag = opt("--tag");
  const keysDir = opt("--keys") ? resolve(opt("--keys")) : DEFAULT_KEYS_DIR;
  let sums;
  if (opt("--sums")) {
    sums = verifyPresigningSums({ sums: readFileSync(opt("--sums")), tag, keysDir });
  } else {
    sums = verifyManifest({ manifest: readFileSync(opt("--manifest")), sig: readFileSync(opt("--sig")), tag, keysDir });
  }
  for (const [asset, sha] of sums) console.log(`${sha} ${asset}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    console.error(`oam-release-verify: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
