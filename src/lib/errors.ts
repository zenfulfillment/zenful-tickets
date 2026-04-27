import { currentPlatform, secretStoreName, type Platform } from "./platform";

// Tagged error payload emitted by the Rust side (see src-tauri/src/error.rs).
// Tauri delivers `invoke` rejections as the serialized error — newer versions
// give us the full object; older / pre-refactor errors come through as plain
// strings. `parseAppError` normalises both shapes.

export type AppErrorKind =
  | "keyring"
  | "http"
  | "jira"
  | "ai"
  | "voice"
  | "io"
  | "invalid"
  | "other";

export interface AppErrorPayload {
  kind: AppErrorKind;
  message: string;
  /** Present on `keyring` errors. Reflects `std::env::consts::OS`. */
  os?: string;
  /** Present on `jira` errors — the upstream HTTP status. */
  status?: number;
}

/**
 * Coerces whatever an `invoke()` rejection gave us into an `AppErrorPayload`.
 * Accepts:
 *   - the new tagged-object shape from `AppError`'s Serialize impl
 *   - legacy plain strings (e.g. "keychain error: …")
 *   - JSON-encoded strings of either of the above
 *   - genuine `Error` instances thrown by the JS side
 */
export function parseAppError(raw: unknown): AppErrorPayload {
  if (raw && typeof raw === "object" && "kind" in raw && "message" in raw) {
    const o = raw as Partial<AppErrorPayload> & { kind: unknown; message: unknown };
    return {
      kind: isKnownKind(o.kind) ? o.kind : "other",
      message: typeof o.message === "string" ? o.message : String(o.message ?? ""),
      os: typeof o.os === "string" ? o.os : undefined,
      status: typeof o.status === "number" ? o.status : undefined,
    };
  }
  if (typeof raw === "string") {
    // Try JSON first — Tauri sometimes ships the structured payload as a
    // string when it's nested inside an Error.message.
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "kind" in parsed) {
        return parseAppError(parsed);
      }
    } catch {}
    return { kind: kindFromLegacyString(raw), message: raw };
  }
  if (raw instanceof Error) {
    return parseAppError(raw.message);
  }
  return { kind: "other", message: String(raw ?? "Unknown error") };
}

function isKnownKind(v: unknown): v is AppErrorKind {
  return (
    v === "keyring" || v === "http" || v === "jira" ||
    v === "ai" || v === "voice" || v === "io" ||
    v === "invalid" || v === "other"
  );
}

// Best-effort classification of pre-refactor error strings so users on older
// builds still get a useful headline.
function kindFromLegacyString(s: string): AppErrorKind {
  const m = s.toLowerCase();
  if (m.startsWith("keychain")) return "keyring";
  if (m.startsWith("http")) return "http";
  if (m.startsWith("jira")) return "jira";
  if (m.startsWith("ai")) return "ai";
  if (m.startsWith("voice")) return "voice";
  if (m.startsWith("io")) return "io";
  if (m.startsWith("invalid")) return "invalid";
  return "other";
}

// ─── Display copy ───────────────────────────────────────────────

export interface ErrorDisplay {
  /** Short, friendly headline. Drop-in for an h1/title. */
  headline: string;
  /** Plain-language guidance. May be multi-line. */
  description: string;
}

/**
 * Map an error payload to user-facing copy. Context lets us tailor a few
 * phrases — e.g. "Couldn't sign in to Jira" vs "Couldn't store credentials".
 *
 * `setup` is the verify-after-save flow (Onboarding + Settings rotate-token):
 * the user just typed credentials, so an `invalid` here almost always means
 * we couldn't load what we just saved → keychain layer is broken.
 */
