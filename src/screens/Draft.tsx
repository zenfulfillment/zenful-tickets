import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { writeText as clipboardWrite } from "@tauri-apps/plugin-clipboard-manager";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "../components/Icon";
import {
  ArrowRightIcon,
  SparklesIcon,
} from "../components/icons-animated";
import { Menu, ThinkingDots } from "../components/primitives";
import { Spinner } from "../components/ui/spinner";
import { Shimmer } from "../components/ai-elements/shimmer";
import { MessageResponse } from "../components/ai-elements/message";
import {
  aiCancel,
  aiDraft,
  aiExpandSubtasks,
  aiOpenLogin,
  jiraCreateIssue,
  jiraCreateSubtask,
  jiraCurrentUser,
  jiraListEpics,
  jiraListIssueTypes,
  jiraListPriorities,
  jiraListProjects,
  jiraSearchUsers,
  jiraUploadAttachment,
  listenDraft,
  type SubtaskExpansion,
} from "../lib/tauri";
import { playUi } from "../lib/ui-sounds";
import { Button } from "../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../components/ui/command";
import { useAppStore } from "../store";
import {
  ISSUE_TYPE_COLORS,
  MODELS,
  PRIORITY_COLORS,
  type JiraEpic,
  type JiraIssueType,
  type JiraPriority,
  type JiraProject,
  type JiraUser,
  type ParsedTicket,
  type Provider,
} from "../types";

interface MetaState {
  projects: JiraProject[];
  issueTypes: JiraIssueType[];
  priorities: JiraPriority[];
  epics: JiraEpic[];

  selectedProjectKey: string | null;
  selectedIssueTypeId: string | null;
  selectedPriorityId: string | null;
  selectedEpicKey: string | null;
  selectedAssignee: JiraUser | null;
}

