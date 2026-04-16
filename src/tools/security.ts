import { z } from "zod";
import { registryGet, registryPost } from "../api.js";
import { translateError } from "../errors.js";

export const securityTools = [
  {
    name: "npm_audit",
    description:
      "Quick vulnerability check for specific packages and versions using the bulk advisory API. Returns matching advisories with severity, CVEs, and patched versions. " +
      "For richer detail (CVSS scores, CWEs, fix recommendations), use npm_audit_deep instead.",
    annotations: {
      title: "Audit packages",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      packages: z
        .record(z.array(z.string()))
        .describe('Object mapping package names to arrays of version strings, e.g. {"lodash": ["4.17.20"]}'),
    }),
    handler: async (input: { packages: Record<string, string[]> }) => {
      const res = await registryPost<Record<string, unknown[]>>("/-/npm/v1/security/advisories/bulk", input.packages);
      if (!res.ok) return translateError(res, { op: "audit" });

      // Per-package rollup so callers don't have to re-aggregate the flat advisory list.
      const advisoriesByPackage = res.data ?? {};
      const summary = Object.entries(advisoriesByPackage).map(([name, advisories]) => {
        const list = Array.isArray(advisories) ? advisories : [];
        const severityCounts: Record<string, number> = {};
        for (const adv of list) {
          const severity = (adv as { severity?: string } | null)?.severity ?? "unknown";
          severityCounts[severity] = (severityCounts[severity] ?? 0) + 1;
        }
        return { name, advisoryCount: list.length, severityCounts };
      });

      const queried = Object.keys(input.packages);
      const vulnerable = summary.filter((s) => s.advisoryCount > 0).map((s) => s.name);
      const clean = queried.filter((n) => !vulnerable.includes(n));

      return {
        ok: true,
        status: 200,
        data: {
          queriedCount: queried.length,
          vulnerableCount: vulnerable.length,
          cleanCount: clean.length,
          vulnerable,
          clean,
          summary,
          advisories: advisoriesByPackage,
        },
      };
    },
  },
  {
    name: "npm_audit_deep",
    description:
      "Full security audit on a dependency set — returns detailed advisories with CVSS scores, CWEs, affected version ranges, fix recommendations, and full vulnerability metadata. " +
      "Uses the npm audit v1 endpoint which provides richer detail than the bulk advisory API (npm_audit). " +
      "Requires you to provide the dependency map (use npm_dependencies to get it first).",
    annotations: {
      title: "Deep security audit",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Project name"),
      version: z.string().optional().describe("Project version (default: '1.0.0')"),
      dependencies: z
        .record(z.string())
        .describe('Dependencies to audit as { "package": "version" }, e.g. { "express": "4.17.1" }'),
    }),
    handler: async (input: { name: string; version?: string; dependencies: Record<string, string> }) => {
      const body = {
        name: input.name,
        version: input.version ?? "1.0.0",
        requires: input.dependencies,
        dependencies: Object.fromEntries(
          Object.entries(input.dependencies).map(([pkg, ver]) => [pkg, { version: ver }]),
        ),
      };
      const res = await registryPost("/-/npm/v1/security/audits", body);
      return res.ok ? res : translateError(res, { pkg: input.name, op: "audit_deep" });
    },
  },
  {
    name: "npm_signing_keys",
    description: "Get the npm registry's ECDSA signing keys used to verify package signatures.",
    annotations: {
      title: "Get signing keys",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      const res = await registryGet("/-/npm/v1/keys");
      return res.ok ? res : translateError(res, { op: "signing_keys" });
    },
  },
] as const;
