# Interview Mode + Subtask Toggle — Design

**Status:** Approved (brainstorming)
**Date:** 2026-05-18
**Author:** Kevin Koester
**Out-of-scope follow-up specs:** Ticket History UI (reads from the per-ticket Markdown records written here on Jira publish).

## Summary

Two coordinated changes to the draft flow:

1. **Interview Mode** — opt-in checkbox on the Main prompt UI. When enabled, the submit routes through a new chat-style Interview screen where the AI asks one focused question at a time (with a recommended answer) until shared understanding is reached. User clicks **Generate ticket** to promote the transcript into a normal draft on the existing Draft screen. The transcript travels in-memory; persistence happens once the ticket is published to Jira (see §8).
2. **Subtask toggle** — global default in Settings ("Split tickets into subtasks by default", ON by default) plus a session-only switch in the Draft sidebar. When disabled, the create pipeline skips both the sub-task expansion AI call and the Jira sub-task POSTs. Flipping the switch on the Draft sidebar does NOT write back to the global default.

Naming note: the underlying skill is `grill-me`, but the UI says "Interview Mode" — the skill body is injected as a system prompt at runtime; we do not load or reference a skill file.

## Goals

- Improve ticket quality for fuzzy / under-specified prompts by gathering missing context before drafting.
- Give the user explicit control over sub-task creation per draft, without forcing them to flip a global setting before each submission.
- Lay groundwork for Ticket History (per-ticket Markdown records written on Jira publish) without building the History UI itself.

## Non-goals (v1)

- No Ticket History UI / list / search (separate spec). No session-resume — History is read-only metadata browsing.
- No native provider session IDs (Claude `--session-id`, Codex resume) — stateless replay across all providers for uniformity.
- No mid-interview provider/model/mode switching.
- No interview-mode toggle on the Settings page — it's a per-Main UI state, persisted across sessions only for stickiness, like `defaultMode`.
- No persistence of in-progress interview transcripts before Jira publish (only published tickets get written to disk).
- No sentinel-driven re-generation if user disagrees with the AI's "ready" signal.

## User-facing flow

### Without Interview Mode (unchanged today)
Main → enter prompt → submit → Draft screen → ticket streams → user refines / creates Jira issue.

### With Interview Mode (new)
Main → check "Interview Mode" → enter prompt → submit → **Interview screen** → AI restates the idea, asks Q1 with recommended A → user replies (text or voice) → repeat → AI emits `[[READY]]` sentinel when discovery feels complete → "Generate ticket" button highlights + banner appears → user clicks Generate → **Draft screen** → ticket streams using the transcript as authoritative context.

User may click Generate at any point regardless of sentinel state.

### Subtask toggle
- Default global ON. Behavior identical to today for existing users.
- On Draft, sidebar has a "Split into subtasks" switch (always visible) initialized from the global setting. Flipping it affects only the current draft. When OFF, the Create pipeline excludes both the "Drafting subtask descriptions" and "Creating subtasks" rows; no greyed-out "skipped" row.

## Architecture

### Two-process model (existing)
- Frontend: React 19 + TypeScript. State via Zustand store; persisted settings via `tauri-plugin-store`.
- Backend: Tauri / Rust. `#[tauri::command]` functions invoked from TS, registered in `lib.rs::run()`.

### New components

```
Main ─checkbox── openInterview(ctx) ──▶ Interview screen
                                            │
                                            │ promoteInterviewToDraft(ctx + transcript)
                                            │
                                            ▼
                                       Draft screen ──ai_draft(interview_transcript=…)──▶ Jira
```

The Interview screen is structurally a chat UI over a new `ai_interview` Tauri command that mirrors `ai_draft`'s streaming event surface. Each user reply triggers a fresh streaming call with the full transcript in the user prompt — stateless replay. No new backend chat-session machinery.

## Detailed design

### §1 Settings schema additions (`src/types.ts`)

```ts
export interface AppSettings {
  // …existing fields…
  interviewMode: boolean;          // checkbox state on Main; sticky across sessions
  splitIntoSubtasks: boolean;      // global default for subtask creation
}

export const DEFAULT_SETTINGS: AppSettings = {
  // …existing defaults…
  interviewMode: false,
  splitIntoSubtasks: true,
};
```

