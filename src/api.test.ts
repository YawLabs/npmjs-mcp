import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import {
  encPkg,
  encScope,
  encTeam,
  encUser,
  maxSatisfying,
  registryGet,
  validatePackageName,
  validateScope,
  validateTeam,
  validateUsername,
} from "./api.js";

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

// ─── Scope / username / team validators and encoders ───

describe("validateScope / validateUsername / validateTeam", () => {
  it("accepts well-formed idents (with and without leading @ where applicable)", () => {
    assert.equal(validateScope("yawlabs"), null);
    assert.equal(validateScope("@yawlabs"), null);
    assert.equal(validateUsername("alice"), null);
    assert.equal(validateUsername("@alice"), null);
    assert.equal(validateTeam("devs"), null);
  });

  it("rejects empty, CRLF, and path-traversal idents", () => {
    for (const v of ["", "bad\nident", "bad\r\nident", "../evil", "a/b"]) {
      assert.ok(validateScope(v), `validateScope should reject ${JSON.stringify(v)}`);
      assert.ok(validateUsername(v), `validateUsername should reject ${JSON.stringify(v)}`);
      assert.ok(validateTeam(v), `validateTeam should reject ${JSON.stringify(v)}`);
    }
  });

  it("rejects leading dot/underscore and non-ASCII", () => {
    assert.ok(validateScope(".hidden"));
    assert.ok(validateScope("_private"));
    assert.ok(validateUsername(".hidden"));
  });
});

describe("encScope / encUser / encTeam", () => {
  it("strip leading @ and URL-encode the remainder", () => {
    assert.equal(encScope("@yawlabs"), "yawlabs");
    assert.equal(encUser("@alice"), "alice");
    assert.equal(encTeam("devs"), "devs");
  });

  it("throw on invalid input (would otherwise build malformed URLs)", () => {
    assert.throws(() => encScope("a/b"), /Invalid/);
    assert.throws(() => encUser("bad\nident"), /Invalid/);
    assert.throws(() => encTeam(""), /empty/i);
  });
});

// ─── Retry/backoff + env-driven base URL ───

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NPM_REGISTRY;
  delete process.env.NPM_RETRY_BACKOFF_MS;
});
after(() => {
  globalThis.fetch = originalFetch;
});

describe("retry/backoff on transient failures", () => {
  it("retries 503 up to MAX_RETRIES and eventually succeeds", async () => {
    // Zero backoff so the test isn't slow.
    process.env.NPM_RETRY_BACKOFF_MS = "0";
    const calls: string[] = [];
    let i = 0;
    globalThis.fetch = (async () => {
      i++;
      if (i < 3) {
        calls.push(`503-${i}`);
        return new Response("service unavailable", { status: 503 });
      }
      calls.push(`200-${i}`);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const res = await registryGet("/test");
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 3);
  });

  it("gives up after MAX_RETRIES and returns the last failure", async () => {
    process.env.NPM_RETRY_BACKOFF_MS = "0";
    let i = 0;
    globalThis.fetch = (async () => {
      i++;
      return new Response("still unavailable", { status: 503 });
    }) as typeof fetch;

    const res = await registryGet("/test");
    assert.equal(res.ok, false);
    assert.equal(res.status, 503);
    // MAX_RETRIES = 2 → total of 3 attempts
    assert.equal(i, 3);
  });

  it("does NOT retry non-retryable statuses (e.g. 404)", async () => {
    process.env.NPM_RETRY_BACKOFF_MS = "0";
    let i = 0;
    globalThis.fetch = (async () => {
      i++;
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const res = await registryGet("/test");
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.equal(i, 1);
  });
});

describe("NPM_REGISTRY env override", () => {
  it("routes registry calls through the override URL", async () => {
    process.env.NPM_REGISTRY = "https://registry.example.internal";
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await registryGet("/express");
    assert.equal(seen.length, 1);
    assert.ok(seen[0].startsWith("https://registry.example.internal/"));
  });

  it("strips trailing slashes from the override URL", async () => {
    process.env.NPM_REGISTRY = "https://registry.example.internal////";
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await registryGet("/express");
    assert.equal(seen[0], "https://registry.example.internal/express");
  });
});
