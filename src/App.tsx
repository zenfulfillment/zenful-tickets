import { useEffect } from "react";
import { platform } from "@tauri-apps/plugin-os";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useAppStore } from "./store";
import { listenSummon, setGlobalShortcut } from "./lib/tauri";
import { notify, notifyUpdate } from "./lib/notify";
import { Toaster } from "./components/ui/sonner";
import { Onboarding } from "./screens/Onboarding";
import { Main } from "./screens/Main";
import { Draft } from "./screens/Draft";
import { Settings } from "./screens/Settings";

export default function App() {
  const { screen, hydrate, settings } = useAppStore();

  useEffect(() => {
    void hydrate();
    // Mark the platform so CSS can reserve the title-bar safe area used by
    // titleBarStyle: "Overlay" on macOS (traffic-light dots float over content).
    try {
      document.documentElement.dataset.platform = platform();
    } catch {}
  }, [hydrate]);

  // Tell Rust which combo to register. Re-fires whenever the user changes the
  // hotkey in Settings. Rust handles unregister-of-old + register-of-new
  // atomically and runs the focus-window logic on the main thread, which is
  // the only reliable way to bring the app forward across platforms.
  useEffect(() => {
    const combo = settings.globalHotkey;
    if (!combo) return;
    void setGlobalShortcut(combo).catch((e) => {
      console.warn("global hotkey couldn't be registered", { combo, error: e });
    });
  }, [settings.globalHotkey]);

  // Rust emits `app:summon` after handling the hotkey. Drop back to Main if
  // the user wasn't mid-flow.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenSummon(() => {
      const st = useAppStore.getState();
      if (st.screen === "draft" || st.screen === "settings") return;
      st.setScreen("main");
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // Auto-update: silently check on boot when enabled. If an update exists,
  // surface a persistent (no auto-dismiss) toast in the bottom-right with
  // Install / Skip actions — the user has to acknowledge it explicitly.
  useEffect(() => {
    if (!settings.autoUpdate || screen === "loading") return;
    void checkUpdate()
      .then(async (update) => {
        if (!update) return;
        notifyUpdate({
          version: update.version,
          onInstall: async () => {
            try {
              await update.downloadAndInstall();
              await relaunch();
            } catch (err) {
              notify("Update install failed", {
                kind: "error",
                description: err instanceof Error ? err.message : String(err),
              });
            }
          },
          onSkip: () => {
            // No-op — toast just dismisses. Next launch will re-check.
          },
        });
      })
      .catch((e) => console.warn("auto-update check failed:", e));
    // Run once per session on first non-loading screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen === "loading"]);

  return (
    <div className="app-root">
      {/* macOS: invisible draggable strip behind the traffic-light dots so the
          window can be moved by grabbing anywhere along the top. On Windows /
          Linux the OS already provides chrome above us — the strip collapses
          to zero height via CSS. */}
      <div className="titlebar-drag" data-tauri-drag-region />
      {screen === "loading" && <LoadingStub />}
      {screen === "onboarding" && <Onboarding />}
      {screen === "main" && <Main />}
      {screen === "draft" && <Draft />}
      {screen === "settings" && <Settings />}
      {/* Single Toaster — bottom-left default; the update toast overrides
          its own position to bottom-right via lib/notify.ts. */}
      <Toaster />
    </div>
  );
}

function LoadingStub() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--fg-subtle)",
        fontSize: 13,
      }}
    >
      Loading…
    </div>
  );
}
