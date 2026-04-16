import { z } from "zod";
import { encPkg, registryGetAuth, requireAuth } from "../api.js";
import { translateError } from "../errors.js";

interface TrustConfig {
  id?: string;
  type: string;
  claims: Record<string, unknown>;
}

export const trustTools = [
  {
    name: "npm_trusted_publishers",
    description:
      "List trusted publishing configurations for a package. Shows OIDC trust relationships with CI/CD providers " +
      "(GitHub Actions, GitLab CI, CircleCI) that allow tokenless publishing. Requires authentication with write access to the package.",
    annotations: {
      title: "List trusted publishers",
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

      const res = await registryGetAuth<TrustConfig[]>(`/-/package/${encPkg(input.name)}/trust`);
      if (!res.ok) return translateError(res, { pkg: input.name, op: "trusted_publishers" });

      const configs = (res.data ?? []).map((c) => {
        const result: Record<string, unknown> = {
          id: c.id,
          provider: c.type,
        };

        // Extract provider-specific fields from claims
        if (c.type === "github") {
          result.repository = c.claims?.repository;
          const workflowRef = c.claims?.workflow_ref as { file?: string } | undefined;
          result.workflowFile = workflowRef?.file;
          result.environment = c.claims?.environment;
        } else if (c.type === "gitlab") {
          result.project = c.claims?.project_path;
          const configRef = c.claims?.ci_config_ref_uri as { file?: string } | undefined;
          result.configFile = configRef?.file;
          result.environment = c.claims?.environment;
        } else if (c.type === "circleci") {
          result.project = c.claims?.project_id;
          result.context = c.claims?.context_ids;
        }

        return result;
      });

      return {
        ok: true,
        status: 200,
        data: {
          package: input.name,
          trustedPublisherCount: configs.length,
          trustedPublishers: configs,
        },
      };
    },
  },
] as const;
