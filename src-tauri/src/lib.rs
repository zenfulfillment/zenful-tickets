mod ai;
mod error;
mod jira;
mod secrets;
mod speech;
mod state;

use error::AppResult;
use secrets::{Secrets, SecretsStatus};
use state::AppState;
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

// ─────────────────────────────────────────────────────────────
// Secrets commands
// ─────────────────────────────────────────────────────────────

#[tauri::command]
fn secrets_status() -> AppResult<SecretsStatus> {
    let s = secrets::load()?;
    Ok((&s).into())
}

#[tauri::command]
fn secrets_update(patch: Secrets) -> AppResult<SecretsStatus> {
    let s = secrets::update(patch)?;
    Ok((&s).into())
}

#[tauri::command]
fn secrets_clear() -> AppResult<()> {
    secrets::clear()
}

// ─────────────────────────────────────────────────────────────
// Global hotkey commands
// ─────────────────────────────────────────────────────────────

fn focus_main_window(app: &AppHandle) {
    log::debug!("global hotkey fired — focusing main window");
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        // Tell the frontend to drop back to Main if the user wasn't mid-flow.
        use tauri::Emitter;
        let _ = w.emit("app:summon", ());
    }
}

#[tauri::command]
async fn set_global_shortcut(
    app: AppHandle,
    state: State<'_, AppState>,
    combo: String,
) -> AppResult<()> {
    let mgr = app.global_shortcut();
    // Remove the old one if any.
    let mut current = state.global_shortcut.lock().await;
    if let Some(old) = current.clone() {
        if let Ok(s) = old.parse::<Shortcut>() {
            let _ = mgr.unregister(s);
        }
    }
    // Parse + register the new one.
    let parsed: Shortcut = combo
        .parse()
        .map_err(|e| crate::error::AppError::Invalid(format!("bad shortcut: {e}")))?;
    mgr.register(parsed)
        .map_err(|e| crate::error::AppError::Other(format!("register: {e}")))?;
    log::info!("global hotkey registered: {combo}");
    *current = Some(combo);
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// Diagnostics — log file location + panic capture + redaction
// ─────────────────────────────────────────────────────────────

/// Best-effort scrubber for things that look like API keys / tokens. Treats:
///   - Anthropic / OpenAI keys: sk-…, sk-ant-…, sk-proj-…
///   - Atlassian tokens: ATATT…
///   - Google AI Studio: AIzaSy…
///   - ElevenLabs: long sk_-prefixed hex
/// Replaces with `***redacted***`. Defense-in-depth — we still try not to log
/// these in the first place.
fn redact_secrets(input: &str) -> String {
    fn scrub(s: &str, prefix: &str, min_tail: usize) -> String {
        let mut out = String::with_capacity(s.len());
        let mut idx = 0;
        let bytes = s.as_bytes();
        while idx < bytes.len() {
            if let Some(p) = s[idx..].find(prefix) {
                let start = idx + p;
                out.push_str(&s[idx..start]);
                let after = &s[start + prefix.len()..];
                let tail_len = after
                    .find(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
                    .unwrap_or(after.len());
                if tail_len >= min_tail {
                    out.push_str("***redacted***");
                    idx = start + prefix.len() + tail_len;
                } else {
                    out.push_str(&s[start..start + prefix.len()]);
                    idx = start + prefix.len();
                }
            } else {
                out.push_str(&s[idx..]);
                break;
            }
        }
        out
    }
    let mut s = input.to_string();
    for (prefix, min_tail) in [
        ("sk-ant-", 20),
        ("sk-proj-", 20),
        ("sk_", 20),
        ("sk-", 20),
        ("ATATT", 30),
        ("AIzaSy", 25),
    ] {
        s = scrub(&s, prefix, min_tail);
    }
    s
}

#[tauri::command]
async fn logs_dir(app: AppHandle) -> AppResult<String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| crate::error::AppError::Other(format!("app_log_dir: {e}")))?;
    Ok(dir.to_string_lossy().to_string())
}

/// Open the log folder in Finder / Explorer / file manager.
#[tauri::command]
async fn logs_reveal(app: AppHandle) -> AppResult<()> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| crate::error::AppError::Other(format!("app_log_dir: {e}")))?;
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| crate::error::AppError::Other(format!("open: {e}")))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| crate::error::AppError::Other(format!("xdg-open: {e}")))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| crate::error::AppError::Other(format!("explorer: {e}")))?;
    }
    Ok(())
}

