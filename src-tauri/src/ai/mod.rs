//! AI dispatcher. Routes a draft request to one of three backends:
//! - Anthropic Claude (local `claude` CLI)
//! - OpenAI Codex (local `codex` CLI)
//! - Google Gemini 2.5 Pro (direct API, key in macOS Keychain)
//!
//! All backends stream output to the frontend via Tauri events:
//!   - `ai:chunk:{request_id}` — partial text
//!   - `ai:done:{request_id}`  — final assembled text + parsed structured ticket
//!   - `ai:error:{request_id}` — terminal error

pub mod cli;
pub mod gemini;
pub mod openrouter;
pub mod openrouter_models;
pub mod prompt;

use crate::attachments::{self, AttachmentKind, ResolvedAttachment};
use crate::error::{AppError, AppResult};
use crate::secrets;
use crate::state::{self, AppState};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone)]
pub enum StreamChunk {
    Text(String),
    Error(String),
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    ClaudeCli,
    CodexCli,
    Gemini,
    OpenRouter,
}

#[derive(Debug, Deserialize)]
pub struct DraftRequest {
    pub request_id: String,
    pub provider: Provider,
    pub prompt: String,
    pub mode: String, // "PO" | "DEV"
    #[serde(default)]
    pub tone: Option<String>,
    #[serde(default)]
    pub custom_system_prompt: Option<String>,
    /// If present, request a refinement of the existing draft.
    #[serde(default)]
    pub refine_of: Option<String>,
    /// Per-provider model identifier the user picked in the model selector.
    /// Forwarded as `--model <id>` to the Claude CLI, `-m <id>` to the
    /// Codex CLI, or substituted into the path for the Gemini API. None
    /// → provider default.
    #[serde(default)]
    pub model: Option<String>,
    /// Attachment ids previously registered via `attachment_register_*`.
    /// Resolved server-side at request time so the webview never sees a
    /// path. Each id maps to a file in the per-session cache dir; the
    /// extracted text + image bytes are routed per-provider (see
    /// `route_attachments`).
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    /// Reference file/folder ids for DEV mode. These are local paths whose
    /// content is read and injected into the prompt as analysis context.
    /// They are NEVER uploaded to Jira.
    #[serde(default)]
    pub reference_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DraftDone {
    pub request_id: String,
    pub text: String,
    pub ticket: Option<ParsedTicket>,
}

/// Metadata sidecar parsed from the trailing fenced JSON block.
///
/// As of the slimmed prompt, the Markdown body above the JSON IS the ticket
/// description — this struct only carries the structured fields the UI
/// needs to pre-fill Jira's form (title input, issue-type / priority
/// selectors, labels). The body itself is shipped to Jira straight from
/// the streamed Markdown.
///
/// `description`, `acceptance_criteria`, and `tech_notes` were removed
/// from the schema. They survive on the struct as `#[serde(default)]`
/// fields purely so older responses (or a model that ignores the
/// instruction and emits the legacy schema) still parse cleanly without
/// an error — they're just ignored downstream.
#[derive(Debug, Serialize, Deserialize)]
pub struct ParsedTicket {
    pub title: String,
    pub r#type: String,
    pub priority: String,
    #[serde(default)]
    pub labels: Vec<String>,
    /// Subtask titles the model proposed. Each becomes a real Jira sub-task
    /// issue linked under the parent ticket — see `jira_create_subtask`.
    /// Empty array means the model decided the scope didn't warrant a
    /// subtask breakdown (small fix, single-PR work, etc).
    #[serde(default)]
    pub subtasks: Vec<String>,
    // Legacy / tolerated fields, no longer required by the prompt.
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub tech_notes: String,
}

/// Result of an `ai_expand_subtasks` call — one entry per sub-task we asked
/// the model to flesh out. The `title` is echoed back verbatim by the model
/// (the prompt requires it) so the caller can match expansions to the
/// original list by string equality, not just index.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SubtaskExpansion {
    pub title: String,
    pub description_markdown: String,
}

