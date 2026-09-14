#!/bin/bash
# =============================================================================
# Release Script -- Build, tag, publish to npm, create GitHub release
# =============================================================================
# Usage:
#   ./release.sh <new-version>    -- full release from local machine
#   ./release.sh                  -- CI mode (derives version from git tag)
#
# If interrupted, re-run with the same version -- each step is idempotent.
#
# Prerequisites:
#   - Node.js 20+ and npm installed
#   - npm authenticated (npm whoami) or NODE_AUTH_TOKEN set
#   - gh CLI authenticated (or GITHUB_TOKEN set)
# =============================================================================

set -euo pipefail
trap 'echo -e "\n\033[0;31m  [FAIL] Release failed at line $LINENO (exit code $?)\033[0m"' ERR

# ---- Helpers ----
# ASCII-only status glyphs: Windows ConPTY mangles Unicode (✓ ✗) into mojibake
# when the colored output is captured into bug reports or copy-pasted.
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  [ok] $1${NC}"; }
warn() { echo -e "${YELLOW}  [!]  $1${NC}"; }
fail() { echo -e "${RED}  [x]  $1${NC}"; exit 1; }

# --- CHANGELOG promotion (ported from ctxlint) ---------------------------
# These scripts never promoted the [Unreleased] heading, so documented work
# accumulated there and shipped versions went out undocumented -- the cause of
# seven backfilled entries across this fleet on 2026-08-23. The promotion then
# skipped any release with nothing under [Unreleased], and step 6 fell back to
# commit subjects for the GitHub release notes whenever the entry was missing,
# so ten versions shipped across the fleet on 2026-09-13 with no changelog
# entry and subject-list release notes (0.16.0 here).
#
# Every release now gets a `## [<version>]` entry, and step 6 sources the
# release notes from it:
#   * [Unreleased] has content -> it becomes the version section, and a fresh,
#     empty [Unreleased] heading is left above it for the next change.
#   * [Unreleased] is empty or absent -> a version section is generated from
#     the commit subjects since the previous tag. Raw subjects are less than a
#     hand-written entry, but a version with no entry at all reads as a mistake.
#   * The Keep-a-Changelog link references at the bottom, when the file has
#     them, are moved along: [Unreleased] compares from the new tag, and the
#     version gets its own compare link.

changelog_section() {
  [ -f CHANGELOG.md ] || return 0
  awk -v heading="$1" '
    index($0, "## [" heading "]") == 1 { capture=1; next }
    capture && /^## \[/ { exit }
    capture { print }
  ' CHANGELOG.md
}

# True when a section body carries any non-whitespace content.
changelog_nonempty() { [ -n "$(echo "$1" | tr -d '[:space:]')" ]; }

# Reuse whatever separator this file already puts between version and date.
# The fleet mixes an em-dash and "--"; promoting with a hardcoded one would
# introduce a third style into whichever repos do not use it.
changelog_dash() {
  local d
  d=$(sed -nE 's/^## \[[0-9][^]]*\][[:space:]]+([^[:space:]]+)[[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2}.*/\1/p' CHANGELOG.md 2>/dev/null | head -1)
  if [ -n "$d" ]; then printf '%s' "$d"; else printf '%s' '--'; fi
}

# The tag this release is compared against: the newest v* tag reachable from
# HEAD other than this release's own (a re-run after tagging must not compare
# the version with itself). Empty on a first release.
changelog_prev_tag() {
  git describe --tags --abbrev=0 --match 'v*' --exclude "v${VERSION}" 2>/dev/null || true
}

# The body of a generated entry: one bullet per commit subject since the
# previous tag, newest first, with version-bump commits dropped.
changelog_generated_body() {
  local prev=$1 range subjects
  if [ -n "$prev" ]; then range="${prev}..HEAD"; else range="HEAD"; fi
  subjects=$(git log --no-merges --format='%s' "$range" 2>/dev/null \
    | grep -vE '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^/- /' || true)
  [ -n "$subjects" ] || subjects="- Maintenance release; no changes since ${prev:-the previous release}."
  printf '### Changed\n%s\n' "$subjects"
}

# Keep-a-Changelog link references, when the file uses them: [Unreleased]
# compares from the new tag, and the version gets its own compare link (or a
# tag link on a first release). A version link that already exists is kept.
changelog_update_links() {
  local prev=$1 tmp
  grep -qE '^\[Unreleased\]: .*/compare/.*\.\.\.HEAD' CHANGELOG.md || return 0
  tmp=$(mktemp)
  awk -v ver="$VERSION" -v prev="$prev" -v have_link="$(grep -c "^\[${VERSION}\]: " CHANGELOG.md || true)" '
    !done && /^\[Unreleased\]: .*\/compare\/.*\.\.\.HEAD/ {
      url=$0; sub(/^\[Unreleased\]: /, "", url); sub(/\/compare\/.*$/, "", url)
      print "[Unreleased]: " url "/compare/v" ver "...HEAD"
      if (have_link == 0) {
        if (prev != "") print "[" ver "]: " url "/compare/" prev "...v" ver
        else print "[" ver "]: " url "/releases/tag/v" ver
      }
      done=1; next
    }
    { print }
  ' CHANGELOG.md > "$tmp" || { rm -f "$tmp"; fail "CHANGELOG.md link update failed"; }
  mv "$tmp" CHANGELOG.md
}

