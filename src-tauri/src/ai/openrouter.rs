//! OpenRouter chat completions, streaming SSE.
//!
//! Endpoint: `POST /api/v1/chat/completions` (the **mature** chat completions
//! endpoint — *not* the beta `/api/v1/responses` endpoint, which is stateless
//! and subject to breaking changes).
//!
//! Stream contract (verified against OpenRouter docs):
//!   - Each event line is `data: {json}` terminated by `\n\n`.
//!   - The final-before-terminator line is `data: [DONE]`.
//!   - Comment lines like `: OPENROUTER PROCESSING` are keep-alives;
//!     skipped per SSE spec.
//!   - The penultimate `data:` chunk carries `{usage: {...}, choices: []}`
//!     — useful for cost tracking later, ignored in v1.
//!   - Mid-stream errors arrive as `choices[0].error` (or top-level
//!     `error`); we forward those as `StreamChunk::Error`.
//!
//! Attachment shape (verified):
//!   - Images: `{type: "image_url", image_url: {url: "data:image/png;base64,..."}}`
//!     — only sent when the chosen model's catalog `input_modalities`
//!     includes `"image"`. Otherwise we silently skip the image part
//!     (the document text fallback already covers content); the frontend
//!     surfaces the user-facing "this model can't see images" warning.
//!   - PDFs: `{type: "file", file: {filename, file_data: "data:application/pdf;base64,..."}}`
//!     — works on **any** model on OpenRouter (server-side fallback to
//!     text extraction), so no per-model gating.

use crate::ai::StreamChunk;
use crate::ai::openrouter_models::{self, OpenRouterModel};
use crate::attachments::{AttachmentKind, ResolvedAttachment};
use crate::error::{AppError, AppResult};
use base64::Engine;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{Value, json};
use std::path::Path;
use tauri::AppHandle;
use tokio::sync::{mpsc, oneshot};

const ENDPOINT: &str = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL: &str = "anthropic/claude-sonnet-4";

