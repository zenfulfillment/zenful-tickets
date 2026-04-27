import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AttachmentRef,
  CreateIssueResponse,
  DetectResult,
  DraftDoneEvent,
  JiraEpic,
  JiraIssueType,
  JiraPriority,
  JiraProject,
  JiraUser,
  ParsedTicket,
  Provider,
  SecretsPatch,
  SecretsStatus,
} from "../types";

// ─────────────────────────────────────────────────────────────
// Secrets
// ─────────────────────────────────────────────────────────────
export const secretsStatus = () => invoke<SecretsStatus>("secrets_status");
export const secretsUpdate = (patch: SecretsPatch) =>
  invoke<SecretsStatus>("secrets_update", { patch });
export const secretsClear = () => invoke<void>("secrets_clear");

// ─────────────────────────────────────────────────────────────
// Jira
// ─────────────────────────────────────────────────────────────
export const jiraVerify = () => invoke<JiraUser>("jira_verify");
export const jiraCurrentUser = () => invoke<JiraUser>("jira_current_user");
export const jiraSearchUsers = (query: string) =>
  invoke<JiraUser[]>("jira_search_users", { query });
export const jiraListProjects = () => invoke<JiraProject[]>("jira_list_projects");
export const jiraListIssueTypes = (projectIdOrKey: string) =>
  invoke<JiraIssueType[]>("jira_list_issue_types", { projectIdOrKey });
export const jiraListPriorities = () => invoke<JiraPriority[]>("jira_list_priorities");
export const jiraListEpics = (projectKey: string) =>
  invoke<JiraEpic[]>("jira_list_epics", { projectKey });

export interface CreateIssueArgs {
  project_key: string;
  summary: string;
  description_markdown: string;
  issue_type_id: string;
  priority_id: string | null;
  labels: string[] | null;
  epic_key: string | null;
  assignee_account_id: string | null;
}

export const jiraCreateIssue = (req: CreateIssueArgs) =>
  invoke<CreateIssueResponse>("jira_create_issue", { req });

export interface CreateSubtaskArgs {
  parent_key: string;
  project_key: string;
  subtask_issue_type_id: string;
  summary: string;
  /** Optional Markdown body. Set when we've expanded the sub-task via AI. */
  description_markdown?: string;
}

export const jiraCreateSubtask = (req: CreateSubtaskArgs) =>
  invoke<CreateIssueResponse>("jira_create_subtask", { req });

export interface SubtaskExpansion {
  title: string;
  description_markdown: string;
}

export interface ExpandSubtasksArgs {
  provider: Provider;
  mode: string;
  parent_title: string;
  parent_body_markdown: string;
  subtask_titles: string[];
  custom_system_prompt?: string;
  /** Per-provider model id picked in the model selector. */
  model?: string;
  /** Same routing as `DraftArgs.attachment_ids`. */
  attachment_ids?: string[];
}

export const aiExpandSubtasks = (req: ExpandSubtasksArgs) =>
  invoke<SubtaskExpansion[]>("ai_expand_subtasks", { req });

export const jiraUploadAttachment = (issueKey: string, filePath: string) =>
  invoke<unknown>("jira_upload_attachment", {
    req: { issue_key: issueKey, file_path: filePath },
  });

/**
 * Upload an attachment by registry id (from `attachment_register_*`). Used
 * by the Draft screen after `jira_create_issue` to attach the prompt's
 * companion files to the new ticket. Path resolution happens in Rust so the
 * webview never needs to know where the cached bytes live.
 */
export const jiraUploadAttachmentById = (issueKey: string, attachmentId: string) =>
  invoke<unknown>("jira_upload_attachment_by_id", {
    req: { issue_key: issueKey, attachment_id: attachmentId },
  });

// ─────────────────────────────────────────────────────────────
// Attachments
//
// All file bytes live in a per-session cache dir on the Rust side. The
// frontend only ever passes around `AttachmentRef` records keyed by id.
// `attachment_register_bytes` covers the paste-image path (clipboard image
// blobs have no fs path); `attachment_register_path` covers drag-drop and the
// file picker. Both run extraction synchronously so the returned record
// already carries the final `extracted_chars` count.
// ─────────────────────────────────────────────────────────────
export const attachmentRegisterBytes = (
  sessionId: string,
  filename: string,
  bytes: Uint8Array,
) =>
  invoke<AttachmentRef>("attachment_register_bytes", {
    sessionId,
    filename,
    bytes: Array.from(bytes),
  });

export const attachmentRegisterPath = (sessionId: string, path: string) =>
  invoke<AttachmentRef>("attachment_register_path", { sessionId, path });

export const attachmentRemove = (id: string) =>
  invoke<void>("attachment_remove", { id });

export const attachmentPurgeSession = (sessionId: string) =>
  invoke<void>("attachment_purge_session", { sessionId });

export const attachmentList = (sessionId: string) =>
  invoke<AttachmentRef[]>("attachment_list", { sessionId });

// ─────────────────────────────────────────────────────────────
// AI
// ─────────────────────────────────────────────────────────────
export const aiDetectClis = () => invoke<DetectResult>("ai_detect_clis");

