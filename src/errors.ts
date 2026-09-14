/**
 * Error translation helpers — turn opaque registry responses into actionable messages.
 *
 * The npm registry returns generic 401/403/404/422 with minimal context. These helpers
 * produce error strings that tell the caller (often an AI assistant) what specifically
 * went wrong and what to try next.
 */

import type { ApiResponse } from "./api.js";

/**
 * The registry calls whose responses translateError can describe. What a
 * 401, 403 or 422 means depends on the CALL that was made -- not on the tool
 * name and not on the prose `op` label, which is free text ("search \"...\"",
 * "hook_update <id>") and must never be parsed. Every write step passes its
 * call; GET steps and every read tool pass none and get the neutral wording.
 *
 * Deprecate and undeprecate (and owner add and remove) share an endpoint but
 * not a CLI command or a body, so each gets its own entry.
 */
export const REGISTRY_CALLS = [
  "read",
  "packument-put-deprecate",
  "packument-put-undeprecate",
  "packument-put-drop-version",
  "packument-put-maintainer-add",
  "packument-put-maintainer-remove",
  "packument-delete",
  "dist-tag-put",
  "dist-tag-delete",
  "access-post",
  "access-mfa-post",
  "team-package-put",
  "team-package-delete",
  "team-put",
  "team-delete",
  "team-user-put",
  "team-user-delete",
  "org-user-put",
  "org-user-delete",
  "token-delete",
  "hook-post",
  "hook-put",
  "hook-delete",
] as const;
export type RegistryCall = (typeof REGISTRY_CALLS)[number];

/**
 * `pkg` and `op` are prose, interpolated as " for <pkg>" / " during <op>".
 * `call` selects the per-call wording; absent or unrecognized means "read".
 */
export interface ErrorContext {
  pkg?: string;
  op?: string;
  call?: RegistryCall;
}

interface CallHint {
  /** What was sent and what a 422 on it can mean. One line, ends pointing at the raw body. */
  check: string;
  /** The npm CLI equivalent (npm 11 usage). Only `<pkg>` is substituted. Absent when none exists. */
  cli?: string;
  /**
   * True when npm requires an interactive 2FA challenge for this change even
   * from a Granular Access Token with 2FA bypass, so no token can make it
   * headlessly. Source: https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/
   * ("Creating or deleting tokens; Changing package access, maintainers, or
   * trusted publishing configuration; Managing organization/team membership
   * and package grants"). Team create/destroy is not on that list.
   */
  interactive2fa?: true;
}

/**
 * One row per registry call. Every `check` states the request as the code
 * builds it, names candidate causes only where npm documents the rule (and
 * hedges them -- no 422 has ever been observed through this server; every
 * 422 test is mocked), and ends by pointing at the raw body, which is the
 * registry's actual reason.
 *
 * Never listed as a 422 cause: a version range matching nothing or an
 * over-long message (npm_deprecate rejects both locally with a 400 before any
 * write), and 2FA/OTP (an OTP challenge arrives as 401 and a 2FA-policy
 * refusal as 403 -- see those branches).
 */
