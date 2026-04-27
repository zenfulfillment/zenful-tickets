#!/usr/bin/env bash
# release.sh — cut a Zenful Tickets release.
#
# Usage:
#   scripts/release.sh <version>          e.g. scripts/release.sh 0.1.6
#
# Process:
#   1. Validate semver, clean tree, fresh main
#   2. Bump version in: package.json, src-tauri/Cargo.toml,
#      src-tauri/Cargo.lock, src-tauri/tauri.conf.json
#   3. Commit "release v<version>" on main; push main
#   4. Check out the `release` branch (create from main if missing),
#      merge main, push release
#   5. Tag v<version> on release branch and push the tag → this is what
#      triggers .github/workflows/release.yml
#   6. Return to main
#
# Aborts on any of:
#   - dirty working tree
#   - tag already exists (locally or on origin)
#   - non-fast-forward pull on main / release
#   - merge conflict (resolve manually, then run again)
#
# Re-runnable from a clean state. If something fails mid-way, fix the cause
# and re-run; the version-bump commit only lands once because the working
# tree must be clean before the script starts.

set -euo pipefail

# ── colours ─────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_RESET=$'\033[0m'
else
  C_BOLD=""; C_GREEN=""; C_RED=""; C_YELLOW=""; C_RESET=""
fi

step() { echo "${C_BOLD}→${C_RESET} $*"; }
ok()   { echo "  ${C_GREEN}✓${C_RESET} $*"; }
warn() { echo "  ${C_YELLOW}!${C_RESET} $*"; }
die()  { echo "${C_RED}✗${C_RESET} $*" >&2; exit 1; }

# ── parse args ─────────────────────────────────────────
VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  cat >&2 <<EOF
usage: $0 <version>
  example: $0 0.1.6
EOF
  exit 1
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  die "'$VERSION' is not a valid semver (expected MAJOR.MINOR.PATCH[-PRE])"
fi

TAG="v$VERSION"
RELEASE_BRANCH="release"
MAIN_BRANCH="main"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── sanity checks ──────────────────────────────────────
step "preflight"
[[ -d .git ]] || die "not a git repo (run from the project root)"
[[ -z "$(git status --porcelain)" ]] || die "working tree is dirty — commit or stash first"
git rev-parse --verify "$MAIN_BRANCH" >/dev/null 2>&1 || die "no local '$MAIN_BRANCH' branch"
! git rev-parse "$TAG" >/dev/null 2>&1 || die "tag $TAG already exists locally"
if git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | grep -q "refs/tags/$TAG$"; then
  die "tag $TAG already exists on origin"
fi
ok "clean state"

# ── refresh main ───────────────────────────────────────
step "refreshing $MAIN_BRANCH"
git checkout "$MAIN_BRANCH"
git pull --ff-only origin "$MAIN_BRANCH"
ok "$MAIN_BRANCH up-to-date with origin"

# ── bump versions ──────────────────────────────────────
step "bumping version → $VERSION"

# Portable in-place sed: write to .bak then delete it. Works on both BSD
# (macOS) and GNU sed without a separate code path.
inplace() {
  local pattern="$1"; shift
  for f in "$@"; do
    [[ -f "$f" ]] || die "$f not found"
    sed -i.bak -E "$pattern" "$f"
    rm -f "$f.bak"
  done
}

# package.json — exactly one top-level "version" key.
inplace 's/("version"[[:space:]]*:[[:space:]]*)"[^"]+"/\1"'"$VERSION"'"/' package.json

# tauri.conf.json — only the top-level "version" matches; bundle.macOS uses
# "minimumSystemVersion" so it isn't caught by this pattern.
inplace 's/("version"[[:space:]]*:[[:space:]]*)"[^"]+"/\1"'"$VERSION"'"/' src-tauri/tauri.conf.json

# Cargo.toml — line-anchored so dependency declarations like
# `tauri = { version = "2", features = [...] }` are NOT matched (they don't
# start at column 0).
inplace 's/^version = "[^"]+"$/version = "'"$VERSION"'"/' src-tauri/Cargo.toml

# Cargo.lock — bump only the `name = "zenfultickets"` block. The /…/{n;s/…/}
# idiom advances to the next line then substitutes there, so we don't
# accidentally rewrite some other crate's version line.
inplace '/^name = "zenfultickets"$/{n;s/^version = "[^"]+"$/version = "'"$VERSION"'"/;}' src-tauri/Cargo.lock

ok "package.json"
ok "src-tauri/Cargo.toml"
ok "src-tauri/Cargo.lock"
ok "src-tauri/tauri.conf.json"

if git diff --quiet; then
  die "no files changed — version may already be $VERSION, or a sed pattern didn't match"
fi

# ── commit on main ─────────────────────────────────────
step "committing release bump on $MAIN_BRANCH"
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "release $TAG"
ok "committed"

step "pushing $MAIN_BRANCH"
git push origin "$MAIN_BRANCH"
ok "$MAIN_BRANCH pushed"

# ── update release branch ──────────────────────────────
step "updating $RELEASE_BRANCH"
if git show-ref --verify --quiet "refs/heads/$RELEASE_BRANCH"; then
  git checkout "$RELEASE_BRANCH"
  if git ls-remote --heads origin "$RELEASE_BRANCH" 2>/dev/null | grep -q "$RELEASE_BRANCH"; then
    git pull --ff-only origin "$RELEASE_BRANCH"
  fi
elif git ls-remote --heads origin "$RELEASE_BRANCH" 2>/dev/null | grep -q "$RELEASE_BRANCH"; then
  git fetch origin "$RELEASE_BRANCH:$RELEASE_BRANCH"
  git checkout "$RELEASE_BRANCH"
else
  warn "'$RELEASE_BRANCH' doesn't exist — creating it from $MAIN_BRANCH"
  git checkout -b "$RELEASE_BRANCH"
fi

# Merge main. When we just created the release branch (or it's already at
# main's HEAD), git reports "Already up to date" and skips the merge commit;
# that's fine — the tag still points at the right SHA.
if ! git merge --no-ff "$MAIN_BRANCH" -m "merge $MAIN_BRANCH into $RELEASE_BRANCH for $TAG"; then
  die "merge conflict on $RELEASE_BRANCH — resolve manually, commit, then re-run from the tag step:
    git tag -a $TAG -m '$TAG'
    git push origin $RELEASE_BRANCH
    git push origin $TAG"
fi
ok "merged $MAIN_BRANCH"

# ── tag + push ─────────────────────────────────────────
step "tagging $TAG"
git tag -a "$TAG" -m "$TAG"
ok "tag created"

step "pushing $RELEASE_BRANCH and $TAG"
git push origin "$RELEASE_BRANCH"
git push origin "$TAG"
ok "release branch + tag pushed → CI workflow will run"

# ── back to main ───────────────────────────────────────
step "returning to $MAIN_BRANCH"
git checkout "$MAIN_BRANCH"
ok "done"

cat <<EOF

${C_GREEN}${C_BOLD}✓ Release $TAG cut${C_RESET}

Watch the build:
  https://github.com/zenfulfillment/zenful-tickets/actions

Once the workflow finishes, the release lands at:
  https://github.com/zenfulfillment/zenful-tickets/releases/tag/$TAG
EOF
