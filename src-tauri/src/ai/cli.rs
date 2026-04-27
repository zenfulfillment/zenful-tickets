//! Local CLI-backed AI providers: Anthropic Claude (`claude`) and OpenAI Codex (`codex`).
//!
//! We spawn the CLI as a child process, pipe the prompt to stdin, and stream
//! stdout lines back as chunks. No shell interpolation — args are passed as a
//! Vec so there's no injection surface even with adversarial prompts.

use crate::ai::StreamChunk;
use crate::error::{AppError, AppResult};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

// ─────────────────────────────────────────────────────────────
// PATH augmentation
//
// GUI Tauri apps launched from Finder/dock on macOS inherit `launchd`'s minimal
// PATH (just /usr/bin:/bin:/usr/sbin:/sbin), missing every common Node / package
// manager bin directory. Linux has the same problem under some session managers
// and Snap/Flatpak. We prepend the well-known install locations so detection
// and spawning work regardless of how the app was launched.
//
// Order matters — earlier entries shadow later ones. We put user-local install
// paths first so a `~/.npm-global/claude` wins over a stale system-wide one.
// ─────────────────────────────────────────────────────────────

// On Windows, child processes spawned from a GUI app inherit `CREATE_NEW_CONSOLE`
// behavior — `CreateProcess` allocates a fresh console window for any child that
// doesn't already have one. For our background CLI calls (`claude --version`,
// `claude -p …`, `codex exec`) that surfaces a visible terminal flashing in
// front of the app for the duration of the request. Setting `CREATE_NO_WINDOW`
// (0x0800_0000) tells Windows to launch the process without a console at all,
// while keeping our piped stdin/stdout/stderr fully functional.
//
// This flag must NOT be applied to the interactive login spawns (wt.exe / cmd /
// powershell in `ai_open_login`) — those rely on a real console to host the
// user's auth flow.
//
// On non-Windows platforms this is a no-op.
fn apply_no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn augmented_path() -> String {
    let home = std::env::var("HOME").ok().map(PathBuf::from);
    let mut extras: Vec<PathBuf> = Vec::new();

    if let Some(h) = &home {
        // npm globals
        extras.push(h.join(".npm-global/bin"));
        extras.push(h.join(".npm/bin"));
        // Volta
        extras.push(h.join(".volta/bin"));
        // bun
        extras.push(h.join(".bun/bin"));
        // pnpm
        extras.push(h.join(".local/share/pnpm"));
        // cargo
        extras.push(h.join(".cargo/bin"));
        // generic local
        extras.push(h.join(".local/bin"));
        extras.push(h.join("bin"));
        // Anthropic Claude Code's native installer
        extras.push(h.join(".claude/local"));
        extras.push(h.join(".claude/bin"));

        // nvm: enumerate every installed Node version
        let nvm = h.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm) {
            for e in entries.flatten() {
                extras.push(e.path().join("bin"));
            }
        }
    }

    // System-level locations (matter mainly on macOS where launchd PATH omits them)
    #[cfg(target_os = "macos")]
    {
        extras.push(PathBuf::from("/opt/homebrew/bin"));
        extras.push(PathBuf::from("/opt/homebrew/sbin"));
        extras.push(PathBuf::from("/usr/local/bin"));
        extras.push(PathBuf::from("/usr/local/sbin"));
    }
    #[cfg(target_os = "linux")]
    {
        extras.push(PathBuf::from("/usr/local/bin"));
        extras.push(PathBuf::from("/snap/bin"));
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            extras.push(PathBuf::from(format!("{appdata}\\npm")));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            extras.push(PathBuf::from(format!("{local}\\Programs\\Anthropic\\Claude Code")));
        }
        if let Some(h) = &home {
            extras.push(h.join("AppData\\Roaming\\npm"));
        }
    }

    // Keep only directories that actually exist — saves `which` and the spawned
    // process from scanning bogus paths.
    let extras = extras
        .into_iter()
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    let existing = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(target_os = "windows") { ';' } else { ':' };

    if extras.is_empty() {
        existing
    } else {
        let extras_joined = extras.join(&sep.to_string());
        if existing.is_empty() {
            extras_joined
        } else {
            format!("{extras_joined}{sep}{existing}")
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CliStatus {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

pub async fn probe_cli(cli: &str) -> CliStatus {
    let path_env = augmented_path();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let Some(path) = which::which_in(cli, Some(&path_env), &cwd).ok() else {
        return CliStatus { available: false, path: None, version: None };
    };
    let mut probe = Command::new(&path);
    probe
        .arg("--version")
        .env("PATH", &path_env)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    apply_no_window(&mut probe);
    let version = probe
        .output()
        .await
        .ok()
        .and_then(|out| {
            if out.status.success() {
                Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
            } else {
                None
            }
        });
    CliStatus {
        available: true,
        path: Some(path.to_string_lossy().to_string()),
        version,
    }
}

#[derive(Clone, Copy)]
pub enum Cli {
    Claude,
    Codex,
}

impl Cli {
    pub fn binary(&self) -> &'static str {
        match self {
            Cli::Claude => "claude",
            Cli::Codex => "codex",
        }
    }

    /// Build the argv for non-interactive streaming. Both CLIs read from stdin
    /// and print the response to stdout. `model` is the per-provider model
    /// id the user picked in the model selector (None → CLI default).
    ///
    /// `image_paths` is forwarded as one `--image <path>` flag per entry on
    /// Claude (which natively accepts images and PDFs through that flag).
    /// Codex has no equivalent today, so the slice is ignored — the caller
    /// is expected to have surfaced a "Codex won't see images" warning.
    pub fn argv(
        &self,
        system_prompt: &str,
        model: Option<&str>,
        image_paths: &[std::path::PathBuf],
    ) -> Vec<String> {
        match self {
            // `claude -p <prompt>` prints the response and exits.
            //
            // Streaming: `--output-format text` BUFFERS the response and only
            // flushes on completion, so the user stares at a blank screen for
            // 10–30s. `--output-format stream-json` emits JSONL events token by
            // token; combined with `--include-partial-messages` we get
            // per-delta `stream_event` entries with `event.delta.text`. The
            // `--verbose` flag is required by the CLI when stream-json is set.
            // We extract the text deltas in `parse_stream_chunk` below and only
            // forward the actual text payload to the UI.
            //
            // Model: forwarded with `--model <id>` when the user picked one.
            // Omitted when None so the CLI uses its configured default.
            Cli::Claude => {
                let mut v: Vec<String> = vec![
                    "-p".into(),
                    "--append-system-prompt".into(),
                    system_prompt.to_string(),
                    "--output-format".into(),
                    "stream-json".into(),
                    "--include-partial-messages".into(),
                    "--verbose".into(),
                ];
                if let Some(m) = model.map(str::trim).filter(|s| !s.is_empty()) {
                    v.push("--model".into());
                    v.push(m.to_string());
                }
                // Vision attachments. The Claude CLI accepts repeated
                // `--image <path>` flags for image and PDF files; the model
                // is invoked with multimodal context for each. We pass
                // absolute paths so the CLI doesn't try to resolve against
                // its own CWD (which differs between dev and bundled run).
                for p in image_paths {
                    v.push("--image".into());
                    v.push(p.to_string_lossy().into_owned());
                }
                v
            }
            // `codex exec` runs non-interactively. Two notes:
            //  - `--skip-git-repo-check` bypasses the "trust this directory"
            //    interactive prompt the CLI emits when run from inside a
            //    repo it hasn't seen. Spawned from the Tauri webview the
            //    CWD is the app bundle / user's project; either way we want
            //    to never block waiting for stdin trust input.
            //  - `--json` emits structured JSONL events instead of the
            //    banner-delimited text mode. We parse `item.completed`
            //    events with `type: "agent_message"` to extract the full
            //    response. Codex doesn't currently stream token-by-token in
            //    JSON mode (one `item.completed` per turn), so the user
            //    sees the shimmer for the full duration and then the
            //    response materialises. We get clean parsing in exchange.
            //  - Codex doesn't support a separate `--system` flag; the
            //    system prompt is prepended to the stdin payload at the
            //    call site below.
            //  - Model: forwarded with `-m <id>` when picked.
            Cli::Codex => {
                let mut v: Vec<String> = vec![
                    "exec".into(),
                    "--skip-git-repo-check".into(),
                    "--json".into(),
                ];
                if let Some(m) = model.map(str::trim).filter(|s| !s.is_empty()) {
                    v.push("-m".into());
                    v.push(m.to_string());
                }
                // Prompt comes from stdin — `-` is the explicit "read stdin" sentinel.
                v.push("-".into());
                v
            }
        }
    }

    /// Whether the system prompt is passed via argv (Claude) or prepended to
    /// the user message stdin stream (Codex).
    pub fn system_in_argv(&self) -> bool {
        matches!(self, Cli::Claude)
    }

    /// Translate one raw stdout line from the CLI into zero or more chunks of
    /// user-visible text. Two CLIs, two formats:
    ///
    /// - **Claude** is invoked with `stream-json` so each line is a JSON
    ///   object. We only forward `stream_event` lines whose `event.delta.type`
    ///   is `"text_delta"` — those are the actual token deltas the assistant
    ///   is producing. All other events (`system`, `assistant` final summary,
    ///   `result`, `message_start`, `content_block_start`, `message_stop`,
    ///   etc.) are control plane and would only pollute the rendered body.
    ///   Empty list = drop the line silently.
    ///
    /// - **Codex** still emits plain text on stdout — no JSON wrapping — so we
    ///   pass the line straight through. (When Codex grows a streaming JSON
    ///   mode we'll branch here too.)
    ///
    /// If a Claude line fails to parse as JSON, we conservatively pass it
    /// through as plain text so the user sees *something* rather than silent
    /// loss — typically that's a CLI banner or an error message printed
    /// outside the JSON stream.
    pub fn parse_stream_chunk(&self, raw_line: &str) -> Vec<String> {
        match self {
            Cli::Claude => parse_claude_stream_line(raw_line),
            Cli::Codex => parse_codex_stream_line(raw_line),
        }
    }
}

/// Parse a single JSONL line from `codex exec --json` and return the
/// agent message text if the line carries one.
///
/// Codex's JSON mode emits a small set of event types:
///   - `thread.started` / `turn.started` — control plane, drop.
///   - `item.completed` with `item.type == "agent_message"` — the full
///     assistant response in `item.text`. Codex (as of 0.116) does NOT
///     stream token deltas in `--json` mode; the entire response arrives
///     in one event. So this is effectively the "the response is ready"
///     signal — the UI shimmer stays on for the whole turn and then the
///     body materialises in one go.
///   - `turn.completed` with usage stats — drop.
///   - Other item types (reasoning, tool calls, etc.) — drop. We only
///     surface assistant prose to the ticket body.
///
/// Non-JSON lines (banners, errors printed outside the stream) fall back
/// to raw passthrough so the user can see CLI output that didn't make it
/// through the protocol.
fn parse_codex_stream_line(raw_line: &str) -> Vec<String> {
    let trimmed = raw_line.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let val: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return vec![raw_line.to_string()],
    };

    let event_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if event_type != "item.completed" {
        return Vec::new();
    }
    let Some(item) = val.get("item") else {
        return Vec::new();
    };
    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if item_type != "agent_message" {
        return Vec::new();
    }
    let Some(text) = item.get("text").and_then(|v| v.as_str()) else {
        return Vec::new();
    };
    if text.is_empty() {
        Vec::new()
    } else {
        vec![text.to_string()]
    }
}

/// Parse a single JSONL line from `claude --output-format stream-json
/// --include-partial-messages` and return the text delta(s) it carries, if
/// any. Quiet on parse failure for empty / blank lines; falls back to raw
/// text for non-JSON lines so we never silently swallow CLI output.
fn parse_claude_stream_line(raw_line: &str) -> Vec<String> {
    let trimmed = raw_line.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let val: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => {
            // Not a JSON line — pass through so the user sees CLI banner /
            // error text instead of nothing.
            return vec![raw_line.to_string()];
        }
    };

    // Only `stream_event` carries token-level deltas under
    // `event.delta.text` when `event.delta.type == "text_delta"`. We also
    // accept `content_block_delta` shapes that may appear in older CLI
    // versions. Anything else is control-plane noise we drop.
    let event_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if event_type != "stream_event" {
        return Vec::new();
    }

    let Some(delta) = val.pointer("/event/delta") else {
        return Vec::new();
    };
    let delta_type = delta
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if delta_type != "text_delta" {
        return Vec::new();
    }
    let Some(text) = delta.get("text").and_then(|v| v.as_str()) else {
        return Vec::new();
    };
    if text.is_empty() {
        Vec::new()
    } else {
        vec![text.to_string()]
    }
}

