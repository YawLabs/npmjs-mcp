# Changelog

All notable changes to `@yawlabs/npmjs-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.10] -- 2026-05-19

### Fixed
- `versionsSatisfying(versions, "1.2.3")` now matches the exact version. `parseSingleConstraint` previously returned `null` for bare `N.N.N` strings (leaning on a fast path in `maxSatisfying`), which left `versionsSatisfying` returning `[]` and silently broke `npm_deprecate(versionRange: "1.2.3")` -- the tool reported "No versions match range '1.2.3'" even when 1.2.3 was published. Bare exact versions now compile to the same range shape as `=N.N.N`.
- `npm_dep_tree` marks a dep `failed: true` when no version satisfies the requested range AND there is no `dist-tags.latest` to fall back on. Previously the unresolved node was emitted as a fake resolved entry whose `version` field held the range string and `dependencies` was `{}`, silently inflating `totalPackages` and hiding the failure from `unresolvedCount`.

### Added
- `npm_health` `signals.auditReliable` distinguishes "audit returned zero advisories" from "audit failed to return". A transient 5xx on `/security/advisories/bulk` (or a packument with no `dist-tags.latest` to audit) used to silently downgrade the assessment from `VULNERABLE` to `ACTIVE`/`MAINTENANCE` -- callers can now read the field to tell clean from missing. The headline `assessment` string still routes through `vulnerabilityCount`; consumers that care about audit reliability should read the signal explicitly.

### Changed
- `npm_compare` collapses N per-package audit POSTs into one batched POST to `/-/npm/v1/security/advisories/bulk` keyed by every package name. Per-package failures now route through `translateError` to match the error shape used by `npm_health` and the rest of the codebase; raw error passthrough is gone.

### Documentation
- `npm_unpublish_version` description spells out the dist-tag handling asymmetry: tags pointing at the unpublished version are removed; only `latest` is auto-reassigned (to the highest remaining stable version). Other tags like `next`/`beta` are left unset and must be reassigned explicitly with `npm_dist_tag_set`.

### Tests
- 25 new cases (698 -> 723) covering: bare-exact-version match in `versionsSatisfying` (plus prerelease exclusion), `npm_compare` one-POST batched audit + per-package vuln attribution + sibling survival on packument failure + `translateError` shape + `weeklyDownloads: null` on downloads failure, `npm_health` `auditReliable` true/false branches (including the no-`latest` case), `npm_dep_tree` resolve-failure failed-true marker, `npm_provenance` `+` build-metadata version encoding, debug logging Authorization redaction, `createLimiter` active-cap + FIFO ordering, `hooks.classifyHookTarget` bare unscoped name, `npm_types` legacy `typings` fallback + "no types available" recommendation, `npm_license_check` FETCH_ERROR vs UNKNOWN, `npm_trusted_publishers` GitLab + CircleCI claim parsing, `npm_package_access` partial result when one of `/access` or `/collaborators` fails, `npm_check_auth` `ifPublishFails` hand-off structure under 2FA, and `npm_publish_preflight` maintainer-access pass/fail branches.

## [0.11.9] -- 2026-05-16

### Changed
- Release process: `release.sh` now sources release notes from the `## [VERSION]` section of `CHANGELOG.md` when present, so the GitHub release page mirrors the project narrative (Fixed / Added / Changed / Documentation) instead of two raw commit subjects. Falls back to the prior git-log-derived bullets when no CHANGELOG entry exists for the version. No changes to the published npm package itself.

## [0.11.8] -- 2026-05-16

### Fixed
- `npm_verify_token` now honors `tfa.pending` -- enabled iff `tfa && !pending`. Previously the handler reported `enabled: true` while enrollment was still pending, while `npm_profile` and `npm_check_auth` (both fixed earlier) treated pending as disabled. Three tools reading the same token's 2FA state now agree.

### Added
- `npm_health` assessment gains a `VULNERABLE` state, layered between `DEPRECATED` and `STALE` so an active package with open CVEs is no longer reported as `ACTIVE`.
- Boot-time duplicate-tool-name guard. A rename refactor that lands a name collision now fails at startup with the offending name instead of being silently overridden by `server.tool()`.

### Changed
- `npm_license_check` matches SPDX identifiers case-insensitively (so `mit` and `MIT` resolve to the same entry). The original-case `allowed` list is still echoed back to the caller. The tool description now documents that SPDX expressions like `(MIT OR Apache-2.0)` require verbatim allow-list entries.

