import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { hookTools } from "./hooks.js";

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

let lastRequest: CapturedRequest | undefined;
const originalFetch = globalThis.fetch;

function mockFetch(status = 200, responseData: unknown = {}) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    let body: unknown = undefined;
    if (init?.body) {
      const raw = init.body.toString();
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    lastRequest = { url, method, body };
    return new Response(JSON.stringify(responseData), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

// biome-ignore lint/complexity/noBannedTypes: test helper
function findTool(name: string): { handler: Function } {
  const tool = hookTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

before(() => {
  process.env.NPM_TOKEN = "test-token-hooks";
});

after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NPM_TOKEN;
});

beforeEach(() => {
  lastRequest = undefined;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("npm_hook_add", () => {
  it("classifies @scope/pkg as package type", async () => {
    mockFetch(200, { id: "h1" });
    const tool = findTool("npm_hook_add");
    await tool.handler({
      target: "@yawlabs/pkg",
      endpoint: "https://example.com/h",
      secret: "s",
    });
    assert.equal(lastRequest!.method, "POST");
    assert.match(lastRequest!.url, /\/-\/npm\/v1\/hooks\/hook$/);
    assert.deepEqual(lastRequest!.body, {
      type: "package",
      name: "@yawlabs/pkg",
      endpoint: "https://example.com/h",
      secret: "s",
    });
  });

  it("classifies @scope (no slash) as scope type", async () => {
    mockFetch(200, { id: "h2" });
    const tool = findTool("npm_hook_add");
    await tool.handler({ target: "@yawlabs", endpoint: "https://example.com/h", secret: "s" });
    assert.equal((lastRequest!.body as { type: string }).type, "scope");
  });

  it("classifies ~user as owner type and strips tilde", async () => {
    mockFetch(200, { id: "h3" });
    const tool = findTool("npm_hook_add");
    await tool.handler({ target: "~jeff", endpoint: "https://example.com/h", secret: "s" });
    const body = lastRequest!.body as { type: string; name: string };
    assert.equal(body.type, "owner");
    assert.equal(body.name, "jeff");
  });
});

describe("npm_hook_list", () => {
  it("GETs /-/npm/v1/hooks with optional package filter", async () => {
    mockFetch(200, { objects: [] });
    const tool = findTool("npm_hook_list");
    await tool.handler({ package: "@yawlabs/pkg", limit: 10 });
    assert.equal(lastRequest!.method, "GET");
    assert.match(lastRequest!.url, /\/-\/npm\/v1\/hooks\?package=/);
    assert.match(lastRequest!.url, /limit=10/);
  });

  it("omits query string when no filters passed", async () => {
    mockFetch(200, { objects: [] });
    const tool = findTool("npm_hook_list");
    await tool.handler({});
    assert.ok(!lastRequest!.url.includes("?"));
  });
});

describe("npm_hook_get / update / remove", () => {
  it("get: GETs /-/npm/v1/hooks/hook/<id>", async () => {
    mockFetch(200, { id: "h1" });
    const tool = findTool("npm_hook_get");
    await tool.handler({ id: "h1" });
    assert.equal(lastRequest!.method, "GET");
    assert.match(lastRequest!.url, /\/hooks\/hook\/h1$/);
  });

  it("update: PUTs /-/npm/v1/hooks/hook/<id> with endpoint+secret", async () => {
    mockFetch(200, { id: "h1" });
    const tool = findTool("npm_hook_update");
    await tool.handler({ id: "h1", endpoint: "https://new.example.com/h", secret: "new-s" });
    assert.equal(lastRequest!.method, "PUT");
    assert.deepEqual(lastRequest!.body, { endpoint: "https://new.example.com/h", secret: "new-s" });
  });

  it("remove: DELETEs /-/npm/v1/hooks/hook/<id>", async () => {
    mockFetch(200, {});
    const tool = findTool("npm_hook_remove");
    await tool.handler({ id: "h1" });
    assert.equal(lastRequest!.method, "DELETE");
    assert.match(lastRequest!.url, /\/hooks\/hook\/h1$/);
  });
});
