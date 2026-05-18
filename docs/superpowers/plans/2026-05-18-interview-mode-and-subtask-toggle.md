# Interview Mode + Subtask Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Interview Mode checkbox on Main that routes through a new chat-style Interview screen before drafting, plus a per-draft "Split into subtasks" sidebar switch with a global default in Settings.

**Architecture:** Frontend adds a new `"interview"` Screen with a chat thread that calls a new `ai_interview` Tauri command (stateless replay each turn, mirrors `ai_draft`'s streaming event surface). On "Generate ticket" the transcript stays in-memory and is forwarded into the existing `ai_draft` pipeline via a new optional `interview_transcript` field that the prompt builder splices in as authoritative context. After a successful Jira publish, `Draft.tsx::handleCreate` fires `ticket_save_history` to write `${appDataDir}/tickets/<uuid>.md` with the full ticket record (frontmatter metadata + initial prompt + transcript if any + final description + sub-task bodies). Subtask toggle is a session-only `useState` on Draft initialized from a new global `splitIntoSubtasks` setting; flipping it gates the existing create-pipeline subtask steps.

**Tech Stack:** React 19 + TypeScript + Zustand + `tauri-plugin-store` (frontend); Rust + Tauri + tokio mpsc/oneshot streaming (backend); existing AI provider plumbing (Claude/Codex/Gemini/OpenRouter/OpenCode).

**Reference spec:** `docs/superpowers/specs/2026-05-18-interview-mode-and-subtask-toggle-design.md`.

**Project gate:** No test runner is wired in this repo. The only automated quality gate is `pnpm build` (TypeScript strict mode + Vite build). Each task ends with a `pnpm build` step plus, where relevant, a manual smoke step run by the engineer in `pnpm tauri dev`. Rust changes also need `cd src-tauri && cargo check`.

---

## File map

| File | Responsibility | Mode |
|---|---|---|
| `src/types.ts` | Settings schema (`interviewMode`, `splitIntoSubtasks`), `InterviewMessage`, `AiInterviewRequest`, `SavedSubtask`, `SaveHistoryPayload`, `SaveHistoryResult`, `DraftContext.interview_transcript`, `DraftArgs.interview_transcript`. | modify |
| `src/store.ts` | `Screen` adds `"interview"`. New `interviewCtx`, `openInterview`, `closeInterview`, `promoteInterviewToDraft`. | modify |
| `src/lib/tauri.ts` | `aiInterview`, `listenInterview`, `ticketSaveHistory` wrappers + types. | modify |
| `src/App.tsx` | Render `<Interview/>` when `screen === "interview"`. | modify |
| `src/screens/Main.tsx` | Interview Mode pill above textarea; route submit between `openInterview` / `openDraft`. | modify |
| `src/screens/Interview.tsx` | NEW. Chat thread, reply composer, Generate button, ready sentinel handling. | create |
| `src/screens/Draft.tsx` | Local `splitIntoSubtasksLocal` state + sidebar switch row + pipeline gate; forward `ctx.interview_transcript` into `aiDraft`; call `ticketSaveHistory` after the create pipeline succeeds. | modify |
| `src/screens/Settings.tsx` | Drafting section row: "Split tickets into subtasks by default". | modify |
| `src-tauri/src/ai/mod.rs` | `InterviewMessage`, `InterviewRequest`, `ai_interview` command; extend `DraftRequest` with `interview_transcript`; pass it into `build_user_prompt`. | modify |
| `src-tauri/src/ai/prompt.rs` | `build_interview_prompt`, `build_interview_user_prompt`; extend `build_user_prompt` to accept transcript. | modify |
| `src-tauri/src/history.rs` | NEW. `SaveHistoryRequest`, `SavedSubtask`, `SaveHistoryResult`, `ticket_save_history` command + Markdown writer. | create |
| `src-tauri/src/lib.rs` | `mod history;`; register `ai::ai_interview`, `history::ticket_save_history` in `generate_handler!`. | modify |

---

## Task 1: Add new settings fields to schema

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Extend `AppSettings` and `DEFAULT_SETTINGS`**

In `src/types.ts`, find `AppSettings`. Add two fields under the "drafting" section comment (next to `submitOnEnter`):

```ts
  // drafting
  defaultMode: "PO" | "DEV";
  submitOnEnter: boolean;
  /** When true, submit on Main routes through the Interview screen
   *  before the Draft screen. The state is persisted purely for
   *  stickiness across sessions — same pattern as `defaultMode`. */
  interviewMode: boolean;
  /** Global default for whether Draft's create pipeline runs the
   *  sub-task expansion + creation steps. The Draft sidebar has a
   *  session-only override that copies this value on mount and does
   *  NOT write back. */
  splitIntoSubtasks: boolean;
  tone: "concise" | "balanced" | "detailed";
```

Then in `DEFAULT_SETTINGS` add the matching defaults (place them next to `submitOnEnter`):

```ts
  submitOnEnter: true,
  interviewMode: false,
  splitIntoSubtasks: true,
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm build`
Expected: PASS — no TypeScript errors. Vite build emits bundles.

(Existing `hydrate()` in `src/store.ts` already merges stored settings over `DEFAULT_SETTINGS`, so absent keys hydrate to the new defaults automatically. No migration code needed.)

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(settings): add interviewMode and splitIntoSubtasks fields"
```

---

## Task 2: Add interview transcript types and extend draft context

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add interview-related TS types**

In `src/types.ts`, append a new section just below `ParsedTicket`:

```ts
/**
 * One message in the Interview screen's chat thread. The role string
 * matches the chat-completions convention so it can be mapped 1:1 onto
 * provider-native chat arrays if we ever move off stateless replay.
 */
export interface InterviewMessage {
  role: "user" | "assistant";
  content: string;
  /** Unix milliseconds. Used for transcript ordering + frontmatter timestamp. */
  ts: number;
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add InterviewMessage type"
```

---

## Task 3: Backend — history module skeleton + ticket writer

**Files:**
- Create: `src-tauri/src/history.rs`
- Modify: `src-tauri/src/lib.rs:1-30` (add `pub mod history;`)

- [ ] **Step 1: Create `src-tauri/src/history.rs`**

Write this file:

```rust
//! Per-ticket history records.
//!
//! Called from `Draft.tsx::handleCreate` after a successful Jira publish.
//! Writes `${appDataDir}/tickets/<uuid>.md` with YAML frontmatter (every
//! field a future Ticket History UI needs to render a list view) plus a
//! Markdown body with the initial prompt, the interview transcript (if
//! any), the final description that was sent to Jira, and the sub-task
//! bodies.
//!
//! Privacy: same posture as other on-disk app data — secrets live in the
//! Keychain, everything else is plaintext under the app data dir. The
//! Ticket History UI spec will add explicit delete/prune UI.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct SavedSubtask {
    pub jira_key: String,
    pub title: String,
    #[serde(default)]
    pub description_markdown: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SaveHistoryRequest {
    pub jira_key: String,
    #[serde(default)]
    pub jira_url: Option<String>,
    pub provider: String,
    pub mode: String,
    #[serde(default)]
    pub model: Option<String>,
    pub project_key: String,
    pub issue_type: String,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub epic_key: Option<String>,
    #[serde(default)]
    pub assignee_account_id: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub subtask_keys: Vec<String>,
    pub title: String,
    pub initial_prompt: String,
    #[serde(default)]
    pub interview_transcript: Option<String>,
    pub description_markdown: String,
    #[serde(default)]
    pub subtasks: Vec<SavedSubtask>,
}

#[derive(Debug, Serialize)]
pub struct SaveHistoryResult {
    pub path: String,
    pub id: String,
}

#[tauri::command]
pub async fn ticket_save_history(
    app: AppHandle,
    req: SaveHistoryRequest,
) -> AppResult<SaveHistoryResult> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("app_data_dir: {e}")))?
        .join("tickets");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::Internal(format!("mkdir tickets: {e}")))?;

    let id = Uuid::new_v4().to_string();
    let path: PathBuf = dir.join(format!("{id}.md"));

    let body = render_history_markdown(&id, &req);

    tokio::fs::write(&path, body.as_bytes())
        .await
        .map_err(|e| AppError::Internal(format!("write ticket history: {e}")))?;

    log::info!(
        "ticket_save_history: id={} jira_key={} mode={} bytes={} path={}",
        id,
        req.jira_key,
        req.mode,
        body.len(),
        path.display()
    );

    Ok(SaveHistoryResult {
        path: path.to_string_lossy().into_owned(),
        id,
    })
}

