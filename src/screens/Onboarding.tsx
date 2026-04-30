import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Background } from "../components/Background";
import { Icon } from "../components/Icon";
import { Persona } from "../components/Persona";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { formatComboParts } from "../lib/hotkey";
import { secretStoreName } from "../lib/platform";
import {
  describeError,
  diagnosticsString,
  parseAppError,
  type AppErrorPayload,
} from "../lib/errors";
import { notify } from "../lib/notify";
import {
  aiDetectClis,
  jiraListProjects,
  jiraVerify,
  secretsUpdate,
} from "../lib/tauri";
import { useAppStore } from "../store";
import type { DetectResult, JiraProject } from "../types";

type Step = "welcome" | "jira" | "verify" | "project" | "ai" | "ready";

// Total visible step dots in the progress indicator. `verify` is an
// interstitial — it doesn't get its own dot and reuses the `jira` position.
const TOTAL_STEPS = 5;

export function Onboarding() {
  const [step, setStep] = useState<Step>("welcome");
  // Prefill the workspace with our org's tenant — the most common case for users.
  const [jiraSite, setJiraSite] = useState("zenfulfillment");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraToken, setJiraToken] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const { setSettings, refreshSecrets, setScreen } = useAppStore();

  // Detect local CLIs when entering the AI step.
  useEffect(() => {
    if (step !== "ai") return;
    void aiDetectClis().then(setDetected).catch(() => setDetected(null));
  }, [step]);

  const goto = (s: Step) => setStep(s);

  const finish = async () => {
    if (geminiKey.trim()) {
      await secretsUpdate({ gemini_key: geminiKey.trim() });
    }
    await refreshSecrets();
    await setSettings({ onboardingComplete: true });
    setScreen("main");
  };

  return (
    <div
      style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}
    >
      <Background />
      {step === "welcome" && <WelcomeStep onNext={() => goto("jira")} />}
      {step === "jira" && (
        <JiraStep
          site={jiraSite}
          email={jiraEmail}
          token={jiraToken}
          onChange={(patch) => {
            if ("site" in patch) setJiraSite(patch.site ?? "");
            if ("email" in patch) setJiraEmail(patch.email ?? "");
            if ("token" in patch) setJiraToken(patch.token ?? "");
          }}
          onBack={() => goto("welcome")}
          onNext={() => goto("verify")}
        />
      )}
      {step === "verify" && (
        <VerifyStep
          site={jiraSite}
          email={jiraEmail}
          token={jiraToken}
          onBack={() => goto("jira")}
          onSuccess={() => goto("project")}
        />
      )}
      {step === "project" && (
        <ProjectStep
          onBack={() => goto("jira")}
          onNext={() => goto("ai")}
        />
      )}
      {step === "ai" && (
        <AIStep
          detected={detected}
          geminiKey={geminiKey}
          onGeminiKey={setGeminiKey}
          onBack={() => goto("project")}
          onNext={() => goto("ready")}
        />
      )}
      {step === "ready" && <ReadyStep onFinish={finish} />}
    </div>
  );
}

// ─── Shell ───────────────────────────────────────────────────

function StepShell({
  step,
  total,
  onBack,
  onNext,
  nextLabel = "Continue",
  nextDisabled,
  back = true,
  children,
}: {
  step: number;
  total: number;
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  back?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: 720,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        margin: "0 auto",
        padding: "40px 60px 28px",
        position: "relative",
        zIndex: 1,
      }}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", minHeight: 0 }}>
        {children}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 20 }}>
        <div style={{ width: 100 }}>
          {back && onBack && step > 0 && (
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
          )}
        </div>
        <StepIndicator step={step} total={total} />
        <div style={{ width: 100, display: "flex", justifyContent: "flex-end" }}>
          {onNext && (
            <Button
              variant="primary"
              size="pill"
              onClick={onNext}
              disabled={nextDisabled}
            >
              {nextLabel}
              <Icon.ArrowRight size={12} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function StepIndicator({ step, total }: { step: number; total: number }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "center" }}>
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`step-dot ${i === step ? "active" : i < step ? "done" : ""}`}
        />
      ))}
    </div>
  );
}

