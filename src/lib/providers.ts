// Single source of truth for "is this AI provider actually pickable?".
//
// Two independent gates:
//   - enabled    — user has flipped the switch on in Settings (settings.aiEnabled)
//   - configured — the credentials/binary exist (CLI detected on PATH, or API key
//                  saved to the keychain)
//
// `usable` = enabled && configured. Use it everywhere we render a model picker
// or decide whether to dispatch a draft request to a provider.
//
// To add a new provider (OpenRouter, Mistral, etc.):
//   1. Add the new id to the `Provider` union in src/types.ts.
//   2. Add an entry to `aiEnabled` in `AppSettings` and `DEFAULT_SETTINGS`.
//   3. Append a `ProviderDef` to `PROVIDERS` below with the right
//      `method` and `isConfigured` predicate. That's it — Main and Settings
//      both pick the change up automatically.

import type {
  AppSettings,
  DetectResult,
  Provider,
  SecretsStatus,
} from "../types";

export type AiEnabledKey = keyof AppSettings["aiEnabled"];

export type ProviderMethod = "cli" | "key";

export interface ProviderDef {
  /** Provider id used by drafts (matches the `Provider` union and MODELS[].provider). */
  id: Provider;
  /** Key inside `AppSettings.aiEnabled` — the visibility switch in Settings. */
  enabledKey: AiEnabledKey;
  /** "cli" → backed by a local binary on PATH; "key" → backed by a stored API secret. */
  method: ProviderMethod;
  /** True when credentials/binary exist for this provider to actually run. */
  isConfigured: (
    secrets: SecretsStatus | null,
    detected: DetectResult | null,
  ) => boolean;
}

export const PROVIDERS: readonly ProviderDef[] = [
  {
    id: "claude_cli",
    enabledKey: "claude",
    method: "cli",
    isConfigured: (_s, d) => !!d?.claude.available,
  },
  {
    id: "codex_cli",
    enabledKey: "codex",
    method: "cli",
    isConfigured: (_s, d) => !!d?.codex.available,
  },
  {
    id: "gemini",
    enabledKey: "gemini",
    method: "key",
    isConfigured: (s) => !!s?.has_gemini_key,
  },
];

export function findProvider(id: Provider): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function isProviderEnabled(
  id: Provider,
  settings: AppSettings,
): boolean {
  const p = findProvider(id);
  return p ? settings.aiEnabled[p.enabledKey] === true : false;
}

export function isProviderConfigured(
  id: Provider,
  secrets: SecretsStatus | null,
  detected: DetectResult | null,
): boolean {
  const p = findProvider(id);
  return p ? p.isConfigured(secrets, detected) : false;
}

export function isProviderUsable(
  id: Provider,
  settings: AppSettings,
  secrets: SecretsStatus | null,
  detected: DetectResult | null,
): boolean {
  return (
    isProviderEnabled(id, settings) &&
    isProviderConfigured(id, secrets, detected)
  );
}