Persistence works via existing `tauri-plugin-store` merge — when keys absent in stored file, `DEFAULT_SETTINGS` fills them on hydrate. No migration code needed.

### §2 Main composer pill (`src/screens/Main.tsx`)

Add a slim top row inside the input card, above the textarea, left-aligned. Pill-style toggle bound to `settings.interviewMode`.

Visual spec:
- Container: `padding: 8px 14px 0` inside existing input card.
- Pill: `height: 22px; border-radius: 999px; padding: 0 10px; font: 500 11.5px var(--font-text); display: inline-flex; align-items: center; gap: 6px`.
- Inactive: `border: 0.5px solid var(--border-strong); color: var(--fg-muted); background: transparent`.
- Active: `background: var(--accent-soft); color: var(--accent); border-color: color-mix(in oklab, var(--accent) 22%, transparent)`.
- Click: `setSettings({ interviewMode: !interviewMode })`. Plays `playUi("toggle")` like existing segmented controls.
- Tooltip via `useGlobalTooltip` (same pattern as `ReferenceButton`):
  ```tsx
  <div>
    <div style={{ font: "600 12px var(--font-mono)", marginBottom: 2 }}>Interview Mode</div>
    <div style={{ font: "400 11px var(--font-mono)", color: "var(--background)", opacity: 0.65, lineHeight: 1.5 }}>
      Agent asks you questions until a ticket is ready,<br />
      instead of using just the initial prompt context
    </div>
  </div>
  ```

Submit handler change in `handleSubmit`:
```ts
const target = settings.interviewMode ? openInterview : openDraft;
target({ prompt: trimmed, provider, mode, model: modelId, attachments, attachmentSessionId, references, referenceSessionId });
```

### §3 Store changes (`src/store.ts`)

```ts
export type Screen = "loading" | "onboarding" | "main" | "interview" | "draft" | "settings";

export interface InterviewMessage {
  role: "user" | "assistant";
  content: string;
  ts: number;  // unix ms
}

export interface AppStoreState {
  // …existing fields…
  interviewCtx: DraftContext | null;
  openInterview: (ctx: DraftContext) => void;
  closeInterview: () => void;
  promoteInterviewToDraft: (
    transcript: InterviewMessage[],
    transcriptPath: string | null,
  ) => void;
}
```

`promoteInterviewToDraft` builds a new `DraftContext` by:
- Carrying through `provider`, `mode`, `model`, `prompt`, `attachments`, `attachmentSessionId`.
- Dropping `references` / `referenceSessionId` (per design call — interview transcript already contains analyzed context; saves tokens and avoids re-reading files).
- Adding new optional `interview_transcript: string` field formatted as Markdown.
- Setting `screen: "draft"`, clearing `interviewCtx`.

`DraftContext` gains:
```ts
interview_transcript?: string;
```

### §4 Interview screen (`src/screens/Interview.tsx` — NEW)

Single-column layout. Top bar carries Back button (closeInterview → setScreen("main")) and model chip. Body splits into:
1. Small persona orb (120×120, listening state when streaming).
2. Scrollable conversation thread (`role: "user"` and `role: "assistant"` bubbles).
3. Optional "AI thinks it has enough — generate ticket?" banner when `aiThinksReady === true`.
4. Reply composer (textarea + mic + send + Generate button). Same chrome as Main composer.

Local state:
```ts
const [messages, setMessages] = useState<InterviewMessage[]>([]);
const [streaming, setStreaming] = useState(false);
const [streamingText, setStreamingText] = useState("");
const [streamError, setStreamError] = useState<string | null>(null);
const [aiThinksReady, setAiThinksReady] = useState(false);
const [replyText, setReplyText] = useState("");
const [voiceActive, setVoiceActive] = useState(false);
// attachments & references carried from interviewCtx; can add more during interview
```

Lifecycle:
1. On mount: push initial USER message with `ctx.prompt`, then call `runTurn()`.
2. `runTurn()`:
   - Allocate `request_id` (uuid).
   - Listen via `listenInterview(rid, { onChunk, onDone, onError })`.
   - Invoke `aiInterview({ request_id, provider, model, mode, tone, custom_system_prompt, messages, attachment_ids, reference_ids })`.
   - `onChunk(t)` appends to `streamingText`.
   - `onDone` pushes `{ role: "assistant", content: finalText, ts }` into `messages`; clears `streamingText`; sets `aiThinksReady` if text contains `[[READY]]` (strip before display).
