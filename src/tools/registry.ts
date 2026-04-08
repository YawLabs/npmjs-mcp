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
    description: "Get the most recent package publishes/updates from the npm registry via the CouchDB changes feed.",
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

      // First get the current update_seq so we can request the tail
      const infoRes = await replicateGet<{ update_seq: number; doc_count: number }>("/_db_updates");
      // If that fails, try a different approach: get the DB info first
      const dbRes = await replicateGet<{ update_seq: number; doc_count: number }>("/");
      if (!dbRes.ok) return dbRes;

      const since = dbRes.data!.update_seq - limit;
      const changesRes = await replicateGet<{
        results: Array<{ seq: number; id: string; changes: Array<{ rev: string }> }>;
      }>(`/_changes?since=${since}&limit=${limit}&descending=false`);

      if (!changesRes.ok) return changesRes;

      const changes = changesRes.data!.results.map((r) => ({
        package: r.id,
        seq: r.seq,
        rev: r.changes[0]?.rev,
      }));

      return {
        ok: true,
        status: 200,
        data: {
          totalPackages: dbRes.data!.doc_count,
          changes,
        },
      };
    },
  },
] as const;