# Make sure `## [<version>] <dash> <today>` exists: promote [Unreleased] when it
# has content, otherwise generate the section from the commit subjects.
promote_changelog() {
  [ -f CHANGELOG.md ] || return 0
  local prev
  prev=$(changelog_prev_tag)
  if changelog_nonempty "$(changelog_section "$VERSION")"; then
    info "CHANGELOG.md already has an entry for v${VERSION}"
    changelog_update_links "$prev"
    return 0
  fi
  local today tmp dash heading body
  today=$(date +%F)
  dash=$(changelog_dash)
  heading="## [${VERSION}] ${dash} ${today}"
  tmp=$(mktemp)
  if changelog_nonempty "$(changelog_section "Unreleased")"; then
    # Rewrite only the FIRST [Unreleased] heading: a stray later mention (a link
    # reference, a quoted example) must not become a second, bogus heading.
    awk -v repl="$heading" '
      !promoted && index($0, "## [Unreleased]") == 1 { print "## [Unreleased]"; print ""; print repl; promoted=1; next }
      { print }
    ' CHANGELOG.md > "$tmp" || { rm -f "$tmp"; fail "CHANGELOG.md promotion failed"; }
    info "CHANGELOG.md: promoted [Unreleased] -> [${VERSION}] ${dash} ${today}"
  else
    body=$(changelog_generated_body "$prev")
    warn "CHANGELOG.md has no [Unreleased] content -- writing [${VERSION}] from the commit subjects since ${prev:-the first commit}; edit it if they undersell the release"
    # Insert below an empty [Unreleased] heading, else above the first version
    # heading, else at the end of the file.
    awk -v heading="$heading" -v body="$body" '
      !done && index($0, "## [Unreleased]") == 1 { print; print ""; print heading; print ""; print body; done=1; next }
      !done && /^## \[/ { print heading; print ""; print body; print ""; done=1 }
      { print }
      END { if (!done) { print ""; print heading; print ""; print body } }
    ' CHANGELOG.md > "$tmp" || { rm -f "$tmp"; fail "CHANGELOG.md entry generation failed"; }
    info "CHANGELOG.md: added [${VERSION}] ${dash} ${today} from commit subjects"
  fi
  mv "$tmp" CHANGELOG.md
  changelog_update_links "$prev"
}

# Backstop for the promotion above: every release has an entry now, so a
# missing one means promote_changelog did not run or did not land, and the
# release notes in step 6 would silently fall back to commit subjects.
assert_changelog_promoted() {
  [ -f CHANGELOG.md ] || return 0
  changelog_nonempty "$(changelog_section "$VERSION")" && return 0
  fail "CHANGELOG.md has no '## [${VERSION}]' entry -- promote_changelog did not run or did not land."
}