3. `handleSendReply()`: push `{ role: "user", content, ts }`, clear textarea, call `runTurn()`.
4. `handleGenerate()`:
   - Strip `[[READY]]` from any assistant text.
   - Serialize transcript to Markdown string.
   - `promoteInterviewToDraft(transcriptMarkdown)` → Draft mounts with `ctx.interview_transcript` set.
   - No disk write here; the transcript is persisted on Jira publish inside `Draft.tsx::handleCreate` (see §8).
5. Voice: same `startVoice` / `listenSpeech` wiring as Main, scoped to reply textarea.

### §5 Backend: `ai_interview` command (`src-tauri/src/ai/mod.rs`)

```rust
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct InterviewMessage {
    pub role: String,     // "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct InterviewRequest {
    pub request_id: String,
    pub provider: Provider,
    pub mode: String,
    pub messages: Vec<InterviewMessage>,
    #[serde(default)] pub tone: Option<String>,
    #[serde(default)] pub custom_system_prompt: Option<String>,
    #[serde(default)] pub model: Option<String>,
    #[serde(default)] pub attachment_ids: Vec<String>,
    #[serde(default)] pub reference_ids: Vec<String>,
}

#[tauri::command]
pub async fn ai_interview(app: AppHandle, state: State<'_, AppState>, req: InterviewRequest) -> AppResult<()> { /* ... */ }
```

Implementation mirrors `ai_draft`:
- Same canceller plumbing (registered under `state.ai_cancellers`).
- Same streaming events (`ai:chunk:{rid}`, `ai:done:{rid}`, `ai:error:{rid}`).
- `DraftDone.ticket` always `None` (no parseable ticket block).
- System prompt = `prompt::build_interview_prompt(&req.mode, tone, custom)`.
- User prompt = `prompt::build_interview_user_prompt(&req.messages)` — formatted transcript:
  ```
  USER: <first message>

  ASSISTANT: <prior question>

  USER: <reply>

  ASSISTANT:
  ```
  Trailing `ASSISTANT:` marker primes the model to continue with the next assistant turn.
- Attachment + reference routing identical to `ai_draft` (calls existing `attachments::resolve_many`, `route_attachments`, `state.references.build_payload_for_ids`).

### §6 Interview system prompt (`src-tauri/src/ai/prompt.rs`)

```rust
pub fn build_interview_prompt(mode: &str, tone: &str, custom: Option<&str>) -> String { /* … */ }
pub fn build_interview_user_prompt(messages: &[InterviewMessage]) -> String { /* … */ }
```

System prompt is a tuned adaptation of `grill-me.md`. Key elements:
- Voice per mode: PO → product strategist; DEV → senior tech lead.
- Phase 1 (Understand & Expand): restate the request in ONE sentence on the first turn; then sharpen one branch at a time.
- Phase 2 (Evaluate & Converge): surface contradictions, stress-test with scenarios, invent edge cases.
- Phase 3 (Sharpen & Ship): when the request is sharp enough, emit a one-paragraph wrap-up followed by the literal token `[[READY]]` on its own line — the frontend strips this and surfaces the ready banner.
- Hard rules:
  - **Exactly one question per assistant turn.**
  - **Every question must include a recommended answer** (`My recommendation: X, because Y.`).
  - **Never write code, propose implementations, or paste reference file contents into responses.**
  - Stay in English regardless of input language.
  - When a question is answerable from attachments/references, answer it yourself and skip — don't ask.

### §7 `ai_draft` extension for transcript synthesis (`src-tauri/src/ai/mod.rs`, `prompt.rs`)

`DraftRequest` gains:
```rust
#[serde(default)] pub interview_transcript: Option<String>,
```

`build_user_prompt` signature changes:
```rust
pub fn build_user_prompt(
    prompt: &str,
    refine_of: Option<&str>,
    transcript: Option<&str>,
) -> String {
    if let Some(prev) = refine_of {
        // …existing refine path…
    }
    if let Some(t) = transcript {
        return format!(
            "The requester completed an interview before this draft. \
             Treat the transcript below as the AUTHORITATIVE source for \
             scope, intent, and decisions. The original prompt is included \
             only as context for the interview's starting point.\n\n\
             ## Original prompt\n\n{prompt}\n\n## Interview transcript\n\n{t}",
        );
    }
    format!("## User input\n\n{prompt}")
}
```

