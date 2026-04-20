/**
 * Error translation helpers — turn opaque registry responses into actionable messages.
 *
 * The npm registry returns generic 401/403/404/422 with minimal context. These helpers
 * produce error strings that tell the caller (often an AI assistant) what specifically
 * went wrong and what to try next.
 */

import type { ApiResponse } from "./api.js";

/**
 * Translate a non-2xx registry response into an actionable error message.
 * Preserves the original status and raw error for debugging.
 */
export function translateError<T>(res: ApiResponse<T>, context: { pkg?: string; op?: string }): ApiResponse<T> {
  if (res.ok) return res;

  const pkgPart = context.pkg ? ` for ${context.pkg}` : "";
  const opPart = context.op ? ` during ${context.op}` : "";

  switch (res.status) {
    case 401:
      return {
        ...res,
        error: `Authentication failed${pkgPart}${opPart}. Your NPM_TOKEN may be invalid, expired, or lack write scope. Create a Granular Access Token with 'Read and write' permission at https://www.npmjs.com/settings/~/tokens, or use a classic Automation token (which bypasses 2FA). Raw: ${res.error}`,
      };
    case 403:
      return {
        ...res,
        error: `Not authorized${pkgPart}${opPart}. You may not be a maintainer of this package, or the token's scope doesn't include it. Check current maintainers with npm_collaborators or npm_package_access. Raw: ${res.error}`,
      };
    case 404:
      return {
        ...res,
        error: `Not found${pkgPart}${opPart}. Check the exact package name (scoped packages require the @scope/ prefix). If the version is specified, verify it exists with npm_package. Raw: ${res.error}`,
      };
    case 422:
      return {
        ...res,
        error: `Registry rejected the request payload${pkgPart}${opPart} (422 Unprocessable Entity). Most common causes: (1) semver range matches no published versions — validate with npm_versions first; (2) deprecation message exceeds 1024 characters; (3) account-level 2FA policy requires an interactive CLI session. If #3, CLI fallback: \`npm login --auth-type=web\` followed by the equivalent npm CLI command. Raw: ${res.error}`,
      };
    case 429:
      return {
        ...res,
        error: `Rate limited${opPart}. Retried automatically and still failed — wait longer and retry, or contact npm support if this persists. Raw: ${res.error}`,
      };
    case 0:
      return {
        ...res,
        error: `Network error${opPart}. Could not reach the registry. Raw: ${res.error}`,
      };
    default:
      return res;
  }
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

/**
 * Filter a version list to those satisfying a semver range.
 * Uses the existing maxSatisfying helper iteratively; O(n) for n versions.
 * Treats "*" or "" as match-all.
 */
export function versionsMatchingRange(
  versions: string[],
  range: string,
  maxSatisfying: (vs: string[], r: string) => string | null,
): string[] {
  if (range === "*" || range === "") return [...versions];
  return versions.filter((v) => maxSatisfying([v], range) === v);
}