fn render_history_markdown(id: &str, req: &SaveHistoryRequest) -> String {
    let now = chrono::Utc::now().to_rfc3339();
    let had_interview = req.interview_transcript.is_some();

    let mut out = String::with_capacity(
        2048
            + req.initial_prompt.len()
            + req.description_markdown.len()
            + req
                .interview_transcript
                .as_ref()
                .map(|s| s.len())
                .unwrap_or(0)
            + req
                .subtasks
                .iter()
                .map(|s| s.title.len() + s.description_markdown.as_deref().unwrap_or("").len() + 64)
                .sum::<usize>(),
    );

    out.push_str("---\n");
    out.push_str(&format!("id: {id}\n"));
    out.push_str(&format!("created: {now}\n"));
    out.push_str(&format!("jira_key: {}\n", req.jira_key));
    if let Some(url) = &req.jira_url {
        out.push_str(&format!("jira_url: {url}\n"));
    }
    out.push_str(&format!("mode: {}\n", req.mode));
    out.push_str(&format!("provider: {}\n", req.provider));
    if let Some(model) = &req.model {
        out.push_str(&format!("model: {model}\n"));
    }
    out.push_str(&format!("project_key: {}\n", req.project_key));
    out.push_str(&format!("issue_type: {}\n", req.issue_type));
    if let Some(p) = &req.priority {
        out.push_str(&format!("priority: {p}\n"));
    }
    if let Some(e) = &req.epic_key {
        out.push_str(&format!("epic_key: {e}\n"));
    }
    if let Some(a) = &req.assignee_account_id {
        out.push_str(&format!("assignee_account_id: {a}\n"));
    }
    if !req.labels.is_empty() {
        out.push_str("labels:\n");
        for l in &req.labels {
            out.push_str(&format!("  - {l}\n"));
        }
    }
    if !req.subtask_keys.is_empty() {
        out.push_str("subtask_keys:\n");
        for k in &req.subtask_keys {
            out.push_str(&format!("  - {k}\n"));
        }
    }
    out.push_str(&format!("had_interview: {had_interview}\n"));
    out.push_str("title: |\n");
    out.push_str(&indent_yaml_block(&req.title));
    if !req.title.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("---\n\n");

    out.push_str("# Initial prompt\n\n");
    out.push_str(req.initial_prompt.trim_end());
    out.push_str("\n\n");

    if let Some(t) = &req.interview_transcript {
        out.push_str("# Interview transcript\n\n");
        out.push_str(t.trim_end());
        out.push_str("\n\n");
    }

    out.push_str("# Final ticket description\n\n");
    out.push_str(req.description_markdown.trim_end());
    out.push_str("\n\n");

    if !req.subtasks.is_empty() {
        out.push_str("# Subtasks\n\n");
        for st in &req.subtasks {
            out.push_str(&format!("## {} — {}\n\n", st.jira_key, st.title));
            if let Some(body) = &st.description_markdown {
                let trimmed = body.trim_end();
                if !trimmed.is_empty() {
                    out.push_str(trimmed);
                    out.push_str("\n\n");
                }
            }
        }
    }

    out
}

/// Indent each line of `s` with two spaces so it embeds cleanly inside a
/// YAML literal block scalar (`key: |` followed by indented lines).
fn indent_yaml_block(s: &str) -> String {
    s.lines()
        .map(|l| format!("  {l}"))
        .collect::<Vec<_>>()
        .join("\n")
}
```

- [ ] **Step 2: Confirm `uuid` and `chrono` are already in Cargo.toml**

Run: `grep -E '^(uuid|chrono) =' src-tauri/Cargo.toml`
Expected: both crates listed. If `uuid` is missing:

```bash
cd src-tauri && cargo add uuid --features v4
```

If `chrono` is missing:

```bash
cd src-tauri && cargo add chrono --features serde
```

- [ ] **Step 3: Wire the module in `src-tauri/src/lib.rs`**

Near the top of `src-tauri/src/lib.rs` (where other `mod` lines live, around the `pub mod ai;` declarations), add:

```rust
pub mod history;
```

- [ ] **Step 4: Compile**

Run: `cd src-tauri && cargo check`
Expected: PASS — the `history` module has no cross-module references, so it compiles standalone. (Registering the command in `generate_handler!` happens in Task 6.)

- [ ] **Step 5: Stage**

```bash
git add src-tauri/src/history.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
```

Hold the commit until Task 6 ships the backend bundle.

---

## Task 4: Backend — `InterviewMessage`, `InterviewRequest`, `ai_interview` command

**Files:**
- Modify: `src-tauri/src/ai/mod.rs`

- [ ] **Step 1: Add the message + request structs**

In `src-tauri/src/ai/mod.rs`, just below the existing `ParsedTicket` struct, add:

```rust
/// One message in an interview turn. The role string matches the
/// chat-completions convention so it maps 1:1 onto provider-native chat
/// arrays if we ever move off stateless replay.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct InterviewMessage {
    pub role: String,    // "user" | "assistant"
    pub content: String,
    #[serde(default)]
    pub ts: i64,
}

