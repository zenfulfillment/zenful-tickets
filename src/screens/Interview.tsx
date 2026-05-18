import { useCallback, useEffect, useRef, useState } from "react";
import { Background } from "../components/Background";
import { Persona } from "../components/Persona";
import { Button } from "../components/ui/button";
import { Icon } from "../components/Icon";
import { ArrowRightIcon, MicIcon } from "../components/icons-animated";
import { VoiceWave } from "../components/primitives";
import {
  aiCancel,
  aiInterview,
  listenInterview,
  listenSpeech,
  referencePurgeSession,
} from "../lib/tauri";
import { startVoice, type VoiceSession } from "../lib/voice";
import { notify } from "../lib/notify";
import { useAppStore } from "../store";
import type { InterviewMessage, Provider } from "../types";
import { MODELS } from "../types";

const READY_RE = /\n?\s*\[\[READY\]\]\s*$/i;

const uuid = (): string =>
  // Tauri webview provides crypto.randomUUID on every supported platform.
  (globalThis.crypto as Crypto).randomUUID();

export function Interview() {
  const { interviewCtx, settings, closeInterview, promoteInterviewToDraft } =
    useAppStore();

  // Guard: if someone landed on this screen without a context (e.g. via a
  // stale state restore), bounce back to Main.
  useEffect(() => {
    if (!interviewCtx) {
      closeInterview();
    }
  }, [interviewCtx, closeInterview]);

  const ctx = interviewCtx;

  const [messages, setMessages] = useState<InterviewMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [aiThinksReady, setAiThinksReady] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
  const [generating, setGenerating] = useState(false);

  const requestIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  const voiceRef = useRef<VoiceSession | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const model = ctx ? MODELS.find((m) => m.provider === ctx.provider) ?? MODELS[0] : MODELS[0];

  const runTurn = useCallback(
    async (history: InterviewMessage[]) => {
      if (!ctx) return;
      cleanupRef.current?.();
      const requestId = uuid();
      requestIdRef.current = requestId;
      let unlistenFn: (() => void) | undefined;
      cleanupRef.current = () => {
        unlistenFn?.();
        void aiCancel(requestId);
      };

      setStreaming(true);
      setStreamingText("");
      setStreamError(null);

      const isCurrent = () => requestIdRef.current === requestId;

      unlistenFn = await listenInterview(requestId, {
        onChunk: (t) => {
          if (!isCurrent()) return;
          setStreamingText((s) => s + t);
        },
        onDone: (done) => {
          if (!isCurrent()) return;
          const raw = done.text;
          const ready = READY_RE.test(raw);
          const cleaned = raw.replace(READY_RE, "").trimEnd();
          setMessages((cur) => [
            ...cur,
            { role: "assistant", content: cleaned, ts: Date.now() },
          ]);
          setStreamingText("");
          setStreaming(false);
          if (ready) setAiThinksReady(true);
        },
        onError: (msg) => {
          if (!isCurrent()) return;
          setStreaming(false);
          setStreamError(msg);
        },
      });

      try {
        await aiInterview({
          request_id: requestId,
          provider: ctx.provider as Provider,
          mode: ctx.mode,
          messages: history,
          tone: settings.tone,
          custom_system_prompt: settings.systemPrompt || undefined,
          model: ctx.model || undefined,
          attachment_ids: ctx.attachments?.map((a) => a.id) ?? [],
          reference_ids: ctx.references?.map((r) => r.id) ?? [],
        });
      } catch (e) {
        if (!isCurrent()) return;
        setStreaming(false);
        setStreamError(e instanceof Error ? e.message : String(e));
      }
    },
    [ctx, settings.tone, settings.systemPrompt],
  );

  // First turn — seed transcript with the Main prompt and call the model.
  useEffect(() => {
    if (!ctx) return;
    const seed: InterviewMessage[] = [
      { role: "user", content: ctx.prompt, ts: Date.now() },
    ];
    setMessages(seed);
    void runTurn(seed);
    return () => cleanupRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-grow textarea + scroll thread to bottom whenever streaming
  // appends, or a new message lands.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText]);

  useEffect(() => {
    if (taRef.current) {
      taRef.current.style.height = "auto";
      taRef.current.style.height = Math.min(taRef.current.scrollHeight, 220) + "px";
    }
  }, [replyText]);

  // Voice wiring — same Scribe pattern as Main.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenSpeech({
      onPartial: (t) => setReplyText((cur) => cur + (cur && !cur.endsWith(" ") ? " " : "") + t),
      onFinal: (t) => setReplyText((cur) => cur + (cur && !cur.endsWith(" ") ? " " : "") + t),
      onError: (msg) => console.error("speech error:", msg),
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  // Reference session cleanup. We deliberately drop references when
  // promoting to Draft (the transcript already contains analyzed
  // context), so this is the last place that knows the session id.
  // Purge on unmount in BOTH paths (Back to Main and Generate→Draft).
  useEffect(() => {
    const sid = ctx?.referenceSessionId;
    if (!sid) return;
    return () => {
      void referencePurgeSession(sid).catch(() => {});
    };
  }, [ctx?.referenceSessionId]);

  const toggleVoice = async () => {
    if (voiceActive) {
      await voiceRef.current?.stop();
      voiceRef.current = null;
      setVoiceActive(false);
      return;
    }
    try {
      voiceRef.current = await startVoice({ deviceId: settings.audioInputDeviceId });
      setVoiceActive(true);
    } catch (e) {
      notify("Couldn't start voice input", {
        kind: "error",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleSendReply = () => {
    const trimmed = replyText.trim();
    if (!trimmed || streaming) return;
    const next: InterviewMessage[] = [
      ...messages,
      { role: "user", content: trimmed, ts: Date.now() },
    ];
    setMessages(next);
    setReplyText("");
    if (voiceActive) void toggleVoice();
    void runTurn(next);
  };

  const handleGenerate = () => {
    if (!ctx || generating) return;
    if (!messages.some((m) => m.role === "assistant")) return;
    setGenerating(true);
    // No disk write here — the transcript travels in-memory through Draft
    // and lands on disk after Jira publishes via ticket_save_history.
    const transcript = renderTranscriptForPrompt(messages);
    promoteInterviewToDraft(transcript);
  };

  if (!ctx) return null;

  const canGenerate = messages.some((m) => m.role === "assistant") && !generating;
  const canSend = replyText.trim().length > 0 && !streaming;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <Background />

      <div style={{ position: "absolute", inset: 0, zIndex: 1, display: "flex", flexDirection: "column" }}>
        {/* Top bar */}
        <div className="main-topbar" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Button variant="ghost" size="iconSm" onClick={() => closeInterview()} aria-label="Back to Main">
            <Icon.Chevron size={14} dir="left" />
          </Button>
          <div style={{ color: "var(--fg-muted)", font: "500 12px var(--font-text)" }}>
            Interview · {model.short}
          </div>
          <div style={{ width: 32 }} />
        </div>

        {/* Persona */}
        <div style={{ display: "flex", justifyContent: "center", padding: "16px 0 8px" }}>
          <Persona variant="halo" state={streaming ? "listening" : "idle"} className="size-[120px]" />
        </div>

        {/* Thread */}
        <div
          ref={threadRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "8px 80px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {messages.map((m, i) => (
            <Bubble key={i} role={m.role} text={m.content} />
          ))}
          {streaming && streamingText.length > 0 && (
            <Bubble role="assistant" text={streamingText.replace(READY_RE, "")} streaming />
          )}
          {streamError && (
            <div className="card" style={{ padding: 10, borderColor: "rgba(255,69,58,0.4)", background: "rgba(255,69,58,0.06)", color: "#ff453a" }}>
              {streamError}
            </div>
          )}
        </div>

        {/* Ready banner */}
        {aiThinksReady && (
          <div style={{ padding: "0 80px 8px" }}>
            <div className="card" style={{
              padding: "8px 12px",
              border: "0.5px solid var(--accent)",
              background: "var(--accent-soft)",
              color: "var(--accent)",
              font: "500 12.5px var(--font-text)",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
            }}>
              <span>I have what I need. Ready to draft the ticket?</span>
              <Button variant="primary" onClick={() => void handleGenerate()} disabled={!canGenerate}>
                Generate ticket
              </Button>
            </div>
          </div>
        )}

        {/* Reply composer */}
        <div style={{ padding: "12px 80px 20px" }}>
          <div style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 8,
            background: "var(--bg-card)",
            border: "0.5px solid var(--border-strong)",
            borderRadius: 14,
            padding: "6px 6px 6px 14px",
          }}>
            <textarea
              ref={taRef}
              rows={1}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendReply();
                }
              }}
              placeholder={streaming ? "Waiting for the agent…" : "Reply…"}
              disabled={streaming}
              style={{
                flex: 1, minHeight: 36, maxHeight: 220,
                background: "transparent", border: 0, outline: 0, resize: "none",
                font: "400 14px var(--font-text)", color: "var(--fg)", lineHeight: 1.5,
              }}
            />
            {settings.voiceEnabled && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void toggleVoice()}
                disabled={streaming}
                style={{
                  background: voiceActive ? "var(--accent-soft)" : "transparent",
                  color: voiceActive ? "var(--accent)" : "var(--fg-muted)",
                }}
              >
                {voiceActive ? <VoiceWave active /> : <MicIcon size={16} />}
              </Button>
            )}
            <Button
              variant="primary"
              size="icon"
              onClick={handleSendReply}
              disabled={!canSend}
              style={{
                background: canSend ? "var(--accent)" : "var(--bg-active)",
                color: canSend ? "white" : "var(--fg-subtle)",
              }}
            >
              <ArrowRightIcon size={16} />
            </Button>
            <Button
              variant={aiThinksReady ? "primary" : "default"}
              onClick={() => void handleGenerate()}
              disabled={!canGenerate}
            >
              Generate ticket
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({ role, text, streaming }: { role: "user" | "assistant"; text: string; streaming?: boolean }) {
  const isUser = role === "user";
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
      <div
        style={{
          maxWidth: 620,
          padding: "10px 14px",
          borderRadius: 12,
          background: isUser ? "var(--accent-soft)" : "var(--bg-card)",
          border: `0.5px solid ${isUser ? "color-mix(in oklab, var(--accent) 22%, transparent)" : "var(--border-strong)"}`,
          color: "var(--fg)",
          font: "400 14px var(--font-text)",
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          opacity: streaming ? 0.85 : 1,
        }}
      >
        {text}
      </div>
    </div>
  );
}

function renderTranscriptForPrompt(messages: InterviewMessage[]): string {
  let out = "";
  for (const m of messages) {
    const label = m.role === "user" ? "USER" : "ASSISTANT";
    out += `## ${label}\n\n${m.content.trimEnd()}\n\n`;
  }
  return out;
}
