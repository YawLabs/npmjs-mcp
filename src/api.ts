/**
 * npm registry API client — supports both public (read-only) and authenticated endpoints.
 *
 * Config (all optional):
 *   - NPM_TOKEN                — bearer token for authenticated endpoints
 *   - NPM_REGISTRY             — alternate registry URL (defaults to https://registry.npmjs.org)
 *   - NPM_REQUEST_TIMEOUT_MS   — per-request timeout (defaults to 30000)
 *   - NPM_RETRY_BACKOFF_MS     — base backoff between retries (defaults to 500)
 *   - DEBUG=npmjs-mcp          — emit one-line request traces on stderr (tokens never logged)
 *
 * Base URLs:
 *   - registry             — package metadata, search, security, auth (override via NPM_REGISTRY)
 *   - api.npmjs.org        — download statistics (npm-specific, not overrideable)
 *   - replicate.npmjs.com  — CouchDB changes feed (npm-specific, not overrideable)
 *
 * Transient failures (429, 502, 503, 504) retry up to 2 times with exponential backoff,
 * honoring the Retry-After header when present. Network errors retry on the same schedule.
 */

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const DOWNLOADS_URL = "https://api.npmjs.org";
const REPLICATE_URL = "https://replicate.npmjs.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BACKOFF_MS = 500;
const MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

// ─── Env-driven config ──────────────────────────────────

function getRegistryUrl(): string {
  return (process.env.NPM_REGISTRY || DEFAULT_REGISTRY_URL).replace(/\/+$/, "");
}

function getTimeoutMs(): number {
  const raw = process.env.NPM_REQUEST_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function getBackoffMs(attempt: number): number {
  const raw = process.env.NPM_RETRY_BACKOFF_MS;
  const parsed = raw !== undefined ? Number(raw) : Number.NaN;
  const base = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BACKOFF_MS;
  return base * 2 ** attempt;
}

function debugEnabled(): boolean {
  const v = process.env.DEBUG;
  return v === "npmjs-mcp" || v === "*";
}

function debug(msg: string): void {
  if (debugEnabled()) console.error(`[npmjs-mcp] ${msg}`);
}

// ─── Identifier validation ──────────────────────────────
// Applied at tool boundaries so malformed input surfaces an actionable error
// client-side instead of an opaque 404 from the registry.

const PACKAGE_NAME_MAX_LENGTH = 214;
const PACKAGE_NAME_PATTERN = /^(?:@[a-zA-Z0-9][a-zA-Z0-9\-_.]*\/)?[a-zA-Z0-9][a-zA-Z0-9\-_.]*$/;
const IDENT_MAX_LENGTH = 214;
const IDENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9\-_.]*$/;

/**
 * Validate an npm package name. Returns an error message if invalid, null if safe.
 * Intentionally permissive (allows mixed case) to accept legacy uppercase packages.
 */
export function validatePackageName(name: string): string | null {
  if (typeof name !== "string" || name.length === 0) return "Package name is empty";
  if (name.length > PACKAGE_NAME_MAX_LENGTH) {
    return `Package name exceeds ${PACKAGE_NAME_MAX_LENGTH} characters (got ${name.length}).`;
  }
  if (!PACKAGE_NAME_PATTERN.test(name)) {
    return `Invalid package name '${name}'. Names must start with an alphanumeric character and contain only [a-zA-Z0-9-_.], optionally prefixed with '@scope/' for scoped packages.`;
  }
  return null;
}

function validateIdent(value: string, label: string): string | null {
  if (typeof value !== "string" || value.length === 0) return `${label} is empty`;
  if (value.length > IDENT_MAX_LENGTH) return `${label} exceeds ${IDENT_MAX_LENGTH} characters`;
  if (!IDENT_PATTERN.test(value)) {
    return `Invalid ${label.toLowerCase()} '${value}'. Must start alphanumeric and contain only [a-zA-Z0-9-_.].`;
  }
  return null;
}

/** Validate an npm scope or org name. Accepts the leading `@` optionally. */
export function validateScope(scope: string): string | null {
  return validateIdent(scope.replace(/^@/, ""), "Scope");
}

/** Validate an npm username. Accepts the leading `@` optionally. */
export function validateUsername(username: string): string | null {
  return validateIdent(username.replace(/^@/, ""), "Username");
}

/** Validate an npm team name (no `@` prefix). */
export function validateTeam(team: string): string | null {
  return validateIdent(team, "Team name");
}

/** Validate a dist-tag name. Same charset as other idents. */
export function validateTag(tag: string): string | null {
  return validateIdent(tag, "Tag name");
}

/**
 * URL-encode a package name for use in registry paths. Throws on invalid input.
 * Scoped packages are preserved with an unencoded `@` prefix as the registry requires.
 */
