import { z } from "zod";
import { registryGetAuth, requireAuth } from "../api.js";

interface HookObject {
  id: string;
  username: string;
  name: string;
  endpoint: string;
  type: string;
  created: string;
  updated: string;
  deleted: boolean;
  delivered: boolean;
  last_delivery: string | null;
  response_code: number;
  status: string;
}

interface HookListResponse {
  total: number;
  objects: HookObject[];
  urls: { next?: string; prev?: string };
}

export const hookTools = [
  {
    name: "npm_hooks",
    description:
      "List all npm webhooks configured for the authenticated user. Shows hook type (package, scope, or owner), endpoint URL, delivery status, and last response code.",
    annotations: {
      title: "List npm hooks",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      package: z.string().optional().describe("Filter hooks by package name"),
      limit: z.number().min(1).max(100).optional().describe("Max results (default: 25)"),
      offset: z.number().min(0).optional().describe("Pagination offset"),
    }),
    handler: async (input: { package?: string; limit?: number; offset?: number }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const params = new URLSearchParams();
      if (input.package) params.set("package", input.package);
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      if (input.offset !== undefined) params.set("offset", String(input.offset));

      const qs = params.toString();
      const path = `/-/npm/v1/hooks${qs ? `?${qs}` : ""}`;
      const res = await registryGetAuth<HookListResponse>(path);
      if (!res.ok) return res;

      const data = res.data!;
      return {
        ok: true,
        status: 200,
        data: {
          total: data.total,
          hooks: data.objects.map((h) => ({
            id: h.id,
            type: h.type,
            name: h.name,
            endpoint: h.endpoint,
            status: h.status,
            lastDelivery: h.last_delivery,
            lastResponseCode: h.response_code,
            created: h.created,
            updated: h.updated,
          })),
        },
      };
    },
  },
] as const;