#[derive(Debug, Deserialize)]
pub struct ExpandSubtasksRequest {
    pub provider: Provider,
    pub mode: String,
    pub parent_title: String,
    pub parent_body_markdown: String,
    pub subtask_titles: Vec<String>,
    #[serde(default)]
    pub custom_system_prompt: Option<String>,
    /// Same as `DraftRequest.model` — pass through so the second-pass
    /// expansion uses the same model the user picked for the main draft.
    #[serde(default)]
    pub model: Option<String>,
    /// Same as `DraftRequest.attachment_ids`. The expansion call is small
    /// and structured, so attachments rarely add value here — but for
    /// consistency with the main draft we plumb them through too.
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DetectResult {
    pub claude: cli::CliStatus,
    pub codex: cli::CliStatus,
    pub gemini: GeminiStatus,
}

#[derive(Debug, Serialize)]
pub struct GeminiStatus {
    pub has_key: bool,
}

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn ai_detect_clis() -> AppResult<DetectResult> {
    let claude_fut = cli::probe_cli("claude");
    let codex_fut = cli::probe_cli("codex");
    let (claude, codex) = tokio::join!(claude_fut, codex_fut);
    let has_gemini = secrets::load()
        .map(|s| s.gemini_key.as_deref().is_some_and(|k| !k.is_empty()))
        .unwrap_or(false);
    Ok(DetectResult {
        claude,
        codex,
        gemini: GeminiStatus { has_key: has_gemini },
    })
}

#[tauri::command]
pub async fn ai_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    req: DraftRequest,
) -> AppResult<()> {
    let request_id = req.request_id.clone();
    log::info!(
        "ai_draft start: request_id={} provider={:?} mode={} prompt_len={} refine={}",
        request_id,
        req.provider,
        req.mode,
        req.prompt.len(),
        req.refine_of.is_some()
    );
    let (chunks_tx, mut chunks_rx) = mpsc::channel::<StreamChunk>(64);
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();

    // Register canceller.
    state
        .ai_cancellers
        .lock()
        .await
        .insert(request_id.clone(), {
            // We wrap the oneshot sender in an mpsc so the canceller slot has a
            // consistent type across backends. A single send is enough.
            let (mpsc_tx, mut mpsc_rx) = mpsc::channel::<()>(1);
            tokio::spawn(async move {
                if mpsc_rx.recv().await.is_some() {
                    let _ = cancel_tx.send(());
                }
            });
            mpsc_tx
        });

    let system = prompt::build_system_prompt(
        &req.mode,
        req.tone.as_deref().unwrap_or("balanced"),
        req.custom_system_prompt.as_deref(),
    );
    let base_user = prompt::build_user_prompt(&req.prompt, req.refine_of.as_deref());

    // Resolve attachments from the registry, then route per provider — see
    // `route_attachments` for the matrix. The text payload (xlsx/csv/pdf
    // bodies, etc.) is appended to the user prompt regardless of provider;
    // images and PDFs go through provider-specific channels.
    let resolved = attachments::resolve_many(&state.attachments, &req.attachment_ids);
    let route = route_attachments(req.provider, &resolved);
    log::info!(
        "ai_draft attachments: total={} routed_images={} routed_inline={} text_chars={}",
        resolved.len(),
        route.image_paths.len(),
        route.inline_attachments.len(),
        route.text_payload.as_ref().map(|t| t.len()).unwrap_or(0)
    );
    let user = match route.text_payload {
        Some(suffix) => format!("{base_user}{suffix}"),
        None => base_user,
    };

    // Append reference files/folders content for DEV mode analysis context.
    let user = if req.reference_ids.is_empty() {
        user
    } else {
        let ref_payload = state.references.build_payload_for_ids(&req.reference_ids).await;
        match ref_payload {
            Some(rp) => {
                log::info!(
                    "ai_draft references: count={} payload_chars={}",
                    req.reference_ids.len(),
                    rp.len()
                );
                format!("{user}{rp}")
            }
            None => user,
        }
    };

    // Spawn the provider pipeline.
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
        }
    });

    // Fan chunks out to the webview.
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

        // Wait for the backend task to fully finish to pick up any outer error.
        let backend_err = match backend.await {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(e.to_string()),
            Err(e) => Some(format!("join: {e}")),
        };

        let ticket = parse_ticket_block(&accum);
        if backend_err.is_none() && last_error.is_none() {
            log::info!(
                "ai_draft done: request_id={} text_len={} ticket_parsed={}",
                rid,
                accum.len(),
                ticket.is_some()
            );
            let _ = app_for_events.emit(
                &done_event,
                &DraftDone {
                    request_id: rid.clone(),
                    text: accum,
                    ticket,
                },
            );
        } else if let Some(err) = backend_err.or(last_error) {
            log::warn!("ai_draft error: request_id={} err={}", rid, err);
            let _ = app_for_events.emit(&error_event, &err);
        }

        cancellers.lock().await.remove(&rid);
    });

    Ok(())
}

