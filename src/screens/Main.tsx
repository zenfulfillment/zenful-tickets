import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Background } from "../components/Background";
import { Icon } from "../components/Icon";
import { AttachmentMenu } from "../components/AttachmentMenu";
import { AttachmentChips } from "../components/AttachmentChips";
import { useDraftAttachments } from "../lib/use-draft-attachments";
import {
  ArrowRightIcon,
  MicIcon,
  SettingsIcon,
} from "../components/icons-animated";
import { Persona } from "../components/Persona";
import { ProviderIcon } from "../components/ProviderIcon";
import { VoiceWave } from "../components/primitives";
import { aiDetectClis, listenSpeech } from "../lib/tauri";
import { notify } from "../lib/notify";
import { playUi } from "../lib/ui-sounds";
import { isProviderUsable } from "../lib/providers";
import { startVoice, type VoiceSession } from "../lib/voice";
import { useAppStore } from "../store";
import { Button } from "../components/ui/button";
import type { DetectResult } from "../types";
import {
  defaultModelFor,
  MODELS,
  MODEL_VARIANTS,
  type Provider,
} from "../types";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorTrigger,
} from "../components/ai-elements/model-selector";

const HEADLINES = [
  "What are we shipping today?",
  "Let's turn ideas into tickets.",
  "Ready to define the next story?",
  "Time to shape the next feature.",
  "What problem are we solving today?",
  "Plan it. Write it. Ship it.",
  "What does success look like?",
  "Spec it before you code it.",
  "Make it clear. Avoid ambiguity.",
  "From idea to impact — start here.",
];