Call site in `ai_draft` updated. Frontend `aiDraft` wrapper gains `interview_transcript?: string`; Draft.tsx forwards `ctx.interview_transcript`.

### §8 Ticket history persistence (`src-tauri/src/history.rs` — NEW)

```rust
#[derive(Debug, Deserialize)]
pub struct SaveHistoryRequest {
    pub jira_key: String,
    pub jira_url: Option<String>,
    pub provider: String,
    pub mode: String,
    pub model: Option<String>,
    pub project_key: String,
    pub issue_type: String,
    pub priority: Option<String>,
    pub epic_key: Option<String>,
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

#[derive(Debug, Deserialize)]
pub struct SavedSubtask {
    pub jira_key: String,
    pub title: String,
    #[serde(default)]
    pub description_markdown: Option<String>,
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
    // 1. Resolve ${appDataDir}/tickets/, create if missing.
    // 2. Generate UUID v4.
    // 3. Write `${dir}/<uuid>.md` with frontmatter + body sections.
    // 4. Return { path, id }.
}
```

Designed for forward-compatible migration:
- Front-matter carries every list-view field the future History UI needs without parsing body.
- Pure-Markdown body keeps the file human-readable in Finder/Quick Look.
- UUID-named file means filename collisions never happen on rapid submits.
- `had_interview` flag in frontmatter lets the History UI badge tickets that came through Interview Mode.

Privacy: stored unencrypted alongside other local app data (same posture as existing draft caches). Secrets stay in Keychain. Ticket History UI spec will add delete/prune.

### §9 Subtask toggle wiring (`src/screens/Draft.tsx`, `src/screens/Settings.tsx`)

**Settings.tsx** — add row in Drafting section, matching `submitOnEnter` / `autoAssign` visual pattern:
```
[Switch] Split tickets into subtasks by default
         When off, the AI may still propose subtasks in the draft body
         but they won't be created as Jira issues unless you enable
         Split for that specific draft.
```
Bound to `settings.splitIntoSubtasks`.

**Draft.tsx** — at top of right meta sidebar, directly under the existing "Details" heading and above the first `MetaRow` block:

```tsx
const [splitIntoSubtasksLocal, setSplitIntoSubtasksLocal] = useState(
  settings.splitIntoSubtasks,
);

// inside sidebar JSX, directly under "Details" heading
<div style={{
  display: "flex", alignItems: "center", justifyContent: "space-between",
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

Pipeline gate in `handleCreate`:
```ts
const wantsSubtasks = splitIntoSubtasksLocal;
const subtasks = wantsSubtasks
  ? (draft.subtasks ?? []).map((s) => s.trim()).filter(Boolean)
  : [];
// rest of pipeline already keyed off subtasks.length — empty list = no expand/create steps
```

`description_markdown` still gets the `### Subtasks` section stripped (existing behavior) so the parent ticket body doesn't carry orphaned bullet lists.

The switch row state is `useState` only — flipping it never calls `setSettings`. Returning to Main and starting a new draft picks up the global default again.

### §10 New tauri command registrations (`src-tauri/src/lib.rs`)

```rust
.invoke_handler(tauri::generate_handler![
    // …existing…
    ai::ai_interview,
    history::ticket_save_history,
])
```

Both inherit existing capability allowlist (`core:default` covers `tauri://invoke`). No new permission entries needed.

### §11 Frontend Tauri wrappers (`src/lib/tauri.ts`)

```ts
export async function aiInterview(req: AiInterviewRequest): Promise<void> { return invoke("ai_interview", { req }); }

export async function listenInterview(
  requestId: string,
  handlers: { onChunk?: (t: string) => void; onDone?: (d: InterviewDoneEvent) => void; onError?: (msg: string) => void },
): Promise<() => void> { /* mirrors listenDraft */ }

export async function ticketSaveHistory(payload: SaveHistoryPayload): Promise<{ path: string; id: string }> {
  return invoke("ticket_save_history", { req: payload });
}
```

Types added to `src/types.ts` (in addition to existing `AiDraftRequest` which gains the new optional `interview_transcript?: string` field):
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

## Data flow

