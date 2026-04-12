# @yawlabs/npmjs-mcp

MCP server for the [npm](https://www.npmjs.com) registry. Package intelligence, security audits, dependency analysis, and org management from any MCP-compatible AI assistant.

## Quick start

```bash
npx @yawlabs/npmjs-mcp
```

## Setup

No API key is required for read-only tools (search, packages, downloads, security, analysis). For authenticated tools (auth, access, orgs, hooks), set your npm token:

```bash
export NPM_TOKEN="your-token"
```

### Claude Code

Add to your MCP config:

```json
{
  "mcpServers": {
    "npmjs": {
      "command": "npx",
      "args": ["-y", "@yawlabs/npmjs-mcp"]
    }
  }
}
```

With authentication:

```json
{
  "mcpServers": {
    "npmjs": {
      "command": "npx",
      "args": ["-y", "@yawlabs/npmjs-mcp"],
      "env": {
        "NPM_TOKEN": "your-token"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "npmjs": {
      "command": "npx",
      "args": ["-y", "@yawlabs/npmjs-mcp"],
      "env": {
        "NPM_TOKEN": "your-token"
      }
    }
  }
}
```

## Tools (46)

### Search
- `npm_search` — Search the npm registry with qualifiers (keywords, author, scope)

### Packages
- `npm_package` — Get package metadata (description, dist-tags, maintainers, license)
- `npm_version` — Get detailed metadata for a specific version
- `npm_versions` — List all published versions with dates
- `npm_readme` — Get README content
- `npm_dist_tags` — Get dist-tags (latest, next, beta, etc)
- `npm_types` — Check TypeScript type support (built-in types or @types/*)

### Dependencies
- `npm_dependencies` — Get dependency lists (prod, dev, peer, optional)
- `npm_dep_tree` — Resolve transitive dependency tree (configurable depth)
- `npm_license_check` — Check licenses of a package and its direct deps

### Downloads
- `npm_downloads` — Get total download count for a period
- `npm_downloads_range` — Get daily download breakdown
- `npm_downloads_bulk` — Compare downloads for up to 128 packages
- `npm_version_downloads` — Per-version download counts

### Security
- `npm_audit` — Check packages for known vulnerabilities
- `npm_audit_deep` — Full audit with CVSS scores, CWEs, fix recommendations
- `npm_signing_keys` — Get registry ECDSA signing keys

### Analysis
- `npm_compare` — Compare 2-5 packages side-by-side
- `npm_health` — Assess maintenance, downloads, security, deprecation status
- `npm_maintainers` — Get maintainers and their publish history
- `npm_release_frequency` — Analyze release cadence and gaps

### Registry
- `npm_registry_stats` — Total npm-wide download counts
- `npm_recent_changes` — Recent package publishes from the CouchDB changes feed
- `npm_ops_playbook` — Canonical recipes for npm operations (call this FIRST when unsure which tool to use)

### Provenance
- `npm_provenance` — Get Sigstore provenance attestations (SLSA, publish)

### Trusted Publishers (requires NPM_TOKEN)
- `npm_trusted_publishers` — List OIDC trust relationships with CI/CD providers

### Auth (requires NPM_TOKEN)
- `npm_whoami` — Check authenticated user
- `npm_profile` — Get profile, email, 2FA status
- `npm_tokens` — List access tokens
- `npm_verify_token` — One-call capability check (call this FIRST when debugging write failures)
- `npm_user_packages` — List packages published by a user

### Access (requires NPM_TOKEN)
- `npm_collaborators` — List package collaborators and permissions
- `npm_package_access` — Get package access settings

### Organizations (requires NPM_TOKEN)
- `npm_org_members` — List org members and roles
- `npm_org_packages` — List org packages
- `npm_org_teams` — List org teams
- `npm_team_packages` — List team package permissions

### Workflows
- `npm_check_auth` — Auth health check with headless publish feasibility
- `npm_publish_preflight` — Pre-publish validation checklist

### Write Operations (requires NPM_TOKEN with write scope)

These bypass the CLI/2FA friction that causes `npm deprecate` and similar commands to 422 locally. All use the HTTP API with your `NPM_TOKEN`.

- `npm_deprecate` — Deprecate a package or specific versions (validates message format)
- `npm_undeprecate` — Clear deprecation
- `npm_unpublish_version` — Unpublish a specific version (requires `confirm: true`)
- `npm_dist_tag_set` — Point a dist-tag at a version
- `npm_dist_tag_remove` — Remove a dist-tag (except `latest`)
- `npm_owner_add` — Add a maintainer
- `npm_owner_remove` — Remove a maintainer (prevents lockout)

### Operation Decision Matrix

| Operation | Preferred path | Why |
|---|---|---|
| Read (search/view/stats) | These MCP tools, no auth required | Fast, zero friction |
| Deprecate / dist-tag / owner | `npm_deprecate`, `npm_dist_tag_*`, `npm_owner_*` | HTTP API, no CLI auth issues |
| Publish | CI tag-push workflow | Version discipline, provenance, org token |
| Unpublish | `npm_unpublish_version` (with `confirm: true`) | Safer than CLI; irreversible within 72h |
| CLI fallback (only if MCP returns 422) | `npm login --auth-type=web` then `npm <op>` | End-user interactive path |

Call `npm_ops_playbook` at the start of any session for the up-to-date matrix.

## Features

- **37 tools** covering search, packages, deps, downloads, security, analysis, auth, orgs, provenance, trust, and publish workflows
- **No API key required** for read-only tools — authenticated tools opt-in via NPM_TOKEN
- **Zero runtime dependencies** — Single bundled file for instant `npx` startup
- **Agent-aware publish tools** — Detects non-interactive context, provides human hand-off actions instead of unworkable retries
- **MCP annotations** — Every tool declares read-only, destructive, and idempotent hints

## License

MIT
