import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// End-to-end over stdio against the built server (dist/index.js, the esbuild
// bundle `npm test` produces). The unit suites call tool handlers directly, so
// only this file exercises the registration wrapper in src/index.ts that turns
// a handler's { ok, data, error } into the MCP tool result a client receives.
//
// Both calls below are network-free: npm_ops_playbook returns static data, and
// npm_deprecate rejects an over-long message before its first registry request.

const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

describe("MCP server over stdio", () => {
  let client: Client;

  before(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      // Only what the calls need. The transport adds its own safe defaults
      // (PATH and friends), so a developer's NPM_REGISTRY cannot leak in.
      env: { NPM_TOKEN: "test-token-index" },
    });
    client = new Client({ name: "npmjs-mcp-index-test", version: "0.0.0" });
    await client.connect(transport);
  });

  after(async () => {
    await client?.close();
  });

  it("returns a failing handler's error as isError with an 'Error: ' prefix", async () => {
    const result = (await client.callTool({
      name: "npm_deprecate",
      arguments: { name: "@test/pkg", message: "a".repeat(1025) },
    })) as ToolResult;
    assert.equal(result.isError, true);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[0].text, "Error: Deprecation message exceeds 1024 characters (registry limit).");
  });

  it("returns a successful handler's data as pretty-printed JSON text", async () => {
    const result = (await client.callTool({ name: "npm_ops_playbook", arguments: {} })) as ToolResult;
    assert.notEqual(result.isError, true);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    const text = result.content[0].text ?? "";
    const data = JSON.parse(text) as Record<string, unknown>;
    assert.ok(data.write, "playbook data should round-trip through the wrapper");
    assert.equal(text, JSON.stringify(data, null, 2));
  });
});
