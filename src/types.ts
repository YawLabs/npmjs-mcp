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

/** Full packument (all versions, readme, maintainers, etc). */
export interface Packument {
  _id: string;
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
