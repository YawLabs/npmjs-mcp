import { z } from "zod";
import { downloadsGet, encPkg } from "../api.js";

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
      return downloadsGet(`/downloads/point/${period}/${encPkg(input.name)}`);
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
      return downloadsGet(`/downloads/range/${period}/${encPkg(input.name)}`);
    },
  },
  {
    name: "npm_downloads_bulk",
    description: "Compare download counts for multiple packages over a period. Up to 128 packages.",
    annotations: {
      title: "Bulk download comparison",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      packages: z.array(z.string()).min(1).max(128).describe("Array of package names to compare"),
      period: z.string().optional().describe("Period (default: 'last-week')"),
    }),
    handler: async (input: { packages: string[]; period?: string }) => {
      const period = input.period ?? "last-week";
      const names = input.packages.map((p) => encPkg(p)).join(",");
      return downloadsGet(`/downloads/point/${period}/${names}`);
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
    }),
    handler: async (input: { name: string }) => {
      return downloadsGet(`/versions/${encPkg(input.name)}/last-week`);
    },
  },
] as const;
