# Changelog

All notable changes to zenfultickets are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
