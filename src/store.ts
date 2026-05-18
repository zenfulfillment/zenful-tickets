import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type AttachmentRef,
  type ReferenceEntry,
  type SecretsStatus,
} from "./types";
import { applyReduceMotion, applyTheme } from "./lib/theme";
import { secretsStatus as fetchSecretsStatus } from "./lib/tauri";

// tauri-plugin-store — lazily opened. All keys under one file.
const tauriStore = new LazyStore("settings.json", { autoSave: true, defaults: {} });
const SETTINGS_KEY = "settings";

export type Screen = "loading" | "onboarding" | "main" | "interview" | "draft" | "settings";

export interface DraftContext {
  prompt: string;
  provider: AppSettings["defaultProvider"];
  mode: "PO" | "DEV";
  /** Per-provider model id the user picked in the model selector.
   *  Missing/empty → backend uses the provider's default model. */
  model?: string;
  /**
   * Attachments registered against the prompt. Carry through to the AI
   * draft (image/text routing per provider) and to Jira issue creation
   * (uploaded after the issue is minted via `jira_upload_attachment_by_id`).
   *
   * The `sessionId` is preserved alongside the refs so the Draft screen
   * can call `attachment_purge_session` after the work is complete —
   * Main.tsx hands ownership of cleanup off rather than purging on submit.
   */
  attachments?: AttachmentRef[];
  attachmentSessionId?: string;
  /**
   * Reference files/folders for DEV mode analysis context. Carried through
   * from Main → Draft so the user can add context before sending.
   */
  references?: ReferenceEntry[];
  referenceSessionId?: string;
  /** Carried Interview → Draft. Forwarded into `aiDraft` as
   *  `interview_transcript`. The Draft screen treats it as an opaque
   *  Markdown blob. */
  interview_transcript?: string;
}

export interface AppStoreState {
  screen: Screen;
  settings: AppSettings;
  secrets: SecretsStatus | null;
  draftCtx: DraftContext | null;
  interviewCtx: DraftContext | null;

  // internal
  _hydrated: boolean;
  hydrate: () => Promise<void>;

  // setters
  setScreen: (s: Screen) => void;
  setSettings: (patch: Partial<AppSettings>) => Promise<void>;
  refreshSecrets: () => Promise<void>;
  openDraft: (ctx: DraftContext) => void;
  closeDraft: () => void;
  openInterview: (ctx: DraftContext) => void;
  closeInterview: () => void;
  promoteInterviewToDraft: (interviewTranscriptMarkdown: string) => void;
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  screen: "loading",
  settings: DEFAULT_SETTINGS,
  secrets: null,
  draftCtx: null,
  interviewCtx: null,
  _hydrated: false,

  async hydrate() {
    if (get()._hydrated) return;
    // Load persisted settings (merge with defaults to survive schema extensions).
    const stored = (await tauriStore.get<Partial<AppSettings>>(SETTINGS_KEY)) ?? {};
    const settings: AppSettings = { ...DEFAULT_SETTINGS, ...stored };
    applyTheme(settings.theme);
    applyReduceMotion(settings.reduceMotion);

    // Load secret presence flags (no actual secrets come to the frontend).
    const secrets = await fetchSecretsStatus().catch(() => null);

    const gateReady =
      settings.onboardingComplete &&
      !!secrets?.jira_site &&
      !!secrets?.jira_email &&
      secrets?.has_jira_token;

    set({
      settings,
      secrets,
      screen: gateReady ? "main" : "onboarding",
      _hydrated: true,
    });
  },

  setScreen(screen) {
    set({ screen });
  },

  async setSettings(patch) {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    if (patch.theme !== undefined) applyTheme(patch.theme);
    if (patch.reduceMotion !== undefined) applyReduceMotion(patch.reduceMotion);
    await tauriStore.set(SETTINGS_KEY, next);
    await tauriStore.save();
  },

  async refreshSecrets() {
    const s = await fetchSecretsStatus().catch(() => null);
    set({ secrets: s });
  },

  openDraft(ctx) {
    set({ draftCtx: ctx, screen: "draft" });
  },

  closeDraft() {
    set({ draftCtx: null, screen: "main" });
  },

  openInterview(ctx) {
    set({ interviewCtx: ctx, screen: "interview" });
  },

  closeInterview() {
    set({ interviewCtx: null, screen: "main" });
  },

  promoteInterviewToDraft(interviewTranscriptMarkdown) {
    const ctx = get().interviewCtx;
    if (!ctx) {
      set({ screen: "main" });
      return;
    }
    // Per the spec: references are not carried into the final draft —
    // the transcript already contains the analyzed context. Attachments
    // ARE carried; subject to existing routing.
    const draftCtx: DraftContext = {
      ...ctx,
      references: undefined,
      referenceSessionId: undefined,
      interview_transcript: interviewTranscriptMarkdown,
    };
    set({ draftCtx, interviewCtx: null, screen: "draft" });
  },
}));