#[derive(Debug, Deserialize)]
pub struct InterviewRequest {
    pub request_id: String,
    pub provider: Provider,
    pub mode: String,                     // "PO" | "DEV"
    pub messages: Vec<InterviewMessage>,
    #[serde(default)] pub tone: Option<String>,
    #[serde(default)] pub custom_system_prompt: Option<String>,
    #[serde(default)] pub model: Option<String>,
    #[serde(default)] pub attachment_ids: Vec<String>,
    #[serde(default)] pub reference_ids: Vec<String>,
}
```

- [ ] **Step 2: Add the `ai_interview` Tauri command**

Append this command directly below the existing `ai_draft` command in the same file:

```rust
#[tauri::command]
pub async fn ai_interview(
    app: AppHandle,
    state: State<'_, AppState>,
    req: InterviewRequest,
) -> AppResult<()> {
    let request_id = req.request_id.clone();
    log::info!(
        "ai_interview start: request_id={} provider={:?} mode={} messages={} attachments={} references={}",
        request_id,
        req.provider,
        req.mode,
        req.messages.len(),
        req.attachment_ids.len(),
        req.reference_ids.len(),
    );

    let (chunks_tx, mut chunks_rx) = mpsc::channel::<StreamChunk>(64);
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();

    state
        .ai_cancellers
        .lock()
        .await
        .insert(request_id.clone(), {
            let (mpsc_tx, mut mpsc_rx) = mpsc::channel::<()>(1);
            tokio::spawn(async move {
                if mpsc_rx.recv().await.is_some() {
                    let _ = cancel_tx.send(());
                }
            });
            mpsc_tx
        });

    let system = prompt::build_interview_prompt(
        &req.mode,
        req.tone.as_deref().unwrap_or("balanced"),
        req.custom_system_prompt.as_deref(),
    );
    let base_user = prompt::build_interview_user_prompt(&req.messages);

    let resolved = attachments::resolve_many(&state.attachments, &req.attachment_ids);
    let route = route_attachments(req.provider, &resolved);
    let user = match route.text_payload {
        Some(suffix) => format!("{base_user}{suffix}"),
        None => base_user,
    };
    let user = if req.reference_ids.is_empty() {
        user
    } else {
        let ref_payload = state.references.build_payload_for_ids(&req.reference_ids).await;
        match ref_payload {
            Some(rp) => format!("{user}{rp}"),
            None => user,
        }
    };

    let http = state.http.clone();
    let provider = req.provider;
    let model = req.model.clone();
    let image_paths = route.image_paths;
    let inline_attachments = route.inline_attachments;
    let app_for_or = app.clone();
    let backend = tokio::spawn(async move {
        match provider {
            Provider::ClaudeCli => cli::stream(cli::Cli::Claude, system, user, model, image_paths, chunks_tx, cancel_rx).await,
            Provider::CodexCli => cli::stream(cli::Cli::Codex, system, user, model, Vec::new(), chunks_tx, cancel_rx).await,
            Provider::Gemini => {
                let key = secrets::load()
                    .ok()
                    .and_then(|s| s.gemini_key)
                    .ok_or_else(|| AppError::Ai("gemini API key not set".into()))?;
                gemini::stream(http, key, system, user, model, inline_attachments, chunks_tx, cancel_rx).await
            }
            Provider::OpenRouter => {
                let key = secrets::load()
                    .ok()
                    .and_then(|s| s.openrouter_key)
                    .ok_or_else(|| AppError::Ai("openrouter API key not set".into()))?;
                openrouter::stream(app_for_or, http, key, system, user, model, inline_attachments, chunks_tx, cancel_rx).await
            }
            Provider::OpenCode => cli::stream(cli::Cli::OpenCode, system, user, model, image_paths, chunks_tx, cancel_rx).await,
        }
    });

    let app_for_events = app.clone();
    let rid = request_id.clone();
    let cancellers = state.ai_cancellers.clone();
    tokio::spawn(async move {
        let mut accum = String::new();
        let chunk_event = format!("ai:chunk:{rid}");
        let done_event = format!("ai:done:{rid}");
        let error_event = format!("ai:error:{rid}");
        let mut last_error: Option<String> = None;

        while let Some(chunk) = chunks_rx.recv().await {
            match chunk {
                StreamChunk::Text(t) => {
                    accum.push_str(&t);
                    let _ = app_for_events.emit(&chunk_event, &t);
                }
                StreamChunk::Error(e) => {
                    last_error = Some(e.clone());
                    let _ = app_for_events.emit(&error_event, &e);
                }
            }
        }

        let backend_err = match backend.await {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(e.to_string()),
            Err(e) => Some(format!("join: {e}")),
        };

        if backend_err.is_none() && last_error.is_none() {
            log::info!(
                "ai_interview done: request_id={} text_len={}",
                rid,
                accum.len(),
            );
            // Interview turns never carry a parseable ticket block, so `ticket: None`.
            let _ = app_for_events.emit(
                &done_event,
                &DraftDone {
                    request_id: rid.clone(),
                    text: accum,
                    ticket: None,
                },
            );
        } else if let Some(err) = backend_err.or(last_error) {
            log::warn!("ai_interview error: request_id={} err={}", rid, err);
            let _ = app_for_events.emit(&error_event, &err);
        }

        cancellers.lock().await.remove(&rid);
    });

    Ok(())
}
```

- [ ] **Step 3: Make `route_attachments` and `cli::stream` visible if currently private**

In `src-tauri/src/ai/mod.rs`, `route_attachments` should already be in scope (same module). If `cli::stream` is `pub(crate)` already in `cli.rs`, this command compiles. If it's `pub(super)` only, change it to `pub(crate)`. Run `cargo check` after Step 4 to confirm.

- [ ] **Step 4: Compile**

Run: `cd src-tauri && cargo check`
Expected: ERRORS until Task 5 lands (no `prompt::build_interview_prompt` / `build_interview_user_prompt` yet). Note the error messages and move on.

- [ ] **Step 5: Stage**

```bash
git add src-tauri/src/ai/mod.rs
```

Leave staged. Commit lands at the end of Task 5.

- [ ] **Step 6: (defer)**

No commit yet.

---

## Task 5: Backend — interview prompt builders + extend `build_user_prompt`

**Files:**
- Modify: `src-tauri/src/ai/prompt.rs`
- Modify: `src-tauri/src/ai/mod.rs` (one call-site change for `build_user_prompt`)

- [ ] **Step 1: Add the interview system prompt**

In `src-tauri/src/ai/prompt.rs`, scroll to the bottom of the file (after `build_subtask_expansion_user_prompt`) and append:

```rust
// ────────────────────────────────────────────────────────────────────────
// Interview Mode — divergent design interview before drafting
//
// Adapted from the `grill-me` skill spec. Voice follows the same PO/DEV
// split as `build_system_prompt`. The model conducts one question per
// turn, always with a recommended answer. When discovery feels complete,
// the model emits a literal `[[READY]]` token on its own line as a
// trailing signal the frontend strips and uses to surface a "ready"
// banner. The accumulated transcript is later fed back into the regular
// `ai_draft` pipeline via `DraftRequest.interview_transcript`.
// ────────────────────────────────────────────────────────────────────────

const INTERVIEW_BASE_DEV: &str = r#"You are conducting a focused engineering interview to sharpen a fuzzy software request before any code or ticket is written. Treat the requester as a smart colleague who has more context than they're surfacing.

## How you work

- Open the first turn by restating the request in ONE sentence — make it concrete. Then ask the FIRST sharpening question.
- Ask exactly ONE question per turn. No exceptions.
- Every question MUST include your recommended answer with one-sentence justification. Shape: "<question>. My recommendation: <X>, because <Y>. Sound right?"
- Walk the design tree branch by branch — purpose, users, what-it-replaces, the single thing it's great at, variations, boundaries (non-goals).
- Stress-test answers. Surface contradictions out loud: "Earlier you said X. Just now you said Y. Which is it?"
- Invent concrete edge-case scenarios that force precision (offline, concurrent users, demo-in-five-minutes).
- If a question can be answered from attached files or reference folders, answer it yourself and skip — do NOT make the user re-state.
- NEVER write code. NEVER propose implementations. NEVER paste reference file contents into your response. Reference files by name only.
- Stay in English regardless of the requester's input language.
- Treat the work as a real engineering ticket — system behaviour, architecture clarity, ownership, rollback.

## When you have enough

Once you can describe the request in one sentence with: a clear primary user, a single thing it's great at, explicit non-goals, and you've resolved any contradictions — emit a short one-paragraph wrap-up that summarises the sharpened request. Then on its own line, emit the literal token:

[[READY]]

Do not emit `[[READY]]` before you actually have enough; the requester relies on it as a signal. Do not emit it inside an example or as a quoted string — only as a real end-of-interview marker.

## Voice

You speak like a senior tech lead conducting design review. Authoritative, specific, no hedging. Concrete nouns and verbs. Skip filler words ("just", "really", "basically"). Avoid "leverage", "synergy", "robust", "seamless"."#;

const INTERVIEW_BASE_PO: &str = r#"You are conducting a focused product interview to sharpen a fuzzy user-facing request before any ticket is written. Treat the requester as a smart colleague who has more context than they're surfacing.

## How you work

- Open the first turn by restating the request in ONE sentence — make it concrete. Then ask the FIRST sharpening question.
- Ask exactly ONE question per turn. No exceptions.
- Every question MUST include your recommended answer with one-sentence justification. Shape: "<question>. My recommendation: <X>, because <Y>. Sound right?"
- Walk the design tree branch by branch — who the user is, what they're trying to do, what they do today instead, the single observable outcome that matters, what's explicitly out of scope.
- Stress-test answers. Surface contradictions: "Earlier you said X. Just now you said Y. Which is it?"
- Invent concrete user scenarios that force precision (Sunday at 11pm, on mobile, while distracted).
- If a question can be answered from attached files or reference folders, answer it yourself and skip.
- NEVER write code or implementation detail. Stay product-shaped.
- Stay in English regardless of the requester's input language.

## When you have enough

Once you can describe the request in one sentence with: a clear primary user, a single observable outcome, explicit out-of-scope items, and you've resolved any contradictions — emit a short one-paragraph wrap-up that summarises the sharpened request. Then on its own line, emit the literal token:

[[READY]]

Do not emit `[[READY]]` before you actually have enough; the requester relies on it as a signal. Do not emit it inside an example or quoted string.

## Voice

You speak like a senior product strategist running discovery. Outcome-first, user-grounded, no hedging. Concrete nouns and verbs."#;

pub fn build_interview_prompt(mode: &str, _tone: &str, custom: Option<&str>) -> String {
    let base = if mode.eq_ignore_ascii_case("PO") {
        INTERVIEW_BASE_PO
    } else {
        INTERVIEW_BASE_DEV
    };

    let mut out = String::with_capacity(base.len() + 1024);
    out.push_str(base);

    if let Some(c) = custom {
        let trimmed = c.trim();
        if !trimmed.is_empty() {
            out.push_str("\n\n---\n\n## Team Conventions\n\nThe following team-specific rules apply to interview questions and any final draft. Honour them when probing scope:\n\n");
            out.push_str(trimmed);
        }
    }
    out
}

