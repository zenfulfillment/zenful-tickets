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
        .map_err(|e| AppError::Other(format!("app_data_dir: {e}")))?
        .join("tickets");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::Other(format!("mkdir tickets: {e}")))?;

    let id = Uuid::new_v4().to_string();
    let path: PathBuf = dir.join(format!("{id}.md"));

    let body = render_history_markdown(&id, &req);

    tokio::fs::write(&path, body.as_bytes())
        .await
        .map_err(|e| AppError::Other(format!("write ticket history: {e}")))?;

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
    let had_interview = req
        .interview_transcript
        .as_deref()
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false);

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
    out.push_str(&format!("id: {}\n", yaml_dq(id)));
    out.push_str(&format!("created: {}\n", yaml_dq(&now)));
    out.push_str(&format!("jira_key: {}\n", yaml_dq(&req.jira_key)));
    if let Some(url) = &req.jira_url {
        out.push_str(&format!("jira_url: {}\n", yaml_dq(url)));
    }
    out.push_str(&format!("mode: {}\n", yaml_dq(&req.mode)));
    out.push_str(&format!("provider: {}\n", yaml_dq(&req.provider)));
    if let Some(model) = &req.model {
        out.push_str(&format!("model: {}\n", yaml_dq(model)));
    }
    out.push_str(&format!("project_key: {}\n", yaml_dq(&req.project_key)));
    out.push_str(&format!("issue_type: {}\n", yaml_dq(&req.issue_type)));
    if let Some(p) = &req.priority {
        out.push_str(&format!("priority: {}\n", yaml_dq(p)));
    }
    if let Some(e) = &req.epic_key {
        out.push_str(&format!("epic_key: {}\n", yaml_dq(e)));
    }
    if let Some(a) = &req.assignee_account_id {
        out.push_str(&format!("assignee_account_id: {}\n", yaml_dq(a)));
    }
    if !req.labels.is_empty() {
        out.push_str("labels:\n");
        for l in &req.labels {
            out.push_str(&format!("  - {}\n", yaml_dq(l)));
        }
    }
    if !req.subtask_keys.is_empty() {
        out.push_str("subtask_keys:\n");
        for k in &req.subtask_keys {
            out.push_str(&format!("  - {}\n", yaml_dq(k)));
        }
    }
    out.push_str(&format!("had_interview: {had_interview}\n"));
    out.push_str("title: |\n");
    out.push_str(&indent_yaml_block(&req.title));
    out.push('\n');
    out.push_str("---\n\n");

    out.push_str("# Initial prompt\n\n");
    out.push_str(req.initial_prompt.trim_end());
    out.push_str("\n\n");

    if let Some(t) = &req.interview_transcript {
        let trimmed = t.trim();
        if !trimmed.is_empty() {
            out.push_str("# Interview transcript\n\n");
            out.push_str(trimmed);
            out.push_str("\n\n");
        }
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

/// Encode `s` as a YAML double-quoted scalar (suitable for any frontmatter
/// value that doesn't already use the `|` literal block scalar). Escapes
/// backslash, double-quote, newline, carriage return, and tab. Other
/// printable characters pass through unchanged, which is safe inside `"..."`.
fn yaml_dq(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