export function Main() {
  const { settings, secrets, openDraft, setScreen, setSettings } = useAppStore();
  const [headlineIdx, setHeadlineIdx] = useState(0);
  const [text, setText] = useState("");
  const [provider, setProvider] = useState<Provider>(settings.defaultProvider);
  // Per-provider model id, hydrated from persisted settings. When the user
  // switches providers we look up the saved pick for THAT provider; if
  // there isn't one, we fall back to the provider's catalog default. This
  // way every provider remembers its own last-used model independently.
  const [modelId, setModelId] = useState<string>(
    settings.selectedModelByProvider?.[settings.defaultProvider] ??
      defaultModelFor(settings.defaultProvider),
  );
  const [mode, setMode] = useState<"PO" | "DEV">(settings.defaultMode);
  const [voiceActive, setVoiceActive] = useState(false);
  const [focused, setFocused] = useState(false);
  const [mouse, setMouse] = useState({ x: -200, y: -200, inside: false });

  const taRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const voiceRef = useRef<VoiceSession | null>(null);
  const voiceRafRef = useRef<number | null>(null);

  // Per-draft attachment state. The hook owns its session id, registers
  // files with the Rust backend via the new attachment_* commands, and
  // returns the canonical AttachmentRef[] for chip rendering. On submit we
  // hand the session id + refs over to Draft.tsx — that screen owns
  // cleanup (purging on success or cancel) since the cached bytes need to
  // outlive Main.tsx for the AI / Jira pipeline to consume them.
  const {
    sessionId: attachmentsSessionId,
    attachments,
    addFiles,
    addPaths,
    remove: removeAttachment,
  } = useDraftAttachments();
  const [dragOver, setDragOver] = useState(false);

  // CLI detection — needed alongside `secrets` to know whether each provider
  // is actually usable (enabled + configured). Refreshed on mount; Settings
  // re-detects when its AI section opens.
  const [detected, setDetected] = useState<DetectResult | null>(null);
  useEffect(() => {
    void aiDetectClis().then(setDetected).catch(() => setDetected(null));
  }, []);

  // Warn the user when they've attached an image and the active provider
  // doesn't support vision. Per current product call: only Claude is treated
  // as image-capable (Gemini also has vision but that's a future polish).
  // Fired exactly once per provider/attachment-set transition so re-entering
  // the screen doesn't keep beeping the same warning at the user.
  const warnedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const hasImage = attachments.some((a) => a.kind === "image");
    if (!hasImage) {
      warnedKeyRef.current = null;
      return;
    }
    if (provider === "claude_cli") {
      warnedKeyRef.current = null;
      return;
    }
    const imageIds = attachments
      .filter((a) => a.kind === "image")
      .map((a) => a.id)
      .sort()
      .join(",");
    const key = `${provider}|${imageIds}`;
    if (warnedKeyRef.current === key) return;
    warnedKeyRef.current = key;

    const providerLabel =
      provider === "codex_cli" ? "Codex" : provider === "gemini" ? "Gemini" : "this model";
    notify(`${providerLabel} can't see attached images`, {
      kind: "warning",
      description: `Switch to Claude if you want the model to read your screenshots — otherwise only the document attachments will be passed through.`,
    });
  }, [provider, attachments]);

  // Drag-drop on the entire window. Tauri exposes file paths (not blob URLs),
  // so we route through `addPaths` which calls attachment_register_path on
  // the Rust side. We track a `dragOver` flag so the input glow can intensify
  // while a drag is in progress — the highlight reads as a clear target zone.
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    let unlisten: (() => void) | undefined;
    void win
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragOver(true);
        } else if (event.payload.type === "leave") {
          setDragOver(false);
        } else if (event.payload.type === "drop") {
          setDragOver(false);
          void addPaths(event.payload.paths);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [addPaths]);

  // Paste handler — captures clipboard image blobs (the "user copied a
  // screenshot" path that motivated this feature). File-list pastes (Cmd+C
  // on a file in Finder) don't surface paths via the webview clipboard API,
  // so drag-drop or the Browse button covers those.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) {
            // Browser-pasted images often arrive without a useful filename
            // ("image.png" at best). Stamp them with a timestamp so the user
            // can tell sequential pastes apart in the chip row.
            const named =
              f.name && f.name !== "image.png"
                ? f
                : new File([f], `pasted-${Date.now()}.${f.type.split("/")[1] || "png"}`, {
                    type: f.type,
                  });
            files.push(named);
          }
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  // Typing-driven orb level — stored in a ref so the per-frame decay loop
  // never re-renders the React tree. Keystrokes bump the ref; the rAF tick
  // decays it; the value flows straight into orbLevelRef so the shader
  // smooths it without any React in the path.
  const typeLevelRef = useRef(0);
  const lastLenRef = useRef(0);
  const lastTickRef = useRef(performance.now());

  useEffect(() => {
    const delta = text.length - lastLenRef.current;
    lastLenRef.current = text.length;
    if (delta !== 0) {
      const bump = Math.min(0.22, 0.08 + Math.abs(delta) * 0.025);
      typeLevelRef.current = Math.min(0.8, typeLevelRef.current + bump);
    }
  }, [text]);

  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - lastTickRef.current) / 1000);
      lastTickRef.current = now;
      typeLevelRef.current =
        typeLevelRef.current > 0.001
          ? typeLevelRef.current * Math.pow(0.5, dt / 1.3)
          : 0;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const t = window.setInterval(
      () => setHeadlineIdx((i) => (i + 1) % HEADLINES.length),
      5000,
    );
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (taRef.current) {
      taRef.current.style.height = "auto";
      taRef.current.style.height = Math.min(taRef.current.scrollHeight, 220) + "px";
    }
  }, [text]);

  // Voice → transcript wiring
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenSpeech({
      onPartial: (t) => {
        setText((cur) => stripPendingAndAppend(cur, t, false));
      },
      onFinal: (t) => {
        setText((cur) => stripPendingAndAppend(cur, t, true));
      },
      onError: (msg) => console.error("speech error:", msg),
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  // Voice level polling — drives orb reactivity AND silence-based auto-submit.
  // When settings.autoSubmit is on, after `silenceMs` of below-threshold
  // amplitude AND non-empty text, we submit and stop the mic.
  const lastLoudRef = useRef<number>(performance.now());
  useEffect(() => {
    if (!voiceActive) return;
    lastLoudRef.current = performance.now();
    const SILENCE_THRESHOLD = 0.04;
    const tick = () => {
      const lvl = voiceRef.current?.level.current ?? 0;
      // Push live mic amplitude straight into the orb (ref-based, no setState).
      orbLevelRef.current = Math.min(1, lvl);
      const now = performance.now();
      if (lvl > SILENCE_THRESHOLD) lastLoudRef.current = now;
      if (
        settings.autoSubmit &&
        text.trim().length > 0 &&
        now - lastLoudRef.current > settings.silenceMs
      ) {
        // Stop the mic and submit on the next tick to avoid any race inside the cb.
        queueMicrotask(() => handleSubmit());
        return;
      }
      voiceRafRef.current = requestAnimationFrame(tick);
    };
    voiceRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (voiceRafRef.current) cancelAnimationFrame(voiceRafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceActive, settings.autoSubmit, settings.silenceMs]);

  const toggleVoice = async () => {
    if (voiceActive) {
      await voiceRef.current?.stop();
      voiceRef.current = null;
      setVoiceActive(false);
    } else {
      try {
        voiceRef.current = await startVoice({
          deviceId: settings.audioInputDeviceId,
        });
        setVoiceActive(true);
      } catch (e) {
        // Surface the Rust-side error (e.g. "voice disabled: no
        // ELEVENLABS_API_KEY in build" if the env var was missing at build).
        console.error("voice start failed:", e);
        notify("Couldn't start voice input", {
          kind: "error",
          description: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };

  const handleSubmit = () => {
    // Strip the in-flight partial-transcript marker before shipping —
    // the marker is a state-internal bookkeeping aid and never user-visible.
    const trimmed = stripPartialMarker(text).trim();
    if (!trimmed && attachments.length === 0) return;
    if (voiceActive) void toggleVoice();
    // Hand attachment ownership off to Draft. We deliberately DON'T call
    // `clearAttachments()` here — that would purge the on-disk session and
    // the AI pipeline wouldn't be able to resolve the ids. Draft.tsx is
    // responsible for purging once the work is complete (issue created or
    // user cancels). The hook's unmount handler is the safety net.
    openDraft({
      prompt: trimmed,
      provider,
      mode,
      model: modelId,
      attachments: attachments.length > 0 ? attachments : undefined,
      attachmentSessionId: attachments.length > 0 ? attachmentsSessionId : undefined,
    });
    setText("");
  };

  const toggleMute = () => {
    const next = !settings.sounds;
    // The Button auto-plays click on press; we only need to flip the setting.
    // When un-muting, the click already feels right; when muting, the click
    // fires before the setting change so the user hears the last beep.
    void setSettings({ sounds: next });
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && settings.submitOnEnter) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    setMouse({ x: e.clientX - r.left, y: e.clientY - r.top, inside: true });
  };
  const onLeave = () => setMouse((m) => ({ ...m, inside: false }));

  // Pointer normalized to [-1..1] inside the orb's own bounding box. Stored
  // in a ref (NOT React state) so mouse-move events don't trigger any
  // re-renders. The shader inside AbstractBall reads this ref every frame
  // and pumps it straight into uniforms — orb reacts at GPU rate, no JS
  // event-loop bottleneck, no transition-driven lag.
  const orbRef = useRef<HTMLDivElement>(null);
  const orbPointerRef = useRef<{ x: number; y: number } | null>(null);
  const onOrbMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = orbRef.current?.getBoundingClientRect();
    if (!r) return;
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = ((e.clientY - r.top) / r.height) * 2 - 1;
    orbPointerRef.current = { x, y };
  };
  const onOrbLeave = () => {
    orbPointerRef.current = null;
  };

  // Live amplitude (0..1) the orb shader reads each frame. Updated by:
  //   - voice tick when the mic is on (already running)
  //   - typeLevel / focused effect below for non-voice input
  // Same ref-based pattern as orbPointerRef so high-frequency mic amplitude
  // changes don't trigger React re-renders.
  const orbLevelRef = useRef(0);

  // Voice / focus → the orb's "listening" state. Both mic input and a
  // focused composer mean the user is talking to the orb.
  const personaState =
    voiceActive ? "listening"
    : focused ? "listening"
    : "idle";

  // Per-frame: when voice isn't on, fold typing energy + focus floor into the
  // shader's level ref. Lives inside the same rAF that decays typeLevelRef
  // so we don't add a second loop.
  useEffect(() => {
    if (voiceActive) return; // voice tick takes over
    let raf = 0;
    const tick = () => {
      const focusFloor = focused ? 0.30 : 0;
      orbLevelRef.current = Math.max(typeLevelRef.current, focusFloor);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [voiceActive, focused]);
  const hoverVisible = mouse.inside && !focused;
  const focusVisible = focused;
  const model = MODELS.find((m) => m.provider === provider) ?? MODELS[0];
  const availableModels = MODELS.filter((m) =>
    isProviderUsable(m.provider, settings, secrets ?? null, detected),
  );
  const variant =
    MODEL_VARIANTS[provider]?.find((v) => v.id === modelId) ??
    MODEL_VARIANTS[provider]?.[0];

  // Switching providers picks up the saved model for the new provider, or
  // falls back to that provider's default. We also persist the new pick.
  const handlePickModel = (nextProvider: Provider, nextModelId: string) => {
    setProvider(nextProvider);
    setModelId(nextModelId);
    void setSettings({
      defaultProvider: nextProvider,
      selectedModelByProvider: {
        ...settings.selectedModelByProvider,
        [nextProvider]: nextModelId,
      },
    });
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <Background />

      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 80px",
        }}
      >
        {/* Top bar — sits in the title-bar safe zone. Badge lives to the right
            of the macOS traffic-light cluster; gear pinned to the right edge.
            Both vertically centred with the OS chrome so the row reads as one
            continuous title bar. */}
        <div className="main-topbar">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: "var(--fg-muted)",
              font: "500 12px var(--font-text)",
            }}
          >
            <div style={{ width: 14, height: 14, borderRadius: 4, background: "linear-gradient(135deg, #0052cc, #2684ff)" }} />
            <span>{secrets?.jira_site ?? "Zenful Tickets"}</span>
          </div>

          <div style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <Button
              variant="ghost"
              size="iconSm"
              onClick={toggleMute}
              title={settings.sounds ? "Mute sounds" : "Unmute sounds"}
              aria-label={settings.sounds ? "Mute sounds" : "Unmute sounds"}
              aria-pressed={!settings.sounds}
              style={{ color: settings.sounds ? "var(--fg-muted)" : "var(--fg-subtle)" }}
            >
              {settings.sounds ? <Icon.Vol size={16} /> : <Icon.VolMute size={16} />}
            </Button>
            <Button
              variant="ghost"
              size="iconSm"
              onClick={() => setScreen("settings")}
              title="Settings"
              aria-label="Open settings"
              className="gear-btn"
              style={{ color: "var(--fg-muted)" }}
            >
              <SettingsIcon size={16} />
            </Button>
          </div>
        </div>

        {/* Orb */}
        <div
          ref={orbRef}
          onMouseMove={onOrbMove}
          onMouseLeave={onOrbLeave}
          style={{ marginBottom: 28, width: 240, height: 240 }}
        >
          <Persona
            variant="halo"
            state={personaState}
            levelRef={orbLevelRef}
            pointerRef={orbPointerRef}
            className="size-[240px]"
          />
        </div>

        {/* Rotating headline */}
        <div style={{ position: "relative", width: "100%", maxWidth: 720, textAlign: "center", marginBottom: 28, height: 48 }}>
          {HEADLINES.map((h, i) => (
            <h1
              key={i}
              style={{
                position: "absolute",
                inset: 0,
                margin: 0,
                fontFamily: "var(--font-display)",
                color: "var(--fg)",
                pointerEvents: "none",
                fontSize: 32,
                fontWeight: 600,
                letterSpacing: "-0.025em",
                opacity: i === headlineIdx ? 1 : 0,
                transform: i === headlineIdx ? "translateY(0)" : "translateY(8px)",
                transition: "opacity 600ms ease, transform 600ms cubic-bezier(.2,.7,.2,1)",
              }}
            >
              {h}
            </h1>
          ))}
        </div>

        {/* Input */}
        <div
          ref={wrapRef}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
          className={`glow-input-wrap ${hoverVisible ? "is-hover" : ""} ${focusVisible ? "is-focus" : ""}`}
          style={{
            width: "100%",
            maxWidth: 720,
            position: "relative",
            borderRadius: 22,
            ["--mx" as string]: `${mouse.x}px`,
            ["--my" as string]: `${mouse.y}px`,
          }}
        >
          <div className="glow-hover" aria-hidden />
          <div className="glow-halo" aria-hidden />
          <div
            style={{
              position: "relative",
              background: "var(--bg-card)",
              backdropFilter: "blur(40px) saturate(180%)",
              WebkitBackdropFilter: "blur(40px) saturate(180%)",
              border:
                dragOver
                  ? "0.5px dashed var(--accent)"
                  : focused
                    ? "0.5px solid var(--accent)"
                    : "0.5px solid var(--border-strong)",
              borderRadius: 22,
              padding: 4,
              boxShadow: dragOver
                ? "0 12px 40px rgba(10,132,255,0.28), 0 0 0 2px var(--accent-soft) inset"
                : focused
                  ? "0 12px 40px rgba(10,132,255,0.18), 0 0 0 1px var(--accent-soft) inset"
                  : "0 8px 30px rgba(0,0,0,0.10), 0 1px 0 rgba(255,255,255,0.04) inset",
              transition: "box-shadow 220ms ease, border-color 220ms ease",
            }}
          >
            {/* Attachment chip row — only renders when there's at least
                one attachment, so the composer height stays unchanged for
                the common no-attachment case. */}
            <AttachmentChips attachments={attachments} onRemove={(id) => void removeAttachment(id)} />
            <div style={{ padding: attachments.length > 0 ? "8px 18px 6px" : "20px 18px 6px" }}>
              <textarea
                ref={taRef}
                rows={1}
                // Strip the bookkeeping marker for display so the user never
                // sees " [[partial]] " literally while a Scribe partial is
                // streaming. The marker stays in state for partial-merge
                // tracking.
                value={stripPartialMarker(text)}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKey}
                onPaste={handlePaste}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder={mode === "PO" ? "Describe the outcome you want…" : "Describe what needs to be built…"}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: 0,
                  outline: 0,
                  resize: "none",
                  font: "400 16px var(--font-text)",
                  color: "var(--fg)",
                  lineHeight: 1.5,
                  minHeight: 56,
                  maxHeight: 240,
                  letterSpacing: "-0.005em",
                }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <AttachmentMenu
                  onFiles={(files) => void addFiles(files)}
                  count={attachments.length}
                  maxCount={8}
                />
                <div className="segmented segmented-sm">
                  <button type="button" className={mode === "PO" ? "active" : ""} onClick={() => { if (mode !== "PO") playUi("toggle"); setMode("PO"); }}>PO</button>
                  <button type="button" className={mode === "DEV" ? "active" : ""} onClick={() => { if (mode !== "DEV") playUi("toggle"); setMode("DEV"); }}>DEV</button>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                {/* Model picker — shadcn/ai-elements ModelSelector wrapped in
                    a Dialog + cmdk overlay. The TRIGGER deliberately keeps
                    the original button styling exactly so the composer
                    chrome stays unchanged; only the dropdown becomes a
                    full searchable command palette grouped by vendor. */}
                <PromptModelPicker
                  provider={provider}
                  modelId={modelId}
                  onPick={handlePickModel}
                  trigger={
                    <button
                      type="button"
                      // The trigger is a plain <button> rather than our
                      // <Button> component (so it can carry the bespoke
                      // composer-chip styling without inheriting `.btn`).
                      // That means it doesn't auto-play the UI click
                      // sound, so we wire it manually here. Base UI's
                      // DialogTrigger merges its own onClick (opens the
                      // dialog) with ours, so both fire.
                      onClick={() => playUi("click")}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 6,
                        height: 28, padding: "0 10px",
                        background: "transparent",
                        border: "0.5px solid transparent",
                        borderRadius: 8,
                        font: "500 12.5px var(--font-text)",
                        color: "var(--fg-muted)",
                        cursor: "pointer",
                      }}
                    >
                      {/* SVG icon — geometrically centred in its viewBox,
                          so flex centering on the parent works the way
                          you'd expect (no font-metric guesswork). */}
                      <ProviderIcon provider={provider} size={14} color={model.color} />
                      {model.short}
                      {variant && (
                        <span style={{
                          color: "var(--fg-subtle)",
                          fontSize: 11,
                          fontWeight: 400,
                          marginLeft: 1,
                        }}>· {variant.short}</span>
                      )}
                      <Icon.Chevron size={10} />
                    </button>
                  }
                  availableProviders={availableModels.length > 0
                    ? availableModels.map((m) => m.provider)
                    : []}
                />

                {settings.voiceEnabled && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void toggleVoice()}
                    title="Voice input"
                    style={{
                      background: voiceActive ? "var(--accent-soft)" : "transparent",
                      color: voiceActive ? "var(--accent)" : "var(--fg-muted)",
                    }}
                  >
                    {voiceActive ? <VoiceWave active /> : <MicIcon size={16} />}
                  </Button>
                )}

                <Button
                  variant={text.trim() || attachments.length > 0 ? "primary" : "default"}
                  size="icon"
                  onClick={handleSubmit}
                  disabled={!text.trim() && attachments.length === 0}
                  style={{
                    background:
                      text.trim() || attachments.length > 0 ? "var(--accent)" : "var(--bg-active)",
                    color: text.trim() || attachments.length > 0 ? "white" : "var(--fg-subtle)",
                    boxShadow:
                      text.trim() || attachments.length > 0
                        ? "0 1px 3px rgba(10,132,255,0.3)"
                        : "none",
                  }}
                >
                  <ArrowRightIcon size={16} />
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            font: "400 11.5px var(--font-text)",
            color: "var(--fg-subtle)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <kbd>⏎</kbd> to draft <span style={{ opacity: 0.5 }}>·</span> <kbd>⇧⏎</kbd> for new line
        </div>
      </div>
    </div>
  );
}