/// Second-pass call: take the parent ticket + its sub-task titles, ask the
/// model to expand each title into a focused Markdown body suitable for a
/// real Jira sub-task. Used by the Draft screen between "Create main
/// ticket" and "Create sub-tasks" pipeline steps.
///
/// Why a separate command rather than another `ai_draft`: this is a
/// non-streaming, structured-output, throwaway call — there's no UI body
/// to stream into, no progress events, no cancellation. The caller blocks
/// on a single round-trip and gets back the parsed array (or an error).
/// Keeping it as its own command keeps the contract honest.
///
/// Failure semantics: the FRONTEND is expected to fall back to creating
/// subtasks with title-only descriptions if this command errors — losing
/// rich descriptions is a soft failure, halting the create pipeline isn't
/// worth it.
#[tauri::command]
pub async fn ai_expand_subtasks(
    state: State<'_, AppState>,
    req: ExpandSubtasksRequest,
) -> AppResult<Vec<SubtaskExpansion>> {
    log::info!(
        "ai_expand_subtasks: provider={:?} parent_title_len={} body_len={} subtask_count={}",
        req.provider,
        req.parent_title.len(),
        req.parent_body_markdown.len(),
        req.subtask_titles.len()
    );

    if req.subtask_titles.is_empty() {
        return Ok(Vec::new());
    }

    let system = prompt::build_subtask_expansion_prompt(
        &req.mode,
        req.custom_system_prompt.as_deref(),
    );
    let base_user = prompt::build_subtask_expansion_user_prompt(
        &req.parent_title,
        &req.parent_body_markdown,
        &req.subtask_titles,
    );

    let resolved = attachments::resolve_many(&state.attachments, &req.attachment_ids);
    let route = route_attachments(req.provider, &resolved);
    let user = match route.text_payload {
        Some(suffix) => format!("{base_user}{suffix}"),
        None => base_user,
    };

    // Reuse the existing streaming providers but accumulate the full
    // response. The expansion call is small (a few hundred tokens) so
    // there's nothing to gain by surfacing the chunks.
    let (chunks_tx, mut chunks_rx) = mpsc::channel::<StreamChunk>(64);
    let (_cancel_tx, cancel_rx) = oneshot::channel::<()>(); // never sent

    let http = state.http.clone();
    let provider = req.provider;
    let model = req.model.clone();
    let image_paths = route.image_paths;
    let inline_attachments = route.inline_attachments;
    let app_for_or = state::APP
        .get()
        .cloned()
        .ok_or_else(|| AppError::Other("app handle not initialized".into()))?;
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
        }
    });

    let mut accum = String::new();
    let mut error: Option<String> = None;
    while let Some(chunk) = chunks_rx.recv().await {
        match chunk {
            StreamChunk::Text(t) => accum.push_str(&t),
            StreamChunk::Error(e) => error = Some(e),
        }
    }
    // backend.await returns Result<AppResult<()>, JoinError> — we have
    // to unpack TWO levels of Result here. Previously the inner
    // AppError (the one cli::stream emits when, say, the binary isn't
    // found or auth fails) was being swallowed because we only matched
    // the outer JoinError case, leaving `error` empty and the caller
    // confused as to why nothing arrived.
    match backend.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => error = Some(e.to_string()),
        Err(e) => error = Some(format!("join: {e}")),
    }
    if let Some(e) = error {
        log::warn!(
            "ai_expand_subtasks: backend errored. accum_len={} err={}",
            accum.len(),
            e
        );
        return Err(AppError::Ai(e));
    }

    let expansions = match parse_subtask_expansions(&accum, &req.subtask_titles) {
        Some(v) => v,
        None => {
            // Diagnostic dump — first 4KB of what the model actually
            // returned, so we can see at-a-glance whether (a) the CLI
            // returned nothing at all, (b) we got prose with no JSON
            // fence, (c) we got JSON in a different shape, or (d)
            // something else weird.
            let preview: String = accum.chars().take(4096).collect();
            log::warn!(
                "ai_expand_subtasks: parse failed. accum_len={} preview=<<<\n{}\n>>>",
                accum.len(),
                preview,
            );
            return Err(AppError::Ai(format!(
                "AI didn't return parseable subtask JSON (accum_len={}, see logs for raw output)",
                accum.len(),
            )));
        }
    };
    log::info!(
        "ai_expand_subtasks ok: requested={} returned={}",
        req.subtask_titles.len(),
        expansions.len()
    );
    Ok(expansions)
}