pub async fn stream(
    cli: Cli,
    system_prompt: String,
    user_prompt: String,
    model: Option<String>,
    image_paths: Vec<PathBuf>,
    chunks_tx: mpsc::Sender<StreamChunk>,
    cancel_rx: oneshot::Receiver<()>,
) -> AppResult<()> {
    let binary = cli.binary();
    let argv = cli.argv(&system_prompt, model.as_deref(), &image_paths);
    let path_env = augmented_path();

    let mut cmd = Command::new(binary);
    cmd.args(&argv)
        .env("PATH", &path_env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Ai(format!("failed to spawn {binary}: {e}")))?;

    // Send the prompt to stdin.
    let stdin_payload = if cli.system_in_argv() {
        user_prompt
    } else {
        // For Codex, prepend system prompt as a leading instruction block.
        format!("[SYSTEM]\n{system_prompt}\n[END SYSTEM]\n\n{user_prompt}")
    };

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(stdin_payload.as_bytes()).await.ok();
        drop(stdin);
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Ai("no stdout handle".into()))?;
    let stderr = child.stderr.take();

    let chunks_tx_stdout = chunks_tx.clone();
    let cli_for_parser = cli.clone();

    // Pump stdout line-by-line through the per-CLI parser so the frontend
    // sees clean assistant text, not control-plane JSON events.
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::with_capacity(1024);
        loop {
            buf.clear();
            let n = match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            let _ = n;
            // Strip the trailing newline before parsing — JSON parsers don't
            // care, but it keeps the fallback raw-text branch from leaking
            // line endings into the rendered Markdown.
            let line = String::from_utf8_lossy(&buf).trim_end_matches(['\n', '\r']).to_string();
            for chunk in cli_for_parser.parse_stream_chunk(&line) {
                if chunks_tx_stdout
                    .send(StreamChunk::Text(chunk))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    });

    let stderr_task = async move {
        if let Some(stderr) = stderr {
            let mut reader = BufReader::new(stderr);
            let mut s = String::new();
            let _ = reader.read_to_string(&mut s).await;
            s
        } else {
            String::new()
        }
    };

    // Race: wait for child OR cancel signal.
    tokio::select! {
        status = child.wait() => {
            let status = status.map_err(|e| AppError::Ai(format!("wait: {e}")))?;
            stdout_task.await.ok();
            if !status.success() {
                let err = stderr_task.await;
                let friendly = friendly_error(binary, err.trim());
                let _ = chunks_tx.send(StreamChunk::Error(friendly)).await;
            }
        }
        _ = cancel_rx => {
            let _ = child.kill().await;
            stdout_task.await.ok();
            let _ = chunks_tx.send(StreamChunk::Error("cancelled".into())).await;
        }
    }

    Ok(())
}

