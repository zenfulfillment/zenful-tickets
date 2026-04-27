import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "./ui/hover-card";
import { Icon } from "./Icon";
import { playUi } from "../lib/ui-sounds";
import type { AttachmentRef } from "../types";

/**
 * The row of attachment chips rendered above the textarea. Each chip is a
 * pill-shaped card showing the file's icon, name, and size, with an X to
 * remove. Image attachments get a 32×32 thumbnail rendered from the inline
 * data URL the backend returns; documents get a type icon.
 *
 * Hovering a document chip expands a HoverCard with extracted-text preview
 * and the per-file character contribution to the prompt budget — useful for
 * users who attach a fat spreadsheet and want to know whether they're about
 * to blow the budget.
 */
export interface AttachmentChipsProps {
  attachments: AttachmentRef[];
  onRemove: (id: string) => void;
}

export function AttachmentChips({ attachments, onRemove }: AttachmentChipsProps) {
  if (attachments.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        padding: "10px 16px 0",
      }}
    >
      {attachments.map((a) => (
        <Chip key={a.id} ref={a} onRemove={onRemove} />
      ))}
    </div>
  );
}

function Chip({
  ref: a,
  onRemove,
}: {
  ref: AttachmentRef;
  onRemove: (id: string) => void;
}) {
  const showHoverCard = a.kind !== "image" && a.extracted_chars > 0;

  const inner = (
    <div
      className="card"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 6px 4px 4px",
        height: 36,
        background: "var(--bg-elevated)",
        border: "0.5px solid var(--border)",
        borderRadius: 10,
        // Override .card's backdrop so the chip feels solid against the
        // composer's already-blurred background.
        backdropFilter: "none",
        WebkitBackdropFilter: "none",
        cursor: showHoverCard ? "default" : "default",
      }}
    >
      {/* Avatar / icon — image preview when we have one, type icon otherwise. */}
      {a.kind === "image" && a.preview_data_url ? (
        <img
          src={a.preview_data_url}
          alt=""
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            objectFit: "cover",
            flexShrink: 0,
            border: "0.5px solid var(--border)",
          }}
        />
      ) : (
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background: kindBg(a.kind),
            color: kindFg(a.kind),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontWeight: 600,
            flexShrink: 0,
            letterSpacing: "0.02em",
            fontFamily: "var(--font-mono)",
          }}
        >
          {kindLabel(a.kind, a.filename)}
        </div>
      )}

      {/* Name + meta */}
      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, maxWidth: 180 }}>
        <span
          title={a.filename}
          style={{
            font: "500 12px var(--font-text)",
            color: "var(--fg)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            letterSpacing: "-0.005em",
          }}
        >
          {a.filename}
        </span>
        <span
          style={{
            font: "400 10.5px var(--font-text)",
            color: "var(--fg-subtle)",
            lineHeight: 1,
          }}
        >
          {formatBytes(a.size_bytes)}
          {a.extracted_chars > 0 && ` · ${formatChars(a.extracted_chars)}`}
        </span>
      </div>

      {/* Remove */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          playUi("click");
          onRemove(a.id);
        }}
        title="Remove"
        aria-label={`Remove ${a.filename}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 18,
          height: 18,
          padding: 0,
          background: "transparent",
          border: "none",
          borderRadius: 5,
          color: "var(--fg-subtle)",
          cursor: "pointer",
          flexShrink: 0,
          marginLeft: 2,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-active)";
          e.currentTarget.style.color = "var(--fg)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--fg-subtle)";
        }}
      >
        <Icon.X size={11} />
      </button>
    </div>
  );

  if (!showHoverCard) return inner;

  return (
    // BaseUI's PreviewCard puts `delay` / `closeDelay` on the Trigger, not
    // the Root (where Radix would put them). Trigger uses the `render` prop
    // pattern instead of `asChild`.
    <HoverCard>
      <HoverCardTrigger delay={300} closeDelay={120} render={inner} />
      <HoverCardContent
        side="top"
        align="start"
        style={{
          width: 320,
          padding: 12,
          background: "var(--bg-card)",
          backdropFilter: "blur(30px) saturate(180%)",
          WebkitBackdropFilter: "blur(30px) saturate(180%)",
          border: "0.5px solid var(--border-strong)",
          borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
        }}
      >
        <div
          style={{
            font: "600 12px var(--font-text)",
            color: "var(--fg)",
            marginBottom: 4,
          }}
        >
          {a.filename}
        </div>
        <div
          style={{
            font: "400 11px var(--font-text)",
            color: "var(--fg-muted)",
            marginBottom: 8,
          }}
        >
          {kindHumanLabel(a.kind)} · {formatBytes(a.size_bytes)} ·{" "}
          ~{formatChars(a.extracted_chars)} sent to model
        </div>
        <div
          style={{
            font: "400 11px var(--font-text)",
            color: "var(--fg-muted)",
            lineHeight: 1.5,
          }}
        >
          The extracted contents of this file will be embedded into the prompt
          so the model can reason about it. Larger files are truncated to
          keep the prompt budget predictable.
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

// ─── Helpers ───────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatChars(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  return `${(chars / 1000).toFixed(1)}k chars`;
}

function kindLabel(kind: AttachmentRef["kind"], filename: string): string {
  // Use the file extension when it's the more recognizable label (CSV, PDF).
  const ext = (filename.split(".").pop() ?? "").toUpperCase();
  switch (kind) {
    case "pdf":
      return "PDF";
    case "csv":
      return "CSV";
    case "spreadsheet":
      return ext === "ODS" ? "ODS" : "XLS";
    case "document":
      return "DOC";
    case "text":
      return "TXT";
    case "image":
      return "IMG";
    default:
      return ext.slice(0, 3) || "?";
  }
}

function kindHumanLabel(kind: AttachmentRef["kind"]): string {
  switch (kind) {
    case "pdf": return "PDF";
    case "csv": return "CSV";
    case "spreadsheet": return "Spreadsheet";
    case "document": return "Word document";
    case "text": return "Text";
    case "image": return "Image";
    default: return "File";
  }
}

function kindBg(kind: AttachmentRef["kind"]): string {
  // Subtle, semantic backgrounds keyed off the system palette so the chips
  // sit cleanly inside the dark composer chrome.
  switch (kind) {
    case "pdf": return "rgba(255,69,58,0.16)";
    case "csv": return "rgba(48,209,88,0.16)";
    case "spreadsheet": return "rgba(48,209,88,0.16)";
    case "document": return "rgba(10,132,255,0.16)";
    case "text": return "rgba(120,120,128,0.16)";
    case "image": return "rgba(191,90,242,0.16)";
    default: return "var(--bg-active)";
  }
}

function kindFg(kind: AttachmentRef["kind"]): string {
  switch (kind) {
    case "pdf": return "#ff453a";
    case "csv": return "#30d158";
    case "spreadsheet": return "#30d158";
    case "document": return "#0a84ff";
    case "text": return "var(--fg-muted)";
    case "image": return "#bf5af2";
    default: return "var(--fg-muted)";
  }
}
