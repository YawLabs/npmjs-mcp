/**
 * Write-op tools — deprecate, undeprecate, unpublish, dist-tag, owner, access, team grant.
 *
 * All writes use the HTTP API with Bearer token auth, bypassing the CLI/2FA friction
 * that local `npm <op>` commands hit. Requires NPM_TOKEN with write scope on the
 * target package (Granular Access Token or Classic Automation token).
 *
 * Endpoint shapes mirror npm CLI / libnpmpublish / libnpmaccess / libnpmteam.
 */

import { z } from "zod";
import {
  type ApiResponse,
  encPkg,
  maxSatisfying,
  registryDeleteAuth,
  registryGetAuth,
  registryPostAuth,
  registryPutAuth,
  requireAuth,
} from "../api.js";
import { translateError, validateDeprecationMessage, versionsMatchingRange } from "../errors.js";

// ─── Packument helpers ──────────────────────────────────

interface Packument {
  _id: string;
  _rev?: string;
  _revisions?: unknown;
  _attachments?: unknown;
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
  dist?: { tarball?: string };
  [key: string]: unknown;
}

/** Fetch the full packument with _rev for write operations. */
async function fetchPackument(pkg: string): Promise<ApiResponse<Packument>> {
  return registryGetAuth<Packument>(`/${encPkg(pkg)}?write=true`);
}