#[tauri::command]
pub async fn ai_cancel(state: State<'_, AppState>, request_id: String) -> AppResult<()> {
    let mut cancellers = state.ai_cancellers.lock().await;
    if let Some(tx) = cancellers.remove(&request_id) {
        let _ = tx.send(()).await;
    }
    Ok(())
}

/// Spawn a system terminal window with the CLI's login command pre-typed.
/// Provider must be "claude" or "codex". Returns immediately after spawn —
/// the user completes the OAuth flow in the terminal and returns to the app.
#[tauri::command]
pub async fn ai_open_login(provider: String) -> AppResult<()> {
    cli::open_login_terminal(&provider)
}

// ─────────────────────────────────────────────────────────────
// Per-provider attachment routing
// ─────────────────────────────────────────────────────────────

/// Routed attachments grouped by how they should be delivered to the active
/// provider. Each provider consumes a different subset:
///
/// | Provider     | image_paths    | inline_attachments | text_payload  |
/// |--------------|----------------|--------------------|---------------|
/// | Claude CLI   | --image flags  | unused             | prompt suffix |
/// | Codex CLI    | unused (skip)  | unused             | prompt suffix |
/// | Gemini API   | unused         | inline_data parts  | prompt suffix |
///
/// `text_payload` is the same `[ATTACHED FILES]` block for all providers —
/// document extraction (xlsx → markdown table, pdf → text, etc) is
/// identical regardless of who sees it. Images are the only thing routed
/// asymmetrically because vision support varies.
struct AttachmentRoute {
    /// Image / pdf paths fed to Claude as repeated `--image <path>` flags.
    image_paths: Vec<PathBuf>,
    /// Image / pdf records fed to Gemini as `inline_data` parts.
    inline_attachments: Vec<ResolvedAttachment>,
    /// Text trailer appended to the user prompt — None when no attachment
    /// produced extractable text.
    text_payload: Option<String>,
}