```
Main:
  text + interviewMode=true + attachments + refs
       │
       ▼
  openInterview(DraftContext)
       │
       ▼
Interview screen:
  messages: [USER: prompt]
       │ runTurn() ── ai_interview ──▶ Rust
       ▼                                  │
  messages: [USER, ASSISTANT(Q1+rec)]    │ stream chunks
       │                                  ▼
  user replies, push USER, runTurn()    ai:chunk / ai:done
       │
       ▼  AI eventually emits [[READY]]
  aiThinksReady = true; banner shows
       │
       ▼  user clicks "Generate ticket"
  promoteInterviewToDraft(transcriptMarkdown)
       │
       ▼
Draft screen:
  ai_draft({ prompt: ctx.prompt, interview_transcript, ... })
       │  (references dropped per design; attachments preserved)
       ▼
  streams ticket Markdown + JSON tail as usual
       │
       ▼
  user reviews; flips "Split into subtasks" if needed; clicks Create
       │
       ▼
  jira_create_issue + jira_upload_attachment* + (if splitIntoSubtasksLocal) ai_expand_subtasks + jira_create_subtask*
       │
       ▼  on success
  ticket_save_history({ jira_key, jira_url, title, project_key, issue_type, …,
                        initial_prompt, interview_transcript?, description_markdown,
                        subtasks: [{ jira_key, title, description_markdown? }, …] })
       │  ── Rust ──▶ writes ${appDataDir}/tickets/<uuid>.md
       ▼  (fire-and-forget; warning toast on failure, no UI block)
  "Created" overlay → user opens ticket or starts a new one
```

## Error handling

- **Interview turn fails mid-stream**: render error in conversation thread as a "Retry last turn" affordance. Existing `streamError` pattern applies. User's prior reply isn't lost — it's already in `messages`.
- **User clicks Generate before any AI turn completes**: button disabled until first assistant turn lands.
- **History save fails on Jira publish**: surface as a warning toast; do NOT block the success UI. The Jira ticket and sub-tasks were already created — losing the local history record is recoverable (user can re-publish by hand only if they care).
- **Subtask switch off, but AI proposed subtasks**: subtasks present in `streamText` (visible to user in the rendered body until create-time), but `handleCreate` filters them out. No greyed-out pipeline row. Description still has the `### Subtasks` section stripped.
- **Interview cancelled (Back button or window close)**: cleanupRef cancels in-flight `ai_interview` call via existing canceller plumbing; reference + attachment sessions purged on Interview unmount.

## Testing approach

No automated tests are wired into this repo (only `pnpm build` typecheck). Manual verification per change set:

1. **Settings hydration**: fresh install — `interviewMode === false`, `splitIntoSubtasks === true`. Hydrated install missing new keys — same defaults applied.
2. **Pill toggle**: click pill on Main, reload app, pill still checked. Submit with pill checked → Interview screen mounts. Submit with pill unchecked → Draft screen mounts (existing behavior).
3. **Interview turn loop**: send first prompt → AI emits restated summary + Q1 with recommendation. Reply → AI emits Q2. Verify exactly one question per turn (visual review of assistant messages).
4. **Ready sentinel**: type contradictory / vague answers until model emits `[[READY]]`. Verify sentinel stripped from displayed text and "Generate ticket" banner appears. Verify Generate button styling changes.
5. **Generate handoff**: click Generate → Draft mounts → ticket streams. Verify references session purged. (No disk write yet at this stage.)
5a. **History on publish**: complete the Draft Create flow against a real Jira project. After the success overlay, inspect `${appDataDir}/tickets/<uuid>.md`. Verify frontmatter includes the Jira key, project, issue type, labels, sub-task keys (if any), and `had_interview: true`. Verify the body sections contain initial prompt, transcript, final description, and sub-task bodies.
6. **Cancellation**: open Interview, send first turn, click Back mid-stream. Verify no leaked listener (no second draft emerging on next session — open Activity Monitor / log).
7. **Voice**: click mic in reply composer; speak; verify transcript appears in textarea.
8. **Subtask toggle, global ON**: submit normally → switch on sidebar reads ON → Create → pipeline shows expand + subtasks rows.
9. **Subtask toggle, flip OFF in sidebar**: Create → pipeline omits expand + subtasks rows entirely.
10. **Subtask toggle, global OFF, sidebar flipped ON for this draft only**: Create → pipeline runs subtasks. Return to Main → next Draft loads with switch OFF again (global default unchanged).
11. **`pnpm build`**: clean typecheck.

