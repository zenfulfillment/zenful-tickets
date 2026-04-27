//! ElevenLabs Scribe v2 Realtime transcription client.
//!
//! Architecture:
//! - The webview captures the microphone, down-samples to 16kHz PCM16, and
//!   pushes ~80ms chunks via `speech_send_chunk`.
//! - We open a single WebSocket to ElevenLabs for the duration of a session
//!   and forward audio bytes (base64-wrapped per the Scribe protocol).
//! - VAD commit strategy is enabled server-side, so we just keep streaming
//!   audio and the API decides when to emit a committed (final) transcript.
//!
//! Events emitted on the AppHandle:
//!   speech:partial — `{ text: string }`         partial_transcript
//!   speech:final   — `{ text: string }`         committed_transcript[_with_timestamps]
//!   speech:lang    — `{ language_code: string }` (optional, when detected)
//!   speech:error   — `{ message: string }`
//!   speech:closed  — `{}`
//!
//! Key: baked into the binary via `option_env!("ELEVENLABS_API_KEY")` (the
//! build script in `build.rs` reads `.env.build` and re-exports it). If the
//! key is absent at compile time the command returns an error and voice
//! features are simply disabled in the UI.
//!
//! Protocol reference (Scribe v2 Realtime):
//!   wss://api.elevenlabs.io/v1/speech-to-text/realtime
//!     ?model_id=scribe_v2_realtime
//!     &audio_format=pcm_16000
//!     &commit_strategy=vad
//!     &include_language_detection=true
//!
//! Outbound audio messages are JSON text frames:
//!   { "message_type": "input_audio_chunk",
//!     "audio_base_64": "<base64 PCM16 LE>",
//!     "sample_rate": 16000 }
//!
//! Inbound messages are tagged on `message_type`:
//!   session_started | partial_transcript | committed_transcript |
//!   committed_transcript_with_timestamps | error

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

const EMBEDDED_KEY: Option<&str> = option_env!("ELEVENLABS_API_KEY");

/// ElevenLabs Scribe V2 Realtime endpoint. VAD commit + language auto-detect
/// give us "user just talks, transcripts appear" behaviour with no manual
/// commit needed from the client.
const WS_URL: &str = "wss://api.elevenlabs.io/v1/speech-to-text/realtime\
    ?model_id=scribe_v2_realtime\
    &audio_format=pcm_16000\
    &commit_strategy=vad\
    &include_language_detection=true";

pub enum VoiceEvent {
    Audio(Vec<u8>),
    Stop,
}

#[derive(Debug, Serialize)]
struct TextPayload<'a> {
    text: &'a str,
}

#[derive(Debug, Serialize)]
struct LangPayload<'a> {
    language_code: &'a str,
}

#[derive(Debug, Serialize)]
struct AudioChunkOut<'a> {
    message_type: &'static str,
    audio_base_64: &'a str,
    sample_rate: u32,
}

#[derive(Debug, Serialize)]
struct CommitOut {
    message_type: &'static str,
    commit: bool,
}

/// Tagged on `message_type`. Unknown variants are ignored gracefully (e.g. ping
/// events the server might add later) so we don't tear down the session on
/// schema drift.
#[derive(Debug, Deserialize)]
#[serde(tag = "message_type", rename_all = "snake_case")]
enum IncomingMsg {
    SessionStarted {
        #[allow(dead_code)]
        #[serde(default)]
        session_id: Option<String>,
    },
    PartialTranscript {
        text: String,
    },
    CommittedTranscript {
        text: String,
        #[serde(default)]
        language_code: Option<String>,
    },
    CommittedTranscriptWithTimestamps {
        text: String,
        #[serde(default)]
        language_code: Option<String>,
    },
    Error {
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        error: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

#[tauri::command]
pub async fn speech_start(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let key = EMBEDDED_KEY
        .filter(|k| !k.is_empty())
        .ok_or_else(|| AppError::Voice("voice disabled: no ELEVENLABS_API_KEY in build".into()))?;

    let mut sender_slot = state.voice_sender.lock().await;
    if sender_slot.is_some() {
        return Err(AppError::Voice("a voice session is already running".into()));
    }

    let (tx, mut rx) = mpsc::channel::<VoiceEvent>(256);
    *sender_slot = Some(tx);
    drop(sender_slot);

    // Open WebSocket with the API key in the auth header.
    let mut req = WS_URL
        .into_client_request()
        .map_err(|e| AppError::Voice(format!("ws request: {e}")))?;
    req.headers_mut().insert(
        "xi-api-key",
        key.parse()
            .map_err(|e| AppError::Voice(format!("bad key header: {e}")))?,
    );

    let (ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| AppError::Voice(format!("ws connect: {e}")))?;

    let (mut ws_tx, mut ws_rx) = ws.split();
    let app_for_events = app.clone();
    let voice_sender = state.voice_sender.clone();

    // Dedupe latch for committed transcripts. The Scribe API can emit BOTH
    // `committed_transcript` and `committed_transcript_with_timestamps` for
    // the same commit (especially when language detection is on), so we'd
    // otherwise fire `speech:final` twice and the textarea would gain a
    // duplicate. We reset this on every partial so a fresh utterance is
    // accepted normally.
    let last_final: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    // Pump audio chunks → WS as JSON text frames.
    let sender_task = tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                VoiceEvent::Audio(bytes) => {
                    let payload = AudioChunkOut {
                        message_type: "input_audio_chunk",
                        audio_base_64: &B64.encode(&bytes),
                        sample_rate: 16_000,
                    };
                    let json = match serde_json::to_string(&payload) {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    if ws_tx.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                VoiceEvent::Stop => {
                    // Force-flush any pending VAD segment, then close cleanly.
                    let commit = CommitOut {
                        message_type: "input_audio_chunk",
                        commit: true,
                    };
                    if let Ok(json) = serde_json::to_string(&commit) {
                        let _ = ws_tx.send(Message::Text(json.into())).await;
                    }
                    let _ = ws_tx.close().await;
                    break;
                }
            }
        }
    });