/// Format the message history as a single user payload for stateless
/// replay. Trailing `ASSISTANT:` line primes the model to continue with
/// the next assistant turn.
pub fn build_interview_user_prompt(messages: &[crate::ai::InterviewMessage]) -> String {
    let mut out = String::with_capacity(256 + messages.iter().map(|m| m.content.len() + 16).sum::<usize>());
    for m in messages {
        let label = if m.role == "user" { "USER" } else { "ASSISTANT" };
        out.push_str(label);
        out.push_str(":\n");
        out.push_str(m.content.trim_end());
        out.push_str("\n\n");
    }
    out.push_str("ASSISTANT:\n");
    out
}
```

- [ ] **Step 2: Extend `build_user_prompt` to accept transcript**

Still in `src-tauri/src/ai/prompt.rs`, find the existing `build_user_prompt` and change its signature + body to:

```rust
pub fn build_user_prompt(
    prompt: &str,
    refine_of: Option<&str>,
    interview_transcript: Option<&str>,
) -> String {
    if let Some(prev) = refine_of {
        // Keep the existing refine body verbatim. Just preserve whatever
        // the function used to return on this branch.
        return format!(
            "## Existing draft to refine\n\n{prev}\n\n## Refinement instruction\n\n{prompt}",
        );
    }
    if let Some(t) = interview_transcript {
        return format!(
            "The requester completed an interview before this draft. Treat the transcript below as the AUTHORITATIVE source for scope, intent, and decisions. The original prompt is included as context only — the transcript overrides it where they conflict.\n\n## Original prompt\n\n{prompt}\n\n## Interview transcript\n\n{t}",
        );
    }
    format!("## User input\n\n{prompt}")
}
```

**Important:** If the existing `build_user_prompt` body for the `refine_of` branch is different from the placeholder above, preserve the existing formatting verbatim. Only add the new `interview_transcript` branch and the parameter; do NOT rewrite the refine path's wording.

- [ ] **Step 3: Update the single call site in `ai/mod.rs`**

In `src-tauri/src/ai/mod.rs::ai_draft`, find:

```rust
let base_user = prompt::build_user_prompt(&req.prompt, req.refine_of.as_deref());
```

Replace with:

```rust
let base_user = prompt::build_user_prompt(
    &req.prompt,
    req.refine_of.as_deref(),
    req.interview_transcript.as_deref(),
);
```

(The `interview_transcript` field on `DraftRequest` lands in Task 6 — `cargo check` will still error after this step. Continue to Task 6 before compiling.)

- [ ] **Step 4: Stage but defer commit**

```bash
git add src-tauri/src/ai/prompt.rs src-tauri/src/ai/mod.rs
```

---

## Task 6: Backend — extend `DraftRequest`, register commands, compile clean

**Files:**
- Modify: `src-tauri/src/ai/mod.rs`
- Modify: `src-tauri/src/lib.rs:389-440` (invoke_handler list)

- [ ] **Step 1: Add `interview_transcript` to `DraftRequest`**

In `src-tauri/src/ai/mod.rs`, find `pub struct DraftRequest { … }` and add this field at the bottom of the struct:

```rust
    /// When present, the prompt builder splices the transcript in as
    /// authoritative context (see `prompt::build_user_prompt`). Set by
    /// the Interview screen's "Generate ticket" handoff.
    #[serde(default)]
    pub interview_transcript: Option<String>,
```

- [ ] **Step 2: Register `ai_interview` and `ticket_save_history` in `lib.rs`**

In `src-tauri/src/lib.rs`, find the `tauri::generate_handler![ … ]` block. Inside the AI group, add `ai::ai_interview` next to `ai::ai_draft`. Add a new "history" group at the end:

```rust
            ai::ai_detect_clis,
            ai::ai_draft,
            ai::ai_interview,
            ai::ai_expand_subtasks,
            ai::ai_cancel,
            ai::ai_open_login,
            ...
            // history
            history::ticket_save_history,
```

(Keep the existing entries intact; add the two lines in the spots above.)

- [ ] **Step 3: Compile**

Run: `cd src-tauri && cargo check`
Expected: PASS — clean compile.

- [ ] **Step 4: Run `pnpm build` to make sure TS still typechecks**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit the backend bundle**

```bash
git add src-tauri/src/ai/mod.rs src-tauri/src/ai/prompt.rs src-tauri/src/history.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(ai): add ai_interview command + per-ticket history persistence

- New InterviewRequest / InterviewMessage structs and ai_interview command
  mirroring ai_draft's streaming surface (chunk / done / error events).
- New build_interview_prompt + build_interview_user_prompt in prompt.rs;
  voice splits PO / DEV like the existing draft prompt.
- DraftRequest gains optional interview_transcript; build_user_prompt
  splices it in as authoritative context when present.
- New history module with ticket_save_history command that writes
  \${appDataDir}/tickets/<uuid>.md with YAML frontmatter + initial prompt
  + interview transcript (if any) + final description + sub-task bodies.
  Foundation for the upcoming Ticket History UI spec."
```

---

## Task 7: Frontend — Tauri wrappers + new request types

**Files:**
- Modify: `src/lib/tauri.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Extend `src/types.ts` with frontend request shapes**

Add to `src/types.ts` (next to `InterviewMessage` from Task 2):

```ts
export interface AiInterviewRequest {
  request_id: string;
  provider: Provider;
  mode: "PO" | "DEV";
  messages: InterviewMessage[];
  tone?: AppSettings["tone"];
  custom_system_prompt?: string;
  model?: string;
  attachment_ids?: string[];
  reference_ids?: string[];
}

export interface SavedSubtask {
  jira_key: string;
  title: string;
  description_markdown?: string;
}

export interface SaveHistoryPayload {
  jira_key: string;
  jira_url?: string;
  provider: Provider;
  mode: "PO" | "DEV";
  model?: string;
  project_key: string;
  issue_type: string;
  priority?: string;
  epic_key?: string;
  assignee_account_id?: string;
  labels: string[];
  subtask_keys: string[];
  title: string;
  initial_prompt: string;
  interview_transcript?: string;
  description_markdown: string;
  subtasks: SavedSubtask[];
}

export interface SaveHistoryResult {
  path: string;
  id: string;
}
```

- [ ] **Step 2: Extend `DraftArgs` in `src/lib/tauri.ts` and the frontend `DraftContext` shape**

In `src/lib/tauri.ts`, find `export interface DraftArgs { … }`. Add at the bottom:

```ts
  /** Set by the Interview → Draft handoff. When present, the backend
   *  prompt builder splices it in as authoritative context (see
   *  `src-tauri/src/ai/prompt.rs::build_user_prompt`). */
  interview_transcript?: string;
```

In `src/store.ts`, find `export interface DraftContext { … }` and add at the bottom:

```ts
  /** Carried Interview → Draft. Forwarded into `aiDraft` as
   *  `interview_transcript`. The Draft screen treats it as an opaque
   *  Markdown blob. */
  interview_transcript?: string;
```

- [ ] **Step 3: Add wrapper functions**

In `src/lib/tauri.ts`, just after the existing `aiDraft` export, add:

```ts
import type { AiInterviewRequest, SaveHistoryPayload, SaveHistoryResult } from "../types";

export const aiInterview = (req: AiInterviewRequest) =>
  invoke<void>("ai_interview", { req });

export async function listenInterview(
  requestId: string,
  handlers: DraftEventHandlers,
): Promise<UnlistenFn> {
  // Mirrors listenDraft — the backend reuses ai:chunk / ai:done / ai:error
  // event names so a single subscriber pattern works for both paths.
  return listenDraft(requestId, handlers);
}

export const ticketSaveHistory = (req: SaveHistoryPayload) =>
  invoke<SaveHistoryResult>("ticket_save_history", { req });
```

Notes for the engineer:
- `listenInterview` is intentionally a thin alias of `listenDraft`. The Rust side emits the same event names keyed by `request_id`, so reusing the listener avoids drift if either signature evolves.
- The import line goes at the top of `src/lib/tauri.ts` next to the existing `import type { … } from "../types";`.

