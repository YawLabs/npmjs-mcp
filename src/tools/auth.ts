import { z } from "zod";
import { encUser, registryGetAuth, requireAuth, validateUsername } from "../api.js";
import { translateError } from "../errors.js";
import type { TokenListResponse, UserProfile } from "../types.js";

export const authTools = [
  {
    name: "npm_whoami",
    description:
      "Check the currently authenticated npm user. Verifies the NPM_TOKEN is valid and returns the associated username. Essential for debugging auth issues before publishing.",
    annotations: {
      title: "Check npm auth",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const res = await registryGetAuth<{ username: string }>("/-/whoami");
      return res.ok ? res : translateError(res, { op: "whoami" });
    },
  },
  {
    name: "npm_profile",
    description:
      "Get the authenticated user's npm profile — name, email, 2FA status, creation date. Useful for checking whether 2FA is enabled (which affects token requirements for publishing).",
    annotations: {
      title: "Get npm profile",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const res = await registryGetAuth<UserProfile>("/-/npm/v1/user");
      if (!res.ok) return translateError(res, { op: "profile" });

      const p = res.data!;
      // `pending: true` means a 2FA enrollment was started but not completed —
      // protection is not yet in force. Match the reading used in workflows.ts
      // (npm_check_auth / npm_publish_preflight): `enabled` iff `tfa && !pending`.
      // Earlier this handler reported `enabled: true` on pending — divergence let
      // npm_profile and npm_check_auth disagree about the same token's 2FA state.
      const tfa = p.tfa
        ? {
            enabled: !p.tfa.pending,
            mode: p.tfa.mode,
            ...(p.tfa.pending ? { pending: true } : {}),
          }
        : { enabled: false };
      return {
        ok: true,
        status: 200,
        data: {
          name: p.name,
          email: p.email,
          emailVerified: p.email_verified,
          fullname: p.fullname,
          tfa,
          homepage: p.homepage,
          github: p.github,
          twitter: p.twitter,
          created: p.created,
          updated: p.updated,
          cidrWhitelist: p.cidr_whitelist,
        },
      };
    },
  },
  {
    name: "npm_tokens",
    description:
      "List all access tokens for the authenticated npm user. Shows token type, creation date, CIDR restrictions, and read-only status. " +
      "Critical for finding reusable automation/granular tokens that cover your org scope — avoids the common mistake of creating duplicate tokens or using publish tokens in CI (which still require OTP).",
    annotations: {
      title: "List npm tokens",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      page: z.number().min(0).optional().describe("Page number for pagination (default: 0)"),
      perPage: z.number().min(1).max(100).optional().describe("Results per page (default: 25)"),
    }),
    handler: async (input: { page?: number; perPage?: number }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const params = new URLSearchParams();
      if (input.page !== undefined) params.set("page", String(input.page));
      if (input.perPage !== undefined) params.set("perPage", String(input.perPage));

      const qs = params.toString();
      const path = `/-/npm/v1/tokens${qs ? `?${qs}` : ""}`;
      const res = await registryGetAuth<TokenListResponse>(path);
      if (!res.ok) return translateError(res, { op: "tokens" });

      const data = res.data!;
      return {
        ok: true,
        status: 200,
        data: {
          total: data.total,
          tokens: data.objects.map((t) => ({
            key: t.key,
            readonly: t.readonly,
            cidrWhitelist: t.cidr_whitelist,
            created: t.created,
            updated: t.updated,
          })),
        },
      };
    },
  },
  {
    name: "npm_verify_token",
    description:
      "Verify the NPM_TOKEN and surface its capabilities — username, 2FA status, and whether " +
      "writes are likely to succeed. Call this FIRST when debugging any write failure to rule " +
      "out auth issues before trying other fixes. Faster than running writes and interpreting " +
      "401/403 errors.",
    annotations: {
      title: "Verify token capabilities",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const [whoami, profile] = await Promise.all([
        registryGetAuth<{ username: string }>("/-/whoami"),
        registryGetAuth<UserProfile>("/-/npm/v1/user"),
      ]);

      if (!whoami.ok) {
        return {
          ...whoami,
          error: `Token failed /-/whoami check. Token is invalid, expired, or revoked. Create a new one at https://www.npmjs.com/settings/~/tokens. Raw: ${whoami.error}`,
        };
      }

      // `pending: true` means a 2FA enrollment was started but not completed —
      // protection is not yet in force. Mirror the reading in npm_profile and
      // npm_check_auth so all three tools agree on the same token's 2FA state.
      //
      // If the profile fetch itself failed (whoami already proved the token is
      // valid, but /-/npm/v1/user 5xx'd or blipped), do NOT report enabled:false —
      // that would tell the caller "no 2FA" when the truth is "we couldn't read
      // it", the exact misleading signal this tool exists to prevent.
      let tfa: Record<string, unknown>;
      if (!profile.ok) {
        tfa = {
          unknown: true,
          warning: `2FA status unknown: profile lookup failed (HTTP ${profile.status}). Token is valid (whoami passed) but write-readiness could not be fully assessed. Raw: ${profile.error}`,
        };
      } else {
        const tfaData = profile.data?.tfa;
        tfa = tfaData
          ? {
              enabled: !tfaData.pending,
              mode: tfaData.mode,
              ...(tfaData.pending ? { pending: true } : {}),
            }
          : { enabled: false };
      }

      return {
        ok: true,
        status: 200,
        data: {
          username: whoami.data?.username,
          tokenValid: true,
          tfa,
          hint:
            "For write ops, token must have 'Read and write' scope on the target package. " +
            "Granular Access Tokens require 2FA for writes; Classic Automation tokens bypass 2FA. " +
            "Check your token's scope at https://www.npmjs.com/settings/~/tokens if writes return 401 or 403.",
        },
      };
    },
  },
  {
    name: "npm_user_packages",
    description:
      "List all packages published by a specific npm user. Shows package names and the user's access level for each. Requires authentication.",
    annotations: {
      title: "List user packages",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      username: z.string().describe("npm username"),
    }),
    handler: async (input: { username: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const userErr = validateUsername(input.username);
      if (userErr) return { ok: false, status: 400, error: userErr };

      const res = await registryGetAuth<Record<string, string>>(
        `/-/user/org.couchdb.user:${encUser(input.username)}/package`,
      );
      if (!res.ok) return translateError(res, { op: `user_packages ${input.username}` });

      const packages = Object.entries(res.data!).map(([name, access]) => ({ name, access }));
      return {
        ok: true,
        status: 200,
        data: {
          username: input.username,
          packageCount: packages.length,
          packages,
        },
      };
    },
  },
] as const;
