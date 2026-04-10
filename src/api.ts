/**
 * npm registry API client — supports both public (read-only) and authenticated endpoints.
 *
 * Authentication is optional via the NPM_TOKEN environment variable.
 * When set, authenticated endpoints (whoami, tokens, org management, etc.) become available.
 *
 * Three base URLs:
 *   - registry.npmjs.org  — package metadata, search, security, auth
 *   - api.npmjs.org       — download statistics
 *   - replicate.npmjs.com — CouchDB changes feed
 */

const REGISTRY_URL = "https://registry.npmjs.org";
const DOWNLOADS_URL = "https://api.npmjs.org";
const REPLICATE_URL = "https://replicate.npmjs.com";
const REQUEST_TIMEOUT_MS = 30_000;

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

/** URL-encode a package name (handles scoped packages like @scope/name). */
export function encPkg(name: string): string {
  if (!name || name === "@") throw new Error("Invalid package name");
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

/** Check whether an NPM_TOKEN is configured. */
export function isAuthenticated(): boolean {
  return !!process.env.NPM_TOKEN;
}

/** Return an error response when auth is required but no token is set. */
export function requireAuth<T = unknown>(): ApiResponse<T> | null {
  if (isAuthenticated()) return null;
  return {
    ok: false,
    status: 401,
    error:
      "No NPM_TOKEN configured. Set the NPM_TOKEN environment variable to use authenticated endpoints. " +
      "Create a token at https://www.npmjs.com/settings/~/tokens — use a Granular Access Token for CI/CD " +
      "(automation tokens bypass 2FA).",
  };
}

function authHeaders(): Record<string, string> {
  const token = process.env.NPM_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T = unknown>(
  baseUrl: string,
  path: string,
  options?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<ApiResponse<T>> {
  const method = options?.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options?.headers,
  };

  let fetchBody: string | undefined;
  if (options?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    fetchBody = JSON.stringify(options.body);
  }

  const url = `${baseUrl}${path}`;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: fetchBody,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      return { ok: false, status: res.status, error: errorBody };
    }

    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return { ok: true, status: res.status };
    }

    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: message };
  }
}

// ─── Registry API (registry.npmjs.org) — public ───

/** Fetch full packument (all versions, readme, maintainers, etc). */
export function registryGet<T = unknown>(path: string): Promise<ApiResponse<T>> {
  return request<T>(REGISTRY_URL, path);
}

/** Fetch abbreviated packument (deps-only, much smaller). */
export function registryGetAbbreviated<T = unknown>(path: string): Promise<ApiResponse<T>> {
  return request<T>(REGISTRY_URL, path, {
    headers: { Accept: "application/vnd.npm.install-v1+json" },
  });
}

/** POST to registry (security audit endpoints). */
export function registryPost<T = unknown>(path: string, body: unknown): Promise<ApiResponse<T>> {
  return request<T>(REGISTRY_URL, path, { method: "POST", body });
}

// ─── Registry API — authenticated ───

/** GET with Bearer token (whoami, tokens, org endpoints, etc). */
export function registryGetAuth<T = unknown>(path: string): Promise<ApiResponse<T>> {
  return request<T>(REGISTRY_URL, path, { headers: authHeaders() });
}

/** POST with Bearer token. */
export function registryPostAuth<T = unknown>(path: string, body: unknown): Promise<ApiResponse<T>> {
  return request<T>(REGISTRY_URL, path, { method: "POST", body, headers: authHeaders() });
}

/** PUT with Bearer token. */
export function registryPutAuth<T = unknown>(path: string, body: unknown): Promise<ApiResponse<T>> {
  return request<T>(REGISTRY_URL, path, { method: "PUT", body, headers: authHeaders() });
}

/** DELETE with Bearer token. */
export function registryDeleteAuth<T = unknown>(path: string): Promise<ApiResponse<T>> {
  return request<T>(REGISTRY_URL, path, { method: "DELETE", headers: authHeaders() });
}

// ─── Downloads API (api.npmjs.org) ───

export function downloadsGet<T = unknown>(path: string): Promise<ApiResponse<T>> {
  return request<T>(DOWNLOADS_URL, path);
}

// ─── Replicate API (replicate.npmjs.com) ───

export function replicateGet<T = unknown>(path: string): Promise<ApiResponse<T>> {
  return request<T>(REPLICATE_URL, path);
}

// ─── Semver helpers (lightweight, no external deps) ───

/** Parse a semver string into [major, minor, patch]. Returns null if unparseable. */
function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Compare two semver tuples: -1 if a<b, 0 if equal, 1 if a>b. */
function cmpSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/**
 * Find the highest version from `versions` that satisfies `range`.
 * Handles ^, ~, >=, <=, exact, and x-ranges. Falls back to null if no match.
 */
export function maxSatisfying(versions: string[], range: string): string | null {
  // Strip leading whitespace/v prefix
  const r = range.trim().replace(/^v/, "");

  // Exact version
  if (versions.includes(r)) return r;

  let minInclusive: [number, number, number] | null = null;
  let maxExclusive: [number, number, number] | null = null;

  if (r.startsWith("^")) {
    const base = parseSemver(r.slice(1));
    if (!base) return null;
    minInclusive = base;
    // ^1.2.3 -> <2.0.0; ^0.2.3 -> <0.3.0; ^0.0.3 -> <0.0.4
    if (base[0] > 0) maxExclusive = [base[0] + 1, 0, 0];
    else if (base[1] > 0) maxExclusive = [0, base[1] + 1, 0];
    else maxExclusive = [0, 0, base[2] + 1];
  } else if (r.startsWith("~")) {
    const base = parseSemver(r.slice(1));
    if (!base) return null;
    minInclusive = base;
    // ~1.2.3 -> <1.3.0
    maxExclusive = [base[0], base[1] + 1, 0];
  } else if (r.startsWith(">=")) {
    const base = parseSemver(r.slice(2));
    if (!base) return null;
    minInclusive = base;
  } else if (r.startsWith("<=")) {
    const base = parseSemver(r.slice(2));
    if (!base) return null;
    maxExclusive = [base[0], base[1], base[2] + 1]; // inclusive upper
  } else {
    // Try x-ranges: 1.x, 1.2.x, 1, 1.2
    const xm = r.match(/^(\d+)(?:\.(\d+|x)(?:\.(\d+|x))?)?$/);
    if (xm) {
      const major = Number(xm[1]);
      const minor = xm[2] !== undefined && xm[2] !== "x" ? Number(xm[2]) : null;
      if (minor === null) {
        minInclusive = [major, 0, 0];
        maxExclusive = [major + 1, 0, 0];
      } else {
        const patch = xm[3] !== undefined && xm[3] !== "x" ? Number(xm[3]) : null;
        if (patch === null) {
          minInclusive = [major, minor, 0];
          maxExclusive = [major, minor + 1, 0];
        } else {
          // Exact version already handled above
          return null;
        }
      }
    } else {
      return null;
    }
  }

  let best: string | null = null;
  let bestParsed: [number, number, number] | null = null;

  for (const v of versions) {
    // Skip prereleases (e.g. 1.0.0-beta.1) unless range explicitly targets one
    if (v.includes("-") && !r.includes("-")) continue;
    const parsed = parseSemver(v);
    if (!parsed) continue;
    if (minInclusive && cmpSemver(parsed, minInclusive) < 0) continue;
    if (maxExclusive && cmpSemver(parsed, maxExclusive) >= 0) continue;
    if (!bestParsed || cmpSemver(parsed, bestParsed) > 0) {
      best = v;
      bestParsed = parsed;
    }
  }

  return best;
}
