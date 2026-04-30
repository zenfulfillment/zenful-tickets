//! OpenCode model catalog discovery and caching.
//!
//! On startup we run `opencode models --verbose` to get the full catalog
//! as newline-delimited JSON. Each entry carries `id`, `providerID`,
//! `name`, `family`, `cost`, `limit.context`, `capabilities`, etc.
//!
//! The catalog is cached to disk and emitted to the frontend via a Tauri
//! event. A background refresh (`--refresh`) fetches the latest from
//! models.dev and hot-swaps if different.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenCodeModel {
    /// Full model identifier in `provider/model` format, e.g. `opencode/big-pickle`.
    /// This is what gets passed to `opencode run -m <id>`.
    pub id: String,
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub name: String,
    #[serde(default)]
    pub family: Option<String>,
    #[serde(default)]
    pub cost: Option<serde_json::Value>,
    #[serde(default)]
    pub limit: Option<ModelLimit>,
    #[serde(default)]
    pub capabilities: Option<ModelCapabilities>,
    #[serde(default)]
    pub variants: serde_json::Value,
    /// Human-readable description generated from metadata.
    /// Populated by `compute_description` after parsing.
    #[serde(default)]
    pub description: String,
}

impl OpenCodeModel {
    /// Generate a Claude/Codex-style description from the model's metadata.
    pub fn compute_description(&mut self) {
        let caps = self.capabilities.as_ref();
        let reasoning = caps.and_then(|c| c.reasoning).unwrap_or(false);
        let attachment = caps.and_then(|c| c.attachment).unwrap_or(false);
        let context = self.limit.as_ref().and_then(|l| l.context).unwrap_or(0);
        let has_variants = !self.variants.is_null() && !self.variants.as_object().map(|o| o.is_empty()).unwrap_or(true);

        let mut parts: Vec<&str> = Vec::new();

        if reasoning {
            parts.push("Strong reasoning");
        }
        if attachment {
            parts.push("supports attachments");
        }
        if context >= 1_000_000 {
            parts.push("massive context");
        } else if context >= 200_000 {
            parts.push("large context");
        }
        if has_variants {
            parts.push("configurable variants");
        }

        if parts.is_empty() {
            parts.push("Fast and efficient");
        }

        // Capitalize first letter, add period.
        let mut desc = parts.join(", ");
        if let Some(first) = desc.get_mut(0..1) {
            first.make_ascii_uppercase();
        }
        desc.push('.');
        self.description = desc;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelLimit {
    #[serde(default)]
    pub context: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCapabilities {
    #[serde(default)]
    pub reasoning: Option<bool>,
    #[serde(default)]
    pub attachment: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenCodeCatalog {
    pub models: Vec<OpenCodeModel>,
    pub fetched_at: String,
}

pub async fn fetch_catalog(refresh: bool) -> AppResult<OpenCodeCatalog> {
    let path_env = crate::ai::cli::augmented_path();

    let mut cmd = Command::new("opencode");
    cmd.args(["models", "--verbose"])
        .env("PATH", &path_env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if refresh {
        cmd.arg("--refresh");
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Ai(format!("failed to spawn opencode models: {e}")))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Ai("no stdout handle".into()))?;

    // The output format is NOT JSONL. Each model is:
    //   provider/model-id    ← header line
    //   {                    ← start of pretty-printed JSON
    //     "id": "...",
    //     ...
    //   }                    ← end of JSON
    //   next-provider/id     ← next header (no blank line separator)
    let mut models = Vec::new();
    let mut reader = BufReader::new(stdout);
    let mut json_lines: Vec<String> = Vec::new();
    let mut in_json = false;
    let mut current_header: Option<String> = None;
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // A header line looks like "opencode/big-pickle" or "opencode-go/glm-5"
        let is_header = !trimmed.starts_with('{')
            && !trimmed.starts_with('}')
            && !trimmed.starts_with('"')
            && !trimmed.starts_with(',')
            && !trimmed.starts_with('[')
            && trimmed.contains('/');

        if is_header {
            if in_json && !json_lines.is_empty() {
                let json_str = json_lines.join("\n");
                if let Ok(mut model) = serde_json::from_str::<OpenCodeModel>(&json_str) {
                    if let Some(header) = current_header.take() {
                        model.id = header;
                    }
                    model.compute_description();
                    models.push(model);
                }
                json_lines.clear();
            }
            current_header = Some(trimmed.to_string());
            in_json = false;
        } else if trimmed.starts_with('{') {
            in_json = true;
            json_lines.push(trimmed.to_string());
        } else if in_json {
            json_lines.push(trimmed.to_string());
        }
    }

    // Flush the last model.
    if !json_lines.is_empty() {
        let json_str = json_lines.join("\n");
        if let Ok(mut model) = serde_json::from_str::<OpenCodeModel>(&json_str) {
            if let Some(header) = current_header.take() {
                model.id = header;
            }
            model.compute_description();
            models.push(model);
        }
    }

    let status = child.wait().await.map_err(|e| AppError::Ai(format!("wait: {e}")))?;
    if !status.success() && models.is_empty() {
        let stderr = child.stderr.take();
        let mut err = String::new();
        if let Some(mut r) = stderr {
            let _ = tokio::io::AsyncReadExt::read_to_string(&mut r, &mut err).await;
        }
        return Err(AppError::Ai(format!("opencode models failed: {}", err.trim())));
    }

    let fetched_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string());
    Ok(OpenCodeCatalog { models, fetched_at })
}

pub fn cache_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| AppError::Other(format!("app_data_dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn cache_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(cache_dir(app)?.join("opencode-catalog.json"))
}

pub fn save_catalog(app: &AppHandle, catalog: &OpenCodeCatalog) -> AppResult<()> {
    let path = cache_path(app)?;
    let json = serde_json::to_string_pretty(catalog)?;
    std::fs::write(&path, json)?;
    Ok(())
}

pub fn load_cached(app: &AppHandle) -> Option<OpenCodeCatalog> {
    let path = cache_path(app).ok()?;
    let json = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&json).ok()
}

#[tauri::command]
pub async fn opencode_models_get(app: AppHandle) -> AppResult<Option<OpenCodeCatalog>> {
    Ok(load_cached(&app))
}

#[tauri::command]
pub async fn opencode_models_refresh(app: AppHandle) -> AppResult<OpenCodeCatalog> {
    let catalog = fetch_catalog(true).await?;
    let _ = save_catalog(&app, &catalog);
    let _ = app.emit("opencode:catalog:updated", &catalog);
    Ok(catalog)
}

pub async fn init_catalog(app: AppHandle) {
    if load_cached(&app).is_none() {
        if let Ok(catalog) = fetch_catalog(false).await {
            let _ = save_catalog(&app, &catalog);
            let _ = app.emit("opencode:catalog:updated", &catalog);
        }
    }

    let app_clone = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        if let Ok(catalog) = fetch_catalog(true).await {
            let cached = load_cached(&app_clone);
            let needs_update = match &cached {
                None => true,
                Some(c) => c.models.len() != catalog.models.len()
                    || c.models.iter().map(|m| &m.id).collect::<Vec<_>>()
                        != catalog.models.iter().map(|m| &m.id).collect::<Vec<_>>(),
            };
            if needs_update {
                let _ = save_catalog(&app_clone, &catalog);
                let _ = app_clone.emit("opencode:catalog:updated", &catalog);
            }
        }
    });
}