- [ ] **Step 4: Run typecheck**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/lib/tauri.ts src/store.ts
git commit -m "feat(tauri): add aiInterview / listenInterview / ticketSaveHistory wrappers"
```

---

## Task 8: Frontend — store changes (screen, ctx, actions)

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 1: Add `"interview"` to the Screen union**

In `src/store.ts`, find:

```ts
export type Screen = "loading" | "onboarding" | "main" | "draft" | "settings";
```

Change to:

```ts
export type Screen = "loading" | "onboarding" | "main" | "interview" | "draft" | "settings";
```

- [ ] **Step 2: Add `interviewCtx` to `AppStoreState`**

Add this field below `draftCtx`:

```ts
  interviewCtx: DraftContext | null;
```

…and in the initial state below `draftCtx: null,`:

```ts
  interviewCtx: null,
```

- [ ] **Step 3: Add `openInterview`, `closeInterview`, `promoteInterviewToDraft` actions**

Declare them in `AppStoreState`:

```ts
  openInterview: (ctx: DraftContext) => void;
  closeInterview: () => void;
  promoteInterviewToDraft: (interviewTranscriptMarkdown: string) => void;
```

Implement them in the `create<AppStoreState>(...)` factory, alongside `openDraft` / `closeDraft`:

```ts
  openInterview(ctx) {
    set({ interviewCtx: ctx, screen: "interview" });
  },

  closeInterview() {
    set({ interviewCtx: null, screen: "main" });
  },

  promoteInterviewToDraft(interviewTranscriptMarkdown) {
    const ctx = get().interviewCtx;
    if (!ctx) {
      set({ screen: "main" });
      return;
    }
    // Per the spec: references are not carried into the final draft —
    // the transcript already contains the analyzed context. Attachments
    // ARE carried; subject to existing routing.
    const draftCtx: DraftContext = {
      ...ctx,
      references: undefined,
      referenceSessionId: undefined,
      interview_transcript: interviewTranscriptMarkdown,
    };
    set({ draftCtx, interviewCtx: null, screen: "draft" });
  },
```

- [ ] **Step 4: Typecheck**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts
git commit -m "feat(store): add interview screen, ctx slot, openInterview / promoteInterviewToDraft actions"
```

---

## Task 9: Frontend — Settings.tsx adds "Split into subtasks" row

**Files:**
- Modify: `src/screens/Settings.tsx`

- [ ] **Step 1: Add a Row beneath "Submit on Enter"**

In `DraftingSection`, find the existing `Row` block for `submitOnEnter`. Add the following row directly below it, still inside the same `<Group title="Composer">`:

```tsx
        <Row title="Split tickets into subtasks by default" hint="When off, the AI may still propose subtasks in the draft body, but they won't be created as Jira issues unless you flip the switch on the Draft sidebar for that draft.">
          <Switch
            checked={settings.splitIntoSubtasks}
            onCheckedChange={(v) => void setSettings({ splitIntoSubtasks: v })}
          />
        </Row>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 3: Manual smoke**

Run: `pnpm tauri dev`
Open Settings → Drafting. Verify "Split tickets into subtasks by default" appears below "Submit on Enter" and toggling it flips the switch state. Reload the app, confirm the value persists.

- [ ] **Step 4: Commit**

```bash
git add src/screens/Settings.tsx
git commit -m "feat(settings): expose 'Split tickets into subtasks by default' switch"
```

---

## Task 10: Frontend — Main.tsx Interview Mode pill

**Files:**
- Modify: `src/screens/Main.tsx`

- [ ] **Step 1: Add an InterviewModePill component above the textarea**

At the bottom of `src/screens/Main.tsx`, add this new component (just before the `stripPartialMarker` export):

```tsx
/**
 * Pill-style toggle above the textarea. Bound to `settings.interviewMode`.
 * Uses `useGlobalTooltip` directly — same pattern as `ReferenceButton` —
 * so re-renders of Main don't cancel the hide timeout.
 */
function InterviewModePill({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: () => void;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const { showTooltip, hideTooltip } = useGlobalTooltip();

  const handleEnter = useCallback(() => {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    showTooltip({
      content: (
        <div>
          <div style={{ font: "600 12px var(--font-mono)", marginBottom: 2 }}>Interview Mode</div>
          <div style={{ font: "400 11px var(--font-mono)", color: "var(--background)", opacity: 0.65, lineHeight: 1.5 }}>
            Agent asks you questions until a ticket is ready,<br />
            instead of using just the initial prompt context
          </div>
        </div>
      ),
      rect,
      side: "bottom",
      sideOffset: 8,
      align: "start",
      alignOffset: 0,
      id: "interview-mode-pill",
      arrow: true,
    });
  }, [showTooltip]);

  const handleLeave = useCallback(() => {
    hideTooltip();
  }, [hideTooltip]);

  return (
    <span
      ref={wrapRef}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      style={{ display: "inline-flex" }}
    >
      <button
        type="button"
        onClick={() => { playUi("toggle"); onToggle(); }}
        aria-pressed={checked}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 22,
          padding: "0 10px",
          background: checked ? "var(--accent-soft)" : "transparent",
          color: checked ? "var(--accent)" : "var(--fg-muted)",
          border: `0.5px solid ${checked ? "color-mix(in oklab, var(--accent) 22%, transparent)" : "var(--border-strong)"}`,
          borderRadius: 999,
          font: "500 11.5px var(--font-text)",
          cursor: "pointer",
          transition: "background 140ms ease, color 140ms ease, border-color 140ms ease",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: 3,
            border: `1px solid ${checked ? "currentColor" : "var(--fg-subtle)"}`,
            background: checked ? "currentColor" : "transparent",
          }}
        />
        Interview Mode
      </button>
    </span>
  );
}
```

- [ ] **Step 2: Render the pill above the textarea**

Find the JSX block in `Main` that opens the composer card (the `<div>` immediately containing `<AttachmentChips … />`). Just before `<AttachmentChips …>`, insert:

```tsx
            {/* Interview Mode pill — slim top row above textarea.
                Settings.interviewMode is sticky across sessions; submit
                routes to openInterview when checked. */}
            <div style={{ padding: "8px 14px 0" }}>
              <InterviewModePill
                checked={settings.interviewMode}
                onToggle={() => void setSettings({ interviewMode: !settings.interviewMode })}
              />
            </div>
```

- [ ] **Step 3: Branch `handleSubmit` between draft and interview**

Find the existing `handleSubmit` body. Replace the `openDraft({ … })` call with:

```tsx
    const target = settings.interviewMode ? useAppStore.getState().openInterview : openDraft;
    target({
      prompt: trimmed,
      provider,
      mode,
      model: modelId,
      attachments: attachments.length > 0 ? attachments : undefined,
      attachmentSessionId: attachments.length > 0 ? attachmentsSessionId : undefined,
      references: references.length > 0 ? references : undefined,
      referenceSessionId: references.length > 0 ? referenceSessionId : undefined,
    });
```

(Also pull `openInterview` from `useAppStore()` next to `openDraft` if you prefer destructuring: `const { settings, secrets, openDraft, openInterview, setScreen, setSettings } = useAppStore();` — either approach is fine; the `getState()` form works without changing the destructure block.)

- [ ] **Step 4: Typecheck**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 5: Manual smoke**

Run: `pnpm tauri dev`. On the Main screen:
- Pill appears above the textarea, left-aligned, inside the composer card.
- Hover shows the two-line tooltip ("Interview Mode" + description).
- Clicking toggles its active/inactive style.
- With pill OFF, submitting still routes to Draft (existing behavior).
- With pill ON, submitting routes to a blank screen — that's expected until Task 11 mounts `<Interview/>`.
- Reload the app: pill state persists.

- [ ] **Step 6: Commit**

```bash
git add src/screens/Main.tsx
git commit -m "feat(main): add Interview Mode pill above composer textarea"
```

---

## Task 11: Frontend — Interview screen + App.tsx routing

**Files:**
- Create: `src/screens/Interview.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create `src/screens/Interview.tsx`**

