#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { accessTools } from "./tools/access.js";
import { analysisTools } from "./tools/analysis.js";
import { authTools } from "./tools/auth.js";
import { dependencyTools } from "./tools/dependencies.js";
import { downloadTools } from "./tools/downloads.js";
import { orgTools } from "./tools/orgs.js";
import { packageTools } from "./tools/packages.js";
import { provenanceTools } from "./tools/provenance.js";
import { registryTools } from "./tools/registry.js";
import { searchTools } from "./tools/search.js";
import { securityTools } from "./tools/security.js";
import { trustTools } from "./tools/trust.js";
import { workflowTools } from "./tools/workflows.js";

// Injected at build time by esbuild; falls back to reading package.json for tsc builds.
declare const __VERSION__: string | undefined;
const version =
  typeof __VERSION__ !== "undefined"
    ? __VERSION__
    : ((await import("node:module")).createRequire(import.meta.url)("../package.json") as { version: string }).version;

// ─── CLI subcommands (run instead of MCP server) ───

const subcommand = process.argv[2];

if (subcommand === "version" || subcommand === "--version") {
  console.log(version);
  process.exit(0);
}

// ─── No subcommand — start the MCP server ───

const allTools = [
  ...searchTools,
  ...packageTools,
  ...dependencyTools,
  ...downloadTools,
  ...securityTools,
  ...analysisTools,
  ...registryTools,
  ...authTools,
  ...orgTools,
  ...accessTools,
  ...provenanceTools,
  ...trustTools,
  ...workflowTools,
];

const server = new McpServer({
  name: "@yawlabs/npmjs-mcp",
  version,
});

// Register all tools with annotations
for (const tool of allTools) {
  server.tool(
    tool.name,
    tool.description,
    tool.inputSchema.shape,
    tool.annotations,
    async (input: Record<string, unknown>) => {
      try {
        const result = await (tool.handler as (input: unknown) => Promise<unknown>)(input);
        const response = result as { ok: boolean; data?: unknown; error?: string };

        if (!response.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${response.error || "Unknown error"}`,
              },
            ],
            isError: true,
          };
        }

        const text = JSON.stringify(response.data ?? { success: true }, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
