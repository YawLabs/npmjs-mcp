import { z } from "zod";
import { encPkg, registryGet } from "../api.js";
import { translateError } from "../errors.js";
import type { Packument, VersionDoc } from "../types.js";

export const packageTools = [
  {
    name: "npm_package",
    description:
      "Get package metadata — description, dist-tags, latest version, maintainers, license, repository, keywords. Does not include per-version details (use npm_version for that).",
    annotations: {
      title: "Get package info",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name (e.g. 'express' or '@anthropic-ai/sdk')"),
    }),
    handler: async (input: { name: string }) => {
      const res = await registryGet<Packument>(`/${encPkg(input.name)}`);
      if (!res.ok) return translateError(res, { pkg: input.name, op: "package" });

      const pkg = res.data!;
      const latest = pkg["dist-tags"]?.latest;
      const latestVersion = latest ? pkg.versions[latest] : undefined;

      return {
        ok: true,
        status: 200,
        data: {
          name: pkg.name,
          description: pkg.description,
          distTags: pkg["dist-tags"],
          latest: latest,
          license: pkg.license ?? latestVersion?.license,
          author: pkg.author,
          maintainers: pkg.maintainers,
          homepage: pkg.homepage ?? latestVersion?.homepage,
          repository: pkg.repository ?? latestVersion?.repository,
          bugs: pkg.bugs ?? latestVersion?.bugs,
          keywords: pkg.keywords ?? latestVersion?.keywords,
          engines: latestVersion?.engines,
          created: pkg.time.created,
          modified: pkg.time.modified,
          versionCount: Object.keys(pkg.versions).length,
        },
      };
    },
  },
  {
    name: "npm_version",
    description:
      "Get detailed metadata for a specific version — dependencies, dist info, file count, size, deprecation status.",
    annotations: {
      title: "Get version details",
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
      if (!res.ok) return translateError(res, { pkg: input.name, op: `version ${ver}` });

      const v = res.data!;
      return {
        ok: true,
        status: 200,
        data: {
          name: v.name,
          version: v.version,
          description: v.description,
          license: v.license,
          author: v.author,
          maintainers: v.maintainers,
          homepage: v.homepage,
          repository: v.repository,
          bugs: v.bugs,
          keywords: v.keywords,
          engines: v.engines,
          dependencies: v.dependencies ?? {},
          devDependencies: v.devDependencies ?? {},
          peerDependencies: v.peerDependencies ?? {},
          optionalDependencies: v.optionalDependencies ?? {},
          deprecated: v.deprecated ?? false,
          dist: {
            shasum: v.dist.shasum,
            integrity: v.dist.integrity,
            tarball: v.dist.tarball,
            fileCount: v.dist.fileCount,
            unpackedSize: v.dist.unpackedSize,
          },
          publisher: v._npmUser?.name,
        },
      };
    },
  },
  {
    name: "npm_versions",
    description:
      "List published versions of a package with their publish dates, ordered newest first. Returns up to `limit` versions (default 50). Set limit=0 to return all.",
    annotations: {
      title: "List versions",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      limit: z.number().min(0).optional().describe("Max versions to return, newest first (default 50, 0 = all)"),
    }),
    handler: async (input: { name: string; limit?: number }) => {
      const res = await registryGet<Packument>(`/${encPkg(input.name)}`);
      if (!res.ok) return translateError(res, { pkg: input.name, op: "versions" });

      const pkg = res.data!;
      const limit = input.limit ?? 50;
      const allVersions = Object.keys(pkg.versions)
        .map((v) => ({
          version: v,
          date: pkg.time[v],
          deprecated: pkg.versions[v].deprecated,
          npmUser: pkg.versions[v]._npmUser?.name,
        }))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      const versions = limit > 0 ? allVersions.slice(0, limit) : allVersions;

      return {
        ok: true,
        status: 200,
        data: {
          name: pkg.name,
          distTags: pkg["dist-tags"],
          total: allVersions.length,
          showing: versions.length,
          versions,
        },
      };
    },
  },
  {
    name: "npm_readme",
    description: "Get the README content of a package.",
    annotations: {
      title: "Get package README",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
    }),
    handler: async (input: { name: string }) => {
      const res = await registryGet<Packument>(`/${encPkg(input.name)}`);
      if (!res.ok) return translateError(res, { pkg: input.name, op: "readme" });

      const readme = res.data!.readme;
      if (!readme) {
        return { ok: true, status: 200, data: { name: input.name, readme: "(no readme available)" } };
      }

      return { ok: true, status: 200, data: { name: input.name, readme } };
    },
  },
  {
    name: "npm_dist_tags",
    description: "Get dist-tags for a package (latest, next, beta, etc).",
    annotations: {
      title: "Get dist-tags",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
    }),
    handler: async (input: { name: string }) => {
      const res = await registryGet<Record<string, string>>(`/-/package/${encPkg(input.name)}/dist-tags`);
      return res.ok ? res : translateError(res, { pkg: input.name, op: "dist_tags" });
    },
  },
  {
    name: "npm_types",
    description:
      "Check TypeScript type support for a package — whether it ships built-in types (types/typings field) or has a DefinitelyTyped companion (@types/* package).",
    annotations: {
      title: "Check TypeScript types",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name (e.g. 'express' or '@anthropic-ai/sdk')"),
      version: z.string().optional().describe("Semver version or dist-tag (default: 'latest')"),
    }),
    handler: async (input: { name: string; version?: string }) => {
      const ver = input.version ?? "latest";

      // Derive the @types package name:
      // "express" -> "@types/express"
      // "@scope/name" -> "@types/scope__name"
      let typesPackage: string;
      if (input.name.startsWith("@")) {
        const withoutAt = input.name.slice(1); // "scope/name"
        typesPackage = `@types/${withoutAt.replace("/", "__")}`;
      } else {
        typesPackage = `@types/${input.name}`;
      }

      // Check built-in types and @types/* in parallel
      const [versionRes, typesRes] = await Promise.all([
        registryGet<VersionDoc>(`/${encPkg(input.name)}/${ver}`),
        registryGet<Packument>(`/${encPkg(typesPackage)}`),
      ]);

      if (!versionRes.ok) return translateError(versionRes, { pkg: input.name, op: `types ${ver}` });

      const v = versionRes.data!;
      const hasBuiltinTypes = !!(v.types || v.typings);
      const typesEntry = hasBuiltinTypes ? (v.types ?? v.typings) : undefined;

      const hasTypesPackage = typesRes.ok;
      const typesPackageLatest = hasTypesPackage ? typesRes.data?.["dist-tags"]?.latest : undefined;

      let recommendation: string;
      if (hasBuiltinTypes) {
        recommendation = "Built-in types included — no additional install needed.";
      } else if (hasTypesPackage) {
        recommendation = `Install types separately: npm install -D ${typesPackage}`;
      } else {
        recommendation = "No TypeScript types available (built-in or @types).";
      }

      return {
        ok: true,
        status: 200,
        data: {
          name: v.name,
          version: v.version,
          builtinTypes: hasBuiltinTypes,
          typesEntry,
          typesPackage: hasTypesPackage ? { name: typesPackage, latest: typesPackageLatest } : null,
          recommendation,
        },
      };
    },
  },
] as const;
