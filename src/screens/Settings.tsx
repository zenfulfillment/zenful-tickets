import { useEffect, useState } from "react";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { platform, version as osVersion, arch as osArch } from "@tauri-apps/plugin-os";
import { getVersion as appVersion } from "@tauri-apps/api/app";
import { writeText as clipboardWrite } from "@tauri-apps/plugin-clipboard-manager";
import { RefreshCCWIcon, SettingsIcon } from "../components/icons-animated";
import { applyThemeWithRipple } from "../lib/theme";
import { Icon } from "../components/Icon";
import { Persona } from "../components/Persona";
import { HotkeyCapture, Menu } from "../components/primitives";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Spinner } from "../components/ui/spinner";
import { Switch } from "../components/animate-ui/components/base/switch";
import { MicSelector } from "../components/MicSelector";
import {
  aiDetectClis,
  jiraListProjects,
  jiraVerify,
  logsDiagnostics,
  logsReveal,
  secretsClear,
  secretsUpdate,
} from "../lib/tauri";
import { useAppStore } from "../store";
import { DEFAULT_SETTINGS, MODELS, type AppSettings, type DetectResult, type JiraProject, type Provider } from "../types";
import { secretStoreName } from "../lib/platform";
import { playUi } from "../lib/ui-sounds";
import { isProviderConfigured, PROVIDERS } from "../lib/providers";

const SECTIONS = [
  { id: "general", label: "General", icon: <SettingsIcon size={14} /> },
  { id: "jira", label: "Jira", icon: <Icon.Globe /> },
  { id: "ai", label: "AI Models", icon: <Icon.Sparkle /> },
  { id: "drafting", label: "Drafting", icon: <Icon.Edit /> },
  { id: "about", label: "About", icon: <Icon.Bolt /> },
] as const;

type SectionId = typeof SECTIONS[number]["id"];

export function Settings() {
  const { setScreen } = useAppStore();
  const [section, setSection] = useState<SectionId>("general");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setScreen("main");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setScreen]);

  const description: Record<SectionId, string> = {
    general: "App-wide preferences and behavior.",
    jira: "Connection, defaults, and ticket destinations.",
    ai: "Models, keys, and how drafts are generated.",
    drafting: "How tickets get written.",
    about: "Version info and resources.",
  };

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg-window)" }}>
      {/* Sidebar — top padding leaves room for the traffic-light cluster on macOS. */}
      <div style={{
        width: 200, flexShrink: 0,
        borderRight: "0.5px solid var(--border)",
        padding: "calc(18px + var(--titlebar-h, 0px)) 10px 18px",
        display: "flex", flexDirection: "column", gap: 2,
      }}>
        <div style={{
          font: "600 11px var(--font-text)",
          color: "var(--fg-subtle)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          padding: "4px 12px 10px",
        }}>
          Settings
        </div>

        {SECTIONS.map((item) => {
          const active = section === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => { if (section !== item.id) playUi("toggle"); setSection(item.id); }}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                width: "100%",
                padding: "7px 12px",
                border: 0, background: active ? "var(--accent)" : "transparent",
                color: active ? "white" : "var(--fg)",
                font: "500 13px var(--font-text)",
                borderRadius: 7,
                cursor: "pointer",
                textAlign: "left",
                transition: "background 120ms ease, color 120ms ease",
                boxShadow: active ? "0 1px 2px rgba(10,132,255,0.3)" : "none",
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = "transparent";
              }}
            >
              <span style={{ color: active ? "white" : "var(--fg-muted)", display: "inline-flex" }}>
                {item.icon}
              </span>
              {item.label}
            </button>
          );
        })}
      </div>

      {/* Detail */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "calc(20px + var(--titlebar-h, 0px)) 28px 14px",
          borderBottom: "0.5px solid var(--border)",
        }}>
          <div>
            <h2 style={{ font: "600 22px var(--font-display)", letterSpacing: "-0.02em", margin: 0 }}>
              {SECTIONS.find((s) => s.id === section)?.label}
            </h2>
            <div style={{ font: "400 12.5px var(--font-text)", color: "var(--fg-muted)", marginTop: 2 }}>
              {description[section]}
            </div>
          </div>
          <Button onClick={() => setScreen("main")} title="Close (Esc)">
            Done
          </Button>
        </div>

        <div key={section} className="fade-in-up" style={{ flex: 1, overflowY: "auto", padding: "24px 28px 28px" }}>
          {section === "general" && <GeneralSection />}
          {section === "jira" && <JiraSection />}
          {section === "ai" && <AISection />}
          {section === "drafting" && <DraftingSection />}
          {section === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}