export const CALL_HINTS: Record<RegistryCall, CallHint> = {
  read: {
    check:
      "registry.npmjs.org is not known to answer a read with 422. Compare the raw body against the values interpolated into the URL (version or dist-tag, download period, search query, org or team name), and check whether NPM_REGISTRY points at a proxy or third-party registry, which can use 422 for validation failures.",
  },
  "packument-put-deprecate": {
    check:
      "The body was the packument the registry itself returned, minus `_revisions` and `_attachments` (which the npm CLI does not strip), with `deprecated` set on the versions matching the range. The range and the message length were checked locally before the write and are not the cause. Read the raw body for the field the registry objected to; the document is re-fetched on every call, so re-running after fixing it is safe.",
    cli: 'npm deprecate <pkg>@"<range>" "<message>"',
  },
  "packument-put-undeprecate": {
    check:
      "The body was the packument the registry itself returned, minus `_revisions` and `_attachments` (which the npm CLI does not strip), with `deprecated` set to an empty string on the versions matching the range. The range was checked locally before the write and is not the cause. Read the raw body for the field the registry objected to; the document is re-fetched on every call, so re-running after fixing it is safe.",
    cli: 'npm undeprecate <pkg>@"<range>"',
  },
  "packument-put-drop-version": {
    check:
      "The body was the packument the registry returned with the version removed, every dist-tag that pointed at it deleted, and `latest` re-pointed to the highest remaining stable version. If only prereleases remain, the document has no `latest`, which the npm CLI never sends -- point `latest` at a prerelease with npm_dist_tag_set first; if this was the last version, use npm_unpublish_package instead. Read the raw body.",
    cli: "npm unpublish <pkg>@<version>",
  },
  "packument-put-maintainer-add": {
    check:
      'The body was { _id, _rev, maintainers }: the registry\'s own maintainer list with the new user appended. If the registry returned no email for that user, the new entry carries email: "", where the npm CLI omits the key, and a strict validator can refuse that. Read the raw body.',
    cli: "npm owner add <user> <pkg>",
    interactive2fa: true,
  },
  "packument-put-maintainer-remove": {
    check:
      "The body was { _id, _rev, maintainers }: the registry's own maintainer list with every case-insensitive match for the user removed. npm does not allow a package to be left with no maintainer. Read the raw body.",
    cli: "npm owner rm <user> <pkg>",
    interactive2fa: true,
  },
  "packument-delete": {
    check:
      "This DELETE carries no body, so nothing in the request was malformed; the registry is refusing to remove the package. npm's unpublish policy (a package published more than 72 hours ago that has dependents, 300 or more downloads in the last week, or more than one owner) has been observed to answer 405, so a 422 here is unusual. Read the raw body.",
    cli: "npm unpublish <pkg> --force",
  },
  "dist-tag-put": {
    check:
      "The body was the version as a JSON string (\"1.2.3\"), verified to exist before the write. npm documents that a tag name which parses as a semver range ('1', '1.x', 'v2', '2.0.0') is rejected; the npm CLI checks that before sending and this tool does not, so pick a tag that does not start with a digit or 'v'. Otherwise the version may have been unpublished between the check and the write. Read the raw body.",
    cli: "npm dist-tag add <pkg>@<version> <tag>",
  },
  "dist-tag-delete": {
    check:
      "This DELETE carries no body. The tag may not be on the package (npm_dist_tags lists them; the npm CLI checks this before sending, so the registry's status for a missing tag is undocumented). Read the raw body.",
    cli: "npm dist-tag rm <pkg> <tag>",
  },
  "access-post": {
    check:
      "The body was { access: 'public' | 'restricted' }. npm documents that unscoped packages are always public, so restricted needs an @scope/ package. Read the raw body.",
    cli: "npm access set status=public|private <pkg>",
    interactive2fa: true,
  },
  "access-mfa-post": {
    check:
      "The body was { publish_requires_tfa }, plus automation_token_overrides_tfa for the publish and automation levels. npm requires the account setting a 2FA publish requirement to have two-factor auth enabled itself. Read the raw body.",
    cli: "npm access set mfa=none|publish|automation <pkg>",
    interactive2fa: true,
  },
  "team-package-put": {
    check:
      "The body was { package, permissions }. The package must be one the team's org governs (an org-scoped package, or one transferred to the org). Read the raw body.",
    cli: "npm access grant <read-only|read-write> <scope:team> <pkg>",
    interactive2fa: true,
  },
  "team-package-delete": {
    check:
      "The body was { package } on a DELETE. The team may hold no grant on the package, and a proxy in front of the registry can drop a DELETE body, so check NPM_REGISTRY. Read the raw body.",
    cli: "npm access revoke <scope:team> <pkg>",
    interactive2fa: true,
  },
  "team-put": {
    check:
      "The body was { name, description? }. npm team names must be lower case with no spaces or punctuation, which is stricter than the local check (it allows capitals and . _ -), and every org already has a built-in `developers` team, so that name is taken. Read the raw body.",
    cli: "npm team create <scope:team>",
  },
  "team-delete": {
    check:
      "This DELETE carries no body. npm does not allow the built-in `developers` team to be removed. Read the raw body.",
    cli: "npm team destroy <scope:team>",
  },
  "team-user-put": {
    check:
      "The body was { user }. npm requires the user to be a member of the org before joining one of its teams -- add them with npm_org_member_set first; a leading '@' on the username is sent as-is, so drop it. Read the raw body.",
    cli: "npm team add <scope:team> <user>",
    interactive2fa: true,
  },
  "team-user-delete": {
    check:
      "The body was { user } on a DELETE. The user may not be on the team; a leading '@' on the username is sent as-is, so drop it; and a proxy in front of the registry can drop a DELETE body, so check NPM_REGISTRY. Read the raw body.",
    cli: "npm team rm <scope:team> <user>",
    interactive2fa: true,
  },
  "org-user-put": {
    check:
      "The body was { user, role? }. The registry can refuse a target user who does not exist, one without two-factor auth when the org requires it for every member (that is the target account, not your token), or a role change that would leave the org without an owner. Read the raw body.",
    cli: "npm org set <org> <user> <developer|admin|owner>",
    interactive2fa: true,
  },
  "org-user-delete": {
    check:
      "The body was { user } on a DELETE. npm does not allow an org's last owner to be removed, and a proxy in front of the registry can drop a DELETE body, so check NPM_REGISTRY. Read the raw body.",
    cli: "npm org rm <org> <user>",
    interactive2fa: true,
  },
  "token-delete": {
    check:
      "This DELETE carries no body. The key passed the local check but may not be a full token id -- list keys with npm_tokens and pass one verbatim. Read the raw body.",
    cli: "npm token revoke <id|token>",
    interactive2fa: true,
  },
  "hook-post": {
    check:
      "The body was { type, name, endpoint, secret }. npm put its hooks service on a sunset notice in July 2024 (hooks 'might no longer be functional') and removed `npm hook` in npm 11, so a refusal here may be the service rather than the payload. Read the raw body.",
  },
  "hook-put": {
    check:
      "The body was { endpoint, secret }. The id is passed through unvalidated (npm_hook_list lists real ids), and npm's hooks service has been on a sunset notice since July 2024, so a refusal may be the service rather than the payload. Read the raw body.",
  },
  "hook-delete": {
    check:
      "This DELETE carries no body; the id is passed through unvalidated -- list hooks with npm_hook_list and pass an id verbatim. npm's hooks service has been on a sunset notice since July 2024. Read the raw body.",
  },
};

