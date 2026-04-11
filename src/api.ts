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

// ─── Concurrency limiter ───

/** Create a concurrency limiter that runs at most `max` tasks simultaneously. */
export function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return function runLimited<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            if (queue.length > 0) queue.shift()!();
          });
      };
      if (active < max) run();
      else queue.push(run);
    });
  };
}

// ─── Semver helpers (lightweight, no external deps) ───

type SemVer = [number, number, number];

/** Parse a semver string into [major, minor, patch]. Returns null if unparseable. */
function parseSemver(v: string): SemVer | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Compare two semver tuples: -1 if a<b, 0 if equal, 1 if a>b. */
function cmpSemver(a: SemVer, b: SemVer): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

interface SemverRange {
  min: SemVer | null; // inclusive lower bound
  max: SemVer | null; // exclusive upper bound
}

/** Parse a single comparator (^, ~, >=, >, <=, <, =, x-range) into a range. */
function parseSingleConstraint(r: string): SemverRange | null {
  if (r === "*" || r === "") {
    return { min: null, max: null };
  }

  if (r.startsWith("^")) {
    const base = parseSemver(r.slice(1));
    if (!base) return null;
    let max: SemVer;
    // ^1.2.3 -> <2.0.0; ^0.2.3 -> <0.3.0; ^0.0.3 -> <0.0.4
    if (base[0] > 0) max = [base[0] + 1, 0, 0];
    else if (base[1] > 0) max = [0, base[1] + 1, 0];
    else max = [0, 0, base[2] + 1];
    return { min: base, max };
  }

  if (r.startsWith("~")) {
    const base = parseSemver(r.slice(1));
    if (!base) return null;
    // ~1.2.3 -> <1.3.0
    return { min: base, max: [base[0], base[1] + 1, 0] };
  }

  if (r.startsWith(">=")) {
    const base = parseSemver(r.slice(2));
    if (!base) return null;
    return { min: base, max: null };
  }

  if (r.startsWith(">")) {
    // >1.2.3 → >=1.2.4 (safe for non-prerelease versions, which is all we match)
    const base = parseSemver(r.slice(1));
    if (!base) return null;
    return { min: [base[0], base[1], base[2] + 1], max: null };
  }

  if (r.startsWith("<=")) {
    const base = parseSemver(r.slice(2));
    if (!base) return null;
    return { min: null, max: [base[0], base[1], base[2] + 1] };
  }

  if (r.startsWith("<")) {
    const base = parseSemver(r.slice(1));
    if (!base) return null;
    return { min: null, max: base };
  }

  if (r.startsWith("=")) {
    const base = parseSemver(r.slice(1));
    if (!base) return null;
    return { min: base, max: [base[0], base[1], base[2] + 1] };
  }

  // x-ranges: 1.x, 1.2.x, 1, 1.2
  const xm = r.match(/^(\d+)(?:\.(\d+|x|\*)(?:\.(\d+|x|\*))?)?$/);
  if (xm) {
    const major = Number(xm[1]);
    const minor = xm[2] !== undefined && xm[2] !== "x" && xm[2] !== "*" ? Number(xm[2]) : null;
    if (minor === null) {
      return { min: [major, 0, 0], max: [major + 1, 0, 0] };
    }
    const patch = xm[3] !== undefined && xm[3] !== "x" && xm[3] !== "*" ? Number(xm[3]) : null;
    if (patch === null) {
      return { min: [major, minor, 0], max: [major, minor + 1, 0] };
    }
    // Exact version — handled by the includes() check in maxSatisfying
    return null;
  }

  return null;
}

/**
 * Parse a range string (which may be a compound like ">=1.0.0 <2.0.0"
 * or a hyphen range like "1.2.3 - 2.3.4") into a single SemverRange.
 */
function parseRange(r: string): SemverRange | null {
  // Hyphen range: 1.2.3 - 2.3.4
  const hyphenMatch = r.match(/^(\d+\.\d+\.\d+)\s+-\s+(\d+\.\d+\.\d+)$/);
  if (hyphenMatch) {
    const low = parseSemver(hyphenMatch[1]);
    const high = parseSemver(hyphenMatch[2]);
    if (low && high) return { min: low, max: [high[0], high[1], high[2] + 1] };
    return null;
  }

  // Compound range: ">=1.0.0 <2.0.0" (multiple space-separated comparators)
  const parts = r.trim().split(/\s+/);
  if (parts.length > 1) {
    let min: SemVer | null = null;
    let max: SemVer | null = null;
    for (const part of parts) {
      const constraint = parseSingleConstraint(part);
      if (!constraint) return null;
      if (constraint.min) {
        if (!min || cmpSemver(constraint.min, min) > 0) min = constraint.min;
      }
      if (constraint.max) {
        if (!max || cmpSemver(constraint.max, max) < 0) max = constraint.max;
      }
    }
    return { min, max };
  }

  // Single constraint
  return parseSingleConstraint(r.trim());
}

/**
 * Find the highest version from `versions` that satisfies `range`.
 * Handles ^, ~, >=, >, <=, <, =, x-ranges, hyphen ranges (1.0.0 - 2.0.0),
 * compound ranges (>=1.0.0 <2.0.0), and || unions. Falls back to null if no match.
 */
export function maxSatisfying(versions: string[], range: string): string | null {
  // Strip leading whitespace/v prefix
  const r = range.trim().replace(/^v/, "");

  // Exact version
  if (versions.includes(r)) return r;

  // Split on || for union ranges, find best across all sub-ranges
  const subRanges = r.split("||").map((s) => s.trim());

  let best: string | null = null;
  let bestParsed: SemVer | null = null;

  for (const sub of subRanges) {
    const parsed = parseRange(sub);
    if (!parsed) continue;

    for (const v of versions) {
      // Skip prereleases (e.g. 1.0.0-beta.1) unless range explicitly targets one
      if (v.includes("-") && !sub.includes("-")) continue;
      const vp = parseSemver(v);
      if (!vp) continue;
      if (parsed.min && cmpSemver(vp, parsed.min) < 0) continue;
      if (parsed.max && cmpSemver(vp, parsed.max) >= 0) continue;
      if (!bestParsed || cmpSemver(vp, bestParsed) > 0) {
        best = v;
        bestParsed = vp;
      }
    }
  }

  return best;
}
