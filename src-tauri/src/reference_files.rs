//! Reference files/folders for DEV mode.
//!
//! Unlike attachments (which are processed, extracted, and potentially
//! uploaded to Jira), reference files are local source code files or
//! directories whose content is read and injected into the AI prompt as
//! problem analysis context. They are NEVER uploaded to Jira.
//!
//! Usage: the frontend sends file/folder paths via `reference_register_path`,
//! which stores them per-session. When `ai_draft` is called in DEV mode,
//! the paths are resolved, their content extracted, and appended to the
//! user prompt as a `[REFERENCE FILES]` block.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Directories to skip when recursively scanning a folder.
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", ".svn", ".hg", "__pycache__", ".venv", "venv",
    "dist", "build", "target", ".next", ".nuxt", ".svelte-kit", "coverage",
    ".idea", ".vscode", "vendor", ".tox", ".mypy_cache", ".pytest_cache",
    ".eggs", ".cache", ".terraform", "vendor/bundle",
];

/// File extensions we consider readable source/text files when scanning
/// a directory. Everything else (binaries, images, compiled artifacts)
/// is silently skipped.
const SOURCE_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java",
    "kt", "kts", "scala", "rb", "php", "cs", "cpp", "c", "h", "hpp",
    "hxx", "cc", "swift", "m", "mm", "dart", "ex", "exs", "erl", "hrl",
    "hs", "lhs", "ml", "mli", "fs", "fsx", "fsi", "clj", "cljs", "cljc",
    "edn", "rkt", "scm", "ss", "lisp", "el", "jl", "zig", "nim", "v",
    "vhd", "vhdl", "sv", "tf", "hcl", "sql", "graphql", "gql",
    "proto", "thrift", "json", "jsonl", "jsonc", "yaml", "yml",
    "toml", "ini", "cfg", "conf", "env", "properties", "xml", "html",
    "htm", "css", "scss", "sass", "less", "styl", "vue", "svelte",
    "astro", "md", "mdx", "txt", "log", "sh", "bash", "zsh", "fish",
    "bat", "cmd", "ps1", "psm1",
];

/// Max characters per reference file.
const MAX_FILE_CHARS: usize = 30_000;

/// Max total characters across all reference files in a single request.
const MAX_TOTAL_CHARS: usize = 120_000;

/// A single registered reference file or folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferenceEntry {
    pub id: String,
    pub session_id: String,
    pub path: String,
    pub is_directory: bool,
    pub label: String,
}

/// Thread-safe registry of reference files per session.
#[derive(Clone)]
pub struct ReferenceRegistry {
    entries: Arc<Mutex<HashMap<String, Vec<ReferenceEntry>>>>,
}

impl ReferenceRegistry {
    pub fn new() -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn add(&self, entry: ReferenceEntry) {
        self.entries
            .lock()
            .await
            .entry(entry.session_id.clone())
            .or_default()
            .push(entry);
    }

    pub async fn remove(&self, session_id: &str, id: &str) {
        if let Some(entries) = self.entries.lock().await.get_mut(session_id) {
            entries.retain(|e| e.id != id);
        }
    }

    pub async fn list(&self, session_id: &str) -> Vec<ReferenceEntry> {
        self.entries
            .lock()
            .await
            .get(session_id)
            .cloned()
            .unwrap_or_default()
    }

    pub async fn purge_session(&self, session_id: &str) {
        self.entries.lock().await.remove(session_id);
    }

    /// Resolve reference entries by their IDs. Unknown IDs are silently
    /// skipped with a log warning.
    pub async fn resolve(&self, ids: &[String]) -> Vec<ReferenceEntry> {
        let all = self.entries.lock().await;
        let mut result = Vec::new();
        for id in ids {
            let found = all.values().flat_map(|v| v.iter()).find(|e| e.id == *id);
            if let Some(entry) = found {
                result.push(entry.clone());
            } else {
                log::warn!("reference id not found: {}", id);
            }
        }
        result
    }

