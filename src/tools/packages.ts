import { z } from "zod";
import { encPkg, registryGet } from "../api.js";

interface Packument {
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

interface VersionDoc {
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
  _npmUser?: { name: string; email?: string };
}

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
      if (!res.ok) return res;

      const pkg = res.data!;
      const latest = pkg["dist-tags"].latest;
      const latestVersion = pkg.versions[latest];

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
      return registryGet<VersionDoc>(`/${encPkg(input.name)}/${ver}`);
    },
  },
  {
    name: "npm_versions",
    description: "List all published versions of a package with their publish dates, ordered newest first.",
    annotations: {
      title: "List versions",
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
      if (!res.ok) return res;

      const pkg = res.data!;
      const versions = Object.keys(pkg.versions)
        .map((v) => ({
          version: v,
          date: pkg.time[v],
          deprecated: pkg.versions[v].deprecated,
          npmUser: pkg.versions[v]._npmUser?.name,
        }))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      return {
        ok: true,
        status: 200,
        data: {
          name: pkg.name,
          distTags: pkg["dist-tags"],
          total: versions.length,
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
      if (!res.ok) return res;

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
      return registryGet<Record<string, string>>(`/-/package/${encPkg(input.name)}/dist-tags`);
    },
  },
] as const;
