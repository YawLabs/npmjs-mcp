/**
 * npm registry API client — read-only, no authentication required.
 *
 * Three base URLs:
 *   - registry.npmjs.org  — package metadata, search, security
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
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
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
}

// ─── Registry API (registry.npmjs.org) ───

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

// ─── Downloads API (api.npmjs.org) ───

export function downloadsGet<T = unknown>(path: string): Promise<ApiResponse<T>> {
  return request<T>(DOWNLOADS_URL, path);
}

// ─── Replicate API (replicate.npmjs.com) ───

export function replicateGet<T = unknown>(path: string): Promise<ApiResponse<T>> {
  return request<T>(REPLICATE_URL, path);
}
