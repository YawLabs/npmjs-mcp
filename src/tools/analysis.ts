import { z } from "zod";
import { type ApiResponse, downloadsGet, encPkg, registryGet, registryPost } from "../api.js";
import { translateError } from "../errors.js";
import type { Packument } from "../types.js";

interface DownloadPoint {
  downloads: number;
  start: string;
  end: string;
  package: string;
}

export const analysisTools = [
  {
    name: "npm_compare",
    description:
      "Compare 2-5 packages side-by-side — downloads, version, license, maintainers, size, last publish, and security status. Great for 'should I use X or Y?' decisions.",
    annotations: {
      title: "Compare packages",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      packages: z.array(z.string()).min(2).max(5).describe("Package names to compare"),
    }),
    handler: async (input: { packages: string[] }) => {
      const results = await Promise.all(
        input.packages.map(async (name) => {
          // Fetch packument and downloads in parallel first
          const [pkgRes, dlRes] = await Promise.all([
            registryGet<Packument>(`/${encPkg(name)}`),
            downloadsGet<DownloadPoint>(`/downloads/point/last-week/${encPkg(name)}`),
          ]);

          if (!pkgRes.ok) {
            return { name, error: pkgRes.error };
          }

          const pkg = pkgRes.data!;
          const latest = pkg["dist-tags"]?.latest;
          const latestVersion = latest ? pkg.versions[latest] : undefined;
          const versionKeys = Object.keys(pkg.versions);

          // Audit with the real resolved version (not "latest" dist-tag)
          let vulnerabilities = 0;
          if (latest) {
            const auditRes = await registryPost<Record<string, unknown[]>>("/-/npm/v1/security/advisories/bulk", {
              [name]: [latest],
            });
            if (auditRes.ok && auditRes.data?.[name]) {
              vulnerabilities = (auditRes.data[name] as unknown[]).length;
            }
          }

          return {
            name,
            description: pkg.description,
            latest,
            license: pkg.license ?? latestVersion?.license,
            maintainers: pkg.maintainers?.map((m) => m.name),
            weeklyDownloads: dlRes.ok ? dlRes.data!.downloads : null,
            versionCount: versionKeys.length,
            created: pkg.time.created,
            lastPublish: latest ? pkg.time[latest] : undefined,
            deprecated: latestVersion?.deprecated ?? false,
            hasReadme: !!(pkg.readme && pkg.readme.length > 0),
            repository: pkg.repository,
            homepage: pkg.homepage,
            vulnerabilities,
          };
        }),
      );

      return { ok: true, status: 200, data: { comparison: results } } as ApiResponse;
    },
  },
  {
    name: "npm_health",
    description:
      "Assess the health of a package — maintenance activity, download trend, security status, deprecation, and documentation quality.",
    annotations: {
      title: "Package health check",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
    }),
    handler: async (input: { name: string }) => {
      const [pkgRes, dlWeekRes, dlMonthRes] = await Promise.all([
        registryGet<Packument>(`/${encPkg(input.name)}`),
        downloadsGet<DownloadPoint>(`/downloads/point/last-week/${encPkg(input.name)}`),
        downloadsGet<DownloadPoint>(`/downloads/point/last-month/${encPkg(input.name)}`),
      ]);

      if (!pkgRes.ok) return translateError(pkgRes, { pkg: input.name, op: "health" });

      const pkg = pkgRes.data!;
      const latest = pkg["dist-tags"]?.latest;
      const latestVersion = latest ? pkg.versions[latest] : undefined;
      const versionKeys = Object.keys(pkg.versions);

      // Security check — audit the latest version
      let vulnerabilityCount: number | null = null;
      if (latest) {
        const auditRes = await registryPost<Record<string, unknown[]>>("/-/npm/v1/security/advisories/bulk", {
          [input.name]: [latest],
        });
        if (auditRes.ok) {
          const advisories = auditRes.data?.[input.name];
          vulnerabilityCount = Array.isArray(advisories) ? advisories.length : 0;
        }
      }

      // Calculate release cadence from the time object
      const publishDates = versionKeys
        .map((v) => pkg.time[v])
        .filter(Boolean)
        .map((d) => new Date(d).getTime())
        .sort((a, b) => b - a);

      const now = Date.now();
      const daysSinceLastPublish = publishDates.length > 0 ? Math.floor((now - publishDates[0]) / 86_400_000) : null;

      // Avg days between releases (last 10)
      const recentPublishes = publishDates.slice(0, 10);
      let avgDaysBetweenReleases: number | null = null;
      if (recentPublishes.length >= 2) {
        const gaps = [];
        for (let i = 0; i < recentPublishes.length - 1; i++) {
          gaps.push((recentPublishes[i] - recentPublishes[i + 1]) / 86_400_000);
        }
        avgDaysBetweenReleases = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
      }

      // Score components
      const hasLicense = !!(pkg.license ?? latestVersion?.license);
      const hasReadme = !!(pkg.readme && pkg.readme.length > 0);
      const hasRepo = !!pkg.repository;
      const hasHomepage = !!pkg.homepage;
      const isDeprecated = !!latestVersion?.deprecated;
      const isStale = daysSinceLastPublish !== null && daysSinceLastPublish > 365;

      return {
        ok: true,
        status: 200,
        data: {
          name: pkg.name,
          latest,
          signals: {
            weeklyDownloads: dlWeekRes.ok ? dlWeekRes.data!.downloads : null,
            monthlyDownloads: dlMonthRes.ok ? dlMonthRes.data!.downloads : null,
            maintainerCount: pkg.maintainers?.length ?? 0,
            versionCount: versionKeys.length,
            daysSinceLastPublish,
            avgDaysBetweenReleases,
            vulnerabilityCount,
            hasLicense,
            hasReadme,
            hasRepo,
            hasHomepage,
            isDeprecated,
            isStale,
          },
          assessment: isDeprecated
            ? "DEPRECATED"
            : isStale
              ? "STALE"
              : daysSinceLastPublish !== null && daysSinceLastPublish < 90
                ? "ACTIVE"
                : "MAINTENANCE",
        },
      } as ApiResponse;
    },
  },
  {
    name: "npm_maintainers",
    description: "Get current maintainers and their publish history for a package.",
    annotations: {
      title: "Package maintainers",
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
      if (!res.ok) return translateError(res, { pkg: input.name, op: "maintainers" });

      const pkg = res.data!;

      // Build per-maintainer publish counts
      const publishCounts: Record<string, number> = {};
      for (const ver of Object.values(pkg.versions)) {
        const publisher = ver._npmUser?.name;
        if (publisher) {
          publishCounts[publisher] = (publishCounts[publisher] ?? 0) + 1;
        }
      }

      return {
        ok: true,
        status: 200,
        data: {
          name: pkg.name,
          maintainers: pkg.maintainers,
          publishHistory: Object.entries(publishCounts)
            .map(([name, count]) => ({ name, versionsPublished: count }))
            .sort((a, b) => b.versionsPublished - a.versionsPublished),
        },
      } as ApiResponse;
    },
  },
  {
    name: "npm_release_frequency",
    description:
      "Analyze the release cadence of a package — publish timeline, gaps, and whether the project is actively maintained.",
    annotations: {
      title: "Release frequency",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("Package name"),
      limit: z.number().min(1).max(100).optional().describe("Number of recent releases to analyze (default 20)"),
    }),
    handler: async (input: { name: string; limit?: number }) => {
      const res = await registryGet<Packument>(`/${encPkg(input.name)}`);
      if (!res.ok) return translateError(res, { pkg: input.name, op: "release_frequency" });

      const pkg = res.data!;
      const limit = input.limit ?? 20;

      const releases = Object.keys(pkg.versions)
        .map((v) => ({ version: v, date: pkg.time[v] }))
        .filter((r) => r.date)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, limit);

      // Calculate gaps
      const gaps: Array<{ from: string; to: string; days: number }> = [];
      for (let i = 0; i < releases.length - 1; i++) {
        const days = Math.round(
          (new Date(releases[i].date).getTime() - new Date(releases[i + 1].date).getTime()) / 86_400_000,
        );
        gaps.push({ from: releases[i + 1].version, to: releases[i].version, days });
      }

      const avgGap = gaps.length > 0 ? Math.round(gaps.reduce((a, b) => a + b.days, 0) / gaps.length) : null;
      const maxGap = gaps.length > 0 ? gaps.reduce((a, b) => (a.days > b.days ? a : b)) : null;

      return {
        ok: true,
        status: 200,
        data: {
          name: pkg.name,
          totalVersions: Object.keys(pkg.versions).length,
          analyzed: releases.length,
          created: pkg.time.created,
          lastPublish: releases[0]?.date,
          avgDaysBetweenReleases: avgGap,
          longestGap: maxGap,
          recentReleases: releases,
        },
      } as ApiResponse;
    },
  },
] as const;
