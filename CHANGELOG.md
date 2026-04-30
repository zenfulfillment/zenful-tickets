# Changelog

All notable changes to zenfultickets are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.13] — 2026-04-30

### Added
- **Main screen reference picker**: add reference folders on the Main screen before sending to the AI (DEV mode), not just on the Draft screen
- **Motion-powered tooltips**: custom global tooltip with spring animation (fade + scale), single shared overlay, max-width constraint, and structured two-line layout with mono font
- **Shadcn theme tokens**: full Tailwind CSS v4 theme token integration (background, foreground, card, popover, primary, muted, destructive, ring) mapped to the existing design system palette

### Fixed
- **macOS CI**: switch to universal binary (`--target universal-apple-darwin`) instead of separate arm64/x64 cross-compilation — fixes "This app is broken" error on M-series Macs

## [0.1.12] — 2026-04-30

### Added
- **OpenCode CLI**: new AI provider with dynamic model catalog (~50 models), disk caching, background refresh, and manual refresh button in the picker
- **Onboarding**: OpenCode CLI detection and setup step alongside Claude, Codex, and Gemini
- **DEV mode reference files**: local source code paths injected into the AI prompt as analysis context (read-only, never uploaded to Jira)
- **DEV/PO prompt overhaul**: DEV voice rewritten as senior tech lead with Technical Approach, Dependencies, Testing Strategy, and Risks sections; PO voice enhanced with Success Metrics and User Impact Scope

### Fixed
- **Windows**: terminal window no longer flashes during CLI execution (missing `CommandExt` import for `CREATE_NO_WINDOW`)

## [0.1.11] — 2026-04-28

### Added
- **OpenRouter**: streaming completions and live model catalog (~300 models) behind one API key
- **OpenRouter model picker**: models grouped by vendor with substring search and live hot-swap
- **OpenRouter Settings**: API key input with save / clear; triggers immediate catalog refresh
- **ProviderIcon**: brand SVG marks for all providers, replacing single-character placeholders
- Vision-attachment guard checks the chosen OpenRouter model's `input_modalities` before warning

### Internal
- Release script accepts a pre-staged CHANGELOG.md so notes ship inside the bump commit
- Added `/release` skill for automated changelog generation and GitHub release notes publishing
