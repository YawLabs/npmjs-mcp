import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { maxSatisfying } from "../api.js";
import { translateError, validateDeprecationMessage, versionsMatchingRange } from "../errors.js";
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
    let body: unknown = undefined;
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

    const response = responses[Math.min(i, responses.length - 1)];
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

  it("422 translates with semver, 1024-char, and CLI fallback guidance", () => {
    const out = translateError({ ok: false, status: 422, error: "Unprocessable" }, { pkg: "@test/pkg" });
    assert.match(out.error!, /422/);
    assert.match(out.error!, /semver range/);
    assert.match(out.error!, /1024/);
    assert.match(out.error!, /npm login --auth-type=web/);
  });

  it("passes through 2xx unchanged", () => {
    const out = translateError({ ok: true, status: 200, data: { x: 1 } }, {});
    assert.equal(out.ok, true);
    assert.deepEqual(out.data, { x: 1 });
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
});

describe("versionsMatchingRange", () => {
  it("returns all versions for '*'", () => {
    const out = versionsMatchingRange(["1.0.0", "2.0.0", "3.0.0"], "*", maxSatisfying);
    assert.deepEqual(out, ["1.0.0", "2.0.0", "3.0.0"]);
  });

  it("filters by range", () => {
    const out = versionsMatchingRange(["0.1.0", "0.2.0", "1.0.0"], "<1.0.0", maxSatisfying);
    assert.deepEqual(out.sort(), ["0.1.0", "0.2.0"]);
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

  it("returns 400 when no versions match range", async () => {
    mockFetchSequence([{ status: 200, body: samplePackument() }]);
    const tool = findTool(writeTools, "npm_deprecate");
    const result = (await tool.handler({
      name: "@test/pkg",
      message: "deprecated — migrate",
      versionRange: ">9.0.0",
    })) as { ok: boolean; status: number };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
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
});

// ─── npm_undeprecate ───

describe("npm_undeprecate", () => {
  it("clears deprecation on all versions", async () => {
    mockFetchSequence([
      { status: 200, body: samplePackument() },
      { status: 200, body: {} },
    ]);
    const tool = findTool(writeTools, "npm_undeprecate");
    const result = (await tool.handler({ name: "@test/pkg" })) as {
      ok: boolean;
      data: { totalAffected: number };
    };
    assert.equal(result.ok, true);
    assert.equal(result.data.totalAffected, 3);
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
    })) as { ok: boolean; data: { remainingVersions: string[]; tarballDeleted: boolean } };
    assert.equal(result.ok, true);
    assert.ok(!result.data.remainingVersions.includes("0.1.0"));
    assert.equal(result.data.remainingVersions.length, 2);
    assert.equal(result.data.tarballDeleted, true);
    // PUT to /-rev/1-abc
    assert.equal(requests[1].method, "PUT");
    assert.match(requests[1].url, /\/-rev\/1-abc$/);
    // DELETE tarball with fresh rev
    assert.equal(requests[3].method, "DELETE");
    assert.match(requests[3].url, /\/@test\/pkg\/-\/pkg-0\.1\.0\.tgz\/-rev\/2-def$/);
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
});

// ─── npm_access_set + npm_access_set_mfa ───

describe("npm_access_set", () => {
  it("POSTs to /-/package/<pkg>/access with access level", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_access_set");
    const result = (await tool.handler({ name: "@test/pkg", access: "private" })) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(lastRequest!.method, "POST");
    assert.match(lastRequest!.url, /\/-\/package\/@test%2Fpkg\/access$/);
    assert.deepEqual(lastRequest!.body, { access: "private" });
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
    await tool.handler({ org: "@yawlabs", user: "bob", role: "developer" });
    assert.equal(lastRequest!.method, "PUT");
    assert.match(lastRequest!.url, /\/-\/org\/yawlabs\/user$/);
    assert.deepEqual(lastRequest!.body, { user: "bob", role: "developer" });
  });

  it("strips leading @ from org and user", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_org_member_set");
    await tool.handler({ org: "yawlabs", user: "@bob" });
    assert.deepEqual(lastRequest!.body, { user: "bob" });
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
    await tool.handler({ tokenKey: "abc-123", confirm: true });
    assert.equal(lastRequest!.method, "DELETE");
    assert.match(lastRequest!.url, /\/-\/npm\/v1\/tokens\/token\/abc-123$/);
  });

  it("requires confirm: true", async () => {
    const tool = findTool(writeTools, "npm_token_revoke");
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing types to test runtime guard
    const result = (await (tool.handler as any)({
      tokenKey: "abc-123",
      confirm: false,
    })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /confirm: true/);
  });
});

// ─── dist-tags ───

describe("npm_dist_tag_set", () => {
  it("PUTs version to /-/package/<pkg>/dist-tags/<tag>", async () => {
    mockFetch(200, {});
    const tool = findTool(writeTools, "npm_dist_tag_set");
    const result = (await tool.handler({
      name: "@test/pkg",
      tag: "beta",
      version: "1.0.0",
    })) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(lastRequest!.method, "PUT");
    assert.match(lastRequest!.url, /\/dist-tags\/beta$/);
    assert.equal(lastRequest!.body, "1.0.0");
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
    })) as { ok: boolean; data: { alreadyOwner: boolean } };
    assert.equal(result.ok, true);
    assert.equal(result.data.alreadyOwner, true);
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
});