const PARTIAL_MARKER = " [[partial]] ";
const PARTIAL_LEADING_RE = new RegExp(" \\[\\[partial\\]\\] ", "g");

// Strips the in-flight partial-transcript marker for display and submit.
// The marker uses NBSPs so it can never collide with user-typed text;
// we collapse it back to a single ASCII space.
export function stripPartialMarker(s: string): string {
  return s.replace(PARTIAL_LEADING_RE, " ");
}

/**
 * Voice transcript merge rule.
 *
 * Scribe v2 emits CUMULATIVE partials — each `partial_transcript` carries
 * the full in-flight utterance so far, not a delta. So every new partial
 * must REPLACE the in-flight text, not append to it.
 *
 * Layout: `<committed text><MARKER><in-flight partial>`. The marker sits
 * BETWEEN committed and partial; split-on-marker yields the committed
 * prefix and discards the previous partial on each new event.
 */
function stripPendingAndAppend(current: string, incoming: string, final: boolean): string {
  const idx = current.indexOf(PARTIAL_MARKER);
  const committed = idx >= 0 ? current.slice(0, idx) : current;
  const inc = incoming.trim();
  if (!inc) return final ? committed : current;
  const sep = committed.length && !/\s$/.test(committed) ? " " : "";
  if (final) return committed + sep + inc;
  // Marker BEFORE the partial → next partial replaces everything after it.
  // Drop the leading NBSP when committed is empty so the textarea does not
  // render a phantom indent.
  return committed.length ? committed + PARTIAL_MARKER + inc : PARTIAL_MARKER.trimStart() + inc;
}

