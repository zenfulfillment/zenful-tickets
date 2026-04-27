use crate::attachments::AttachmentRegistry;
use once_cell::sync::OnceCell;
use reqwest::Client;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, mpsc};

// Shared app state carried through Tauri's `State<AppState>`.
pub struct AppState {
    pub http: Client,
    // Cancellation senders for in-flight AI streams, keyed by request id.
    pub ai_cancellers: Arc<Mutex<HashMap<String, mpsc::Sender<()>>>>,
    // Active ElevenLabs session sender for audio bytes, if one is running.
    pub voice_sender: Arc<Mutex<Option<mpsc::Sender<crate::speech::VoiceEvent>>>>,
    // Currently-registered global summon shortcut, so we can replace it cleanly
    // when the user picks a new combo.
    pub global_shortcut: Arc<Mutex<Option<String>>>,
    // In-memory attachment registry. Per-draft files live on disk under
    // ${app_cache_dir}/attachments/<session>/; this index maps ids → entries
    // so the AI + Jira pipelines can resolve attachments without re-walking
    // the filesystem on every send. See `attachments::AttachmentRegistry`.
    pub attachments: AttachmentRegistry,
}

impl AppState {
    pub fn new() -> Self {
        let http = Client::builder()
            .user_agent(concat!("zenfultickets/", env!("CARGO_PKG_VERSION")))
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .expect("build reqwest client");
        Self {
            http,
            ai_cancellers: Arc::new(Mutex::new(HashMap::new())),
            voice_sender: Arc::new(Mutex::new(None)),
            global_shortcut: Arc::new(Mutex::new(None)),
            attachments: AttachmentRegistry::new(),
        }
    }
}

// Global handle for background tasks that don't receive State directly.
pub static APP: OnceCell<tauri::AppHandle> = OnceCell::new();
