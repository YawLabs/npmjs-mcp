import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { accessTools } from "./access.js";
import { analysisTools } from "./analysis.js";
import { authTools } from "./auth.js";
import { dependencyTools } from "./dependencies.js";
import { downloadTools } from "./downloads.js";
import { hookTools } from "./hooks.js";
import { orgTools } from "./orgs.js";
import { packageTools } from "./packages.js";
import { provenanceTools } from "./provenance.js";
import { registryTools } from "./registry.js";
import { searchTools } from "./search.js";
import { securityTools } from "./security.js";
import { workflowTools } from "./workflows.js";

// ─── Test helpers ───

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let lastRequest: CapturedRequest | undefined;
let requests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;

function mockFetch(status = 200, responseData: unknown = {}) {
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

    if (status === 204) {
      return new Response(null, { status: 204, headers: { "content-length": "0" } });
    }
    return new Response(JSON.stringify(responseData), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

// Mock that returns different data per URL pattern
function mockFetchMulti(routes: Record<string, unknown>, fallbackStatus = 200) {
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

    // Find matching route
    for (const [pattern, data] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(data), {
          status: fallbackStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({}), {
      status: fallbackStatus,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

// biome-ignore lint/complexity/noBannedTypes: test helper needs generic function matching
function findTool(tools: readonly { name: string; handler: Function }[], name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS = "https://api.npmjs.org";
const REPLICATE = "https://replicate.npmjs.com";

// ─── Setup / teardown ───

before(() => {
  process.env.NPM_TOKEN = "test-token-123";
});

after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NPM_TOKEN;
});

beforeEach(() => {
  lastRequest = undefined;
  requests = [];
  mockFetch();
});

// ─── Search ───

describe("Search handlers", () => {
  it("npm_search calls GET /-/v1/search with query", async () => {
    mockFetch(200, { objects: [], total: 0 });
    const tool = findTool(searchTools, "npm_search");
    await tool.handler({ query: "express" });
    assert.equal(lastRequest!.method, "GET");
    assert.ok(lastRequest!.url.startsWith(`${REGISTRY}/-/v1/search`));
    assert.ok(lastRequest!.url.includes("text=express"));
  });

  it("npm_search passes size and from params", async () => {
    mockFetch(200, { objects: [], total: 0 });
    const tool = findTool(searchTools, "npm_search");
    await tool.handler({ query: "mcp", size: 5, from: 10 });
    assert.ok(lastRequest!.url.includes("size=5"));
    assert.ok(lastRequest!.url.includes("from=10"));
  });

  it("npm_search passes score weights", async () => {
    mockFetch(200, { objects: [], total: 0 });
    const tool = findTool(searchTools, "npm_search");
    await tool.handler({ query: "test", quality: 0.8, popularity: 0.5, maintenance: 0.3 });
    assert.ok(lastRequest!.url.includes("quality=0.8"));
    assert.ok(lastRequest!.url.includes("popularity=0.5"));
    assert.ok(lastRequest!.url.includes("maintenance=0.3"));
  });

  it("npm_search preserves full publisher object", async () => {
    mockFetch(200, {
      objects: [
        {
          package: {
            name: "test",
            version: "1.0.0",
            date: "2026-01-01",
            publisher: { username: "user1", email: "user1@test.com" },
          },
          score: { final: 0.5, detail: { quality: 0.5, popularity: 0.5, maintenance: 0.5 } },
          searchScore: 1,
        },
      ],
      total: 1,
    });
    const tool = findTool(searchTools, "npm_search");
    const result = (await tool.handler({ query: "test" })) as { data: { results: { publisher: unknown }[] } };
    assert.deepEqual(result.data.results[0].publisher, { username: "user1", email: "user1@test.com" });
  });
});

// ─── Packages ───

describe("Package handlers", () => {
  const packument = {
    name: "express",
    description: "Fast web framework",
    "dist-tags": { latest: "4.18.2" },
    versions: {
      "4.18.2": {
        name: "express",
        version: "4.18.2",
        license: "MIT",
        dist: { shasum: "abc", tarball: "https://registry.npmjs.org/express/-/express-4.18.2.tgz" },
      },
    },
    time: { created: "2010-01-01", modified: "2024-01-01", "4.18.2": "2024-01-01" },
    maintainers: [{ name: "dougwilson" }],
    readme: "# Express",
  };

  it("npm_package calls GET /{name}", async () => {
    mockFetch(200, packument);
    const tool = findTool(packageTools, "npm_package");
    await tool.handler({ name: "express" });
    assert.equal(lastRequest!.url, `${REGISTRY}/express`);
  });

  it("npm_package encodes scoped packages", async () => {
    mockFetch(200, { ...packument, name: "@scope/pkg" });
    const tool = findTool(packageTools, "npm_package");
    await tool.handler({ name: "@scope/pkg" });
    assert.ok(lastRequest!.url.includes(`${REGISTRY}/@${encodeURIComponent("scope/pkg")}`));
  });

  it("npm_package returns structured data", async () => {
    mockFetch(200, packument);
    const tool = findTool(packageTools, "npm_package");
    const result = (await tool.handler({ name: "express" })) as { ok: boolean; data: Record<string, unknown> };
    assert.equal(result.ok, true);
    assert.equal(result.data.name, "express");
    assert.equal(result.data.latest, "4.18.2");
    assert.equal(result.data.versionCount, 1);
  });

  it("npm_package handles missing dist-tags.latest", async () => {
    mockFetch(200, { ...packument, "dist-tags": {} });
    const tool = findTool(packageTools, "npm_package");
    const result = (await tool.handler({ name: "express" })) as { ok: boolean; data: Record<string, unknown> };
    assert.equal(result.ok, true);
    assert.equal(result.data.latest, undefined);
  });

  it("npm_version calls GET /{name}/{version}", async () => {
    mockFetch(200, packument.versions["4.18.2"]);
    const tool = findTool(packageTools, "npm_version");
    await tool.handler({ name: "express", version: "4.18.2" });
    assert.equal(lastRequest!.url, `${REGISTRY}/express/4.18.2`);
  });

  it("npm_version defaults to latest", async () => {
    mockFetch(200, packument.versions["4.18.2"]);
    const tool = findTool(packageTools, "npm_version");
    await tool.handler({ name: "express" });
    assert.equal(lastRequest!.url, `${REGISTRY}/express/latest`);
  });

  it("npm_version returns structured data", async () => {
    mockFetch(200, packument.versions["4.18.2"]);
    const tool = findTool(packageTools, "npm_version");
    const result = (await tool.handler({ name: "express" })) as { ok: boolean; data: Record<string, unknown> };
    assert.equal(result.ok, true);
    assert.equal(result.data.name, "express");
    assert.equal(result.data.version, "4.18.2");
    assert.ok("dist" in result.data);
    assert.ok("dependencies" in result.data);
  });

  it("npm_versions calls GET /{name}", async () => {
    mockFetch(200, packument);
    const tool = findTool(packageTools, "npm_versions");
    await tool.handler({ name: "express" });
    assert.equal(lastRequest!.url, `${REGISTRY}/express`);
  });

  it("npm_readme returns readme content", async () => {
    mockFetch(200, packument);
    const tool = findTool(packageTools, "npm_readme");
    const result = (await tool.handler({ name: "express" })) as { data: { readme: string } };
    assert.equal(result.data.readme, "# Express");
  });

  it("npm_readme handles missing readme", async () => {
    mockFetch(200, { ...packument, readme: undefined });
    const tool = findTool(packageTools, "npm_readme");
    const result = (await tool.handler({ name: "express" })) as { data: { readme: string } };
    assert.equal(result.data.readme, "(no readme available)");
  });

  it("npm_dist_tags calls GET /-/package/{name}/dist-tags", async () => {
    mockFetch(200, { latest: "4.18.2" });
    const tool = findTool(packageTools, "npm_dist_tags");
    await tool.handler({ name: "express" });
    assert.ok(lastRequest!.url.includes("/-/package/express/dist-tags"));
  });
});

// ─── Dependencies ───

describe("Dependency handlers", () => {
  const versionDoc = {
    name: "express",
    version: "4.18.2",
    dependencies: { "content-type": "~1.0.5", accepts: "~1.3.8" },
    devDependencies: { mocha: "^10.0.0" },
    peerDependencies: {},
    optionalDependencies: {},
    license: "MIT",
  };

  it("npm_dependencies calls GET /{name}/{version}", async () => {
    mockFetch(200, versionDoc);
    const tool = findTool(dependencyTools, "npm_dependencies");
    await tool.handler({ name: "express", version: "4.18.2" });
    assert.equal(lastRequest!.url, `${REGISTRY}/express/4.18.2`);
  });

  it("npm_dependencies defaults version to latest", async () => {
    mockFetch(200, versionDoc);
    const tool = findTool(dependencyTools, "npm_dependencies");
    await tool.handler({ name: "express" });
    assert.equal(lastRequest!.url, `${REGISTRY}/express/latest`);
  });

  it("npm_dependencies returns counts", async () => {
    mockFetch(200, versionDoc);
    const tool = findTool(dependencyTools, "npm_dependencies");
    const result = (await tool.handler({ name: "express" })) as { data: { totalDeps: number; totalDevDeps: number } };
    assert.equal(result.data.totalDeps, 2);
    assert.equal(result.data.totalDevDeps, 1);
  });

  it("npm_license_check flags non-permissive licenses", async () => {
    mockFetchMulti({
      "/express/latest": { name: "express", version: "4.18.2", dependencies: { gpl: "1.0.0" }, license: "MIT" },
      "/gpl/latest": { name: "gpl", version: "1.0.0", license: "GPL-3.0" },
    });
    const tool = findTool(dependencyTools, "npm_license_check");
    const result = (await tool.handler({ name: "express" })) as {
      data: { flagged: number; issues: { name: string; license: string }[] };
    };
    assert.equal(result.data.flagged, 1);
    assert.equal(result.data.issues[0].name, "gpl");
    assert.equal(result.data.issues[0].license, "GPL-3.0");
  });

  it("npm_license_check accepts custom allowed list", async () => {
    mockFetchMulti({
      "/express/latest": { name: "express", version: "4.18.2", dependencies: { gpl: "1.0.0" }, license: "MIT" },
      "/gpl/latest": { name: "gpl", version: "1.0.0", license: "GPL-3.0" },
    });
    const tool = findTool(dependencyTools, "npm_license_check");
    const result = (await tool.handler({ name: "express", allowed: ["MIT", "GPL-3.0"] })) as {
      data: { flagged: number; allowed: string[] };
    };
    assert.equal(result.data.flagged, 0);
    assert.ok(result.data.allowed.includes("GPL-3.0"));
  });
});

// ─── Downloads ───

describe("Download handlers", () => {
  it("npm_downloads calls GET /downloads/point/{period}/{name}", async () => {
    mockFetch(200, { downloads: 1000, start: "2026-01-01", end: "2026-01-07", package: "express" });
    const tool = findTool(downloadTools, "npm_downloads");
    await tool.handler({ name: "express" });
    assert.ok(lastRequest!.url.includes("/downloads/point/last-week/express"));
  });

  it("npm_downloads passes custom period", async () => {
    mockFetch(200, { downloads: 5000 });
    const tool = findTool(downloadTools, "npm_downloads");
    await tool.handler({ name: "express", period: "last-month" });
    assert.ok(lastRequest!.url.includes("/downloads/point/last-month/express"));
  });

  it("npm_downloads_range calls range endpoint", async () => {
    mockFetch(200, { downloads: [] });
    const tool = findTool(downloadTools, "npm_downloads_range");
    await tool.handler({ name: "express" });
    assert.ok(lastRequest!.url.includes("/downloads/range/last-month/express"));
  });

  it("npm_downloads_bulk joins package names", async () => {
    mockFetch(200, {});
    const tool = findTool(downloadTools, "npm_downloads_bulk");
    await tool.handler({ packages: ["express", "koa", "fastify"] });
    assert.ok(lastRequest!.url.includes("/downloads/point/last-week/express,koa,fastify"));
  });

  it("npm_version_downloads defaults to last-week", async () => {
    mockFetch(200, {});
    const tool = findTool(downloadTools, "npm_version_downloads");
    await tool.handler({ name: "express" });
    assert.ok(lastRequest!.url.includes("/versions/express/last-week"));
  });

  it("npm_version_downloads accepts custom period", async () => {
    mockFetch(200, {});
    const tool = findTool(downloadTools, "npm_version_downloads");
    await tool.handler({ name: "express", period: "last-month" });
    assert.ok(lastRequest!.url.includes("/versions/express/last-month"));
  });
});

// ─── Security ───

describe("Security handlers", () => {
  it("npm_audit sends POST to advisories/bulk", async () => {
    mockFetch(200, {});
    const tool = findTool(securityTools, "npm_audit");
    await tool.handler({ packages: { lodash: ["4.17.20"] } });
    assert.equal(lastRequest!.method, "POST");
    assert.ok(lastRequest!.url.includes("/-/npm/v1/security/advisories/bulk"));
    assert.deepEqual(lastRequest!.body, { lodash: ["4.17.20"] });
  });

  it("npm_audit_deep sends POST to security/audits", async () => {
    mockFetch(200, {});
    const tool = findTool(securityTools, "npm_audit_deep");
    await tool.handler({ name: "myapp", dependencies: { express: "4.17.1" } });
    assert.equal(lastRequest!.method, "POST");
    assert.ok(lastRequest!.url.includes("/-/npm/v1/security/audits"));
    const body = lastRequest!.body as { requires: Record<string, string> };
    assert.deepEqual(body.requires, { express: "4.17.1" });
  });

  it("npm_signing_keys calls GET /-/npm/v1/keys", async () => {
    mockFetch(200, { keys: [] });
    const tool = findTool(securityTools, "npm_signing_keys");
    await tool.handler({});
    assert.equal(lastRequest!.url, `${REGISTRY}/-/npm/v1/keys`);
  });
});

// ─── Analysis ───

describe("Analysis handlers", () => {
  const packument = {
    name: "express",
    "dist-tags": { latest: "4.18.2" },
    versions: { "4.18.2": { version: "4.18.2", license: "MIT" } },
    time: { created: "2010-01-01", "4.18.2": "2024-01-01" },
    maintainers: [{ name: "dougwilson" }],
  };

  it("npm_compare fetches multiple packages in parallel", async () => {
    mockFetch(200, packument);
    const tool = findTool(analysisTools, "npm_compare");
    await tool.handler({ packages: ["express", "koa"] });
    // Should have made requests for both packages (registry + downloads + audit each)
    assert.ok(requests.length >= 4);
  });

  it("npm_health fetches package + downloads", async () => {
    mockFetch(200, packument);
    const tool = findTool(analysisTools, "npm_health");
    await tool.handler({ name: "express" });
    // Registry + weekly downloads + monthly downloads
    assert.ok(requests.length >= 3);
    assert.ok(requests.some((r) => r.url.includes(REGISTRY)));
    assert.ok(requests.some((r) => r.url.includes(DOWNLOADS)));
  });

  it("npm_maintainers returns maintainer list", async () => {
    mockFetch(200, {
      ...packument,
      versions: { "4.18.2": { ...packument.versions["4.18.2"], _npmUser: { name: "dougwilson" } } },
    });
    const tool = findTool(analysisTools, "npm_maintainers");
    const result = (await tool.handler({ name: "express" })) as {
      data: { maintainers: { name: string }[] };
    };
    assert.ok(result.data.maintainers.length > 0);
  });

  it("npm_release_frequency analyzes release gaps", async () => {
    mockFetch(200, {
      ...packument,
      versions: { "4.18.1": { version: "4.18.1" }, "4.18.2": { version: "4.18.2" } },
      time: { created: "2010-01-01", "4.18.1": "2023-06-01", "4.18.2": "2024-01-01" },
    });
    const tool = findTool(analysisTools, "npm_release_frequency");
    const result = (await tool.handler({ name: "express" })) as {
      data: { totalVersions: number; analyzed: number };
    };
    assert.equal(result.data.totalVersions, 2);
  });
});

// ─── Registry ───

describe("Registry handlers", () => {
  it("npm_registry_stats calls downloads API", async () => {
    mockFetch(200, { downloads: 50000000 });
    const tool = findTool(registryTools, "npm_registry_stats");
    await tool.handler({});
    assert.ok(lastRequest!.url.includes(`${DOWNLOADS}/downloads/point/last-week`));
  });

  it("npm_registry_stats passes custom period", async () => {
    mockFetch(200, { downloads: 50000000 });
    const tool = findTool(registryTools, "npm_registry_stats");
    await tool.handler({ period: "last-month" });
    assert.ok(lastRequest!.url.includes("/downloads/point/last-month"));
  });
});

// ─── Auth (requires NPM_TOKEN) ───

describe("Auth handlers", () => {
  it("npm_whoami calls GET /-/whoami with Bearer token", async () => {
    mockFetch(200, { username: "testuser" });
    const tool = findTool(authTools, "npm_whoami");
    await tool.handler({});
    assert.equal(lastRequest!.url, `${REGISTRY}/-/whoami`);
    assert.equal(lastRequest!.headers.Authorization, "Bearer test-token-123");
  });

  it("npm_profile calls GET /-/npm/v1/user", async () => {
    mockFetch(200, { name: "testuser", email: "test@test.com", tfa: null });
    const tool = findTool(authTools, "npm_profile");
    await tool.handler({});
    assert.equal(lastRequest!.url, `${REGISTRY}/-/npm/v1/user`);
    assert.equal(lastRequest!.headers.Authorization, "Bearer test-token-123");
  });

  it("npm_profile transforms snake_case to camelCase", async () => {
    mockFetch(200, { name: "testuser", email_verified: true, tfa: { pending: false, mode: "auth-and-writes" } });
    const tool = findTool(authTools, "npm_profile");
    const result = (await tool.handler({})) as {
      data: { emailVerified: boolean; tfa: { enabled: boolean; mode: string } };
    };
    assert.equal(result.data.emailVerified, true);
    assert.equal(result.data.tfa.enabled, true);
    assert.equal(result.data.tfa.mode, "auth-and-writes");
  });

  it("npm_tokens calls GET /-/npm/v1/tokens", async () => {
    mockFetch(200, { total: 2, objects: [], urls: {} });
    const tool = findTool(authTools, "npm_tokens");
    await tool.handler({});
    assert.equal(lastRequest!.url, `${REGISTRY}/-/npm/v1/tokens`);
  });

  it("npm_tokens passes pagination params", async () => {
    mockFetch(200, { total: 0, objects: [], urls: {} });
    const tool = findTool(authTools, "npm_tokens");
    await tool.handler({ page: 1, perPage: 50 });
    assert.ok(lastRequest!.url.includes("page=1"));
    assert.ok(lastRequest!.url.includes("perPage=50"));
  });

  it("npm_whoami returns auth error without token", async () => {
    const saved = process.env.NPM_TOKEN;
    delete process.env.NPM_TOKEN;
    const tool = findTool(authTools, "npm_whoami");
    const result = (await tool.handler({})) as { ok: boolean; status: number };
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    process.env.NPM_TOKEN = saved;
  });
});

// ─── Access ───

describe("Access handlers", () => {
  it("npm_collaborators calls GET /-/package/{name}/collaborators", async () => {
    mockFetch(200, { testuser: "read-write" });
    const tool = findTool(accessTools, "npm_collaborators");
    await tool.handler({ name: "express" });
    assert.ok(lastRequest!.url.includes("/-/package/express/collaborators"));
    assert.equal(lastRequest!.headers.Authorization, "Bearer test-token-123");
  });

  it("npm_package_access returns scoped package info", async () => {
    mockFetch(200, { testuser: "read-write" });
    const tool = findTool(accessTools, "npm_package_access");
    const result = (await tool.handler({ name: "@yawlabs/npmjs-mcp" })) as {
      data: { isScoped: boolean; scope: string };
    };
    assert.equal(result.data.isScoped, true);
    assert.equal(result.data.scope, "@yawlabs");
  });
});

// ─── Organizations ───

describe("Org handlers", () => {
  it("npm_org_members calls GET /-/org/{org}/user", async () => {
    mockFetch(200, { testuser: "owner" });
    const tool = findTool(orgTools, "npm_org_members");
    await tool.handler({ org: "yawlabs" });
    assert.ok(lastRequest!.url.includes("/-/org/yawlabs/user"));
  });

  it("npm_org_packages calls GET /-/org/{org}/package", async () => {
    mockFetch(200, { "@yawlabs/npmjs-mcp": "write" });
    const tool = findTool(orgTools, "npm_org_packages");
    await tool.handler({ org: "yawlabs" });
    assert.ok(lastRequest!.url.includes("/-/org/yawlabs/package"));
  });

  it("npm_org_teams calls GET /-/org/{org}/team", async () => {
    mockFetch(200, ["developers", "owners"]);
    const tool = findTool(orgTools, "npm_org_teams");
    await tool.handler({ org: "yawlabs" });
    assert.ok(lastRequest!.url.includes("/-/org/yawlabs/team"));
  });

  it("npm_team_packages calls GET /-/team/{org}/{team}/package", async () => {
    mockFetch(200, { "@yawlabs/npmjs-mcp": "read-write" });
    const tool = findTool(orgTools, "npm_team_packages");
    await tool.handler({ org: "yawlabs", team: "developers" });
    assert.ok(lastRequest!.url.includes("/-/team/yawlabs/developers/package"));
  });
});

// ─── Provenance ───

describe("Provenance handlers", () => {
  it("npm_provenance calls GET /-/npm/v1/attestations/{name}@{version}", async () => {
    mockFetch(200, { attestations: [] });
    const tool = findTool(provenanceTools, "npm_provenance");
    await tool.handler({ name: "express", version: "4.18.2" });
    assert.ok(lastRequest!.url.includes("/-/npm/v1/attestations/express@4.18.2"));
  });

  it("npm_provenance detects SLSA provenance", async () => {
    mockFetch(200, {
      attestations: [
        { predicateType: "https://slsa.dev/provenance/v1", bundle: {} },
        { predicateType: "https://npmjs.com/attestation/publish/v1", bundle: {} },
      ],
    });
    const tool = findTool(provenanceTools, "npm_provenance");
    const result = (await tool.handler({ name: "express", version: "4.18.2" })) as {
      data: { hasProvenance: boolean; hasPublishAttestation: boolean; attestationCount: number };
    };
    assert.equal(result.data.hasProvenance, true);
    assert.equal(result.data.hasPublishAttestation, true);
    assert.equal(result.data.attestationCount, 2);
  });
});

// ─── Hooks ───

describe("Hook handlers", () => {
  it("npm_hooks calls GET /-/npm/v1/hooks", async () => {
    mockFetch(200, { total: 0, objects: [], urls: {} });
    const tool = findTool(hookTools, "npm_hooks");
    await tool.handler({});
    assert.ok(lastRequest!.url.includes("/-/npm/v1/hooks"));
  });

  it("npm_hooks passes filter params", async () => {
    mockFetch(200, { total: 0, objects: [], urls: {} });
    const tool = findTool(hookTools, "npm_hooks");
    await tool.handler({ package: "express", limit: 10, offset: 5 });
    assert.ok(lastRequest!.url.includes("package=express"));
    assert.ok(lastRequest!.url.includes("limit=10"));
    assert.ok(lastRequest!.url.includes("offset=5"));
  });
});

// ─── Workflows ───

describe("Workflow handlers", () => {
  it("npm_check_auth returns unauthenticated when no token", async () => {
    const saved = process.env.NPM_TOKEN;
    delete process.env.NPM_TOKEN;
    const tool = findTool(workflowTools, "npm_check_auth");
    const result = (await tool.handler({})) as { ok: boolean; data: { authenticated: boolean } };
    assert.equal(result.ok, true);
    assert.equal(result.data.authenticated, false);
    process.env.NPM_TOKEN = saved;
  });

  it("npm_check_auth checks whoami and profile when authenticated", async () => {
    mockFetchMulti({
      "/-/whoami": { username: "testuser" },
      "/-/npm/v1/user": { name: "testuser", tfa: null },
      "/-/npm/v1/tokens": {
        total: 1,
        objects: [{ token: "npm_***", key: "k1", readonly: false, cidr_whitelist: [], created: "", updated: "" }],
      },
    });
    const tool = findTool(workflowTools, "npm_check_auth");
    const result = (await tool.handler({})) as { data: { authenticated: boolean; username: string } };
    assert.equal(result.data.authenticated, true);
    assert.equal(result.data.username, "testuser");
  });

  it("npm_publish_preflight returns auth error without token", async () => {
    const saved = process.env.NPM_TOKEN;
    delete process.env.NPM_TOKEN;
    const tool = findTool(workflowTools, "npm_publish_preflight");
    const result = (await tool.handler({ name: "@yawlabs/test" })) as {
      data: { failCount: number; checks: { check: string; status: string }[] };
    };
    assert.ok(result.data.failCount > 0);
    assert.ok(result.data.checks.some((c) => c.check === "NPM_TOKEN configured" && c.status === "fail"));
    process.env.NPM_TOKEN = saved;
  });
});

// ─── Error handling ───

describe("Error handling", () => {
  it("returns error response on 404", async () => {
    mockFetch(404, "Not found");
    const tool = findTool(packageTools, "npm_package");
    const result = (await tool.handler({ name: "nonexistent-pkg-xyz" })) as { ok: boolean; status: number };
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  });

  it("returns error response on 500", async () => {
    mockFetch(500, "Internal Server Error");
    const tool = findTool(searchTools, "npm_search");
    const result = (await tool.handler({ query: "test" })) as { ok: boolean; status: number };
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
  });

  it("handles network errors gracefully", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    const tool = findTool(packageTools, "npm_package");
    const result = (await tool.handler({ name: "express" })) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.ok(result.error.includes("ECONNREFUSED"));
  });
});
