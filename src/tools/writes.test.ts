import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { versionsSatisfying } from "../api.js";
import {
  CALL_HINTS,
  REGISTRY_CALLS,
  type RegistryCall,
  translateError,
  validateDeprecationMessage,
} from "../errors.js";
import { authTools } from "./auth.js";
import { registryTools } from "./registry.js";
import { writeTools } from "./writes.js";

// ─── Test harness (mirrors handlers.test.ts pattern) ───

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let lastRequest: CapturedRequest | undefined;
let requests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    let body: unknown;
    if (init?.body) {
      const raw = init.body.toString();
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    lastRequest = { url, method, headers, body };
    requests.push(lastRequest);

    const response = responses[i];
    if (!response) throw new Error(`mockFetchSequence over-run: request ${i} to ${url}`);
    i++;
    if (response.status === 204) {
      return new Response(null, { status: 204, headers: { "content-length": "0" } });
    }
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function mockFetch(status = 200, responseData: unknown = {}) {
  mockFetchSequence([{ status, body: responseData }]);
}

// biome-ignore lint/complexity/noBannedTypes: test helper needs generic function matching
function findTool(tools: readonly { name: string; handler: Function }[], name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function samplePackument(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _id: "@test/pkg",
    _rev: "1-abc",
    name: "@test/pkg",
    "dist-tags": { latest: "1.0.0" },
    versions: {
      "0.1.0": { name: "@test/pkg", version: "0.1.0" },
      "0.2.0": { name: "@test/pkg", version: "0.2.0" },
      "1.0.0": { name: "@test/pkg", version: "1.0.0" },
    },
    maintainers: [{ name: "alice", email: "alice@test.com" }],
    ...overrides,
  };
}

before(() => {
  process.env.NPM_TOKEN = "test-token-writes";
});

after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NPM_TOKEN;
});