/** Highest semver in the list (loose compare, ignoring prereleases). Null if empty. */
function highestVersion(versions: string[]): string | null {
  const parsed: Array<[number, number, number, string]> = [];
  for (const v of versions) {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (m) parsed.push([Number(m[1]), Number(m[2]), Number(m[3]), v]);
  }
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return parsed[parsed.length - 1][3];
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
  // Mirrors libnpmpublish/unpublish.js single-version flow:
  //   1. GET /{pkg}?write=true
  //   2. mutate: remove version, fix dist-tags, delete _revisions/_attachments
  //   3. PUT /{pkg}/-rev/{rev}
  //   4. GET /{pkg}?write=true (fresh rev)
  //   5. DELETE {tarball-pathname}/-rev/{newRev}
  // The tarball DELETE is best-effort — if it fails, the version is already unreachable
  // via the packument (step 3 succeeded), so we report success with a warning.
  {
    name: "npm_unpublish_version",
    description:
      "Unpublish a specific version of a package. IRREVERSIBLE: once unpublished, the version " +
      "cannot be re-published and will be blocked for 72 hours. Only works within 72 hours of " +
      "the original publish for most packages. Requires explicit confirm: true to prevent accidents. " +
      "Follows the npm CLI flow (mutate packument + delete tarball). For full-package unpublish use npm_unpublish_package.",
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
      const versionData = packument.versions?.[input.version];
      if (!versionData) {
        return {
          ok: false,
          status: 404,
          error:
            `Version ${input.version} not found for ${input.name}. ` +
            `Published versions: ${Object.keys(packument.versions || {}).join(", ")}.`,
        };
      }

      if (!packument._rev) {
        return {
          ok: false,
          status: 500,
          error: `Packument for ${input.name} missing _rev — cannot unpublish. Try again; this is usually transient.`,
        };
      }

      const tarballUrl = versionData.dist?.tarball;
      const latestBefore = packument["dist-tags"]?.latest;

      // Remove the version and any dist-tags pointing at it.
      delete packument.versions[input.version];
      for (const tag of Object.keys(packument["dist-tags"] || {})) {
        if (packument["dist-tags"][tag] === input.version) {
          delete packument["dist-tags"][tag];
        }
      }

      // If we just removed the version that 'latest' pointed at, reset it to highest remaining.
      if (latestBefore === input.version) {
        const newLatest = highestVersion(Object.keys(packument.versions));
        if (newLatest) packument["dist-tags"].latest = newLatest;
      }

      // Couch metadata must not be echoed back.
      delete packument._revisions;
      delete packument._attachments;

      const putRes = await registryPutAuth(
        `/${encPkg(input.name)}/-rev/${encodeURIComponent(packument._rev)}`,
        packument,
      );
      if (!putRes.ok) return translateError(putRes, { pkg: input.name, op: "unpublish (packument PUT)" });

      // Fetch fresh rev for the tarball DELETE.
      let tarballDeleted = false;
      let tarballError: string | undefined;
      if (tarballUrl) {
        const freshRes = await fetchPackument(input.name);
        const freshRev = freshRes.ok ? (freshRes.data as Packument)._rev : undefined;
        if (freshRev) {
          try {
            const pathname = new URL(tarballUrl).pathname;
            const delRes = await registryDeleteAuth(`${pathname}/-rev/${encodeURIComponent(freshRev)}`);
            tarballDeleted = delRes.ok;
            if (!delRes.ok) tarballError = delRes.error;
          } catch (err) {
            tarballError = err instanceof Error ? err.message : String(err);
          }
        } else {
          tarballError = "could not re-fetch packument for tarball DELETE rev";
        }
      }

      return {
        ok: true,
        status: 200,
        data: {
          package: input.name,
          unpublishedVersion: input.version,
          remainingVersions: Object.keys(packument.versions),
          tarballDeleted,
          ...(tarballError ? { tarballWarning: tarballError } : {}),
        },
      };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_unpublish_package
  // ───────────────────────────────────────────────────────
  {
    name: "npm_unpublish_package",
    description:
      "Unpublish an ENTIRE package (all versions). DELETE /{pkg}/-rev/{rev}. " +
      "IRREVERSIBLE: the name is blocked for 72 hours and cannot be re-published. " +
      "For single-version unpublish prefer npm_unpublish_version. Requires confirm: true.",
    annotations: {
      title: "Unpublish entire package",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      confirm: z.literal(true).describe("Must be literally true. Guards against accidental full unpublish."),
    }),
    handler: async (input: { name: string; confirm: true }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      if (input.confirm !== true) {
        return {
          ok: false,
          status: 400,
          error: "Full-package unpublish requires confirm: true. This blocks the name for 72 hours.",
        };
      }

      const pRes = await fetchPackument(input.name);
      if (!pRes.ok) return translateError(pRes, { pkg: input.name, op: "unpublish_package (fetch)" });

      const rev = (pRes.data as Packument)._rev;
      if (!rev) {
        return {
          ok: false,
          status: 500,
          error: `Packument for ${input.name} missing _rev — cannot unpublish.`,
        };
      }

      const delRes = await registryDeleteAuth(`/${encPkg(input.name)}/-rev/${encodeURIComponent(rev)}`);
      if (!delRes.ok) return translateError(delRes, { pkg: input.name, op: "unpublish_package (DELETE)" });

      return {
        ok: true,
        status: 200,
        data: { package: input.name, unpublished: true },
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
  // Mirrors npm CLI owner.js:
  //   1. GET /-/user/org.couchdb.user:{user} → resolve {name, email}
  //   2. GET /{pkg}?write=true → packument with _rev
  //   3. PUT /{pkg}/-rev/{_rev} body {_id, _rev, maintainers}
  {
    name: "npm_owner_add",
    description:
      "Add a user as a maintainer of a package. They will have publish and write permissions. " +
      "Resolves the user's email via /-/user/ (no need to supply it). Use npm_collaborators to verify before adding.",
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
    }),
    handler: async (input: { name: string; username: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      // Resolve the user to get canonical name+email.
      const uRes = await registryGetAuth<{ name: string; email?: string }>(
        `/-/user/org.couchdb.user:${encodeURIComponent(input.username)}`,
      );
      if (!uRes.ok) return translateError(uRes, { pkg: input.name, op: `owner_add (resolve user ${input.username})` });
      const userRecord = { name: uRes.data!.name, email: uRes.data!.email ?? "" };

      const pRes = await fetchPackument(input.name);
      if (!pRes.ok) return translateError(pRes, { pkg: input.name, op: "owner_add (fetch)" });

      const packument = pRes.data as Packument;
      const owners = packument.maintainers || [];

      if (owners.some((m) => m.name === userRecord.name)) {
        return {
          ok: true,
          status: 200,
          data: {
            package: input.name,
            username: userRecord.name,
            alreadyOwner: true,
            maintainers: owners.map((m) => m.name),
          },
        };
      }

      if (!packument._rev) {
        return {
          ok: false,
          status: 500,
          error: `Packument for ${input.name} missing _rev — cannot update owners.`,
        };
      }

      const maintainers = [...owners, userRecord];
      const putRes = await registryPutAuth(`/${encPkg(input.name)}/-rev/${encodeURIComponent(packument._rev)}`, {
        _id: packument._id,
        _rev: packument._rev,
        maintainers,
      });
      if (!putRes.ok) return translateError(putRes, { pkg: input.name, op: "owner_add (write)" });

      return {
        ok: true,
        status: 200,
        data: {
          package: input.name,
          addedOwner: userRecord.name,
          maintainers: maintainers.map((m) => m.name),
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

      if (!packument._rev) {
        return {
          ok: false,
          status: 500,
          error: `Packument for ${input.name} missing _rev — cannot update owners.`,
        };
      }

      const putRes = await registryPutAuth(`/${encPkg(input.name)}/-rev/${encodeURIComponent(packument._rev)}`, {
        _id: packument._id,
        _rev: packument._rev,
        maintainers: after,
      });
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

  // ───────────────────────────────────────────────────────
  // npm_access_set
  // ───────────────────────────────────────────────────────
  {
    name: "npm_access_set",
    description:
      "Set package access level: 'public', 'private', or 'restricted'. Unscoped packages are always public. " +
      "Private access requires a paid npm account.",
    annotations: {
      title: "Set package access level",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      access: z.enum(["public", "private", "restricted"]).describe("Access level"),
    }),
    handler: async (input: { name: string; access: "public" | "private" | "restricted" }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const res = await registryPostAuth(`/-/package/${encPkg(input.name)}/access`, { access: input.access });
      if (!res.ok) return translateError(res, { pkg: input.name, op: `access_set ${input.access}` });

      return {
        ok: true,
        status: 200,
        data: { package: input.name, access: input.access },
      };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_access_set_mfa
  // ───────────────────────────────────────────────────────
  {
    name: "npm_access_set_mfa",
    description:
      "Configure 2FA requirement for publishing: 'none' (off), 'publish' (2FA required), " +
      "'automation' (2FA required but automation tokens can bypass).",
    annotations: {
      title: "Set package 2FA publish policy",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      level: z.enum(["none", "publish", "automation"]).describe("MFA level for publish"),
    }),
    handler: async (input: { name: string; level: "none" | "publish" | "automation" }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      let body: Record<string, boolean>;
      if (input.level === "none") {
        body = { publish_requires_tfa: false };
      } else if (input.level === "publish") {
        body = { publish_requires_tfa: true, automation_token_overrides_tfa: false };
      } else {
        body = { publish_requires_tfa: true, automation_token_overrides_tfa: true };
      }

      const res = await registryPostAuth(`/-/package/${encPkg(input.name)}/access`, body);
      if (!res.ok) return translateError(res, { pkg: input.name, op: `access_set_mfa ${input.level}` });

      return {
        ok: true,
        status: 200,
        data: { package: input.name, mfaLevel: input.level },
      };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_team_grant
  // ───────────────────────────────────────────────────────
  {
    name: "npm_team_grant",
    description:
      "Grant a team read-only or read-write permission on a package. Scope and team are passed as " +
      "@scope:team (e.g. '@yawlabs:devs'). Requires org admin or team admin.",
    annotations: {
      title: "Grant team package permission",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      team: z.string().describe("Team in the form '@scope:team' (e.g. '@yawlabs:devs')"),
      package: z.string().describe("Package name"),
      permissions: z.enum(["read-only", "read-write"]).describe("Permission level"),
    }),
    handler: async (input: { team: string; package: string; permissions: "read-only" | "read-write" }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const m = input.team.match(/^@?([^:]+):(.+)$/);
      if (!m) {
        return {
          ok: false,
          status: 400,
          error: `Team must be in the form '@scope:team' (got '${input.team}').`,
        };
      }
      const [, scope, team] = m;

      const res = await registryPutAuth(`/-/team/${encodeURIComponent(scope)}/${encodeURIComponent(team)}/package`, {
        package: input.package,
        permissions: input.permissions,
      });
      if (!res.ok) return translateError(res, { pkg: input.package, op: `team_grant ${input.team}` });

      return {
        ok: true,
        status: 200,
        data: { team: `@${scope}:${team}`, package: input.package, permissions: input.permissions },
      };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_team_revoke
  // ───────────────────────────────────────────────────────
  {
    name: "npm_team_revoke",
    description:
      "Revoke a team's access to a package. Team is passed as '@scope:team'. " +
      "Does not delete the team itself — use npm_team_delete for that.",
    annotations: {
      title: "Revoke team package permission",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      team: z.string().describe("Team in the form '@scope:team'"),
      package: z.string().describe("Package name"),
    }),
    handler: async (input: { team: string; package: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const m = input.team.match(/^@?([^:]+):(.+)$/);
      if (!m) {
        return {
          ok: false,
          status: 400,
          error: `Team must be in the form '@scope:team' (got '${input.team}').`,
        };
      }
      const [, scope, team] = m;

      const res = await registryDeleteAuth(`/-/team/${encodeURIComponent(scope)}/${encodeURIComponent(team)}/package`, {
        package: input.package,
      });
      if (!res.ok) return translateError(res, { pkg: input.package, op: `team_revoke ${input.team}` });

      return {
        ok: true,
        status: 200,
        data: { team: `@${scope}:${team}`, package: input.package, revoked: true },
      };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_team_create
  // ───────────────────────────────────────────────────────
  {
    name: "npm_team_create",
    description: "Create a team inside an organization. Team is passed as '@scope:team'.",
    annotations: {
      title: "Create team",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      team: z.string().describe("Team in the form '@scope:team'"),
      description: z.string().optional().describe("Optional team description"),
    }),
    handler: async (input: { team: string; description?: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const m = input.team.match(/^@?([^:]+):(.+)$/);
      if (!m) {
        return { ok: false, status: 400, error: `Team must be in the form '@scope:team' (got '${input.team}').` };
      }
      const [, scope, team] = m;

      const res = await registryPutAuth(`/-/org/${encodeURIComponent(scope)}/team`, {
        name: team,
        description: input.description,
      });
      if (!res.ok) return translateError(res, { op: `team_create ${input.team}` });

      return { ok: true, status: 200, data: { team: `@${scope}:${team}`, created: true } };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_team_delete
  // ───────────────────────────────────────────────────────
  {
    name: "npm_team_delete",
    description: "Delete a team. Team is passed as '@scope:team'. Revokes all package permissions that team held.",
    annotations: {
      title: "Delete team",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      team: z.string().describe("Team in the form '@scope:team'"),
    }),
    handler: async (input: { team: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const m = input.team.match(/^@?([^:]+):(.+)$/);
      if (!m) {
        return { ok: false, status: 400, error: `Team must be in the form '@scope:team' (got '${input.team}').` };
      }
      const [, scope, team] = m;

      const res = await registryDeleteAuth(`/-/team/${encodeURIComponent(scope)}/${encodeURIComponent(team)}`);
      if (!res.ok) return translateError(res, { op: `team_delete ${input.team}` });

      return { ok: true, status: 200, data: { team: `@${scope}:${team}`, deleted: true } };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_team_member_add
  // ───────────────────────────────────────────────────────
  {
    name: "npm_team_member_add",
    description: "Add a user to a team. Team is '@scope:team'. User must already be in the org.",
    annotations: {
      title: "Add team member",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      team: z.string().describe("Team in the form '@scope:team'"),
      user: z.string().describe("npm username"),
    }),
    handler: async (input: { team: string; user: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const m = input.team.match(/^@?([^:]+):(.+)$/);
      if (!m) {
        return { ok: false, status: 400, error: `Team must be in the form '@scope:team' (got '${input.team}').` };
      }
      const [, scope, team] = m;

      const res = await registryPutAuth(`/-/team/${encodeURIComponent(scope)}/${encodeURIComponent(team)}/user`, {
        user: input.user,
      });
      if (!res.ok) return translateError(res, { op: `team_member_add ${input.team}` });

      return { ok: true, status: 200, data: { team: `@${scope}:${team}`, addedUser: input.user } };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_team_member_remove
  // ───────────────────────────────────────────────────────
  {
    name: "npm_team_member_remove",
    description: "Remove a user from a team. Team is '@scope:team'. User remains in the org.",
    annotations: {
      title: "Remove team member",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      team: z.string().describe("Team in the form '@scope:team'"),
      user: z.string().describe("npm username"),
    }),
    handler: async (input: { team: string; user: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const m = input.team.match(/^@?([^:]+):(.+)$/);
      if (!m) {
        return { ok: false, status: 400, error: `Team must be in the form '@scope:team' (got '${input.team}').` };
      }
      const [, scope, team] = m;

      const res = await registryDeleteAuth(`/-/team/${encodeURIComponent(scope)}/${encodeURIComponent(team)}/user`, {
        user: input.user,
      });
      if (!res.ok) return translateError(res, { op: `team_member_remove ${input.team}` });

      return { ok: true, status: 200, data: { team: `@${scope}:${team}`, removedUser: input.user } };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_org_member_set
  // ───────────────────────────────────────────────────────
  {
    name: "npm_org_member_set",
    description:
      "Add a user to an org or change their role. Roles: 'developer', 'admin', 'owner'. " +
      "If user is already in the org, updates the role. Omit role to keep existing role.",
    annotations: {
      title: "Set org member",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      org: z.string().describe("Organization name (with or without leading @)"),
      user: z.string().describe("npm username"),
      role: z.enum(["developer", "admin", "owner"]).optional().describe("Role to assign"),
    }),
    handler: async (input: { org: string; user: string; role?: "developer" | "admin" | "owner" }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const org = input.org.replace(/^@/, "");
      const user = input.user.replace(/^@/, "");
      const body: { user: string; role?: string } = { user };
      if (input.role) body.role = input.role;

      const res = await registryPutAuth(`/-/org/${encodeURIComponent(org)}/user`, body);
      if (!res.ok) return translateError(res, { op: `org_member_set ${org}/${user}` });

      return { ok: true, status: 200, data: { org, user, role: input.role } };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_org_member_remove
  // ───────────────────────────────────────────────────────
  {
    name: "npm_org_member_remove",
    description: "Remove a user from an org. Their team memberships in that org are also removed.",
    annotations: {
      title: "Remove org member",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      org: z.string().describe("Organization name"),
      user: z.string().describe("npm username"),
    }),
    handler: async (input: { org: string; user: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const org = input.org.replace(/^@/, "");
      const user = input.user.replace(/^@/, "");
      const res = await registryDeleteAuth(`/-/org/${encodeURIComponent(org)}/user`, { user });
      if (!res.ok) return translateError(res, { op: `org_member_remove ${org}/${user}` });

      return { ok: true, status: 200, data: { org, removedUser: user } };
    },
  },

  // ───────────────────────────────────────────────────────
  // npm_token_revoke
  // ───────────────────────────────────────────────────────
  // Note: token CREATION requires a user password (not a token), so it cannot be
  // performed via NPM_TOKEN alone — we intentionally don't expose npm_token_create.
  {
    name: "npm_token_revoke",
    description:
      "Revoke an access token by its key (UUID from npm_tokens). " +
      "Creating tokens is NOT exposed because the endpoint requires the user password — " +
      "create via https://www.npmjs.com/settings/~/tokens instead.",
    annotations: {
      title: "Revoke access token",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      tokenKey: z.string().describe("Token key (UUID shown by npm_tokens)"),
    }),
    handler: async (input: { tokenKey: string }) => {
      const authErr = requireAuth();
      if (authErr) return authErr;

      const res = await registryDeleteAuth(`/-/npm/v1/tokens/token/${encodeURIComponent(input.tokenKey)}`);
      if (!res.ok) return translateError(res, { op: "token_revoke" });

      return { ok: true, status: 200, data: { tokenKey: input.tokenKey, revoked: true } };
    },
  },
] as const;