/**
 * Searchable model picker — wraps the existing trigger styling and opens
 * a shadcn/ai-elements `ModelSelector` dialog (Dialog + cmdk) on click.
 *
 * Layout of the dialog:
 *   - Search input (filters across vendor + model name + id + description)
 *   - One group per vendor (Anthropic / OpenAI / Google), each containing
 *     all models for that vendor's provider.
 *   - Models whose provider isn't usable (CLI not detected, API key
 *     missing, etc) render disabled with a small "(not configured)" tag
 *     so the user still sees the option but can't pick it.
 *
 * Selecting an item commits BOTH the provider and the model id back via
 * `onPick`, which the parent uses to update local state AND persist the
 * per-provider model choice in `selectedModelByProvider`.
 */
function PromptModelPicker({
  provider,
  modelId,
  trigger,
  availableProviders,
  onPick,
}: {
  provider: Provider;
  modelId: string;
  trigger: React.ReactElement;
  availableProviders: Provider[];
  onPick: (provider: Provider, modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const isUsable = (p: Provider) => availableProviders.includes(p);
  const groups: { provider: Provider; vendor: string; vendorTag: string; color: string; char: string }[] = [
    { provider: "claude_cli", vendor: "Anthropic — Claude CLI", vendorTag: "Anthropic", color: "#d97757", char: "✻" },
    { provider: "codex_cli",  vendor: "OpenAI — Codex CLI",      vendorTag: "OpenAI",    color: "#10a37f", char: "◓" },
    { provider: "gemini",     vendor: "Google — Gemini API",     vendorTag: "Google",    color: "#4285f4", char: "◆" },
  ];
  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger render={trigger} />
      <ModelSelectorContent
        title="Select a model"
        // .model-picker-overlay scopes a CSS bundle in styles/index.css
        // that reskins cmdk's data-slots onto our app's design tokens
        // (--bg-elevated, --border, --accent-soft, etc) — see that file
        // for the full set of overrides.
        className="model-picker-overlay !w-[560px] !max-w-[calc(100vw-48px)]"
      >
        <ModelSelectorInput placeholder="Search providers, models, or keywords…" />
        <ModelSelectorList>
          <ModelSelectorEmpty>No matching models.</ModelSelectorEmpty>
          {groups.map((g) => {
            const variants = MODEL_VARIANTS[g.provider] ?? [];
            const usable = isUsable(g.provider);
            return (
              <ModelSelectorGroup key={g.provider} heading={g.vendor}>
                {variants.map((v) => {
                  const selected = g.provider === provider && v.id === modelId;
                  return (
                    <ModelSelectorItem
                      key={`${g.provider}-${v.id}`}
                      value={`${g.vendorTag} ${v.name} ${v.id} ${v.description}`}
                      disabled={!usable}
                      onSelect={() => {
                        if (!usable) return;
                        // Use the same `toggle` sound the Settings
                        // sidebar plays when switching tabs / segmented
                        // selectors — model selection is the same kind
                        // of "switch the active option" interaction, so
                        // the audio feedback should match.
                        playUi("toggle");
                        onPick(g.provider, v.id);
                        setOpen(false);
                      }}
                    >
                      <span style={{
                        width: 28, height: 28, flexShrink: 0,
                        borderRadius: 8,
                        background: usable ? `${g.color}1c` : "var(--bg-active)",
                        color: usable ? g.color : "var(--fg-subtle)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}>
                        <ProviderIcon provider={g.provider} size={16} />
                      </span>
                      <div style={{
                        display: "flex",
                        flexDirection: "column",
                        flex: 1,
                        minWidth: 0,
                      }}>
                        <span style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          font: "500 13.5px var(--font-text)",
                          color: usable ? "var(--fg)" : "var(--fg-muted)",
                          letterSpacing: "-0.005em",
                        }}>
                          <span style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}>
                            {v.name}
                          </span>
                          {selected && (
                            <span style={{
                              flexShrink: 0,
                              font: "600 10px var(--font-text)",
                              color: "var(--accent)",
                              padding: "2px 7px",
                              background: "var(--accent-soft)",
                              border: "0.5px solid color-mix(in oklab, var(--accent) 20%, transparent)",
                              borderRadius: 999,
                              textTransform: "uppercase",
                              letterSpacing: "0.06em",
                            }}>
                              Current
                            </span>
                          )}
                          {!usable && (
                            <span style={{
                              flexShrink: 0,
                              font: "600 10px var(--font-text)",
                              color: "var(--fg-subtle)",
                              padding: "2px 7px",
                              border: "0.5px dashed var(--border-strong)",
                              borderRadius: 999,
                              textTransform: "uppercase",
                              letterSpacing: "0.06em",
                            }}>
                              Not configured
                            </span>
                          )}
                        </span>
                        <span style={{
                          font: "400 12px var(--font-text)",
                          color: "var(--fg-subtle)",
                          marginTop: 2,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          letterSpacing: "-0.005em",
                        }}>
                          {v.description}
                        </span>
                      </div>
                      <span style={{
                        flexShrink: 0,
                        font: "400 10.5px var(--font-mono)",
                        color: "var(--fg-subtle)",
                        background: "var(--bg-active)",
                        padding: "2px 7px",
                        borderRadius: 5,
                        letterSpacing: "0",
                      }}>
                        {v.id}
                      </span>
                    </ModelSelectorItem>
                  );
                })}
              </ModelSelectorGroup>
            );
          })}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