/// Translate raw CLI stderr into user-actionable text. Known auth failures get
/// a concrete remediation; everything else falls through with the binary name
/// prefixed for context.
fn friendly_error(binary: &str, stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    let auth_markers = [
        "/login",
        "not authenticated",
        "not logged in",
        "please sign in",
        "please log in",
        "unauthorized",
        "401",
        "authentication required",
        "no credentials",
        "session expired",
    ];
    if auth_markers.iter().any(|m| lower.contains(m)) {
        let cmd = match binary {
            "claude" => "claude /login",
            "codex" => "codex login",
            other => other,
        };
        return format!(
            "{binary} isn't signed in. Open a terminal and run `{cmd}`, then come back and try again.\n\n(original error: {})",
            truncate(stderr, 240)
        );
    }
    if lower.contains("command not found") || lower.contains("not found") {
        return format!(
            "Couldn't run `{binary}`. Make sure the CLI is installed and on your PATH, then relaunch the app."
        );
    }
    if stderr.is_empty() {
        format!("{binary} exited without output. Try running it once in a terminal to confirm it's working.")
    } else {
        format!("{binary} failed: {}", truncate(stderr, 400))
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let cut: String = s.chars().take(n).collect();
        format!("{cut}…")
    }
}

// ─────────────────────────────────────────────────────────────
// Open a terminal window pre-loaded with the CLI's login command.
//
// Cross-platform terminal launching is a fragile area; the strategy is
// best-effort: try the most common terminals in order, fall back gracefully.
// The user just needs to see a prompt and complete the OAuth flow.
// ─────────────────────────────────────────────────────────────

