import { z } from "zod";
import { registryGet, registryPost } from "../api.js";

export const securityTools = [
  {
    name: "npm_audit",
    description:
      "Check specific packages and versions for known vulnerabilities. Returns advisories with severity, CVEs, and patched versions.",
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
      "Run a full security audit on a set of dependencies. Returns detailed advisories with CVSS scores, CWEs, fix recommendations, and vulnerability metadata.",
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
