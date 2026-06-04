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
      // Step 1: fetch packument + downloads per package in parallel.
      const partials = await Promise.all(
        input.packages.map(async (name) => {
          const [pkgRes, dlRes] = await Promise.all([
            registryGet<Packument>(`/${encPkg(name)}`),
            downloadsGet<DownloadPoint>(`/downloads/point/last-week/${encPkg(name)}`),
          ]);
          return { name, pkgRes, dlRes };
        }),
      );

      // Step 2: one batched audit POST for every resolvable package — replaces
      // N per-package POSTs to the same endpoint. The advisory map is keyed by
      // name, so the registry returns per-package advisory lists in one round-trip.
      // `auditSucceeded` distinguishes "bulk POST returned data" from "POST failed",
      // so per-package rows can report auditReliable accurately rather than silently
      // reporting zero vulnerabilities on a 5xx.
      const auditMap: Record<string, string[]> = {};
      for (const { name, pkgRes } of partials) {
        if (!pkgRes.ok) continue;
        const latest = pkgRes.data!["dist-tags"]?.latest;
        if (latest) auditMap[name] = [latest];
      }
      let auditData: Record<string, unknown[]> = {};
      let auditSucceeded = false;
      if (Object.keys(auditMap).length > 0) {
        const auditRes = await registryPost<Record<string, unknown[]>>("/-/npm/v1/security/advisories/bulk", auditMap);
        if (auditRes.ok && auditRes.data) {
          auditData = auditRes.data;
          auditSucceeded = true;
        }
      }

      // Step 3: assemble per-package rows. Per-package failures route through
      // translateError so the error shape matches the rest of the codebase
      // (raw passthrough used to diverge from npm_health).
      //
      // `auditReliable` is load-bearing below: when false, `vulnerabilities`
      // is `null`, not `0` -- a transient 5xx on the bulk audit endpoint
      // must not silently report "clean" for every row. Consumers that only
      // check `vulnerabilities > 0` get the right answer; the `auditReliable`
      // field is the escape hatch for callers that need to distinguish
      // "clean" from "not audited". Pinned by handlers.test.ts case
      // "npm_compare reports auditReliable=false and vulnerabilities=null on
      // every row when the bulk audit 5xx's".
      const results = partials.map(({ name, pkgRes, dlRes }) => {
        if (!pkgRes.ok) {
          const translated = translateError(pkgRes, { pkg: name, op: "compare" });
          return { name, error: translated.error };
        }

        const pkg = pkgRes.data!;
        const latest = pkg["dist-tags"]?.latest;
        const latestVersion = latest ? pkg.versions[latest] : undefined;
        const versionKeys = Object.keys(pkg.versions);
        // `auditReliable` is true iff the bulk POST returned for this package's
        // latest version. When false, `vulnerabilities` is null rather than 0 —
        // a 5xx on the bulk endpoint must not silently report "clean" for every
        // row. Packages without a `latest` (so they were never in auditMap) also
        // get auditReliable=false; nothing to audit.
        const wasAudited = auditSucceeded && name in auditMap;
        const advisories = auditData[name];
        const vulnerabilities = wasAudited ? (Array.isArray(advisories) ? advisories.length : 0) : null;

        return {
          name,
          description: pkg.description,
          latest,
          license: pkg.license ?? latestVersion?.license,
          maintainers: pkg.maintainers?.map((m) => m.name),
          // Guard on data presence, not just .ok: a 2xx with an empty body yields
          // ok:true with no data (api.ts), and dlRes.data!.downloads would throw
          // and crash the whole compare. Degrade to null instead.
          weeklyDownloads: dlRes.ok && dlRes.data ? dlRes.data.downloads : null,
          versionCount: versionKeys.length,
          created: pkg.time.created,
          lastPublish: latest ? pkg.time[latest] : undefined,
          deprecated: latestVersion?.deprecated ?? false,
          hasReadme: !!(pkg.readme && pkg.readme.length > 0),
          repository: pkg.repository,
          homepage: pkg.homepage,
          vulnerabilities,
          auditReliable: wasAudited,
        };
      });

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

      // Security check — audit the latest version. `auditReliable` distinguishes
      // "audit returned zero advisories" from "audit failed to return". Without
      // it, a transient 5xx silently downgrades the assessment from VULNERABLE
      // to ACTIVE/MAINTENANCE — callers couldn't tell a clean run from a missing run.
      let vulnerabilityCount: number | null = null;
      let auditReliable = true;
      if (latest) {
        const auditRes = await registryPost<Record<string, unknown[]>>("/-/npm/v1/security/advisories/bulk", {
          [input.name]: [latest],
        });
        if (auditRes.ok) {
          const advisories = auditRes.data?.[input.name];
          vulnerabilityCount = Array.isArray(advisories) ? advisories.length : 0;
        } else {
          auditReliable = false;
        }
      } else {
        // No `latest` to audit. Not an audit failure per se — just nothing to check.
        auditReliable = false;
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
            // Guard on data presence, not just .ok: an empty-body 2xx yields
            // ok:true with no data (api.ts); degrade to null rather than throw.
            weeklyDownloads: dlWeekRes.ok && dlWeekRes.data ? dlWeekRes.data.downloads : null,
            monthlyDownloads: dlMonthRes.ok && dlMonthRes.data ? dlMonthRes.data.downloads : null,
            maintainerCount: pkg.maintainers?.length ?? 0,
            versionCount: versionKeys.length,
            daysSinceLastPublish,
            avgDaysBetweenReleases,
            vulnerabilityCount,
            auditReliable,
            hasLicense,
            hasReadme,
            hasRepo,
            hasHomepage,
            isDeprecated,
            isStale,
          },
          // Holistic single-string verdict layered priority-first: a deprecated
          // package supersedes everything (don't use it), a vulnerable package
          // supersedes maintenance signals (active development doesn't undo a
          // CVE), then AUDIT_UNKNOWN when we couldn't verify vuln status (a 5xx
          // on the audit endpoint or a packument with no `latest` to audit) --
          // better to flag the unknown than confidently report ACTIVE on
          // unverified data. Then staleness, recency, and the catch-all.
          assessment: isDeprecated
            ? "DEPRECATED"
            : vulnerabilityCount !== null && vulnerabilityCount > 0
              ? "VULNERABLE"
              : !auditReliable
                ? "AUDIT_UNKNOWN"
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