pub fn open_login_terminal(provider: &str) -> AppResult<()> {
    // Lock the command set so the Tauri IPC surface can't be coerced into
    // running arbitrary shell input.
    let login_cmd = match provider {
        "claude" => "claude /login",
        "codex" => "codex login",
        other => return Err(AppError::Invalid(format!("unknown provider: {other}"))),
    };

    let path_env = augmented_path();

    // Used by the macOS Ghostty fallback and every Linux terminal — Windows
    // wraps the same prompt as a `.cmd`/`.bat` invocation further down, so
    // gate this so Windows builds don't fire `unused_variable`.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let inner_unix = format!("{login_cmd}; echo; read -rp 'Press Enter to close…'");

    #[cfg(target_os = "macos")]
    {
        // 1. AppleScript drives Terminal.app reliably across every macOS version.
        let exported = format!(
            "export PATH='{}'; {}",
            path_env.replace('\'', "'\\''"),
            login_cmd
        );
        let script = format!(
            "tell application \"Terminal\"\n  activate\n  do script \"{}\"\nend tell",
            exported.replace('\\', "\\\\").replace('"', "\\\"")
        );
        if std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }

        // 2. Ghostty if installed (handles users who set it as default).
        if which::which("ghostty").is_ok()
            && std::process::Command::new("ghostty")
                .args(["-e", "bash", "-lc", &inner_unix])
                .env("PATH", &path_env)
                .spawn()
                .is_ok()
        {
            return Ok(());
        }

        // 3. Last-resort: write a .command file and `open` it. macOS hands
        //    .command files to Terminal.app even without Automation permission.
        if let Ok(()) = open_command_file(&path_env, login_cmd) {
            return Ok(());
        }

        return Err(AppError::Other(
            "couldn't open a terminal — try running the login command manually".into(),
        ));
    }

    #[cfg(target_os = "linux")]
    {
        // First honour $TERMINAL if the user set one explicitly.
        if let Ok(term) = std::env::var("TERMINAL") {
            if !term.is_empty()
                && std::process::Command::new(&term)
                    .args(["-e", "bash", "-lc", &inner_unix])
                    .env("PATH", &path_env)
                    .spawn()
                    .is_ok()
            {
                return Ok(());
            }
        }

        // Probe a wide list of terminals — modern Wayland-native ones first,
        // then GTK/Qt classics, then xterm (the X11 universal default that's
        // basically always available where any GUI is present).
        let candidates: &[(&str, &[&str])] = &[
            ("ghostty",             &["-e", "bash", "-lc"]),
            ("x-terminal-emulator", &["-e", "bash", "-lc"]),
            ("gnome-terminal",      &["--", "bash", "-lc"]),
            ("kgx",                 &["--", "bash", "-lc"]), // GNOME Console (modern GNOME default)
            ("ptyxis",              &["--", "bash", "-lc"]), // Fedora 40+ default
            ("konsole",             &["-e", "bash", "-lc"]),
            ("xfce4-terminal",      &["-e", "bash", "-lc"]),
            ("tilix",               &["-e", "bash", "-lc"]),
            ("kitty",               &["bash", "-lc"]),
            ("alacritty",           &["-e", "bash", "-lc"]),
            ("wezterm",             &["start", "--", "bash", "-lc"]),
            ("foot",                &["-e", "bash", "-lc"]), // Wayland default on Sway/etc.
            ("warp-terminal",       &["-e", "bash", "-lc"]),
            ("xterm",               &["-e", "bash", "-lc"]), // X11 fallback
        ];
        for (term, prefix) in candidates {
            if which::which(term).is_err() {
                continue;
            }
            if std::process::Command::new(term)
                .args(*prefix)
                .arg(&inner_unix)
                .env("PATH", &path_env)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        return Err(AppError::Other(
            "couldn't find a terminal emulator — tried $TERMINAL, ghostty, gnome-terminal, konsole, kitty, alacritty, foot, xterm, …".into(),
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let inner_win = format!("{login_cmd} & pause");

        // 1. Windows Terminal if installed (modern, tabbed, sane defaults).
        if which::which("wt.exe").is_ok()
            && std::process::Command::new("wt.exe")
                .args(["cmd", "/K", &inner_win])
                .env("PATH", &path_env)
                .spawn()
                .is_ok()
        {
            return Ok(());
        }

        // 2. Ghostty if installed.
        if which::which("ghostty.exe").is_ok()
            && std::process::Command::new("ghostty.exe")
                .args(["-e", "cmd", "/K", &inner_win])
                .env("PATH", &path_env)
                .spawn()
                .is_ok()
        {
            return Ok(());
        }

        // 3. PowerShell — present on every supported Windows version.
        if std::process::Command::new("powershell")
            .args(["-NoExit", "-Command", login_cmd])
            .env("PATH", &path_env)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }

        // 4. cmd.exe — universal Windows fallback.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "cmd", "/K", &inner_win])
            .env("PATH", &path_env)
            .spawn()
            .map_err(|e| AppError::Other(format!("cmd: {e}")))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err(AppError::Other("unsupported platform".into()))
}

#[cfg(target_os = "macos")]
fn open_command_file(path_env: &str, login_cmd: &str) -> AppResult<()> {
    use std::io::Write;
    let path = std::env::temp_dir().join(format!("zft-login-{}.command", uuid_quick()));
    let body = format!(
        "#!/bin/bash\nexport PATH={path_env:?}\n{login_cmd}\necho\nread -rp 'Press Enter to close…'\n"
    );
    {
        let mut f = std::fs::File::create(&path)?;
        f.write_all(body.as_bytes())?;
    }
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| AppError::Other(format!("open: {e}")))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn uuid_quick() -> String {
    // Tiny unique-ish suffix without pulling another crate dep into this file.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{now:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deltas(line: &str) -> Vec<String> {
        Cli::Claude.parse_stream_chunk(line)
    }

    #[test]
    fn extracts_text_from_stream_event_text_delta() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}"#;
        assert_eq!(deltas(line), vec!["Hello".to_string()]);
    }

    #[test]
    fn drops_non_text_delta_events() {
        let cases = [
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m_1"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}}"#,
            r#"{"type":"system","subtype":"init","cwd":"/tmp"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"final assembled text — should NOT double-emit"}]}}"#,
            r#"{"type":"result","subtype":"success","total_cost_usd":0.001}"#,
        ];
        for c in cases {
            assert!(deltas(c).is_empty(), "expected drop for: {c}");
        }
    }

    #[test]
    fn empty_lines_drop_silently() {
        assert!(deltas("").is_empty());
        assert!(deltas("   \n").is_empty());
    }

    #[test]
    fn non_json_passes_through_as_raw_text() {
        // CLI banners / unexpected stderr-on-stdout shouldn't disappear.
        let line = "Warning: something printed outside the JSON stream";
        assert_eq!(deltas(line), vec![line.to_string()]);
    }

    #[test]
    fn codex_extracts_agent_message_text() {
        let line = r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Here is your draft."}}"#;
        assert_eq!(
            Cli::Codex.parse_stream_chunk(line),
            vec!["Here is your draft.".to_string()]
        );
    }

    #[test]
    fn codex_drops_control_events() {
        let cases = [
            r#"{"type":"thread.started","thread_id":"t_1"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":10}}"#,
            r#"{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"thinking…"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_2","type":"tool_call","name":"shell"}}"#,
        ];
        for c in cases {
            assert!(Cli::Codex.parse_stream_chunk(c).is_empty(), "expected drop for: {c}");
        }
    }

    #[test]
    fn codex_falls_back_to_raw_for_non_json() {
        // Codex banners on stdout (text mode) shouldn't disappear if the
        // CLI gets misconfigured.
        let line = "OpenAI Codex v0.116.0";
        assert_eq!(Cli::Codex.parse_stream_chunk(line), vec![line.to_string()]);
        assert!(Cli::Codex.parse_stream_chunk("").is_empty());
    }

    #[test]
    fn streamed_deltas_concatenate_to_final_text() {
        // Reassembling a multi-delta sequence should produce the canonical text.
        let lines = [
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m_1"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello, "}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
            r#"{"type":"result","subtype":"success"}"#,
        ];
        let assembled: String = lines
            .iter()
            .flat_map(|l| deltas(l))
            .collect::<Vec<_>>()
            .join("");
        assert_eq!(assembled, "Hello, world!");
    }
}