Write this file:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Background } from "../components/Background";
import { Persona } from "../components/Persona";
import { Button } from "../components/ui/button";
import { Icon } from "../components/Icon";
import { ArrowRightIcon, MicIcon } from "../components/icons-animated";
import { VoiceWave } from "../components/primitives";
import {
  aiCancel,
  aiInterview,
  listenInterview,
  listenSpeech,
} from "../lib/tauri";
import { startVoice, type VoiceSession } from "../lib/voice";
import { notify } from "../lib/notify";
import { useAppStore } from "../store";
import type { InterviewMessage, Provider } from "../types";
import { MODELS } from "../types";

const READY_RE = /\n?\s*\[\[READY\]\]\s*$/i;

const uuid = (): string =>
  // Tauri webview provides crypto.randomUUID on every supported platform.
  (globalThis.crypto as Crypto).randomUUID();

export function Interview() {
  const { interviewCtx, settings, closeInterview, promoteInterviewToDraft } =
    useAppStore();

  // Guard: if someone landed on this screen without a context (e.g. via a
  // stale state restore), bounce back to Main.
  useEffect(() => {
    if (!interviewCtx) {
      closeInterview();
    }
  }, [interviewCtx, closeInterview]);

  const ctx = interviewCtx;

  const [messages, setMessages] = useState<InterviewMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [aiThinksReady, setAiThinksReady] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
  const [generating, setGenerating] = useState(false);

  const requestIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  const voiceRef = useRef<VoiceSession | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const model = ctx ? MODELS.find((m) => m.provider === ctx.provider) ?? MODELS[0] : MODELS[0];

  const runTurn = useCallback(
    async (history: InterviewMessage[]) => {
      if (!ctx) return;
      cleanupRef.current?.();
      const requestId = uuid();
      requestIdRef.current = requestId;
      let unlistenFn: (() => void) | undefined;
      cleanupRef.current = () => {
        unlistenFn?.();
        void aiCancel(requestId);
      };

      setStreaming(true);
      setStreamingText("");
      setStreamError(null);

      const isCurrent = () => requestIdRef.current === requestId;

      unlistenFn = await listenInterview(requestId, {
        onChunk: (t) => {
          if (!isCurrent()) return;
          setStreamingText((s) => s + t);
        },
        onDone: (done) => {
          if (!isCurrent()) return;
          const raw = done.text;
          const ready = READY_RE.test(raw);
          const cleaned = raw.replace(READY_RE, "").trimEnd();
          setMessages((cur) => [
            ...cur,
            { role: "assistant", content: cleaned, ts: Date.now() },
          ]);
          setStreamingText("");
          setStreaming(false);
          if (ready) setAiThinksReady(true);
        },
        onError: (msg) => {
          if (!isCurrent()) return;
          setStreaming(false);
          setStreamError(msg);
        },
      });

      try {
        await aiInterview({
          request_id: requestId,
          provider: ctx.provider as Provider,
          mode: ctx.mode,
          messages: history,
          tone: settings.tone,
          custom_system_prompt: settings.systemPrompt || undefined,
          model: ctx.model || undefined,
          attachment_ids: ctx.attachments?.map((a) => a.id) ?? [],
          reference_ids: ctx.references?.map((r) => r.id) ?? [],
        });
      } catch (e) {
        if (!isCurrent()) return;
        setStreaming(false);
        setStreamError(e instanceof Error ? e.message : String(e));
      }
    },
    [ctx, settings.tone, settings.systemPrompt],
  );

  // First turn — seed transcript with the Main prompt and call the model.
  useEffect(() => {
    if (!ctx) return;
    const seed: InterviewMessage[] = [
      { role: "user", content: ctx.prompt, ts: Date.now() },
    ];
    setMessages(seed);
    void runTurn(seed);
    return () => cleanupRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-grow textarea + scroll thread to bottom whenever streaming
  // appends, or a new message lands.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText]);

  useEffect(() => {
    if (taRef.current) {
      taRef.current.style.height = "auto";
      taRef.current.style.height = Math.min(taRef.current.scrollHeight, 220) + "px";
    }
  }, [replyText]);

  // Voice wiring — same Scribe pattern as Main.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenSpeech({
      onPartial: (t) => setReplyText((cur) => cur + (cur && !cur.endsWith(" ") ? " " : "") + t),
      onFinal: (t) => setReplyText((cur) => cur + (cur && !cur.endsWith(" ") ? " " : "") + t),
      onError: (msg) => console.error("speech error:", msg),
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  const toggleVoice = async () => {
    if (voiceActive) {
      await voiceRef.current?.stop();
      voiceRef.current = null;
      setVoiceActive(false);
      return;
    }
    try {
      voiceRef.current = await startVoice({ deviceId: settings.audioInputDeviceId });
      setVoiceActive(true);
    } catch (e) {
      notify("Couldn't start voice input", {
        kind: "error",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleSendReply = () => {
    const trimmed = replyText.trim();
    if (!trimmed || streaming) return;
    const next: InterviewMessage[] = [
      ...messages,
      { role: "user", content: trimmed, ts: Date.now() },
    ];
    setMessages(next);
    setReplyText("");
    if (voiceActive) void toggleVoice();
    void runTurn(next);
  };

  const handleGenerate = () => {
    if (!ctx || generating || messages.length === 0) return;
    setGenerating(true);
    // No disk write here — the transcript travels in-memory through Draft
    // and lands on disk after Jira publishes via ticket_save_history.
    const transcript = renderTranscriptForPrompt(messages);
    promoteInterviewToDraft(transcript);
  };

  if (!ctx) return null;

  const canGenerate = messages.some((m) => m.role === "assistant") && !generating;
  const canSend = replyText.trim().length > 0 && !streaming;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <Background />

      <div style={{ position: "absolute", inset: 0, zIndex: 1, display: "flex", flexDirection: "column" }}>
        {/* Top bar */}
        <div className="main-topbar" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Button variant="ghost" size="iconSm" onClick={() => closeInterview()} aria-label="Back to Main">
            <Icon.Chevron size={14} style={{ transform: "rotate(90deg)" }} />
          </Button>
          <div style={{ color: "var(--fg-muted)", font: "500 12px var(--font-text)" }}>
            Interview · {model.short}
          </div>
          <div style={{ width: 32 }} />
        </div>

        {/* Persona */}
        <div style={{ display: "flex", justifyContent: "center", padding: "16px 0 8px" }}>
          <Persona variant="halo" state={streaming ? "listening" : "idle"} className="size-[120px]" />
        </div>

        {/* Thread */}
        <div
          ref={threadRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "8px 80px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {messages.map((m, i) => (
            <Bubble key={i} role={m.role} text={m.content} />
          ))}
          {streaming && streamingText.length > 0 && (
            <Bubble role="assistant" text={streamingText.replace(READY_RE, "")} streaming />
          )}
          {streamError && (
            <div className="card" style={{ padding: 10, borderColor: "rgba(255,69,58,0.4)", background: "rgba(255,69,58,0.06)", color: "#ff453a" }}>
              {streamError}
            </div>
          )}
        </div>

        {/* Ready banner */}
        {aiThinksReady && (
          <div style={{ padding: "0 80px 8px" }}>
            <div className="card" style={{
              padding: "8px 12px",
              border: "0.5px solid var(--accent)",
              background: "var(--accent-soft)",
              color: "var(--accent)",
              font: "500 12.5px var(--font-text)",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
            }}>
              <span>I have what I need. Ready to draft the ticket?</span>
              <Button variant="primary" onClick={() => void handleGenerate()} disabled={!canGenerate}>
                Generate ticket
              </Button>
            </div>
          </div>
        )}

        {/* Reply composer */}
        <div style={{ padding: "12px 80px 20px" }}>
          <div style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 8,
            background: "var(--bg-card)",
            border: "0.5px solid var(--border-strong)",
            borderRadius: 14,
            padding: "6px 6px 6px 14px",
          }}>
            <textarea
              ref={taRef}
              rows={1}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendReply();
                }
              }}
              placeholder={streaming ? "Waiting for the agent…" : "Reply…"}
              disabled={streaming}
              style={{
                flex: 1, minHeight: 36, maxHeight: 220,
                background: "transparent", border: 0, outline: 0, resize: "none",
                font: "400 14px var(--font-text)", color: "var(--fg)", lineHeight: 1.5,
              }}
            />
            {settings.voiceEnabled && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void toggleVoice()}
                disabled={streaming}
                style={{
                  background: voiceActive ? "var(--accent-soft)" : "transparent",
                  color: voiceActive ? "var(--accent)" : "var(--fg-muted)",
                }}
              >
                {voiceActive ? <VoiceWave active /> : <MicIcon size={16} />}
              </Button>
            )}
            <Button
              variant="primary"
              size="icon"
              onClick={handleSendReply}
              disabled={!canSend}
              style={{
                background: canSend ? "var(--accent)" : "var(--bg-active)",
                color: canSend ? "white" : "var(--fg-subtle)",
              }}
            >
              <ArrowRightIcon size={16} />
            </Button>
            <Button
              variant={aiThinksReady ? "primary" : "default"}
              onClick={() => void handleGenerate()}
              disabled={!canGenerate}
            >
              Generate ticket
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({ role, text, streaming }: { role: "user" | "assistant"; text: string; streaming?: boolean }) {
  const isUser = role === "user";
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
      <div
        style={{
          maxWidth: 620,
          padding: "10px 14px",
          borderRadius: 12,
          background: isUser ? "var(--accent-soft)" : "var(--bg-card)",
          border: `0.5px solid ${isUser ? "color-mix(in oklab, var(--accent) 22%, transparent)" : "var(--border-strong)"}`,
          color: "var(--fg)",
          font: "400 14px var(--font-text)",
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          opacity: streaming ? 0.85 : 1,
        }}
      >
        {text}
      </div>
    </div>
  );
}