### Documentation
- `npm_deprecate` `versionRange` description warns that bare integers are x-ranges (e.g. `'0'` means `'0.x.x'`, not exact version 0). `'=1.2.3'` shown as the exact-version form.
- `compileRange` carries an inline note on the first-match prerelease-anchor heuristic and the range shapes that would require a fuller comparator parser.

## [0.11.6] — 2026-05-13

### Documentation
- README: tool count corrected from 63 to 64 (headline, "Why this one?" bullet, and section header all reflect the actual count from `tools.test.ts`).
- README: "Access & orgs" section was missing `npm_team_members` -- row added and the section count updated from 6 to 7.
- README: Requirements lifted from "Node.js 18+" to "Node.js 20+" to match `package.json` (`engines.node: ">=20"`) and the CI matrix (20 + 22 only).
- README: `npm_compare` example used `{ names: [...] }`; the actual schema is `{ packages: [...] }`. Copy-paste from the README would have failed Zod validation.

No code changes. Doc-only release so the npm page reflects the corrected README.

## [0.11.5] — 2026-05-13

### Fixed
- `npm_dep_tree` no longer double-counts a failed transitive when two parents reference it via different ranges. Previously the same packument was fetched twice in parallel, two warnings were pushed, two placeholder entries landed under different hintKeys, and `unresolvedCount` reported 2 for one underlying failure. The cache now stores the in-flight Promise so concurrent callers share a single round-trip, and a sibling `failedPackages` set gates the placeholder write to exactly one entry per failed name.
- The same change dedupes successful fetches. A shared transitive (e.g. `react`, `express`) referenced by multiple parents now triggers one network round-trip instead of N -- the cache used to populate only after the await, so concurrent callers all missed and all fired duplicate requests.

## [0.11.4] — 2026-05-13

### Fixed
- `npm_profile` `tfa.enabled` now mirrors `npm_check_auth` -- enabled iff `tfa && !pending`. Previously the two tools could disagree about the same token's 2FA state (npm_profile reported `enabled: true` while enrollment was still pending; npm_check_auth treated pending as disabled). Pending state preserved as an explicit field.
- `npm_dep_tree` failed transitive fetches now carry `failed: true` on their tree entry. `totalPackages` counts only resolved nodes; a new `unresolvedCount` surfaces failures separately. Previously failed entries were keyed by the requested range string and silently inflated `totalPackages`.
- `npm_unpublish_version` guards against the registry returning a packument with no `dist-tags` object before reassigning `latest`. The deletion loop above already tolerated it via `|| {}`; the assignment now mirrors that.
- `npm_hook_add` validates the hook target after classification. `~@scope/pkg`, `@.bad`, `bad\nname`, and similar shapes now reject upfront with an actionable 400 instead of being POSTed and opaquely rejected by the registry.

### Changed
- `npm_ops_playbook` publish guidance updated. The misleading `neverRunLocally: true` is gone; the playbook now describes both CI tag-push (preferred) and local `release.sh` as valid publish paths, since some YawLabs repos rely on the local flow.
- `versionsSatisfying(versions, range)` now exported from `api.ts`. Replaces `versionsMatchingRange(versions, range, maxSatisfying)` (removed from `errors.ts`), which re-parsed the range once per version. Same observable behavior at the MCP tool surface; cheaper for large packuments.
- `release.sh` Step 7 npm-view verify now retries up to 5 times with 5s spacing instead of a single 3s sleep, matching the CI smoke test pattern. Still warn-only on final failure.

### Security
- Dev dependencies: `fast-uri` 3.1.0 → 3.1.2 (fixes GHSA-q3j6-qgpj-74h6, GHSA-v39h-62p7-jpjc -- both high); `hono` 4.12.14 → 4.12.18 (fixes GHSA-69xw-7hcm-h432, GHSA-p77w-8qqv-26rm, GHSA-qp7p-654g-cw7p, GHSA-hm8q-7f3q-5f36 -- 3 medium + 1 low). Not reachable from the published bundle, but the SCA tooling was flagging them.

### Other
- `@biomejs/biome` 2.4.12 → 2.4.14 and `zod` patched via Dependabot.

## [0.11.2] — 2026-05-04