/// Build a privacy-safe diagnostics blob the user can paste into a bug report.
/// Includes: app version, OS, log file path, last ~200 lines of the current log.
#[tauri::command]
async fn logs_diagnostics(app: AppHandle) -> AppResult<String> {
    let version = app.package_info().version.to_string();
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| crate::error::AppError::Other(format!("app_log_dir: {e}")))?;
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    let mut tail = String::new();
    if let Ok(entries) = std::fs::read_dir(&log_dir) {
        let mut files: Vec<_> = entries
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("zenfultickets")
            })
            .collect();
        files.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
        if let Some(latest) = files.last() {
            if let Ok(content) = std::fs::read_to_string(latest.path()) {
                let lines: Vec<&str> = content.lines().collect();
                let take = lines.len().saturating_sub(200);
                tail = lines[take..].join("\n");
            }
        }
    }

    Ok(format!(
        "Zenful Tickets v{version}\n\
         OS: {os} {arch}\n\
         Log dir: {}\n\
         \n\
         --- Recent log (last 200 lines) ---\n\
         {tail}\n",
        log_dir.to_string_lossy()
    ))
}

fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".into());
        let payload = info
            .payload()
            .downcast_ref::<&'static str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(|s| s.as_str()))
            .unwrap_or("<non-string panic payload>");
        let bt = std::backtrace::Backtrace::force_capture();
        log::error!("PANIC at {location}: {payload}\nbacktrace:\n{bt}");
        prev(info);
    }));
}

#[tauri::command]
async fn clear_global_shortcut(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let mut current = state.global_shortcut.lock().await;
    if let Some(old) = current.take() {
        if let Ok(s) = old.parse::<Shortcut>() {
            let _ = app.global_shortcut().unregister(s);
        }
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[allow(unused_mut)]
    let mut builder = builder;

    // single-instance MUST be first so a second launch exits cleanly before any
    // global-shortcut registration conflicts with the running instance.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
                let _ = w.unminimize();
            }
        }));
    }

    // ── Logging ─────────────────────────────────────────────
    // Three sinks:
    //   - LogDir → rotating file in OS-native log dir, primary persistent record
    //   - Webview → DevTools console for debugging in `tauri dev`
    //   - Stdout → terminal output in `tauri dev`
    // Rotation: 5 MB per file, keep last 5 (so ≤ 25 MB on disk).
    // Redaction: pattern-based scrub of API-key-shaped strings as defense in
    // depth — primary policy is "don't log secrets in the first place".
    let log_plugin = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::LogDir {
            file_name: Some("zenfultickets".into()),
        }))
        .target(Target::new(TargetKind::Webview))
        .target(Target::new(TargetKind::Stdout))
        .level(log::LevelFilter::Info)
        .level_for("zenfultickets_lib", log::LevelFilter::Debug)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("rustls", log::LevelFilter::Warn)
        .level_for("tao", log::LevelFilter::Warn)
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .max_file_size(5_000_000)
        .rotation_strategy(RotationStrategy::KeepAll)
        .format(|out, message, record| {
            let scrubbed = redact_secrets(&message.to_string());
            out.finish(format_args!(
                "[{}] {:>5} [{}] {}",
                tauri_plugin_log::TimezoneStrategy::UseLocal
                    .get_now()
                    .format(&time::format_description::well_known::Iso8601::DATE_TIME_OFFSET)
                    .unwrap_or_default(),
                record.level(),
                record.target(),
                scrubbed
            ))
        })
        .build();

    builder
        .plugin(log_plugin)
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        // The handler runs in Rust on the main thread — it's the reliable
        // path for actually focusing the window when the app is in the
        // background. JS-side `register()` is unreliable on macOS because
        // dispatching the event back to JS races with the OS bringing other
        // apps to focus.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        focus_main_window(app);
                    }
                })
                .build(),
        )
        // Updater (pubkey + endpoint live in tauri.conf.json → plugins.updater).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .setup(|app| {
            state::APP.set(app.handle().clone()).ok();
            install_panic_hook();
            log::info!(
                "boot: zenfultickets v{} on {}/{}",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH,
            );
            if let Ok(dir) = app.path().app_log_dir() {
                log::info!("log dir: {}", dir.to_string_lossy());
            }
            // Global hotkey is registered by the JS layer once settings hydrate
            // (so the user's persisted choice is honoured rather than a hardcoded default).
            Ok(())
        })
        .on_window_event(|window, event| {
            // On macOS, the window-state plugin persists size/position automatically.
            // We only need to intercept close-to-hide if we later add menubar mode.
            if let WindowEvent::CloseRequested { .. } = event {
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            // secrets
            secrets_status,
            secrets_update,
            secrets_clear,
            // hotkeys
            set_global_shortcut,
            clear_global_shortcut,
            // diagnostics
            logs_dir,
            logs_reveal,
            logs_diagnostics,
            // jira
            jira::jira_verify,
            jira::jira_list_projects,
            jira::jira_list_issue_types,
            jira::jira_list_priorities,
            jira::jira_list_epics,
            jira::jira_create_issue,
            jira::jira_create_subtask,
            jira::jira_upload_attachment,
            jira::jira_current_user,
            jira::jira_search_users,
            // ai
            ai::ai_detect_clis,
            ai::ai_draft,
            ai::ai_expand_subtasks,
            ai::ai_cancel,
            ai::ai_open_login,
            // voice
            speech::speech_start,
            speech::speech_stop,
            speech::speech_send_chunk,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
