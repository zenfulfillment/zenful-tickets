// DTOs mirroring the Rust side. Keep in lockstep with src-tauri/src/*.

export type Provider = "claude_cli" | "codex_cli" | "gemini";

export interface CliStatus {
  available: boolean;
  path: string | null;
  version: string | null;
}

export interface DetectResult {
  claude: CliStatus;
  codex: CliStatus;
  gemini: { has_key: boolean };
}

export interface SecretsStatus {
  jira_site: string | null;
  jira_email: string | null;
  has_jira_token: boolean;
  has_gemini_key: boolean;
  has_anthropic_key: boolean;
  has_openai_key: boolean;
}

export interface SecretsPatch {
  jira_site?: string;
  jira_email?: string;
  jira_token?: string;
  gemini_key?: string;
  anthropic_key?: string;
  openai_key?: string;
}

export interface JiraUser {
  accountId: string;
  displayName?: string;
  email?: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey?: string;
}

export interface JiraIssueType {
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  subtask: boolean;
  hierarchyLevel?: number;
}

export interface JiraPriority {
  id: string;
  name: string;
  iconUrl?: string;
}

export interface JiraEpic {
  id: string;
  key: string;
  summary: string;
}

/**
 * Per-draft attachment metadata. Mirrors the Rust `AttachmentRef` struct.
 *
 * The frontend never touches absolute paths — only this opaque record. All
 * file operations (read, remove, purge) go through Tauri commands that
 * resolve `id` to an on-disk path internally. This keeps the webview's
 * filesystem surface area at zero.
 */
export type AttachmentKind =
  | "image"
  | "pdf"
  | "spreadsheet"
  | "document"
  | "csv"
  | "text"
  | "unsupported";

export interface AttachmentRef {
  id: string;
  session_id: string;
  filename: string;
  size_bytes: number;
  mime: string;
  kind: AttachmentKind;
  /** Extracted character count. 0 for images. */
  extracted_chars: number;
  /** Inline data URL preview for image attachments under 512 KB. */
  preview_data_url?: string | null;
}

export interface CreateIssueResponse {
  id: string;
  key: string;
  self: string;
  browse_url?: string;
}

/**
 * Metadata sidecar from the trailing fenced JSON block.
 *
 * As of the slimmed prompt, the Markdown body the user sees on screen IS
 * the ticket description — this carries only the structured fields the UI
 * needs to pre-fill Jira's form (title field, type / priority selectors,
 * labels list). The body itself is shipped to Jira straight from the
 * streamed Markdown (`Draft.tsx::handleCreate`).
 *
 * `description`, `acceptance_criteria`, and `tech_notes` are kept here as
 * optional/tolerated for one transitional cycle: a model that ignores the
 * new prompt and still emits the old shape will continue to parse, the
 * fields are just ignored downstream. Drop them once we're confident every
 * provider is emitting the new schema.
 */
export interface ParsedTicket {
  title: string;
  type: string;
  priority: string;
  labels: string[];
  /**
   * Subtask titles the model proposed. Each becomes a real Jira sub-task
   * issue created alongside the main ticket. Empty array means the model
   * decided the scope didn't warrant a subtask breakdown — the prompt
   * explicitly tells the model to omit subtasks for bug fixes / single-PR
   * work, so an empty array here is the correct, common case.
   */
  subtasks?: string[];
  description?: string;
  acceptance_criteria?: string[];
  tech_notes?: string;
}

export interface DraftDoneEvent {
  request_id: string;
  text: string;
  ticket: ParsedTicket | null;
}

// Persisted settings (tauri-plugin-store). Everything is non-secret.
export interface AppSettings {
  // general
  theme: "system" | "light" | "dark";
  reduceMotion: boolean;
  sounds: boolean;
  launchAtLogin: boolean;
  autoUpdate: boolean;
  // jira defaults
  defaultProjectKey: string | null;
  defaultIssueType: string; // display name, e.g. "Story"
  autoAssign: boolean;
  openAfterCreate: boolean;
  // ai
  aiEnabled: { claude: boolean; codex: boolean; gemini: boolean };
  defaultProvider: Provider;
  /**
   * Per-provider model preference. Each key is a Provider, each value is
   * the chosen `ModelVariant.id`. Lazily populated as the user picks.
   * Missing/empty values fall back to `defaultModelFor(provider)`.
   */
  selectedModelByProvider: Partial<Record<Provider, string>>;
  streaming: boolean;
  // drafting
  defaultMode: "PO" | "DEV";
  submitOnEnter: boolean;
  tone: "concise" | "balanced" | "detailed";
  systemPrompt: string;
  // voice
  voiceEnabled: boolean;
  autoSubmit: boolean;
  silenceMs: number;
  /** MediaDeviceInfo.deviceId; null = system default. */
  audioInputDeviceId: string | null;
  // hotkeys — Tauri global-shortcut combo string, e.g. "CommandOrControl+Alt+KeyT"
  globalHotkey: string;
  // lifecycle
  onboardingComplete: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  reduceMotion: false,
  sounds: true,
  launchAtLogin: false,
  autoUpdate: true,
  defaultProjectKey: null,
  defaultIssueType: "Story",
  autoAssign: false,
  openAfterCreate: true,
  aiEnabled: { claude: true, codex: true, gemini: false },
  defaultProvider: "claude_cli",
  selectedModelByProvider: {},
  streaming: true,
  defaultMode: "PO",
  submitOnEnter: true,
  tone: "balanced",
  systemPrompt: "",
  voiceEnabled: true,
  autoSubmit: false,
  silenceMs: 1500,
  audioInputDeviceId: null,
  globalHotkey: "CommandOrControl+Alt+KeyT",
  onboardingComplete: false,
};