// ─── Step 0: Welcome ─────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <StepShell step={0} total={TOTAL_STEPS} onNext={onNext} nextLabel="Get started" back={false}>
      <div className="fade-in-up" style={{ textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 32 }}>
          <Persona variant="obsidian" state="idle" className="size-[210px]" />
        </div>
        <h1
          style={{
            font: "600 38px var(--font-display)",
            letterSpacing: "-0.025em",
            margin: "0 0 12px",
            lineHeight: 1.15,
          }}
        >
          Welcome to Zenful Tickets
        </h1>
        <p
          style={{
            font: "400 17px var(--font-text)",
            color: "var(--fg-muted)",
            margin: "0 auto",
            maxWidth: 460,
            lineHeight: 1.5,
            letterSpacing: "-0.01em",
          }}
        >
          Turn rough ideas into clear, well-structured Jira tickets — with a little help from your favourite AI.
        </p>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
          marginTop: 48,
          maxWidth: 600,
          marginLeft: "auto",
          marginRight: "auto",
        }}>
          {[
            { icon: <Icon.Sparkle />, title: "AI-drafted", sub: "Claude, Codex, or Gemini" },
            { icon: <Icon.Mic />, title: "Voice input", sub: "Speak it, ship it" },
            { icon: <Icon.Bolt />, title: "One keystroke", sub: "From idea to Jira" },
          ].map((f, i) => (
            <div key={i} className="card" style={{ padding: "16px 14px", textAlign: "left" }}>
              <div style={{ color: "var(--accent)", marginBottom: 8 }}>{f.icon}</div>
              <div style={{ font: "600 13px var(--font-text)", marginBottom: 2 }}>{f.title}</div>
              <div style={{ font: "400 12px var(--font-text)", color: "var(--fg-muted)" }}>{f.sub}</div>
            </div>
          ))}
        </div>
      </div>
    </StepShell>
  );
}

// ─── Step 1: Jira credentials ────────────────────────────────