### Fixed
- `highestVersion` (used by `npm_unpublish_version` to recompute `dist-tags.latest` after removing the version `latest` pointed at) no longer treats prereleases as candidates. Previously the unanchored regex matched `1.0.0-beta.1` as `[1,0,0]` and returned the prerelease string. Now prereleases are excluded; if no stable version remains, `latest` is left unset rather than pointing at a prerelease.
- `maxSatisfying` prerelease anchoring tightened to match npm semver: a range like `^1.0.0-beta` now only allows prereleases of `1.0.0`, not arbitrary prereleases such as `1.5.0-alpha.1`.
- `npm_publish_preflight` now emits a `warn` check (instead of silently dropping the entry) when the packument fetch returns a status other than 200 or 404.
- `npm_versions` filters out versions missing a `pkg.time[v]` entry before sorting (matches the defensive pattern already used by `npm_release_frequency`). The `total` field still reports the raw published-version count so the meaning doesn't shift.

### Changed
- `npm_hook_add` and `npm_hook_update` now reject `http://` endpoints at the schema layer. HMAC integrity does not protect payload confidentiality, and webhook events leak package metadata over plain HTTP.
- `npm_unpublish_version` response now includes a `complete: boolean` field. When the packument PUT succeeds but the tarball DELETE fails the version is unreachable via the listing but the tarball file remains fetchable at the CDN URL until the registry GCs it -- callers can detect this without parsing `tarballWarning`.
- `Packument` type consolidated -- `_rev`, `_revisions`, and `_attachments` moved from a duplicate definition in `writes.ts` onto the canonical type in `types.ts` as optional fields.

## [0.11.1] — 2026-04-24

### Fixed
- `maxSatisfying` no longer leaks prereleases into hyphen ranges. The prerelease filter used to check `sub.includes("-")`, which matched the hyphen-range separator (`1.0.0 - 2.0.0`) and let `2.0.0-beta.1` through. Replaced with a prerelease-tag regex (`/\d+\.\d+\.\d+-/`) that only matches a dash attached to a version.
- `npm_downloads_bulk` now returns a 400 with an actionable message when any scoped package is passed. The downloads bulk endpoint silently 404s on scoped names; previously that surfaced as a confusing "Not found".
- `npm_org_member_set` no longer echoes `role: undefined` in the response when the caller omitted `role`. The field is now simply absent, matching the documented "omit role to keep existing role" semantics.

### Changed
- Identifier validation extended to the four remaining orgs.ts read-only tools (`npm_org_members`, `npm_org_packages`, `npm_org_teams`, `npm_team_packages`). Malformed `org`/`team` now returns a 400 client-side instead of hitting the registry and producing an opaque 404. Matches the pattern already used by `npm_team_members`.
- Dist-tag names are now validated before `npm_dist_tag_set` / `npm_dist_tag_remove` build the URL. Empty or malformed tags return a 400 immediately (new `validateTag` / `encTag` helpers).

## [0.11.0] — 2026-04-20

### Changed
- Dev dependencies upgraded: Biome 1.9.4 → 2.4.12, TypeScript 5.9.3 → 6.0.3, Zod 3.25.76 → 4.3.6, @types/node 22 → 25. Biome config migrated to v2 schema (`organizeImports` moved under `assist.actions.source`, `files.ignore` → `files.includes`). `tsconfig.json` now sets `types: ["node"]` explicitly (TS 6 no longer auto-includes ambient node types). `z.record()` calls updated to the Zod 4 two-argument form.
- Upgraded CI actions: `actions/checkout@v4` → `v6`, `actions/setup-node@v4` → `v6`.
- Dependabot config restricted to minor/patch grouping so future major dev-dep bumps arrive as individual PRs.

### Fixed
- Release workflow's post-publish smoke test now runs `npx` from `runner.temp` instead of the checkout root, avoiding a false negative where npx resolved the repo's own `bin` entry instead of installing the published tarball.
- Windows CI parity: added `.gitattributes` to force LF line endings so Biome's format check passes identically on Ubuntu and Windows, and switched the `test` script to an explicit file list (PowerShell doesn't expand `dist/**/*.test.js` and Node <22's `--test` doesn't glob either).

## [0.10.0] — 2026-04-20

