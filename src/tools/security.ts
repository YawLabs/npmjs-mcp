import { z } from "zod";
import { registryGet, registryPost } from "../api.js";

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
      return registryPost("/-/npm/v1/security/advisories/bulk", input.packages);
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
      return registryPost("/-/npm/v1/security/audits", body);
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
      return registryGet("/-/npm/v1/keys");
    },
  },
] as const;