export function describeError(
  err: AppErrorPayload,
  ctx: "jira-setup" | "jira-test" | "generic" = "generic",
): ErrorDisplay {
  const platform = currentPlatform();

  if (err.kind === "keyring") {
    return {
      headline: `Couldn't access your ${secretStoreName()}`,
      description: keyringHelp(platform, (err.os as Platform | undefined) ?? platform),
    };
  }

  if (err.kind === "invalid" && (ctx === "jira-setup" || ctx === "jira-test")) {
    // In the setup flow this branch is almost always the symptom of a silent
    // keychain failure — `secrets::save` looked successful but `secrets::load`
    // came back empty, so verify reports "jira site/email/token not configured".
    if (/not configured/i.test(err.message)) {
      return {
        headline: `Credentials didn't persist to your ${secretStoreName()}`,
        description: keyringHelp(platform, platform),
      };
    }
  }

  if (err.kind === "jira") {
    const status = err.status ?? 0;
    if (status === 401) {
      return {
        headline: "Atlassian rejected those credentials",
        description:
          "The email or API token doesn't match. Double-check the email is the one you sign in to Atlassian with, and that the token hasn't been revoked. Tokens are case-sensitive and don't include any leading/trailing spaces.",
      };
    }
    if (status === 403) {
      return {
        headline: "Your account can't access this workspace",
        description:
          "The credentials are valid, but your Atlassian account doesn't have permission for this workspace. Ask a workspace admin to grant access, or try a different workspace URL.",
      };
    }
    if (status === 404) {
      return {
        headline: "That workspace URL doesn't look right",
        description:
          "Atlassian couldn't find that workspace. Make sure the URL matches what you see in the browser when you're logged into Jira (e.g. acme.atlassian.net).",
      };
    }
    if (status >= 500) {
      return {
        headline: "Atlassian is having trouble",
        description:
          "Jira returned a server error. This is usually transient — wait a minute and try again. If it persists, check status.atlassian.com.",
      };
    }
    return {
      headline: `Jira returned an error (${status || "unknown"})`,
      description: err.message || "No additional detail.",
    };
  }

  if (err.kind === "http") {
    return {
      headline: "Couldn't reach Atlassian",
      description:
        "Your computer couldn't open a connection to atlassian.net. Check your internet connection, VPN, or proxy settings, then try again.",
    };
  }

  if (err.kind === "io") {
    return {
      headline: "A local file operation failed",
      description: err.message || "Unknown I/O error.",
    };
  }

  if (err.kind === "ai") {
    return {
      headline: "AI provider error",
      description: err.message || "The model didn't return a response.",
    };
  }

  if (err.kind === "voice") {
    return {
      headline: "Voice input error",
      description: err.message || "The transcription stream failed.",
    };
  }

  if (err.kind === "invalid") {
    return {
      headline: "Something's missing",
      description: err.message || "The request was rejected as invalid.",
    };
  }

  return {
    headline: "Something went wrong",
    description: err.message || "Unknown error.",
  };
}

function keyringHelp(uiPlatform: Platform, errOs: Platform): string {
  // Prefer the platform reported by the error payload — covers the (rare)
  // case where the UI didn't manage to resolve a platform at boot.
  switch (errOs) {
    case "windows":
      return (
        "The app couldn't talk to Windows Credential Manager. This usually means the service is disabled, the app is being run with a profile that has no credential vault, or a group policy is blocking access. " +
        "Try restarting the app as your normal user account (not Administrator), or run `services.msc` and confirm \"Credential Manager\" is set to Automatic and running."
      );
    case "linux":
      return (
        "The app couldn't talk to your system keyring (Secret Service). On most Linux desktops this is provided by gnome-keyring or KWallet — make sure one is installed and unlocked, then try again. " +
        "On a headless system you may need to start a session bus (`dbus-run-session`) before launching the app."
      );
    case "macos":
      return (
        "The app couldn't talk to the macOS Keychain. Open Keychain Access, find any entry under \"com.zenfulfillment.zenfultickets\", and delete it — the app will recreate it on the next save. " +
        "If your keychain is locked, unlock it and try again."
      );
    default:
      return (
        "The app couldn't access this system's secret store. Make sure your OS keyring service is running and unlocked, then try again. " +
        `(Detected platform: ${uiPlatform}.)`
      );
  }
}

// ─── Diagnostics ────────────────────────────────────────────────

/**
 * Render a single string suitable for pasting into a bug report. Includes the
 * structured payload plus app + platform metadata so we can triage without a
 * back-and-forth.
 */
export function diagnosticsString(err: AppErrorPayload, ctx?: string): string {
  const lines = [
    `kind:     ${err.kind}`,
    `message:  ${err.message}`,
  ];
  if (err.status !== undefined) lines.push(`status:   ${err.status}`);
  if (err.os) lines.push(`os(rust): ${err.os}`);
  lines.push(`os(ui):   ${currentPlatform()}`);
  if (ctx) lines.push(`context:  ${ctx}`);
  lines.push(`ua:       ${navigator.userAgent}`);
  return lines.join("\n");
}
