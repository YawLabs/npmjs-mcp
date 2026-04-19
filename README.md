# @yawlabs/npmjs-mcp

[![npm version](https://img.shields.io/npm/v/@yawlabs/npmjs-mcp)](https://www.npmjs.com/package/@yawlabs/npmjs-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/npmjs-mcp)](https://github.com/YawLabs/npmjs-mcp/stargazers)
[![CI](https://github.com/YawLabs/npmjs-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/YawLabs/npmjs-mcp/actions/workflows/ci.yml) [![Release](https://github.com/YawLabs/npmjs-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/YawLabs/npmjs-mcp/actions/workflows/release.yml)

**Run npm registry operations from Claude Code, Cursor, and any MCP client.** 63 tools covering the full registry surface: package intelligence, security audits, dependency analysis, org/team management, and the write ops that normally fight you locally (`npm deprecate`, `npm dist-tag`, `npm owner`, `npm unpublish`).

Built and maintained by [Yaw Labs](https://yaw.sh).

[![Add to mcp.hosting](https://mcp.hosting/install-button.svg)](https://mcp.hosting/install?name=npm&command=npx&args=-y%2C%40yawlabs%2Fnpmjs-mcp&env=NPM_TOKEN&description=npm%20registry%20-%20package%20intel%2C%20security%2C%20dependency%20analysis%2C%20write%20ops&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Fnpmjs-mcp)

One click adds this to your [mcp.hosting](https://mcp.hosting) account so it syncs to every MCP client you use. Or install manually below.

## Why this one?

Other npm MCP servers wrap `npm search` and call it done. This one doesn't.

- **Full registry HTTP surface** — 63 tools across reads, writes, orgs, teams, hooks, provenance, trusted publishers, and ops health. Not just `npm view`.
- **Write ops that actually work in agents** — `npm_deprecate`, `npm_dist_tag_set`, `npm_owner_add`, `npm_unpublish_version` go directly to the HTTP API with your token. No 2FA prompts, no `--otp` hunts, no `ENEEDAUTH` from a session-bound `.npmrc`.
- **Agent-aware failure surfacing** — write tools detect non-interactive context and return specific human-runnable commands (`npm login --auth-type=web`) instead of looping on unrecoverable errors.
- **Safety by default** — `npm_unpublish_*` requires `confirm: true`. `npm_owner_remove` blocks you from locking yourself out. `npm_deprecate` validates the message format (em-dash, no trailing period) that npmjs.com's API actually accepts.
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
      "args": ["-y", "@yawlabs/npmjs-mcp"]
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
      "args": ["/c", "npx", "-y", "@yawlabs/npmjs-mcp"]
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
      "args": ["-y", "@yawlabs/npmjs-mcp"],
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
| `NPM_TOKEN` | (none) | npm access token. Required only for write/auth/org/access/hooks tools. A Granular Access Token is strongly preferred over a Classic Automation token. |
| `NPM_REGISTRY` | `https://registry.npmjs.org` | Alternate registry (enterprise/private). Must support the npm HTTP API shape. |

**Alternate MCP clients:**

| Client | Config file |
|---|---|
| Claude Code | `.mcp.json` (project root) or `~/.claude.json` (global) |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code | `.vscode/mcp.json` |

Use the same JSON block shown above in any of these.

## Tools (63)

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

### Access & orgs (6, requires NPM_TOKEN)
- **npm_collaborators** — Package collaborators and permissions.
- **npm_package_access** — Package access settings.
- **npm_org_members** — Org members and roles.
- **npm_org_packages** — Org packages.
- **npm_org_teams** — Org teams.
- **npm_team_packages** — Team package permissions.

### Workflows (2)
- **npm_check_auth** — Auth health check with headless publish feasibility.
- **npm_publish_preflight** — Pre-publish validation checklist.

### Write operations (19, requires NPM_TOKEN with write scope)

These bypass the CLI/2FA friction that makes `npm deprecate` and friends fail locally. All use the HTTP API with your `NPM_TOKEN`.

- **npm_deprecate** — Deprecate a package or specific versions (validates message format).
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
| Deprecate / dist-tag / owner / team / hook | `npm_deprecate`, `npm_dist_tag_*`, etc. | HTTP API, no CLI 2FA friction |
| Publish | CI tag-push workflow | Version discipline, provenance, org token |
| Unpublish | `npm_unpublish_version` (with `confirm: true`) | Safer than CLI; irreversible within 72h |
| CLI fallback (rare) | `npm login --auth-type=web` then `npm <op>` | Only if MCP returns 422 |

Call `npm_ops_playbook` at the start of any session to get the up-to-date matrix.

## Examples

### Audit a dependency

```
> "What vulnerabilities does lodash 4.17.20 have and what's the fix?"
→ npm_audit_deep({ name: "lodash", version: "4.17.20" })
```

### Deprecate a package

```
> "Deprecate @myorg/legacy-sdk with a pointer to @myorg/sdk"
→ npm_deprecate({ name: "@myorg/legacy-sdk", message: "Renamed to @myorg/sdk — install that instead" })
```

### Compare package health

```
> "Compare fastify vs express vs koa for maintenance health"
→ npm_compare({ names: ["fastify", "express", "koa"] })
→ npm_health({ name: "fastify" }) // ...etc
```

### Rotate a dist-tag

```
> "Point @myorg/pkg@latest at 3.2.1"
→ npm_dist_tag_set({ name: "@myorg/pkg", tag: "latest", version: "3.2.1" })
```

### Debug a write failure

```
> "My deprecate keeps returning 422 — what's wrong?"
→ npm_verify_token()  // Confirms token scope, packages, 2FA state
→ npm_ops_playbook()  // Returns the canonical retry sequence
```

## Troubleshooting

**"Error: NPM_TOKEN is required"**

- The tool you called needs auth. Add `NPM_TOKEN` to the `env` block of your MCP config and restart the client.
- Prefer a [Granular Access Token](https://docs.npmjs.com/creating-and-viewing-access-tokens#creating-granular-access-tokens) scoped to just the packages and orgs you want touched.

**"HTTP 401 Unauthorized" or "HTTP 403 Forbidden"**

- Your token lacks scope on the target package. Call `npm_verify_token` — it reports which packages and orgs the token can actually write.
- If the package requires 2FA for writes, your token must be an automation token or come from an OIDC trusted publisher. A user token will 403.

**"HTTP 422 Unprocessable" on deprecate**

- Common cause: message format. Use an em-dash and no trailing period: `"Renamed to @x/y — install that instead"`, not `"Renamed to @x/y. Install that instead."`
- Another: specifying a `versions` range that doesn't match any published version. Call `npm_versions` to confirm.

**Windows: MCP server doesn't start**

- Use the `cmd /c npx ...` pattern from the Quick start section. Node 20+ can't spawn `.cmd` files directly.

## Requirements

- Node.js 18+
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