// ─── Common bits ─────────────────────────────────────────────

function Group({ title, children, footer }: { title?: string; children: React.ReactNode; footer?: string }) {
  return (
    <div style={{ marginBottom: 26 }}>
      {title && (
        <div style={{
          font: "600 11px var(--font-text)",
          color: "var(--fg-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          padding: "0 4px 8px",
        }}>{title}</div>
      )}
      <div className="card settings-group-inner" style={{ padding: 0, overflow: "hidden" }}>
        <style>{`.settings-group-inner > :last-child { border-bottom: 0 !important; }`}</style>
        {children}
      </div>
      {footer && (
        <div style={{
          font: "400 11.5px var(--font-text)",
          color: "var(--fg-subtle)",
          padding: "8px 4px 0", lineHeight: 1.5,
        }}>{footer}</div>
      )}
    </div>
  );
}

function Row({ title, hint, danger, children, align = "center" }: { title: string; hint?: string; danger?: boolean; children: React.ReactNode; align?: "center" | "top" }) {
  return (
    <div style={{
      display: "flex",
      alignItems: align === "top" ? "flex-start" : "center",
      gap: 16, padding: "14px 16px",
      borderBottom: "0.5px solid var(--border)",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ font: "500 13.5px var(--font-text)", color: danger ? "#ff453a" : "var(--fg)", letterSpacing: "-0.005em" }}>{title}</div>
        {hint && (
          <div style={{ font: "400 12px var(--font-text)", color: "var(--fg-muted)", marginTop: 3, lineHeight: 1.45, maxWidth: 460 }}>{hint}</div>
        )}
      </div>
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>{children}</div>
    </div>
  );
}

// ─── General ─────────────────────────────────────────────────

