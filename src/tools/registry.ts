import { z } from "zod";
import { downloadsGet, replicateGet } from "../api.js";

export const registryTools = [
  {
    name: "npm_registry_stats",
    description: "Get total npm-wide download counts for a period. Shows overall registry activity.",
    annotations: {
      title: "Registry download stats",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      period: z.string().optional().describe("Period: 'last-day', 'last-week', 'last-month' (default: 'last-week')"),
    }),
    handler: async (input: { period?: string }) => {
      const period = input.period ?? "last-week";
      return downloadsGet(`/downloads/point/${period}`);
    },
  },
  {
    name: "npm_recent_changes",
    description:
      "Get the most recent package publishes/updates from the npm registry via the CouchDB changes feed. Note: uses replicate.npmjs.com which may have intermittent availability.",
    annotations: {
      title: "Recent registry changes",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      limit: z.number().min(1).max(100).optional().describe("Number of recent changes (default 25, max 100)"),
    }),
    handler: async (input: { limit?: number }) => {
      const limit = input.limit ?? 25;

      // Fetch db info and recent changes in parallel.
      // Use descending=true to get the most recent changes without relying on
      // update_seq arithmetic (update_seq is an opaque string in CouchDB 2.x+).
      const [dbRes, changesRes] = await Promise.all([
        replicateGet<{ doc_count: number }>("/"),
        replicateGet<{
          results: Array<{ seq: unknown; id: string; changes: Array<{ rev: string }> }>;
        }>(`/_changes?limit=${limit}&descending=true`),
      ]);

      if (!changesRes.ok) return changesRes;

      const changes = changesRes.data!.results.map((r) => ({
        package: r.id,
        rev: r.changes[0]?.rev,
      }));

      return {
        ok: true,
        status: 200,
        data: {
          totalPackages: dbRes.ok ? dbRes.data!.doc_count : null,
          changes,
        },
      };
    },
  },
  {
    name: "npm_ops_playbook",
    description:
      "Return canonical recipes for common npm operations — which MCP tool to call for which op, " +
      "CLI fallbacks when the MCP server can't handle something, and message format guidance. " +
      "Call this FIRST when you're not sure how to do an npm operation. Prevents reinventing " +
      "approaches that don't work.",
    annotations: {
      title: "npm operations playbook",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({}),
    handler: async () => ({
      ok: true,
      status: 200,
      data: {
        read: {
          search: "mcp_tool: npm_search",
          view: "mcp_tool: npm_package",
          downloads: "mcp_tool: npm_downloads",
          securityAudit: "mcp_tool: npm_audit",
          auth: "none required",
        },
        write: {
          deprecate: {
            tool: "mcp_tool: npm_deprecate",
            requiresNpmToken: true,
            messageFormat: {
              preferred: "Renamed to @scope/pkg — install that instead",
              avoid: "Renamed to @scope/pkg. Install that instead.",
              note: "Period-capital form has triggered 422 on at least one scoped package; use em-dash.",
            },
          },
          undeprecate: "mcp_tool: npm_undeprecate",
          unpublishVersion: "mcp_tool: npm_unpublish_version (requires confirm: true)",
          distTag: "mcp_tool: npm_dist_tag_set / npm_dist_tag_remove",
          owner: "mcp_tool: npm_owner_add / npm_owner_remove",
        },
        publish: {
          method: "CI tag-push",
          neverRunLocally: true,
          steps: [
            "Bump version in package.json",
            "git add package.json && git commit -m 'vX.Y.Z'",
            "git tag vX.Y.Z",
            "git push origin main --follow-tags",
            "gh run list --limit 1 to confirm CI published",
          ],
          why: "Local npm publish bypasses version discipline and often fails on 2FA. CI uses repo-level NPM_TOKEN.",
        },
        auth: {
          verifyToken: "mcp_tool: npm_verify_token (first step when debugging write failures)",
          envVar: "NPM_TOKEN",
          tokenTypes: {
            granularAccess: "Requires 2FA for writes. Most common.",
            classicAutomation: "Bypasses 2FA. Ideal for CI.",
            classicPublish: "Requires 2FA for writes.",
          },
        },
        cliFallback: {
          when: "When an MCP write op returns 422 despite valid token (rare, account-level 2FA policy)",
          sequence: ["npm login --auth-type=web", "npm <deprecate|unpublish|dist-tag> <args>"],
          who: "End user runs in their terminal — MCP server cannot initiate browser auth.",
        },
      },
    }),
  },
] as const;