fn route_attachments(provider: Provider, resolved: &[ResolvedAttachment]) -> AttachmentRoute {
    let text_payload = attachments::build_text_payload(resolved);

    let mut image_paths: Vec<PathBuf> = Vec::new();
    let mut inline_attachments: Vec<ResolvedAttachment> = Vec::new();

    for a in resolved {
        let visual = matches!(a.r#ref.kind, AttachmentKind::Image | AttachmentKind::Pdf);
        if !visual {
            continue;
        }
        match provider {
            Provider::ClaudeCli => image_paths.push(a.path.clone()),
            // Codex has no vision today — the frontend's image-attached
            // warning toast (see Main.tsx) tells the user the image will be
            // skipped. We honour that contract here by not even mentioning
            // the image to the model. Document extraction still flows
            // through `text_payload` so non-image attachments remain useful.
            Provider::CodexCli => {}
            // Gemini and OpenRouter both consume `inline_attachments` —
            // their respective `stream` modules each translate the records
            // into the right multimodal part shape (Gemini `inline_data`
            // vs OpenRouter `image_url` / `file`). OpenRouter additionally
            // gates images on the chosen model's `input_modalities`.
            Provider::Gemini | Provider::OpenRouter => inline_attachments.push(a.clone()),
        }
    }

    AttachmentRoute { image_paths, inline_attachments, text_payload }
}

// ─────────────────────────────────────────────────────────────
// JSON block parser — locates the final ```json fenced block.
// ─────────────────────────────────────────────────────────────

fn parse_ticket_block(text: &str) -> Option<ParsedTicket> {
    let json_str = extract_last_json_block(text)?;
    serde_json::from_str(json_str).ok()
}

/// Pulls the contents of the LAST ```json fenced block out of a possibly
/// chatty response. Shared by `parse_ticket_block` and the subtask
/// expansion parser since both providers wrap their structured payload in
/// a fenced block at the end.
fn extract_last_json_block(text: &str) -> Option<&str> {
    let lower = text.to_ascii_lowercase();
    let mut start = None;
    let mut search_from = 0;
    while let Some(pos) = lower[search_from..].find("```json") {
        start = Some(search_from + pos);
        search_from = search_from + pos + 7;
    }
    let start = start?;
    let after_fence = text[start..].find('\n').map(|n| start + n + 1)?;
    let end = text[after_fence..].find("```").map(|n| after_fence + n)?;
    Some(text[after_fence..end].trim())
}

/// Parse the AI's expansion response.
///
/// Tolerant: tries multiple shapes the model is likely to produce, in
/// rough order of strictness:
///
///   1. Fenced ```json``` block containing { "subtasks": [...] }
///   2. Fenced ```json``` block containing a bare array
///   3. The entire trimmed response as { "subtasks": [...] }
///   4. The entire trimmed response as a bare array
///   5. The largest balanced `[…]` or `{…}` substring — picks the JSON
///      out of free-form prose like "Here you go: [...]"
///
/// All four shapes accept `description` OR `description_markdown` as the
/// body field name (some providers and prompt drift produce the shorter
/// form, even though our prompt asks for `description_markdown`).
///
/// Title-snapping at the end overrides whatever the model echoed back
/// with the exact input string, so the caller can index by `==`.
fn parse_subtask_expansions(
    text: &str,
    expected_titles: &[String],
) -> Option<Vec<SubtaskExpansion>> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum FlexibleBody {
        Wrapped { subtasks: Vec<FlexibleEntry> },
        Bare(Vec<FlexibleEntry>),
    }
    #[derive(Deserialize)]
    struct FlexibleEntry {
        #[serde(default)]
        title: String,
        // Accept both forms — the prompt asks for `description` (Markdown
        // body) but some models echo our internal `description_markdown`
        // field name from the request schema.
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        description_markdown: Option<String>,
        #[serde(default)]
        body: Option<String>,
        #[serde(default)]
        markdown: Option<String>,
    }
    impl FlexibleEntry {
        fn into_expansion(self) -> SubtaskExpansion {
            let description_markdown = self
                .description
                .or(self.description_markdown)
                .or(self.body)
                .or(self.markdown)
                .unwrap_or_default();
            SubtaskExpansion {
                title: self.title,
                description_markdown,
            }
        }
    }

    fn try_parse(s: &str) -> Option<Vec<FlexibleEntry>> {
        match serde_json::from_str::<FlexibleBody>(s.trim()).ok()? {
            FlexibleBody::Wrapped { subtasks } => Some(subtasks),
            FlexibleBody::Bare(v) => Some(v),
        }
    }

    let candidates = [
        extract_last_json_block(text),
        Some(text),
        extract_largest_json_blob(text),
    ];

    let entries = candidates
        .into_iter()
        .flatten()
        .find_map(try_parse)?;

    let snapped = entries
        .into_iter()
        .map(FlexibleEntry::into_expansion)
        .enumerate()
        .map(|(i, mut e)| {
            if let Some(canon) = expected_titles.get(i) {
                if e.title.trim().to_lowercase() != canon.trim().to_lowercase() {
                    log::warn!(
                        "subtask expansion title drift at idx {}: model={:?} expected={:?}",
                        i, e.title, canon
                    );
                }
                e.title = canon.clone();
            }
            e
        })
        .collect();
    Some(snapped)
}