export const MODELS: {
  id: string;
  provider: Provider;
  name: string;
  short: string;
  vendor: string;
  color: string;
  char: string;
}[] = [
  { id: "claude", provider: "claude_cli", name: "Claude (CLI)", short: "Claude", vendor: "Anthropic", color: "#d97757", char: "✻" },
  { id: "codex", provider: "codex_cli", name: "Codex (CLI)", short: "Codex", vendor: "OpenAI", color: "#10a37f", char: "◓" },
  { id: "gemini", provider: "gemini", name: "Gemini 2.5 Pro", short: "Gemini 2.5", vendor: "Google", color: "#4285f4", char: "◆" },
];

/**
 * Per-provider catalog of model variants the user can pick. The `id` is
 * what we forward to the backend (as `--model <id>` for Claude CLI,
 * `-m <id>` for Codex CLI, or substituted into the Gemini API path).
 *
 * The first entry per provider is the default — used when the user has
 * never picked one explicitly and the persisted setting is empty.
 *
 * Curated list, deliberately short. The CLIs accept other model ids too,
 * but listing every minor variant in the picker would make it noise.
 * Power users can still extend this array.
 */
export interface ModelVariant {
  /** Identifier passed to the underlying CLI/API. */
  id: string;
  /** Human label rendered in the picker. */
  name: string;
  /** Short label for the trigger chip. */
  short: string;
  /** One-line capability hint. */
  description: string;
}

export const MODEL_VARIANTS: Record<Provider, ModelVariant[]> = {
  claude_cli: [
    { id: "claude-opus-4-7",   name: "Claude Opus 4.7",   short: "Opus 4.7",   description: "Most capable. Slower, costs more. Best for complex drafts." },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", short: "Sonnet 4.6", description: "Balanced quality + speed. Sensible default." },
    { id: "claude-haiku-4-5",  name: "Claude Haiku 4.5",  short: "Haiku 4.5",  description: "Fastest + cheapest. Great for quick drafts." },
  ],
  codex_cli: [
    { id: "gpt-5",      name: "GPT-5",      short: "GPT-5",     description: "OpenAI flagship. Strong reasoning across modes." },
    { id: "gpt-5-mini", name: "GPT-5 mini", short: "GPT-5 mini", description: "Smaller, faster, cheaper." },
    { id: "o3",         name: "o3",          short: "o3",        description: "Reasoning-focused. Slower; trades latency for depth." },
  ],
  gemini: [
    { id: "gemini-2.5-pro",        name: "Gemini 2.5 Pro",        short: "2.5 Pro",        description: "Google's flagship; best for long context." },
    { id: "gemini-2.5-flash",      name: "Gemini 2.5 Flash",      short: "2.5 Flash",      description: "Fast + cheap; good default for short drafts." },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite", short: "2.5 Flash-Lite", description: "Smallest. Very fast; lower quality on nuanced asks." },
  ],
};

export function defaultModelFor(provider: Provider): string {
  return MODEL_VARIANTS[provider]?.[0]?.id ?? "";
}

export const ISSUE_TYPE_COLORS: Record<string, { color: string; icon: string }> = {
  Story: { color: "#30d158", icon: "◉" },
  Task: { color: "#0a84ff", icon: "◇" },
  Bug: { color: "#ff453a", icon: "✕" },
  Epic: { color: "#bf5af2", icon: "⬢" },
  "Sub-task": { color: "#6b6b70", icon: "▸" },
};

export const PRIORITY_COLORS: Record<string, string> = {
  Highest: "#ff453a",
  High: "#ff9f0a",
  Medium: "#ffd60a",
  Low: "#30d158",
  Lowest: "#64d2ff",
};