# Release notes for step 6: the version's changelog section, trimmed of the
# blank lines around it; commit subjects only when there is no changelog.
release_notes() {
  local notes
  notes=$(changelog_section "$VERSION" | sed -e '/./,$!d' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')
  if changelog_nonempty "$notes"; then
    printf '%s\n' "$notes"
  elif [ -n "${1:-}" ] && [ "$1" != "v${VERSION}" ]; then
    git log --oneline "${1}..v${VERSION}" --no-decorate | sed 's/^[a-f0-9]* /- /'
  else
    printf 'Initial release\n'
  fi
}

# SKIP_LINT=1 escape hatch -- wraps `npm`/`pnpm` so lint-related runs are
# no-ops.
#
# THIS SHOULD NOW BE UNNECESSARY, and reaching for it is a signal something
# regressed. `npm run lint` routes through scripts/lint.mjs, which runs biome
# at the version this repo's lockfile installs, on a binary that works on the
# host. On Windows ARM64 that means the x64 build of that same version under
# emulation, because the native arm64 build of SOME biome releases crashes
# rather than running -- measured on that host: 2.5.4 exits 139, while 2.4.16
# and 2.5.13 run correctly. Verified: `npm run lint` exits 0 there.
#
# Two things the earlier text here got wrong, recorded so they do not get
# re-diagnosed. It blamed "the MINGW64-ARM64 npm-run-script wrapper": `npm run`
# is fine on that host, and a plain node script through the same wrapper exits
# 0. And the crash is not a permanent property of arm64 -- it is specific to
# the biome release installed, which is why the wrapper provisions the x64
# build of THAT version rather than assuming the architecture is broken.
#
# The earlier text also justified skipping with "CI catches lint regressions
# anyway". This repo has NO CI -- its workflows were removed in b2c256c and
# Actions is disabled on the repository -- so nothing downstream re-checks
# formatting. Skipping the lint step means the release is published unlinted,
# full stop.
#
# So: only set SKIP_LINT=1 if scripts/lint.mjs cannot produce a result at all,
# and treat that as a bug to fix rather than a step to routinely skip.
if [ "${SKIP_LINT:-}" = "1" ]; then
  npm() {
    if [ "$1" = "run" ] && [[ "$2" == lint* ]]; then
      warn "SKIP_LINT=1 -- noop 'npm run $2'"
      return 0
    fi
    command npm "$@"
  }
  pnpm() {
    if [ "$1" = "run" ] && [[ "$2" == lint* ]]; then
      warn "SKIP_LINT=1 -- noop 'pnpm run $2'"
      return 0
    fi
    command pnpm "$@"
  }
fi

TOTAL_STEPS=8

# ---- Resolve version ----
VERSION="${1:-}"
IS_CI="${CI:-false}"

if [ -z "$VERSION" ]; then
  if [ "$IS_CI" = "true" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
    VERSION="${GITHUB_REF_NAME#v}"
    info "CI mode -- version $VERSION from tag $GITHUB_REF_NAME"
  else
    echo "Usage: ./release.sh <version>"
    echo "  e.g. ./release.sh 0.1.0"
    exit 1
  fi
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

# ---- Pre-flight checks ----
echo -e "${CYAN}Pre-flight checks...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null || fail "node not installed"
command -v npm >/dev/null  || fail "npm not installed"

CURRENT_VERSION=$(node -p "require('./package.json').version")
RESUMING=false

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  info "Already at v${VERSION} -- resuming"
else
  if [ "$IS_CI" != "true" ]; then
    if [ -n "$(git status --porcelain)" ]; then
      fail "Working directory not clean. Commit or stash changes first."
    fi
  fi
  info "Current: v${CURRENT_VERSION} → v${VERSION}"
fi

if [ "$IS_CI" != "true" ] && [ "$RESUMING" != "true" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Run lint + tests"
  echo "  2. Build"
  echo "  3. Bump version in package.json"
  echo "  4. Commit, tag, and push"
  echo "  5. Publish to npm"
  echo "  6. Create GitHub release"
  echo "  7. Publish to MCP Registry"
  echo "  8. Verify"
  echo ""
  if [ -t 0 ]; then
    read -p "Continue? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "Aborted."
      exit 0
    fi
  else
    info "Non-interactive shell -- proceeding without confirmation"
  fi
fi

# =============================================================================
# Step 1: Lint
# =============================================================================
step 1 "Lint"

# A crashed linter is not a lint result -- and not a pass either, so a crash
# STOPS the release. On Windows ARM64 the native
# node_modules/@biomejs/cli-win32-arm64/biome.exe can crash instead of running
# (measured at biome 2.5.4: 139 under bash, 3221225477 / 0xC0000005 under
# PowerShell, through npm and invoked directly alike -- so it is that release's
# binary, not npm's exit path; 2.4.16 and 2.5.13 run fine on the same host).
# `npm run lint` now routes through scripts/lint.mjs, which runs the x64 build
# of the INSTALLED version under emulation on that host and turns any biome
# crash into a labelled exit 1. A raw crash code reaching this point means the
# wrapper was bypassed, overridden (YAWLABS_BIOME_BIN / YAWLABS_BIOME_NATIVE),
# or regressed.
#
# This used to warn "Lint is UNVERIFIED" and let the release continue. With no
# CI on this repo, that published an unlinted release with nothing downstream to
# catch it. Fix the runner; SKIP_LINT=1 is the explicit last-resort override.
LINT_OUT=$(mktemp)
if [ "${SKIP_LINT:-}" = "1" ]; then
  warn "Lint SKIPPED (SKIP_LINT=1) -- UNVERIFIED for this release"
elif npm run lint > "$LINT_OUT" 2>&1; then
  info "Lint passed"
else
  LINT_RC=$?
  if [ "$LINT_RC" -eq 139 ] || [ "$LINT_RC" -eq 3221225477 ]; then
    cat "$LINT_OUT"
    rm -f "$LINT_OUT"
    fail "Lint runner CRASHED (exit $LINT_RC) -- no lint result, so the release stops here. scripts/lint.mjs should route around a crashing native biome binary by running the x64 build of the installed version; check the YAWLABS_BIOME_BIN / YAWLABS_BIOME_NATIVE overrides. Last resort, publishing unlinted: re-run with SKIP_LINT=1."
  else
    cat "$LINT_OUT"
    rm -f "$LINT_OUT"
    fail "Lint failed"
  fi
fi
rm -f "$LINT_OUT"

# =============================================================================
# Step 2: Test
# =============================================================================
step 2 "Test"

npm run build || fail "Build failed"
npm test || fail "Tests failed"
info "All tests passed"

# =============================================================================
# Step 3: Bump version
# =============================================================================
step 3 "Bump version to $VERSION"

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Already at v${VERSION} -- skipping"
else
  npm version "$VERSION" --no-git-tag-version
  info "Version bumped"
fi

# server.json is published to the MCP Registry in step 7 and must match the
# tag's version. This runs UNCONDITIONALLY (not inside the bump else above)
# so a resume run where package.json was bumped in a prior invocation still
# syncs server.json -- otherwise mcp-publisher tries to re-publish the
# previous version and gets 400 "cannot publish duplicate version".
# Idempotent: the inner if skips the write when server.json is already in
# sync, so a clean re-run produces no working-tree dirt.
if [ -f server.json ]; then
  CURRENT_SERVER_VERSION=$(jq -r '.version' server.json 2>/dev/null || echo "")
  if [ "$CURRENT_SERVER_VERSION" != "$VERSION" ]; then
    # jq on Windows emits CRLF. The committed file is LF (.gitattributes), so
    # without the strip every release leaves a CRLF working copy and git warns
    # "CRLF will be replaced by LF" on the bump commit.
    jq --arg v "$VERSION" '.version = $v | .packages[0].version = $v' server.json | tr -d '\r' > server.tmp
    mv server.tmp server.json
    info "server.json synced to $VERSION"
  fi
fi

# =============================================================================
# Step 4: Commit, tag, and push
# =============================================================================
# Promote the heading BEFORE the bump commit, so the rewrite is committed
# with the version bump rather than left dirty in the working tree.
promote_changelog
assert_changelog_promoted

step 4 "Commit, tag, and push"

if [ "$IS_CI" = "true" ]; then
  info "CI mode -- skipping commit/tag/push (already tagged)"
else
  BUMP_FILES="package.json package-lock.json"
  [ -f CHANGELOG.md ] && BUMP_FILES="$BUMP_FILES CHANGELOG.md"
  [ -f server.json ] && BUMP_FILES="$BUMP_FILES server.json"
  if [ -n "$(git status --porcelain $BUMP_FILES 2>/dev/null)" ]; then
    git add $BUMP_FILES
    git commit -m "v${VERSION}"
    info "Committed version bump"
  else
    info "Nothing to commit"
  fi

  if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
    info "Tag v${VERSION} already exists"
  else
    # Annotated (-a) so `git push --follow-tags` below picks it up;
    # lightweight tags are ignored by --follow-tags and would silently
    # fail to publish (release commit lands but tag-push is a no-op).
    git tag -a "v${VERSION}" -m "v${VERSION}"
    info "Tag v${VERSION} created"
  fi

  # --follow-tags pushes only annotated tags reachable from the pushed
  # commits, not every local tag. Avoids accidentally publishing dangling
  # experimental tags that happen to be lying around.
  # Tag-drift safety: refuse to push if origin already has a tag at this name
  # pointing to a different commit (rewound tag elsewhere, parallel release race).
  # Without this check, `git push --follow-tags` SILENTLY skips updating the
  # tag on origin (the tag exists, no fast-forward happens). The main push
  # reports success, but origin's tag stays at the old SHA -- and the later
  # `gh release create` step then creates a GitHub release linked to that
  # stale commit while npm carries the new one.
  ORIGIN_TAG_SHA=$(git ls-remote --tags origin "refs/tags/v${VERSION}" 2>/dev/null | awk '{print $1}')
  if [ -n "$ORIGIN_TAG_SHA" ]; then
    LOCAL_TAG_SHA=$(git rev-parse "v${VERSION}")
    if [ "$ORIGIN_TAG_SHA" != "$LOCAL_TAG_SHA" ]; then
      fail "Tag v${VERSION} exists on origin at $ORIGIN_TAG_SHA but local tag points to $LOCAL_TAG_SHA -- resolve the drift before re-running"
    fi
  fi

  git push origin main --follow-tags
  info "Pushed to origin"
fi

# =============================================================================
# Step 5: Publish to npm
# =============================================================================
step 5 "Publish to npm"
# Three publish paths, picked by environment:
#   1. IS_CI=true                    -> WE are CI. Do the publish (NODE_AUTH_TOKEN
#                                       is set; --provenance for sigstore).
#   2. IS_CI=false + release.yml     -> CI will publish on the tag we just pushed.
#      exists with CI publish path      Watch `gh run watch` for that run and
#                                       verify via `npm view`. Workstation MUST
#                                       NOT also publish -- stale ~/.npmrc fails
#                                       E404, valid one races CI for the same
#                                       version. CI is authoritative.
#   3. IS_CI=false + no CI publish   -> Workstation IS the publisher. Try locally
#      path                             with EOTP retry for fresh WebAuthn sessions.
#
# CURRENT STATE OF THIS REPO: the GitHub Actions workflows were removed in
# b2c256c, so `.github/workflows/release.yml` does not exist and path 3 is the
# live one. That has a consequence worth stating outright: `npm publish
# --provenance` requires the OIDC token that only Actions issues, so releases
# cut from a workstation carry NO sigstore provenance attestation. Restoring
# attested releases means restoring a CI publish job (or an npm Trusted
# Publisher), not a change in this script. Step 8 warns when a release lands
# unattested so the gap stays visible instead of silently persisting.
PUBLISHED_VERSION=$(npm view "@yawlabs/npmjs-mcp@${VERSION}" version 2>/dev/null || echo "")
if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "v${VERSION} already published on npm -- skipping"
  # Resume-path safety: a prior interrupted run may have published but never
  # observed `gh run watch` to completion. Later CI steps (smoke test, MCP
  # Registry publish, attestation upload) could have failed silently. Look
  # up the most recent Release run for this tag and warn if its conclusion
  # was non-success. Best-effort -- if the tag isn't on origin yet or the
  # run isn't visible, the warn just doesn't fire.
  if [ "$IS_CI" != "true" ] && [ -f ".github/workflows/release.yml" ]; then
    RESUME_TAG_SHA=$(git rev-parse "v${VERSION}^{}" 2>/dev/null || echo "")
    if [ -n "$RESUME_TAG_SHA" ]; then
      RESUME_CONCLUSION=$(gh run list --workflow=Release --event=push --commit="$RESUME_TAG_SHA" --limit=1 --json conclusion --jq '.[0].conclusion' 2>/dev/null || echo "")
      if [ -n "$RESUME_CONCLUSION" ] && [ "$RESUME_CONCLUSION" != "success" ]; then
        warn "Prior CI Release run for v${VERSION} ended with conclusion='$RESUME_CONCLUSION' (not 'success'). A post-publish step (smoke test, MCP Registry publish, attestation) may have failed silently. Inspect: gh run list --workflow=Release --commit=$RESUME_TAG_SHA --limit=3"
      fi
    fi
  fi
elif [ "$IS_CI" = "true" ]; then
  npm publish --access public --provenance
  info "Published @yawlabs/npmjs-mcp@${VERSION} to npm (with provenance)"
elif [ -f ".github/workflows/release.yml" ] && grep -q "npm publish\|NODE_AUTH_TOKEN" .github/workflows/release.yml; then
  info "CI release.yml fires on v* tag push -- workstation hands off to CI"
  # Verify the tag landed on origin BEFORE looking up the CI run. A local
  # push that succeeded but the remote rejected (protected-tag rule, network
  # blip) would otherwise dead-end in the lookup loop with a misleading
  # "Push may have failed" error 62s later. ls-remote is one round-trip --
  # cheap relative to gh run watch.
  if ! git ls-remote --tags origin "refs/tags/v${VERSION}" 2>/dev/null | grep -q "refs/tags/v${VERSION}$"; then
    fail "Tag v${VERSION} not visible on origin. Step 4's 'git push --follow-tags' may have failed silently (protected-tag rule, network blip), or the tag was deleted between push and now. Re-run step 4."
  fi
  TAG_SHA=$(git rev-parse "v${VERSION}^{}")
  RUN_ID=""
  # Exponential backoff: 2+4+8+16+32 = 62s upper bound on GitHub's
  # tag-push -> actions queue visibility lag. Cheap relative to the CI run
  # itself (~6 min on aws-mcp).
  DELAY=2
  for i in 1 2 3 4 5; do
    RUN_ID=$(gh run list --workflow=Release --event=push --commit="$TAG_SHA" --limit=1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || echo "")
    [ -n "$RUN_ID" ] && break
    sleep $DELAY
    DELAY=$((DELAY * 2))
  done
  if [ -z "$RUN_ID" ]; then
    fail "Could not find Release workflow run for tag v${VERSION} (commit $TAG_SHA) after 62s of polling. The actions queue may be backed up; check 'gh run list --limit 5' and rerun the script to retry."
  fi
  info "Watching CI Release run $RUN_ID"
  gh run watch "$RUN_ID" --exit-status || fail "CI Release run $RUN_ID failed. See 'gh run view $RUN_ID --log-failed'."
  # CI is authoritative on the publish itself -- if `gh run watch` exited 0,
  # the package is live on npm regardless of how long the registry mirror
  # takes to surface it. Verification here is a courtesy check; warn rather
  # than fail when the mirror lags (existing memory: lag can exceed a minute).
  NPM_NOW=""
  for i in 1 2 3 4 5 6 7 8 9 10; do
    NPM_NOW=$(npm view "@yawlabs/npmjs-mcp@${VERSION}" version 2>/dev/null || echo "")
    [ "$NPM_NOW" = "$VERSION" ] && break
    sleep 6
  done
  if [ "$NPM_NOW" = "$VERSION" ]; then
    info "Published @yawlabs/npmjs-mcp@${VERSION} via CI Release run $RUN_ID"
  else
    DISPLAY_NPM="${NPM_NOW:-(not found)}"
    warn "CI Release run $RUN_ID succeeded but npm registry still shows '$DISPLAY_NPM' for @yawlabs/npmjs-mcp@${VERSION} after 60s. Likely registry propagation lag -- verify with 'npm view @yawlabs/npmjs-mcp@${VERSION}' in a minute. Publish is authoritative on CI's exit code."
  fi
else
  # Workstation IS the publisher (no CI fallback). Retry only on EOTP/EAUTH/OTP
  # for fresh WebAuthn sessions; fail fast on everything else.
  ATTEMPT=1
  MAX_ATTEMPTS=3
  while true; do
    PUBLISH_LOG=$(mktemp)
    if npm publish --access public 2>&1 | tee "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      break
    fi
    if ! grep -qE 'EOTP|EAUTH|one-time password|OTP' "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      fail "npm publish failed (non-OTP error -- see output above).

  If the error was E401 or E404, the automation token in ~/.npmrc is dead.
  npm answers an UNAUTHORIZED PUT with 404, not 401, so 'could not be found
  or you do not have permission' here almost always means 'not authorized'
  -- the package is fine. Confirm which it is:

      npm whoami          # E401 => the token is dead

  Fix: mint a NEW automation token (npmjs.com -> Access Tokens -> Generate
  -> Automation), then write these two lines to ~/.npmrc:

      @yawlabs:registry=https://registry.npmjs.org/
      //registry.npmjs.org/:_authToken=npm_YOURTOKEN

  Do NOT run 'npm login --auth-type=web'. It OVERWRITES the automation token
  with a 2FA-bound web session; the next publish then EOTPs on a WebAuthn
  challenge, and any CI sharing that token starts failing too."
    fi
    rm -f "$PUBLISH_LOG"
    if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
      fail "npm publish failed after $MAX_ATTEMPTS OTP-class attempts. WebAuthn session may not be propagating."
    fi
    warn "npm publish attempt $ATTEMPT EOTPed -- waiting 30s for WebAuthn session to propagate"
    ATTEMPT=$((ATTEMPT + 1))
    sleep 30
  done
  info "Published @yawlabs/npmjs-mcp@${VERSION} to npm (workstation)"
fi

# =============================================================================
# Step 6: Create GitHub release
# =============================================================================
step 6 "Create GitHub release"

if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists -- skipping"
else
  # The notes are the CHANGELOG.md `## [<version>]` section, which
  # promote_changelog guaranteed (and assert_changelog_promoted checked) before
  # the bump commit in step 4 -- so the release page mirrors the project
  # narrative (Fixed / Added / Changed / Documentation) rather than raw commit
  # subjects. release_notes falls back to the subjects since the previous tag
  # only when the repo has no CHANGELOG.md at all. `git describe --tags
  # --abbrev=0 v${VERSION}^` only succeeds when the current tag exists; if it
  # fails (first release) the fallback lands on "Initial release".
  PREV_TAG=$(git describe --tags --abbrev=0 "v${VERSION}^" 2>/dev/null || true)
  NOTES=$(release_notes "$PREV_TAG")

  gh release create "v${VERSION}" \
    --title "v${VERSION}" \
    --notes "$NOTES"
  info "GitHub release created (notes from CHANGELOG.md [${VERSION}])"
fi

# --- npm propagation gate (part of step 7, deliberately not a step of its own) ---
#
# `npm publish` returns as soon as the registry ACCEPTS the tarball, but the
# version is not immediately readable from the CDN-backed read path. The MCP
# Registry validates by READING the package, so a registry publish that runs
# straight after `npm publish` can fail with "version 'X' was not found
# (status: 404)". ssh-mcp v0.15.3 failed exactly that way, and aws-mcp did on
# three consecutive releases (2.2.0, 2.2.1, 2.2.2). Each recovered only by
# waiting and re-running, i.e. the release cost two invocations and a human
# in the loop.
#
# Polling here makes one invocation enough (ported from aws-mcp's release.sh).
# Three deliberate choices:
#
#   * curl, not `npm view`. npm caches registry metadata (5 min by default), so
#     a poll through it can keep reporting the pre-publish answer well after the
#     version is live -- the loop would then outlast the condition it is waiting
#     on.
#   * The EXACT URL the MCP Registry fetches. Its npm validator requests
#     <base>/url.PathEscape(name)/<version>, and Go's PathEscape turns the scope
#     slash into %2F (`@yawlabs%2Fpkg`, the `@` left bare). A literal-slash URL
#     reaches the same origin but can be a different CDN cache entry, so success
#     there would be a proxy rather than evidence about the path that fails.
#   * WARN, never fail, on timeout. If propagation is genuinely stuck, letting
#     mcp-publisher run produces its own precise error naming the version and
#     status; a timeout message from this loop would replace that with something
#     strictly less informative. This gate can only make the release faster,
#     never worse than it was before it existed.
if [ "${SKIP_NPM_WAIT:-}" = "1" ]; then
  warn "SKIP_NPM_WAIT=1 -- not waiting for npm to serve v${VERSION}"
elif ! command -v curl >/dev/null 2>&1; then
  warn "curl not found -- skipping the npm propagation wait; step 7 may 404 on a fresh publish"
else
  PKG_NAME=$(node -p "require('./package.json').name")
  NPM_WAIT_URL="https://registry.npmjs.org/${PKG_NAME//\//%2F}/${VERSION}"
  NPM_WAIT_TIMEOUT_S=${NPM_WAIT_TIMEOUT_S:-300}
  NPM_WAITED_S=0
  # 5s: this is a remote read on a minutes-scale wait, so a tighter spin buys
  # nothing. (Under MSYS every `sleep` forks a process -- ~0.1s each -- which is
  # noise at this interval but the reason not to poll sub-second.)
  while [ "$NPM_WAITED_S" -lt "$NPM_WAIT_TIMEOUT_S" ]; do
    if curl -fsS -o /dev/null "$NPM_WAIT_URL" 2>/dev/null; then
      break
    fi
    sleep 5
    NPM_WAITED_S=$((NPM_WAITED_S + 5))
  done
  if [ "$NPM_WAITED_S" -ge "$NPM_WAIT_TIMEOUT_S" ]; then
    warn "npm still does not serve ${PKG_NAME}@${VERSION} after ${NPM_WAIT_TIMEOUT_S}s -- continuing anyway so the registry step can report the precise error"
  elif [ "$NPM_WAITED_S" -gt 0 ]; then
    info "npm is serving v${VERSION} (waited ${NPM_WAITED_S}s for propagation)"
  else
    info "npm is already serving v${VERSION}"
  fi
fi

# =============================================================================
# Step 7: Publish to the Official MCP Registry
# =============================================================================
# Downstream catalogs (Glama, PulseMCP, mcpservers.org) auto-source from the
# Official MCP Registry; publishing here is what makes the new version visible
# to them. server.json was already bumped in step 3 so the version matches the
# tag.
step 7 "Publish to MCP Registry"

if [ ! -f server.json ]; then
  info "No server.json -- not an MCP server, skipping registry publish"
else
  # mcp-publisher binary cached at ~/.local/bin. Pinned to "latest" upstream;
  # if the registry's CLI introduces a breaking change, the next release will
  # surface it. The OS/arch detection handles Linux, macOS, and Git Bash on
  # Windows (MINGW/MSYS uname -s starts with "mingw" / "msys").
  MP="${MCP_PUBLISHER:-$HOME/.local/bin/mcp-publisher}"
  if ! [ -x "$MP" ]; then
    info "mcp-publisher not found at $MP -- downloading"
    mkdir -p "$(dirname "$MP")"
    OS_RAW=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$OS_RAW" in mingw*|msys*|cygwin*) OS=windows ;; *) OS="$OS_RAW" ;; esac
    ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
    TMP=$(mktemp -d)
    curl -sL -o "$TMP/mp.tar.gz" \
      "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_${OS}_${ARCH}.tar.gz" \
      || fail "Failed to download mcp-publisher (${OS}/${ARCH})"
    tar xzf "$TMP/mp.tar.gz" -C "$TMP" || fail "Failed to extract mcp-publisher tarball"
    if [ -f "$TMP/mcp-publisher.exe" ]; then
      mv "$TMP/mcp-publisher.exe" "$MP"
    else
      mv "$TMP/mcp-publisher" "$MP"
    fi
    rm -rf "$TMP"
    chmod +x "$MP" 2>/dev/null || true
  fi

  # OIDC auth (used by the old release.yml) only works inside Actions; locally
  # we use a GitHub PAT via `login github -token <PAT>`. The PAT needs read:org
  # for YawLabs so the registry can verify org membership for the
  # io.github.YawLabs/* namespace.
  # Fall back to gh CLI's session token if MCP_REGISTRY_TOKEN is unset --
  # gh auth login (admin:org or read:org scope) covers the namespace claim.
  : "${MCP_REGISTRY_TOKEN:=$(gh auth token 2>/dev/null || true)}"
  if [ -z "${MCP_REGISTRY_TOKEN:-}" ]; then
    fail "MCP_REGISTRY_TOKEN unset -- set it to a GitHub PAT with read:org for YawLabs (or run '$MP login github' once interactively to cache the session)."
  fi
  "$MP" login github -token "$MCP_REGISTRY_TOKEN" >/dev/null 2>&1 \
    || fail "mcp-publisher login failed -- check MCP_REGISTRY_TOKEN scopes (needs read:org for YawLabs)"
  "$MP" publish \
    || fail "mcp-publisher publish failed -- npm + GitHub release succeeded, but the MCP Registry did not. Retry the step (re-run the script) once the cause is identified."
  info "Published to MCP Registry"
fi

# =============================================================================
# Step 8: Verify
# =============================================================================
step 8 "Verify"

# Registry propagation can lag a few seconds after publish succeeds. The earlier
# `sleep 3` + single `npm view` finished before the version was visible on a slow
# day, leaving the user with a spurious "may still be propagating" warning even
# when the release was fine. Mirror the CI smoke test's retry shape (5 attempts,
# 5s spacing) so the local flow gets the same robustness.
#
# Still warn-only on final failure: Step 8 is a verify step, not a gate -- by
# the time we're here the publish has already succeeded.
NPM_VERSION=""
for attempt in 1 2 3 4 5; do
  NPM_VERSION=$(npm view "@yawlabs/npmjs-mcp@${VERSION}" version 2>/dev/null || echo "")
  if [ "$NPM_VERSION" = "$VERSION" ]; then
    break
  fi
  if [ "$attempt" -lt 5 ]; then
    sleep 5
  fi
done

if [ "$NPM_VERSION" = "$VERSION" ]; then
  info "npm: @yawlabs/npmjs-mcp@${NPM_VERSION}"
else
  warn "npm shows ${NPM_VERSION:-nothing} (expected $VERSION -- may still be propagating)"
fi

# Post-publish smoke test: confirm a fresh install via npx can execute the
# binary and respond to --version. Catches packaging regressions (missing bin
# shebang, bad "files" entry, broken esbuild output) before they hit real
# users. Ported from the deleted release.yml smoke step.
#
# Run npx from a temp dir -- if run from the checkout root, npx sees our own
# package.json `bin` entry and tries to resolve the local (unbuilt) path
# instead of installing the published tarball.
#
# Registry propagation can lag well past a minute after publish succeeds, and
# `npm view` and `npx` may hit different CDN paths -- seeing the version via
# `npm view` doesn't guarantee the tarball is reachable from the edge `npx`
# hits a moment later. Retry the actual smoke (the npx invocation itself)
# with a budget generous enough to outlast realistic propagation.
# 30 * 10s = ~5min upper bound; typical case completes in < 30s.
SMOKE_DIR=$(mktemp -d)
SMOKE_OUTPUT=""
SMOKE_STARTED=$(date +%s)
SMOKE_ATTEMPTS=30
SMOKE_SLEEP=10
# The subshell MUST run inside an `if`. Under `set -e` a bare `( ... )` that
# exits non-zero terminates the script immediately -- `SMOKE_OK=$?` never runs
# and the warn-only branch below is unreachable, so a slow registry turns an
# already-successful release into "[FAIL] Release failed at line N". `set -e` is
# suppressed for a command used as a condition, which is what we want here:
# step 8 verifies, it does not gate.
SMOKE_OK=0
if (
  cd "$SMOKE_DIR"
  for i in $(seq 1 $SMOKE_ATTEMPTS); do
    if SMOKE_OUTPUT=$(npx -y "@yawlabs/npmjs-mcp@${VERSION}" --version 2>/dev/null); then
      echo "$SMOKE_OUTPUT" > "$SMOKE_DIR/.out"
      exit 0
    fi
    sleep $SMOKE_SLEEP
  done
  exit 1
); then
  SMOKE_OK=0
else
  SMOKE_OK=1
fi
SMOKE_ELAPSED=$(( $(date +%s) - SMOKE_STARTED ))
if [ "$SMOKE_OK" -eq 0 ] && [ -f "$SMOKE_DIR/.out" ]; then
  SMOKE_OUTPUT=$(cat "$SMOKE_DIR/.out")
  if [ "$SMOKE_OUTPUT" = "$VERSION" ]; then
    info "smoke: npx @yawlabs/npmjs-mcp@${VERSION} --version -> $SMOKE_OUTPUT (${SMOKE_ELAPSED}s)"
  else
    warn "smoke: npx returned '$SMOKE_OUTPUT' (expected $VERSION) after ${SMOKE_ELAPSED}s"
  fi
else
  warn "smoke: npx -y @yawlabs/npmjs-mcp@${VERSION} --version did not succeed after $SMOKE_ATTEMPTS attempts (${SMOKE_ELAPSED}s) -- registry propagation lag or packaging regression"
fi
rm -rf "$SMOKE_DIR"

PKG_VERSION=$(node -p "require('./package.json').version")
if [ "$PKG_VERSION" = "$VERSION" ]; then
  info "package.json: ${PKG_VERSION}"
else
  warn "package.json shows ${PKG_VERSION} (expected $VERSION)"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "git tag: v${VERSION}"
else
  warn "git tag v${VERSION} not found"
fi

# Provenance attestation check. npm attaches a sigstore attestation only when
# `npm publish --provenance` runs somewhere that can mint an OIDC token -- in
# practice, GitHub Actions. Check unconditionally rather than only under CI: on
# the workstation path the answer is "none", and that is exactly the fact worth
# surfacing (see the note in step 5). Warn-only either way; the publish already
# happened by the time we get here.
ATTEST=$(npm view "@yawlabs/npmjs-mcp@${VERSION}" dist.attestations.provenance.predicateType 2>/dev/null || echo "")
if [ -n "$ATTEST" ]; then
  info "provenance attestation: $ATTEST"
elif [ "$IS_CI" = "true" ]; then
  warn "no provenance attestation found on v${VERSION} (expected on a CI publish -- --provenance may have been dropped)"
else
  warn "v${VERSION} published WITHOUT a provenance attestation. Expected for a workstation publish: --provenance needs CI OIDC, and this repo has no release workflow (removed in b2c256c). Restore a CI publish job or an npm Trusted Publisher to get attested releases back."
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${GREEN}  v${VERSION} released successfully!${NC}"
echo ""
echo -e "  npm: https://www.npmjs.com/package/@yawlabs/npmjs-mcp"
echo -e "  git: https://github.com/YawLabs/npmjs-mcp/releases/tag/v${VERSION}"
echo ""