function renderTranscriptForPrompt(messages: InterviewMessage[]): string {
  let out = "";
  for (const m of messages) {
    const label = m.role === "user" ? "USER" : "ASSISTANT";
    out += `## ${label}\n\n${m.content.trimEnd()}\n\n`;
  }
  return out;
}
```

- [ ] **Step 2: Wire the screen into App.tsx**

In `src/App.tsx`, add the import at the top:

```tsx
import { Interview } from "./screens/Interview";
```

In the screen-switch JSX (below `{screen === "main" && <Main />}` and above `{screen === "draft" && <Draft />}`):

```tsx
        {screen === "interview" && <Interview />}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 4: Manual smoke**

Run: `pnpm tauri dev`. On Main:
- Check the Interview Mode pill. Type "I want to make our checkout faster" and submit.
- Interview screen mounts. Persona renders. The first turn streams in.
- Reply with "yes" → next turn streams.
- After several turns, the model should eventually emit `[[READY]]`. Verify:
  - The sentinel is stripped from the displayed bubble.
  - The "I have what I need" banner appears.
  - The "Generate ticket" button at the bottom-right takes the primary-accent styling.
- Click Generate → Draft screen mounts and starts streaming. (Final draft quality is validated in Task 12 once Draft.tsx forwards the transcript.)
- Reload the app: starting fresh resets state (interviewCtx is in-memory only).

- [ ] **Step 5: Commit**

```bash
git add src/screens/Interview.tsx src/App.tsx
git commit -m "feat(interview): add Interview screen with chat thread + ready sentinel + Generate handoff"
```

---

## Task 12: Frontend — Draft.tsx subtask switch + transcript forwarding + history save

**Files:**
- Modify: `src/screens/Draft.tsx`

- [ ] **Step 1: Add `Switch` + `ticketSaveHistory` imports**

Near the top of `src/screens/Draft.tsx`, add (next to other UI imports):

```tsx
import { Switch } from "../components/animate-ui/components/base/switch";
```

And next to the other `tauri.ts` imports already in that file:

```tsx
import { ticketSaveHistory } from "../lib/tauri";
```

(If `ticketSaveHistory` is already part of the existing `from "../lib/tauri"` import group, just add it to the destructure.)

- [ ] **Step 2: Add session-local subtask state**

Inside the Draft component body, near the other `useState` declarations (alongside `streamText`, `draft`, etc.), add:

```tsx
  const [splitIntoSubtasksLocal, setSplitIntoSubtasksLocal] = useState(
    settings.splitIntoSubtasks,
  );
```

