//! Gemini 2.5 Pro via Google Generative Language API, streaming SSE.
//! Endpoint: /v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse

use crate::ai::StreamChunk;
use crate::attachments::ResolvedAttachment;
use crate::error::{AppError, AppResult};
use base64::Engine;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{Value, json};
use std::path::Path;
use tokio::sync::{mpsc, oneshot};

const DEFAULT_MODEL: &str = "gemini-2.5-pro";

pub async fn stream(
    http: Client,
    api_key: String,
    system_prompt: String,
    user_prompt: String,
    model: Option<String>,
    // Resolved attachments — image/pdf entries become `inline_data` parts;
    // text-extracted entries are already prepended to `user_prompt` by the
    // caller (so callers don't need to also pass the text twice).
    inline_attachments: Vec<ResolvedAttachment>,
    chunks_tx: mpsc::Sender<StreamChunk>,
    mut cancel_rx: oneshot::Receiver<()>,
) -> AppResult<()> {
    // The user's model pick (e.g. "gemini-2.5-flash") substitutes into
    // the path. None / empty → DEFAULT_MODEL so existing behaviour is
    // preserved when the picker hasn't been touched yet.
    let model_id = model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_MODEL);
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model_id}:streamGenerateContent?alt=sse&key={api_key}"
    );

    // Build the user message parts. Order is: every inline attachment first,
    // then the text. Gemini reads parts left-to-right, and putting image
    // context up front lets the textual instructions reference what the
    // model just saw ("based on the screenshot above…").
    let mut parts: Vec<Value> = Vec::new();
    for a in &inline_attachments {
        let Some(part) = inline_data_part(&a.path, &a.r#ref.mime) else {
            // Skip attachments we can't inline (large files, IO errors).
            // The text payload already contains a textual fallback for
            // documents — images are the only thing genuinely lost here.
            continue;
        };
        parts.push(part);
    }
    parts.push(json!({ "text": user_prompt }));

    let body = json!({
        "systemInstruction": { "parts": [{ "text": system_prompt }] },
        "contents": [{ "role": "user", "parts": parts }],
        "generationConfig": {
            "temperature": 0.4,
            "topP": 0.95,
            "maxOutputTokens": 4096,
        },
    });

    let resp = http
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Ai(format!("gemini {status}: {}", truncate(&text, 400))));
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
                                let Some(data) = line.strip_prefix("data: ") else { continue };
                                if data.trim() == "[DONE]" {
                                    return Ok(());
                                }
                                if let Ok(json) = serde_json::from_str::<Value>(data) {
                                    if let Some(text) = extract_text(&json) {
                                        if !text.is_empty() {
                                            if chunks_tx.send(StreamChunk::Text(text)).await.is_err() {
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
        }
    }
    Ok(())
}

fn extract_text(v: &Value) -> Option<String> {
    v.get("candidates")?
        .get(0)?
        .get("content")?
        .get("parts")?
        .as_array()?
        .iter()
        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
        .fold(None, |acc, s| match acc {
            None => Some(s.to_string()),
            Some(mut a) => {
                a.push_str(s);
                Some(a)
            }
        })
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n { s.to_string() } else { format!("{}…", &s[..n]) }
}

/// Build a Gemini `inline_data` part from a local file. Reads the bytes,
/// base64-encodes them, and pairs with the declared MIME type.
///
/// Returns `None` on read failure. Gemini's request payload limit is on the
/// order of 20 MB; our per-attachment cap is 10 MB so we fit comfortably
/// even with several attachments in one request.
fn inline_data_part(path: &Path, mime: &str) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(json!({
        "inline_data": {
            "mime_type": mime,
            "data": encoded,
        }
    }))
}