function JiraStep({
  site,
  email,
  token,
  onChange,
  onBack,
  onNext,
}: {
  site: string;
  email: string;
  token: string;
  onChange: (patch: Partial<{ site: string; email: string; token: string }>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [showHelp, setShowHelp] = useState(false);
  const valid = site.trim() && email.trim() && token.trim().length >= 12;

  return (
    <StepShell step={1} total={TOTAL_STEPS} onBack={onBack} onNext={onNext} nextDisabled={!valid}>
      <div className="fade-in-up">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: "linear-gradient(135deg, #0052cc, #2684ff)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "white", boxShadow: "0 4px 14px rgba(38,132,255,0.35)",
          }}>
            <svg width={22} height={22} viewBox="0 0 24 24" fill="none">
              <path d="M11.5 2L4 9.5l3 3 4.5-4.5 4.5 4.5 3-3L11.5 2z" fill="currentColor" />
              <path d="M11.5 22l-7.5-7.5 3-3L11.5 16l4.5-4.5 3 3L11.5 22z" fill="currentColor" opacity="0.7" />
            </svg>
          </div>
          <div>
            <h2 style={{ font: "600 24px var(--font-display)", letterSpacing: "-0.02em", margin: 0 }}>
              Connect to Jira
            </h2>
            <p style={{ font: "400 14px var(--font-text)", color: "var(--fg-muted)", margin: "4px 0 0" }}>
              We need your Atlassian workspace URL, email, and an API token.
            </p>
          </div>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <Field label="Atlassian Workspace URL" icon={<Icon.Globe />}>
            <Input
              style={{ paddingLeft: 38 }}
              placeholder="acme.atlassian.net"
              value={site}
              onChange={(e) => onChange({ site: e.target.value })}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Atlassian Account Email" icon={<Icon.Mail />}>
            <Input
              type="email"
              style={{ paddingLeft: 38 }}
              placeholder="you@company.com"
              value={email}
              onChange={(e) => onChange({ email: e.target.value })}
              autoComplete="off"
            />
          </Field>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <span className="label" style={{ margin: 0 }}>Jira API Token</span>
              <a
                onClick={(e) => { e.preventDefault(); setShowHelp((s) => !s); }}
                style={{ font: "500 12px var(--font-text)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <Icon.External size={11} /> Where do I get this?
              </a>
            </div>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--fg-subtle)" }}>
                <Icon.Key />
              </span>
              <Input
                type="password"
                style={{ paddingLeft: 38, fontFamily: "var(--font-mono)", letterSpacing: "0.05em" }}
                placeholder="ATATT3xFfGF0…"
                value={token}
                onChange={(e) => onChange({ token: e.target.value })}
                autoComplete="off"
              />
            </div>

            {showHelp && (
              <div className="card scale-in" style={{ marginTop: 10, padding: 14, fontSize: 12.5, lineHeight: 1.55, transformOrigin: "top" }}>
                <div style={{ font: "600 12px var(--font-text)", color: "var(--fg)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                  <Icon.Sparkle size={11} /> Quick guide
                </div>
                <ol style={{ margin: 0, paddingLeft: 18, color: "var(--fg-muted)" }}>
                  <li>
                    Open{" "}
                    <a
                      onClick={(e) => { e.preventDefault(); void openUrl("https://id.atlassian.com/manage-profile/security/api-tokens"); }}
                      href="https://id.atlassian.com/manage-profile/security/api-tokens"
                    >
                      id.atlassian.com/manage-profile/security/api-tokens
                    </a>
                  </li>
                  <li>Click <code>Create API token</code></li>
                  <li>Give it a label like <code>Zenful Tickets</code> and copy the value</li>
                  <li>Paste it above — it's stored locally in your {secretStoreName()}</li>
                </ol>
              </div>
            )}
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "10px 12px",
            background: "var(--bg-active)",
            borderRadius: 8,
            fontSize: 12, color: "var(--fg-muted)",
          }}>
            <Icon.Lock size={12} />
            Your token never leaves your machine. We store it encrypted in your {secretStoreName()}.
          </div>
        </div>
      </div>
    </StepShell>
  );
}

function Field({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      <div style={{ position: "relative" }}>
        {icon && (
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--fg-subtle)" }}>
            {icon}
          </span>
        )}
        {children}
      </div>
    </div>
  );
}

// ─── Verify Jira credentials ────────────────────────────────

