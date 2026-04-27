//! OpenRouter model catalog: fetch, cache, and background refresh.
//!
//! `GET /api/v1/models` returns the full list of ~300 models OpenRouter
//! exposes. We cache it on disk under the app data dir so the picker can
//! render instantly on launch, then refresh in the background and emit
//! `openrouter:catalog:updated` so the frontend hot-swaps without reload.

use crate::error::{AppError, AppResult};
use crate::secrets;
use crate::state::APP;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

const ENDPOINT: &str = "https://openrouter.ai/api/v1/models";
const CACHE_FILE: &str = "openrouter-catalog.json";

/// One model entry as it lands in the cache and ships to the frontend.
///
/// We project the upstream response down to just the fields the picker and
/// attachment-routing logic need, so a future schema addition upstream
/// doesn't bloat the on-disk cache or churn the IPC surface.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenRouterModel {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub context_length: Option<u64>,
    #[serde(default)]
    pub max_output_length: Option<u64>,
    /// `["text", "image", "file", ...]`. The picker uses `"image"` to gate
    /// the image-attachment warning; PDF works on every model so `"file"`
    /// isn't load-bearing.
    #[serde(default)]
    pub input_modalities: Vec<String>,
    #[serde(default)]
    pub output_modalities: Vec<String>,
    /// `["tools", "json_mode", "structured_outputs", "reasoning", ...]`.
    /// Stored for future capability gating; not used in v1.
    #[serde(default)]
    pub supported_features: Vec<String>,
    /// String-typed per-token USD prices (the docs warn about float
    /// precision). Kept opaque — the UI doesn't render them in v1.
    #[serde(default)]
    pub pricing: Option<Value>,
    #[serde(default)]
    pub deprecation_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Catalog {
    pub fetched_at: i64, // unix seconds
    pub models: Vec<OpenRouterModel>,
}

#[derive(Debug, Deserialize)]
struct ListResponse {
    data: Vec<OpenRouterModel>,
}

fn cache_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("app_data_dir: {e}")))?;
    std::fs::create_dir_all(&dir).ok();
    Ok(dir.join(CACHE_FILE))
}

/// Read the cached catalog. Returns `None` on first launch / corrupt cache.
pub fn cached(app: &AppHandle) -> Option<Catalog> {
    let path = cache_path(app).ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_cache(app: &AppHandle, cat: &Catalog) -> AppResult<()> {
    let path = cache_path(app)?;
    let raw = serde_json::to_string(cat)?;
    // Atomic-ish write: tmp file + rename so a crash mid-write doesn't
    // leave a half-written cache that fails to parse next launch.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Hit `/api/v1/models`. The endpoint is public, but if we have an API key
/// we send it — costs nothing and futures-proofs against any per-account
/// filtering OpenRouter might introduce.
async fn fetch(http: &Client, api_key: Option<&str>) -> AppResult<Vec<OpenRouterModel>> {
    let mut req = http.get(ENDPOINT);
    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }
    let resp = req.send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Ai(format!(
            "openrouter models {status}: {}",
            truncate(&body, 400)
        )));
    }
    let parsed: ListResponse = resp.json().await?;
    Ok(parsed.data)
}

/// Spawn a background task that refreshes the on-disk catalog and emits
/// `openrouter:catalog:updated` on completion. Non-blocking — callers
/// return immediately. Idempotent: safe to call repeatedly; multiple
/// in-flight fetches just race to write the cache.
pub fn refresh_in_background(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = refresh_now(&app).await {
            log::warn!("openrouter catalog refresh failed: {e}");
        }
    });
}

async fn refresh_now(app: &AppHandle) -> AppResult<()> {
    // Pull the API key fresh on each refresh — the user might have
    // rotated it via Settings between launches.
    let key = secrets::load().ok().and_then(|s| s.openrouter_key);
    let http = Client::builder()
        .user_agent(concat!("zenfultickets/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Other(format!("build http: {e}")))?;

    let models = fetch(&http, key.as_deref()).await?;
    let cat = Catalog {
        fetched_at: chrono_secs(),
        models,
    };
    write_cache(app, &cat)?;
    log::info!("openrouter catalog refreshed: {} models", cat.models.len());
    let _ = app.emit("openrouter:catalog:updated", &cat);
    Ok(())
}

/// Returns Unix seconds without pulling in `chrono`.
fn chrono_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

// ─────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────

/// Returns the cached catalog. The frontend should call this on mount
/// and re-call when the `openrouter:catalog:updated` event fires.
#[tauri::command]
pub fn openrouter_models_get(app: AppHandle) -> AppResult<Option<Catalog>> {
    Ok(cached(&app))
}

/// Force a background refresh. Returns immediately — the result lands
/// via the `openrouter:catalog:updated` event.
#[tauri::command]
pub fn openrouter_models_refresh() -> AppResult<()> {
    if let Some(app) = APP.get() {
        refresh_in_background(app.clone());
    }
    Ok(())
}
