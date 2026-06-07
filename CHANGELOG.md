# Changelog

All notable changes to `@yawlabs/npmjs-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.12.1] -- 2026-06-07

Hardening pass over the tool surface from a full-pass review: input validation on the write/bulk handlers, output-contract fixes, and test-suite robustness.

### Fixed
- `npm_dist_tag_set` pre-flights the packument and returns a 404 (with the published-version list) when the target version does not exist, instead of PUTting a tag at a nonexistent version. It was the only write handler that skipped the packument pre-flight.
- `npm_token_revoke` validates the token key (rejects empty/malformed) before the DELETE, so passing the token value instead of its UUID key no longer silently targets the wrong resource.
- `npm_team_grant` / `npm_team_revoke` validate the `package` field before building the request -- previously the only package-accepting handlers with no validation guard in the call path.
- `npm_downloads_bulk` and `npm_compare` validate every package name up front and return a clean 400 naming the offender, instead of throwing inside `encPkg` and surfacing a raw error at the MCP boundary.
- `npm_owner_remove` matches usernames case-insensitively; a caller passing `Bob` against a stored `bob` no longer gets a misleading 404.
- The packument GET-mutate-PUT flows (`npm_deprecate`, `npm_undeprecate`, `npm_owner_add`, `npm_owner_remove`) retry once on a 409 `_rev` conflict (CouchDB optimistic-concurrency), so a concurrent write no longer hard-fails a retryable conflict.
- `npm_unpublish_version` skips the tarball DELETE when the tarball origin does not match the configured registry origin, instead of misrouting the DELETE to the wrong host under proxy registries (Verdaccio/Nexus in proxy mode).
- `npm_check_auth` / `npm_publish_preflight` report a distinct `fetch-failed` 2FA state when the profile fetch fails, instead of rendering "2FA is enabled (unknown)" -- which implied confirmed 2FA when the real cause was a token lacking read on `/-/npm/v1/user`.
- `npm_provenance` rejects an empty/whitespace version with a 400 before the registry call.
- `npm_package_access` surfaces both endpoint errors when `/access` and `/collaborators` both fail, instead of reporting only the collaborators error and hiding the real root cause.
- `npm_health` stays well-defined for a partially-written packument (`dist-tags.latest` present but its version doc absent).
- `build.mjs` guards the `package.json` read with an actionable error instead of an unhandled exception.

### Changed
- `npm_recent_changes`: the `totalPackages` response field is renamed to `registryPackageCount`. It holds the registry-wide doc count (~3M from `replicate.npmjs.com`), not the per-call `changes.length`, and the old name read as if it were a per-call count. **Consumers reading `totalPackages` must update to `registryPackageCount`.**
- `npm_recent_changes`: the `idempotentHint` annotation is corrected to `false` -- it serves a live changes feed, so MCP clients must not cache or de-duplicate repeated calls.
- `npm_access_set`: `access: "private"` now maps to the registry wire value `"restricted"` rather than being passed through verbatim (the registry uses `public`/`restricted`).
- `npm_provenance`: predicate-type detection tightened from substring to prefix match, and the description reworded to make clear the tool **retrieves** attestations -- it does not cryptographically verify signatures, certificate chains, or Rekor entries.
- `npm_org_member_set` now requires `confirm: true`, matching `npm_org_member_remove`.
- `npm_compare` / `npm_health` carry the deprecation message string when a package is deprecated, instead of collapsing it to a boolean.
- `npm_trusted_publishers` tolerates a string-or-object `workflow_ref` / `ci_config_ref_uri`, surfacing the raw string instead of silently yielding `undefined`.

### Added
- `npm_tokens` surfaces each token's `type` and `automation` flag, so callers can distinguish automation tokens (which bypass 2FA) from granular/legacy ones -- the distinction the tool description already promised.
- `npm_check_auth` / `npm_publish_preflight` fire their independent auth reads (whoami / profile / tokens) concurrently rather than serially.

### Documentation
- Description fixes: `npm_deprecate` empty-message wording, enumerated download `period` values, consistent org-name `@`-prefix wording, `npm_dep_tree` depth semantics (depth counts the root), and named staleness constants in `npm_health`.
- ASCII-normalized the `missing _rev` error strings (were a mix of em-dash and `--`).

### Tests
- `mockFetchSequence` throws on over-run instead of silently replaying the last canned response, which had masked spurious extra-request regressions across the write suite. Tightened write/semver assertions, derived the total tool-count check from the per-module sums, and added an `npm_token_revoke` malformed-key negative test. 739 passing.
- Internal: `Packument` `dist-tags` / `maintainers` typed optional to match the defensive runtime guards.

## [0.12.0] -- 2026-06-04

### Fixed
- `errors.translateError` now covers HTTP 409 (version conflict, e.g. concurrent publish/deprecate racing the `_rev`) and 5xx (registry outage). Both statuses previously fell through to the raw passthrough, surfacing opaque `Raw: <body>` to callers. The 409 case names the re-run behavior (each write re-fetches the current `_rev`).
- `access` handlers tolerate `ok:true` with no data in collaborators/team responses. The `api.ts` empty-body short-circuit returns `ok:true` with no data on 2xx-with-no-content, so `res.data!.members` would have thrown on the next access. Mirrors the `res.data ?? {}` pattern already used in tokens, search, and `recent_changes`.
- `provenance` handler reads `res.data?.attestations ?? []` instead of `res.data!.attestations`. Same empty-body guard.
- `npm_verify_token` distinguishes "token valid, 2FA state unknown" (profile fetch failed) from "token valid, 2FA disabled". Previously the tool reported `enabled:false` on a 5xx from `/-/npm/v1/user`, telling the caller "no 2FA" when the truth was "we couldn't read it" -- the exact misleading signal this tool exists to prevent. The `unknown` shape includes a `warning` field naming the failed call and its HTTP status.

### Documentation
- `npm_team_delete` description calls out the cascade explicitly (team memberships removed, all package grants revoked) and points at `npm_team_packages` as the pre-check. Matches the wording already in `npm_org_member_remove`.
- `npm_compare` carries an inline comment above the per-package row assembly naming `auditReliable` as load-bearing. When `auditReliable: false`, `vulnerabilities` is `null`, not `0` -- a 5xx on the bulk audit endpoint must not silently report "clean" for every row. Test pinning this lives at `handlers.test.ts:1068-1122`.
- `npm_recent_changes.totalPackages` carries a comment clarifying that it is the registry-wide doc count from `replicate.npmjs.com` (the entire npm registry, ~3M), NOT the per-call `changes.length`. Field name reads as if it were a per-call count; the comment pins the semantic.

### Changed
- `search.npm_search` rejects empty/whitespace-only queries with a 400 before the registry round-trip. The registry returns `total: 0` on `text=` which silently masks caller bugs like `query: ""`. Error string names the expected input shape.
- `tsconfig.json` module + moduleResolution flipped from `Node16` to `NodeNext`. Forward-compat with the ESM-first posture already declared in `package.json` (`type: "module"`, `.js` extensions on imports). Build, typecheck, and full test suite (736/736) all pass under NodeNext.

## [0.11.13] -- 2026-05-22

### Fixed
- `npm_deprecate` / `npm_undeprecate` now PUT to `/{pkg}/-rev/{_rev}` with couch metadata (`_attachments`, `_revisions`) stripped, matching the `npm_unpublish_version` flow. Previously the handlers PUT the whole packument back to `/{pkg}` without the rev segment -- the lone outlier across the write tools. The registry tolerated the echo, but the call shape was a silent regression risk if npm tightens optimistic-concurrency on the deprecate endpoint.
- `npm_publish_preflight` no longer reports `READY to publish` / `canPublishHeadless: true` when 2FA is disabled but the account holds only readonly tokens. The token-inventory check now runs regardless of 2FA state and adds a `Token capability fail` entry in the 2FA-off + zero-RW-tokens case.
- `api.ts` request loop no longer retries a successful 2xx with chunked transfer-encoding and an empty body. The empty body previously threw inside `res.json()` and was caught as a network error, triggering a redundant retry of a request the server already handled.
- `npm_types` validates the source package name up front so a malformed name returns a clean 400 instead of throwing inside `encPkg` during the parallel-fetch block.
- `hooks.validateHookTarget` intercepts bare `~` and `@` sigils with a message naming what is missing (`Hook target '~' is missing the username (use '~your-username')`, `Hook target '@' is missing the scope (use '@scope' or '@scope/pkg')`), instead of the post-classify composite (`Invalid hook target '~': Username is empty`).

### Documentation
- `registryDeleteAuth` carries a comment on the DELETE-with-body footgun used by `npm_team_revoke` and `npm_team_member_remove`. The npm registry tolerates the shape today but the request only works when no HTTP intermediary sits in the path -- corporate proxies, some CDNs, and certain service-mesh sidecars strip DELETE request bodies.
- `npm_dist_tag_set` comment matches the actual body shape. The prior wording (`wrapped as a JSON string body`) implied an extra JSON-wrap layer that wasn't in the code; the registry expects the version string passed through `registryPutAuth`'s `JSON.stringify` to land as `"1.2.3"` on the wire, which is what the existing code already does.

## [0.11.12] -- 2026-05-19

### Fixed
- `npm_compare` no longer silently reports `vulnerabilities: 0` for every compared package when the bulk `/security/advisories/bulk` POST fails. Each row now carries an `auditReliable: boolean` and reports `vulnerabilities: null` when audit didn't return — matches the signal we already surface in `npm_health`. Same class of bug as the `npm_health` audit-failure fix in 0.11.11.
- `npm_health` `assessment` now layers `AUDIT_UNKNOWN` between `VULNERABLE` and `STALE`. Previously the headline string fell through to `ACTIVE`/`MAINTENANCE` when audit was unreliable, even though `signals.auditReliable: false` was already exposed — callers reading only `.assessment` got a confident "fine" verdict on unverified vuln data. `DEPRECATED` still takes priority over `AUDIT_UNKNOWN`.
- `npm_dep_tree` resolve-failure path (no range match AND no `dist-tags.latest` to fall back on, added in 0.11.11) now gates the placeholder write on `failedPackages`, matching the fetch-failure path. Two parents referencing the same unresolvable dep via different ranges land exactly one failed-true entry instead of inflating `unresolvedCount`.

### Tests
- +6 cases (723 -> 729): `npm_compare` `auditReliable` true on successful audit / false with `vulnerabilities: null` on audit 5xx, `npm_health` assessment `AUDIT_UNKNOWN` on audit 5xx and on no-`latest` packages, `DEPRECATED` still wins over `AUDIT_UNKNOWN`, and `npm_dep_tree` resolve-failure dedup across two parents.

## [0.11.11] -- 2026-05-19

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