beforeEach(() => {
  lastRequest = undefined;
  requests = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── errors.ts helpers ───

describe("translateError", () => {
  it("401 translates to auth-failure message with token guidance", () => {
    const out = translateError(
      { ok: false, status: 401, error: "Unauthorized" },
      { pkg: "@test/pkg", op: "deprecate" },
    );
    assert.equal(out.ok, false);
    assert.match(out.error!, /Authentication failed/);
    assert.match(out.error!, /@test\/pkg/);
    assert.match(out.error!, /Granular Access Token/);
  });

  it("403 translates to authorization-failure with maintainer guidance", () => {
    const out = translateError({ ok: false, status: 403, error: "Forbidden" }, { pkg: "@test/pkg" });
    assert.match(out.error!, /Not authorized/);
    assert.match(out.error!, /npm_collaborators/);
  });

  it("404 translates to not-found with package-name guidance", () => {
    const out = translateError({ ok: false, status: 404, error: "Not Found" }, { pkg: "@test/pkg" });
    assert.match(out.error!, /Not found/);
    assert.match(out.error!, /scoped packages require the @scope\//);
  });

  it("401 and 403 place OTP at 401 and 2FA policy at 403, never recommend npm login or a classic token", () => {
    for (const status of [401, 403]) {
      const out = translateError({ ok: false, status, error: "x" }, { pkg: "@test/pkg" }).error!;
      assert.match(out, /OTP challenge arrives as 401 and a 2FA-policy refusal as 403, never as 422/, `${status}`);
      assert.match(out, /Granular Access Token with 'Read and write' permission and 2FA bypass/, `${status}`);
      assert.match(out, /revoked in December 2025/, `${status}`);
      assert.doesNotMatch(out, /npm login|auth-type=web|use a classic|classic Automation token, which/i, `${status}`);
      // No call means a read or pre-write step: the neutral wording, no "this change".
      assert.match(out, /for headless writes/, `${status}`);
    }
  });

  it("401 and 403 on a call npm restricted on 2026-07-31 send a human to the CLI, not to a new token", () => {
    const interactive = REGISTRY_CALLS.filter((c) => CALL_HINTS[c].interactive2fa);
    // Exactly the calls npm's 2026-07-31 list covers: tokens, package access,
    // maintainers, org/team membership and package grants. Team create and
    // destroy are not on it.
    assert.deepEqual([...interactive].sort(), [
      "access-mfa-post",
      "access-post",
      "org-user-delete",
      "org-user-put",
      "packument-put-maintainer-add",
      "packument-put-maintainer-remove",
      "team-package-delete",
      "team-package-put",
      "team-user-delete",
      "team-user-put",
      "token-delete",
    ]);
    for (const status of [401, 403]) {
      const out = translateError(
        { ok: false, status, error: "x" },
        { pkg: "@t/p", call: "packument-put-maintainer-add" },
      ).error!;
      assert.match(out, /Since 2026-07-31 npm requires an interactive 2FA challenge/, `${status}`);
      assert.match(out, /a human runs `npm owner add <user> @t\/p`/, `${status}`);
      assert.doesNotMatch(out, /2FA bypass enabled \(https/, `${status}`);
    }
    // A write NOT on the list keeps the token advice, worded for the change.
    const dep = translateError({ ok: false, status: 401, error: "x" }, { call: "packument-put-deprecate" }).error!;
    assert.match(dep, /answers both for this change/);
    assert.doesNotMatch(dep, /Since 2026-07-31/);
  });

  it("422 with no call falls back to the read wording", () => {
    const out = translateError({ ok: false, status: 422, error: "Unprocessable" }, { pkg: "@test/pkg" });
    assert.match(out.error!, /422/);
    assert.match(out.error!, /not known to answer a read/);
    assert.match(out.error!, /NPM_REGISTRY/);
    assert.match(out.error!, /Raw: Unprocessable$/);
    // The retired causes must not come back through the default branch, and a
    // CLI command belongs to write calls only.
    assert.doesNotMatch(out.error!, /semver range|1024|auth-type=web|npm login|2FA|OTP|deprecat|CLI equivalent/);
  });

  it("every RegistryCall renders one line that ends in the raw body, for 401, 403 and 422", () => {
    for (const call of REGISTRY_CALLS) {
      for (const status of [401, 403, 422]) {
        const out = translateError({ ok: false, status, error: "boom" }, { call, pkg: "@t/p" }).error!;
        assert.ok(!out.includes("\n"), `${call} ${status}: multi-line`);
        assert.ok(out.endsWith("Raw: boom"), `${call} ${status}: missing Raw suffix`);
        assert.doesNotMatch(out, /undefined/, `${call} ${status}`);
      }
      const unprocessable = translateError({ ok: false, status: 422, error: "boom" }, { call }).error!;
      assert.ok(unprocessable.includes(CALL_HINTS[call].check), `${call}: 422 does not carry its own row`);
    }
  });

  it("every call hint is distinct", () => {
    const texts = new Set(REGISTRY_CALLS.map((call) => CALL_HINTS[call].check));
    assert.equal(texts.size, REGISTRY_CALLS.length);
  });

  it("no 422 hint names a retired cause", () => {
    // 2FA may appear only where it is about the TARGET account's settings.
    const aboutTargetAccount = new Set<RegistryCall>(["access-mfa-post", "org-user-put"]);
    for (const call of REGISTRY_CALLS) {
      const out = translateError({ ok: false, status: 422, error: "x" }, { call }).error!;
      assert.doesNotMatch(out, /auth-type=web|npm login|semver range matches no|1024|Automation token/i, call);
      if (!aboutTargetAccount.has(call)) assert.doesNotMatch(out, /\b2FA\b|two-factor/i, call);
    }
  });

  it("only rows with an npm 11 command name a CLI equivalent", () => {
    // `npm hook` was removed in npm 11; reads have no single command.
    const noCli = new Set<RegistryCall>(["read", "hook-post", "hook-put", "hook-delete"]);
    for (const call of REGISTRY_CALLS) {
      const out = translateError({ ok: false, status: 422, error: "x" }, { call }).error!;
      if (noCli.has(call)) assert.doesNotMatch(out, /CLI equivalent/, call);
      else assert.match(out, /CLI equivalent[^`]*`npm /, call);
    }
  });

  it("<pkg> is substituted from context.pkg and left as a placeholder without it", () => {
    const withPkg = translateError({ ok: false, status: 422, error: "x" }, { call: "dist-tag-put", pkg: "@t/p" })
      .error!;
    assert.match(withPkg, /npm dist-tag add @t\/p@<version> <tag>/);
    const withoutPkg = translateError({ ok: false, status: 422, error: "x" }, { call: "dist-tag-put" }).error!;
    assert.match(withoutPkg, /npm dist-tag add <pkg>@<version> <tag>/);
    // No pkg and no op: the preamble carries neither " for <pkg>" nor " during <op>".
    assert.match(withoutPkg, /^Registry rejected the request \(422 Unprocessable Entity\)\. /);
  });

  it("<pkg> substitution is literal: `$` patterns in the package are not expanded", () => {
    for (const pkg of ["a$&b", "a$$b", "x$'y"]) {
      const rendered = translateError({ ok: false, status: 422, error: "x" }, { call: "dist-tag-delete", pkg }).error!;
      assert.ok(rendered.includes(`\`npm dist-tag rm ${pkg} <tag>\``), `${pkg}: ${rendered}`);
    }
  });

  it("an unrecognized call falls back to read and never prints undefined", () => {
    const out = translateError({ ok: false, status: 422, error: "x" }, { call: "bogus" as RegistryCall }).error!;
    assert.match(out, /not known to answer a read/);
    assert.doesNotMatch(out, /undefined/);
  });

  it("op stays prose in the 422 preamble", () => {
    const out = translateError(
      { ok: false, status: 422, error: "x" },
      { pkg: "@t/p", op: "deprecate (write)", call: "packument-put-deprecate" },
    ).error!;
    assert.match(out, /^Registry rejected the request for @t\/p during deprecate \(write\) \(422/);
  });

  it("token-delete never echoes a key", () => {
    const out = translateError({ ok: false, status: 422, error: "x" }, { call: "token-delete", op: "token_revoke" })
      .error!;
    assert.doesNotMatch(out, /[0-9a-f]{8,}/);
    assert.match(out, /npm token revoke <id\|token>/);
  });

  it("passes through 2xx unchanged", () => {
    const out = translateError({ ok: true, status: 200, data: { x: 1 } }, {});
    assert.equal(out.ok, true);
    assert.deepEqual(out.data, { x: 1 });
  });

  // The four branches below are what a caller sees precisely when the registry
  // is misbehaving. They were the untested half of translateError.

  it("429 says the retry budget was already spent, so the caller waits rather than hammering", () => {
    const out = translateError({ ok: false, status: 429, error: "Too Many Requests" }, { op: "deprecate" });
    assert.equal(out.ok, false);
    assert.match(out.error!, /Rate limited/);
    assert.match(out.error!, /Retried automatically and still failed/);
    assert.match(out.error!, /during deprecate/);
  });

  it("409 explains the read-write race and that re-running re-reads _rev", () => {
    const out = translateError({ ok: false, status: 409, error: "Conflict" }, { pkg: "@test/pkg", op: "deprecate" });
    assert.match(out.error!, /Version conflict/);
    assert.match(out.error!, /concurrent publish/);
    assert.match(out.error!, /re-fetches the current _rev/);
  });

  it("status 0 is reported as a network error, not an HTTP failure", () => {
    const out = translateError({ ok: false, status: 0, error: "fetch failed" }, { op: "whoami" });
    assert.match(out.error!, /Network error/);
    assert.match(out.error!, /Could not reach the registry/);
    // Must not be mistaken for a server-side fault.
    assert.equal(/Registry server error/.test(out.error!), false);
  });

  it("5xx points at the status page and preserves the code", () => {
    for (const status of [500, 502, 503]) {
      const out = translateError({ ok: false, status, error: "boom" }, { pkg: "@test/pkg" });
      assert.match(out.error!, /Registry server error/, `status ${status}`);
      assert.match(out.error!, new RegExp(`HTTP ${status}`));
      assert.match(out.error!, /status\.npmjs\.org/);
    }
  });

  it("leaves an unrecognized 4xx untouched rather than inventing guidance", () => {
    const out = translateError({ ok: false, status: 418, error: "teapot" }, { pkg: "@test/pkg" });
    assert.equal(out.error, "teapot");
  });
});

describe("validateDeprecationMessage", () => {
  it("accepts em-dash + lowercase form", () => {
    assert.equal(validateDeprecationMessage("Renamed to @yawlabs/spend — install that instead"), null);
  });

  it("accepts empty string (undeprecate)", () => {
    assert.equal(validateDeprecationMessage(""), null);
  });

  it("accepts period-capital patterns (they do not 422 in practice)", () => {
    // The earlier heuristic flagged this shape after a single 422; follow-up diagnosis
    // in issue #2 confirmed the 422 was caused by a wildcard version mismatch, not
    // message formatting. The check produced false positives and was removed.
    assert.equal(validateDeprecationMessage("Renamed to @yawlabs/spend. Install that instead."), null);
  });

  it("rejects messages over 1024 characters", () => {
    const err = validateDeprecationMessage("a".repeat(1025));
    assert.ok(err);
    assert.match(err!, /1024 characters/);
  });

  it("accepts a message of exactly 1024 characters (the limit is inclusive)", () => {
    assert.equal(validateDeprecationMessage("a".repeat(1024)), null);
  });
});

describe("versionsSatisfying", () => {
  it("returns all versions for '*'", () => {
    const out = versionsSatisfying(["1.0.0", "2.0.0", "3.0.0"], "*");
    assert.deepEqual(out, ["1.0.0", "2.0.0", "3.0.0"]);
  });

  it("filters by range", () => {
    const out = versionsSatisfying(["0.1.0", "0.2.0", "1.0.0"], "<1.0.0");
    assert.deepEqual(out.sort(), ["0.1.0", "0.2.0"]);
  });

  it("matches a bare exact version like '1.2.3' (the shape npm_deprecate hands us)", () => {
    // Regression guard: parseSingleConstraint used to return null for bare
    // N.N.N (treating it as the x-range branch's "handled elsewhere" case),
    // which left versionsSatisfying returning [] and silently breaking
    // npm_deprecate(versionRange: "1.2.3").
    const out = versionsSatisfying(["1.2.3", "1.2.4"], "1.2.3");
    assert.deepEqual(out, ["1.2.3"]);
  });

  it("a bare exact version does not let prereleases of the same base leak through", () => {
    // No prerelease tag in the range source -> no anchor -> the standard
    // prerelease-exclusion rule still applies.
    const out = versionsSatisfying(["1.2.3-beta.1", "1.2.3"], "1.2.3");
    assert.deepEqual(out, ["1.2.3"]);
  });
});

// ─── npm_deprecate ───

describe("npm_deprecate", () => {
  it("happy path: deprecates all versions and calls GET then PUT", async () => {
    mockFetchSequence([
      { status: 200, body: samplePackument() },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_deprecate");
    const result = (await tool.handler({
      name: "@test/pkg",
      message: "Renamed to @test/newpkg — install that instead",
    })) as { ok: boolean; data: { affectedVersions: string[] } };

    assert.equal(result.ok, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[1].method, "PUT");
    assert.equal(result.data.affectedVersions.length, 3);
  });

  it("filters by versionRange", async () => {
    mockFetchSequence([
      { status: 200, body: samplePackument() },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_deprecate");
    const result = (await tool.handler({
      name: "@test/pkg",
      message: "old — upgrade to 1.x",
      versionRange: "<1.0.0",
    })) as { ok: boolean; data: { affectedVersions: string[] } };

    assert.equal(result.ok, true);
    assert.equal(result.data.affectedVersions.length, 2);
    assert.ok(result.data.affectedVersions.includes("0.1.0"));
    assert.ok(result.data.affectedVersions.includes("0.2.0"));
  });

  it("accepts period-capital message without force (check removed)", async () => {
    mockFetchSequence([
      { status: 200, body: samplePackument() },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_deprecate");
    const result = (await tool.handler({
      name: "@test/pkg",
      message: "Renamed. Install instead.",
    })) as { ok: boolean };
    assert.equal(result.ok, true);
  });

  it("rejects messages over 1024 characters", async () => {
    const tool = findTool(writeTools, "npm_deprecate");
    const result = (await tool.handler({
      name: "@test/pkg",
      message: "a".repeat(1025),
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /1024/);
  });

  it("returns 400 when no versions match range, listing the published versions", async () => {
    mockFetchSequence([{ status: 200, body: samplePackument() }]);
    const tool = findTool(writeTools, "npm_deprecate");
    const result = (await tool.handler({
      name: "@test/pkg",
      message: "deprecated — migrate",
      versionRange: ">9.0.0",
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /No versions match range '>9\.0\.0' for @test\/pkg\./);
    // The list is what the caller corrects the range from, so pin its contents.
    assert.match(result.error, /Published versions: 0\.1\.0, 0\.2\.0, 1\.0\.0\./);
    // Rejected before the write: only the GET went out.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
  });

  it("returns 400 naming '(none)' when the packument has no versions object", async () => {
    const noVersions = samplePackument();
    // biome-ignore lint/performance/noDelete: removing the key models a packument with no versions object
    delete (noVersions as Record<string, unknown>).versions;
    mockFetchSequence([{ status: 200, body: noVersions }]);
    const tool = findTool(writeTools, "npm_deprecate");
    const result = (await tool.handler({
      name: "@test/pkg",
      message: "deprecated — migrate",
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /No versions match range '\*' for @test\/pkg\./);
    assert.match(result.error, /Published versions: \(none\)\./);
    assert.equal(requests.length, 1);
  });

  it("writes the message onto exactly the versions inside versionRange in the PUT body", async () => {
    // affectedVersions in the response is computed locally, so it cannot show
    // what was sent. Only the PUT body proves which versions got deprecated.
    mockFetchSequence([
      { status: 200, body: samplePackument() },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_deprecate");
    const message = "old — upgrade to 1.x";
    const result = (await tool.handler({
      name: "@test/pkg",
      message,
      versionRange: "<1.0.0",
    })) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(requests[1].method, "PUT");
    const versions = (requests[1].body as { versions: Record<string, Record<string, unknown>> }).versions;
    assert.equal(versions["0.1.0"].deprecated, message);
    assert.equal(versions["0.2.0"].deprecated, message);
    assert.ok(!("deprecated" in versions["1.0.0"]), "1.0.0 is outside the range and must not be deprecated");
  });

  it("strips CouchDB _revisions and _attachments from the PUT body", async () => {
    mockFetchSequence([
      {
        status: 200,
        body: samplePackument({
          _revisions: { start: 1, ids: ["abc"] },
          _attachments: { "pkg-1.0.0.tgz": { content_type: "application/octet-stream", stub: true } },
        }),
      },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_deprecate");
    const result = (await tool.handler({
      name: "@test/pkg",
      message: "deprecated — use newpkg",
    })) as { ok: boolean };
    assert.equal(result.ok, true);
    const body = requests[1].body as Record<string, unknown>;
    assert.ok(!("_revisions" in body), "_revisions must not be echoed back");
    assert.ok(!("_attachments" in body), "_attachments must not be echoed back");
    assert.ok("versions" in body);
  });

  it("translates 401 from GET into actionable error", async () => {
    mockFetchSequence([{ status: 401, body: { error: "Unauthorized" } }]);
    const tool = findTool(writeTools, "npm_deprecate");
    const result = (await tool.handler({
      name: "@test/pkg",
      message: "deprecated — use newpkg",
    })) as { ok: boolean; error: string };
    assert.equal(result.ok, false);
    assert.match(result.error, /Authentication failed/);
  });

  // ─── GAP 1: requireAuth short-circuits when NPM_TOKEN is UNSET ───
  it("short-circuits 401 + token-setup guidance when NPM_TOKEN is unset, with no network call", async () => {
    // The shared `before` hook sets NPM_TOKEN for the whole file; delete it for
    // this one case and restore in finally so the rest of the suite is unaffected.
    const saved = process.env.NPM_TOKEN;
    delete process.env.NPM_TOKEN;
    // Mock the network so that, if requireAuth ever failed to short-circuit, we'd
    // see a request recorded and the lastRequest assertion below would catch it.
    mockFetchSequence([{ status: 200, body: samplePackument() }]);
    try {
      const tool = findTool(writeTools, "npm_deprecate");
      const result = (await tool.handler({
        name: "@test/pkg",
        message: "deprecated — use newpkg",
      })) as { ok: boolean; status: number; error: string };
      assert.equal(result.ok, false);
      assert.equal(result.status, 401);
      assert.match(result.error, /No NPM_TOKEN configured/);
      assert.match(result.error, /Set the NPM_TOKEN environment variable/);
      assert.match(result.error, /Granular Access Token/);
      // requireAuth runs before any fetch -- the registry must not be touched.
      assert.equal(lastRequest, undefined);
      assert.equal(requests.length, 0);
    } finally {
      process.env.NPM_TOKEN = saved;
    }
  });

  // ─── GAP 2: missing-_rev guard returns 500 when the packument lacks _rev ───
  it("returns 500 when the fetched packument lacks _rev (missing-rev guard)", async () => {
    // Packument has versions (so versionsSatisfying finds affected versions and
    // execution reaches the _rev guard) but no _rev field. Only the GET fires;
    // the PUT write-step is never reached.
    const noRev = samplePackument();
    // biome-ignore lint/performance/noDelete: removing the key models the registry omitting _rev
    delete (noRev as Record<string, unknown>)._rev;
    mockFetchSequence([{ status: 200, body: noRev }]);
    const tool = findTool(writeTools, "npm_deprecate");
    const result = (await tool.handler({
      name: "@test/pkg",
      message: "deprecated — use newpkg",
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
    assert.match(result.error, /missing _rev/);
    // Only the GET happened -- no PUT, since the guard fires before the write.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
  });

  // ─── W8: 409-retry on CouchDB OCC conflict ───
  it("retries once on 409 from PUT (CouchDB OCC): re-fetches and re-applies mutation", async () => {
    const pkg1 = samplePackument({ _rev: "1-abc" });
    const pkg2 = samplePackument({ _rev: "2-def" });
    mockFetchSequence([
      { status: 200, body: pkg1 }, // initial GET
      { status: 409, body: { error: "Conflict" } }, // PUT conflicts (OCC)
      { status: 200, body: pkg2 }, // retry GET with fresh rev
      { status: 200, body: {} }, // retry PUT succeeds
    ]);
    const tool = findTool(writeTools, "npm_deprecate");
    const result = (await tool.handler({
      name: "@test/pkg",
      message: "deprecated -- use newpkg",
    })) as { ok: boolean; data: { affectedVersions: string[] } };
    assert.equal(result.ok, true);
    assert.equal(requests.length, 4);
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[1].method, "PUT");
    assert.equal(requests[2].method, "GET"); // re-fetch on conflict
    assert.equal(requests[3].method, "PUT");
    // The retry PUT must use the fresh rev (2-def), not the stale rev (1-abc).
    assert.match(requests[3].url, /\/-rev\/2-def$/);
    assert.equal(result.data.affectedVersions.length, 3);
  });

  // ─── GAP 3: the PUT write-step (not just the GET) translates a 422 ───
  it("translates a 422 from the PUT write-step into actionable error", async () => {
    // GET returns a valid packument with _rev; the PUT then 422s. The handler
    // must run translateError on the PUT response, not just the GET.
    mockFetchSequence([
      { status: 200, body: samplePackument() }, // GET packument (ok)
      { status: 422, body: { error: "Unprocessable" } }, // PUT write (rejected)
    ]);
    const tool = findTool(writeTools, "npm_deprecate");
    const result = (await tool.handler({
      name: "@test/pkg",
      message: "deprecated — use newpkg",
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.match(result.error, /Registry rejected the request/);
    assert.match(result.error, /422/);
    // The deprecate-specific wording: what was sent, and the CLI equivalent
    // with the package substituted. Never the causes the handler pre-checks.
    assert.match(result.error, /with `deprecated` set on the versions matching the range/);
    assert.match(result.error, /npm deprecate @test\/pkg@"<range>"/);
    assert.doesNotMatch(result.error, /semver range|1024|auth-type/);
    // Confirm the failure came from the PUT step, not the GET.
    assert.equal(requests.length, 2);
    assert.equal(requests[1].method, "PUT");
  });

  it("a 422 from the pre-write GET gets the read wording, not the deprecate wording", async () => {
    mockFetchSequence([{ status: 422, body: { error: "Unprocessable" } }]);
    const tool = findTool(writeTools, "npm_deprecate");
    const result = (await tool.handler({
      name: "@test/pkg",
      message: "deprecated — use newpkg",
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.match(result.error, /during deprecate \(fetch\)/);
    assert.match(result.error, /not known to answer a read/);
    assert.doesNotMatch(result.error, /`deprecated`|npm deprecate/);
    assert.equal(requests.length, 1);
  });

  it("surfaces a translated 409 when the conflict survives the single retry", async () => {
    mockFetchSequence([
      { status: 200, body: samplePackument({ _rev: "1-abc" }) },
      { status: 409, body: { error: "Conflict" } },
      { status: 200, body: samplePackument({ _rev: "2-def" }) },
      { status: 409, body: { error: "Conflict" } },
    ]);
    const tool = findTool(writeTools, "npm_deprecate");
    const result = (await tool.handler({
      name: "@test/pkg",
      message: "deprecated — use newpkg",
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.match(result.error, /Version conflict/);
    assert.equal(requests.length, 4, "exactly one retry, then give up");
  });
});

// ─── npm_undeprecate ───

describe("npm_undeprecate", () => {
  it("clears deprecation on all versions", async () => {
    const pkg = samplePackument({
      versions: {
        "0.1.0": { name: "@test/pkg", version: "0.1.0", deprecated: "old" },
        "0.2.0": { name: "@test/pkg", version: "0.2.0", deprecated: "old" },
        "1.0.0": { name: "@test/pkg", version: "1.0.0", deprecated: "old" },
      },
    });
    mockFetchSequence([
      { status: 200, body: pkg },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_undeprecate");
    const result = (await tool.handler({ name: "@test/pkg" })) as {
      ok: boolean;
      data: { totalAffected: number };
    };
    assert.equal(result.ok, true);
    assert.equal(result.data.totalAffected, 3);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[1].method, "PUT");
    // All versions must have deprecated cleared to "" in the PUT body.
    const putBody = requests[1].body as { versions: Record<string, { deprecated?: string }> };
    for (const v of ["0.1.0", "0.2.0", "1.0.0"]) {
      assert.equal(putBody.versions[v].deprecated, "");
    }
  });

  it("retries once on 409 from PUT (CouchDB OCC): re-fetches and re-applies the clear", async () => {
    // Same full-packument read-modify-write as npm_deprecate, so it loses the
    // same race against a concurrent publish. npm_deprecate's 409 retry is
    // pinned; this one was added later and had no coverage.
    const deprecated = {
      versions: {
        "0.1.0": { name: "@test/pkg", version: "0.1.0", deprecated: "old" },
        "1.0.0": { name: "@test/pkg", version: "1.0.0", deprecated: "old" },
      },
    };
    mockFetchSequence([
      { status: 200, body: samplePackument({ ...deprecated, _rev: "1-abc" }) },
      { status: 409, body: { error: "Conflict" } },
      { status: 200, body: samplePackument({ ...deprecated, _rev: "2-def" }) },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_undeprecate");
    const result = (await tool.handler({ name: "@test/pkg" })) as {
      ok: boolean;
      data: { totalAffected: number };
    };
    assert.equal(result.ok, true);
    assert.equal(requests.length, 4);
    assert.deepEqual(
      requests.map((r) => r.method),
      ["GET", "PUT", "GET", "PUT"],
    );
    // The retry must use the fresh rev, not the stale one.
    assert.match(requests[3].url, /\/-rev\/2-def$/);
    assert.equal(result.data.totalAffected, 2);
  });

  it("surfaces a translated 409 when the conflict survives the single retry", async () => {
    mockFetchSequence([
      { status: 200, body: samplePackument({ _rev: "1-abc" }) },
      { status: 409, body: { error: "Conflict" } },
      { status: 200, body: samplePackument({ _rev: "2-def" }) },
      { status: 409, body: { error: "Conflict" } },
    ]);
    const tool = findTool(writeTools, "npm_undeprecate");
    const result = (await tool.handler({ name: "@test/pkg" })) as {
      ok: boolean;
      status: number;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.match(result.error, /Version conflict/);
    assert.equal(requests.length, 4, "exactly one retry, then give up");
  });
});

// ─── npm_unpublish_version ───

describe("npm_unpublish_version", () => {
  it("requires confirm: true (handler-level guard)", async () => {
    const tool = findTool(writeTools, "npm_unpublish_version");
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing types to test runtime guard
    const result = (await (tool.handler as any)({
      name: "@test/pkg",
      version: "0.1.0",
      confirm: false,
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /confirm: true/);
  });

  it("unpublishes a specific version: GET → PUT /-rev → GET → DELETE tarball", async () => {
    const pkg = samplePackument({
      versions: {
        "0.1.0": {
          name: "@test/pkg",
          version: "0.1.0",
          dist: { tarball: "https://registry.npmjs.org/@test/pkg/-/pkg-0.1.0.tgz" },
        },
        "0.2.0": { name: "@test/pkg", version: "0.2.0" },
        "1.0.0": { name: "@test/pkg", version: "1.0.0" },
      },
    });
    mockFetchSequence([
      { status: 200, body: pkg },
      { status: 200, body: {} },
      { status: 200, body: { ...pkg, _rev: "2-def" } },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_unpublish_version");
    const result = (await tool.handler({
      name: "@test/pkg",
      version: "0.1.0",
      confirm: true,
    })) as { ok: boolean; data: { remainingVersions: string[]; tarballDeleted: boolean; complete: boolean } };
    assert.equal(result.ok, true);
    assert.ok(!result.data.remainingVersions.includes("0.1.0"));
    assert.equal(result.data.remainingVersions.length, 2);
    assert.equal(result.data.tarballDeleted, true);
    assert.equal(result.data.complete, true);
    // PUT to /-rev/1-abc
    assert.equal(requests[1].method, "PUT");
    assert.match(requests[1].url, /\/-rev\/1-abc$/);
    // DELETE tarball with fresh rev
    assert.equal(requests[3].method, "DELETE");
    assert.match(requests[3].url, /\/@test\/pkg\/-\/pkg-0\.1\.0\.tgz\/-rev\/2-def$/);
  });

  it("reports complete:false when packument PUT succeeds but tarball DELETE fails", async () => {
    const pkg = samplePackument({
      versions: {
        "0.1.0": {
          name: "@test/pkg",
          version: "0.1.0",
          dist: { tarball: "https://registry.npmjs.org/@test/pkg/-/pkg-0.1.0.tgz" },
        },
        "0.2.0": { name: "@test/pkg", version: "0.2.0" },
        "1.0.0": { name: "@test/pkg", version: "1.0.0" },
      },
    });
    mockFetchSequence([
      { status: 200, body: pkg }, // GET packument
      { status: 200, body: {} }, // PUT packument (success)
      { status: 200, body: { ...pkg, _rev: "2-def" } }, // re-GET for fresh rev
      { status: 500, body: "boom" }, // DELETE tarball (fails)
    ]);
    const tool = findTool(writeTools, "npm_unpublish_version");
    const result = (await tool.handler({
      name: "@test/pkg",
      version: "0.1.0",
      confirm: true,
    })) as {
      ok: boolean;
      data: { complete: boolean; tarballDeleted: boolean; tarballWarning?: string };
    };
    assert.equal(result.ok, true);
    assert.equal(result.data.tarballDeleted, false);
    assert.equal(result.data.complete, false);
    assert.ok(result.data.tarballWarning);
  });

  it("reports complete:true when the version had no tarball URL to delete", async () => {
    const pkg = samplePackument({
      versions: {
        "0.1.0": { name: "@test/pkg", version: "0.1.0" }, // no dist.tarball
        "0.2.0": { name: "@test/pkg", version: "0.2.0" },
        "1.0.0": { name: "@test/pkg", version: "1.0.0" },
      },
    });
    mockFetchSequence([
      { status: 200, body: pkg },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_unpublish_version");
    const result = (await tool.handler({
      name: "@test/pkg",
      version: "0.1.0",
      confirm: true,
    })) as { ok: boolean; data: { complete: boolean; tarballDeleted: boolean } };
    assert.equal(result.ok, true);
    assert.equal(result.data.tarballDeleted, false);
    assert.equal(result.data.complete, true);
  });

  it("does not set dist-tags.latest to a prerelease when the only stable version is unpublished", async () => {
    // Unpublishing the sole stable release leaves only prereleases. Per npm
    // convention `latest` must not point at a prerelease, so the recompute
    // helper should return null and `latest` should be removed entirely
    // (the dist-tag deletion loop already handled it by virtue of pointing at
    // the unpublished version).
    const pkg = samplePackument({
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name: "@test/pkg",
          version: "1.0.0",
          dist: { tarball: "https://registry.npmjs.org/@test/pkg/-/pkg-1.0.0.tgz" },
        },
        "1.1.0-beta.1": { name: "@test/pkg", version: "1.1.0-beta.1" },
        "2.0.0-alpha.3": { name: "@test/pkg", version: "2.0.0-alpha.3" },
      },
    });
    mockFetchSequence([
      { status: 200, body: pkg },
      { status: 200, body: {} },
      { status: 200, body: { ...pkg, _rev: "2-def" } },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_unpublish_version");
    await tool.handler({ name: "@test/pkg", version: "1.0.0", confirm: true });
    const putBody = requests[1].body as { "dist-tags": Record<string, string> };
    // No latest tag at all — better than pointing at a prerelease.
    assert.ok(!("latest" in putBody["dist-tags"]));
  });

  it("does not crash when the registry returns a packument with no dist-tags object", async () => {
    // The deletion loop tolerates a missing dist-tags via `|| {}`; the
    // newLatest assignment must mirror that. Without the guard, this case
    // throws TypeError reading `.latest` on undefined.
    const pkg = {
      _id: "@test/pkg",
      _rev: "1-abc",
      name: "@test/pkg",
      // No "dist-tags" key at all.
      versions: {
        "0.1.0": { name: "@test/pkg", version: "0.1.0", dist: { tarball: "https://r/p/-/p-0.1.0.tgz" } },
        "0.2.0": { name: "@test/pkg", version: "0.2.0" },
      },
      maintainers: [{ name: "alice", email: "alice@test.com" }],
    };
    mockFetchSequence([
      { status: 200, body: pkg },
      { status: 200, body: {} },
      { status: 200, body: { ...pkg, _rev: "2-def" } },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_unpublish_version");
    const result = (await tool.handler({ name: "@test/pkg", version: "0.1.0", confirm: true })) as { ok: boolean };
    assert.equal(result.ok, true);
  });

  it("resets dist-tags.latest when removing the version it pointed at", async () => {
    const pkg = samplePackument({
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "0.1.0": { name: "@test/pkg", version: "0.1.0" },
        "0.2.0": { name: "@test/pkg", version: "0.2.0" },
        "1.0.0": {
          name: "@test/pkg",
          version: "1.0.0",
          dist: { tarball: "https://registry.npmjs.org/@test/pkg/-/pkg-1.0.0.tgz" },
        },
      },
    });
    mockFetchSequence([
      { status: 200, body: pkg },
      { status: 200, body: {} },
      { status: 200, body: { ...pkg, _rev: "2-def" } },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_unpublish_version");
    await tool.handler({ name: "@test/pkg", version: "1.0.0", confirm: true });
    const putBody = requests[1].body as { "dist-tags": Record<string, string> };
    assert.equal(putBody["dist-tags"].latest, "0.2.0");
  });

  it("returns 404 for nonexistent version", async () => {
    mockFetchSequence([{ status: 200, body: samplePackument() }]);
    const tool = findTool(writeTools, "npm_unpublish_version");
    const result = (await tool.handler({
      name: "@test/pkg",
      version: "9.9.9",
      confirm: true,
    })) as { ok: boolean; status: number };
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  });

  it("removes a non-latest dist-tag pointing at the version and does NOT reassign it", async () => {
    // Documented behaviour: any tag aimed at the unpublished version is dropped,
    // but only `latest` is recomputed -- `next`/`beta` are left unset for the
    // caller to reassign. Every other test drives the `latest` path, so the
    // documented half of this irreversible operation was unverified.
    const pkg = samplePackument({
      "dist-tags": { latest: "1.0.0", next: "0.2.0", beta: "0.2.0" },
      versions: {
        "0.1.0": { name: "@test/pkg", version: "0.1.0" },
        "0.2.0": {
          name: "@test/pkg",
          version: "0.2.0",
          dist: { tarball: "https://registry.npmjs.org/@test/pkg/-/pkg-0.2.0.tgz" },
        },
        "1.0.0": { name: "@test/pkg", version: "1.0.0" },
      },
    });
    mockFetchSequence([
      { status: 200, body: pkg },
      { status: 200, body: {} },
      { status: 200, body: { ...pkg, _rev: "2-def" } },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_unpublish_version");
    const result = (await tool.handler({ name: "@test/pkg", version: "0.2.0", confirm: true })) as { ok: boolean };
    assert.equal(result.ok, true);
    const putTags = (requests[1].body as { "dist-tags": Record<string, string> })["dist-tags"];
    assert.ok(!("next" in putTags), "next pointed at the removed version and must be dropped");
    assert.ok(!("beta" in putTags), "beta pointed at the removed version and must be dropped");
    // latest pointed elsewhere, so it is untouched.
    assert.equal(putTags.latest, "1.0.0");
  });

  it("skips the tarball DELETE when the tarball origin differs from the configured registry", async () => {
    // Under a proxy registry (Verdaccio/Nexus) the tarball URL can point at a
    // different host. DELETEing there is a no-op at best and destructive at
    // worst, so the handler must skip it and report the reason.
    process.env.NPM_REGISTRY = "https://registry.internal.example";
    try {
      const pkg = samplePackument({
        versions: {
          "0.1.0": {
            name: "@test/pkg",
            version: "0.1.0",
            // Origin deliberately does NOT match NPM_REGISTRY.
            dist: { tarball: "https://registry.npmjs.org/@test/pkg/-/pkg-0.1.0.tgz" },
          },
          "1.0.0": { name: "@test/pkg", version: "1.0.0" },
        },
      });
      mockFetchSequence([
        { status: 200, body: pkg },
        { status: 200, body: {} },
        { status: 200, body: { ...pkg, _rev: "2-def" } },
      ]);
      const tool = findTool(writeTools, "npm_unpublish_version");
      const result = (await tool.handler({ name: "@test/pkg", version: "0.1.0", confirm: true })) as {
        ok: boolean;
        data: { complete: boolean; tarballDeleted: boolean; tarballWarning?: string };
      };
      assert.equal(result.ok, true);
      assert.equal(result.data.tarballDeleted, false);
      assert.equal(result.data.complete, false);
      assert.match(result.data.tarballWarning ?? "", /does not match registry origin/);
      // GET, PUT, GET(fresh rev) -- and crucially no DELETE.
      assert.equal(requests.length, 3);
      assert.equal(
        requests.some((r) => r.method === "DELETE"),
        false,
        "must not DELETE against a foreign origin",
      );
    } finally {
      delete process.env.NPM_REGISTRY;
    }
  });

  it("reports complete:false when the fresh-rev re-fetch fails before the tarball DELETE", async () => {
    // The packument PUT already succeeded, so the version is delisted -- but
    // without a fresh _rev the tarball stays live on the CDN. Callers need to
    // see that partial state rather than a flat success.
    process.env.NPM_RETRY_BACKOFF_MS = "0";
    try {
      const pkg = samplePackument({
        versions: {
          "0.1.0": {
            name: "@test/pkg",
            version: "0.1.0",
            dist: { tarball: "https://registry.npmjs.org/@test/pkg/-/pkg-0.1.0.tgz" },
          },
          "1.0.0": { name: "@test/pkg", version: "1.0.0" },
        },
      });
      mockFetchSequence([
        { status: 200, body: pkg }, // GET packument
        { status: 200, body: {} }, // PUT succeeds -- version is now delisted
        { status: 500, body: "boom" }, // re-GET for the fresh rev fails
      ]);
      const tool = findTool(writeTools, "npm_unpublish_version");
      const result = (await tool.handler({ name: "@test/pkg", version: "0.1.0", confirm: true })) as {
        ok: boolean;
        data: { complete: boolean; tarballDeleted: boolean; tarballWarning?: string };
      };
      assert.equal(result.ok, true);
      assert.equal(result.data.tarballDeleted, false);
      assert.equal(result.data.complete, false);
      assert.match(result.data.tarballWarning ?? "", /could not re-fetch packument/);
      assert.equal(
        requests.some((r) => r.method === "DELETE"),
        false,
        "no rev means no DELETE can be attempted",
      );
    } finally {
      delete process.env.NPM_RETRY_BACKOFF_MS;
    }
  });
});

// ─── npm_unpublish_package ───

describe("npm_unpublish_package", () => {
  it("DELETEs /{pkg}/-rev/{rev} after fetching rev", async () => {
    mockFetchSequence([
      { status: 200, body: samplePackument() },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_unpublish_package");
    const result = (await tool.handler({ name: "@test/pkg", confirm: true })) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(requests[1].method, "DELETE");
    assert.match(requests[1].url, /\/-rev\/1-abc$/);
  });

  it("requires confirm: true", async () => {
    const tool = findTool(writeTools, "npm_unpublish_package");
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing types to test runtime guard
    const result = (await (tool.handler as any)({ name: "@test/pkg", confirm: false })) as {
      ok: boolean;
      status: number;
    };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  });

  // ─── GAP 2: missing-_rev guard returns 500 when the packument lacks _rev ───
  it("returns 500 when the fetched packument lacks _rev (missing-rev guard)", async () => {
    const noRev = samplePackument();
    // biome-ignore lint/performance/noDelete: removing the key models the registry omitting _rev
    delete (noRev as Record<string, unknown>)._rev;
    mockFetchSequence([{ status: 200, body: noRev }]);
    const tool = findTool(writeTools, "npm_unpublish_package");
    const result = (await tool.handler({ name: "@test/pkg", confirm: true })) as {
      ok: boolean;
      status: number;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
    assert.match(result.error, /missing _rev/);
    // Only the GET fired -- the DELETE write-step is never reached.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
  });

  // ─── GAP 3: the DELETE write-step (not just the GET) translates a 403 ───
  it("translates a 403 from the DELETE write-step into actionable error", async () => {
    mockFetchSequence([
      { status: 200, body: samplePackument() }, // GET packument (ok, has _rev)
      { status: 403, body: { error: "Forbidden" } }, // DELETE write (rejected)
    ]);
    const tool = findTool(writeTools, "npm_unpublish_package");
    const result = (await tool.handler({ name: "@test/pkg", confirm: true })) as {
      ok: boolean;
      status: number;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.match(result.error, /Not authorized/);
    assert.match(result.error, /npm_collaborators/);
    // The failure came from the DELETE step, not the GET.
    assert.equal(requests.length, 2);
    assert.equal(requests[1].method, "DELETE");
  });
});

// ─── npm_access_set + npm_access_set_mfa ───

describe("npm_access_set", () => {
  it("POSTs to /-/package/<pkg>/access with access level, mapping 'private' to 'restricted' on the wire", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_access_set");
    const result = (await tool.handler({ name: "@test/pkg", access: "private" })) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(lastRequest!.method, "POST");
    assert.match(lastRequest!.url, /\/-\/package\/@test%2Fpkg\/access$/);
    // "private" maps to "restricted" on the wire (W4).
    assert.deepEqual(lastRequest!.body, { access: "restricted" });
  });
});

describe("npm_access_set_mfa", () => {
  it("publish-only MFA: publish_requires_tfa=true, automation_token_overrides_tfa=false", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_access_set_mfa");
    await tool.handler({ name: "@test/pkg", level: "publish" });
    assert.deepEqual(lastRequest!.body, { publish_requires_tfa: true, automation_token_overrides_tfa: false });
  });

  it("automation level: both flags true", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_access_set_mfa");
    await tool.handler({ name: "@test/pkg", level: "automation" });
    assert.deepEqual(lastRequest!.body, { publish_requires_tfa: true, automation_token_overrides_tfa: true });
  });

  it("none level: publish_requires_tfa=false", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_access_set_mfa");
    await tool.handler({ name: "@test/pkg", level: "none" });
    assert.deepEqual(lastRequest!.body, { publish_requires_tfa: false });
  });
});

// ─── team grant/revoke ───

describe("npm_team_grant", () => {
  it("PUTs to /-/team/<scope>/<team>/package with permissions body", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_team_grant");
    const result = (await tool.handler({
      team: "@yawlabs:devs",
      package: "@yawlabs/pkg",
      permissions: "read-write",
    })) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(lastRequest!.method, "PUT");
    assert.match(lastRequest!.url, /\/-\/team\/yawlabs\/devs\/package$/);
    assert.deepEqual(lastRequest!.body, { package: "@yawlabs/pkg", permissions: "read-write" });
  });

  it("rejects malformed team string", async () => {
    const tool = findTool(writeTools, "npm_team_grant");
    const result = (await tool.handler({
      team: "no-colon-here",
      package: "x",
      permissions: "read-only",
    })) as { ok: boolean; error: string };
    assert.equal(result.ok, false);
    assert.match(result.error, /@scope:team/);
  });
});

describe("npm_team_revoke", () => {
  it("DELETEs /-/team/<scope>/<team>/package with body", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_team_revoke");
    await tool.handler({ team: "@yawlabs:devs", package: "@yawlabs/pkg" });
    assert.equal(lastRequest!.method, "DELETE");
    assert.deepEqual(lastRequest!.body, { package: "@yawlabs/pkg" });
  });
});

// ─── team create/delete + members ───

describe("npm_team_create", () => {
  it("PUTs /-/org/<scope>/team with name + description", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_team_create");
    await tool.handler({ team: "@yawlabs:devs", description: "dev team" });
    assert.equal(lastRequest!.method, "PUT");
    assert.match(lastRequest!.url, /\/-\/org\/yawlabs\/team$/);
    assert.deepEqual(lastRequest!.body, { name: "devs", description: "dev team" });
  });
});

describe("npm_team_delete", () => {
  it("DELETEs /-/team/<scope>/<team>", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_team_delete");
    await tool.handler({ team: "@yawlabs:devs", confirm: true });
    assert.equal(lastRequest!.method, "DELETE");
    assert.match(lastRequest!.url, /\/-\/team\/yawlabs\/devs$/);
  });

  it("requires confirm: true", async () => {
    const tool = findTool(writeTools, "npm_team_delete");
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing types to test runtime guard
    const result = (await (tool.handler as any)({
      team: "@yawlabs:devs",
      confirm: false,
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /confirm: true/);
  });
});

describe("npm_team_member_add", () => {
  it("PUTs /-/team/<scope>/<team>/user with user body", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_team_member_add");
    await tool.handler({ team: "@yawlabs:devs", user: "bob" });
    assert.equal(lastRequest!.method, "PUT");
    assert.match(lastRequest!.url, /\/-\/team\/yawlabs\/devs\/user$/);
    assert.deepEqual(lastRequest!.body, { user: "bob" });
  });
});

describe("npm_team_member_remove", () => {
  it("DELETEs /-/team/<scope>/<team>/user with user body", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_team_member_remove");
    await tool.handler({ team: "@yawlabs:devs", user: "bob" });
    assert.equal(lastRequest!.method, "DELETE");
    assert.deepEqual(lastRequest!.body, { user: "bob" });
  });
});

// ─── org member set/remove ───

describe("npm_org_member_set", () => {
  it("PUTs /-/org/<org>/user with user + role body", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_org_member_set");
    await tool.handler({ org: "@yawlabs", user: "bob", role: "developer", confirm: true });
    assert.equal(lastRequest!.method, "PUT");
    assert.match(lastRequest!.url, /\/-\/org\/yawlabs\/user$/);
    assert.deepEqual(lastRequest!.body, { user: "bob", role: "developer" });
  });

  it("strips leading @ from org and user", async () => {
    // No role passed -> the handler reads the roster first, then PUTs. bob is
    // not on this roster, so no role is sent and the registry default applies.
    mockFetchSequence([
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_org_member_set");
    await tool.handler({ org: "yawlabs", user: "@bob", confirm: true });
    assert.deepEqual(lastRequest!.body, { user: "bob" });
  });

  it("response includes role when it was set", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_org_member_set");
    const result = (await tool.handler({ org: "yawlabs", user: "bob", role: "admin", confirm: true })) as {
      data: Record<string, unknown>;
    };
    assert.equal(result.data.role, "admin");
  });

  it("omitting role preserves an existing member's role by re-sending it explicitly", async () => {
    // The registry membership spec defines `role` as "defaults to 'developer'
    // if not given" -- it does NOT preserve. The npm CLI never hits that path
    // because it fills the same default itself (lib/commands/org.js:
    // `role = role || 'developer'`). So a bare { user } body silently demotes
    // an admin to developer. The handler must read the roster and send the
    // existing role back.
    mockFetchSequence([
      { status: 200, body: { alice: "owner", bob: "admin" } }, // roster read
      { status: 200, body: {} }, // PUT
    ]);
    const tool = findTool(writeTools, "npm_org_member_set");
    const result = (await tool.handler({ org: "yawlabs", user: "bob", confirm: true })) as {
      data: Record<string, unknown>;
    };
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, "GET");
    assert.match(requests[0].url, /\/-\/org\/yawlabs\/user$/);
    assert.equal(requests[1].method, "PUT");
    // The critical assertion: role is present and matches what bob already had.
    assert.deepEqual(requests[1].body, { user: "bob", role: "admin" });
    assert.equal(result.data.role, "admin");
    assert.equal(result.data.rolePreserved, true);
  });

  it("matches the roster entry case-insensitively when preserving a role", async () => {
    mockFetchSequence([
      { status: 200, body: { Bob: "owner" } },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_org_member_set");
    await tool.handler({ org: "yawlabs", user: "bob", confirm: true });
    assert.deepEqual(requests[1].body, { user: "bob", role: "owner" });
  });

  it("omitting role for a non-member sends no role and reports the registry default", async () => {
    mockFetchSequence([
      { status: 200, body: { alice: "owner" } }, // bob absent
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_org_member_set");
    const result = (await tool.handler({ org: "yawlabs", user: "bob", confirm: true })) as {
      data: Record<string, unknown>;
    };
    assert.deepEqual(requests[1].body, { user: "bob" });
    assert.equal(result.data.role, "developer");
    assert.ok(!("rolePreserved" in result.data));
  });

  it("fails closed instead of demoting when the roster read fails", async () => {
    // If we cannot learn the current role, PUTting a role-less body would
    // default the member to 'developer'. Refuse rather than risk the demotion.
    mockFetchSequence([{ status: 403, body: { error: "Forbidden" } }]);
    const tool = findTool(writeTools, "npm_org_member_set");
    const result = (await tool.handler({ org: "yawlabs", user: "bob", confirm: true })) as {
      ok: boolean;
      status: number;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.match(result.error, /demoting them/);
    // Only the roster GET fired -- no PUT.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
  });

  it("skips the roster read entirely when role is passed explicitly", async () => {
    mockFetchSequence([{ status: 200, body: {} }]);
    const tool = findTool(writeTools, "npm_org_member_set");
    await tool.handler({ org: "yawlabs", user: "bob", role: "developer", confirm: true });
    assert.equal(requests.length, 1, "explicit role needs no roster lookup");
    assert.equal(requests[0].method, "PUT");
  });

  it("requires confirm: true", async () => {
    const tool = findTool(writeTools, "npm_org_member_set");
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing types to test runtime guard
    const result = (await (tool.handler as any)({
      org: "yawlabs",
      user: "bob",
      confirm: false,
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /confirm: true/);
  });
});

describe("npm_org_member_remove", () => {
  it("DELETEs /-/org/<org>/user with user body", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_org_member_remove");
    await tool.handler({ org: "yawlabs", user: "bob", confirm: true });
    assert.equal(lastRequest!.method, "DELETE");
    assert.deepEqual(lastRequest!.body, { user: "bob" });
  });

  it("requires confirm: true", async () => {
    const tool = findTool(writeTools, "npm_org_member_remove");
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing types to test runtime guard
    const result = (await (tool.handler as any)({
      org: "yawlabs",
      user: "bob",
      confirm: false,
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /confirm: true/);
  });

  it("rejects malformed org (identifier validation)", async () => {
    const tool = findTool(writeTools, "npm_org_member_remove");
    const result = (await tool.handler({
      org: "bad\norg",
      user: "bob",
      confirm: true,
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /scope/i);
  });
});

// ─── token revoke ───

describe("npm_token_revoke", () => {
  it("DELETEs /-/npm/v1/tokens/token/<key>", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_token_revoke");
    await tool.handler({ tokenKey: "a1b2c3d4-e5f6-7890", confirm: true });
    assert.equal(lastRequest!.method, "DELETE");
    assert.match(lastRequest!.url, /\/-\/npm\/v1\/tokens\/token\/a1b2c3d4-e5f6-7890$/);
  });

  it("requires confirm: true", async () => {
    const tool = findTool(writeTools, "npm_token_revoke");
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing types to test runtime guard
    const result = (await (tool.handler as any)({
      tokenKey: "a1b2c3d4-e5f6-7890",
      confirm: false,
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /confirm: true/);
  });

  it("rejects a malformed tokenKey without hitting the network", async () => {
    const tool = findTool(writeTools, "npm_token_revoke");
    const result = (await tool.handler({ tokenKey: "abc-123", confirm: true })) as {
      ok: boolean;
      status: number;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /token key/i);
    assert.equal(lastRequest, undefined);
  });
});

// ─── dist-tags ───

describe("npm_dist_tag_set", () => {
  it("PUTs version to /-/package/<pkg>/dist-tags/<tag>", async () => {
    // Pre-flight GET (W3) then PUT: must supply both responses.
    mockFetchSequence([
      { status: 200, body: samplePackument() },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_dist_tag_set");
    const result = (await tool.handler({
      name: "@test/pkg",
      tag: "beta",
      version: "1.0.0",
    })) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[1].method, "PUT");
    assert.match(requests[1].url, /\/dist-tags\/beta$/);
    // The wire body is a JSON string -- JSON.stringify("1.0.0") -> '"1.0.0"'
    assert.equal(requests[1].body, "1.0.0");
  });

  it("rejects empty tag without hitting the network", async () => {
    const tool = findTool(writeTools, "npm_dist_tag_set");
    const result = (await tool.handler({ name: "@test/pkg", tag: "", version: "1.0.0" })) as {
      ok: boolean;
      status: number;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /empty/i);
    assert.equal(lastRequest, undefined);
  });

  it("rejects malformed tag (CRLF, slash) without hitting the network", async () => {
    const tool = findTool(writeTools, "npm_dist_tag_set");
    const result = (await tool.handler({ name: "@test/pkg", tag: "bad\ntag", version: "1.0.0" })) as {
      ok: boolean;
      status: number;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /tag/i);
    assert.equal(lastRequest, undefined);
  });
});

describe("npm_dist_tag_remove", () => {
  it("DELETEs the tag", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_dist_tag_remove");
    const result = (await tool.handler({ name: "@test/pkg", tag: "beta" })) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(lastRequest!.method, "DELETE");
  });

  it("refuses to remove 'latest'", async () => {
    const tool = findTool(writeTools, "npm_dist_tag_remove");
    const result = (await tool.handler({ name: "@test/pkg", tag: "latest" })) as {
      ok: boolean;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.match(result.error, /'latest' tag cannot be removed/);
  });

  it("rejects empty tag without hitting the network", async () => {
    const tool = findTool(writeTools, "npm_dist_tag_remove");
    const result = (await tool.handler({ name: "@test/pkg", tag: "" })) as {
      ok: boolean;
      status: number;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /empty/i);
    assert.equal(lastRequest, undefined);
  });
});

// ─── owner add/remove ───

describe("npm_owner_add", () => {
  it("adds a new maintainer (resolve user → fetch packument → PUT with rev)", async () => {
    mockFetchSequence([
      { status: 200, body: { name: "bob", email: "bob@test.com" } },
      { status: 200, body: samplePackument() },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_owner_add");
    const result = (await tool.handler({
      name: "@test/pkg",
      username: "bob",
    })) as { ok: boolean; data: { maintainers: string[] } };
    assert.equal(result.ok, true);
    assert.ok(result.data.maintainers.includes("bob"));
    assert.ok(result.data.maintainers.includes("alice"));
    // PUT URL must include -rev/
    const putReq = requests.find((r) => r.method === "PUT")!;
    assert.match(putReq.url, /\/-rev\/1-abc$/);
    // PUT body is the minimal maintainers doc, not the full packument
    assert.deepEqual(Object.keys(putReq.body as object).sort(), ["_id", "_rev", "maintainers"]);
  });

  it("is idempotent for existing maintainer (user resolve + packument fetch, no PUT)", async () => {
    mockFetchSequence([
      { status: 200, body: { name: "alice", email: "alice@test.com" } },
      { status: 200, body: samplePackument() },
    ]);
    const tool = findTool(writeTools, "npm_owner_add");
    const result = (await tool.handler({
      name: "@test/pkg",
      username: "alice",
    })) as { ok: boolean; data: { alreadyOwner: boolean; maintainers: string[] } };
    assert.equal(result.ok, true);
    assert.equal(result.data.alreadyOwner, true);
    assert.equal(requests.filter((r) => r.method === "PUT").length, 0);
    // Maintainers list must be exactly ["alice"] -- no duplication.
    assert.deepEqual(result.data.maintainers, ["alice"]);
  });

  it("treats a case-differing maintainer entry as already-owner instead of appending a duplicate", async () => {
    // npm usernames are case-insensitive, and the packument's stored entry can
    // differ in case from the canonical record /-/user returns. A
    // case-sensitive check reads that as "not an owner" and adds the same
    // person twice.
    mockFetchSequence([
      { status: 200, body: { name: "Alice", email: "alice@test.com" } }, // canonical record
      { status: 200, body: samplePackument({ maintainers: [{ name: "alice", email: "alice@test.com" }] }) },
    ]);
    const tool = findTool(writeTools, "npm_owner_add");
    const result = (await tool.handler({ name: "@test/pkg", username: "Alice" })) as {
      ok: boolean;
      data: { alreadyOwner: boolean; maintainers: string[] };
    };
    assert.equal(result.ok, true);
    assert.equal(result.data.alreadyOwner, true);
    assert.deepEqual(result.data.maintainers, ["alice"], "no duplicate entry");
    assert.equal(requests.filter((r) => r.method === "PUT").length, 0, "nothing to write");
  });

  // ─── GAP 4: user-resolve step 404s for a nonexistent user (writes.ts:572-575) ───
  it("translates a 404 from the /-/user resolve step (nonexistent user)", async () => {
    // The first call is the user resolve to /-/user/org.couchdb.user:<user>.
    // A nonexistent user 404s there; the handler must translate it and stop
    // before touching the packument.
    mockFetchSequence([{ status: 404, body: { error: "user not found" } }]);
    const tool = findTool(writeTools, "npm_owner_add");
    const result = (await tool.handler({
      name: "@test/pkg",
      username: "ghost",
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.match(result.error, /Not found/);
    // Only the user-resolve GET fired -- the packument fetch is never reached.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.match(requests[0].url, /\/-\/user\/org\.couchdb\.user:ghost$/);
  });

  // ─── GAP 2: missing-_rev guard returns 500 when the packument lacks _rev ───
  it("returns 500 when the fetched packument lacks _rev (missing-rev guard)", async () => {
    // User resolves (new user, not already a maintainer), then the packument
    // fetch comes back without _rev -- execution reaches the _rev guard before
    // the PUT write-step.
    const noRev = samplePackument();
    // biome-ignore lint/performance/noDelete: removing the key models the registry omitting _rev
    delete (noRev as Record<string, unknown>)._rev;
    mockFetchSequence([
      { status: 200, body: { name: "bob", email: "bob@test.com" } }, // user resolve
      { status: 200, body: noRev }, // packument fetch (no _rev)
    ]);
    const tool = findTool(writeTools, "npm_owner_add");
    const result = (await tool.handler({
      name: "@test/pkg",
      username: "bob",
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
    assert.match(result.error, /missing _rev/);
    // user-resolve GET + packument GET, but no PUT.
    assert.equal(requests.length, 2);
    assert.equal(requests.filter((r) => r.method === "PUT").length, 0);
  });
});

describe("npm_owner_remove", () => {
  it("removes an existing maintainer", async () => {
    const pkg = samplePackument({
      maintainers: [
        { name: "alice", email: "alice@test.com" },
        { name: "bob", email: "bob@test.com" },
      ],
    });
    mockFetchSequence([
      { status: 200, body: pkg },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_owner_remove");
    const result = (await tool.handler({
      name: "@test/pkg",
      username: "bob",
    })) as { ok: boolean; data: { remainingMaintainers: string[] } };
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.remainingMaintainers, ["alice"]);
  });

  it("refuses to remove last maintainer (lockout prevention)", async () => {
    mockFetchSequence([{ status: 200, body: samplePackument() }]);
    const tool = findTool(writeTools, "npm_owner_remove");
    const result = (await tool.handler({
      name: "@test/pkg",
      username: "alice",
    })) as { ok: boolean; error: string };
    assert.equal(result.ok, false);
    assert.match(result.error, /zero maintainers/);
  });

  it("returns 404 for non-maintainer", async () => {
    mockFetchSequence([{ status: 200, body: samplePackument() }]);
    const tool = findTool(writeTools, "npm_owner_remove");
    const result = (await tool.handler({
      name: "@test/pkg",
      username: "nobody",
    })) as { ok: boolean; status: number };
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  });
});

// ─── npm_verify_token ───

describe("npm_verify_token", () => {
  it("returns username and tfa status", async () => {
    mockFetchSequence([
      { status: 200, body: { username: "alice" } },
      { status: 200, body: { tfa: { mode: "webauthn", pending: false } } },
    ]);
    const tool = findTool(authTools, "npm_verify_token");
    const result = (await tool.handler({})) as {
      ok: boolean;
      data: { username: string; tokenValid: boolean; tfa: { enabled: boolean } };
    };
    assert.equal(result.ok, true);
    assert.equal(result.data.username, "alice");
    assert.equal(result.data.tokenValid, true);
    assert.equal(result.data.tfa.enabled, true);
  });

  it("returns invalid-token error on whoami 401", async () => {
    mockFetchSequence([
      { status: 401, body: { error: "Unauthorized" } },
      { status: 401, body: { error: "Unauthorized" } },
    ]);
    const tool = findTool(authTools, "npm_verify_token");
    const result = (await tool.handler({})) as { ok: boolean; error: string };
    assert.equal(result.ok, false);
    assert.match(result.error, /whoami/);
  });
});

// ─── per-call wording, one row per write tool ───
//
// For every write tool the registry rejects the WRITE step, and the message
// must carry that call's own CALL_HINTS row. Each row names the call its
// handler must pass, so the assertion is the table itself: a call site that
// omits `call` (falls to the read wording) or passes a neighbour's fails
// here, independent of the prose `op` label. The guard tests below fail when
// a write tool or a RegistryCall is added without a row.

describe("per-call wording, one row per write tool", () => {
  const unpublishPkg = () =>
    samplePackument({
      versions: {
        "0.1.0": { name: "@test/pkg", version: "0.1.0" },
        "0.2.0": { name: "@test/pkg", version: "0.2.0" },
        "1.0.0": { name: "@test/pkg", version: "1.0.0" },
      },
    });
  const ok = (body: unknown = {}) => ({ status: 200, body });
  const twoOwners = () =>
    samplePackument({
      maintainers: [
        { name: "alice", email: "alice@test.com" },
        { name: "bob", email: "bob@test.com" },
      ],
    });

  const rows: Array<{
    tool: string;
    call: RegistryCall;
    input: Record<string, unknown>;
    /** Responses before the rejected write step. */
    before: Array<{ status: number; body: unknown }>;
    cli: RegExp;
  }> = [
    {
      tool: "npm_deprecate",
      call: "packument-put-deprecate",
      input: { name: "@test/pkg", message: "deprecated -- use newpkg" },
      before: [ok(samplePackument())],
      cli: /`npm deprecate @test\/pkg@"<range>" "<message>"`/,
    },
    {
      tool: "npm_undeprecate",
      call: "packument-put-undeprecate",
      input: { name: "@test/pkg" },
      before: [ok(samplePackument())],
      cli: /`npm undeprecate @test\/pkg@"<range>"`/,
    },
    {
      tool: "npm_unpublish_version",
      call: "packument-put-drop-version",
      input: { name: "@test/pkg", version: "0.1.0", confirm: true },
      before: [ok(unpublishPkg())],
      cli: /`npm unpublish @test\/pkg@<version>`/,
    },
    {
      tool: "npm_unpublish_package",
      call: "packument-delete",
      input: { name: "@test/pkg", confirm: true },
      before: [ok(samplePackument())],
      cli: /`npm unpublish @test\/pkg --force`/,
    },
    {
      tool: "npm_dist_tag_set",
      call: "dist-tag-put",
      input: { name: "@test/pkg", tag: "beta", version: "1.0.0" },
      before: [ok(samplePackument())],
      cli: /`npm dist-tag add @test\/pkg@<version> <tag>`/,
    },
    {
      tool: "npm_dist_tag_remove",
      call: "dist-tag-delete",
      input: { name: "@test/pkg", tag: "beta" },
      before: [],
      cli: /`npm dist-tag rm @test\/pkg <tag>`/,
    },
    {
      tool: "npm_owner_add",
      call: "packument-put-maintainer-add",
      input: { name: "@test/pkg", username: "bob" },
      before: [ok({ name: "bob", email: "bob@test.com" }), ok(samplePackument())],
      cli: /`npm owner add <user> @test\/pkg`/,
    },
    {
      tool: "npm_owner_remove",
      call: "packument-put-maintainer-remove",
      input: { name: "@test/pkg", username: "bob" },
      before: [ok(twoOwners())],
      cli: /`npm owner rm <user> @test\/pkg`/,
    },
    {
      tool: "npm_access_set",
      call: "access-post",
      input: { name: "@test/pkg", access: "private" },
      before: [],
      cli: /`npm access set status=public\|private @test\/pkg`/,
    },
    {
      tool: "npm_access_set_mfa",
      call: "access-mfa-post",
      input: { name: "@test/pkg", level: "publish" },
      before: [],
      cli: /`npm access set mfa=none\|publish\|automation @test\/pkg`/,
    },
    {
      tool: "npm_team_grant",
      call: "team-package-put",
      input: { team: "@yawlabs:devs", package: "@yawlabs/pkg", permissions: "read-write" },
      before: [],
      cli: /`npm access grant <read-only\|read-write> <scope:team> @yawlabs\/pkg`/,
    },
    {
      tool: "npm_team_revoke",
      call: "team-package-delete",
      input: { team: "@yawlabs:devs", package: "@yawlabs/pkg" },
      before: [],
      cli: /`npm access revoke <scope:team> @yawlabs\/pkg`/,
    },
    {
      tool: "npm_team_create",
      call: "team-put",
      input: { team: "@yawlabs:devs", description: "dev team" },
      before: [],
      cli: /`npm team create <scope:team>`/,
    },
    {
      tool: "npm_team_delete",
      call: "team-delete",
      input: { team: "@yawlabs:devs", confirm: true },
      before: [],
      cli: /`npm team destroy <scope:team>`/,
    },
    {
      tool: "npm_team_member_add",
      call: "team-user-put",
      input: { team: "@yawlabs:devs", user: "bob" },
      before: [],
      cli: /`npm team add <scope:team> <user>`/,
    },
    {
      tool: "npm_team_member_remove",
      call: "team-user-delete",
      input: { team: "@yawlabs:devs", user: "bob" },
      before: [],
      cli: /`npm team rm <scope:team> <user>`/,
    },
    {
      tool: "npm_org_member_set",
      call: "org-user-put",
      input: { org: "yawlabs", user: "bob", role: "developer", confirm: true },
      before: [],
      cli: /`npm org set <org> <user> <developer\|admin\|owner>`/,
    },
    {
      tool: "npm_org_member_remove",
      call: "org-user-delete",
      input: { org: "yawlabs", user: "bob", confirm: true },
      before: [],
      cli: /`npm org rm <org> <user>`/,
    },
    {
      tool: "npm_token_revoke",
      call: "token-delete",
      input: { tokenKey: "a1b2c3d4-e5f6-7890", confirm: true },
      before: [],
      cli: /`npm token revoke <id\|token>`/,
    },
  ];

  const run = async (row: (typeof rows)[number], status: number) => {
    mockFetchSequence([...row.before, { status, body: { error: "rejected" } }]);
    const tool = findTool(writeTools, row.tool);
    const result = (await tool.handler(row.input)) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false, row.tool);
    assert.equal(result.status, status, row.tool);
    // The rejection came from the last mocked call: the write step.
    assert.equal(requests.length, row.before.length + 1, `${row.tool}: request count`);
    return result.error;
  };

  for (const row of rows) {
    it(`${row.tool} carries the ${row.call} row on 422`, async () => {
      const error = await run(row, 422);
      assert.ok(error.includes(CALL_HINTS[row.call].check), `${row.tool}: not its own row:\n${error}`);
      assert.match(error, row.cli, row.tool);
      // A token id must never be echoed into an error.
      assert.doesNotMatch(error, /a1b2c3d4/, row.tool);
    });

    it(`${row.tool} gives ${CALL_HINTS[row.call].interactive2fa ? "the interactive-2FA" : "the token"} advice on 403`, async () => {
      const error = await run(row, 403);
      if (CALL_HINTS[row.call].interactive2fa) {
        assert.match(error, /Since 2026-07-31 npm requires an interactive 2FA challenge/, row.tool);
        assert.match(error, row.cli, row.tool);
      } else {
        assert.match(error, /2FA bypass enabled .* answers both for this change/, row.tool);
        assert.doesNotMatch(error, /Since 2026-07-31/, row.tool);
      }
    });
  }

  it("every write tool has a row", () => {
    const writeToolNames = writeTools
      .filter((t) => !(t as unknown as { annotations: { readOnlyHint: boolean } }).annotations.readOnlyHint)
      .map((t) => t.name)
      .sort();
    assert.deepEqual(rows.map((r) => r.tool).sort(), writeToolNames);
  });

  it("every non-read, non-hook RegistryCall is exercised by a row (hooks: hooks.test.ts)", () => {
    const covered = new Set(rows.map((r) => r.call));
    const uncovered = REGISTRY_CALLS.filter((c) => c !== "read" && !c.startsWith("hook-") && !covered.has(c));
    assert.deepEqual(uncovered, [], "a RegistryCall was added without a handler-level test");
  });
});

// ─── npm_ops_playbook ───

describe("npm_ops_playbook", () => {
  it("returns structured playbook data", async () => {
    const tool = findTool(registryTools, "npm_ops_playbook");
    const result = (await tool.handler({})) as {
      ok: boolean;
      data: { read: unknown; write: unknown; publish: unknown; auth: unknown; cliFallback: unknown };
    };
    assert.equal(result.ok, true);
    assert.ok(result.data.read);
    assert.ok(result.data.write);
    assert.ok(result.data.publish);
    assert.ok(result.data.auth);
    assert.ok(result.data.cliFallback);
  });

  it("gives current token and 2FA guidance: no npm login, no classic tokens, the 2026-07-31 limits", async () => {
    const tool = findTool(registryTools, "npm_ops_playbook");
    const result = (await tool.handler({})) as {
      ok: boolean;
      data: { cliFallback: unknown; write: unknown; auth: { tokenTypes: Record<string, string> }; publish: unknown };
    };
    const fallback = JSON.stringify(result.data.cliFallback);
    assert.doesNotMatch(fallback, /auth-type=web|npm login|Automation token/);
    assert.match(fallback, /401 and a 2FA-policy refusal as 403, never as 422/);
    assert.match(fallback, /--otp=<code>/);
    // The deprecate note must not send a 422 reader to re-check the range.
    assert.doesNotMatch(JSON.stringify(result.data.write), /If a deprecate 422s/);
    // Token types describe what npm issues today.
    const tokens = JSON.stringify(result.data.auth.tokenTypes);
    assert.match(tokens, /revoked on 2025-12-09/);
    assert.match(tokens, /Since 2026-07-31 it can NOT/);
    assert.doesNotMatch(tokens, /Ideal for CI/);
    // Publishing no longer tells a human to overwrite their token with a web login.
    assert.match(JSON.stringify(result.data.publish), /Do not run `npm login --auth-type=web`/);
  });

  it("npm_deprecate's description no longer blames 422s on 2FA or the range", () => {
    const tool = findTool(writeTools, "npm_deprecate");
    const description = (tool as unknown as { description: string }).description;
    assert.doesNotMatch(description, /causes 422 errors|422s, first verify/);
    assert.match(description, /HTTP 400/);
  });
});