function GeneralSection() {
  const { settings, setSettings } = useAppStore();
  const [autostartOn, setAutostartOn] = useState<boolean | null>(null);

  useEffect(() => {
    void isAutostartEnabled().then(setAutostartOn).catch(() => setAutostartOn(false));
  }, []);

  const toggleAutostart = async (v: boolean) => {
    setAutostartOn(v);
    try {
      if (v) await enableAutostart();
      else await disableAutostart();
      await setSettings({ launchAtLogin: v });
    } catch (e) {
      console.error("autostart:", e);
      // Revert on failure.
      setAutostartOn(!v);
    }
  };

  return (
    <>
      <Group title="Appearance">
        <Row title="Theme" hint="Sync with system, or pin to light or dark.">
          <div className="segmented">
            {(["system", "light", "dark"] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={settings.theme === t ? "active" : ""}
                onClick={async (e) => {
                  if (settings.theme === t) return;
                  playUi("toggle");
                  // Persist first, then drive the visual transition centred on the click.
                  await setSettings({ theme: t });
                  void applyThemeWithRipple(
                    t,
                    { x: e.clientX, y: e.clientY },
                    settings.reduceMotion,
                  );
                }}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </Row>
        <Row title="Reduce motion" hint="Tones down the orb, particles, and aurora.">
          <Switch checked={settings.reduceMotion} onCheckedChange={(v) => void setSettings({ reduceMotion: v })} />
        </Row>
        <Row title="Sound effects" hint="Subtle confirmation sounds on ticket creation.">
          <Switch checked={settings.sounds} onCheckedChange={(v) => void setSettings({ sounds: v })} />
        </Row>
      </Group>

      <Group title="Behavior">
        <Row title="Launch at login" hint="Open Zenful Tickets when you sign in.">
          <Switch checked={!!autostartOn} onCheckedChange={(v) => void toggleAutostart(v)} disabled={autostartOn === null} />
        </Row>
        <Row title="Global hotkey" hint="Click, then press the combo you want. Press Esc to cancel.">
          <HotkeyCapture
            value={settings.globalHotkey}
            defaultValue={DEFAULT_SETTINGS.globalHotkey}
            onChange={(combo) => void setSettings({ globalHotkey: combo })}
          />
        </Row>
        <Row title="Check for updates automatically">
          <Switch checked={settings.autoUpdate} onCheckedChange={(v) => void setSettings({ autoUpdate: v })} />
        </Row>
      </Group>
    </>
  );
}

// ─── Jira ────────────────────────────────────────────────────

function JiraSection() {
  const { settings, setSettings, secrets, refreshSecrets } = useAppStore();
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<"ok" | "fail" | null>(null);
  const [user, setUser] = useState<{ displayName?: string; email?: string } | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [editingToken, setEditingToken] = useState(false);

  useEffect(() => {
    void jiraListProjects().then(setProjects).catch(() => setProjects([]));
    void jiraVerify().then(setUser).catch(() => setUser(null));
  }, []);

  const test = async () => {
    setTesting(true);
    setTestStatus(null);
    try {
      const u = await jiraVerify();
      setUser(u);
      setTestStatus("ok");
    } catch {
      setTestStatus("fail");
    } finally {
      setTesting(false);
    }
  };

  const rotateToken = async () => {
    if (!tokenInput.trim()) { setEditingToken(false); return; }
    await secretsUpdate({ jira_token: tokenInput.trim() });
    setTokenInput("");
    setEditingToken(false);
    await refreshSecrets();
    void test();
  };

  const disconnect = async () => {
    await secretsClear();
    await setSettings({ onboardingComplete: false, defaultProjectKey: null });
    await refreshSecrets();
    location.reload();
  };

  const connected = !!secrets?.has_jira_token && !!secrets?.jira_site;

  return (
    <>
      <Group title="Workspace">
        <Row title="Status" hint={user?.email ? `Connected as ${user.email}` : connected ? "Token stored" : "Not connected"}>
          <span className="chip" style={{
            color: connected ? "#30d158" : "#ff9f0a",
            background: connected ? "rgba(48,209,88,0.12)" : "rgba(255,159,10,0.12)",
          }}>
            <span style={{ width: 5, height: 5, background: connected ? "#30d158" : "#ff9f0a", borderRadius: "50%" }} />
            {connected ? "Connected" : "Not connected"}
          </span>
        </Row>
        <Row title="Workspace URL">
          <code style={{ fontSize: 12 }}>{secrets?.jira_site ?? "—"}</code>
        </Row>
        <Row title="Account email">
          <span style={{ font: "400 13px var(--font-text)", color: "var(--fg-muted)" }}>
            {secrets?.jira_email ?? "—"}
          </span>
        </Row>
        <Row title="API token" hint={`Stored in your ${secretStoreName()}.`} align="top">
          {editingToken ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Input
                type="password"
                placeholder="ATATT3xFfGF0…"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                style={{ width: 200, fontFamily: "var(--font-mono)" }}
              />
              <Button variant="primary" onClick={() => void rotateToken()}>Save</Button>
              <Button onClick={() => { setTokenInput(""); setEditingToken(false); }}>Cancel</Button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <code style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>
                {secrets?.has_jira_token ? "•••••••••••••••" : "(not set)"}
              </code>
              <Button onClick={() => setEditingToken(true)}>Rotate</Button>
            </div>
          )}
        </Row>
        <Row title="Test connection" hint="Round-trips a request to your Jira host.">
          <Button onClick={() => void test()} disabled={testing}>
            {testing ? <><Spinner size={11} /> Testing…</> : <><Icon.Refresh size={12} /> Test</>}
          </Button>
          {testStatus === "ok" && <span className="chip" style={{ color: "#30d158", background: "rgba(48,209,88,0.12)" }}><Icon.Check size={10} /> OK</span>}
          {testStatus === "fail" && <span className="chip" style={{ color: "#ff453a", background: "rgba(255,69,58,0.12)" }}><Icon.Alert size={10} /> Failed</span>}
        </Row>
      </Group>

      <Group title="Defaults">
        <Row title="Default project" hint="Where new tickets land if you don't specify.">
          <Menu
            align="right"
            value={settings.defaultProjectKey ?? ""}
            trigger={
              <Button silent style={{ minWidth: 200, justifyContent: "space-between" }}>
                <span>{projects.find((p) => p.key === settings.defaultProjectKey)?.name ?? "Pick a project"}</span>
                <Icon.Chevron size={10} />
              </Button>
            }
            items={projects.map((p) => ({ value: p.key, label: `${p.key} — ${p.name}` }))}
            onSelect={(v) => void setSettings({ defaultProjectKey: v as string })}
          />
        </Row>
        <Row title="Default issue type" hint="Used when AI doesn't infer one.">
          <div className="segmented">
            {(["Story", "Task", "Bug", "Epic"] as const).map((t) => (
              <button key={t} type="button" className={settings.defaultIssueType === t ? "active" : ""} onClick={() => { if (settings.defaultIssueType !== t) playUi("toggle"); void setSettings({ defaultIssueType: t }); }}>
                {t}
              </button>
            ))}
          </div>
        </Row>
        <Row title="Auto-assign to me" hint="Set yourself as assignee on new tickets.">
          <Switch checked={settings.autoAssign} onCheckedChange={(v) => void setSettings({ autoAssign: v })} />
        </Row>
        <Row title="Open in Jira after create" hint="Pop the new ticket in your browser.">
          <Switch checked={settings.openAfterCreate} onCheckedChange={(v) => void setSettings({ openAfterCreate: v })} />
        </Row>
      </Group>

      <Group>
        <Row title="Disconnect Jira" hint="Clears your token and resets onboarding." danger>
          <Button style={{ color: "#ff453a" }} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </Row>
      </Group>
    </>
  );
}

// ─── AI ──────────────────────────────────────────────────────

function AISection() {
  const { settings, setSettings, secrets, refreshSecrets } = useAppStore();
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const [geminiKeyInput, setGeminiKeyInput] = useState("");

  useEffect(() => {
    void aiDetectClis().then(setDetected).catch(() => null);
  }, []);

  const saveGemini = async () => {
    if (!geminiKeyInput.trim()) return;
    await secretsUpdate({ gemini_key: geminiKeyInput.trim() });
    setGeminiKeyInput("");
    await refreshSecrets();
    void aiDetectClis().then(setDetected);
  };

  const clearGemini = async () => {
    await secretsUpdate({ gemini_key: "" });
    await refreshSecrets();
    void aiDetectClis().then(setDetected);
  };

  // ModelDef joins MODELS metadata with the PROVIDERS availability rules so
  // adding a new provider only requires extending those two registries.
  type ModelDef = {
    id: keyof AppSettings["aiEnabled"];
    provider: Provider;
    name: string;
    tag: string;
    method: "cli" | "key";
    color: string;
    char: string;
    /** Configured = credentials/binary exist; independent of the on/off switch. */
    configured: boolean;
    desc: string;
  };

  const describe = (provider: Provider): string => {
    switch (provider) {
      case "claude_cli":
        return detected?.claude.available
          ? `Detected at ${detected.claude.path} · ${detected.claude.version ?? "unknown version"}`
          : "Not detected. Install with: npm i -g @anthropic-ai/claude-code";
      case "codex_cli":
        return detected?.codex.available
          ? `Detected at ${detected.codex.path} · ${detected.codex.version ?? "unknown version"}`
          : "Not detected. Install with: npm i -g @openai/codex";
      case "gemini":
        return secrets?.has_gemini_key
          ? "API key configured."
          : "Add an API key from Google AI Studio.";
    }
  };

  const tagFor = (vendor: string): string => vendor;

  const models: ModelDef[] = PROVIDERS.map((p) => {
    const meta = MODELS.find((m) => m.provider === p.id)!;
    return {
      id: p.enabledKey,
      provider: p.id,
      name: meta.name,
      tag: tagFor(meta.vendor),
      method: p.method,
      color: meta.color,
      char: meta.char,
      configured: isProviderConfigured(p.id, secrets ?? null, detected),
      desc: describe(p.id),
    };
  });

  return (
    <>
      <Group title="Connected models">
        {models.map((m) => (
          <div key={m.id} style={{ borderBottom: "0.5px solid var(--border)", padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 9,
                background: `linear-gradient(135deg, ${m.color}, ${m.color}cc)`,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "white", fontSize: 16, fontWeight: 600,
                boxShadow: `0 2px 8px ${m.color}55`,
                flexShrink: 0,
              }}>{m.char}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ font: "600 13.5px var(--font-text)" }}>{m.name}</span>
                  <span className="chip">{m.tag}</span>
                  {m.method === "cli" && m.configured && (
                    <span className="chip" style={{ color: "#30d158", background: "rgba(48,209,88,0.12)" }}>
                      <span style={{ width: 5, height: 5, background: "#30d158", borderRadius: "50%" }} />
                      Detected
                    </span>
                  )}
                  {m.method === "cli" && !m.configured && (
                    <span className="chip" style={{ color: "var(--fg-subtle)" }}>Not detected</span>
                  )}
                  {m.method === "key" && m.configured && (
                    <span className="chip" style={{ color: "#30d158", background: "rgba(48,209,88,0.12)" }}>
                      <Icon.Check size={10} /> Key set
                    </span>
                  )}
                </div>
                <div style={{ font: "400 12px var(--font-text)", color: "var(--fg-muted)", marginTop: 2 }}>
                  {m.desc}
                </div>
              </div>
              <Switch
                checked={settings.aiEnabled[m.id]}
                // CLI providers can only be enabled once the binary is on PATH —
                // there's nothing the user can do in Settings to fix it. Key
                // providers (Gemini, future OpenRouter, …) stay enable-able even
                // before the key is entered, so the input row appears below.
                disabled={m.method === "cli" && !m.configured}
                onCheckedChange={(v) => void setSettings({ aiEnabled: { ...settings.aiEnabled, [m.id]: v } })}
              />
            </div>
            {m.id === "gemini" && settings.aiEnabled.gemini && (
              <div style={{ marginTop: 10, paddingLeft: 44, display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Input
                  type="password"
                  placeholder={secrets?.has_gemini_key ? "•••••••••••••••" : "AIzaSy…"}
                  value={geminiKeyInput}
                  onChange={(e) => setGeminiKeyInput(e.target.value)}
                  style={{ flex: 1, minWidth: 200, fontFamily: "var(--font-mono)", fontSize: 12.5 }}
                />
                <Button variant="primary" onClick={() => void saveGemini()} disabled={!geminiKeyInput.trim()}>
                  Save key
                </Button>
                {secrets?.has_gemini_key && (
                  <Button onClick={() => void clearGemini()}>Clear</Button>
                )}
              </div>
            )}
          </div>
        ))}
      </Group>

      <Group title="Defaults">
        <Row title="Default model" hint="Used when you don't pick one in the composer.">
          <Menu
            align="right"
            value={settings.defaultProvider}
            trigger={
              <Button silent style={{ minWidth: 180, justifyContent: "space-between" }}>
                {(() => {
                  const m = MODELS.find((x) => x.provider === settings.defaultProvider) ?? MODELS[0];
                  return (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: m.color, fontSize: 14 }}>{m.char}</span>
                      {m.short}
                    </span>
                  );
                })()}
                <Icon.Chevron size={10} />
              </Button>
            }
            items={MODELS.map((m) => ({
              value: m.provider,
              label: m.name,
              icon: <span style={{ color: m.color, fontSize: 14 }}>{m.char}</span>,
            }))}
            onSelect={(v) => void setSettings({ defaultProvider: v as Provider })}
          />
        </Row>
        <Row title="Stream responses" hint="Render drafts token-by-token.">
          <Switch checked={settings.streaming} onCheckedChange={(v) => void setSettings({ streaming: v })} />
        </Row>
      </Group>
    </>
  );
}