### Added
- Alternate registry support via `NPM_REGISTRY` env var (defaults to `https://registry.npmjs.org`).
- Per-request timeout via `NPM_REQUEST_TIMEOUT_MS` (default 30000).
- Automatic retry with exponential backoff on 429/502/503/504 and network errors (up to 2 retries, honors `Retry-After`).
- Opt-in request tracing via `DEBUG=npmjs-mcp` (emits one-line method/URL/status/elapsed traces to stderr; tokens never logged).
- Identifier validators for scopes, usernames, and team names — malformed input now returns an actionable 400 instead of an opaque 404.
- `confirm: true` gates on `npm_token_revoke`, `npm_team_delete`, and `npm_org_member_remove` (matching the existing gates on the unpublish tools).
- Hook responses now recursively strip any `secret` fields before returning, so HMAC secrets can never leak into tool output.
- Windows added to the CI matrix (now running Ubuntu + Windows × Node 18/20/22).
- Post-publish smoke test in the release workflow — installs the freshly published tarball and verifies `--version`.
- Provenance attestation check in `release.sh` step 7.
- `CHANGELOG.md` (this file).
- `.github/dependabot.yml` for weekly npm + GitHub Actions updates.

### Changed
- **BREAKING**: Removed the `force` parameter from `npm_deprecate`. The period-then-capital message-format check it was bypassing was removed in this release (see below), so the escape hatch no longer serves a purpose.
- `validateDeprecationMessage` no longer flags the "period + space + capital letter" pattern. The single 422 that originally motivated the check was later diagnosed (issue #2) as a wildcard-version/range mismatch, not a message-format issue. The pattern check produced too many false positives.
- `parseTeamTarget` now returns a discriminated union `{scope, team} | {error}` and validates each half against the identifier rules before returning.

### Security
- All registry URL components (scopes, teams, usernames) flow through validating encoders that reject CRLF, path-traversal, and empty idents before building request URLs.

## [0.9.0] — 2026-04-19

### Added
- Reddit-ready README with mcp.hosting install button and shields.io badges.

## [0.8.0] — 2026-04-18

### Added
- Expanded test coverage for semver resolution, input validation, `dep_tree`, and `recent_changes`.

### Changed
- Release workflow: lint/build/test now surface as discrete GitHub Actions steps for clearer failure attribution.

### Fixed
- Provenance output encoding for sigstore attestation payloads.
- Package name validation applied consistently across tool boundaries.
- Error translation now routed through a single path so 401/403/404/422 messages stay consistent.

## [0.7.0] — 2026-04-17

### Added
- Expanded write and hook tool surface.

### Fixed
- `npm_unpublish_version` packument-mutation flow (dist-tag cleanup, `_rev` handling, tarball DELETE).
- `npm_owner_add` / `npm_owner_remove` write paths.

## [0.6.0] — 2026-04-16

### Added
- Write-op tools: `npm_deprecate`, `npm_undeprecate`, `npm_unpublish_version`, `npm_unpublish_package`, `npm_dist_tag_set`, `npm_dist_tag_remove`, `npm_owner_add`, `npm_owner_remove`, `npm_team_*`, `npm_org_member_*`, `npm_token_revoke`.
- `npm_verify_token` and `npm_ops_playbook` diagnostic tools.
- Error translator that turns opaque 401/403/404/422 registry responses into actionable messages with remediation hints.

_Closes #1._

## [0.5.0]

### Changed
- Consolidated shared types; extracted the concurrency limiter into a reusable helper.
- Improved semver range resolution (hyphen ranges, compound comparators, `||` unions).

### Fixed
- README accuracy.

## [0.4.0]

### Added
- New read-side tools expanding npm registry coverage.

### Fixed
- Bug fixes across existing tools.
- Removed endpoints that had been silently deprecated upstream.

## [0.3.0]

### Added
- Handler-level tests covering all tool surfaces.

### Fixed
- Remaining review issues from 0.2.0.

## [0.2.0]

### Added
- 13 authenticated tools spanning auth, orgs, access, provenance, hooks, and publish preflight.
- `LICENSE` and full `README.md`.

### Fixed
- Null guards, input validation, and `dep_tree` concurrency bounds flagged during review.

## [0.1.0]

### Added
- Initial release — 22 tools for npm registry intelligence (read-side).
- Tool definition tests.

[Unreleased]: https://github.com/YawLabs/npmjs-mcp/compare/v0.11.2...HEAD
[0.11.2]: https://github.com/YawLabs/npmjs-mcp/compare/v0.11.1...v0.11.2
[0.9.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/YawLabs/npmjs-mcp/releases/tag/v0.1.0