function resolveCall(context: ErrorContext): RegistryCall {
  // A caller passing a value outside the union (a JS caller, or a cast) must
  // land on the neutral wording, never on `undefined`.
  return context.call && (REGISTRY_CALLS as readonly string[]).includes(context.call) ? context.call : "read";
}

/** The CLI equivalent with the package filled in, or undefined when none exists. */
function renderCli(hint: CallHint, context: ErrorContext): string | undefined {
  // A replacer FUNCTION, not a string: a string replacement expands `$&`,
  // `$$` and `$'`. Package names are validated before any request, so no
  // tool can reach here with a `$`, but translateError is exported.
  return hint.cli?.replaceAll("<pkg>", () => context.pkg ?? "<pkg>");
}

/**
 * The 2FA sentence for 401 and 403. For a call on npm's 2026-07-31 list no
 * token works any more, so the fix is a human at the CLI, not a new token.
 */
function twoFactorAdvice(call: RegistryCall, context: ErrorContext): string {
  const hint = CALL_HINTS[call];
  if (hint.interactive2fa) {
    const cli = renderCli(hint, context);
    return ` Since 2026-07-31 npm requires an interactive 2FA challenge for this change even from a Granular Access Token with 2FA bypass, so no token can make it headlessly: a human runs \`${cli}\` in their own terminal and answers the one-time-password prompt.`;
  }
  const which = call === "read" ? "for headless writes" : "for this change";
  return ` An OTP challenge arrives as 401 and a 2FA-policy refusal as 403, never as 422. A Granular Access Token with 'Read and write' permission and 2FA bypass enabled (https://www.npmjs.com/settings/~/tokens) answers both ${which}; classic tokens, including Automation tokens, were revoked in December 2025.`;
}