export function Draft() {
  const { draftCtx, closeDraft, settings } = useAppStore();
  const ctx = draftCtx!;
  const model = MODELS.find((m) => m.provider === ctx.provider) ?? MODELS[0];

  // Streaming state
  const [streamText, setStreamText] = useState("");
  const [thinking, setThinking] = useState(true);
  const [draft, setDraft] = useState<ParsedTicket | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  // Meta state
  const [meta, setMeta] = useState<MetaState>({
    projects: [],
    issueTypes: [],
    priorities: [],
    epics: [],
    selectedProjectKey: settings.defaultProjectKey,
    selectedIssueTypeId: null,
    selectedPriorityId: null,
    selectedEpicKey: null,
    selectedAssignee: null,
  });

  // Current user (cached on mount). Used to (a) populate the assignee
  // dropdown's "Me" entry, (b) auto-select self when settings.autoAssign is
  // on, (c) feed the create-issue payload's `assignee_account_id` field.
  const [currentUser, setCurrentUser] = useState<JiraUser | null>(null);

  // Refine + create
  const [refineText, setRefineText] = useState("");
  const [refining, setRefining] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);

  // Step-by-step "create pipeline" overlay state. We only render the modal
  // while the pipeline is active OR finished (so the user can pick "Open
  // ticket" / "Create new ticket"). Each step lifecycles
  // pending → active → done | error.
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStep[]>([]);
  const [pipelineDone, setPipelineDone] = useState(false);

  const requestIdRef = useRef<string>(uuid());
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  const myAccountIdRef = useRef<string | null>(null);

  // Streaming scroll behaviour. We auto-pin the body to the bottom while
  // the model is producing tokens so the latest text stays visible — UNLESS
  // the user has manually scrolled up to re-read something earlier in the
  // ticket, in which case we yield and stop tugging the viewport. They
  // re-engage auto-scroll by scrolling back near the bottom themselves.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const onScrollBody = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
  };

  // Resolve the current user once per draft session. We need both:
  //   - the accountId, for the create-issue payload's assignee field;
  //   - the full user object, so the Assignee picker can render "Me — Kevin
  //     Koester (kevin@…)" with the right display name and email.
  // If autoAssign is on we also pre-select the user as the assignee at the
  // moment the lookup resolves (idempotent — won't overwrite a user-made
  // selection because we only set it when selectedAssignee is still null).
  useEffect(() => {
    void jiraCurrentUser()
      .then((u) => {
        myAccountIdRef.current = u.accountId;
        setCurrentUser(u);
        if (settings.autoAssign) {
          setMeta((m) => (m.selectedAssignee ? m : { ...m, selectedAssignee: u }));
        }
      })
      .catch(() => {
        myAccountIdRef.current = null;
        setCurrentUser(null);
      });
    // settings.autoAssign change-after-mount is rare; intentional one-shot run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runInitialDraft = async () => {
    // Cancel and unlisten any prior in-flight attempt before kicking off a new one.
    cleanupRef.current?.();
    const requestId = uuid();
    requestIdRef.current = requestId;

    // Set the cleanup hook IMMEDIATELY (before any awaits). React 19 StrictMode
    // mounts the effect twice in dev, and the cleanup in between can fire
    // before our `await listenDraft(...)` below resolves — which means the
    // first request's backend would otherwise keep running, BOTH listeners
    // would interleave chunks onto the same `streamText`, and the user would
    // see garbled output like "USER STORYAMING PIPELINE" (User Story +
    // Streaming Pipeline interleaved character-by-character). Setting an
    // unconditional cancel here means the StrictMode cleanup actually kills
    // the first backend even when listenDraft hasn't resolved yet.
    let unlistenFn: (() => void) | undefined;
    cleanupRef.current = () => {
      unlistenFn?.();
      void aiCancel(requestId);
    };

    setStreamText("");
    setStreamError(null);
    setDraft(null);
    setThinking(true);

    // Stale-request guard: even after cancellation, a leaked listener could
    // technically still fire if a chunk was already in the queue. We compare
    // against requestIdRef so only the CURRENT request mutates state.
    const isCurrent = () => requestIdRef.current === requestId;

    unlistenFn = await listenDraft(requestId, {
      // When streaming is off, swallow chunks — only the final result populates the UI.
      onChunk: settings.streaming ? (t) => {
        if (!isCurrent()) return;
        setStreamText((s) => s + t);
      } : undefined,
      onDone: (done) => {
        if (!isCurrent()) return;
        setThinking(false);
        if (done.ticket) {
          setDraft(done.ticket);
        } else {
          setStreamError(
            "The AI didn't include the structured tail block this draft needs. Click Retry to regenerate, or refine your prompt below.",
          );
        }
      },
      onError: (msg) => {
        if (!isCurrent()) return;
        setStreamError(msg);
        setThinking(false);
      },
    });

    try {
      await aiDraft({
        request_id: requestId,
        provider: ctx.provider,
        prompt: ctx.prompt,
        mode: ctx.mode,
        tone: settings.tone,
        custom_system_prompt: settings.systemPrompt || undefined,
        model: ctx.model || undefined,
      });
    } catch (e) {
      if (!isCurrent()) return;
      setStreamError(String(e));
      setThinking(false);
    }
  };

  // ── Initial draft request ───────────────────────────────────
  useEffect(() => {
    void runInitialDraft();
    return () => cleanupRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auth-error helpers ──────────────────────────────────────
  const authProvider = detectAuthProvider(streamError, ctx.provider);
  const handleSignIn = async () => {
    if (!authProvider) return;
    try {
      await aiOpenLogin(authProvider);
    } catch (e) {
      console.error("open login terminal:", e);
    }
  };

  // ── Load Jira metadata ──────────────────────────────────────
  // We honour settings.defaultProjectKey here, but only after validating
  // that the key actually exists in the fetched project list — a stale or
  // mistyped default in settings shouldn't leave the dropdown stuck on an
  // unresolvable key. Same idea for issue type and priority defaults.
  useEffect(() => {
    (async () => {
      try {
        const [projects, priorities] = await Promise.all([
          jiraListProjects(),
          jiraListPriorities(),
        ]);
        setMeta((m) => {
          const currentValid =
            m.selectedProjectKey != null &&
            projects.some((p) => p.key === m.selectedProjectKey);
          const fromSettings = projects.find(
            (p) => p.key === settings.defaultProjectKey,
          )?.key;
          const selectedProjectKey = currentValid
            ? m.selectedProjectKey
            : (fromSettings ?? projects[0]?.key ?? null);
          return {
            ...m,
            projects,
            priorities,
            selectedProjectKey,
            selectedPriorityId:
              priorities.find((p) => p.name === "Medium")?.id ??
              priorities[0]?.id ??
              null,
          };
        });
      } catch (e) {
        console.error("load meta failed:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch issue types + epics when project changes
  useEffect(() => {
    if (!meta.selectedProjectKey) return;
    const projKey = meta.selectedProjectKey;
    (async () => {
      try {
        const proj = meta.projects.find((p) => p.key === projKey);
        if (!proj) return;
        const [types, epics] = await Promise.all([
          jiraListIssueTypes(proj.id).catch(() => [] as JiraIssueType[]),
          jiraListEpics(projKey).catch(() => [] as JiraEpic[]),
        ]);
        setMeta((m) => ({
          ...m,
          issueTypes: types,
          epics,
          selectedIssueTypeId:
            // Prefer the AI-inferred type, then settings default, then first.
            findTypeId(types, draft?.type) ??
            findTypeId(types, settings.defaultIssueType) ??
            types[0]?.id ??
            null,
        }));
      } catch (e) {
        console.error("project meta:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.selectedProjectKey, meta.projects.length, draft?.type]);

  // When AI-parsed priority arrives, sync the dropdown.
  useEffect(() => {
    if (!draft) return;
    setMeta((m) => ({
      ...m,
      selectedPriorityId:
        m.priorities.find((p) => p.name.toLowerCase() === draft.priority.toLowerCase())?.id ??
        m.selectedPriorityId,
    }));
  }, [draft]);

  // ── Handlers ────────────────────────────────────────────────
  const handleRefine = async () => {
    const t = refineText.trim();
    if (!t || refining) return;

    // Cancel + unlisten any prior request (initial draft OR a previous
    // refine) so concurrent listeners can't accumulate text from two
    // different streams onto the same `streamText` state. Mirrors what
    // runInitialDraft does at the top.
    cleanupRef.current?.();

    // Capture the existing draft body BEFORE we clear streamText. With the
    // slimmed JSON-tail schema, streamText (sans fence) is the canonical
    // body — it's what the model wrote and what the user just refined.
    // Fall back to a synthesised Markdown representation of the parsed
    // ticket only when streamText isn't available, then to the original
    // user prompt as the absolute last resort.
    const previousBody = streamText.split(/```json/i)[0].trim();
    const baseDraftMd = previousBody.length > 0
      ? previousBody
      : draft
        ? draftToMarkdown(draft)
        : ctx.prompt;

    setRefining(true);
    setStreamText("");
    setThinking(true);
    setStreamError(null);

    const requestId = uuid();
    requestIdRef.current = requestId;
    const unlisten = await listenDraft(requestId, {
      onChunk: (chunk) => setStreamText((s) => s + chunk),
      onDone: (done) => {
        if (done.ticket) setDraft(done.ticket);
        setThinking(false);
        setRefining(false);
      },
      onError: (msg) => {
        setStreamError(msg);
        setThinking(false);
        setRefining(false);
      },
    });
    cleanupRef.current = () => {
      unlisten();
      void aiCancel(requestId);
    };

    try {
      await aiDraft({
        request_id: requestId,
        provider: ctx.provider,
        prompt: t,
        mode: ctx.mode,
        tone: settings.tone,
        custom_system_prompt: settings.systemPrompt || undefined,
        refine_of: baseDraftMd,
        model: ctx.model || undefined,
      });
      setRefineText("");
    } catch (e) {
      setStreamError(String(e));
      setThinking(false);
      setRefining(false);
    }
  };

  const handleAttach = async () => {
    const picked = await openDialog({
      multiple: true,
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] },
        { name: "Documents", extensions: ["pdf", "txt", "md", "log", "json", "zip"] },
      ],
    });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    setAttachments((cur) => [...cur, ...list.map((p) => String(p))]);
  };

  const handleCreate = async () => {
    if (!draft || !meta.selectedProjectKey || !meta.selectedIssueTypeId) {
      setCreateError("Select a project and issue type first.");
      return;
    }

    // Body sent to Jira is what the user is looking at on screen
    // (streamText sans JSON fence). Two more strips applied here that
    // aren't needed for the on-screen preview:
    //   - `### Title` heading block — the title is already shown in
    //     Jira's `summary` field and as the issue page header. Repeating
    //     it as the first line of the description is just visual noise
    //     in the rendered ticket.
    //   - `### Subtasks` section — each subtask becomes its own real
    //     Jira issue under "Child issues". Keeping the bullets in the
    //     parent description would duplicate what's already linked.
    const streamBody = streamText.split(/```json/i)[0].trim();
    const rawBody = streamBody.length > 0
      ? streamBody
      : (draft.description ?? "").trim();
    const subtasks = (draft.subtasks ?? [])
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    let description_markdown = rawBody.replace(
      /^\s*#{1,6}[ \t]+Title[ \t]*\n[^\n]*(?:\n+|$)/i,
      "",
    );
    if (subtasks.length > 0) {
      description_markdown = stripSubtasksSection(description_markdown);
    }
    description_markdown = description_markdown.trim();

    // Pick a sub-taskable issue type from the project's metadata. Jira's
    // `/issue/createmeta/{project}/issuetypes` flags these via
    // `subtask: true`. Most Cloud projects have exactly one
    // ("Sub-task"); company-managed projects sometimes have several
    // (e.g. "Sub-bug"). We just take the first one and run with it.
    const subtaskIssueType = subtasks.length > 0
      ? meta.issueTypes.find((t) => t.subtask)
      : undefined;

    // Build the step list dynamically — each visible row is something
    // we ARE going to do for this submission. No fake/placeholder rows.
    const steps: PipelineStep[] = [];
    steps.push({ id: "ticket", label: `Creating ${draft.type ?? "ticket"}`, status: "active" });
    if (attachments.length > 0) {
      steps.push({
        id: "attachments",
        label: attachments.length === 1
          ? "Uploading attachment"
          : `Uploading ${attachments.length} attachments`,
        status: "pending",
      });
    }
    if (subtasks.length > 0 && subtaskIssueType) {
      // Expansion pass — second AI call that turns each bare sub-task
      // title into a full ticket body. Inserted before the create step
      // so the user can see "Drafting sub-task descriptions" tick by
      // before any Jira POSTs land.
      steps.push({
        id: "expand",
        label: subtasks.length === 1
          ? "Drafting sub-task description"
          : `Drafting ${subtasks.length} sub-task descriptions`,
        status: "pending",
      });
      steps.push({
        id: "subtasks",
        label: subtasks.length === 1
          ? "Creating sub-task"
          : `Creating ${subtasks.length} sub-tasks`,
        status: "pending",
      });
    } else if (subtasks.length > 0) {
      // Project has no sub-task issue type — show a single greyed-out
      // "skipped" row so the user knows we noticed but couldn't create them.
      steps.push({
        id: "subtasks",
        label: `Skipping ${subtasks.length} sub-tasks (project has no sub-task issue type)`,
        status: "pending",
        skipped: true,
      });
    }

    setPipelineSteps(steps);
    setPipelineOpen(true);
    setPipelineDone(false);
    setCreating(true);
    setCreateError(null);

    const updateStep = (id: string, patch: Partial<PipelineStep>) => {
      setPipelineSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    };

    try {
      // ── Step: Main ticket ──────────────────────────────────────
      const assignee_account_id =
        meta.selectedAssignee?.accountId ??
        (settings.autoAssign ? myAccountIdRef.current : null);

      const created = await jiraCreateIssue({
        project_key: meta.selectedProjectKey,
        summary: draft.title,
        description_markdown,
        issue_type_id: meta.selectedIssueTypeId,
        priority_id: meta.selectedPriorityId,
        labels: draft.labels.length > 0 ? draft.labels : null,
        epic_key: meta.selectedEpicKey,
        assignee_account_id,
      });
      const url = created.browse_url ?? created.self;
      setCreatedKey(created.key);
      setCreatedUrl(url);
      updateStep("ticket", { status: "done", detail: created.key });

      // ── Step: Attachments ─────────────────────────────────────
      if (attachments.length > 0) {
        updateStep("attachments", { status: "active" });
        let uploaded = 0;
        for (const path of attachments) {
          try {
            await jiraUploadAttachment(created.key, path);
            uploaded++;
            updateStep("attachments", {
              detail: `${uploaded} / ${attachments.length}`,
            });
          } catch (e) {
            console.warn("attachment failed:", path, e);
          }
        }
        updateStep("attachments", {
          status: "done",
          detail: `${uploaded} / ${attachments.length}`,
        });
      }

      // ── Step: Sub-task expansion + creation ───────────────────
      if (subtasks.length > 0) {
        if (!subtaskIssueType) {
          // Sub-task type genuinely missing from this project; mark the
          // step as skipped (visual greyed-out) and move on.
          updateStep("subtasks", { status: "done", skipped: true });
        } else {
          // 1. Expansion pass — second AI call to flesh out each title
          //    into a Markdown body. Soft failure: if the expansion errors
          //    or returns nothing, fall back to title-only creation rather
          //    than halting the pipeline. The user still gets their
          //    sub-tasks, just without rich descriptions.
          updateStep("expand", { status: "active" });
          let expansions: SubtaskExpansion[] = [];
          try {
            expansions = await aiExpandSubtasks({
              provider: ctx.provider,
              mode: ctx.mode,
              parent_title: draft.title,
              parent_body_markdown: description_markdown,
              subtask_titles: subtasks,
              custom_system_prompt: settings.systemPrompt || undefined,
              model: ctx.model || undefined,
            });
            updateStep("expand", {
              status: "done",
              detail:
                expansions.length === subtasks.length
                  ? `${expansions.length} drafted`
                  : `${expansions.length} of ${subtasks.length} drafted`,
            });
          } catch (e) {
            console.warn("subtask expansion failed:", e);
            // Truncate to keep the row readable, but include enough of
            // the actual error so the user can see WHY it failed
            // (auth, network, parse, etc) rather than a generic
            // "Expansion failed" with no context.
            const msg = String(e instanceof Error ? e.message : e).replace(/\s+/g, " ").trim();
            const short = msg.length > 80 ? msg.slice(0, 77) + "…" : msg;
            updateStep("expand", {
              status: "done",
              skipped: true,
              detail: short
                ? `Expansion failed (${short}) — creating with titles only`
                : "Expansion failed — creating with titles only",
            });
            expansions = [];
          }

          // Index expansions by title for O(1) lookup. Indices are also
          // matched as a fallback because the prompt requires order
          // preservation.
          const expansionByTitle = new Map<string, SubtaskExpansion>();
          for (const e of expansions) expansionByTitle.set(e.title, e);

          // 2. Creation pass — one POST per subtask, with the (possibly
          //    AI-expanded) Markdown body attached. Sequential so the
          //    "X / N" detail can update in lockstep with what's actually
          //    landed in Jira.
          updateStep("subtasks", { status: "active", detail: `0 / ${subtasks.length}` });
          let made = 0;
          for (let i = 0; i < subtasks.length; i++) {
            const summary = subtasks[i];
            const exp = expansionByTitle.get(summary) ?? expansions[i];
            const body = exp?.description_markdown?.trim() || undefined;
            try {
              await jiraCreateSubtask({
                parent_key: created.key,
                project_key: meta.selectedProjectKey,
                subtask_issue_type_id: subtaskIssueType.id,
                summary,
                description_markdown: body,
              });
              made++;
              updateStep("subtasks", { detail: `${made} / ${subtasks.length}` });
            } catch (e) {
              console.warn("subtask creation failed:", summary, e);
              // Don't abort the whole pipeline on a single subtask failure —
              // keep going and surface the partial count at the end.
            }
          }
          updateStep("subtasks", {
            status: "done",
            detail: `${made} / ${subtasks.length}`,
          });
        }
      }

      // Side effects (notification, clipboard) — nice-to-haves; not modelled
      // as pipeline steps because they don't fail loudly enough to warrant it.
      playUi("questComplete");
      try {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (granted) {
          await sendNotification({ title: `Created ${created.key}`, body: draft.title });
        }
      } catch {}
      try { await clipboardWrite(url); } catch {}

      setPipelineDone(true);
    } catch (e) {
      // The active step is the one that failed. Mark it as error so the
      // user sees which row blew up; keep the modal open with a Close button.
      setPipelineSteps((prev) =>
        prev.map((s) =>
          s.status === "active" ? { ...s, status: "error", detail: String(e) } : s,
        ),
      );
      setCreateError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const handleOpenCreated = async () => {
    if (!createdUrl) return;
    try { await openUrl(createdUrl); } catch (e) { console.warn("open url:", e); }
  };

  const handleStartNew = () => {
    setPipelineOpen(false);
    closeDraft();
  };

  // ── Computed ────────────────────────────────────────────────
  const proj = meta.projects.find((p) => p.key === meta.selectedProjectKey);
  const it = meta.issueTypes.find((t) => t.id === meta.selectedIssueTypeId);
  const itColor = it ? ISSUE_TYPE_COLORS[it.name] : undefined;
  const pr = meta.priorities.find((p) => p.id === meta.selectedPriorityId);

  // Auto-scroll the body container as new tokens arrive. We piggyback on
  // streamText changes (the lowest-level signal we have) and only scroll
  // when the user is near the bottom — see onScrollBody for the latch.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [streamText]);

  // The body rendered on the left.
  //
  // Preference order:
  //   1. Live stream (with the trailing fenced JSON block stripped) — this is
  //      what the user sees while the model is producing output, AND it's
  //      what we keep showing after completion so the body doesn't visually
  //      "switch" the moment the JSON fence parses.
  //   2. Legacy `draft.description` — only meaningful for the transitional
  //      schema where the model may still emit a description in the JSON.
  //      Keeps the screen readable across the refine kick-off transition
  //      instead of going blank.
  //   3. Empty string — pure initial state; the skeleton/shimmer renders.
  //
  // Then strip the leading `### Title` section. The model writes the title
  // both as the JSON `title` field AND as a `### Title\n<text>` heading at
  // the top of the body. We render the title once via the editable
  // TitleField above the markdown, so the heading would be a redundant
  // second copy. The regex matches a leading H1–H6 whose text is exactly
  // "Title" (with optional surrounding whitespace) followed by one line of
  // content, and removes that whole block — including any trailing blank
  // lines so the next section starts cleanly.
  const renderedBody = useMemo(() => {
    const streamPrefix = streamText.split(/```json/i)[0].trimEnd();
    const raw = streamPrefix.length > 0 ? streamPrefix : (draft?.description ?? "");
    return raw.replace(/^\s*#{1,6}[ \t]+Title[ \t]*\n[^\n]*(?:\n+|$)/i, "");
  }, [streamText, draft]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header. We already reserve vertical space for the macOS traffic-light
          cluster via `paddingTop: var(--titlebar-h)`, so the toolbar row sits
          fully BELOW the traffic lights — no horizontal clearance needed. The
          Back button can sit flush left (20px gutter, same as everywhere else
          in the app). */}
      <div style={{
        height: "calc(48px + var(--titlebar-h, 0px))",
        paddingTop: "var(--titlebar-h, 0px)",
        flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        paddingLeft: 20,
        paddingRight: 20,
        borderBottom: "0.5px solid var(--border)",
        background: "var(--bg-elevated)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Button variant="ghost" size="sm" onClick={closeDraft} style={{ padding: "0 8px" }}>
            <Icon.Chevron size={11} dir="left" /> Back
          </Button>
          <div style={{ width: 1, height: 16, background: "var(--border)" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 6, font: "500 12.5px var(--font-text)", color: "var(--fg-muted)" }}>
            <span style={{ color: "var(--accent)", display: "inline-flex" }}><SparklesIcon size={13} /></span>
            Draft ticket
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="chip">
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: thinking ? "#ff9f0a" : streamError ? "#ff453a" : "#30d158" }} />
            {thinking ? "Drafting…" : streamError ? "Issue" : "Draft ready"}
          </span>
          <Button onClick={() => void handleAttach()}>
            <Icon.Paperclip size={12} /> Attach
            {attachments.length > 0 && <span className="chip" style={{ marginLeft: 4 }}>{attachments.length}</span>}
          </Button>
          {/* RefreshCCWIcon spins on hover — perfect for the regenerate concept; reserved for a future "Regenerate" affordance. */}
          <Button
            variant="primary"
            onClick={() => void handleCreate()}
            disabled={!draft || creating || pipelineOpen || thinking}
          >
            {createdKey ? <><Icon.Check size={12} /> Created</> :
             creating ? <>Creating…</> :
             <>Create ticket <kbd style={{ marginLeft: 4, background: "rgba(255,255,255,0.18)", border: "0.5px solid rgba(255,255,255,0.18)", color: "white" }}>⌘⏎</kbd></>}
          </Button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Left: ticket body */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--bg-window)" }}>
          <div
            ref={scrollRef}
            onScroll={onScrollBody}
            style={{ flex: 1, overflowY: "auto", padding: "32px 48px 24px" }}
          >
            <DraftBody
              thinking={thinking}
              refining={refining}
              streamError={streamError}
              draft={draft}
              renderedBody={renderedBody}
              modelName={model.name}
              proj={proj}
              issueType={it}
              issueTypeColor={itColor}
              attachments={attachments}
              authProvider={authProvider}
              onTitleChange={(t) => setDraft((d) => d ? { ...d, title: t } : d)}
              onRemoveAttachment={(i) =>
                setAttachments((a) => a.filter((_, j) => j !== i))
              }
              onSignIn={handleSignIn}
              onRetry={() => void runInitialDraft()}
            />
          </div>

          {/* Refine bar */}
          <div style={{ flexShrink: 0, padding: "12px 48px 20px", background: "linear-gradient(to top, var(--bg-window) 70%, transparent)" }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              background: "var(--bg-card)",
              backdropFilter: "blur(30px) saturate(180%)",
              WebkitBackdropFilter: "blur(30px) saturate(180%)",
              border: "0.5px solid var(--border-strong)",
              borderRadius: 14,
              padding: "6px 6px 6px 14px",
              boxShadow: "0 4px 14px rgba(0,0,0,0.06)",
            }}>
              {refining ? <ThinkingDots /> : <span style={{ color: "var(--accent)", display: "inline-flex" }}><SparklesIcon size={14} /></span>}
              <input
                value={refineText}
                onChange={(e) => setRefineText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleRefine(); } }}
                placeholder={refining ? "Refining…" : "Refine — \"add Safari 17 to scope\", \"bump priority to high\""}
                disabled={refining}
                style={{ flex: 1, border: 0, background: "transparent", outline: 0, font: "400 13.5px var(--font-text)", color: "var(--fg)" }}
              />
              <Button
                variant={refineText.trim() ? "primary" : "default"}
                size="iconSm"
                onClick={() => void handleRefine()}
                disabled={!refineText.trim() || refining}
                style={{
                  background: refineText.trim() ? "var(--accent)" : "var(--bg-active)",
                  color: refineText.trim() ? "white" : "var(--fg-subtle)",
                }}
              >
                <ArrowRightIcon size={14} />
              </Button>
            </div>
          </div>
        </div>

        {/* Right: meta */}
        <div style={{
          width: 320, flexShrink: 0,
          borderLeft: "0.5px solid var(--border)",
          background: "var(--bg-elevated)",
          padding: "20px 20px 24px",
          overflowY: "auto",
        }}>
          <div style={{ font: "600 11px var(--font-text)", color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 12 }}>
            Details
          </div>

          <MetaRow label="Project">
            <Menu
              align="right"
              value={meta.selectedProjectKey ?? ""}
              trigger={<FieldChip label={proj ? `${proj.key} · ${proj.name}` : "Pick project"} icon={<Icon.Folder size={11} />} />}
              items={meta.projects.map((p) => ({ value: p.key, label: `${p.key} — ${p.name}` }))}
              onSelect={(v) => setMeta((m) => ({ ...m, selectedProjectKey: v as string }))}
            />
          </MetaRow>

          <MetaRow label="Type">
            <Menu
              align="right"
              value={meta.selectedIssueTypeId ?? ""}
              trigger={<FieldChip label={it?.name ?? "Pick type"} icon={itColor ? <span style={{ color: itColor.color }}>{itColor.icon}</span> : <Icon.Tag size={11} />} />}
              items={meta.issueTypes.map((t) => ({
                value: t.id,
                label: t.name,
                icon: ISSUE_TYPE_COLORS[t.name] ? <span style={{ color: ISSUE_TYPE_COLORS[t.name].color }}>{ISSUE_TYPE_COLORS[t.name].icon}</span> : undefined,
              }))}
              onSelect={(v) => setMeta((m) => ({ ...m, selectedIssueTypeId: v as string }))}
            />
          </MetaRow>

          <MetaRow label="Priority">
            <Menu
              align="right"
              value={meta.selectedPriorityId ?? ""}
              trigger={<FieldChip label={pr?.name ?? "Pick priority"} color={pr ? PRIORITY_COLORS[pr.name] : undefined} icon={<Icon.Flag size={11} />} />}
              items={meta.priorities.map((p) => ({ value: p.id, label: p.name }))}
              onSelect={(v) => setMeta((m) => ({ ...m, selectedPriorityId: v as string }))}
            />
          </MetaRow>

          {meta.epics.length > 0 && (
            <MetaRow label="Epic">
              <Menu
                align="right"
                value={meta.selectedEpicKey ?? ""}
                trigger={<FieldChip label={meta.epics.find((e) => e.key === meta.selectedEpicKey)?.summary ?? "No epic"} icon={<span style={{ color: "#bf5af2" }}>⬢</span>} />}
                items={[
                  { value: "", label: "No epic" },
                  ...meta.epics.map((e) => ({ value: e.key, label: `${e.key} — ${e.summary}` })),
                ]}
                onSelect={(v) => setMeta((m) => ({ ...m, selectedEpicKey: v ? (v as string) : null }))}
              />
            </MetaRow>
          )}

          <MetaRow label="Assignee">
            <AssigneePicker
              value={meta.selectedAssignee}
              currentUser={currentUser}
              onChange={(u) => setMeta((m) => ({ ...m, selectedAssignee: u }))}
            />
          </MetaRow>

          <MetaRow label="Labels">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {(draft?.labels ?? []).map((l, i) => (
                <span key={i} style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  height: 22, padding: "0 4px 0 8px",
                  background: "var(--accent-soft)",
                  color: "var(--accent)",
                  borderRadius: 5,
                  font: "500 11.5px var(--font-text)",
                }}>
                  {l}
                  <button
                    type="button"
                    onClick={() => setDraft((d) => d ? { ...d, labels: d.labels.filter((_, j) => j !== i) } : d)}
                    style={{ width: 14, height: 14, border: 0, padding: 0, borderRadius: 3, background: "transparent", color: "currentColor", cursor: "pointer", opacity: 0.6, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                  >
                    <Icon.X size={10} />
                  </button>
                </span>
              ))}
              <AddLabel onAdd={(label) => setDraft((d) => d ? { ...d, labels: [...d.labels, label] } : d)} />
            </div>
          </MetaRow>

          {createError && (
            <div className="card" style={{ padding: 12, marginTop: 16, borderColor: "rgba(255,69,58,0.4)", background: "rgba(255,69,58,0.06)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#ff453a", font: "500 12.5px var(--font-text)" }}>
                <Icon.Alert size={12} /> {createError}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create-pipeline modal — replaces the old single-shot "created"
          overlay. Drives a step-by-step view of what's actually happening
          (main ticket → attachments → sub-tasks), then transitions to a
          done state with two CTAs. Closed only by user action. */}
      {pipelineOpen && (
        <CreatePipelineModal
          steps={pipelineSteps}
          done={pipelineDone}
          createdKey={createdKey}
          onOpenCreated={() => void handleOpenCreated()}
          onStartNew={handleStartNew}
          onClose={() => setPipelineOpen(false)}
          errored={!!createError}
        />
      )}
    </div>
  );
}

// ─── Create-pipeline overlay ─────────────────────────────────

/**
 * One row in the create-ticket pipeline modal. The lifecycle is
 * `pending` → `active` → `done` (or `error`). `skipped` flags a row that's
 * displayed greyed-out as "not applicable to this submission" rather than
 * actually performed (e.g. project has no sub-task issue type).
 */
type PipelineStepStatus = "pending" | "active" | "done" | "error";

interface PipelineStep {
  id: string;
  label: string;
  detail?: string;
  status: PipelineStepStatus;
  skipped?: boolean;
}

/**
 * Modal overlay that visualises the create flow as discrete steps. While a
 * step is active it shows a spinner; completed steps show a check; failed
 * steps show an error mark with the message inline.
 *
 * When `done` is true and we have a createdKey, the footer transitions to
 * two primary CTAs: "Open ticket" (opens Jira in the user's default
 * browser) and "Create another ticket" (returns to Main). The modal is
 * never auto-dismissed — the user always picks an explicit next step.
 */
function CreatePipelineModal({
  steps,
  done,
  createdKey,
  errored,
  onOpenCreated,
  onStartNew,
  onClose,
}: {
  steps: PipelineStep[];
  done: boolean;
  createdKey: string | null;
  errored: boolean;
  onOpenCreated: () => void;
  onStartNew: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fade-in"
      style={{
        position: "absolute", inset: 0,
        background: "rgba(10, 12, 16, 0.62)",
        backdropFilter: "blur(20px) saturate(160%)",
        WebkitBackdropFilter: "blur(20px) saturate(160%)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        className="scale-in card"
        style={{
          width: 460,
          maxWidth: "calc(100% - 48px)",
          padding: 24,
          background: "var(--bg-elevated)",
          border: "0.5px solid var(--border)",
          borderRadius: 16,
          boxShadow: "0 24px 60px rgba(0,0,0,0.35)",
        }}
      >
        <div style={{
          font: "600 16px var(--font-display)",
          letterSpacing: "-0.015em",
          color: "var(--fg)",
          marginBottom: 4,
        }}>
          {done && createdKey
            ? `${createdKey} created`
            : errored
              ? "Couldn't finish"
              : "Creating ticket"}
        </div>
        <div style={{
          font: "400 13px var(--font-text)",
          color: "var(--fg-muted)",
          marginBottom: 18,
        }}>
          {done
            ? "Everything is in Jira."
            : errored
              ? "One of the steps below failed. Check the detail and retry from the Draft."
              : "Hang tight — we'll show each step as it lands in Jira."}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {steps.map((step) => (
            <PipelineStepRow key={step.id} step={step} />
          ))}
        </div>

        <div style={{ marginTop: 22, display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {done && createdKey ? (
            <>
              <Button onClick={onStartNew}>
                <Icon.Plus size={11} /> Create another ticket
              </Button>
              <Button variant="primary" onClick={onOpenCreated}>
                <Icon.External size={11} /> Open ticket
              </Button>
            </>
          ) : errored ? (
            <Button onClick={onClose}>Close</Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PipelineStepRow({ step }: { step: PipelineStep }) {
  const muted = step.skipped || step.status === "pending";
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "10px 12px",
      borderRadius: 10,
      background: step.status === "active"
        ? "color-mix(in oklab, var(--accent) 6%, transparent)"
        : step.status === "error"
          ? "rgba(255,69,58,0.08)"
          : "var(--bg-card)",
      border: `0.5px solid ${
        step.status === "active"
          ? "color-mix(in oklab, var(--accent) 25%, transparent)"
          : step.status === "error"
            ? "rgba(255,69,58,0.35)"
            : "var(--border)"
      }`,
      opacity: muted ? 0.7 : 1,
      transition: "background 200ms ease, border-color 200ms ease, opacity 200ms ease",
    }}>
      <PipelineStepIcon status={step.status} skipped={step.skipped} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          font: `${step.status === "active" ? 600 : 500} 13.5px var(--font-text)`,
          color: step.status === "error" ? "#ff453a" : "var(--fg)",
          letterSpacing: "-0.005em",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {step.label}
        </div>
        {step.detail && (
          <div style={{
            font: "400 12px var(--font-text)",
            color: step.status === "error" ? "rgba(255,69,58,0.85)" : "var(--fg-subtle)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {step.detail}
          </div>
        )}
      </div>
    </div>
  );
}

function PipelineStepIcon({
  status,
  skipped,
}: {
  status: PipelineStepStatus;
  skipped?: boolean;
}) {
  const ringStyle: React.CSSProperties = {
    width: 22,
    height: 22,
    borderRadius: "50%",
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  };
  if (skipped) {
    return (
      <span style={{
        ...ringStyle,
        border: "0.5px dashed var(--border-strong)",
        background: "var(--bg-active)",
        color: "var(--fg-subtle)",
        font: "600 11px var(--font-text)",
      }}>—</span>
    );
  }
  if (status === "active") {
    return (
      <span style={{ ...ringStyle, color: "var(--accent)" }}>
        <Spinner size={16} />
      </span>
    );
  }
  if (status === "done") {
    return (
      <span style={{
        ...ringStyle,
        background: "#30d158",
        color: "white",
      }}>
        <Icon.Check size={11} />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span style={{
        ...ringStyle,
        background: "#ff453a",
        color: "white",
        font: "700 12px var(--font-text)",
      }}>!</span>
    );
  }
  // pending
  return (
    <span style={{
      ...ringStyle,
      border: "0.5px solid var(--border-strong)",
      background: "var(--bg-card)",
    }} />
  );
}

/**
 * Strip a leading or inline `### Subtasks` (and h2/h4 variants, case-insensitive)
 * section + its contents from a Markdown body. We do this when rendering the
 * description sent to Jira because each subtask becomes its own real issue —
 * keeping the bullet list in the parent description would just duplicate
 * what's already linked under "Child issues".
 *
 * The match runs from the heading to the next sibling-or-shallower heading
 * (or end of string). We're conservative: if the model wrote the heading
 * with extra punctuation or different wording, we leave it alone — the cost
 * of leaving a stray section in is much lower than accidentally lopping off
 * legitimate content.
 */
function stripSubtasksSection(md: string): string {
  // Matches:  ### Subtasks  / ## Subtasks  / #### Sub-tasks  (case-insensitive),
  // up to the next heading at the same-or-shallower level, or end of string.
  const re = /(^|\n)#{1,6}[ \t]+sub[-\s]?tasks?[ \t]*\n[\s\S]*?(?=\n#{1,6}[ \t]+\S|$)/i;
  return md.replace(re, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ─── Helpers / sub-components ────────────────────────────────

/**
 * The whole left-pane body of the Draft screen.
 *
 * Three states it has to render cleanly:
 *
 *   1. **Loading, no chunks yet** — the model has been kicked off but not a
 *      single token has streamed back. We show a Shimmer status pill plus a
 *      few shimmering placeholder lines so the user sees the system is
 *      actively working. This state must appear instantly on mount or the
 *      screen feels frozen.
 *
 *   2. **Streaming** — chunks have started flowing. We render the partial
 *      Markdown via `MessageResponse` with `parseIncompleteMarkdown` so
 *      half-finished bullets/blocks render gracefully as they arrive. The
 *      Shimmer pill stays on so the user can tell more is coming.
 *
 *   3. **Done** — JSON has been parsed; `draft` is populated. We render the
 *      same `MessageResponse` (now over the canonical `draft.description`)
 *      plus an editable, autosizing title field above it, plus the
 *      type/project chip row. The user can still refine via the bottom bar.
 *
 * Errors short-circuit the whole pane to an `ErrorCard`.
 */
type IssueTypeColor = (typeof ISSUE_TYPE_COLORS)[keyof typeof ISSUE_TYPE_COLORS];

interface DraftBodyProps {
  thinking: boolean;
  refining: boolean;
  streamError: string | null;
  draft: ParsedTicket | null;
  renderedBody: string;
  modelName: string;
  proj: JiraProject | undefined;
  issueType: JiraIssueType | undefined;
  issueTypeColor: IssueTypeColor | undefined;
  attachments: string[];
  authProvider: "claude" | "codex" | null;
  onTitleChange: (t: string) => void;
  onRemoveAttachment: (i: number) => void;
  onSignIn: () => void | Promise<void>;
  onRetry: () => void;
}

function DraftBody({
  thinking,
  refining,
  streamError,
  draft,
  renderedBody,
  modelName,
  proj,
  issueType,
  issueTypeColor,
  attachments,
  authProvider,
  onTitleChange,
  onRemoveAttachment,
  onSignIn,
  onRetry,
}: DraftBodyProps) {
  const hasBody = renderedBody.trim().length > 0;

  // Hard error path — only show if we have nothing to display yet. If we
  // have a draft + an error (e.g. the user hit cancel mid-stream), the body
  // stays visible and the error inlines below.
  if (streamError && !draft && !hasBody) {
    return (
      <ErrorCard
        title="Drafting failed"
        message={streamError}
        authProvider={authProvider}
        onSignIn={onSignIn}
        onRetry={onRetry}
      />
    );
  }

  return (
    <div className="fade-in-up">
      <StatusPill
        thinking={thinking}
        refining={refining}
        hasDraft={!!draft}
        modelName={modelName}
      />

      {/* Issue-type / project chips. Only meaningful once we've parsed the JSON. */}
      {draft && issueType && issueTypeColor && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "3px 8px",
            background: `${issueTypeColor.color}1f`,
            color: issueTypeColor.color,
            borderRadius: 5,
            font: "600 11.5px var(--font-text)",
          }}>
            <span>{issueTypeColor.icon}</span> {issueType.name}
          </span>
          {proj && (
            <span style={{ font: "500 12px var(--font-text)", color: "var(--fg-subtle)" }}>
              {proj.key}-NEW
            </span>
          )}
        </div>
      )}

      {/* Title — editable when we have a draft, shimmering placeholder while
          we don't. Wrapper div carries the layout/typography so the Shimmer
          stays a tight inline-block (its CSS forces inline-block, and the
          gradient sweep relies on it). Short copy keeps it readable on a
          single line at 26px without wrap weirdness. */}
      {draft ? (
        <TitleField value={draft.title} onChange={onTitleChange} />
      ) : (
        <div style={{
          font: "600 26px var(--font-display)",
          letterSpacing: "-0.025em",
          color: "var(--fg-muted)",
          margin: "0 0 22px",
          lineHeight: 1.3,
        }}>
          <Shimmer as="span" duration={1.6} spread={3}>
            Composing your ticket…
          </Shimmer>
        </div>
      )}

      {/* Body — single rendered Markdown block. While streaming,
          parse-incomplete mode lets streamdown render half-arrived
          bullets / fences / tables without flashing broken layout. The
          empty className override on MessageResponse blanks out
          streamdown's default `size-full` (which would force the body to
          fill the scroll container's full height even for short tickets,
          leaving a tall empty band of background below short outputs). */}
      {hasBody ? (
        <div className="ticket-md">
          <MessageResponse className="size-auto" parseIncompleteMarkdown={thinking}>
            {renderedBody}
          </MessageResponse>
        </div>
      ) : thinking ? (
        <DraftSkeleton />
      ) : null}

      {/* Inline attachments badge row stays on the left because it's part of
          the ticket payload, not the meta-controls panel. */}
      {attachments.length > 0 && draft && (
        <div style={{ marginTop: 22, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {attachments.map((p, i) => (
            <span key={i} className="chip" style={{ height: 26, padding: "0 8px" }}>
              <Icon.Paperclip size={11} />
              {basename(p)}
              <button
                type="button"
                onClick={() => onRemoveAttachment(i)}
                style={{
                  width: 14, height: 14, border: 0, background: "transparent",
                  color: "currentColor", cursor: "pointer", opacity: 0.6, marginLeft: 2,
                }}
              >
                <Icon.X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* If we have ANY content (a parsed draft OR streamed prose) AND an
          error (e.g. JSON block didn't parse, or partial result with a tail
          failure), inline the error rather than blowing the whole pane away.
          The full-screen ErrorCard at the top of this component handles the
          "nothing to show" case. */}
      {streamError && (
        <ErrorCard
          message={streamError}
          authProvider={authProvider}
          onSignIn={onSignIn}
          onRetry={onRetry}
        />
      )}
    </div>
  );
}

function StatusPill({
  thinking,
  refining,
  hasDraft,
  modelName,
}: {
  thinking: boolean;
  refining: boolean;
  hasDraft: boolean;
  modelName: string;
}) {
  if (thinking) {
    // Distinguish "first draft" from "refining an existing draft" so the
    // user knows whether the body they currently see (which only changes
    // once the first new chunk arrives) is the previous output being
    // updated or a fresh response being composed.
    const label = refining
      ? `Refining with ${modelName}`
      : `Drafting with ${modelName}`;
    return (
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 8,
        padding: "5px 12px", marginBottom: 18,
        background: "var(--accent-soft)",
        border: "0.5px solid color-mix(in oklab, var(--accent) 25%, transparent)",
        borderRadius: 9999,
        color: "var(--accent)",
        font: "500 12px var(--font-text)",
      }}>
        <Spinner size={11} />
        <Shimmer as="span" duration={1.4}>
          {label}
        </Shimmer>
      </div>
    );
  }
  if (hasDraft) {
    return (
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "5px 12px", marginBottom: 18,
        background: "rgba(48,209,88,0.10)",
        border: "0.5px solid rgba(48,209,88,0.25)",
        borderRadius: 9999,
        color: "#1f9d4a",
        font: "500 12px var(--font-text)",
      }}>
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#30d158" }} />
        Draft ready
      </div>
    );
  }
  return null;
}

/**
 * A few shimmering placeholder lines that fill the body before any tokens
 * have streamed back. Each line uses the Shimmer text component so the
 * placeholder content itself feels alive instead of static.
 */
function DraftSkeleton() {
  const lines = [
    { text: "Reading the input and identifying the strategic opportunity.", spread: 2.6 },
    { text: "Composing user story, context, and acceptance criteria.", spread: 3.0 },
    { text: "Breaking the work into a platform-oriented subtask plan.", spread: 2.4 },
    { text: "Inferring labels, priority, and the right Jira issue type.", spread: 2.8 },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
      {lines.map((l, i) => (
        <div
          key={i}
          style={{
            font: "400 14.5px var(--font-text)",
            color: "var(--fg-subtle)",
            lineHeight: 1.55,
          }}
        >
          <Shimmer as="span" duration={1.6 + i * 0.1} spread={l.spread}>
            {l.text}
          </Shimmer>
        </div>
      ))}
    </div>
  );
}

/**
 * Editable title that wraps onto multiple lines instead of overflowing the
 * container. Implemented as a 1-row textarea that auto-resizes via
 * scrollHeight after each input — the natural way to get an `<input>`-like
 * affordance with `wrap: hard` semantics.
 */
function TitleField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Resize on value change AND on mount (resizing requires the node to be in
  // the DOM with its real width to compute scrollHeight correctly).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      style={{
        display: "block",
        width: "100%",
        border: 0, background: "transparent", outline: 0,
        font: "600 26px var(--font-display)",
        letterSpacing: "-0.025em",
        color: "var(--fg)",
        padding: 0,
        margin: "0 0 22px",
        lineHeight: 1.3,
        resize: "none",
        overflow: "hidden",
        wordBreak: "break-word",
        whiteSpace: "pre-wrap",
      }}
    />
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "0.5px solid var(--border)" }}>
      <div style={{
        width: 80, flexShrink: 0,
        font: "500 12px var(--font-text)",
        color: "var(--fg-muted)",
      }}>{label}</div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "flex-end" }}>{children}</div>
    </div>
  );
}

/**
 * Searchable assignee picker.
 *
 * Built on shadcn primitives:
 *   - Popover (Base UI)            — anchored dropdown
 *   - Command + cmdk               — keyboard-navigable list with input
 *
 * Why Combobox-style instead of our `Menu` primitive: Jira instances can
 * have hundreds/thousands of users, so the list MUST be searchable. cmdk
 * gives us keyboard nav (↑↓⏎/Esc) and accessible labelling for free.
 *
 * `shouldFilter={false}` disables cmdk's local filter — the search query
 * is debounced and forwarded to `jira_search_users`, so the visible list
 * is whatever Jira's API returned for that query, not a client-side
 * substring match against a static set.
 *
 * The current user is always pinned at the top of the results (when
 * known and not already in the search results) so "assign to me" is one
 * click away — even when settings.autoAssign isn't on.
 */
function AssigneePicker({
  value,
  currentUser,
  onChange,
}: {
  value: JiraUser | null;
  currentUser: JiraUser | null;
  onChange: (u: JiraUser | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<JiraUser[]>([]);
  const [loading, setLoading] = useState(false);

  // Debounce server queries so each keystroke doesn't fire a Jira call.
  // Initial open with empty query also pulls "recently active" users.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      jiraSearchUsers(query)
        .then((users) => {
          if (cancelled) return;
          // Jira's /user/search occasionally returns app/system accounts;
          // prefer accounts with a real display name to keep the list
          // signal-to-noise high.
          setResults(users.filter((u) => !!u.displayName));
        })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, query.trim() ? 220 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, query]);

  const pickAndClose = (user: JiraUser | null) => {
    onChange(user);
    setOpen(false);
    setQuery("");
  };

  // Pin current user at the top of the list (if known and not already
  // surfaced by the current query). Skip the duplicate when search results
  // already include them so we don't show "Me" twice.
  const showPinnedMe =
    currentUser && !results.some((r) => r.accountId === currentUser.accountId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              height: 26, padding: "0 10px",
              background: "var(--bg-input)",
              border: "0.5px solid var(--border-input)",
              borderRadius: 7,
              font: "500 12.5px var(--font-text)",
              color: "var(--fg)",
              cursor: "pointer",
              maxWidth: "100%",
              overflow: "hidden",
            }}
          >
            <UserAvatar user={value} size={16} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {value
                ? assigneeLabel(value, currentUser)
                : "Unassigned"}
            </span>
            <Icon.Chevron size={9} />
          </button>
        }
      />
      <PopoverContent
        align="end"
        sideOffset={6}
        className="!w-72 !p-0 !bg-[var(--bg-elevated)] !text-[var(--fg)] !ring-[var(--border)] !shadow-[0_8px_30px_rgba(0,0,0,0.18)]"
      >
        <Command shouldFilter={false} className="bg-transparent">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search people…"
            className="text-[13px]"
          />
          <CommandList className="max-h-[280px]">
            {loading && results.length === 0 ? (
              <div style={{
                padding: "16px 12px",
                font: "400 12px var(--font-text)",
                color: "var(--fg-muted)",
              }}>
                Searching…
              </div>
            ) : (
              <>
                <CommandEmpty>
                  <div style={{
                    padding: "12px 12px",
                    font: "400 12px var(--font-text)",
                    color: "var(--fg-muted)",
                  }}>
                    No matches.
                  </div>
                </CommandEmpty>

                <CommandGroup>
                  <CommandItem
                    value="__unassigned__"
                    onSelect={() => pickAndClose(null)}
                    className="!gap-2"
                  >
                    <span style={{
                      width: 16, height: 16, borderRadius: "50%",
                      background: "var(--bg-active)",
                      border: "0.5px dashed var(--border-strong)",
                      flexShrink: 0,
                    }} />
                    <span style={{ font: "500 13px var(--font-text)" }}>Unassigned</span>
                  </CommandItem>

                  {showPinnedMe && currentUser && (
                    <CommandItem
                      value={`me-${currentUser.accountId}`}
                      onSelect={() => pickAndClose(currentUser)}
                      className="!gap-2"
                    >
                      <UserAvatar user={currentUser} size={18} />
                      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                        <span style={{ font: "500 13px var(--font-text)", color: "var(--fg)" }}>
                          Me — {currentUser.displayName ?? "Current user"}
                        </span>
                        {currentUser.email && (
                          <span style={{ font: "400 11.5px var(--font-text)", color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {currentUser.email}
                          </span>
                        )}
                      </div>
                    </CommandItem>
                  )}
                </CommandGroup>

                {results.length > 0 && (
                  <CommandGroup heading="People">
                    {results.map((u) => (
                      <CommandItem
                        key={u.accountId}
                        value={`${u.accountId}-${u.displayName ?? ""}`}
                        onSelect={() => pickAndClose(u)}
                        className="!gap-2"
                      >
                        <UserAvatar user={u} size={18} />
                        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                          <span style={{ font: "500 13px var(--font-text)", color: "var(--fg)" }}>
                            {u.displayName ?? u.accountId}
                            {currentUser?.accountId === u.accountId ? " (Me)" : ""}
                          </span>
                          {u.email && (
                            <span style={{ font: "400 11.5px var(--font-text)", color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {u.email}
                            </span>
                          )}
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function assigneeLabel(u: JiraUser, currentUser: JiraUser | null): string {
  const name = u.displayName ?? "Unknown";
  return currentUser?.accountId === u.accountId ? `Me — ${name}` : name;
}

/**
 * Tiny user avatar. Uses the user's avatarUrls from Jira when present,
 * falls back to coloured initials so the picker still reads at a glance
 * even before the Jira CDN responds (or when the field is missing).
 */
function UserAvatar({ user, size = 18 }: { user: JiraUser | null; size?: number }) {
  if (!user) {
    return (
      <span style={{
        width: size, height: size, borderRadius: "50%",
        background: "var(--bg-active)",
        border: "0.5px dashed var(--border-strong)",
        flexShrink: 0,
        display: "inline-block",
      }} />
    );
  }
  const initials = (user.displayName ?? "??")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("") || "?";
  // Stable per-user color from accountId hash — keeps avatars distinguishable
  // without hauling in the Jira avatar CDN (which would also need image
  // remote-resource permissions in the Tauri capabilities config).
  const hue = hashHue(user.accountId);
  return (
    <span style={{
      width: size, height: size, borderRadius: "50%",
      background: `hsl(${hue} 65% 45%)`,
      color: "white",
      flexShrink: 0,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      font: `600 ${Math.max(8, Math.round(size * 0.5))}px var(--font-text)`,
      letterSpacing: "0.02em",
    }}>
      {initials}
    </span>
  );
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function FieldChip({ icon, label, color }: { icon?: React.ReactNode; label: string; color?: string }) {
  return (
    <button
      type="button"
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        height: 26, padding: "0 10px",
        background: "var(--bg-input)",
        border: "0.5px solid var(--border-input)",
        borderRadius: 7,
        font: "500 12.5px var(--font-text)",
        color: "var(--fg)",
        cursor: "pointer",
        maxWidth: "100%",
        overflow: "hidden",
      }}
    >
      {color && <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />}
      {icon}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <Icon.Chevron size={9} />
    </button>
  );
}

function AddLabel({ onAdd }: { onAdd: (label: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState("");
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        style={{
          height: 22, padding: "0 8px",
          background: "transparent",
          border: "0.5px dashed var(--border-strong)",
          borderRadius: 5, color: "var(--fg-subtle)",
          font: "500 11px var(--font-text)", cursor: "pointer",
          display: "inline-flex", alignItems: "center", gap: 3,
        }}
      >
        <Icon.Plus size={9} /> Add
      </button>
    );
  }
  return (
    <input
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v.trim()) onAdd(v.trim()); setV(""); setEditing(false); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { if (v.trim()) onAdd(v.trim()); setV(""); setEditing(false); }
        if (e.key === "Escape") { setV(""); setEditing(false); }
      }}
      placeholder="label"
      style={{
        height: 22, padding: "0 8px",
        border: "0.5px solid var(--border-strong)",
        borderRadius: 5, background: "var(--bg-input)",
        color: "var(--fg)",
        font: "500 11px var(--font-text)",
        width: 80, outline: "none",
      }}
    />
  );
}

function ErrorCard({
  title = "Something went wrong",
  message,
  authProvider,
  onSignIn,
  onRetry,
}: {
  title?: string;
  message: string;
  authProvider: "claude" | "codex" | null;
  onSignIn: () => void | Promise<void>;
  onRetry: () => void;
}) {
  return (
    <div className="card" style={{
      padding: 14, marginTop: 16,
      borderColor: "rgba(255,69,58,0.4)",
      background: "rgba(255,69,58,0.06)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#ff453a", font: "500 13px var(--font-text)" }}>
        <Icon.Alert size={14} />
        {authProvider ? `${authProvider === "claude" ? "Claude" : "Codex"} isn't signed in` : title}
      </div>
      <div style={{ font: "400 13px var(--font-text)", color: "var(--fg-muted)", marginTop: 6, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
        {authProvider
          ? `Open a terminal, run the login command, then come back and click "Try again".`
          : message}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        {authProvider && (
          <Button variant="primary" onClick={() => void onSignIn()}>
            <Icon.Terminal size={12} /> Sign in to {authProvider === "claude" ? "Claude" : "Codex"}
          </Button>
        )}
        <Button onClick={onRetry}>
          <Icon.Refresh size={12} /> Try again
        </Button>
      </div>
      {authProvider && (
        <details style={{ marginTop: 10, font: "400 11.5px var(--font-text)", color: "var(--fg-subtle)" }}>
          <summary style={{ cursor: "pointer" }}>Show original error</summary>
          <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", font: "400 11.5px var(--font-mono)", color: "var(--fg-subtle)" }}>
            {message}
          </pre>
        </details>
      )}
    </div>
  );
}

function detectAuthProvider(message: string | null, fallback: Provider): "claude" | "codex" | null {
  if (!message) return null;
  // Server-side friendly_error() emits "<binary> isn't signed in.". Match that
  // first, then any free-text auth markers as a safety net.
  const m = message.toLowerCase();
  if (/\bclaude\b.*(signed in|sign in|\/login|not authenticated|unauthorized)/.test(m)) return "claude";
  if (/\bcodex\b.*(signed in|sign in|login|not authenticated|unauthorized)/.test(m)) return "codex";
  if (/(signed in|sign in|\/login|not authenticated|unauthorized|401)/.test(m)) {
    if (fallback === "claude_cli") return "claude";
    if (fallback === "codex_cli") return "codex";
  }
  return null;
}

// ─── Pure helpers ────────────────────────────────────────────

function uuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function basename(p: string) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function findTypeId(types: JiraIssueType[], name: string | undefined | null): string | null {
  if (!name) return null;
  return types.find((t) => t.name.toLowerCase() === name.toLowerCase())?.id ?? null;
}

/**
 * Synthesise a Markdown representation of a parsed ticket, used as the
 * `refine_of` payload when we don't have the original streamed body in
 * memory (e.g. the live buffer was cleared and only the metadata-sidecar
 * survives). This is a fallback — the preferred refine context is the
 * actual streamed Markdown from the previous turn (see handleRefine).
 *
 * With the slimmed JSON schema the only fields we can rely on here are
 * `title`, `type`, `priority`, `labels`. The legacy fields are read
 * defensively in case an older response shape is in play.
 */
function draftToMarkdown(d: ParsedTicket): string {
  const sections: string[] = [`# ${d.title}`];
  if (d.description?.trim()) sections.push(d.description.trim());
  if (d.acceptance_criteria && d.acceptance_criteria.length > 0) {
    sections.push(
      `## Acceptance Criteria\n${d.acceptance_criteria.map((c) => `- ${c}`).join("\n")}`,
    );
  }
  if (d.tech_notes?.trim()) {
    sections.push(`## Technical Notes\n${d.tech_notes.trim()}`);
  }
  sections.push(
    `_type: ${d.type} · priority: ${d.priority} · labels: ${d.labels.join(", ")}_`,
  );
  return sections.join("\n\n");
}
