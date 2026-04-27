//! Per-draft attachment storage.
//!
//! Files dropped/pasted/picked by the user are written to a session-scoped
//! cache directory, keyed by attachment id. The frontend never sees absolute
//! paths — only `AttachmentRef` records. All file I/O happens through the
//! commands in this module, which keeps the webview's filesystem surface area
//! at exactly zero (no `tauri-plugin-fs` dep).
//!
//! Layout:
//!   ${app_cache_dir}/attachments/${session_id}/${attachment_id}.${ext}
//!   ${app_cache_dir}/attachments/${session_id}/${attachment_id}.txt    (extracted)
//!
//! Lifecycle:
//!   - Session created lazily on first attachment register.
//!   - `attachment_purge_session` clears one session.
//!   - On boot, sessions older than 24 h are swept (see `sweep_stale`).

pub mod extract;

use crate::error::{AppError, AppResult};
use base64::Engine;
pub use extract::AttachmentKind;
use extract::MAX_EXTRACTED_CHARS;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

/// Hard per-file size cap. Anything larger is rejected before we touch
/// extraction or copy bytes around. 10 MB matches Atlassian's typical
/// per-attachment limit and keeps prompt budgets predictable.
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// Per-session cap on number of attachments.
const MAX_PER_SESSION: usize = 8;

/// How long an attachment session sticks around on disk before sweep.
const SESSION_TTL: Duration = Duration::from_secs(24 * 60 * 60);

// ─── Records ────────────────────────────────────────────────────

/// Frontend-visible record. No absolute path — only an opaque id, the
/// original filename, and metadata the UI needs to render a chip and to make
/// per-provider routing decisions.
#[derive(Debug, Clone, Serialize)]
pub struct AttachmentRef {
    pub id: String,
    pub session_id: String,
    pub filename: String,
    pub size_bytes: u64,
    pub mime: String,
    pub kind: AttachmentKind,
    /// Extracted character count. 0 for images. Useful for the UI to show
    /// "this file contributes ~3.4k characters to your prompt".
    pub extracted_chars: usize,
    /// Tiny preview thumbnail for image attachments only — base64 data URL,
    /// 64×64ish, suitable for an inline chip avatar. None for non-images.
    pub preview_data_url: Option<String>,
}

/// Internal record kept in the registry. Mirrors `AttachmentRef` plus the
/// resolved filesystem paths the frontend doesn't need to see.
#[derive(Debug, Clone)]
pub struct AttachmentEntry {
    pub r#ref: AttachmentRef,
    pub path: PathBuf,
    pub extracted_path: Option<PathBuf>,
}

/// In-memory index from id → entry. Lives on `AppState` so commands can
/// resolve ids without re-walking the filesystem on every call.
#[derive(Debug, Default)]
pub struct AttachmentRegistry {
    inner: Mutex<Vec<AttachmentEntry>>,
}

impl AttachmentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn list_all(&self) -> Vec<AttachmentEntry> {
        self.inner.lock().unwrap().clone()
    }

    fn list_session(&self, session_id: &str) -> Vec<AttachmentEntry> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.r#ref.session_id == session_id)
            .cloned()
            .collect()
    }

    fn count_session(&self, session_id: &str) -> usize {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.r#ref.session_id == session_id)
            .count()
    }

    fn insert(&self, entry: AttachmentEntry) {
        self.inner.lock().unwrap().push(entry);
    }

    fn remove(&self, id: &str) -> Option<AttachmentEntry> {
        let mut g = self.inner.lock().unwrap();
        let idx = g.iter().position(|e| e.r#ref.id == id)?;
        Some(g.remove(idx))
    }

    fn purge_session(&self, session_id: &str) -> Vec<AttachmentEntry> {
        let mut g = self.inner.lock().unwrap();
        let mut removed = Vec::new();
        g.retain(|e| {
            if e.r#ref.session_id == session_id {
                removed.push(e.clone());
                false
            } else {
                true
            }
        });
        removed
    }

    /// Resolve id → on-disk path. Used by the AI + Jira pipelines via
    /// `resolve_many` / `jira_upload_attachment_by_id`.
    pub fn resolve(&self, id: &str) -> Option<AttachmentEntry> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .find(|e| e.r#ref.id == id)
            .cloned()
    }
}

// ─── Storage helpers ────────────────────────────────────────────

fn session_dir(app: &AppHandle, session_id: &str) -> AppResult<PathBuf> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Other(format!("app_cache_dir: {e}")))?;
    Ok(base.join("attachments").join(session_id))
}

fn attachments_root(app: &AppHandle) -> AppResult<PathBuf> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Other(format!("app_cache_dir: {e}")))?;
    Ok(base.join("attachments"))
}

fn extension_of(filename: &str) -> String {
    Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_lowercase()
}

