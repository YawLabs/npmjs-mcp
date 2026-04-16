import { z } from "zod";
import { encPkg, registryGetAuth, requireAuth } from "../api.js";
import { translateError } from "../errors.js";

export const accessTools = [
  {
    name: "npm_collaborators",
    description:
      "Get all users who have access to a package and their permission levels (read-only, read-write). " +
      "Useful for verifying who can publish to a package before setting up CI/CD.",
    annotations: {
      title: "Package collaborators",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name (e.g. 'express' or '@yawlabs/npmjs-mcp')"),
    }),
    handler: async (input: { name: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const res = await registryGetAuth<Record<string, string>>(`/-/package/${encPkg(input.name)}/collaborators`);
      if (!res.ok) return translateError(res, { pkg: input.name, op: "collaborators" });

      const collaborators = Object.entries(res.data!).map(([username, permissions]) => ({
        username,
        permissions,
      }));
      return {
        ok: true,
        status: 200,
        data: {
          package: input.name,
          collaboratorCount: collaborators.length,
          collaborators,
        },
      };
    },
  },
  {
    name: "npm_package_access",
    description:
      "Get package access settings — visibility (public/private), whether publish requires 2FA, and whether automation tokens can bypass 2FA. " +
      "Critical for understanding why CI publishing fails: if publish_requires_tfa is true but automation_token_overrides_tfa is false, automation tokens cannot publish.",
    annotations: {
      title: "Package access settings",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name (e.g. 'express' or '@yawlabs/npmjs-mcp')"),
    }),
    handler: async (input: { name: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const [accessRes, collabRes] = await Promise.all([
        registryGetAuth<Record<string, unknown>>(`/-/package/${encPkg(input.name)}/access`),
        registryGetAuth<Record<string, string>>(`/-/package/${encPkg(input.name)}/collaborators`),
      ]);

      // Need at least one successful response
      if (!accessRes.ok && !collabRes.ok) return translateError(collabRes, { pkg: input.name, op: "package_access" });

      const result: Record<string, unknown> = {
        package: input.name,
        isScoped: input.name.startsWith("@"),
      };

      if (input.name.startsWith("@")) {
        result.scope = input.name.split("/")[0];
        result.hint =
          "Scoped packages belong to an org. Use npm_org_packages to see all packages in the org, " +
          "and npm_tokens to check if you have a token scoped to this org.";
      }

      if (accessRes.ok) {
        result.access = accessRes.data;
      }

      if (collabRes.ok) {
        result.collaborators = Object.entries(collabRes.data!).map(([username, permissions]) => ({
          username,
          permissions,
        }));
      }

      return { ok: true, status: 200, data: result };
    },
  },
] as const;
