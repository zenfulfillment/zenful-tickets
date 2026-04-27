# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**zenfultickets** is a Tauri 2 desktop app (macOS-first) for drafting product/engineering tickets from a chat-style prompt, with selectable LLM backends (Anthropic, OpenAI, Google). The shipping app is named "zenfultickets"; the design mockups use the working title "Ticketmaster".

The repo is in early-stage scaffolding: `src/` still contains the Tauri starter (a `greet` invoke demo), while `_design/` already contains a complete, opinionated set of UI mockups for Onboarding → Main → Draft → Settings.

**`_design/` is a visual reference only.** Follow the layout, typography, color, spacing, motion, and component shapes exactly — but do **not** port the JSX wholesale. All state management, event wiring, side effects, data flow, and IPC integration must be designed fresh to fit the real app architecture (React 19 + TS + Tauri commands), not copied from the mockup's ad-hoc `React.useState` patterns. Treat the mockups as Figma frames that happen to be runnable in a browser.

## Commands

Package manager is **pnpm** (configured in `tauri.conf.json` `beforeDevCommand`/`beforeBuildCommand`).

```bash
pnpm install              # install JS deps
pnpm tauri dev            # run the desktop app (spawns vite + cargo)
pnpm tauri build          # produce a signed/bundled desktop binary
pnpm dev                  # vite-only (web preview, no Rust); port 1420 strict
pnpm build                # tsc --noEmit + vite build (typecheck gate)
```

There is no test runner, linter, or formatter wired up yet — `pnpm build` is the only quality gate (TypeScript strict mode + `noUnusedLocals`/`noUnusedParameters`).

For Rust-side work: `cd src-tauri && cargo check` / `cargo build`. Tauri's dev server expects port **1420** to be free; if `pnpm dev` fails because the port is taken, kill the holder rather than changing the port (Tauri loads `devUrl: http://localhost:1420` from `tauri.conf.json`).

The standalone design mockups in `_design/` run entirely in a browser via Babel/Tailwind CDNs — open `_design/Ticketmaster.html` directly. They are **not** wired into vite or Tauri.

## Architecture

### Two-process model (Tauri)

- **Frontend** (`src/`, React 19 + TS, bundled by Vite): the webview UI. Calls into Rust via `invoke("command_name", args)` from `@tauri-apps/api/core`.
- **Backend** (`src-tauri/`, Rust): native side. Commands are `#[tauri::command]` functions registered in `invoke_handler![...]` inside `src-tauri/src/lib.rs::run()`. `src-tauri/src/main.rs` is a thin entry that calls `zenfultickets_lib::run()`.

When adding a Tauri command: define the `#[tauri::command]` fn in `lib.rs`, add it to `tauri::generate_handler![...]`, then call from TS via `invoke()`. Type the TS side manually — there is no codegen.

### Capabilities and CSP

- `src-tauri/capabilities/default.json` controls which Tauri APIs the `main` window can call. Currently grants only `core:default` + `opener:default`. Adding new plugins (fs, shell, http, etc.) requires both a Cargo dep, a `.plugin(...)` registration in `lib.rs`, **and** a permission entry here — missing any of the three results in a runtime IPC rejection.
- `tauri.conf.json` has `"csp": null` (dev-permissive). Tighten before shipping; the `tauri` skill in `.agents/skills/tauri/` documents the threat model.

### Frontend structure (planned)

The `_design/` files indicate the eventual screen graph: Onboarding → Main → Draft → Settings, with a draft context carrying `{ prompt, mode: 'PO'|'DEV', model }` between Main and Draft. The mockup's `App` switcher and `useState`-everywhere approach are illustrative only — the real implementation should use proper routing/state primitives that fit the production architecture (router, typed stores, Tauri command boundaries).

Reusable visual signals to mine from `_design/` (style only, reimplement the logic):
- `siri-orb.jsx` — the audio/typing-reactive orb visual
- `primitives.jsx` — base component shapes
- `tweaks-panel.jsx` — dev-only tweak overlay (the `EDITMODE-BEGIN/END` markers in `Ticketmaster.html` are sentinels for an external mockup editor; preserve them if you edit that file)
- `MODELS` array in `main-screen.jsx` — vendor/model identifier reference for the LLM layer

## Skills convention

`.agents/skills/{tauri,rust,rust-errors}/` hold project-specific agent skills, and `.claude/skills/` symlinks to them so Claude Code picks them up automatically. The `tauri` skill is marked HIGH-RISK and contains CVE-backed guidance on IPC security, capabilities, and CSP — consult it before changing `capabilities/`, adding plugins, or touching the `invoke_handler` surface.