function VerifyStep({
  site,
  email,
  token,
  onBack,
  onSuccess,
}: {
  site: string;
  email: string;
  token: string;
  onBack: () => void;
  onSuccess: () => void;
}) {
  type Phase = "saving" | "auth" | "done" | "error";
  const [phase, setPhase] = useState<Phase>("saving");
  const [error, setError] = useState<AppErrorPayload | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await secretsUpdate({
          jira_site: normalizeJiraSite(site),
          jira_email: email.trim(),
          jira_token: token,
        });
        setPhase("auth");
        const user = await jiraVerify();
        setDisplayName(user.displayName ?? user.email ?? email);
        setPhase("done");
        setTimeout(onSuccess, 600);
      } catch (e) {
        const parsed = parseAppError(e);
        setError(parsed);
        setPhase("error");

        // Mirror the failure into the toast tray so it's still discoverable
        // if the user clicks Back before reading the full inline panel.
        const display = describeError(parsed, "jira-setup");
        notify(display.headline, { kind: "error", description: display.description });

        // If the window isn't focused (user tabbed away during the verify
        // spinner), fire an OS-level notification so they don't miss it.
        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
          void (async () => {
            try {
              const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
              if (granted) {
                sendNotification({ title: display.headline, body: display.description });
              }
            } catch {
              // Notifications are nice-to-have; failures are non-fatal.
            }
          })();
        }
      }
    })();
  }, [site, email, token, onSuccess]);

  const STEPS: { key: Phase; label: string }[] = [
    { key: "saving", label: `Storing credentials in your ${secretStoreName()}…` },
    { key: "auth", label: `Signing in as ${email}…` },
  ];
  const order: Phase[] = ["saving", "auth", "done"];
  const idx = order.indexOf(phase);

  return (
    <div style={{
      width: 720, height: "100%",
      display: "flex", flexDirection: "column",
      margin: "0 auto", padding: "40px 60px 28px",
      position: "relative", zIndex: 1,
    }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div className="fade-in-up" style={{ textAlign: "center", maxWidth: 520, margin: "0 auto" }}>
          {phase !== "error" ? (
            <>
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 28 }}>
                <Persona
                  variant="obsidian"
                  state={phase === "done" ? "speaking" : "thinking"}
                  className="size-[170px]"
                />
              </div>
              <h1 style={{ font: "600 28px var(--font-display)", letterSpacing: "-0.02em", margin: "0 0 8px" }}>
                {phase === "done" ? `Welcome, ${displayName ?? "there"}` : "Verifying your Jira workspace"}
              </h1>
              <p style={{ font: "400 14px var(--font-text)", color: "var(--fg-muted)", margin: "0 0 28px", lineHeight: 1.5 }}>
                {phase === "done"
                  ? "Everything checks out — let's pick your AI."
                  : "Hang on while we make sure your credentials work."}
              </p>

              <div style={{ display: "grid", gap: 8, textAlign: "left" }}>
                {STEPS.map((s, i) => {
                  const status = i < idx ? "done" : i === idx ? "active" : "pending";
                  return (
                    <div key={s.key} className="card" style={{
                      padding: "12px 14px",
                      display: "flex", alignItems: "center", gap: 12,
                      opacity: status === "pending" ? 0.5 : 1,
                      transition: "opacity 200ms ease",
                    }}>
                      <div style={{
                        width: 22, height: 22, borderRadius: "50%",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        background: status === "done" ? "#30d158"
                                  : status === "active" ? "var(--accent-soft)"
                                  : "var(--bg-active)",
                        color: status === "done" ? "white" : "var(--accent)",
                        flexShrink: 0,
                      }}>
                        {status === "done" ? <Icon.Check size={12} />
                         : status === "active" ? <Spinner size={12} />
                         : <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--fg-subtle)" }} />}
                      </div>
                      <span style={{ font: "500 13px var(--font-text)", color: status === "pending" ? "var(--fg-muted)" : "var(--fg)" }}>
                        {s.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <ErrorPanel error={error} onBack={onBack} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Verify error panel ─────────────────────────────────────
//
// Renders a classified, actionable failure state instead of the original
// generic "couldn't verify your Jira workspace" message. The headline +
// description come from `describeError`; `Technical details` is collapsed by
// default and exists so users on cryptic edge cases (and bug reporters) can
// reach the raw payload without leaving the screen.

function ErrorPanel({
  error,
  onBack,
}: {
  error: AppErrorPayload | null;
  onBack: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!error) {
    return (
      <>
        <h1 style={{ font: "600 22px var(--font-display)", letterSpacing: "-0.02em", margin: "0 0 8px" }}>
          Something went wrong
        </h1>
        <Button onClick={onBack}>Go back</Button>
      </>
    );
  }

  const display = describeError(error, "jira-setup");
  const diag = diagnosticsString(error, "jira-setup");

  const copyDiag = async () => {
    try {
      await writeText(diag);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard failures are non-fatal — the details are still visible.
    }
  };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 24 }}>
        <div style={{
          width: 64, height: 64, borderRadius: "50%",
          background: "rgba(255,69,58,0.12)",
          border: "0.5px solid rgba(255,69,58,0.35)",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#ff453a",
        }}>
          <Icon.Alert size={24} />
        </div>
      </div>
      <h1 style={{ font: "600 22px var(--font-display)", letterSpacing: "-0.02em", margin: "0 0 8px" }}>
        {display.headline}
      </h1>
      <p style={{ font: "400 14px var(--font-text)", color: "var(--fg-muted)", margin: "0 0 20px", lineHeight: 1.55 }}>
        {display.description}
      </p>

      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 16 }}>
        <Button variant="primary" onClick={onBack}>
          Go back and try again
        </Button>
        <Button onClick={() => void copyDiag()}>
          {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Copy diagnostics</>}
        </Button>
      </div>

      <button
        type="button"
        onClick={() => setShowDetails((v) => !v)}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--fg-subtle)",
          font: "500 12px var(--font-text)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <Icon.Chevron size={10} dir={showDetails ? "up" : "down"} />
        {showDetails ? "Hide" : "Show"} technical details
      </button>

      {showDetails && (
        <pre
          className="card scale-in"
          style={{
            marginTop: 10,
            padding: 12,
            textAlign: "left",
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            lineHeight: 1.5,
            color: "var(--fg-muted)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            transformOrigin: "top",
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          {diag}
        </pre>
      )}
    </>
  );
}

// ─── Step 2: Default project ─────────────────────────────────

function ProjectStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { settings, setSettings } = useAppStore();
  const [projects, setProjects] = useState<JiraProject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const ISSUE_TYPES = ["Story", "Task", "Bug", "Epic"] as const;

  // Load projects once we land on this step. Verify just succeeded so the token
  // is good — any failure here is transient (network, permissions on a
  // specific endpoint) and the back button gets the user out.
  useEffect(() => {
    void jiraListProjects()
      .then((p) => setProjects(p))
      .catch((e) => {
        setLoadError(String(e));
        setProjects([]);
      });
  }, []);

  const filtered = (projects ?? []).filter((p) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q);
  });

  const picked = settings.defaultProjectKey;
  const valid = !!picked;

  return (
    <StepShell
      step={2}
      total={TOTAL_STEPS}
      onBack={onBack}
      onNext={onNext}
      nextDisabled={!valid}
    >
      <div className="fade-in-up" style={{ width: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: "var(--accent-soft)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--accent)",
          }}>
            <Icon.Folder size={20} />
          </div>
          <div>
            <h2 style={{ font: "600 24px var(--font-display)", letterSpacing: "-0.02em", margin: 0 }}>
              Pick your default project
            </h2>
            <p style={{ font: "400 14px var(--font-text)", color: "var(--fg-muted)", margin: "4px 0 0" }}>
              {projects === null
                ? "Fetching your Jira projects…"
                : projects.length === 0
                  ? "No projects visible to your account."
                  : `Found ${projects.length} ${projects.length === 1 ? "project" : "projects"} — tickets land here unless you specify otherwise.`}
            </p>
          </div>
        </div>

        {/* Search */}
        <div style={{ position: "relative", marginBottom: 12 }}>
          <span style={{
            position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)",
            color: "var(--fg-subtle)", pointerEvents: "none",
          }}>
            <Icon.Search size={13} />
          </span>
          <Input
            placeholder="Search projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={projects === null || projects.length === 0}
            style={{ paddingLeft: 38 }}
          />
        </div>

        {/* Project grid */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 8,
          maxHeight: 270,
          overflowY: "auto",
          paddingRight: 4,
          marginBottom: 14,
          minHeight: 110,
        }}>
          {projects === null && (
            <div style={{
              gridColumn: "1 / -1", display: "flex", alignItems: "center", justifyContent: "center",
              gap: 10, padding: 24, color: "var(--fg-muted)", font: "400 13px var(--font-text)",
            }}>
              <Spinner size={14} /> Loading projects…
            </div>
          )}

          {projects !== null && filtered.map((p) => {
            const active = picked === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => void setSettings({ defaultProjectKey: p.key })}
                className="card"
                style={{
                  padding: "12px 14px",
                  display: "flex", alignItems: "center", gap: 12,
                  textAlign: "left",
                  border: active ? "1px solid var(--accent)" : "0.5px solid var(--border)",
                  background: active ? "var(--accent-soft)" : "var(--bg-elevated)",
                  boxShadow: active ? "0 0 0 3px var(--accent-soft)" : "none",
                  cursor: "pointer",
                  transition: "all 140ms ease",
                  position: "relative",
                  // Override .card's backdrop so the hover/active surfaces stay opaque.
                  backdropFilter: "none",
                  WebkitBackdropFilter: "none",
                }}
              >
                <div style={{
                  width: 32, height: 32, borderRadius: 7, flexShrink: 0,
                  background: projectKeyColor(p.key),
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "white",
                  font: "700 11px var(--font-text)",
                  letterSpacing: "0.02em",
                }}>
                  {p.key.slice(0, 3)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    font: "600 13px var(--font-text)", color: "var(--fg)",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {p.name}
                  </div>
                  <div style={{ font: "400 11.5px var(--font-text)", color: "var(--fg-muted)", marginTop: 1 }}>
                    {p.key}{p.projectTypeKey ? ` · ${p.projectTypeKey}` : ""}
                  </div>
                </div>
                {active && (
                  <div style={{
                    width: 18, height: 18, borderRadius: "50%",
                    background: "var(--accent)", color: "white",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0,
                  }}>
                    <Icon.Check size={10} />
                  </div>
                )}
              </button>
            );
          })}

          {projects !== null && filtered.length === 0 && (
            <div style={{
              gridColumn: "1 / -1", textAlign: "center", padding: 24,
              color: "var(--fg-muted)", font: "400 13px var(--font-text)",
            }}>
              {projects.length === 0 ? (loadError ?? "No projects to show.") : `No projects match "${query}"`}
            </div>
          )}
        </div>

        {/* Default issue type — dimmed until a project is picked, mirroring the design. */}
        <div style={{
          opacity: picked ? 1 : 0.4,
          pointerEvents: picked ? "auto" : "none",
          transition: "opacity 200ms ease",
        }}>
          <div style={{
            font: "500 12px var(--font-text)", color: "var(--fg-muted)",
            marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em",
          }}>
            Default issue type
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {ISSUE_TYPES.map((t) => {
              const active = settings.defaultIssueType === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => void setSettings({ defaultIssueType: t })}
                  className="chip"
                  style={{
                    padding: "6px 12px",
                    height: 28,
                    borderRadius: 999,
                    border: active ? "1px solid var(--accent)" : "0.5px solid var(--border)",
                    background: active ? "var(--accent-soft)" : "var(--bg-elevated)",
                    color: active ? "var(--accent)" : "var(--fg)",
                    font: "500 12px var(--font-text)",
                    cursor: "pointer",
                    transition: "all 140ms ease",
                  }}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </StepShell>
  );
}

