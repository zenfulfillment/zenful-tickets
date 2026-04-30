import { Icon } from "./Icon";
import { playUi } from "../lib/ui-sounds";
import type { AttachmentRef } from "../types";

/**
 * The row of attachment chips rendered above the textarea. Compact, monospaced
 * chips that mirror the reference-file layout — icon + name + remove — so the
 * composer footer reads as a single visual language rather than two different
 * chip styles.
 */
export interface AttachmentChipsProps {
  attachments: AttachmentRef[];
  onRemove: (id: string) => void;
}

export function AttachmentChips({ attachments, onRemove }: AttachmentChipsProps) {
  if (attachments.length === 0) return null;

  return (
    <div style={{ padding: "4px 18px 2px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ font: "500 10px var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--fg-subtle)" }}>
          Files
        </span>
        {attachments.map((a) => (
          <div
            key={a.id}
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "2px 6px", borderRadius: 4,
              background: "rgba(255,255,255,0.04)", border: "0.5px solid rgba(255,255,255,0.08)",
              font: "400 11px var(--font-mono)", color: "var(--fg-muted)",
            }}
          >
            <Icon.Paperclip size={10} />
            <span style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.filename}>
              {a.filename}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                playUi("click");
                onRemove(a.id);
              }}
              style={{
                width: 14, height: 14, border: 0, padding: 0,
                borderRadius: 2, background: "transparent",
                color: "var(--fg-subtle)", cursor: "pointer",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
