import { z } from "zod";
import { type ApiResponse, createLimiter, encPkg, maxSatisfying, registryGet, registryGetAbbreviated } from "../api.js";
import { translateError } from "../errors.js";
import type { AbbreviatedPackument, VersionDoc } from "../types.js";

export const dependencyTools = [
  {
    name: "npm_dependencies",
    description:
      "Get the dependency lists for a specific package version — production deps, devDeps, peerDeps, and optionalDeps.",
    annotations: {
      title: "Get dependencies",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      version: z.string().optional().describe("Semver version or dist-tag (default: 'latest')"),
    }),
    handler: async (input: { name: string; version?: string }) => {
      const ver = input.version ?? "latest";
      const res = await registryGet<VersionDoc>(`/${encPkg(input.name)}/${ver}`);
      if (!res.ok) return translateError(res, { pkg: input.name, op: `dependencies ${ver}` });

      const v = res.data!;
      return {
        ok: true,
        status: 200,
        data: {
          name: v.name,
          version: v.version,
          dependencies: v.dependencies ?? {},
          devDependencies: v.devDependencies ?? {},
          peerDependencies: v.peerDependencies ?? {},
          optionalDependencies: v.optionalDependencies ?? {},
          totalDeps: Object.keys(v.dependencies ?? {}).length,
          totalDevDeps: Object.keys(v.devDependencies ?? {}).length,
        },
      };
    },
  },
  {
    name: "npm_dep_tree",
    description:
      "Resolve the production dependency tree for a package version (up to a configurable depth). Shows the full transitive dependency graph with versions.",
    annotations: {
      title: "Resolve dependency tree",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      version: z.string().optional().describe("Semver version or dist-tag (default: 'latest')"),
      depth: z.number().min(1).max(5).optional().describe("Max tree depth where the root counts as level 1 (default 3 = root + 2 transitive levels, max 5)"),
    }),
    handler: async (input: { name: string; version?: string; depth?: number }) => {
      const maxDepth = input.depth ?? 3;
      const runLimited = createLimiter(10);
      // Cache stores the IN-FLIGHT promise (resolving to the packument, or null
      // on fetch failure). When two parents reference the same package via
      // different ranges they share a single network round-trip instead of
      // racing duplicate fetches before the first one populates the cache.
      const packumentCache = new Map<string, Promise<AbbreviatedPackument | null>>();
      // Tracks package names whose fetch failed AND whose placeholder is
      // already recorded in the tree. Without this, a failed transitive
      // referenced from two parents lands two placeholders (under different
      // hintKeys) and inflates `unresolvedCount` to 2 for one underlying
      // failure.
      const failedPackages = new Set<string>();
      const resolved = new Set<string>(); // "name@hint" keys already queued
      // `failed: true` marks entries we couldn't fully resolve. Two failure
      // modes both land here:
      //   1. The packument fetch never returned (404/network/etc).
      //   2. The packument returned, but no version satisfied the requested
      //      range AND there was no `latest` to fall back on.
      // In both cases `version` holds the REQUESTED range string, not a real
      // resolved version — callers must filter on `failed` before reading
      // `version` as a semver.
      type TreeNode = { version: string; dependencies: Record<string, string>; failed?: true };
      const tree: Record<string, TreeNode> = {};
      const warnings: string[] = [];

      async function resolve(name: string, versionHint: string, currentDepth: number): Promise<void> {
        const hintKey = `${name}@${versionHint}`;
        if (resolved.has(hintKey) || currentDepth > maxDepth) return;
        resolved.add(hintKey);

        // Share the in-flight fetch across concurrent callers. The warning is
        // pushed inside the .then so it fires exactly once per failed package
        // name (the .then callback runs once, regardless of how many awaiters
        // there are on the resulting promise).
        let pending = packumentCache.get(name);
        if (!pending) {
          // Wrap encPkg in try/catch: a malformed transitive dep name (e.g. a
          // registry entry with an invalid character) must not abort the whole
          // tree. Record a failed node and continue, mirroring the fetch-failure
          // path below.
          let encodedName: string;
          try {
            encodedName = encPkg(name);
          } catch {
            warnings.push(`Invalid package name "${name}": skipped`);
            if (!failedPackages.has(name)) {
              failedPackages.add(name);
              tree[hintKey] = { version: versionHint, dependencies: {}, failed: true };
            }
            return;
          }
          pending = runLimited(() => registryGetAbbreviated<AbbreviatedPackument>(`/${encodedName}`)).then((res) => {
            if (!res.ok) {
              warnings.push(`Failed to fetch ${name}: ${res.error}`);
              return null;
            }
            return res.data!;
          });
          packumentCache.set(name, pending);
        }

        const pkg = await pending;
        if (!pkg) {
          // Exactly one placeholder per failed package name. Subsequent
          // parents see the failure but don't inflate `unresolvedCount`
          // with duplicate entries under different hintKeys.
          if (!failedPackages.has(name)) {
            failedPackages.add(name);
            tree[hintKey] = { version: versionHint, dependencies: {}, failed: true };
          }
          return;
        }

        // Resolve version hint to an actual version. Falls back to `latest`
        // when the range doesn't match anything; if `latest` is also missing
        // we leave the range string in place and let the missing-versionData
        // branch below mark the node as failed.
        let resolvedVersion: string;
        if (pkg.versions[versionHint]) {
          resolvedVersion = versionHint;
        } else if (pkg["dist-tags"][versionHint]) {
          resolvedVersion = pkg["dist-tags"][versionHint];
        } else {
          const available = Object.keys(pkg.versions);
          const matched = maxSatisfying(available, versionHint);
          resolvedVersion = matched ?? pkg["dist-tags"]?.latest ?? versionHint;
        }

        // Deduplicate on resolved version (different ranges may resolve to the same version)
        const resolvedKey = `${name}@${resolvedVersion}`;
        if (tree[resolvedKey]) return;

        const versionData = pkg.versions[resolvedVersion];
        if (!versionData) {
          // Reached when `resolvedVersion` is still the range string (no range
          // match, no latest), or — pathologically — when the registry hands
          // back a `latest`/match that's absent from `versions`. Mark failed
          // so `unresolvedCount` and consumers don't treat this as a real
          // resolution with zero deps. Gated on `failedPackages` so two
          // parents referencing the same unresolvable dep via different
          // ranges land exactly one failed-true entry, matching the
          // fetch-failure path's dedup pattern.
          if (!failedPackages.has(name)) {
            failedPackages.add(name);
            tree[resolvedKey] = { version: resolvedVersion, dependencies: {}, failed: true };
          }
          return;
        }

        const deps = versionData.dependencies ?? {};
        tree[resolvedKey] = { version: resolvedVersion, dependencies: deps };

        if (currentDepth < maxDepth) {
          const tasks = Object.entries(deps).map(([depName, depRange]) => resolve(depName, depRange, currentDepth + 1));
          await Promise.all(tasks);
        }
      }

      const versionHint = input.version ?? "latest";
      await resolve(input.name, versionHint, 1);

      // Prefer a successfully-resolved root key; fall back to the failed
      // placeholder only when the root itself couldn't be fetched.
      const treeEntries = Object.entries(tree);
      const rootKey =
        treeEntries.find(([k, v]) => k.startsWith(`${input.name}@`) && !v.failed)?.[0] ??
        treeEntries.find(([k]) => k.startsWith(`${input.name}@`))?.[0] ??
        `${input.name}@${versionHint}`;

      // `totalPackages` counts resolved nodes only — failed placeholders carry a
      // range string in `version` rather than a real version and would otherwise
      // inflate the count. Surface failures via `unresolvedCount` so callers
      // don't have to inspect the tree to know about them.
      const resolvedCount = treeEntries.filter(([, v]) => !v.failed).length;
      const unresolvedCount = treeEntries.length - resolvedCount;

      return {
        ok: true,
        status: 200,
        data: {
          root: rootKey,
          depth: maxDepth,
          totalPackages: resolvedCount,
          ...(unresolvedCount > 0 ? { unresolvedCount } : {}),
          tree,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      } as ApiResponse;
    },
  },
  {
    name: "npm_license_check",
    description:
      "Check the license of a package and its direct production dependencies. Flags missing or non-standard licenses. " +
      "Matches single SPDX license identifiers case-insensitively (so 'mit' and 'MIT' both match). " +
      "SPDX expressions like '(MIT OR Apache-2.0)' are NOT decomposed — they are flagged unless added to `allowed` verbatim.",
    annotations: {
      title: "Check licenses",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      version: z.string().optional().describe("Semver version or dist-tag (default: 'latest')"),
      allowed: z
        .array(z.string())
        .optional()
        .describe(
          "SPDX license identifiers to treat as allowed (default: MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, Unlicense)",
        ),
    }),
    handler: async (input: { name: string; version?: string; allowed?: string[] }) => {
      const ver = input.version ?? "latest";
      const res = await registryGet<VersionDoc>(`/${encPkg(input.name)}/${ver}`);
      if (!res.ok) return translateError(res, { pkg: input.name, op: `license_check ${ver}` });

      const pkg = res.data!;
      const depEntries = Object.entries(pkg.dependencies ?? {});

      // Fetch license info for direct deps with concurrency limit.
      // Perf note: this is a 2N-fetch pattern per dependency -- one abbreviated
      // packument to resolve the version range, then one version doc for the
      // license field. This is intentional (avoids reading a stale "latest"
      // license when the dep range resolves to an older version), but callers
      // should be aware that a package with many direct deps will issue 2*N
      // registry requests (bounded to 10 in-flight at a time by createLimiter).
      const runLimited = createLimiter(10);

      const depLicenses = await Promise.all(
        depEntries.map(async ([depName, depRange]) => {
          // Resolve the version range to find the correct version
          const abbrevRes = await runLimited(() => registryGetAbbreviated<AbbreviatedPackument>(`/${encPkg(depName)}`));
          if (!abbrevRes.ok) return { name: depName, version: depRange, license: "FETCH_ERROR" };

          const abbrev = abbrevRes.data!;
          const available = Object.keys(abbrev.versions);
          const resolved = maxSatisfying(available, depRange) ?? abbrev["dist-tags"]?.latest;
          if (!resolved) return { name: depName, version: depRange, license: "UNKNOWN" };

          // Fetch the specific version doc for its license
          const verRes = await runLimited(() => registryGet<VersionDoc>(`/${encPkg(depName)}/${resolved}`));
          return {
            name: depName,
            version: resolved,
            license: verRes.ok ? (verRes.data?.license ?? "UNKNOWN") : "FETCH_ERROR",
          };
        }),
      );

      const defaultAllowed = ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "Unlicense"];
      const allowedInput = input.allowed ?? defaultAllowed;
      // SPDX identifiers are case-insensitive per spec; normalize both sides
      // so `mit` and `MIT` match the same entry. Expression strings like
      // `(MIT OR Apache-2.0)` still require a verbatim opt-in via `allowed`.
      const allowedSet = new Set(allowedInput.map((l) => l.toLowerCase()));

      const results = [{ name: pkg.name, version: pkg.version, license: pkg.license ?? "UNKNOWN" }, ...depLicenses];

      const flagged = results.filter((r) => !allowedSet.has(r.license.toLowerCase()));

      return {
        ok: true,
        status: 200,
        data: {
          total: results.length,
          allowed: allowedInput,
          flagged: flagged.length,
          packages: results,
          issues: flagged.length > 0 ? flagged : undefined,
        },
      } as ApiResponse;
    },
  },
] as const;
