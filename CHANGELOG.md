# Changelog

All notable changes to `@yawlabs/npmjs-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/YawLabs/npmjs-mcp/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/YawLabs/npmjs-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/YawLabs/npmjs-mcp/releases/tag/v0.1.0
