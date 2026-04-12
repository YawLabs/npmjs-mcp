/**
 * Write-op tools — deprecate, undeprecate, unpublish, dist-tag, owner management.
 *
 * All writes use the HTTP API with Bearer token auth, bypassing the CLI/2FA friction
 * that local `npm <op>` commands hit. Requires NPM_TOKEN with write scope on the
 * target package (Granular Access Token or Classic Automation token).
 */

import { z } from "zod";
import {
  type ApiResponse,
  encPkg,
  maxSatisfying,
  registryDeleteAuth,
  registryGetAuth,
  registryPutAuth,
  requireAuth,
} from "../api.js";
import { translateError, validateDeprecationMessage, versionsMatchingRange } from "../errors.js";

// ─── Packument helpers ──────────────────────────────────

interface Packument {
  _id: string;
  _rev?: string;
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, PackumentVersion>;
  maintainers: Array<{ name: string; email?: string }>;
  [key: string]: unknown;
}

interface PackumentVersion {
  name: string;
  version: string;
  deprecated?: string;
  [key: string]: unknown;
}

/** Fetch the full packument with _rev for write operations. */
async function fetchPackument(pkg: string): Promise<ApiResponse<Packument>> {
  return registryGetAuth<Packument>(`/${encPkg(pkg)}?write=true`);
}

// ─── Tools ──────────────────────────────────────────────