/// Find the longest substring that looks like a balanced JSON value (an
/// object or an array), starting from the first `{` or `[` at depth 0.
/// Useful when the model wraps JSON in narrative prose and forgets the
/// fenced block ("Here are your subtasks: [...] hope that helps!"). Naïve
/// — it only tracks bracket depth (string literals can confuse it if they
/// contain unbalanced brackets, but ours don't), so we use it as a last
/// resort after the strict / fenced parsers.
fn extract_largest_json_blob(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut start = None;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'{' || b == b'[' {
            start = Some(i);
            break;
        }
    }
    let start = start?;
    let open = bytes[start];
    let close = if open == b'{' { b'}' } else { b']' };
    let mut depth = 0i32;
    let mut last_close = None;
    let mut in_string = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            x if x == open => depth += 1,
            x if x == close => {
                depth -= 1;
                if depth == 0 {
                    last_close = Some(i);
                }
            }
            _ => {}
        }
    }
    let end = last_close?;
    Some(&text[start..=end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_slim_metadata_block() {
        // The current prompt asks the model to emit only metadata in the
        // JSON tail — the Markdown body above is authoritative for the
        // ticket content.
        let text = r#"### Title

Add dark mode

### Acceptance Criteria
- Preference persists
- System setting respected

```json
{
  "title": "Add dark mode",
  "type": "Story",
  "priority": "Medium",
  "labels": ["ui"]
}
```"#;
        let ticket = parse_ticket_block(text).expect("parses");
        assert_eq!(ticket.title, "Add dark mode");
        assert_eq!(ticket.r#type, "Story");
        assert_eq!(ticket.priority, "Medium");
        assert_eq!(ticket.labels, vec!["ui".to_string()]);
        // Legacy fields default to empty when not present.
        assert_eq!(ticket.description, "");
        assert!(ticket.acceptance_criteria.is_empty());
        assert_eq!(ticket.tech_notes, "");
    }

    #[test]
    fn tolerates_legacy_full_schema() {
        // A model that ignores the new instruction and still emits the
        // old description/acceptance_criteria/tech_notes fields shouldn't
        // crash the parser — those fields are silently accepted and
        // ignored by the UI (which uses the streamed Markdown body).
        let text = r#"```json
{
  "title": "Legacy",
  "description": "Old body",
  "acceptance_criteria": ["ac1"],
  "tech_notes": "notes",
  "type": "Task",
  "priority": "Low",
  "labels": []
}
```"#;
        let ticket = parse_ticket_block(text).expect("parses");
        assert_eq!(ticket.title, "Legacy");
        assert_eq!(ticket.description, "Old body");
        assert_eq!(ticket.acceptance_criteria, vec!["ac1".to_string()]);
    }

    #[test]
    fn returns_none_without_json_block() {
        let text = "just prose, no fenced block";
        assert!(parse_ticket_block(text).is_none());
    }

    fn titles() -> Vec<String> {
        vec!["First subtask".into(), "Second subtask".into()]
    }

    #[test]
    fn expansion_parser_fenced_wrapped() {
        let text = r#"```json
{
  "subtasks": [
    { "title": "First subtask", "description": "Body 1" },
    { "title": "Second subtask", "description": "Body 2" }
  ]
}
```"#;
        let r = parse_subtask_expansions(text, &titles()).expect("parses");
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].title, "First subtask");
        assert_eq!(r[0].description_markdown, "Body 1");
        assert_eq!(r[1].description_markdown, "Body 2");
    }

    #[test]
    fn expansion_parser_fenced_bare_array() {
        let text = r#"```json
[
  { "title": "First subtask", "description": "Body 1" },
  { "title": "Second subtask", "description": "Body 2" }
]
```"#;
        let r = parse_subtask_expansions(text, &titles()).expect("parses");
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn expansion_parser_bare_json_no_fence() {
        let text = r#"{
  "subtasks": [
    { "title": "First subtask", "description": "Body 1" },
    { "title": "Second subtask", "description": "Body 2" }
  ]
}"#;
        let r = parse_subtask_expansions(text, &titles()).expect("parses");
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].description_markdown, "Body 1");
    }

    #[test]
    fn expansion_parser_accepts_description_markdown_field_name() {
        let text = r#"[
  { "title": "First subtask", "description_markdown": "Body 1" },
  { "title": "Second subtask", "description_markdown": "Body 2" }
]"#;
        let r = parse_subtask_expansions(text, &titles()).expect("parses");
        assert_eq!(r[0].description_markdown, "Body 1");
        assert_eq!(r[1].description_markdown, "Body 2");
    }

    #[test]
    fn expansion_parser_picks_json_out_of_prose() {
        // Model preambled with "Here you go" — last-resort blob extractor
        // should still find the array.
        let text = r#"Here are your subtasks:

[
  { "title": "First subtask", "description": "Body 1" },
  { "title": "Second subtask", "description": "Body 2" }
]

Hope that helps!"#;
        let r = parse_subtask_expansions(text, &titles()).expect("parses");
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn expansion_parser_snaps_title_drift_to_canonical() {
        // Model returned a slightly different title — we override with
        // the canonical one so the frontend's exact-match lookup works.
        let text = r#"```json
[
  { "title": "First sub-task", "description": "Body 1" },
  { "title": "second SUBTASK", "description": "Body 2" }
]
```"#;
        let r = parse_subtask_expansions(text, &titles()).expect("parses");
        assert_eq!(r[0].title, "First subtask");
        assert_eq!(r[1].title, "Second subtask");
    }

    #[test]
    fn expansion_parser_returns_none_for_garbage() {
        assert!(parse_subtask_expansions("totally not json", &titles()).is_none());
    }
}