/**
 * Stable, deterministic colour for a project's key badge — same key always
 * yields the same hue. Avoids needing a server-supplied palette.
 */
function projectKeyColor(key: string): string {
  const palette = [
    "#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f",
    "#ff9f0a", "#30d158", "#0bb6c5", "#ff453a",
  ];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

// ─── Step 3: AI ──────────────────────────────────────────────

function AIStep({
  detected,
  geminiKey,
  onGeminiKey,
  onBack,
  onNext,
}: {
  detected: DetectResult | null;
  geminiKey: string;
  onGeminiKey: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const anyAvailable =
    !!detected?.claude.available || !!detected?.codex.available || !!detected?.opencode.available || geminiKey.trim().length > 10;

  return (
    <StepShell step={3} total={TOTAL_STEPS} onBack={onBack} onNext={onNext} nextDisabled={!anyAvailable}>
      <div className="fade-in-up">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: "conic-gradient(from 200deg, #ff7e3d, #d97e62, #5e5ce6, #0a84ff)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "white", boxShadow: "0 4px 14px rgba(94,92,230,0.35)",
          }}>
            <Icon.Sparkle size={20} />
          </div>
          <div>
            <h2 style={{ font: "600 24px var(--font-display)", letterSpacing: "-0.02em", margin: 0 }}>
              Choose your AI
            </h2>
            <p style={{ font: "400 14px var(--font-text)", color: "var(--fg-muted)", margin: "4px 0 0" }}>
              Connect at least one model. You can add more later in Settings.
            </p>
          </div>
        </div>

        <div style={{ display: "grid", gap: 10, marginTop: 22 }}>
          <ModelRow
            name="Claude"
            tag="Anthropic"
            description={
              detected?.claude.available
                ? `Detected at ${detected.claude.path} · ${detected.claude.version ?? "version unknown"}`
                : "Install with: npm i -g @anthropic-ai/claude-code — then relaunch."
            }
            method="cli"
            available={!!detected?.claude.available}
            color="#d97757"
            iconChar="✻"
          />
          <ModelRow
            name="Codex"
            tag="OpenAI"
            description={
              detected?.codex.available
                ? `Detected at ${detected.codex.path} · ${detected.codex.version ?? "version unknown"}`
                : "Install with: npm i -g @openai/codex — then relaunch."
            }
            method="cli"
            available={!!detected?.codex.available}
            color="#10a37f"
            iconChar="◓"
          />
          <ModelRow
            name="OpenCode"
            tag="Anomaly"
            description={
              detected?.opencode.available
                ? `Detected at ${detected.opencode.path} · ${detected.opencode.version ?? "version unknown"}`
                : "Install with: npm i -g opencode — then relaunch."
            }
            method="cli"
            available={!!detected?.opencode.available}
            color="#6366f1"
            iconChar="⌘"
          />
          <ModelRow
            name="Gemini 2.5 Pro"
            tag="Google"
            description="Paste an API key from Google AI Studio."
            method="key"
            color="#4285f4"
            iconChar="◆"
            keyValue={geminiKey}
            onKeyChange={onGeminiKey}
          />
        </div>
      </div>
    </StepShell>
  );
}

