/**
 * Shared type definitions for npm registry API responses.
 *
 * Three response shapes exist depending on the Accept header:
 *   - Packument (full)         — all versions, readme, maintainers
 *   - AbbreviatedPackument     — deps-only (application/vnd.npm.install-v1+json)
 *   - VersionDoc               — single version metadata
 */

/** Full version document from the npm registry. */
export interface VersionDoc {
  name: string;
  version: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  license?: string;
  author?: { name?: string; email?: string; url?: string } | string;
  maintainers?: Array<{ name: string; email?: string }>;
  repository?: { type?: string; url?: string } | string;
  homepage?: string;
  bugs?: { url?: string } | string;
  keywords?: string[];
  dist: {
    shasum: string;
    tarball: string;
    integrity?: string;
    fileCount?: number;
    unpackedSize?: number;
    signatures?: Array<{ sig: string; keyid: string }>;
  };
  deprecated?: string;
  types?: string;
  typings?: string;
  _npmUser?: { name: string; email?: string };
}

/**
 * Full packument (all versions, readme, maintainers, etc).
 *
 * The CouchDB-style fields (`_rev`, `_revisions`, `_attachments`) are only
 * populated on `?write=true` reads. They're optional so the same type works
 * for both read and write paths.
 */
export interface Packument {
  _id: string;
  _rev?: string;
  _revisions?: unknown;
  _attachments?: unknown;
  name: string;
  description?: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, VersionDoc>;
  time: Record<string, string>;
  maintainers: Array<{ name: string; email?: string }>;
  author?: { name?: string; email?: string; url?: string } | string;
  license?: string;
  homepage?: string;
  repository?: { type?: string; url?: string } | string;
  bugs?: { url?: string } | string;
  keywords?: string[];
  readme?: string;
}

/** Abbreviated packument (dependencies only, from Accept: application/vnd.npm.install-v1+json). */
export interface AbbreviatedPackument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<
    string,
    {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    }
  >;
}

// ─── Authenticated endpoint shapes ──────────────────────
// Snake_case fields are preserved as-is from the wire format; handlers that
// expose these via tool output convert to camelCase at the boundary.

/** npm access token record from /-/npm/v1/tokens. */
export interface TokenObject {
  token: string;
  key: string;
  cidr_whitelist: string[];
  created: string;
  updated: string;
  readonly: boolean;
}

/** Paginated response from /-/npm/v1/tokens. */
export interface TokenListResponse {
  total: number;
  objects: TokenObject[];
  urls?: { next?: string; prev?: string };
}

/** Authenticated user profile from /-/npm/v1/user. */
export interface UserProfile {
  name?: string;
  email?: string;
  email_verified?: boolean;
  created?: string;
  updated?: string;
  tfa?: { pending: boolean; mode: string } | null;
  fullname?: string;
  homepage?: string;
  freenode?: string;
  twitter?: string;
  github?: string;
  cidr_whitelist?: string[] | null;
}