/**
 * Translate a non-2xx registry response into an actionable error message.
 * Preserves the original status and raw error for debugging.
 */
export function translateError<T>(res: ApiResponse<T>, context: ErrorContext): ApiResponse<T> {
  if (res.ok) return res;

  const pkgPart = context.pkg ? ` for ${context.pkg}` : "";
  const opPart = context.op ? ` during ${context.op}` : "";
  const call = resolveCall(context);

  switch (res.status) {
    case 401:
      return {
        ...res,
        error: `Authentication failed${pkgPart}${opPart}. Your NPM_TOKEN may be invalid, expired, or lack write scope, or the registry may have asked for a one-time password the token cannot supply.${twoFactorAdvice(call, context)} Raw: ${res.error}`,
      };
    case 403:
      return {
        ...res,
        error: `Not authorized${pkgPart}${opPart}. You may not be a maintainer of this package, the token's scope may not include it, or the package or org may require 2FA for writes. Check current maintainers with npm_collaborators or npm_package_access.${twoFactorAdvice(call, context)} Raw: ${res.error}`,
      };
    case 404:
      return {
        ...res,
        error: `Not found${pkgPart}${opPart}. Check the exact package name (scoped packages require the @scope/ prefix). If the version is specified, verify it exists with npm_package. Raw: ${res.error}`,
      };
    case 422: {
      const hint = CALL_HINTS[call];
      const cli = renderCli(hint, context);
      const cliPart = cli
        ? ` CLI equivalent, which prints the registry's full error and prompts for a one-time password if one is required: \`${cli}\`.`
        : "";
      return {
        ...res,
        error: `Registry rejected the request${pkgPart}${opPart} (422 Unprocessable Entity). ${hint.check}${cliPart} Raw: ${res.error}`,
      };
    }
    case 429:
      return {
        ...res,
        error: `Rate limited${opPart}. Retried automatically and still failed — wait longer and retry, or contact npm support if this persists. Raw: ${res.error}`,
      };
    case 409:
      return {
        ...res,
        error: `Version conflict${pkgPart}${opPart}. The package metadata changed between read and write (a concurrent publish, deprecate, or registry _rev bump). Re-run the operation — it re-fetches the current _rev each call. Raw: ${res.error}`,
      };
    case 0:
      return {
        ...res,
        error: `Network error${opPart}. Could not reach the registry. Raw: ${res.error}`,
      };
    default:
      if (res.status >= 500) {
        return {
          ...res,
          error: `Registry server error${pkgPart}${opPart} (HTTP ${res.status}). Retried automatically and still failed — the registry is likely having a transient outage. Wait and retry; check https://status.npmjs.org if it persists. Raw: ${res.error}`,
        };
      }
      return res;
  }
}

/**
 * Build the error for a 2xx that carried no parseable body.
 *
 * `request()` returns `{ ok: true }` with no `data` for an empty 2xx (see
 * api.ts). Handlers that need the body were reading it through `res.data!`,
 * which turns that case into a TypeError surfaced as a generic "Error: Cannot
 * read properties of undefined". This gives the caller something actionable
 * and keeps the `{ ok, status, error }` shape used everywhere else.
 */
export function emptyBodyError(context: ErrorContext): { ok: false; status: number; error: string } {
  const pkgPart = context.pkg ? ` for ${context.pkg}` : "";
  const opPart = context.op ? ` during ${context.op}` : "";
  return {
    ok: false,
    status: 502,
    error: `Registry returned a success status with an empty body${pkgPart}${opPart}. This is usually a transient registry or proxy fault -- retry the call.`,
  };
}

/**
 * Validate a deprecation message against the npm registry's hard 1024-char limit.
 * Returns null if safe to send, or an error string explaining the issue.
 *
 * History: earlier versions also flagged a "period + space + capital letter" pattern
 * after a single 422 incident. Follow-up testing (issue #2) confirmed that case was
 * a wildcard-version issue, not a message-format issue, and the pattern check produced
 * too many false positives. Removed in v0.10.
 */
export function validateDeprecationMessage(msg: string): string | null {
  if (msg.length > 1024) {
    return "Deprecation message exceeds 1024 characters (registry limit).";
  }
  return null;
}