function ModelRow({
  name,
  tag,
  description,
  method,
  available,
  color,
  iconChar,
  keyValue,
  onKeyChange,
}: {
  name: string;
  tag: string;
  description: string;
  method: "cli" | "key";
  available?: boolean;
  color: string;
  iconChar: string;
  keyValue?: string;
  onKeyChange?: (v: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasKey = !!keyValue?.trim();
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: `linear-gradient(135deg, ${color}, ${color}cc)`,
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "white", fontSize: 18, fontWeight: 600,
          boxShadow: `0 2px 10px ${color}55`,
          flexShrink: 0,
        }}>{iconChar}</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ font: "600 14px var(--font-text)", letterSpacing: "-0.01em" }}>{name}</span>
            <span className="chip">{tag}</span>
            {method === "cli" && available && (
              <span className="chip" style={{ color: "#30d158", background: "rgba(48,209,88,0.12)" }}>
                <span style={{ width: 5, height: 5, background: "#30d158", borderRadius: "50%" }} />
                Detected
              </span>
            )}
            {method === "cli" && !available && (
              <span className="chip" style={{ color: "var(--fg-subtle)" }}>Not found</span>
            )}
            {method === "key" && hasKey && (
              <span className="chip" style={{ color: "#30d158", background: "rgba(48,209,88,0.12)" }}>
                <Icon.Check size={10} /> Configured
              </span>
            )}
          </div>
          <div style={{ font: "400 12.5px var(--font-text)", color: "var(--fg-muted)", marginTop: 2 }}>
            {description}
          </div>
        </div>
        {method === "key" && (
          <Button onClick={() => setExpanded((e) => !e)}>
            {hasKey ? "Edit key" : "Add key"}
            <Icon.Chevron size={10} dir={expanded ? "up" : "down"} />
          </Button>
        )}
      </div>
      {method === "key" && expanded && (
        <div className="fade-in" style={{ marginTop: 12, paddingTop: 12, borderTop: "0.5px solid var(--border)" }}>
          <Input
            type="password"
            placeholder="AIzaSy…"
            value={keyValue ?? ""}
            onChange={(e) => onKeyChange?.(e.target.value)}
            style={{ fontFamily: "var(--font-mono)" }}
          />
          <div style={{ font: "400 11.5px var(--font-text)", color: "var(--fg-subtle)", marginTop: 6, display: "inline-flex", alignItems: "center", gap: 4 }}>
            Get a key at{" "}
            <a
              onClick={(e) => { e.preventDefault(); void openUrl("https://aistudio.google.com/apikey"); }}
              href="https://aistudio.google.com/apikey"
            >
              aistudio.google.com/apikey
            </a>
            <Icon.External size={10} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Step 3: Ready ───────────────────────────────────────────

function ReadyStep({ onFinish }: { onFinish: () => void }) {
  return (
    <StepShell step={4} total={TOTAL_STEPS} onNext={onFinish} nextLabel="Open Zenful Tickets" back={false}>
      <div className="fade-in-up" style={{ textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 28, position: "relative" }}>
          <Persona variant="obsidian" state="speaking" className="size-[185px]" />
          <div style={{
            position: "absolute", top: "50%", left: "50%",
            transform: "translate(-50%, -50%)",
            width: 56, height: 56, borderRadius: "50%",
            background: "rgba(255,255,255,0.95)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#0a84ff",
            boxShadow: "0 8px 30px rgba(0,0,0,0.2)",
          }}>
            <Icon.Check size={26} />
          </div>
        </div>
        <h1 style={{ font: "600 clamp(26px, 5.5vw, 34px) var(--font-display)", letterSpacing: "-0.025em", margin: "0 0 10px" }}>
          You're all set.
        </h1>
        <p style={{ font: "400 16px var(--font-text)", color: "var(--fg-muted)", maxWidth: 420, margin: "0 auto", lineHeight: 1.5 }}>
          Zenful Tickets is ready to draft. Try: <em>"Add a bug for the broken checkout flow on Safari"</em>.
        </p>
        <ReadyHotkeyHint />
      </div>
    </StepShell>
  );
}

function ReadyHotkeyHint() {
  const combo = useAppStore((s) => s.settings.globalHotkey);
  const parts = formatComboParts(combo);
  return (
    <div style={{ marginTop: 32, display: "inline-flex", gap: 8, padding: "8px 14px", background: "var(--bg-active)", borderRadius: 9999, font: "500 12px var(--font-text)", color: "var(--fg-muted)" }}>
      {parts.map((p, i) => <kbd key={i}>{p}</kbd>)}
      <span>from anywhere to summon</span>
    </div>
  );
}

/**
 * Normalise an Atlassian workspace URL.
 * - "zenfulfillment"            → "zenfulfillment.atlassian.net"
 * - "zenfulfillment.atlassian.net" → "zenfulfillment.atlassian.net"
 * - "https://acme.atlassian.net" → "acme.atlassian.net"
 * - "acme.atlassian.net/"       → "acme.atlassian.net"
 */
function normalizeJiraSite(raw: string): string {
  let s = raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!/\.atlassian\.net$/i.test(s) && !s.includes(".")) {
    s = `${s}.atlassian.net`;
  }
  return s.toLowerCase();
}
