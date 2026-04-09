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

## Tools (35)

### Search
- `npm_search` — Search the npm registry with qualifiers (keywords, author, scope)

### Packages
- `npm_package` — Get package metadata (description, dist-tags, maintainers, license)
- `npm_version` — Get detailed metadata for a specific version
- `npm_versions` — List all published versions with dates
- `npm_readme` — Get README content
- `npm_dist_tags` — Get dist-tags (latest, next, beta, etc)

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

### Provenance
- `npm_provenance` — Get Sigstore provenance attestations (SLSA, publish)

### Auth (requires NPM_TOKEN)
- `npm_whoami` — Check authenticated user
- `npm_profile` — Get profile, email, 2FA status
- `npm_tokens` — List access tokens

### Access (requires NPM_TOKEN)
- `npm_collaborators` — List package collaborators and permissions
- `npm_package_access` — Get package access settings

### Organizations (requires NPM_TOKEN)
- `npm_org_members` — List org members and roles
- `npm_org_packages` — List org packages
- `npm_org_teams` — List org teams
- `npm_team_packages` — List team package permissions

### Hooks (requires NPM_TOKEN)
- `npm_hooks` — List npm webhooks

### Workflows
- `npm_check_auth` — Auth health check with headless publish feasibility
- `npm_publish_preflight` — Pre-publish validation checklist

## Features

- **35 tools** covering search, packages, deps, downloads, security, analysis, auth, orgs, provenance, and publish workflows
- **No API key required** for read-only tools — authenticated tools opt-in via NPM_TOKEN
- **Zero runtime dependencies** — Single bundled file for instant `npx` startup
- **Agent-aware publish tools** — Detects non-interactive context, provides human hand-off actions instead of unworkable retries
- **MCP annotations** — Every tool declares read-only, destructive, and idempotent hints

## License

MIT