export const writeTools = [
  // ───────────────────────────────────────────────────────
  // npm_deprecate
  // ───────────────────────────────────────────────────────
  {
    name: "npm_deprecate",
    description:
      "Deprecate a package or specific versions. Shows a warning message on install. " +
      "Uses the HTTP API with NPM_TOKEN, bypassing the CLI auth friction that causes 422 errors " +
      "on accounts with 2FA. Message format: prefer em-dash form " +
      "('Renamed to @scope/pkg — install that instead'); period-capital form sometimes triggers 422.",
    annotations: {
      title: "Deprecate package",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name (e.g. '@yawlabs/tokenmeter-mcp')"),
      message: z
        .string()
        .describe("Deprecation message. Empty string to clear deprecation (use npm_undeprecate instead)."),
      versionRange: z
        .string()
        .optional()
        .describe("Semver range. Omit to deprecate ALL versions. Example: '<1.0.0' or '0.3.x'."),
      force: z.boolean().optional().describe("Bypass message format validation (default: false)."),
    }),
    handler: async (input: {
      name: string;
      message: string;
      versionRange?: string;
      force?: boolean;
    }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      if (!input.force) {
        const problem = validateDeprecationMessage(input.message);
        if (problem) return { ok: false, status: 400, error: problem };
      }

      const pRes = await fetchPackument(input.name);
      if (!pRes.ok) return translateError(pRes, { pkg: input.name, op: "deprecate (fetch)" });

      const packument = pRes.data as Packument;
      const allVersions = Object.keys(packument.versions || {});
      const range = input.versionRange ?? "*";
      const affected = versionsMatchingRange(allVersions, range, maxSatisfying);

      if (affected.length === 0) {
        return {
          ok: false,
          status: 400,
          error:
            `No versions match range '${range}' for ${input.name}. ` +
            `Published versions: ${allVersions.join(", ") || "(none)"}.`,
        };
      }

      for (const v of affected) {
        packument.versions[v].deprecated = input.message;
      }

      const putRes = await registryPutAuth(`/${encPkg(input.name)}`, packument);
      if (!putRes.ok) return translateError(putRes, { pkg: input.name, op: "deprecate (write)" });

      return {
        ok: true,
        status: 200,
        data: {
          package: input.name,
          affectedVersions: affected,
          totalAffected: affected.length,
          message: input.message,
        },
      };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_undeprecate
  // ───────────────────────────────────────────────────────
  {
    name: "npm_undeprecate",
    description:
      "Clear the deprecation message from a package or specific versions. Equivalent to " +
      "npm_deprecate with an empty message but more explicit about intent.",
    annotations: {
      title: "Undeprecate package",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      versionRange: z.string().optional().describe("Semver range. Omit to undeprecate ALL versions."),
    }),
    handler: async (input: { name: string; versionRange?: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const pRes = await fetchPackument(input.name);
      if (!pRes.ok) return translateError(pRes, { pkg: input.name, op: "undeprecate (fetch)" });

      const packument = pRes.data as Packument;
      const allVersions = Object.keys(packument.versions || {});
      const range = input.versionRange ?? "*";
      const affected = versionsMatchingRange(allVersions, range, maxSatisfying);

      if (affected.length === 0) {
        return {
          ok: false,
          status: 400,
          error: `No versions match range '${range}' for ${input.name}.`,
        };
      }

      for (const v of affected) {
        packument.versions[v].deprecated = "";
      }

      const putRes = await registryPutAuth(`/${encPkg(input.name)}`, packument);
      if (!putRes.ok) return translateError(putRes, { pkg: input.name, op: "undeprecate (write)" });

      return {
        ok: true,
        status: 200,
        data: {
          package: input.name,
          affectedVersions: affected,
          totalAffected: affected.length,
        },
      };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_unpublish_version
  // ───────────────────────────────────────────────────────
  {
    name: "npm_unpublish_version",
    description:
      "Unpublish a specific version of a package. IRREVERSIBLE: once unpublished, the version " +
      "cannot be re-published and will be blocked for 72 hours. Only works within 72 hours of " +
      "the original publish for most packages. Requires explicit confirm: true to prevent accidents.",
    annotations: {
      title: "Unpublish version",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      version: z.string().describe("Specific version to unpublish (e.g. '1.2.3')"),
      confirm: z.literal(true).describe("Must be literally true. Guards against accidental unpublish."),
    }),
    handler: async (input: { name: string; version: string; confirm: true }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      if (input.confirm !== true) {
        return {
          ok: false,
          status: 400,
          error: "Unpublish requires confirm: true. This op is irreversible within 72 hours.",
        };
      }

      const pRes = await fetchPackument(input.name);
      if (!pRes.ok) return translateError(pRes, { pkg: input.name, op: "unpublish (fetch)" });

      const packument = pRes.data as Packument;
      if (!packument.versions[input.version]) {
        return {
          ok: false,
          status: 404,
          error:
            `Version ${input.version} not found for ${input.name}. ` +
            `Published versions: ${Object.keys(packument.versions).join(", ")}.`,
        };
      }

      // Remove the version from versions map and dist-tags.
      delete packument.versions[input.version];
      for (const tag of Object.keys(packument["dist-tags"])) {
        if (packument["dist-tags"][tag] === input.version) {
          delete packument["dist-tags"][tag];
        }
      }

      const putRes = await registryPutAuth(`/${encPkg(input.name)}`, packument);
      if (!putRes.ok) return translateError(putRes, { pkg: input.name, op: "unpublish (write)" });

      return {
        ok: true,
        status: 200,
        data: {
          package: input.name,
          unpublishedVersion: input.version,
          remainingVersions: Object.keys(packument.versions),
        },
      };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_dist_tag_set
  // ───────────────────────────────────────────────────────
  {
    name: "npm_dist_tag_set",
    description:
      "Point a dist-tag (e.g. 'latest', 'beta', 'next') at a specific version. " +
      "Common uses: promote a beta to latest, roll back latest to a prior version, " +
      "maintain separate channels.",
    annotations: {
      title: "Set dist-tag",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      tag: z.string().describe("Dist-tag name (e.g. 'latest', 'beta', 'next')"),
      version: z.string().describe("Version the tag should point to"),
    }),
    handler: async (input: { name: string; tag: string; version: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      // Registry expects the version wrapped as a JSON string body.
      const putRes = await registryPutAuth(
        `/-/package/${encPkg(input.name)}/dist-tags/${encodeURIComponent(input.tag)}`,
        input.version,
      );
      if (!putRes.ok) return translateError(putRes, { pkg: input.name, op: `dist-tag set ${input.tag}` });

      return {
        ok: true,
        status: 200,
        data: {
          package: input.name,
          tag: input.tag,
          version: input.version,
        },
      };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_dist_tag_remove
  // ───────────────────────────────────────────────────────
  {
    name: "npm_dist_tag_remove",
    description: "Remove a dist-tag from a package. The 'latest' tag cannot be removed, only reassigned.",
    annotations: {
      title: "Remove dist-tag",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      tag: z.string().describe("Dist-tag name to remove"),
    }),
    handler: async (input: { name: string; tag: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      if (input.tag === "latest") {
        return {
          ok: false,
          status: 400,
          error: "The 'latest' tag cannot be removed. Use npm_dist_tag_set to reassign it to a different version.",
        };
      }

      const delRes = await registryDeleteAuth(
        `/-/package/${encPkg(input.name)}/dist-tags/${encodeURIComponent(input.tag)}`,
      );
      if (!delRes.ok) return translateError(delRes, { pkg: input.name, op: `dist-tag remove ${input.tag}` });

      return {
        ok: true,
        status: 200,
        data: { package: input.name, removedTag: input.tag },
      };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_owner_add
  // ───────────────────────────────────────────────────────
  {
    name: "npm_owner_add",
    description:
      "Add a user as a maintainer of a package. They will have publish and write permissions. " +
      "Use npm_collaborators to verify before adding.",
    annotations: {
      title: "Add package owner",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      username: z.string().describe("npm username to add as maintainer"),
      email: z.string().optional().describe("Optional email for the maintainer record (defaults to empty)"),
    }),
    handler: async (input: { name: string; username: string; email?: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const pRes = await fetchPackument(input.name);
      if (!pRes.ok) return translateError(pRes, { pkg: input.name, op: "owner_add (fetch)" });

      const packument = pRes.data as Packument;
      packument.maintainers = packument.maintainers || [];

      if (packument.maintainers.some((m) => m.name === input.username)) {
        return {
          ok: true,
          status: 200,
          data: {
            package: input.name,
            username: input.username,
            alreadyOwner: true,
            maintainers: packument.maintainers.map((m) => m.name),
          },
        };
      }

      packument.maintainers.push({ name: input.username, email: input.email ?? "" });

      const putRes = await registryPutAuth(`/${encPkg(input.name)}`, packument);
      if (!putRes.ok) return translateError(putRes, { pkg: input.name, op: "owner_add (write)" });

      return {
        ok: true,
        status: 200,
        data: {
          package: input.name,
          addedOwner: input.username,
          maintainers: packument.maintainers.map((m) => m.name),
        },
      };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_owner_remove
  // ───────────────────────────────────────────────────────
  {
    name: "npm_owner_remove",
    description:
      "Remove a user from a package's maintainer list. Refuses if it would leave the package with " +
      "zero maintainers (lockout prevention).",
    annotations: {
      title: "Remove package owner",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      username: z.string().describe("npm username to remove"),
    }),
    handler: async (input: { name: string; username: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const pRes = await fetchPackument(input.name);
      if (!pRes.ok) return translateError(pRes, { pkg: input.name, op: "owner_remove (fetch)" });

      const packument = pRes.data as Packument;
      const before = packument.maintainers || [];

      if (!before.some((m) => m.name === input.username)) {
        return {
          ok: false,
          status: 404,
          error:
            `${input.username} is not a maintainer of ${input.name}. ` +
            `Current maintainers: ${before.map((m) => m.name).join(", ") || "(none)"}.`,
        };
      }

      const after = before.filter((m) => m.name !== input.username);

      if (after.length === 0) {
        return {
          ok: false,
          status: 400,
          error: `Removing ${input.username} would leave ${input.name} with zero maintainers (lockout). Add another maintainer first with npm_owner_add.`,
        };
      }

      packument.maintainers = after;

      const putRes = await registryPutAuth(`/${encPkg(input.name)}`, packument);
      if (!putRes.ok) return translateError(putRes, { pkg: input.name, op: "owner_remove (write)" });

      return {
        ok: true,
        status: 200,
        data: {
          package: input.name,
          removedOwner: input.username,
          remainingMaintainers: after.map((m) => m.name),
        },
      };
    },
  },
] as const;
