---
name: release
description: Cut a new zenfultickets release. Generates a CHANGELOG.md entry from commits since the last tag, bundles it into the version-bump commit via scripts/release.sh, and publishes the same notes to the GitHub release. Use when the user says "release", "ship a release", "/release", "cut v0.1.X", or otherwise wants to publish a new version.
model: sonnet
---

# Release skill

Cuts a new release end-to-end. The user invokes this when they want to ship.
The existing `scripts/release.sh` handles version-bumping, tagging, and CI
trigger; this skill adds the **CHANGELOG generation** and **GitHub release
notes** layer on top.

## Inputs

The user typically says one of:

- `/release 0.1.11` — explicit version
- `/release patch` / `minor` / `major` — bump kind, infer the version
- `/release` — ask the user, but suggest a version based on conventional
  commit types since the last tag (`feat:` → minor; only `fix:`/`chore:` → patch)

## Pipeline

Execute these steps in order. Stop on any failure and surface a clear
error — do not skip to the next step.

### 1. Preflight

Run these checks **in parallel**:

```bash
git rev-parse --abbrev-ref HEAD       # must be 'main'
git status --porcelain                # must be empty (CHANGELOG.md edits come later)
git fetch --tags origin               # ensure local tags are up to date
git describe --tags --abbrev=0        # last tag, e.g. v0.1.10
```

Refuse to proceed if:
- Not on `main`.
- Working tree dirty (the user must commit/stash first).
- The proposed `vX.Y.Z` tag already exists locally or on origin
  (`git ls-remote --tags origin "refs/tags/vX.Y.Z"`).

### 2. Collect commits since the last tag

```bash
LAST_TAG="$(git describe --tags --abbrev=0)"
git log "$LAST_TAG"..HEAD --pretty=format:'%H%x09%s%x09%b%x1e' --no-merges
```

The `%x1e` (record separator) and `%x09` (tab) lets you safely split out
hash / subject / body even when bodies contain newlines.

### 3. Categorize commits

Bucket each subject by Conventional Commit type prefix:

| Prefix              | CHANGELOG section | Notes |
|---------------------|-------------------|-------|
| `feat:` / `feat(*)` | **Added**         | User-facing new capability |
| `fix:` / `fix(*)`   | **Fixed**         | Bug fix |
| `perf:`             | **Changed**       | Performance change worth surfacing |
| `refactor:`         | **Changed**       | Only if user-visible — usually skip |
| `docs:`             | skip              | Internal-only unless docs are user-facing |
| `chore(CI):`, `ci:` | **Internal**      | Or skip entirely on patch releases |
| `chore:`            | **Internal**      | Skip from user-facing notes |
| `style:` / `test:`  | skip              | |
| Bare `release vX.Y.Z` subjects | skip | These are old release bumps mid-window — not changelog content |

Drop the prefix when writing the bullet (`feat: implement attachments`
becomes `Implement attachments`). Capitalize the first letter, no trailing
period.

If a commit doesn't match any pattern, include it under **Changed** with
the full subject — better to over-include than silently lose history.

### 4. Decide the new version

If the user gave an explicit version, use it. Otherwise infer from buckets:

- **major** — any `feat!:` / `fix!:` / `BREAKING CHANGE:` in the body.
- **minor** — any `feat:` since last tag.
- **patch** — only `fix:` / `chore:` / `perf:` / `refactor:`.

When inferring, **show the user the proposed version + the commit list**
and ask for confirmation before continuing.

### 5. Write CHANGELOG.md

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
If `CHANGELOG.md` does not exist, create it with this header:

```markdown
# Changelog

All notable changes to zenfultickets are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
```

Insert the new version block **immediately after** `## [Unreleased]`:

```markdown
## [0.1.11] — 2026-04-28

### Added
- ...

### Changed
- ...

### Fixed
- ...

### Internal
- ...
```

Rules:
- Use today's date in `YYYY-MM-DD` (run `date +%Y-%m-%d`).
- Omit any subsection (Added/Changed/Fixed/Internal) that has no entries.
- Keep bullets short (≤ 100 chars). For long commit subjects, summarize.
- For commits with a scope like `fix(win):`, prefix the bullet:
  `**Windows:** Fix keyring issue on Windows builds`.

After writing, **stage but do not commit**:

```bash
git add CHANGELOG.md
```

### 6. Cut the release

`scripts/release.sh` is idempotent-on-failure and now allows a pre-staged
`CHANGELOG.md` (it's bundled into the version-bump commit):

```bash
./scripts/release.sh 0.1.11
```

The script handles: bumping `package.json`, `Cargo.toml`, `Cargo.lock`,
`tauri.conf.json`; committing on `main`; merging into `release`; tagging;
pushing both branches and the tag.

If the script dies (merge conflict, etc), surface the error verbatim —
**do not** try to clean up or amend; the user resolves manually.

### 7. Wait for the draft release to appear, then publish notes

CI creates a draft GitHub release as soon as the workflow starts. Poll
for it (up to ~90 s):

```bash
TAG="v0.1.11"
for i in $(seq 1 30); do
  if gh release view "$TAG" --repo zenfulfillment/zenful-tickets >/dev/null 2>&1; then
    break
  fi
  sleep 3
done
```

Extract the just-written CHANGELOG section for this version (everything
between `## [0.1.11]` and the next `## [` heading), then push it as the
release body:

```bash
# `awk` extracts the latest section. The body for `gh release edit
# --notes-file` accepts Markdown directly.
awk -v tag="$TAG" '
  $0 ~ "^## \\[" substr(tag, 2) "\\]" { found=1; next }
  found && /^## \[/ { exit }
  found { print }
' CHANGELOG.md > /tmp/release-notes.md

gh release edit "$TAG" \
  --repo zenfulfillment/zenful-tickets \
  --notes-file /tmp/release-notes.md
```

Note: the release stays a *draft* until the build matrix uploads all
artifacts; the workflow's final step (`gh release edit --draft=false`)
publishes it. Editing the body of a draft is fine — the body is preserved
when the draft is published.

### 8. Report

Tell the user:
- New version cut: `vX.Y.Z`.
- CHANGELOG section that was published (or a summary).
- Link to the GitHub Actions run: `https://github.com/zenfulfillment/zenful-tickets/actions`.
- Link to the release: `https://github.com/zenfulfillment/zenful-tickets/releases/tag/vX.Y.Z`.

## Edge cases

- **No commits since last tag.** Refuse — there's nothing to release.
- **Only `chore:` / `docs:` commits and the user asked for `minor` or
  `major`.** Warn but obey — the user knows.
- **`gh` CLI not authenticated.** Surface the error from `gh auth status`
  and stop. The user must `gh auth login` first.
- **CHANGELOG.md already has a section for the proposed version.** Refuse —
  most likely a half-finished previous attempt; ask the user what to do.
- **Repository slug.** `zenfulfillment/zenful-tickets` (note the hyphen) —
  this is the GitHub repo, distinct from the on-disk dir name `zenfultickets`.

## Don't

- Don't `git push --force` anything. Ever.
- Don't auto-resolve a merge conflict on the `release` branch — that's
  the user's call.
- Don't strip security or breaking-change notes to keep the changelog
  short. Truncate, but always include them.
- Don't include the bare `release vX.Y.Z` commits (the previous
  release-bump commits) in the changelog — they're scaffolding, not changes.