(This is initialized once from the global default at mount. It deliberately never calls `setSettings`, so flipping it does not change the user's saved default.)

- [ ] **Step 3: Render the switch row in the sidebar**

In the right-hand meta sidebar JSX, directly under the "Details" heading and **above** the existing `<MetaRow label="Project">`:

```tsx
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 0 14px",
            borderBottom: "0.5px solid var(--border)",
            marginBottom: 14,
          }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ font: "500 12.5px var(--font-text)", color: "var(--fg)" }}>
                Split into subtasks
              </span>
              <span style={{ font: "400 11px var(--font-text)", color: "var(--fg-subtle)" }}>
                This draft only
              </span>
            </div>
            <Switch
              checked={splitIntoSubtasksLocal}
              onCheckedChange={setSplitIntoSubtasksLocal}
            />
          </div>
```

- [ ] **Step 4: Gate the create pipeline**

Find the section in `handleCreate` that builds the `subtasks` array (around line 516):

```tsx
const subtasks = (draft.subtasks ?? [])
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
```

Change to:

```tsx
const subtasks = splitIntoSubtasksLocal
  ? (draft.subtasks ?? []).map((s) => s.trim()).filter((s) => s.length > 0)
  : [];
```

The rest of the pipeline is already keyed off `subtasks.length` — an empty array means the `"expand"` and `"subtasks"` pipeline rows never get pushed. The `description_markdown` `### Subtasks` strip on the same path still runs because the conditional uses `subtasks.length > 0`, which is false when the user opted out — but the rendered Markdown the user sees was the streamed body, where the subtask section is fine to keep as a visible suggestion. Verify in the manual smoke step.

**However**, we still want to strip the `### Subtasks` block from `description_markdown` even when the user opts out — otherwise Jira's main ticket carries an orphaned bullet list. Adjust the strip condition just below the `subtasks` declaration:

```tsx
const hasProposedSubtasks =
  (draft.subtasks ?? []).filter((s) => s.trim().length > 0).length > 0;
let description_markdown = rawBody.replace(
  /^\s*#{1,6}[ \t]+Title[ \t]*\n[^\n]*(?:\n+|$)/i,
  "",
);
if (hasProposedSubtasks) {
  description_markdown = stripSubtasksSection(description_markdown);
}
description_markdown = description_markdown.trim();
```

This keeps the existing `stripSubtasksSection` call running whenever the model proposed any subtasks, regardless of whether the user wants them created.

- [ ] **Step 5: Forward `interview_transcript` into `aiDraft`**

In `runInitialDraft`, find:

```tsx
await aiDraft({
  request_id: requestId,
  provider: ctx.provider,
  prompt: ctx.prompt,
  mode: ctx.mode,
  tone: settings.tone,
  custom_system_prompt: settings.systemPrompt || undefined,
  model: ctx.model || undefined,
  attachment_ids: promptAttachments.map((a) => a.id),
  reference_ids: references.map((r) => r.id),
});
```

Change to:

```tsx
await aiDraft({
  request_id: requestId,
  provider: ctx.provider,
  prompt: ctx.prompt,
  mode: ctx.mode,
  tone: settings.tone,
  custom_system_prompt: settings.systemPrompt || undefined,
  model: ctx.model || undefined,
  attachment_ids: promptAttachments.map((a) => a.id),
  reference_ids: references.map((r) => r.id),
  interview_transcript: ctx.interview_transcript,
});
```

- [ ] **Step 6: Capture sub-task expansion results for history**

The existing `handleCreate` pipeline expands sub-task titles into bodies via `aiExpandSubtasks` and stores the result in a local variable (often `expansions: SubtaskExpansion[]`) before posting to Jira. Find that variable in `handleCreate`; we need its values plus each newly-created sub-task's Jira key for the history payload.

Adjust the sub-task creation loop to collect both pieces of data. Find the loop that calls `jiraCreateSubtask` per title. Above the loop, declare:

```tsx
const createdSubtasks: { jira_key: string; title: string; description_markdown?: string }[] = [];
```

Inside the loop, immediately after the `jiraCreateSubtask(...)` call returns a response, push to `createdSubtasks` using:

```tsx
const expansion = expansions.find((e) => e.title === title);
createdSubtasks.push({
  jira_key: subtaskResponse.key,
  title,
  description_markdown: expansion?.description_markdown,
});
```

(Adjust variable names — `title`, `subtaskResponse`, `expansions` — to match the surrounding code. The intent is: one entry in `createdSubtasks` per Jira sub-task we successfully posted, carrying the title we sent and the AI-expanded body if available.)

- [ ] **Step 7: Fire `ticketSaveHistory` after pipeline success**

Still inside `handleCreate`, immediately after the entire pipeline completes successfully (right after `setPipelineDone(true)` or equivalent — i.e. the last successful step), call:

```tsx
// Best-effort: persist a local ticket record for the future Ticket History UI.
// Failure is non-fatal — the Jira ticket is already live.
void ticketSaveHistory({
  jira_key: created.key,
  jira_url: created.browse_url ?? undefined,
  provider: ctx.provider,
  mode: ctx.mode,
  model: ctx.model,
  project_key: meta.selectedProjectKey!,
  issue_type: meta.issueTypes.find((t) => t.id === meta.selectedIssueTypeId)?.name ?? draft.type,
  priority: meta.priorities.find((p) => p.id === meta.selectedPriorityId)?.name,
  epic_key: meta.selectedEpicKey ?? undefined,
  assignee_account_id: meta.selectedAssignee?.accountId
    ?? (settings.autoAssign ? myAccountIdRef.current ?? undefined : undefined),
  labels: draft.labels ?? [],
  subtask_keys: createdSubtasks.map((s) => s.jira_key),
  title: draft.title,
  initial_prompt: ctx.prompt,
  interview_transcript: ctx.interview_transcript,
  description_markdown,
  subtasks: createdSubtasks,
}).catch((e) => {
  console.warn("ticket_save_history failed:", e);
  notify("Couldn't save local ticket history", {
    kind: "warning",
    description: e instanceof Error ? e.message : String(e),
  });
});
```

If `notify` is not yet imported in `Draft.tsx`, add it to the existing `lib/notify` import.

- [ ] **Step 8: Typecheck**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 9: Manual smoke**

Run: `pnpm tauri dev`. Five scenarios:

A. **No interview, global default ON**: submit normally. Draft sidebar shows "Split into subtasks" switch in ON position. If the model proposes subtasks, the Create pipeline shows the expand + subtasks rows.

B. **No interview, flip switch OFF on Draft**: submit again. Same draft, switch flipped OFF before Create. Pipeline omits expand + subtasks rows entirely. Verify Jira ticket created with no child issues. Sidebar `### Subtasks` strip from description still runs (parent body has no orphan bullet list).

C. **Global default OFF in Settings**: switch flips global. Submit a fresh draft. Sidebar switch initial state = OFF. Pipeline omits subtask steps unless user flips it ON.

D. **Interview flow**: from Main with Interview Mode on, complete an interview, click Generate. Verify the Draft ticket reflects the interview's sharpened scope (the description should match the discussed answers, not just the original one-liner).

E. **History on publish**: in any of the above scenarios, after the Create pipeline completes successfully, inspect `${appDataDir}/tickets/<uuid>.md`. On macOS the app data dir is typically `~/Library/Application Support/<bundle-id>/tickets/`. Find the bundle id in `src-tauri/tauri.conf.json` if needed. Verify:
   - Frontmatter has `jira_key`, `project_key`, `issue_type`, `labels`, `subtask_keys`, `had_interview` matching the scenario.
   - Body contains `# Initial prompt`, `# Final ticket description`, and (when had_interview) `# Interview transcript` and (when subtasks created) `# Subtasks` with one `## PROJ-N — Title` heading per child issue.

- [ ] **Step 10: Commit**

```bash
git add src/screens/Draft.tsx
git commit -m "feat(draft): subtask switch + interview transcript forwarding + ticket history persistence"
```

---

## Task 13: End-to-end verification + spec back-link

**Files:**
- Modify: `docs/superpowers/specs/2026-05-18-interview-mode-and-subtask-toggle-design.md` (status bump)

- [ ] **Step 1: Run the full type+build gate**

Run: `pnpm build`
Expected: PASS, no errors.

Run: `cd src-tauri && cargo check`
Expected: PASS.

- [ ] **Step 2: Manual end-to-end checklist**

Boot: `pnpm tauri dev`. Walk through:

1. **Fresh launch hydrate**: `interviewMode === false` (pill grey), `splitIntoSubtasks === true` (Settings switch on).
2. **Sticky `interviewMode`**: check pill → quit app → relaunch → pill still checked.
3. **Non-interview submit**: pill off → submit "Add a copy button to the issue header" → Draft streams as before. Switch on sidebar reads ON. Create → pipeline runs (no subtasks because copy button is a small change — model usually emits empty array).
4. **Interview submit**: pill on → submit "We need analytics on user signups." → Interview screen appears with first restated summary + first question and a recommendation. Reply across 3–5 turns. Verify exactly ONE question per assistant turn. Verify each question includes a recommendation. Verify `[[READY]]` sentinel is hidden when emitted, and the banner appears.
5. **Generate ticket**: click Generate → Draft mounts and streams. The streamed body should incorporate decisions from the transcript, not just paraphrase the original one-liner. Inspect the description.
6. **Ticket record on disk**: after Create succeeds, `ls ~/Library/Application\ Support/<bundle-id>/tickets/` shows a fresh `<uuid>.md` whose frontmatter carries `jira_key`, `had_interview: true`, `subtask_keys`, etc., and whose body contains `# Initial prompt`, `# Interview transcript`, `# Final ticket description`, `# Subtasks` (when present).
7. **Subtask switch OFF on Draft (interview path)**: in step 5's Draft, if subtasks were proposed, flip the switch OFF and click Create. Pipeline modal omits the expand + subtasks rows. Jira ticket has no child issues. The history record has empty `subtask_keys` and no `# Subtasks` body section.
8. **Cancellation**: open an Interview, send a reply, hit Back mid-stream → no console warning, no orphan listener noise on next session.
9. **Voice on Interview**: mic button starts/stops; transcripts merge into the reply textarea.

If anything fails, the failure is the bug — fix it, re-run.

- [ ] **Step 3: Bump spec status**

Open `docs/superpowers/specs/2026-05-18-interview-mode-and-subtask-toggle-design.md`. Change the top line:

```markdown
**Status:** Approved (brainstorming)
```

to:

```markdown
**Status:** Shipped
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-05-18-interview-mode-and-subtask-toggle-design.md
git commit -m "docs: mark interview-mode + subtask-toggle spec as shipped"
```

---

## Self-review notes (post-write)

- **Spec coverage:** all 12 sections of the spec map to tasks. §1 Settings → Task 1. §2 Main pill → Task 10. §3 Store → Task 8. §4 Interview screen → Task 11. §5 `ai_interview` → Task 4. §6 Interview prompts → Task 5. §7 `ai_draft` transcript extension → Tasks 5–6. §8 Ticket history persistence → Tasks 3, 12. §9 Subtask toggle → Tasks 9, 12. §10 Command registration → Task 6. §11 Frontend wrappers → Task 7. §12 Out of scope → respected (no Ticket History UI introduced).
- **Placeholder scan:** no TBD / TODO / "implement appropriate". Every code step shows the full code to paste.
- **Type consistency:** `InterviewMessage` shape (`role`, `content`, `ts`) is identical across `src/types.ts`, `src-tauri/src/ai/mod.rs`, `Interview.tsx`. `interview_transcript` field name matches in `DraftRequest` (Rust), `DraftArgs` (TS), `DraftContext` (TS), `SaveHistoryPayload` / `SaveHistoryRequest`. `splitIntoSubtasks` settings key matches between `types.ts`, Settings.tsx, and Draft.tsx. `interviewMode` settings key matches between `types.ts`, Main.tsx, and the persisted store. `ticketSaveHistory` / `ticket_save_history` / `SaveHistoryPayload` / `SaveHistoryRequest` field names are 1:1 between TS and Rust (snake_case on both sides since the Rust struct uses default serde naming).
