import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encPkg, maxSatisfying, validatePackageName } from "./api.js";

// ─── maxSatisfying ───

describe("maxSatisfying", () => {
  const versions = ["1.0.0", "1.2.3", "1.2.4", "1.3.0", "2.0.0", "2.1.0"];

  it("returns exact match when range is an exact version", () => {
    assert.equal(maxSatisfying(versions, "1.2.3"), "1.2.3");
  });

  it("resolves caret ranges to the highest compatible minor/patch", () => {
    // ^1.2.3 means >=1.2.3 <2.0.0 — should pick 1.3.0 (highest <2.0.0)
    assert.equal(maxSatisfying(versions, "^1.2.3"), "1.3.0");
  });

  it("caret on 0.x bumps the minor, not the major", () => {
    // ^0.2.3 means >=0.2.3 <0.3.0
    const zv = ["0.2.2", "0.2.3", "0.2.9", "0.3.0", "0.4.0"];
    assert.equal(maxSatisfying(zv, "^0.2.3"), "0.2.9");
  });

  it("caret on 0.0.x bumps only the patch", () => {
    // ^0.0.3 means >=0.0.3 <0.0.4 — the exact version only
    const zv = ["0.0.2", "0.0.3", "0.0.4", "0.0.5"];
    assert.equal(maxSatisfying(zv, "^0.0.3"), "0.0.3");
  });

  it("resolves tilde ranges within the same minor", () => {
    // ~1.2.3 means >=1.2.3 <1.3.0
    assert.equal(maxSatisfying(versions, "~1.2.3"), "1.2.4");
  });

  it("tilde does not cross the minor boundary", () => {
    assert.notEqual(maxSatisfying(versions, "~1.2.3"), "1.3.0");
  });

  it("resolves >= ranges to the highest overall", () => {
    assert.equal(maxSatisfying(versions, ">=1.2.4"), "2.1.0");
  });

  it("resolves < ranges (exclusive upper bound)", () => {
    assert.equal(maxSatisfying(versions, "<2.0.0"), "1.3.0");
  });

  it("resolves <= ranges (inclusive upper bound)", () => {
    assert.equal(maxSatisfying(versions, "<=1.2.4"), "1.2.4");
  });

  it("resolves > ranges (exclusive lower bound)", () => {
    // >1.0.0 should not include 1.0.0
    assert.notEqual(maxSatisfying(versions, ">1.0.0"), "1.0.0");
  });

  it("resolves hyphen ranges", () => {
    // 1.2.3 - 2.0.0 means >=1.2.3 <=2.0.0
    assert.equal(maxSatisfying(versions, "1.2.3 - 2.0.0"), "2.0.0");
  });

  it("resolves compound ranges (space-separated comparators)", () => {
    // >=1.2.0 <2.0.0
    assert.equal(maxSatisfying(versions, ">=1.2.0 <2.0.0"), "1.3.0");
  });

  it("resolves || union ranges", () => {
    // ^1.0.0 || ^2.0.0 — should pick the highest across both
    assert.equal(maxSatisfying(versions, "^1.0.0 || ^2.0.0"), "2.1.0");
  });

  it("handles * as match-all", () => {
    assert.equal(maxSatisfying(versions, "*"), "2.1.0");
  });

  it("handles empty string as match-all", () => {
    assert.equal(maxSatisfying(versions, ""), "2.1.0");
  });

  it("handles x-ranges on major", () => {
    // "1" or "1.x" means >=1.0.0 <2.0.0
    assert.equal(maxSatisfying(versions, "1.x"), "1.3.0");
    assert.equal(maxSatisfying(versions, "1"), "1.3.0");
  });

  it("handles x-ranges on minor", () => {
    // "1.2.x" means >=1.2.0 <1.3.0
    assert.equal(maxSatisfying(versions, "1.2.x"), "1.2.4");
  });

  it("skips prereleases when range is non-prerelease", () => {
    const withPre = ["1.0.0", "1.2.0", "2.0.0-beta.1", "2.0.0-beta.2"];
    // ^1.0.0 should pick 1.2.0, never 2.0.0-beta (prerelease excluded)
    assert.equal(maxSatisfying(withPre, "^1.0.0"), "1.2.0");
    // ^2.0.0 should fail to match any non-prerelease 2.x
    assert.equal(maxSatisfying(withPre, "^2.0.0"), null);
  });

  it("returns null when no version matches", () => {
    assert.equal(maxSatisfying(versions, "^3.0.0"), null);
  });

  it("strips a leading v prefix", () => {
    assert.equal(maxSatisfying(versions, "v1.2.3"), "1.2.3");
  });

  it("returns null for unparseable ranges", () => {
    assert.equal(maxSatisfying(versions, "not-a-range"), null);
  });
});

// ─── validatePackageName ───

describe("validatePackageName", () => {
  it("accepts simple lowercase names", () => {
    assert.equal(validatePackageName("express"), null);
    assert.equal(validatePackageName("react-dom"), null);
    assert.equal(validatePackageName("react_dom"), null);
    assert.equal(validatePackageName("react.dom"), null);
  });

  it("accepts scoped names", () => {
    assert.equal(validatePackageName("@yawlabs/npmjs-mcp"), null);
    assert.equal(validatePackageName("@anthropic-ai/sdk"), null);
  });

  it("accepts alphanumeric-led names with mixed case (legacy packages)", () => {
    // Legacy packages with uppercase exist in the registry — must not be rejected.
    assert.equal(validatePackageName("JSONStream"), null);
  });

  it("rejects empty strings", () => {
    const err = validatePackageName("");
    assert.ok(err !== null);
    assert.match(err!, /empty/i);
  });

  it("rejects names longer than 214 chars", () => {
    const longName = "a".repeat(215);
    const err = validatePackageName(longName);
    assert.ok(err !== null);
    assert.match(err!, /214/);
  });

  it("accepts names at exactly 214 chars", () => {
    const boundary = "a".repeat(214);
    assert.equal(validatePackageName(boundary), null);
  });

  it("rejects leading dot", () => {
    assert.ok(validatePackageName(".hidden") !== null);
  });

  it("rejects leading underscore", () => {
    assert.ok(validatePackageName("_private") !== null);
  });

  it("rejects path traversal attempts", () => {
    assert.ok(validatePackageName("../evil") !== null);
    assert.ok(validatePackageName("foo/bar") !== null);
  });

  it("rejects newlines and control characters", () => {
    assert.ok(validatePackageName("foo\nbar") !== null);
    assert.ok(validatePackageName("foo\tbar") !== null);
  });

  it("rejects scoped names with bad scope", () => {
    assert.ok(validatePackageName("@/pkg") !== null);
    assert.ok(validatePackageName("@.scope/pkg") !== null);
  });

  it("rejects unscoped names starting with @", () => {
    assert.ok(validatePackageName("@foo") !== null);
  });
});

// ─── encPkg ───

describe("encPkg", () => {
  it("encodes unscoped names via encodeURIComponent", () => {
    assert.equal(encPkg("express"), "express");
  });

  it("preserves leading @ for scoped packages but encodes the slash", () => {
    assert.equal(encPkg("@yawlabs/npmjs-mcp"), `@${encodeURIComponent("yawlabs/npmjs-mcp")}`);
  });

  it("throws on invalid names rather than silently producing bad URLs", () => {
    assert.throws(() => encPkg(""), /empty/i);
    assert.throws(() => encPkg("foo/bar"), /Invalid/);
    assert.throws(() => encPkg("../evil"), /Invalid/);
  });
});
