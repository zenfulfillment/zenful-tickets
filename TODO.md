# zenfultickets — MVP implementation TODO

Living checklist. Update as you go. Format: `- [ ]` pending, `- [~]` in progress, `- [x]` done.

---

## Architecture decisions (locked)

| Concern | Decision |
|---|---|
| Desktop framework | Tauri 2 + React 19 + TypeScript + Vite |
| Package manager | pnpm |
| Styling | Tailwind v4 (Vite plugin) + ported design tokens from `_design/styles.css` |
| State | Zustand (global) + local `useState` for UI state |
| Screen graph | Stateful switch (Onboarding → Main → Draft → Settings) — no router |
| Window chrome | Native macOS chrome (decorations: true) |
| Secrets | `keyring` crate, single macOS Keychain item holding `{ jira_token, gemini_key, anthropic_key, openai_key }` JSON blob → single auth prompt |
| Non-secret storage | `tauri-plugin-store` (`store.json`) |
| AI — Claude/Codex | Local CLIs spawned via `tokio::process::Command` (stream stdout → frontend via events). **Not** `tauri-plugin-shell` (dynamic prompts don't fit its scoped-command model). |
| AI — Gemini | Rust-side `reqwest` SSE stream → Tauri events |
| AI output contract | Free-form prose streamed live + final fenced JSON block `{title, description, type, priority, labels, acceptance_criteria[], tech_notes}` parsed on completion |
| Voice | Webview captures mic (Web Audio API → PCM16 @ 16kHz) → Rust holds ElevenLabs Scribe V2 Realtime WebSocket → transcript events back to webview. Key via `option_env!("ELEVENLABS_API_KEY")` from `.env.build`. |
| Jira | REST API v3 with ADF for description (markdown → ADF converter). Attachments via `reqwest::multipart` with `X-Atlassian-Token: no-check`. Project/type/priority/epic lists fetched on entering Draft, cached for session. |
| Global hotkey | ⌘⇧K via `tauri-plugin-global-shortcut` (paired with `single-instance` to prevent double-registration) |
| Auto-update | `tauri-plugin-updater` + `tauri-plugin-process` for restart. Signing key and release endpoint deferred to post-MVP config. |

## Tauri plugins adopted

| Plugin | Why |
|---|---|
| `autostart` | Launch-at-login toggle in Settings |
| `clipboard-manager` | Copy created ticket URL |
| `dialog` | Native screenshot/document picker |
| `global-shortcut` | ⌘⇧K summon |
| `log` | Rotating file + stdout logging |
| `notification` | "Ticket created → ABC-123" toasts |
| `opener` | Open Jira ticket in browser (scoped to `https://*.atlassian.net/*`) |
| `os` | About screen OS info |
| `process` | `restart()` after update install |
| `single-instance` | Prevent two instances racing on the global hotkey |
| `store` | Non-secret persistence |
| `updater` | Signed auto-updates (endpoint/key deferred) |
| `window-state` | Restore window size/position |

Explicitly **not** adopted: `cli`, `fs`, `http`, `shell`, `stronghold`, `upload`, `persisted-scope`, `deep-link` (all rejected with rationale in-session).

---

## Phase 0 — Build infrastructure

- [x] `package.json` — React 19, Zustand, Tailwind v4, plugin JS packages
- [x] `vite.config.ts` — Tailwind plugin
- [x] `scripts/build.sh` — loads `.env.build` before `tauri build`
- [x] `src-tauri/Cargo.toml` — deps (needs revision for full plugin set)
- [x] `src-tauri/tauri.conf.json` — native chrome, minimum macOS 11, CSP
- [x] `src-tauri/entitlements.plist` — mic + network client
- [ ] `src-tauri/capabilities/default.json` — full plugin permission set
- [ ] `src/styles/index.css` — port design tokens from `_design/styles.css`

## Phase 1 — Rust backend

### 1.1 Skeleton & infra
- [ ] `src-tauri/src/error.rs` — typed `AppError` with `serde::Serialize`
- [ ] `src-tauri/src/state.rs` — shared app state (HTTP client, in-flight request map)
- [ ] `src-tauri/src/lib.rs` — plugin registration, command wiring, `setup()`

### 1.2 Secrets (keychain)
- [ ] `src-tauri/src/secrets.rs` — load/save/delete single JSON blob via `keyring`
- [ ] Commands: `secrets_load`, `secrets_save`, `secrets_clear`

### 1.3 Jira client
- [ ] `src-tauri/src/jira/mod.rs` — HTTP client, basic auth
- [ ] `src-tauri/src/jira/adf.rs` — markdown → ADF converter (headings, paragraphs, lists, code, links, bold/italic)
- [ ] `src-tauri/src/jira/types.rs` — request/response DTOs
- [ ] Commands: `jira_verify`, `jira_list_projects`, `jira_list_issue_types`, `jira_list_priorities`, `jira_list_epics`, `jira_create_issue`, `jira_upload_attachment`

### 1.4 AI
- [ ] `src-tauri/src/ai/mod.rs` — dispatcher (Claude/Codex/Gemini)
- [ ] `src-tauri/src/ai/cli.rs` — detect + stream-spawn `claude -p` and `codex exec`
- [ ] `src-tauri/src/ai/gemini.rs` — Gemini 2.5 Pro SSE streaming
- [ ] `src-tauri/src/ai/prompt.rs` — system prompt builder (PO/DEV modes, JSON output schema)
- [ ] Commands: `ai_detect_clis`, `ai_draft` (streams via event `ai:chunk:{requestId}` + `ai:done:{requestId}`), `ai_cancel`

### 1.5 Voice (ElevenLabs Scribe V2 Realtime)
- [ ] `src-tauri/src/speech.rs` — WebSocket client, audio chunk forwarding, transcript events
- [ ] Commands: `speech_start`, `speech_stop`, `speech_send_chunk`

### 1.6 Global shortcut + window management
- [ ] Register ⌘⇧K in `setup()` → focus/show main window
- [ ] Single-instance handler → focus existing window on relaunch

## Phase 2 — Frontend

### 2.1 Foundation
- [ ] `src/main.tsx`, `src/App.tsx` — screen switcher + global hotkey listener
- [ ] `src/types.ts` — DTOs matching Rust
- [ ] `src/store.ts` — Zustand (settings, onboarding, currentDraft, screen)
- [ ] `src/lib/tauri.ts` — typed `invoke` + event helpers
- [ ] `src/lib/voice.ts` — mic capture → PCM16 → Rust
- [ ] `src/lib/theme.ts` — system/light/dark application

### 2.2 Primitives (ported from `_design/`)
- [ ] `src/components/Icon.tsx`
- [ ] `src/components/SiriOrb.tsx`
- [ ] `src/components/Background.tsx` (grid + noise + aurora)
- [ ] `src/components/primitives/Button.tsx`, `Input.tsx`, `Textarea.tsx`, `Segmented.tsx`, `Toggle.tsx`, `Menu.tsx`, `Chip.tsx`, `Kbd.tsx`, `Spinner.tsx`
- [ ] `src/components/primitives/Scrollable.tsx`

### 2.3 Screens
- [ ] `src/screens/Onboarding/index.tsx` — step orchestration + animations
- [ ] `src/screens/Onboarding/Welcome.tsx`
- [ ] `src/screens/Onboarding/Jira.tsx` — verify connection, save token to keychain
- [ ] `src/screens/Onboarding/AI.tsx` — CLI detection display, Gemini key capture
- [ ] `src/screens/Onboarding/Ready.tsx`
- [ ] `src/screens/Main.tsx` — prompt input, voice, model picker, PO/DEV segmented, headline rotator
- [ ] `src/screens/Draft.tsx` — streaming draft, editable fields, refine input, create button
- [ ] `src/screens/Settings/index.tsx` — sidebar + sections
- [ ] `src/screens/Settings/General.tsx`
- [ ] `src/screens/Settings/Jira.tsx`
- [ ] `src/screens/Settings/AI.tsx`
- [ ] `src/screens/Settings/Drafting.tsx`
- [ ] `src/screens/Settings/About.tsx`

### 2.4 Wire-up
- [ ] Onboarding completion → writes flag to store → gates main app
- [ ] Jira verify round-trip during Jira step
- [ ] Draft: on prompt submit, call `ai_draft` → stream to UI → parse JSON → populate fields
- [ ] Draft: on create, call `jira_create_issue` + optional `jira_upload_attachment` per attachment → show toast → copy URL
- [ ] Settings: every toggle persists to store (live), "Disconnect Jira" clears keychain entry for that field
- [ ] Theme switch updates `document.documentElement.dataset.theme`
- [ ] Global hotkey focuses main window from background

## Phase 3 — Verification

- [x] `pnpm install` succeeds (375 crates / all JS deps resolved)
- [x] `pnpm build` (tsc + vite) passes — zero errors, zero warnings, ~548 KB JS / 21 KB CSS
- [x] `cargo check` in `src-tauri/` passes — zero errors, zero warnings
- [ ] `pnpm tauri dev` smoke test (manual — first launch will prompt for mic + accessibility permissions)
- [ ] End-to-end Jira ticket creation against a real workspace (manual)

---

## Deferred to post-MVP

- Draft history / session persistence
- Deep-link `zenfultickets://` scheme
- Auto-submit-after-silence voice behavior
- Multi-project / board picker inside draft (currently just the default)
- Claude CLI `--output-format stream-json` parsing beyond token chunks
- Menubar mode (currently always-on window)

## Updater release flow

- Signing key was generated locally to `~/.tauri/zenfultickets.key` (never commit).
- Private key contents → `.env.build` as `TAURI_SIGNING_PRIVATE_KEY` (used by `scripts/build.sh`).
- Public key → `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
- Endpoint → GitHub Releases redirect: `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`.
- Update `<owner>/<repo>` in `tauri.conf.json` to match the actual GitHub repo before the first release.
- For CI releases, mirror the three secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `ELEVENLABS_API_KEY`) into GitHub Actions secrets.
- Push a `v*` tag to trigger `.github/workflows/release.yml` → cuts a release for macOS arm64+x64, Linux x64, Windows x64.

---

## Runbook

```bash
pnpm install
pnpm tauri dev          # full stack dev
pnpm build              # typecheck only
cd src-tauri && cargo check
./scripts/build.sh      # production bundle (loads .env.build)
```
