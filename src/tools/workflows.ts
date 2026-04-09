import { z } from "zod";
import { type ApiResponse, encPkg, isAuthenticated, registryGet, registryGetAuth } from "../api.js";

interface Packument {
  name: string;
  maintainers?: Array<{ name: string; email?: string }>;
  "dist-tags"?: Record<string, string>;
}

interface TokenObject {
  token: string;
  key: string;
  cidr_whitelist: string[];
  readonly: boolean;
  created: string;
  updated: string;
}

interface TokenListResponse {
  total: number;
  objects: TokenObject[];
}

interface UserProfile {
  name?: string;
  tfa?: { pending: boolean; mode: string } | null;
}

type Check = {
  check: string;
  status: "pass" | "fail" | "warn" | "info";
  detail: string;
};

type AuthAction = {
  label: string;
  command?: string;
  url?: string;
  context: string;
};

export const workflowTools = [
  {
    name: "npm_check_auth",
    description:
      "Quick auth health check — returns structured data about npm auth status, token capability, and whether headless (CI/agent) publishing is possible. " +
      "Run this BEFORE attempting any publish operation. Returns canPublishHeadless boolean and a clear recommendation.\n\n" +
      "MCP servers are called by AI agents which CANNOT open browsers or enter OTP codes. " +
      "This tool detects that and provides the exact terminal command for the human to run instead of suggesting unworkable retries.",
    annotations: {
      title: "Check npm auth health",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      const result: Record<string, unknown> = {
        authenticated: false,
        username: null,
        twoFactorAuth: "unknown",
        tokenType: "unknown",
        canPublishHeadless: false,
        recommendation: null,
      };

      if (!isAuthenticated()) {
        result.recommendation =
          'No NPM_TOKEN configured. Run "npm login" in your terminal, or create a token at https://www.npmjs.com/settings/~/tokens';
        return { ok: true, status: 200, data: result };
      }

      // Check whoami
      const whoamiRes = await registryGetAuth<{ username: string }>("/-/whoami");
      if (!whoamiRes.ok) {
        result.recommendation = `Token is set but invalid (HTTP ${whoamiRes.status}). It may be expired or revoked. Create a new token at https://www.npmjs.com/settings/~/tokens`;
        return { ok: true, status: 200, data: result };
      }

      result.authenticated = true;
      result.username = whoamiRes.data!.username;

      // Check 2FA status
      const profileRes = await registryGetAuth<UserProfile>("/-/npm/v1/user");
      if (profileRes.ok && profileRes.data) {
        const tfa = profileRes.data.tfa;
        if (tfa && !tfa.pending) {
          result.twoFactorAuth = tfa.mode; // "auth-only" or "auth-and-writes"
        } else {
          result.twoFactorAuth = "disabled";
        }
      }

      // Check token inventory for capability assessment
      const tokensRes = await registryGetAuth<TokenListResponse>("/-/npm/v1/tokens");
      if (tokensRes.ok && tokensRes.data) {
        const tokens = tokensRes.data.objects;
        const hasReadWrite = tokens.some((t) => !t.readonly);
        result.tokenCount = tokensRes.data.total;
        result.hasReadWriteTokens = hasReadWrite;
      }

      // Determine if headless publish is possible
      if (result.twoFactorAuth === "disabled") {
        // No 2FA — any valid token can publish
        result.canPublishHeadless = true;
        result.tokenType = "any (2FA disabled)";
        result.recommendation = "2FA is disabled — any valid token can publish. Consider enabling 2FA for security.";
      } else {
        // 2FA is enabled — we can't know for certain if the current token is automation-type
        // from the API alone (tokens are redacted). But we can give accurate guidance.
        result.tokenType = "unknown (tokens are redacted in API)";
        result.canPublishHeadless = null; // unknown — depends on token type
        result.recommendation = `2FA is enabled (${result.twoFactorAuth}). Headless publishing ONLY works with automation/granular tokens. Publish tokens from ~/.npmrc ALWAYS require OTP and WILL fail in CI/agent contexts. If publish fails with EOTP, your token is a publish token — you need an automation token.`;
        result.ifPublishFails = {
          errorType: "2FA_REQUIRED",
          humanAction: {
            label: "Publish from your terminal (one-time)",
            command: "npm publish --access public --auth-type=web",
            context:
              "Run in an INTERACTIVE terminal — a browser will open for 2FA. Do NOT run through piped/agent runners.",
          },
          permanentFix: {
            label: "Set up automation token (permanent fix for CI/agents)",
            url: "https://www.npmjs.com/settings/~/tokens",
            instructions:
              "Create a 'Granular Access Token' with publish permissions scoped to your org/packages. " +
              "Then set it as your CI secret or run: npm config set //registry.npmjs.org/:_authToken=<token>",
          },
        };
      }

      return { ok: true, status: 200, data: result };
    },
  },
  {
    name: "npm_publish_preflight",
    description:
      "Comprehensive pre-publish validation — run before publishing ANY npm package. " +
      "Returns an actionable checklist with pass/fail/warn for each item.\n\n" +
      "ASSUMES NON-INTERACTIVE CONTEXT BY DEFAULT because MCP servers are called by AI agents that:\n" +
      "- CANNOT open browsers (so --auth-type=web is useless)\n" +
      "- CANNOT enter OTP codes\n" +
      "- CANNOT retry with 2FA — this is a hand-off to the human\n\n" +
      "Checks: auth token validity, 2FA requirements, token type inference, org-level token reuse, " +
      "package name availability, maintainer access, scoped package settings.\n\n" +
      "When issues are found, returns structured actions with exact commands for the HUMAN to run " +
      "in their terminal — never suggests actions an agent cannot perform.",
    annotations: {
      title: "Publish preflight check",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name to publish (e.g. '@yawlabs/npmjs-mcp')"),
    }),
    handler: async (input: { name: string }) => {
      const checks: Check[] = [];
      const actions: AuthAction[] = [];
      const isScoped = input.name.startsWith("@");
      const scope = isScoped ? input.name.split("/")[0] : null;
      let username: string | null = null;
      let twoFactorAuth: string | null = null;
      let canPublishHeadless: boolean | null = null;

      // ─── 1. Auth token check ───
      if (!isAuthenticated()) {
        checks.push({
          check: "NPM_TOKEN configured",
          status: "fail",
          detail: "No NPM_TOKEN environment variable set. Publishing requires authentication.",
        });
        actions.push({
          label: "Login interactively",
          command: "npm login",
          context: "Run in your terminal to create a publish token",
        });
        actions.push({
          label: "Create automation token (for CI/agents)",
          url: "https://www.npmjs.com/settings/~/tokens",
          context: `Create a Granular Access Token with publish permissions${scope ? ` scoped to ${scope}` : ""}, then set NPM_TOKEN in your environment`,
        });
      } else {
        // Verify token works
        const whoamiRes = await registryGetAuth<{ username: string }>("/-/whoami");
        if (!whoamiRes.ok) {
          checks.push({
            check: "NPM_TOKEN valid",
            status: "fail",
            detail: `Token rejected (HTTP ${whoamiRes.status}). Expired or revoked.`,
          });
          actions.push({
            label: "Create new token",
            url: "https://www.npmjs.com/settings/~/tokens",
            context: "Your current token is invalid. Create a new Granular Access Token.",
          });
        } else {
          username = whoamiRes.data!.username;
          checks.push({
            check: "NPM_TOKEN valid",
            status: "pass",
            detail: `Authenticated as: ${username}`,
          });
        }

        // ─── 2. 2FA and token type analysis ───
        if (username) {
          const profileRes = await registryGetAuth<UserProfile>("/-/npm/v1/user");
          if (profileRes.ok && profileRes.data) {
            const tfa = profileRes.data.tfa;
            if (tfa && !tfa.pending) {
              twoFactorAuth = tfa.mode;
              checks.push({
                check: "2FA status",
                status: "info",
                detail: `2FA is enabled (mode: ${tfa.mode}). In this non-interactive context:\n  - Automation/granular tokens: can publish (bypass 2FA)\n  - Publish tokens (from ~/.npmrc): WILL FAIL with EOTP error\n  - --auth-type=web: IMPOSSIBLE (needs browser)\n  - OTP codes: IMPOSSIBLE (agent can't enter them)`,
              });
            } else {
              twoFactorAuth = "disabled";
              canPublishHeadless = true;
              checks.push({
                check: "2FA status",
                status: "warn",
                detail: "2FA is disabled. Any valid token can publish, but 2FA is strongly recommended for security.",
              });
            }
          }

          // Token inventory
          const tokensRes = await registryGetAuth<TokenListResponse>("/-/npm/v1/tokens");
          if (tokensRes.ok && tokensRes.data) {
            const tokens = tokensRes.data.objects;
            const totalTokens = tokensRes.data.total;
            const readWriteTokens = tokens.filter((t) => !t.readonly);

            if (twoFactorAuth && twoFactorAuth !== "disabled") {
              // 2FA is on — headless publish depends on token type
              if (readWriteTokens.length > 0) {
                checks.push({
                  check: "Token capability",
                  status: "warn",
                  detail: `Found ${readWriteTokens.length} read-write token(s) out of ${totalTokens} total. Cannot determine token type from API (tokens are redacted). If publish fails with EOTP, your active token is a publish-type token — you need an automation/granular token.`,
                });
                canPublishHeadless = null; // unknown
              } else {
                checks.push({
                  check: "Token capability",
                  status: "fail",
                  detail: "No read-write tokens found. You need a token with publish permissions.",
                });
                canPublishHeadless = false;
              }
            }

            // Org-level token reuse check
            if (isScoped && scope) {
              checks.push({
                check: "Org-scope token reuse",
                status: "info",
                detail: `${input.name} is under ${scope}. You have ${totalTokens} token(s). If any are granular tokens scoped to ${scope}, they cover ALL packages under that scope — check your tokens at https://www.npmjs.com/settings/~/tokens before creating duplicates.`,
              });
            }
          }
        }
      }

      // ─── 3. Package name / maintainer check ───
      const pkgRes = await registryGet<Packument>(`/${encPkg(input.name)}`);
      if (!pkgRes.ok && pkgRes.status === 404) {
        checks.push({
          check: "Package name available",
          status: "pass",
          detail: `"${input.name}" is not taken — you can publish it as a new package.`,
        });
        if (isScoped) {
          checks.push({
            check: "First publish access flag",
            status: "info",
            detail:
              "First publish of a scoped package requires --access public (otherwise it defaults to restricted/paid).",
          });
        }
      } else if (pkgRes.ok && pkgRes.data) {
        const pkg = pkgRes.data;
        const maintainers = pkg.maintainers?.map((m) => m.name) ?? [];
        const isMaintainer = username ? maintainers.includes(username) : null;

        if (isMaintainer === true) {
          checks.push({
            check: "Maintainer access",
            status: "pass",
            detail: `You (${username}) are a maintainer of ${input.name}.`,
          });
        } else if (isMaintainer === false) {
          checks.push({
            check: "Maintainer access",
            status: "fail",
            detail: `You (${username}) are NOT a maintainer. Maintainers: ${maintainers.join(", ")}. You need to be added as a maintainer or collaborator.`,
          });
        } else {
          checks.push({
            check: "Package exists",
            status: "info",
            detail: `"${input.name}" exists. Maintainers: ${maintainers.join(", ") || "unknown"}. Authenticate to check your access.`,
          });
        }
      }

      // ─── 4. Publish guidance (always non-interactive) ───
      if (twoFactorAuth && twoFactorAuth !== "disabled" && canPublishHeadless !== true) {
        actions.push({
          label: "Publish from your terminal (one-time)",
          command: "npm publish --access public --auth-type=web",
          context:
            "Run this in an INTERACTIVE terminal (not piped through an agent or ! runner). A browser will open for 2FA.",
        });
        actions.push({
          label: "Set up automation token (permanent fix for CI/agents)",
          url: "https://www.npmjs.com/settings/~/tokens",
          context: `Create a 'Granular Access Token' with publish permissions${scope ? ` scoped to ${scope} packages` : ""}. This bypasses 2FA for headless publishing.`,
        });
      }

      // ─── Summary ───
      const failures = checks.filter((c) => c.status === "fail");
      const warnings = checks.filter((c) => c.status === "warn");
      const passes = checks.filter((c) => c.status === "pass");

      let summary: string;
      if (failures.length > 0) {
        summary = `BLOCKED: ${failures.length} issue(s) must be resolved before publishing.`;
      } else if (canPublishHeadless === false) {
        summary = "BLOCKED: No suitable token for headless publishing. See actions below.";
      } else if (canPublishHeadless === null && twoFactorAuth !== "disabled") {
        summary =
          "UNCERTAIN: 2FA is enabled and token type cannot be verified. Publishing may fail with EOTP. " +
          "If it does, this is a hand-off to the human — do NOT retry. See actions below.";
      } else if (warnings.length > 0) {
        summary = `READY with ${warnings.length} warning(s). Review before proceeding.`;
      } else {
        summary = "READY to publish. All checks passed.";
      }

      const response: Record<string, unknown> = {
        package: input.name,
        context: "non-interactive (MCP/agent)",
        summary,
        canPublishHeadless,
        passCount: passes.length,
        warnCount: warnings.length,
        failCount: failures.length,
        checks,
      };

      // Only include actions when there are things the human needs to do
      if (actions.length > 0) {
        response.humanActions = actions;
        response.agentNote =
          "The actions below are for the HUMAN to run in their terminal. " +
          "Do NOT attempt these through piped runners, ! commands, or automation. " +
          "Do NOT retry the publish. Do NOT suggest --otp. " +
          "Present these actions to the user and wait for them to complete the step manually.";
      }

      return { ok: true, status: 200, data: response } as ApiResponse;
    },
  },
] as const;
