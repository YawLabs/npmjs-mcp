import { z } from "zod";
import { registryGet } from "../api.js";

interface SearchResult {
  objects: Array<{
    package: {
      name: string;
      version: string;
      description?: string;
      keywords?: string[];
      date: string;
      license?: string;
      publisher?: { username: string; email?: string };
      maintainers?: Array<{ username: string; email?: string }>;
      links?: { npm?: string; homepage?: string; repository?: string; bugs?: string };
    };
    score: { final: number; detail: { quality: number; popularity: number; maintenance: number } };
    searchScore: number;
  }>;
  total: number;
}

export const searchTools = [
  {
    name: "npm_search",
    description:
      "Search the npm registry for packages. Supports text search and qualifiers like 'keywords:mcp', 'author:user', 'maintainer:user', 'scope:org', 'not:insecure', 'is:unstable'.",
    annotations: {
      title: "Search npm packages",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      query: z.string().describe("Search text. Supports qualifiers: keywords:x, author:x, maintainer:x, scope:x"),
      size: z.number().min(1).max(250).optional().describe("Number of results (default 20, max 250)"),
      from: z.number().min(0).optional().describe("Offset for pagination"),
      quality: z.number().min(0).max(1).optional().describe("Weight for quality score (0-1)"),
      popularity: z.number().min(0).max(1).optional().describe("Weight for popularity score (0-1)"),
      maintenance: z.number().min(0).max(1).optional().describe("Weight for maintenance score (0-1)"),
    }),
    handler: async (input: {
      query: string;
      size?: number;
      from?: number;
      quality?: number;
      popularity?: number;
      maintenance?: number;
    }) => {
      const params = new URLSearchParams({ text: input.query });
      if (input.size !== undefined) params.set("size", String(input.size));
      if (input.from !== undefined) params.set("from", String(input.from));
      if (input.quality !== undefined) params.set("quality", String(input.quality));
      if (input.popularity !== undefined) params.set("popularity", String(input.popularity));
      if (input.maintenance !== undefined) params.set("maintenance", String(input.maintenance));

      const res = await registryGet<SearchResult>(`/-/v1/search?${params}`);
      if (!res.ok) return res;

      const results = res.data!.objects.map((obj) => ({
        name: obj.package.name,
        version: obj.package.version,
        description: obj.package.description,
        date: obj.package.date,
        license: obj.package.license,
        publisher: obj.package.publisher,
        keywords: obj.package.keywords,
        links: obj.package.links,
        score: obj.score.detail,
      }));

      return { ok: true, status: 200, data: { total: res.data!.total, results } };
    },
  },
] as const;