    /// Resolve all references by ID and build the text payload to inject
    /// into the AI prompt. Returns None if there are no references or if
    /// all files failed to read.
    pub async fn build_payload_for_ids(&self, ids: &[String]) -> Option<String> {
        let entries = self.resolve(ids).await;
        if entries.is_empty() {
            return None;
        }

        let mut parts = Vec::new();
        let mut total_chars = 0;

        for entry in &entries {
            if total_chars >= MAX_TOTAL_CHARS {
                break;
            }
            let path = PathBuf::from(&entry.path);
            if !path.exists() {
                log::warn!("reference path not found: {}", entry.path);
                continue;
            }
            if entry.is_directory {
                match scan_directory(&path, MAX_TOTAL_CHARS - total_chars) {
                    Ok(text) if !text.is_empty() => {
                        total_chars += text.len();
                        parts.push(format!(
                            "\n## Reference directory: {} ({})\n\n```\n{}\n```",
                            entry.label, entry.path, text
                        ));
                    }
                    Ok(_) => {}
                    Err(e) => log::warn!("reference directory scan error: {}: {}", entry.path, e),
                }
            } else {
                match read_file_content(&path) {
                    Ok(text) if !text.is_empty() => {
                        total_chars += text.len();
                        parts.push(format!(
                            "\n## Reference file: {} ({})\n\n```\n{}\n```",
                            entry.label, entry.path, text
                        ));
                    }
                    Ok(_) => {}
                    Err(e) => log::warn!("reference file read error: {}: {}", entry.path, e),
                }
            }
        }

        if parts.is_empty() {
            return None;
        }

        let mut payload = String::from(
            "\n\n[REFERENCE FILES — for problem analysis and context only]\n\
             Use these files to understand the codebase and analyze the root cause of the issue. \
             Do NOT propose solutions, write code changes, or suggest implementations. \
             Your job is to analyze the problem and document it in the ticket — not to fix it.\n",
        );
        for part in parts {
            payload.push_str(&part);
        }
        payload.push_str("\n\n[/REFERENCE FILES]\n");
        Some(payload)
    }
}

fn read_file_content(path: &Path) -> Result<String, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("read error: {e}"))?;
    if content.chars().count() > MAX_FILE_CHARS {
        Ok(content.chars().take(MAX_FILE_CHARS).collect::<String>() + "\n[... truncated]")
    } else {
        Ok(content)
    }
}

fn should_skip_dir(dir_name: &str) -> bool {
    SKIP_DIRS.iter().any(|&skip| dir_name == skip || dir_name.ends_with(&format!("/{}", skip)))
}

fn is_source_file(path: &Path) -> bool {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        return SOURCE_EXTS.iter().any(|&se| se.eq_ignore_ascii_case(ext));
    }
    false
}

fn scan_directory(dir: &Path, remaining_chars: usize) -> Result<String, String> {
    let mut result = String::new();

    for entry in fs::read_dir(dir).map_err(|e| format!("read_dir error: {e}"))? {
        let entry = entry.map_err(|e| format!("entry error: {e}"))?;
        let path = entry.path();
        let name = entry
            .file_name()
            .to_string_lossy()
            .to_string();

        if path.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            match scan_directory(&path, remaining_chars.saturating_sub(result.len())) {
                Ok(sub) if !sub.is_empty() => {
                    result.push_str(&format!("\n--- {}/ ---\n{}\n", name, sub));
                    if result.len() >= remaining_chars {
                        break;
                    }
                }
                Ok(_) => {}
                Err(e) => log::warn!("reference subdir scan error: {}: {}", path.display(), e),
            }
        } else if is_source_file(&path) {
            match read_file_content(&path) {
                Ok(content) if !content.is_empty() => {
                    result.push_str(&format!("\n--- {} ---\n{}\n", name, content));
                    if result.len() >= remaining_chars {
                        break;
                    }
                }
                Ok(_) => {}
                Err(e) => log::warn!("reference file read error: {}: {}", path.display(), e),
            }
        }
    }

    Ok(result)
}

// ─────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────

use crate::error::AppResult;
use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn reference_register_path(
    _app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<ReferenceEntry> {
    let path_buf = PathBuf::from(&path);
    let is_directory = path_buf.is_dir();
    let label = path_buf
        .file_name()
        .unwrap_or(path_buf.as_os_str())
        .to_string_lossy()
        .to_string();
    let id = uuid::Uuid::new_v4().to_string();

    let entry = ReferenceEntry {
        id: id.clone(),
        session_id: session_id.clone(),
        path: path.clone(),
        is_directory,
        label: label.clone(),
    };

    state.references.add(entry.clone()).await;

    log::info!(
        "reference registered: id={} session={} path={} is_dir={}",
        id, session_id, path, is_directory
    );

    Ok(entry)
}

#[tauri::command]
pub async fn reference_remove(
    state: State<'_, AppState>,
    session_id: String,
    id: String,
) -> AppResult<()> {
    state.references.remove(&session_id, &id).await;
    Ok(())
}

#[tauri::command]
pub async fn reference_list(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<ReferenceEntry>> {
    Ok(state.references.list(&session_id).await)
}

#[tauri::command]
pub async fn reference_purge_session(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<()> {
    state.references.purge_session(&session_id).await;
    Ok(())
}
