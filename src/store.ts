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

export type Screen = "loading" | "onboarding" | "main" | "draft" | "settings";

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
}

export interface AppStoreState {
  screen: Screen;
  settings: AppSettings;
  secrets: SecretsStatus | null;
  draftCtx: DraftContext | null;

  // internal
  _hydrated: boolean;
  hydrate: () => Promise<void>;

  // setters
  setScreen: (s: Screen) => void;
  setSettings: (patch: Partial<AppSettings>) => Promise<void>;
  refreshSecrets: () => Promise<void>;
  openDraft: (ctx: DraftContext) => void;
  closeDraft: () => void;
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  screen: "loading",
  settings: DEFAULT_SETTINGS,
  secrets: null,
  draftCtx: null,
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
}));
