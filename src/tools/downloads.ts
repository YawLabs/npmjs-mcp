import { z } from "zod";
import { downloadsGet, encPkg } from "../api.js";
import { translateError } from "../errors.js";

export const downloadTools = [
  {
    name: "npm_downloads",
    description:
      "Get total download count for a package over a period (last-day, last-week, last-month, last-year, or a custom date range like 2025-01-01:2025-12-31).",
    annotations: {
      title: "Get download count",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      period: z
        .string()
        .optional()
        .describe("Period: 'last-day', 'last-week', 'last-month', 'last-year', or 'YYYY-MM-DD:YYYY-MM-DD'"),
    }),
    handler: async (input: { name: string; period?: string }) => {
      const period = input.period ?? "last-week";
      const res = await downloadsGet(`/downloads/point/${period}/${encPkg(input.name)}`);
      return res.ok ? res : translateError(res, { pkg: input.name, op: `downloads ${period}` });
    },
  },
  {
    name: "npm_downloads_range",
    description: "Get daily download counts for a package over a period. Returns per-day breakdown.",
    annotations: {
      title: "Get daily downloads",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      period: z
        .string()
        .optional()
        .describe("Period: 'last-week', 'last-month', 'last-year', or 'YYYY-MM-DD:YYYY-MM-DD'"),
    }),
    handler: async (input: { name: string; period?: string }) => {
      const period = input.period ?? "last-month";
      const res = await downloadsGet(`/downloads/range/${period}/${encPkg(input.name)}`);
      return res.ok ? res : translateError(res, { pkg: input.name, op: `downloads_range ${period}` });
    },
  },
  {
    name: "npm_downloads_bulk",
    description:
      "Compare download counts for multiple packages over a period. Up to 128 packages. " +
      "Scoped packages (@scope/name) are NOT supported by the bulk endpoint — call npm_downloads separately for each scoped package.",
    annotations: {
      title: "Bulk download comparison",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      packages: z.array(z.string()).min(1).max(128).describe("Array of package names to compare (unscoped only)"),
      period: z.string().optional().describe("Period (default: 'last-week')"),
    }),
    handler: async (input: { packages: string[]; period?: string }) => {
      const period = input.period ?? "last-week";

      // The downloads bulk endpoint silently 404s on scoped packages — reject
      // upfront with an actionable message rather than masking it as "not found".
      const scoped = input.packages.filter((p) => p.startsWith("@"));
      if (scoped.length > 0) {
        return {
          ok: false,
          status: 400,
          error:
            `npm_downloads_bulk does not support scoped packages (received: ${scoped.join(", ")}). ` +
            `Call npm_downloads separately for each scoped package.`,
        };
      }

      const names = input.packages.map((p) => encPkg(p)).join(",");
      const res = await downloadsGet(`/downloads/point/${period}/${names}`);
      return res.ok ? res : translateError(res, { op: `downloads_bulk ${period}` });
    },
  },
  {
    name: "npm_version_downloads",
    description: "Get download counts broken down by version for the last week. Shows version adoption.",
    annotations: {
      title: "Per-version downloads",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      period: z.string().optional().describe("Period: 'last-day', 'last-week', 'last-month' (default: 'last-week')"),
    }),
    handler: async (input: { name: string; period?: string }) => {
      const period = input.period ?? "last-week";
      const res = await downloadsGet(`/versions/${encPkg(input.name)}/${period}`);
      return res.ok ? res : translateError(res, { pkg: input.name, op: `version_downloads ${period}` });
    },
  },
] as const;