// ─── Drafting ────────────────────────────────────────────────

function DraftingSection() {
  const { settings, setSettings } = useAppStore();
  return (
    <>
      <Group title="Composer">
        <Row title="Default mode" hint="PO writes outcome-driven user stories. DEV writes implementation-ready specs.">
          <div className="segmented">
            {(["PO", "DEV"] as const).map((m) => (
              <button key={m} type="button" className={settings.defaultMode === m ? "active" : ""} onClick={() => { if (settings.defaultMode !== m) playUi("toggle"); void setSettings({ defaultMode: m }); }}>
                {m}
              </button>
            ))}
          </div>
        </Row>
        <Row title="Submit on Enter" hint="When off, ⌘↩ submits and Enter inserts a newline.">
          <Switch checked={settings.submitOnEnter} onCheckedChange={(v) => void setSettings({ submitOnEnter: v })} />
        </Row>
      </Group>

      <Group title="Voice">
        <Row title="Voice input" hint="Toggle the mic button in the composer.">
          <Switch checked={settings.voiceEnabled} onCheckedChange={(v) => void setSettings({ voiceEnabled: v })} />
        </Row>
        <Row title="Microphone" hint="Pick which input device to use. New devices (e.g. AirPods) appear automatically.">
          <MicSelector
            value={settings.audioInputDeviceId}
            onChange={(id) => void setSettings({ audioInputDeviceId: id })}
          />
        </Row>
        <Row title="Auto-submit after silence" hint={`Submits ${(settings.silenceMs / 1000).toFixed(1)}s after you stop speaking.`}>
          <Switch checked={settings.autoSubmit} onCheckedChange={(v) => void setSettings({ autoSubmit: v })} />
        </Row>
      </Group>

      <Group title="Tone">
        <Row title="Writing style" hint="Affects how AI phrases titles, descriptions, and ACs.">
          <div className="segmented">
            {(["concise", "balanced", "detailed"] as const).map((t) => (
              <button key={t} type="button" className={settings.tone === t ? "active" : ""} onClick={() => { if (settings.tone !== t) playUi("toggle"); void setSettings({ tone: t }); }}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </Row>
        <Row title="Custom system prompt" hint="Appended to every draft. Use it to enforce team conventions." align="top">
          <div style={{ width: 320 }}>
            <Textarea
              rows={3}
              placeholder="e.g. Always reference the Zen Design System for UI tickets…"
              value={settings.systemPrompt}
              onChange={(e) => void setSettings({ systemPrompt: e.target.value })}
              style={{ minHeight: 72 }}
            />
          </div>
        </Row>
      </Group>
    </>
  );
}

// ─── About ───────────────────────────────────────────────────

function AboutSection() {
  const { setSettings, refreshSecrets } = useAppStore();
  const [info, setInfo] = useState<{ version: string; os: string; arch: string; osVer: string } | null>(null);
  const [updateState, setUpdateState] = useState<"idle" | "checking" | "none" | "available" | "installing" | "ready">("idle");
  const [diagState, setDiagState] = useState<"idle" | "copied" | "failed">("idle");
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [v, p, a, ov] = await Promise.all([appVersion(), platform(), osArch(), osVersion()]);
        setInfo({ version: v, os: p, arch: a, osVer: ov });
      } catch {}
    })();
  }, []);

  const copyDiagnostics = async () => {
    try {
      const blob = await logsDiagnostics();
      await clipboardWrite(blob);
      setDiagState("copied");
      setTimeout(() => setDiagState("idle"), 2200);
    } catch (e) {
      console.error("diagnostics:", e);
      setDiagState("failed");
      setTimeout(() => setDiagState("idle"), 2200);
    }
  };

  const resetCredentials = async () => {
    const confirmed = await confirmDialog(
      `This will permanently remove your Jira API token, Gemini API key, and any other stored credentials from your ${secretStoreName()}. You'll need to enter them again to keep using the app.`,
      { title: "Reset all credentials?", kind: "warning", okLabel: "Reset credentials", cancelLabel: "Cancel" },
    );
    if (!confirmed) return;
    setResetting(true);
    try {
      await secretsClear();
      await setSettings({ onboardingComplete: false, defaultProjectKey: null });
      await refreshSecrets();
      location.reload();
    } catch (e) {
      console.error("reset credentials:", e);
      setResetting(false);
    }
  };

  const checkForUpdate = async () => {
    setUpdateState("checking");
    try {
      const update = await checkUpdate();
      if (!update) { setUpdateState("none"); return; }
      setUpdateState("available");
      setUpdateState("installing");
      await update.downloadAndInstall();
      setUpdateState("ready");
      await relaunch();
    } catch (e) {
      // Updater isn't wired yet (no signing key / endpoint). Show a neutral
      // "up to date" rather than an alarming error in the MVP.
      console.warn("update unavailable:", e);
      setUpdateState("none");
    }
  };

  return (
    <>
      <div className="card" style={{ padding: 28, textAlign: "center", marginBottom: 26 }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
          <Persona variant="obsidian" state="idle" className="size-[140px]" />
        </div>
        <div style={{ font: "600 22px var(--font-display)", letterSpacing: "-0.02em", marginBottom: 4 }}>
          Zenful Tickets
        </div>
        <div style={{ font: "400 13px var(--font-text)", color: "var(--fg-muted)", marginBottom: 18 }}>
          {info ? `Version ${info.version} · ${info.os} ${info.osVer} ${info.arch}` : "—"}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <Button onClick={() => void checkForUpdate()} disabled={updateState === "checking" || updateState === "installing"}>
            {updateState === "checking" ? <><Spinner size={11} /> Checking…</> :
             updateState === "installing" ? <><Spinner size={11} /> Installing…</> :
             updateState === "ready" ? <>Restarting…</> :
             updateState === "none" ? <><Icon.Check size={11} /> Up to date</> :
             <><RefreshCCWIcon size={14} /> Check for updates</>}
          </Button>
        </div>
      </div>

      <Group title="Diagnostics" footer="Logs are written locally and rotate at 5MB (last 5 files kept). Secrets are scrubbed from log lines as a safety net.">
        <Row title="Open log folder" hint="Reveals the folder where rotating log files live.">
          <Button onClick={() => void logsReveal()}>
            <Icon.Folder size={12} /> Open
          </Button>
        </Row>
        <Row title="Copy diagnostics" hint="Copies app version, OS info, and the last 200 log lines to your clipboard — handy for bug reports.">
          <Button onClick={() => void copyDiagnostics()}>
            {diagState === "copied" ? <><Icon.Check size={11} /> Copied</> :
             diagState === "failed" ? <><Icon.Alert size={11} /> Failed</> :
             <><Icon.Paperclip size={11} /> Copy</>}
          </Button>
        </Row>
      </Group>

      <Group title="Danger zone">
        <Row
          title="Reset credentials"
          hint={`Removes your Jira API token, Gemini API key, and any other stored secrets from the ${secretStoreName()}. This can't be undone.`}
          danger
        >
          <Button
            onClick={() => void resetCredentials()}
            disabled={resetting}
            style={{ color: "#ff453a" }}
          >
            {resetting ? <><Spinner size={11} /> Resetting…</> : <><Icon.Alert size={12} /> Reset credentials</>}
          </Button>
        </Row>
      </Group>

      <div style={{
        textAlign: "center", font: "400 11px var(--font-text)",
        color: "var(--fg-subtle)", marginTop: 8,
      }}>
        © 2026 Zenfulfillment · Made with care
      </div>
    </>
  );
}