export function encPkg(name: string): string {
  const err = validatePackageName(name);
  if (err) throw new Error(err);
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

/** URL-encode a scope (without the `@` prefix). Throws on invalid input. */
export function encScope(scope: string): string {
  const err = validateScope(scope);
  if (err) throw new Error(err);
  return encodeURIComponent(scope.replace(/^@/, ""));
}

/** URL-encode a username (without the `@` prefix). Throws on invalid input. */
export function encUser(username: string): string {
  const err = validateUsername(username);
  if (err) throw new Error(err);
  return encodeURIComponent(username.replace(/^@/, ""));
}

/** URL-encode a team name. Throws on invalid input. */
export function encTeam(team: string): string {
  const err = validateTeam(team);
  if (err) throw new Error(err);
  return encodeURIComponent(team);
}

/** URL-encode a dist-tag name. Throws on invalid input. */
export function encTag(tag: string): string {
  const err = validateTag(tag);
  if (err) throw new Error(err);
  return encodeURIComponent(tag);
}

// ─── Auth ──────────────────────────────────────────────

export function isAuthenticated(): boolean {
  return !!process.env.NPM_TOKEN;
}

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

// ─── HTTP request with retry/backoff on transient failures ────

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: fetchBody,
        signal: AbortSignal.timeout(getTimeoutMs()),
      });

      if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
        const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
        const waitMs = retryAfter ?? getBackoffMs(attempt);
        debug(`${method} ${url} -> ${res.status} retry in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
        // Drain body to free the connection before retrying
        try {
          await res.text();
        } catch {
          // ignore — drain is best-effort
        }
        await sleep(waitMs);
        continue;
      }

      const elapsed = Date.now() - started;

      if (!res.ok) {
        const errorBody = await res.text();
        debug(`${method} ${url} -> ${res.status} ${elapsed}ms`);
        return { ok: false, status: res.status, error: errorBody };
      }

      if (res.status === 204 || res.headers.get("content-length") === "0") {
        debug(`${method} ${url} -> ${res.status} ${elapsed}ms`);
        return { ok: true, status: res.status };
      }

      const data = (await res.json()) as T;
      debug(`${method} ${url} -> ${res.status} ${elapsed}ms`);
      return { ok: true, status: res.status, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        const waitMs = getBackoffMs(attempt);
        debug(`${method} ${url} -> network error retry in ${waitMs}ms (${message})`);
        await sleep(waitMs);
        continue;
      }
      debug(`${method} ${url} -> network error: ${message}`);
      return { ok: false, status: 0, error: message };
    }
  }
  // Unreachable — loop body always returns or continues within bounds
  return { ok: false, status: 0, error: "unreachable" };
}

// ─── Registry API (public) ──────────────────────────────

/** Fetch full packument (all versions, readme, maintainers, etc). */
export function registryGet<T = unknown>(path: string): Promise<ApiResponse<T>> {
  return request<T>(getRegistryUrl(), path);
}

/** Fetch abbreviated packument (deps-only, much smaller). */
export function registryGetAbbreviated<T = unknown>(path: string): Promise<ApiResponse<T>> {
  return request<T>(getRegistryUrl(), path, {
    headers: { Accept: "application/vnd.npm.install-v1+json" },
  });
}

/** POST to registry (security audit endpoints). */
export function registryPost<T = unknown>(path: string, body: unknown): Promise<ApiResponse<T>> {
  return request<T>(getRegistryUrl(), path, { method: "POST", body });
}

// ─── Registry API (authenticated) ───────────────────────

export function registryGetAuth<T = unknown>(path: string): Promise<ApiResponse<T>> {
  return request<T>(getRegistryUrl(), path, { headers: authHeaders() });
}

export function registryPostAuth<T = unknown>(path: string, body: unknown): Promise<ApiResponse<T>> {
  return request<T>(getRegistryUrl(), path, { method: "POST", body, headers: authHeaders() });
}

export function registryPutAuth<T = unknown>(path: string, body: unknown): Promise<ApiResponse<T>> {
  return request<T>(getRegistryUrl(), path, { method: "PUT", body, headers: authHeaders() });
}

export function registryDeleteAuth<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>> {
  return request<T>(getRegistryUrl(), path, { method: "DELETE", body, headers: authHeaders() });
}

// ─── Downloads / Replicate (npm-specific, not overrideable) ───

export function downloadsGet<T = unknown>(path: string): Promise<ApiResponse<T>> {
  return request<T>(DOWNLOADS_URL, path);
}

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

    // A prerelease tag is `-<alphanumeric>` directly attached to a version
    // (e.g. `^1.0.0-beta`). Hyphen ranges (`1.0.0 - 2.0.0`) have whitespace
    // around the dash, so they must not be misread as targeting prereleases.
    // When a range names a prerelease, only prereleases with the same
    // major.minor.patch as the anchor are eligible -- this matches npm semver,
    // which would NOT consider 1.5.0-alpha to satisfy ^1.0.0-beta.
    const anchorMatch = sub.match(/(\d+)\.(\d+)\.(\d+)-/);
    const prereleaseAnchor: SemVer | null = anchorMatch
      ? [Number(anchorMatch[1]), Number(anchorMatch[2]), Number(anchorMatch[3])]
      : null;

    for (const v of versions) {
      const vp = parseSemver(v);
      if (!vp) continue;
      if (v.includes("-")) {
        if (!prereleaseAnchor) continue;
        if (vp[0] !== prereleaseAnchor[0] || vp[1] !== prereleaseAnchor[1] || vp[2] !== prereleaseAnchor[2]) continue;
      }
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
