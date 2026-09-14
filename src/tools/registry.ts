import { z } from "zod";
import { downloadsGet, replicateGet, validatePeriod } from "../api.js";
import { translateError } from "../errors.js";

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
      const periodErr = validatePeriod(period);
      if (periodErr) return { ok: false, status: 400, error: periodErr };

      const res = await downloadsGet(`/downloads/point/${period}`);
      return res.ok ? res : translateError(res, { op: `registry_stats ${period}` });
    },
  },
  {
    name: "npm_recent_changes",
    description:
      "Get the most recent package publishes/updates from the npm registry via the CouchDB changes feed. Note: uses replicate.npmjs.com which may have intermittent availability.",
    annotations: {
      title: "Recent registry changes",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      limit: z.number().min(1).max(100).optional().describe("Number of recent changes (default 25, max 100)"),
    }),
    handler: async (input: { limit?: number }) => {
      const limit = input.limit ?? 25;

      // Fetch db info and recent changes in parallel.
      // Use descending=true to get the most recent changes without relying on
      // update_seq arithmetic (update_seq is an opaque string in CouchDB 2.x+).
      const [dbRes, changesRes] = await Promise.all([
        replicateGet<{ doc_count: number }>("/"),
        replicateGet<{
          results: Array<{ seq: unknown; id: string; changes: Array<{ rev: string }> }>;
        }>(`/_changes?limit=${limit}&descending=true`),
      ]);

      if (!changesRes.ok) return translateError(changesRes, { op: "recent_changes" });

      // replicate.npmjs.com is flaky (see description) — a degraded 2xx with an
      // empty body yields ok:true with no data. Guard both reads so that surfaces
      // as an empty result rather than a thrown TypeError.
      const changes = (changesRes.data?.results ?? []).map((r) => ({
        package: r.id,
        rev: r.changes[0]?.rev,
      }));

      return {
        ok: true,
        status: 200,
        data: {
          // `registryPackageCount` is the registry-wide doc-count from
          // replicate.npmjs.com (the entire npm registry, ~3M) -- NOT the
          // count of returned changes. `changes.length` is the per-call
          // result size.
          registryPackageCount: dbRes.data?.doc_count ?? null,
          changes,
        },
      };
    },
  },
  {
    name: "npm_ops_playbook",
    description:
      "Return canonical recipes for common npm operations — which MCP tool to call for which op, " +
      "CLI fallbacks when the MCP server can't handle something, and message format guidance. " +
      "Call this FIRST when you're not sure how to do an npm operation. Prevents reinventing " +
      "approaches that don't work.",
    annotations: {
      title: "npm operations playbook",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({}),
    handler: async () => ({
      ok: true,
      status: 200,
      data: {
        read: {
          search: "mcp_tool: npm_search",
          view: "mcp_tool: npm_package",
          downloads: "mcp_tool: npm_downloads",
          securityAudit: "mcp_tool: npm_audit",
          auth: "none required",
        },
        write: {
          deprecate: {
            tool: "mcp_tool: npm_deprecate",
            requiresNpmToken: true,
            messageFormat: {
              preferred: "Renamed to @scope/pkg -- install that instead",
              limit: "Hard registry limit: 1024 characters. That is the ONLY format constraint enforced.",
              note:
                "Message punctuation does NOT cause 422s. An earlier version of this playbook claimed a " +
                "'period + capital letter' message triggered 422; follow-up diagnosis traced that incident to a " +
                "wildcard version range matching no published versions, and the heuristic was removed in v0.10 " +
                "for false positives. A range matching no published version is rejected locally as HTTP 400 " +
                "before any write; a real 422 from npm_deprecate describes the packument it sent.",
            },
          },
          undeprecate: "mcp_tool: npm_undeprecate",
          unpublishVersion: "mcp_tool: npm_unpublish_version (requires confirm: true)",
          distTag: "mcp_tool: npm_dist_tag_set / npm_dist_tag_remove",
          owner: "mcp_tool: npm_owner_add / npm_owner_remove",
        },
        publish: {
          preferred: "CI tag-push (when the repo has .github/workflows/release.yml)",
          ciSteps: [
            "Bump version in package.json",
            "git add package.json && git commit -m 'vX.Y.Z'",
            "git tag vX.Y.Z",
            "git push origin main --follow-tags",
            "gh run list --limit 1 to confirm CI published",
          ],
          localSteps: [
            "Used when the repo has no release.yml, or CI is unavailable.",
            "Requires a publish-capable token in ~/.npmrc: a Granular Access Token with 'Read and write' permission and 2FA bypass. Do not run `npm login --auth-type=web` -- it replaces that token with a 2FA-bound web session, and the next headless publish fails on an OTP challenge.",
            "Then: `bash release.sh X.Y.Z` or `npm publish --access public`.",
          ],
          why:
            "CI publish is reproducible — artifact built on a clean checkout with a scoped automation token, and the tag-push trigger makes every published version correspond to a git tag. " +
            "Local publish is valid when CI is unavailable or being trimmed; some repos use it as the primary path. " +
            "Both are real flows — don't treat 'never publish locally' as an absolute rule.",
        },
        auth: {
          verifyToken: "mcp_tool: npm_verify_token (first step when debugging write failures)",
          envVar: "NPM_TOKEN",
          tokenTypes: {
            granularAccess:
              "The only token type npm still issues. Requires an interactive 2FA challenge for writes unless created with 2FA bypass.",
            granularWith2faBypass:
              "Headless deprecate, undeprecate, dist-tag and unpublish. Since 2026-07-31 it can NOT create or delete tokens, change package access or maintainers, or manage org/team membership and package grants -- those need an interactive 2FA challenge from a human. npm is targeting January 2027 to remove its direct-publish permission as well.",
            classic: "Classic tokens, including Automation tokens, were revoked on 2025-12-09 and cannot be recreated.",
          },
        },
        cliFallback: {
          when:
            "When a write op returns 401 or 403 on a change that needs interactive 2FA (owner, access, team membership or grant, org membership, token changes), " +
            "or a 422 whose message names a CLI equivalent. An OTP challenge arrives as 401 and a 2FA-policy refusal as 403, never as 422.",
          sequence: [
            "For deprecate, undeprecate, dist-tag and unpublish: a Granular Access Token with 2FA bypass set as NPM_TOKEN makes the change headlessly.",
            "For everything else, and whenever the error names one: the human runs the npm CLI equivalent in their own terminal and answers the one-time-password prompt (or passes --otp=<code>).",
          ],
          who: "End user runs in their terminal — MCP server cannot answer an OTP prompt.",
        },
      },
    }),
  },
] as const;