#[allow(clippy::too_many_arguments)]
pub async fn stream(
    app: AppHandle,
    http: Client,
    api_key: String,
    system_prompt: String,
    user_prompt: String,
    model: Option<String>,
    inline_attachments: Vec<ResolvedAttachment>,
    chunks_tx: mpsc::Sender<StreamChunk>,
    mut cancel_rx: oneshot::Receiver<()>,
) -> AppResult<()> {
    let model_id = model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string();

    // Look up capabilities so we can gate images on `input_modalities`.
    // Cache miss = first launch before the background fetch lands; default
    // to "supports image" so we don't silently swallow attachments — worst
    // case the model returns a 400 we surface to the user.
    let model_caps = openrouter_models::cached(&app)
        .and_then(|c| c.models.into_iter().find(|m| m.id == model_id));
    let allows_image = model_supports_image(model_caps.as_ref());

    // Build content parts: text first, then attachments. OpenRouter follows
    // the OpenAI vision shape — text and image_url/file parts coexist in
    // a single user message's `content` array.
    let mut parts: Vec<Value> = Vec::new();
    parts.push(json!({ "type": "text", "text": user_prompt }));

    let mut dropped_images = 0usize;
    for a in &inline_attachments {
        match a.r#ref.kind {
            AttachmentKind::Image => {
                if !allows_image {
                    dropped_images += 1;
                    continue;
                }
                if let Some(part) = image_part(&a.path, &a.r#ref.mime) {
                    parts.push(part);
                }
            }
            AttachmentKind::Pdf => {
                // PDF works on every OpenRouter model — no gating needed.
                if let Some(part) = pdf_part(&a.path, &a.r#ref.filename) {
                    parts.push(part);
                }
            }
            // Other kinds (xlsx, csv, etc.) are already inlined as text by
            // `attachments::build_text_payload` — nothing to do here.
            _ => {}
        }
    }
    if dropped_images > 0 {
        log::info!(
            "openrouter: dropped {dropped_images} image attachment(s) — model {model_id} lacks image modality"
        );
    }

    let body = json!({
        "model": model_id,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": parts }
        ],
        "stream": true,
        "temperature": 0.4,
    });

    let resp = http
        .post(ENDPOINT)
        .bearer_auth(&api_key)
        // App attribution — affects the OpenRouter rankings page only.
        .header("HTTP-Referer", "https://github.com/zenfulfillment/zenfultickets")
        .header("X-Title", "zenfultickets")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let raw = resp.text().await.unwrap_or_default();
        return Err(AppError::Ai(format!(
            "openrouter {status}: {}",
            extract_error_message(&raw).unwrap_or_else(|| truncate(&raw, 400))
        )));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                let _ = chunks_tx.send(StreamChunk::Error("cancelled".into())).await;
                break;
            }
            next = stream.next() => {
                match next {
                    None => break,
                    Some(Err(e)) => {
                        let _ = chunks_tx.send(StreamChunk::Error(format!("stream error: {e}"))).await;
                        break;
                    }
                    Some(Ok(bytes)) => {
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        // Parse SSE frames (each event ends with \n\n).
                        while let Some(idx) = buf.find("\n\n") {
                            let frame = buf[..idx].to_string();
                            buf.drain(..idx + 2);
                            for line in frame.lines() {
                                // Comment lines (`: OPENROUTER PROCESSING`)
                                // are keep-alives; tolerate per SSE spec.
                                if line.starts_with(':') || line.is_empty() {
                                    continue;
                                }
                                let Some(data) = line.strip_prefix("data: ") else { continue };
                                if data.trim() == "[DONE]" {
                                    return Ok(());
                                }
                                let Ok(json) = serde_json::from_str::<Value>(data) else {
                                    continue;
                                };
                                // Mid-stream errors land as either
                                // `choices[0].error` or a top-level `error`.
                                if let Some(err_msg) = extract_chunk_error(&json) {
                                    let _ = chunks_tx
                                        .send(StreamChunk::Error(err_msg))
                                        .await;
                                    return Ok(());
                                }
                                if let Some(text) = extract_delta_content(&json) {
                                    if !text.is_empty()
                                        && chunks_tx.send(StreamChunk::Text(text)).await.is_err()
                                    {
                                        return Ok(());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn model_supports_image(m: Option<&OpenRouterModel>) -> bool {
    match m {
        Some(model) => model.input_modalities.iter().any(|s| s == "image"),
        // No catalog yet — be permissive. The user gets a 400 from the
        // upstream model if they pick a non-vision one with an image
        // attached, which is louder than silently dropping it.
        None => true,
    }
}

fn extract_delta_content(v: &Value) -> Option<String> {
    let delta = v.get("choices")?.get(0)?.get("delta")?;
    let content = delta.get("content")?;
    // Most providers emit a string; a few emit `null` or an array of
    // content parts (rare, e.g. when the model also returns reasoning
    // tokens). Handle both gracefully — only string content is forwarded;
    // structured deltas are dropped silently for v1.
    content.as_str().map(|s| s.to_string())
}

fn extract_chunk_error(v: &Value) -> Option<String> {
    // Top-level error (rare but documented).
    if let Some(e) = v.get("error") {
        return Some(stringify_error(e));
    }
    // Per-choice error (more common — provider partial failure).
    if let Some(e) = v.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("error")) {
        return Some(stringify_error(e));
    }
    None
}

fn stringify_error(e: &Value) -> String {
    let code = e.get("code").and_then(|c| c.as_i64());
    let msg = e
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("unknown error");
    match code {
        Some(c) => format!("openrouter [{c}]: {msg}"),
        None => format!("openrouter: {msg}"),
    }
}

/// Pull a meaningful message out of an HTTP error body.
/// OpenRouter shape: `{error: {code, message, metadata?}, user_id?}`.
fn extract_error_message(raw: &str) -> Option<String> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let err = v.get("error")?;
    let msg = err.get("message").and_then(|m| m.as_str())?;
    Some(msg.to_string())
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

/// Build an `image_url` content part with a `data:` URL.
fn image_part(path: &Path, mime: &str) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let url = format!("data:{mime};base64,{encoded}");
    Some(json!({
        "type": "image_url",
        "image_url": { "url": url }
    }))
}

/// Build a `file` content part with a `data:application/pdf;base64,...`
/// URL. Works on every OpenRouter model — the platform server-side
/// extracts text for models without native `file` modality.
fn pdf_part(path: &Path, filename: &str) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let url = format!("data:application/pdf;base64,{encoded}");
    Some(json!({
        "type": "file",
        "file": {
            "filename": filename,
            "file_data": url,
        }
    }))
}