export interface DraftArgs {
  request_id: string;
  provider: Provider;
  prompt: string;
  mode: "PO" | "DEV";
  tone?: string;
  custom_system_prompt?: string;
  refine_of?: string;
  /** Per-provider model id picked in the model selector. */
  model?: string;
  /**
   * Ids of attachments previously registered via `attachment_register_*`.
   * Resolved on the Rust side and routed per provider — see
   * `src-tauri/src/ai/mod.rs::route_attachments` for the matrix.
   */
  attachment_ids?: string[];
}

export const aiDraft = (req: DraftArgs) => invoke<void>("ai_draft", { req });
export const aiCancel = (requestId: string) =>
  invoke<void>("ai_cancel", { requestId });
export const aiOpenLogin = (provider: "claude" | "codex") =>
  invoke<void>("ai_open_login", { provider });

// ─────────────────────────────────────────────────────────────
// OpenRouter catalog
// ─────────────────────────────────────────────────────────────
//
// The catalog is fetched in the background on app start (see
// src-tauri/src/lib.rs::setup) and cached on disk under app_data_dir.
// `openrouter_models_get` returns the cached snapshot; the frontend
// should also subscribe to `openrouter:catalog:updated` events so the
// picker hot-swaps the list when a fresh fetch lands.

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string | null;
  context_length?: number | null;
  max_output_length?: number | null;
  /** "text" | "image" | "file" | … — used to gate image attachments. */
  input_modalities: string[];
  output_modalities: string[];
  /** "tools" | "json_mode" | "structured_outputs" | "reasoning" | … */
  supported_features: string[];
  pricing?: unknown;
  deprecation_date?: string | null;
}

export interface OpenRouterCatalog {
  fetched_at: number;
  models: OpenRouterModel[];
}

export const openrouterModelsGet = () =>
  invoke<OpenRouterCatalog | null>("openrouter_models_get");
export const openrouterModelsRefresh = () =>
  invoke<void>("openrouter_models_refresh");

// ─────────────────────────────────────────────────────────────
// Global hotkey
// ─────────────────────────────────────────────────────────────
export const setGlobalShortcut = (combo: string) =>
  invoke<void>("set_global_shortcut", { combo });
export const clearGlobalShortcut = () =>
  invoke<void>("clear_global_shortcut");

// ─────────────────────────────────────────────────────────────
// Diagnostics / logs
// ─────────────────────────────────────────────────────────────
export const logsDir = () => invoke<string>("logs_dir");
export const logsReveal = () => invoke<void>("logs_reveal");
export const logsDiagnostics = () => invoke<string>("logs_diagnostics");

export interface DraftEventHandlers {
  onChunk?: (text: string) => void;
  onDone?: (done: DraftDoneEvent) => void;
  onError?: (message: string) => void;
}

export async function listenDraft(
  requestId: string,
  handlers: DraftEventHandlers,
): Promise<UnlistenFn> {
  const unlisten: UnlistenFn[] = [];
  if (handlers.onChunk) {
    unlisten.push(
      await listen<string>(`ai:chunk:${requestId}`, (e) => handlers.onChunk?.(e.payload)),
    );
  }
  if (handlers.onDone) {
    unlisten.push(
      await listen<DraftDoneEvent>(`ai:done:${requestId}`, (e) => handlers.onDone?.(e.payload)),
    );
  }
  if (handlers.onError) {
    unlisten.push(
      await listen<string>(`ai:error:${requestId}`, (e) => handlers.onError?.(e.payload)),
    );
  }
  return () => unlisten.forEach((fn) => fn());
}

// ─────────────────────────────────────────────────────────────
// Speech
// ─────────────────────────────────────────────────────────────
export const speechStart = () => invoke<void>("speech_start");
export const speechStop = () => invoke<void>("speech_stop");
export const speechSendChunk = (bytes: Uint8Array) =>
  invoke<void>("speech_send_chunk", { bytes: Array.from(bytes) });

export interface SpeechHandlers {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onClosed?: () => void;
}

export async function listenSpeech(handlers: SpeechHandlers): Promise<UnlistenFn> {
  const unlisten: UnlistenFn[] = [];
  if (handlers.onPartial) {
    unlisten.push(
      await listen<{ text: string }>("speech:partial", (e) =>
        handlers.onPartial?.(e.payload.text),
      ),
    );
  }
  if (handlers.onFinal) {
    unlisten.push(
      await listen<{ text: string }>("speech:final", (e) => handlers.onFinal?.(e.payload.text)),
    );
  }
  if (handlers.onError) {
    unlisten.push(
      await listen<{ text: string }>("speech:error", (e) => handlers.onError?.(e.payload.text)),
    );
  }
  if (handlers.onClosed) {
    unlisten.push(await listen("speech:closed", () => handlers.onClosed?.()));
  }
  return () => unlisten.forEach((fn) => fn());
}

// Global summon event (⌘⇧K)
export const listenSummon = (cb: () => void) => listen("app:summon", cb);

// Re-exports for convenience
export type { ParsedTicket };