/// Tiny base64 image preview suitable for a chip avatar. We deliberately don't
/// downscale here — for the typical pasted screenshot (1-2 MB) the data URL is
/// well under what's reasonable to ship through IPC, and downscaling would pull
/// in `image` (a heavy crate) for marginal gain. If users start dropping 8K
/// photos we revisit.
fn make_image_preview(bytes: &[u8], mime: &str) -> Option<String> {
    if bytes.len() > 512 * 1024 {
        // Only generate a preview for images under 512 KB to keep the IPC
        // payload sane. Larger images render a generic icon in the UI.
        return None;
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

/// Create the session directory if it doesn't exist and write `bytes` to it
/// under a fresh attachment id. Performs all the validation, classification,
/// extraction, and registry insertion.
fn store(
    app: &AppHandle,
    registry: &AttachmentRegistry,
    session_id: &str,
    filename: &str,
    bytes: Vec<u8>,
) -> AppResult<AttachmentRef> {
    if bytes.is_empty() {
        return Err(AppError::Invalid("file is empty".into()));
    }
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(AppError::Invalid(format!(
            "file too large ({:.1} MB) — max is {:.0} MB",
            bytes.len() as f64 / 1_048_576.0,
            MAX_FILE_BYTES as f64 / 1_048_576.0
        )));
    }
    if registry.count_session(session_id) >= MAX_PER_SESSION {
        return Err(AppError::Invalid(format!(
            "too many attachments — max {MAX_PER_SESSION} per draft"
        )));
    }

    let ext = extension_of(filename);
    let kind = AttachmentKind::from_extension(&ext);
    if matches!(kind, AttachmentKind::Unsupported) {
        return Err(AppError::Invalid(format!(
            "unsupported file type \".{ext}\" — try png, jpg, pdf, xlsx, docx, csv, or txt"
        )));
    }

    let dir = session_dir(app, session_id)?;
    std::fs::create_dir_all(&dir)?;

    let id = Uuid::new_v4().to_string();
    let path = dir.join(format!("{id}.{ext}"));
    std::fs::write(&path, &bytes)?;

    // Run extraction synchronously. For documents this is the slow path but
    // it's bounded by MAX_FILE_BYTES + MAX_EXTRACTED_CHARS so the worst case
    // is well under a second on a modern machine.
    let (extracted_text, extracted_path, extracted_chars) = match extract::extract(&path, kind) {
        Ok(Some(text)) => {
            let txt_path = dir.join(format!("{id}.txt"));
            // Cache the extraction next to the original so we don't re-run
            // the parser on every send.
            std::fs::write(&txt_path, &text)?;
            let chars = text.chars().count().min(MAX_EXTRACTED_CHARS);
            (Some(text), Some(txt_path), chars)
        }
        Ok(None) => (None, None, 0),
        Err(e) => {
            // Extraction failure is non-fatal for images (already handled with
            // None) but for documents we propagate so the UI can surface a
            // useful message. Clean up the staged file first.
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
    };
    let _ = extracted_text; // The text lives on disk; we only need the count + path.

    let mime = kind.mime_hint(&ext).to_string();
    let preview = if matches!(kind, AttachmentKind::Image) {
        make_image_preview(&bytes, &mime)
    } else {
        None
    };

    let attachment_ref = AttachmentRef {
        id,
        session_id: session_id.to_string(),
        filename: filename.to_string(),
        size_bytes: bytes.len() as u64,
        mime,
        kind,
        extracted_chars,
        preview_data_url: preview,
    };

    registry.insert(AttachmentEntry {
        r#ref: attachment_ref.clone(),
        path,
        extracted_path,
    });

    Ok(attachment_ref)
}

// ─── Resolution helpers (used by AI + Jira pipelines) ──────────

/// Fully resolved attachment ready to be handed to a provider — includes the
/// on-disk path and the cached extracted text. The AI router picks fields
/// based on the active provider's modality (image-capable, text-only, etc).
#[derive(Debug, Clone)]
pub struct ResolvedAttachment {
    pub r#ref: AttachmentRef,
    pub path: PathBuf,
    /// Cached extracted text for documents (xlsx, pdf, docx, csv, txt).
    /// `None` for image attachments.
    pub extracted_text: Option<String>,
}

/// Resolve a list of attachment ids to fully-loaded records. Unknown ids are
/// silently skipped — by the time the AI pipeline asks for them the user may
/// have removed an attachment via the chip's X. Logging the skip is enough.
pub fn resolve_many(
    registry: &AttachmentRegistry,
    ids: &[String],
) -> Vec<ResolvedAttachment> {
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(entry) = registry.resolve(id) else {
            log::warn!("attachments: id not found, skipping: {id}");
            continue;
        };
        let extracted_text = match &entry.extracted_path {
            Some(p) => std::fs::read_to_string(p).ok(),
            None => None,
        };
        out.push(ResolvedAttachment {
            r#ref: entry.r#ref,
            path: entry.path,
            extracted_text,
        });
    }
    out
}

/// Build the "[ATTACHED FILES]" block that gets appended to the user prompt
/// for any text-extracted attachment. Image attachments are excluded — those
/// flow through provider-specific channels (Claude --image, Gemini
/// inline_data) rather than the prompt body.
///
/// Returns `None` when no attachment contributes text, so callers can skip
/// the trailer entirely on image-only batches.
pub fn build_text_payload(resolved: &[ResolvedAttachment]) -> Option<String> {
    let mut out = String::new();
    for a in resolved {
        let Some(text) = &a.extracted_text else { continue };
        if text.trim().is_empty() {
            continue;
        }
        if out.is_empty() {
            out.push_str("\n\n[ATTACHED FILES]\n");
        }
        out.push_str(&format!("\n--- {} ({}) ---\n", a.r#ref.filename, kind_label(a.r#ref.kind)));
        out.push_str(text);
        out.push('\n');
    }
    if out.is_empty() { None } else { Some(out) }
}

fn kind_label(kind: AttachmentKind) -> &'static str {
    match kind {
        AttachmentKind::Image => "image",
        AttachmentKind::Pdf => "pdf",
        AttachmentKind::Spreadsheet => "spreadsheet",
        AttachmentKind::Document => "word document",
        AttachmentKind::Csv => "csv",
        AttachmentKind::Text => "text",
        AttachmentKind::Unsupported => "file",
    }
}

/// Sweep session directories that haven't been touched in `SESSION_TTL`.
/// Called once on app boot. Best-effort — failures are logged and swallowed.
pub fn sweep_stale(app: &AppHandle) {
    let Ok(root) = attachments_root(app) else { return; };
    let Ok(read_dir) = std::fs::read_dir(&root) else { return; };
    let cutoff = SystemTime::now() - SESSION_TTL;
    let mut swept = 0u32;
    for entry in read_dir.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        let touched = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if touched < cutoff {
            if std::fs::remove_dir_all(entry.path()).is_ok() {
                swept += 1;
            }
        }
    }
    if swept > 0 {
        log::info!("attachments: swept {swept} stale session(s)");
    }
}

// ─── Commands ───────────────────────────────────────────────────

/// Register an attachment from a raw byte buffer. Used by the paste handler
/// (clipboard image data has no path on disk) and by drag-drop fallback.
#[tauri::command]
pub async fn attachment_register_bytes(
    app: AppHandle,
    state: State<'_, crate::state::AppState>,
    session_id: String,
    filename: String,
    bytes: Vec<u8>,
) -> AppResult<AttachmentRef> {
    log::info!(
        "attachment_register_bytes: session={} filename={} size={}",
        session_id,
        filename,
        bytes.len()
    );
    store(&app, &state.attachments, &session_id, &filename, bytes)
}

/// Register an attachment from a filesystem path. Used by the drag-drop and
/// file-picker paths — both surface real paths via Tauri's APIs.
///
/// We re-read the bytes ourselves rather than using a hardlink/copy because
/// the source file may live in /tmp, on a USB drive, or in a path the user
/// doesn't want us watching. Copying the bytes into our cache makes the
/// session entirely self-contained.
#[tauri::command]
pub async fn attachment_register_path(
    app: AppHandle,
    state: State<'_, crate::state::AppState>,
    session_id: String,
    path: String,
) -> AppResult<AttachmentRef> {
    log::info!("attachment_register_path: session={session_id} path={path}");
    let src = PathBuf::from(&path);
    let filename = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Invalid("invalid file path".into()))?
        .to_string();
    let bytes = std::fs::read(&src)?;
    store(&app, &state.attachments, &session_id, &filename, bytes)
}