## Risks & mitigations

- **Sentinel collision**: model emits `[[READY]]` inside body content unrelated to readiness. *Mitigation*: regex matches only on its own line at end of message, after a blank line. False positives still possible; user can always send another reply if Generate button appears prematurely.
- **Token cost on long interviews**: stateless replay resends full transcript each turn — cost grows ~O(n²) by total length. *Mitigation*: acceptable for v1 (interviews target a handful of turns). Future optimization: native session IDs for CLI providers.
- **Reference files re-read every interview turn**: each `ai_interview` call resolves refs and builds payload. *Mitigation*: existing reference cache; cost is read-from-disk, not network. Acceptable.
- **Transcript privacy**: plaintext on local disk. *Mitigation*: same posture as existing draft caches; secrets remain in Keychain. Ticket History spec will add explicit delete/prune UI.
- **Schema drift between this spec and Ticket History UI**: front-matter fields chosen here lock the structure History will read. *Mitigation*: keep front-matter minimal and machine-readable; document the contract in this file so the UI spec inherits it. Adding new optional frontmatter keys later is forward-compatible; renaming or removing keys requires a migration pass.
- **History persists on EVERY publish, including drafts not driven by Interview**: by design — the file is the full ticket record, not just an interview record. `had_interview: false` distinguishes them. *Mitigation*: none needed; this is the intent.

## Files touched

| File | Change |
|---|---|
| `src/types.ts` | Add `interviewMode`, `splitIntoSubtasks` to `AppSettings` + `DEFAULT_SETTINGS`. Add `InterviewMessage`, `AiInterviewRequest`, `SavedSubtask`, `SaveHistoryPayload`, `SaveHistoryResult`. Extend `DraftContext` and `DraftArgs` with optional `interview_transcript`. |
| `src/store.ts` | Add `"interview"` to `Screen`. Add `interviewCtx`, `openInterview`, `closeInterview`, `promoteInterviewToDraft`. |
| `src/App.tsx` | Render `<Interview/>` when `screen === "interview"`. |
| `src/screens/Main.tsx` | Add Interview Mode pill above textarea. Branch submit between `openInterview` / `openDraft`. |
| `src/screens/Interview.tsx` | NEW. Chat thread, reply composer, ready banner, Generate button, voice + attachments wiring. |
| `src/screens/Draft.tsx` | `splitIntoSubtasksLocal` state initialized from `settings.splitIntoSubtasks`. New sidebar switch row above existing MetaRows. Pipeline gate in `handleCreate`. Forward `ctx.interview_transcript` to `aiDraft`. After successful Jira publish, fire-and-forget `ticketSaveHistory(...)` with full payload (initial prompt, transcript if any, final description, sub-task keys + bodies). |
| `src/screens/Settings.tsx` | New row in Drafting section: "Split tickets into subtasks by default". |
| `src/lib/tauri.ts` | `aiInterview`, `listenInterview`, `ticketSaveHistory` wrappers. |
| `src-tauri/src/ai/mod.rs` | Add `InterviewMessage`, `InterviewRequest`, `ai_interview` command. Extend `DraftRequest` with `interview_transcript`. Update `ai_draft` to pass transcript through to `build_user_prompt`. |
| `src-tauri/src/ai/prompt.rs` | Add `build_interview_prompt`, `build_interview_user_prompt`. Extend `build_user_prompt` signature. |
| `src-tauri/src/history.rs` | NEW. `ticket_save_history` command + markdown writer. |
| `src-tauri/src/lib.rs` | `mod history;`. Register `ai::ai_interview`, `history::ticket_save_history` in `generate_handler!`. |

## Open questions

None.

## References

- `_design/main-screen.jsx`, `_design/draft-screen.jsx` — visual continuity targets.
- `/Users/koester/Workspace/agent-skills/skills/grill-me/SKILL.md` — source for the interview system prompt's three-phase shape and the "one question + recommendation" rule.
- `src-tauri/src/ai/mod.rs::ai_draft`, `prompt.rs::build_system_prompt` — patterns the new `ai_interview` command + prompt builders mirror.
