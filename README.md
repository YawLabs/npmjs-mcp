# @yawlabs/npmjs-mcp

[![npm version](https://img.shields.io/npm/v/@yawlabs/npmjs-mcp)](https://www.npmjs.com/package/@yawlabs/npmjs-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/npmjs-mcp)](https://github.com/YawLabs/npmjs-mcp/stargazers)

**Run npm registry operations from Claude Code, Cursor, and any MCP client.** 64 tools covering the full registry surface: package intelligence, security audits, dependency analysis, org/team management, and the write ops that normally fight you locally (`npm deprecate`, `npm dist-tag`, `npm owner`, `npm unpublish`).

Built and maintained by [Yaw Labs](https://yaw.sh).

[![Add to Yaw MCP](https://yaw.sh/yaw-mcp-button.svg)](https://yaw.sh/mcp/install?name=npm&command=npx&args=-y%2C%40yawlabs%2Fnpmjs-mcp&description=npm%20registry%20-%20package%20intel%2C%20security%2C%20dependency%20analysis%2C%20write%20ops&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Fnpmjs-mcp)

One click adds this to your local Yaw MCP config so it's available in every Yaw Terminal session. Or install manually below.

## Why this one?

Other npm MCP servers wrap `npm search` and call it done. This one doesn't.

- **Full registry HTTP surface** — 64 tools across reads, writes, orgs, teams, hooks, provenance, trusted publishers, and ops health. Not just `npm view`.
- **Write ops that actually work in agents** — `npm_deprecate`, `npm_undeprecate`, `npm_dist_tag_set`, `npm_unpublish_version` go directly to the HTTP API with a Granular Access Token that has 2FA bypass. No 2FA prompts, no `--otp` hunts, no `ENEEDAUTH` from a session-bound `.npmrc`. (Since 2026-07-31 npm requires an interactive 2FA challenge for owner, access, team membership and grant, org membership and token changes even with 2FA bypass; for those tools the error names the exact `npm` command a human runs.)
- **Agent-aware failure surfacing** — `npm_check_auth` and `npm_publish_preflight` detect a non-interactive context and hand back a human-runnable command, and every write error names what was sent and the npm CLI equivalent, instead of looping on unrecoverable errors.
- **Safety by default** — `npm_unpublish_*` requires `confirm: true`. `npm_owner_remove` blocks you from locking yourself out. `npm_deprecate` rejects a message over the registry's 1024-character limit before sending it.
- **Ops playbook built in** — `npm_ops_playbook` returns the canonical tool-vs-CLI-vs-CI decision matrix so your agent picks the right path on the first try.
- **Tool annotations** — every tool declares `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`, so MCP clients can skip confirmation on safe ops.
- **No API key required for reads** — search, packages, downloads, security, dep tree, licenses all work anonymously. Auth is opt-in via `NPM_TOKEN`.
- **Instant startup** — ships as a single bundled file with zero runtime dependencies. No 5-minute `node_modules` install.
- **Input hardening** — package names, scopes, versions, dist-tags, and team names are all regex-validated against npm's actual constraints. Defends against CRLF and path-traversal in URL construction.

## Quick start

**1. Create `.mcp.json` in your project root**

macOS / Linux / WSL:

```json
{
  "mcpServers": {
    "npm": {
      "command": "npx",
      "args": ["-y", "@yawlabs/npmjs-mcp@latest"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "npm": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@yawlabs/npmjs-mcp@latest"]
    }
  }
}
```

> **Why the extra step on Windows?** Since Node 20, `child_process.spawn` cannot directly execute `.cmd` files (that's what `npx` is on Windows). Wrapping with `cmd /c` is the standard workaround.

**2. Restart and approve**

Restart Claude Code (or your MCP client) and approve the npm MCP server when prompted.

**3. (Optional) Add your npm token for write operations**

Read-only tools work without any setup. For write tools (`deprecate`, `dist-tag`, `owner`, `team_*`, `org_member_*`, `unpublish`, `hook_*`, `access_set*`, `token_revoke`), add `NPM_TOKEN` to the `env` block:

```json
{
  "mcpServers": {
    "npm": {
      "command": "npx",
      "args": ["-y", "@yawlabs/npmjs-mcp@latest"],
      "env": {
        "NPM_TOKEN": "npm_xxxxxxxxxxxx"
      }
    }
  }
}
```

Use a [Granular Access Token](https://docs.npmjs.com/creating-and-viewing-access-tokens#creating-granular-access-tokens) scoped to just the packages and orgs you want your agent to manage.

That's it. Now ask your AI assistant:

> "Deprecate my-old-pkg 1.x with a pointer to v2"
>
> "What's the dep tree for fastify look like three levels deep?"
>
> "Audit express for known CVEs and tell me the fix"
>
> "Who are the maintainers of next.js and when did each one last publish?"

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `NPM_TOKEN` | (none) | npm access token. Required only for write/auth/org/access/hooks tools. Use a Granular Access Token (with 2FA bypass for headless writes); classic tokens, including Automation tokens, were revoked in December 2025. |
| `NPM_REGISTRY` | `https://registry.npmjs.org` | Alternate registry (enterprise/private). Must support the npm HTTP API shape. |
| `NPM_REQUEST_TIMEOUT_MS` | `30000` | Timeout for each attempt of a registry request, in milliseconds, including reading the body. A read retries a timeout, a network error, or HTTP 429/502/503/504, up to 3 attempts in all, so a stalled read can take about three times this value. A write is never re-sent after a timeout or network error, because the registry may already have applied it; it retries only on 429/503. A value that is not a positive, finite number (`Infinity` included) falls back to the default, so the timeout cannot be turned off. |
| `NPM_RETRY_BACKOFF_MS` | `500` | Base wait before a retry, doubled each time: 500 ms, then 1000 ms by default. When the retried response carries a `Retry-After` header, that wait (capped at 30 s) is used instead, whatever this is set to. `0`, an empty value, or whitespace removes the backoff wait. Any other negative or non-numeric value falls back to the default. |
| `DEBUG` | (none) | Logs one line per attempt of every npm API call to stderr, prefixed `[npmjs-mcp]`: method, URL, then the status and milliseconds to response headers, or the wait before a retry and the attempt number, or the network error. The token is never logged. Enabled only by the exact values `npmjs-mcp` or `*`; anything else, such as `1` or `npmjs-mcp:*`, is ignored. A `DEBUG=*` set for another tool turns it on too. |
| `NPMJS_MCP_RUNTIME` | `auto` | `auto`: serve on the [oam](https://oamjs.org) the launcher is already running under if that is 0.15.2 or newer; otherwise run on the newest oam binary it can find at 0.15.2 or newer (see `OAM_BIN`); otherwise on Node. An oam host older than 0.15.2 never serves the server itself — it hands off to the newest usable oam, or to Node on `PATH`, or exits with an error when there is neither. An unusable `OAM_BIN` is always named on stderr; the other oam binaries found are named, with the reason, only when none of them is usable — an older copy losing to a newer one says nothing. `oam`: the same, but exit with an error instead of falling back to Node. `node`: always Node — in-process under `npx`, and handed off to Node on `PATH` when a client launches the command with `oam run`. Case-insensitive; any other value behaves like `auto`. |
| `NPMJS_MCP_SANDBOX` | (none) | `1` runs the server in a freshly spawned oam (0.15.2+) under `--permission`, granting only the npm registry hosts (plus `NPM_REGISTRY`'s host) and the variables the server reads; filesystem and subprocess access stay denied. Forces a spawn even when already running on oam. Under `auto`, when no usable oam is found, or the one found fails to launch, the server runs without the sandbox and says so on stderr; pair it with `NPMJS_MCP_RUNTIME=oam` to make that fatal. Ignored under `NPMJS_MCP_RUNTIME=node`. |
| `OAM_BIN` | (none) | Path to an `oam` binary to use in preference to discovery, when it is 0.15.2 or newer. If it does not exist, is older, or will not run, the launcher says so on stderr and carries on with discovery. Discovery looks in the installed location (`%LOCALAPPDATA%\oam\bin` then `~/.oam/bin` on Windows, `~/.oam/bin` elsewhere) and on `PATH`, asks every oam it finds for its version, and uses the newest; on a tie the installed copy wins. On Windows only `oam.exe` counts; an `oam.cmd` / `oam.bat` shim is never run, and is named on stderr when no usable oam is found. Ignored under `NPMJS_MCP_RUNTIME=node`, and when already running on oam 0.15.2+ without the sandbox. |

### Runtime

The server ships a launcher that prefers the [oam](https://oamjs.org) runtime and falls back to Node. The server itself is a pre-bundled ESM file using only `node:` builtins, so **both paths behave identically** — verified against the full MCP surface (handshake, all 64 tools, live registry calls) on each.

**oam 0.15.2, the latest release, is the minimum.** The launcher asks every oam binary it can find for its version and runs the newest one at or above it, never serves on an older oam, and falls back to Node when there is none (`NPMJS_MCP_RUNTIME=oam` turns that into a hard error). See [Configuration](#configuration) for the details.

Falling back costs nothing: npm has already started Node to run the launcher, so the fallback is an in-process `import()` — no extra spawn, no extra startup.

**oam is faster, but the launcher is not.** Measured on windows-arm64, n=12 medians, spawn to first MCP `initialize` response:

| invocation | time | vs node |
|---|--:|--:|
| `oam run dist/index.js` | 116 ms | **0.67x** |
| `node dist/index.js` | 172 ms | 1.00x |
| this launcher (node spawns oam) | 243 ms | 1.41x |

npm `bin` entries are Node scripts, so reaching oam through one costs Node's startup *plus* oam's — more than oam saves. The launcher exists so `npx` users get oam automatically; it is not the fast path.

**If you want oam's speed, point your MCP host straight at it** and skip the launcher:

```json
{ "mcpServers": { "npmjs": { "command": "oam", "args": ["run", "/abs/path/to/dist/index.js"] } } }
```

Benchmarking note: measure an **installed** oam (`~/.oam/bin`), never one out of a cargo `target/` directory — a concurrent `cargo build` replaces the binary mid-run, and fresh bytes are cold where the `node.exe` you are comparing against is warm. oam is pre-alpha; re-measure on your own hardware.

**oam's `--permission` sandbox is opt-in.** Set `NPMJS_MCP_SANDBOX=1` and the launcher spawns the server on oam (0.15.2 or newer) with:

- **network** granted to `registry.npmjs.org`, `api.npmjs.org` and `replicate.npmjs.com`, plus the hostname of `NPM_REGISTRY` when it is set;
- **environment** granted to exactly the variables the server reads: `NPM_TOKEN`, `NPM_REGISTRY`, `NPM_REQUEST_TIMEOUT_MS`, `NPM_RETRY_BACKOFF_MS` and `DEBUG`;
- **filesystem and subprocess** access denied outright. The server reads no files at runtime and spawns nothing, so a dependency that suddenly wants either is stopped by the runtime instead of trusted — which matters for a process holding an `NPM_TOKEN`.

Under the default `NPMJS_MCP_RUNTIME=auto`, if no usable oam is found, or the one chosen fails to start, the server runs without the sandbox and says so on stderr. Set `NPMJS_MCP_RUNTIME=oam` as well to make that an error.

It is not the default because an incomplete grant fails silently rather than loudly. Measured on oam 0.9.0 with only `registry.npmjs.org` granted, `npm_health` still returned HTTP 200, with `weeklyDownloads: null` and no error: the download counts come from `api.npmjs.org`. A missing variable is worse. oam removes a non-granted variable from `process.env` instead of throwing, so a denied `NPM_TOKEN` looks like no token at all, "unauthenticated" rather than "denied".

**Alternate MCP clients:**

| Client | Config file |
|---|---|
| Claude Code | `.mcp.json` (project root) or `~/.claude.json` (global) |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code | `.vscode/mcp.json` |

Use the same JSON block shown above in any of these.

## Tools (64)

### Search (1)
- **npm_search** — Search the npm registry with qualifiers (keywords, author, scope).

### Packages (6)
- **npm_package** — Metadata: description, dist-tags, maintainers, license, repository.
- **npm_version** — Detailed metadata for a specific version.
- **npm_versions** — All published versions with dates.
- **npm_readme** — README content.
- **npm_dist_tags** — Dist-tags (latest, next, beta, etc).
- **npm_types** — TypeScript type support (built-in types or `@types/*`).

### Dependencies (3)
- **npm_dependencies** — Dependency lists (prod, dev, peer, optional).
- **npm_dep_tree** — Transitive dependency tree (configurable depth).
- **npm_license_check** — License audit of a package and its direct deps.

### Downloads (4)
- **npm_downloads** — Total download count for a period.
- **npm_downloads_range** — Daily download breakdown.
- **npm_downloads_bulk** — Compare downloads for up to 128 packages.
- **npm_version_downloads** — Per-version download counts.

### Security (3)
- **npm_audit** — Check packages for known vulnerabilities.
- **npm_audit_deep** — Full audit with CVSS scores, CWEs, fix recommendations.
- **npm_signing_keys** — Registry ECDSA signing keys.

### Analysis (4)
- **npm_compare** — Compare 2–5 packages side-by-side.
- **npm_health** — Maintenance, downloads, security, deprecation summary.
- **npm_maintainers** — Maintainers and publish history.
- **npm_release_frequency** — Release cadence and gaps.

### Registry (3)
- **npm_registry_stats** — Total npm-wide download counts.
- **npm_recent_changes** — Recent publishes from the CouchDB changes feed.
- **npm_ops_playbook** — Canonical recipes for npm operations. **Call this first** when unsure which tool to use.

### Provenance & trust (2)
- **npm_provenance** — Sigstore attestations (SLSA, publish).
- **npm_trusted_publishers** — OIDC trust relationships with CI/CD providers.

### Auth (5, requires NPM_TOKEN)
- **npm_whoami** — Authenticated user.
- **npm_profile** — Profile, email, 2FA status.
- **npm_tokens** — List access tokens.
- **npm_verify_token** — One-call capability check. **Call this first** when debugging write failures.
- **npm_user_packages** — Packages published by a user.

### Access & orgs (7, requires NPM_TOKEN)
- **npm_collaborators** — Package collaborators and permissions.
- **npm_package_access** — Package access settings.
- **npm_org_members** — Org members and roles.
- **npm_org_packages** — Org packages.
- **npm_org_teams** — Org teams.
- **npm_team_packages** — Team package permissions.
- **npm_team_members** — Team members and roles.

### Workflows (2)
- **npm_check_auth** — Auth health check with headless publish feasibility.
- **npm_publish_preflight** — Pre-publish validation checklist.

### Write operations (19, requires NPM_TOKEN with write scope)

These bypass the CLI/2FA friction that makes `npm deprecate` and friends fail locally. All use the HTTP API with your `NPM_TOKEN`.

- **npm_deprecate** — Deprecate a package or specific versions (enforces the registry's 1024-char message limit; message punctuation is not constrained).
- **npm_undeprecate** — Clear deprecation.
- **npm_unpublish_version** — Unpublish a version. Requires `confirm: true`.
- **npm_unpublish_package** — Unpublish an entire package. Requires `confirm: true`.
- **npm_dist_tag_set** — Point a dist-tag at a version.
- **npm_dist_tag_remove** — Remove a dist-tag (refuses `latest`).
- **npm_owner_add** — Add a maintainer (resolves user via `/-/user/`).
- **npm_owner_remove** — Remove a maintainer (prevents self-lockout).
- **npm_access_set** — Set public/private/restricted access.
- **npm_access_set_mfa** — Configure 2FA requirement (none/publish/automation).
- **npm_team_grant** / **npm_team_revoke** — Grant/revoke team permissions on a package.
- **npm_team_create** / **npm_team_delete** — Create/delete a team in an org.
- **npm_team_member_add** / **npm_team_member_remove** — Manage team members.
- **npm_org_member_set** / **npm_org_member_remove** — Manage org membership and roles.
- **npm_token_revoke** — Revoke an access token by key.

### Webhooks (5, requires NPM_TOKEN)
- **npm_hook_add** — Register a webhook on a package, scope, or user.
- **npm_hook_list** — List webhooks (optional package filter).
- **npm_hook_get** — Fetch a single webhook.
- **npm_hook_update** — Update endpoint/secret.
- **npm_hook_remove** — Delete a webhook.

## Operation decision matrix

| Operation | Preferred path | Why |
|---|---|---|
| Read (search/view/stats) | These MCP tools, no auth | Fast, zero friction |
| Deprecate / dist-tag / unpublish | `npm_deprecate`, `npm_dist_tag_*`, etc. | HTTP API, no CLI 2FA friction with a 2FA-bypass token |
| Owner / access / team / org / token changes | `npm_owner_*`, `npm_access_set*`, `npm_team_*`, `npm_org_member_*`, `npm_token_revoke` | Since 2026-07-31 these need an interactive 2FA challenge; on 401/403 the error names the `npm` command a human runs |
| Publish | `bash release.sh X.Y.Z` from the workstation | This repo has no CI release workflow (removed in b2c256c). Note: workstation publishes carry no sigstore provenance — `--provenance` needs CI OIDC. |
| Unpublish | `npm_unpublish_version` (with `confirm: true`) | Safer than CLI; irreversible within 72h |
| CLI fallback | The `npm` command named in the error, run by a human who can answer the one-time-password prompt | On a 401/403 from a change that needs interactive 2FA, or a 422 whose message names it |

Call `npm_ops_playbook` at the start of any session to get the up-to-date matrix.

## Examples

### Audit a dependency

```
> "What vulnerabilities does lodash 4.17.20 have and what's the fix?"
→ npm_audit_deep({
    name: "my-project",              // the PROJECT being audited, not the dependency
    version: "1.0.0",
    dependencies: { lodash: "4.17.20" }   // required — the set to audit
  })
```

For a quick check across several packages at once, `npm_audit` takes the
name-to-versions map directly: `npm_audit({ packages: { lodash: ["4.17.20"] } })`.

### Deprecate a package

```
> "Deprecate @myorg/legacy-sdk with a pointer to @myorg/sdk"
→ npm_deprecate({ name: "@myorg/legacy-sdk", message: "Renamed to @myorg/sdk — install that instead" })
```

### Compare package health

```
> "Compare fastify vs express vs koa for maintenance health"
→ npm_compare({ packages: ["fastify", "express", "koa"] })
→ npm_health({ name: "fastify" }) // ...etc
```

### Rotate a dist-tag

```
> "Point @myorg/pkg@latest at 3.2.1"
→ npm_dist_tag_set({ name: "@myorg/pkg", tag: "latest", version: "3.2.1" })
```

### Debug a write failure

```
> "My deprecate keeps returning 401 — what's wrong?"
→ npm_verify_token()  // Confirms token scope, packages, 2FA state
→ npm_ops_playbook()  // Returns the canonical retry sequence
```

## Troubleshooting

**"Error: NPM_TOKEN is required"**

- The tool you called needs auth. Add `NPM_TOKEN` to the `env` block of your MCP config and restart the client.
- Prefer a [Granular Access Token](https://docs.npmjs.com/creating-and-viewing-access-tokens#creating-granular-access-tokens) scoped to just the packages and orgs you want touched.

**"HTTP 401 Unauthorized" or "HTTP 403 Forbidden"**

- Your token lacks scope on the target package. Call `npm_verify_token` — it reports which packages and orgs the token can actually write.
- An OTP challenge arrives as a 401 and a 2FA-policy refusal as a 403; neither is ever a 422. For deprecate, undeprecate, dist-tag and unpublish, a Granular Access Token with 2FA bypass enabled fixes both. Classic tokens, including Automation tokens, were revoked in December 2025.
- Owner, access, team membership and grant, org membership and token changes need an interactive 2FA challenge since 2026-07-31, even from a token with 2FA bypass. No token fixes those: the error names the exact `npm` command for a human to run and answer the one-time-password prompt.

**"HTTP 422 Unprocessable" on a write**

- Read the `Raw:` body at the end first; it is the registry's actual reason. Before it, the message says what that call sent and the documented npm rules it could have broken, then (where one exists) the npm CLI equivalent, which prints the registry's full error and prompts for a one-time password if needed.
- For `npm_deprecate`, a `versionRange` that matches no published version and a message over 1024 characters are both rejected locally as HTTP 400 before any write, so neither is a 422 cause. The range error lists the published versions; correct the range from that list or with `npm_versions`.
- Message punctuation is not a cause. Swapping a trailing period for an em-dash will not clear a 422.

**Windows: MCP server doesn't start**

- Use the `cmd /c npx ...` pattern from the Quick start section. Node 20+ can't spawn `.cmd` files directly.

## Requirements

- Node.js 20.11+ (`package.json` declares `engines.node: ">=20.11.0"`)
- (Optional) npm access token for write operations

## Contributing

```bash
git clone https://github.com/YawLabs/npmjs-mcp.git
cd npmjs-mcp
npm install
npm run lint       # Biome check
npm run lint:fix   # Auto-fix
npm run build      # tsc + esbuild bundle
npm test           # node --test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, including release process.

## License

MIT

[![Follow @TokenLimitNews on X](https://img.shields.io/badge/follow-%40TokenLimitNews-000000?logo=x&logoColor=white)](https://x.com/TokenLimitNews)