    // Pump WS → Tauri events.
    let app_for_reader = app_for_events.clone();
    let last_final_for_reader = last_final.clone();
    tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Text(txt)) => match serde_json::from_str::<IncomingMsg>(&txt) {
                    Ok(IncomingMsg::PartialTranscript { text }) => {
                        // New partial = new in-flight utterance — clear the dedupe
                        // latch so the next commit fires.
                        *last_final_for_reader.lock().await = None;
                        let _ = app_for_reader
                            .emit("speech:partial", &TextPayload { text: &text });
                    }
                    Ok(IncomingMsg::CommittedTranscript { text, language_code })
                    | Ok(IncomingMsg::CommittedTranscriptWithTimestamps {
                        text,
                        language_code,
                    }) => {
                        let mut guard = last_final_for_reader.lock().await;
                        if guard.as_deref() == Some(text.as_str()) {
                            // Duplicate of the just-emitted commit (the API sent
                            // both the plain and the timestamped variant).
                            continue;
                        }
                        *guard = Some(text.clone());
                        drop(guard);
                        if let Some(code) = language_code.as_deref() {
                            let _ = app_for_reader
                                .emit("speech:lang", &LangPayload { language_code: code });
                        }
                        let _ = app_for_reader
                            .emit("speech:final", &TextPayload { text: &text });
                    }
                    Ok(IncomingMsg::Error { message, error }) => {
                        let m = message.or(error).unwrap_or_else(|| "unknown error".into());
                        let _ = app_for_reader
                            .emit("speech:error", &TextPayload { text: &m });
                    }
                    Ok(IncomingMsg::SessionStarted { .. }) | Ok(IncomingMsg::Unknown) => {}
                    Err(e) => {
                        // Surface schema drift so we notice; don't tear down.
                        log::warn!("speech: failed to parse message ({e}): {txt}");
                    }
                },
                Ok(Message::Binary(_)) | Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
                Ok(Message::Close(_)) => break,
                Ok(Message::Frame(_)) => {}
                Err(e) => {
                    let msg = e.to_string();
                    let _ = app_for_reader.emit("speech:error", &TextPayload { text: &msg });
                    break;
                }
            }
        }

        // Cleanup.
        let _ = sender_task.await;
        *voice_sender.lock().await = None;
        let _ = app_for_reader.emit("speech:closed", &serde_json::json!({}));
    });

    Ok(())
}

#[tauri::command]
pub async fn speech_send_chunk(state: State<'_, AppState>, bytes: Vec<u8>) -> AppResult<()> {
    let guard = state.voice_sender.lock().await;
    let tx = guard
        .as_ref()
        .ok_or_else(|| AppError::Voice("no active voice session".into()))?;
    tx.send(VoiceEvent::Audio(bytes))
        .await
        .map_err(|_| AppError::Voice("voice channel closed".into()))
}

#[tauri::command]
pub async fn speech_stop(state: State<'_, AppState>) -> AppResult<()> {
    let guard = state.voice_sender.lock().await;
    if let Some(tx) = guard.as_ref() {
        let _ = tx.send(VoiceEvent::Stop).await;
    }
    Ok(())
}