/// Remove a single attachment by id. Cleans up both the original and
/// extracted-text artefacts. No-op if the id is unknown (idempotent).
#[tauri::command]
pub async fn attachment_remove(
    state: State<'_, crate::state::AppState>,
    id: String,
) -> AppResult<()> {
    let Some(entry) = state.attachments.remove(&id) else {
        return Ok(());
    };
    let _ = std::fs::remove_file(&entry.path);
    if let Some(p) = &entry.extracted_path {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// Drop every attachment for a session. Called when the user submits a draft
/// (the files have been forwarded to the AI / Jira layer and are no longer
/// needed) or when they explicitly clear the input.
#[tauri::command]
pub async fn attachment_purge_session(
    app: AppHandle,
    state: State<'_, crate::state::AppState>,
    session_id: String,
) -> AppResult<()> {
    log::info!("attachment_purge_session: session={session_id}");
    let _ = state.attachments.purge_session(&session_id);
    let dir = session_dir(&app, &session_id)?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

/// List the attachments registered for a session. Used to repopulate the UI
/// after a navigation or a relaunch (in case we ever persist sessions across
/// app restarts — currently we don't, so this returns the in-memory view).
#[tauri::command]
pub async fn attachment_list(
    state: State<'_, crate::state::AppState>,
    session_id: String,
) -> AppResult<Vec<AttachmentRef>> {
    Ok(state
        .attachments
        .list_session(&session_id)
        .into_iter()
        .map(|e| e.r#ref)
        .collect())
}

/// All attachments across all sessions — debugging only.
#[tauri::command]
pub async fn attachment_list_all(
    state: State<'_, crate::state::AppState>,
) -> AppResult<Vec<AttachmentRef>> {
    Ok(state
        .attachments
        .list_all()
        .into_iter()
        .map(|e| e.r#ref)
        .collect())
}
