import { z } from "zod";
import { type ApiResponse, encPkg, registryGet, registryGetAbbreviated } from "../api.js";

interface AbbreviatedPackument {
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

interface VersionDoc {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  license?: string;
}

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
      if (!res.ok) return res;

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
      depth: z.number().min(1).max(5).optional().describe("Max tree depth (default 3, max 5)"),
    }),
    handler: async (input: { name: string; version?: string; depth?: number }) => {
      const maxDepth = input.depth ?? 3;
      const MAX_CONCURRENT = 10;
      const packumentCache = new Map<string, AbbreviatedPackument>(); // pkg name -> packument
      const resolved = new Set<string>(); // "name@hint" keys already queued
      const tree: Record<string, { version: string; dependencies: Record<string, string> }> = {};
      const warnings: string[] = [];

      // Simple concurrency limiter
      let active = 0;
      const queue: Array<() => void> = [];
      function runLimited<T>(fn: () => Promise<T>): Promise<T> {
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
          if (active < MAX_CONCURRENT) run();
          else queue.push(run);
        });
      }

      async function resolve(name: string, versionHint: string, currentDepth: number): Promise<void> {
        const hintKey = `${name}@${versionHint}`;
        if (resolved.has(hintKey) || currentDepth > maxDepth) return;
        resolved.add(hintKey);

        // Cache packuments by package name to avoid duplicate fetches
        let pkg = packumentCache.get(name);
        if (!pkg) {
          const res = await runLimited(() => registryGetAbbreviated<AbbreviatedPackument>(`/${encPkg(name)}`));
          if (!res.ok) {
            warnings.push(`Failed to fetch ${name}: ${res.error}`);
            tree[hintKey] = { version: versionHint, dependencies: {} };
            return;
          }
          pkg = res.data!;
          packumentCache.set(name, pkg);
        }

        // Resolve to latest if we got a range/tag
        let resolvedVersion: string;
        if (pkg.versions[versionHint]) {
          resolvedVersion = versionHint;
        } else if (pkg["dist-tags"][versionHint]) {
          resolvedVersion = pkg["dist-tags"][versionHint];
        } else {
          resolvedVersion = pkg["dist-tags"]?.latest ?? versionHint;
        }

        // Deduplicate on resolved version (different ranges may resolve to the same version)
        const resolvedKey = `${name}@${resolvedVersion}`;
        if (tree[resolvedKey]) return;

        const versionData = pkg.versions[resolvedVersion];
        if (!versionData) {
          tree[resolvedKey] = { version: resolvedVersion, dependencies: {} };
          return;
        }

        const deps = versionData.dependencies ?? {};
        tree[resolvedKey] = { version: resolvedVersion, dependencies: deps };

        if (currentDepth < maxDepth) {
          const tasks = Object.entries(deps).map(([depName, depRange]) => resolve(depName, depRange, currentDepth + 1));
          await Promise.all(tasks);
        }
      }

      await resolve(input.name, input.version ?? "latest", 1);

      return {
        ok: true,
        status: 200,
        data: {
          root: `${input.name}@${input.version ?? "latest"}`,
          depth: maxDepth,
          totalPackages: Object.keys(tree).length,
          tree,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      } as ApiResponse;
    },
  },
  {
    name: "npm_license_check",
    description:
      "Check the license of a package and its direct production dependencies. Flags missing or non-standard licenses.",
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
      if (!res.ok) return res;

      const pkg = res.data!;
      const deps = Object.keys(pkg.dependencies ?? {});

      // Fetch license info for direct deps with concurrency limit
      const MAX_CONCURRENT = 10;
      let active = 0;
      const queue: Array<() => void> = [];
      function runLimited<T>(fn: () => Promise<T>): Promise<T> {
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
          if (active < MAX_CONCURRENT) run();
          else queue.push(run);
        });
      }

      const depLicenses = await Promise.all(
        deps.map(async (depName) => {
          const depRes = await runLimited(() => registryGet<VersionDoc>(`/${encPkg(depName)}/latest`));
          return {
            name: depName,
            license: depRes.ok ? (depRes.data?.license ?? "UNKNOWN") : "FETCH_ERROR",
          };
        }),
      );

      const allowedSet = new Set(
        input.allowed ?? ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "Unlicense"],
      );

      const results = [
        { name: pkg.name, version: pkg.version, license: pkg.license ?? "UNKNOWN" },
        ...depLicenses.map((d) => ({ name: d.name, version: "latest", license: d.license })),
      ];

      const flagged = results.filter((r) => !allowedSet.has(r.license));

      return {
        ok: true,
        status: 200,
        data: {
          total: results.length,
          allowed: [...allowedSet],
          flagged: flagged.length,
          packages: results,
          issues: flagged.length > 0 ? flagged : undefined,
        },
      } as ApiResponse;
    },
  },
] as const;
