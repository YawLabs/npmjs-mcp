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
] as const;
