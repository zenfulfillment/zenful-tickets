import { useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Icon } from "./Icon";
import { playUi } from "../lib/ui-sounds";
import { SUPPORTED_EXTENSIONS } from "../lib/use-draft-attachments";

/**
 * The "+" button that lives in the prompt input footer. Clicking it opens
 * a dropdown that explains the attachment rules and offers a click-to-browse
 * affordance. Drag-drop and paste are wired separately at the textarea level
 * — this menu is the "discoverable" entry point for users who don't know
 * those shortcuts exist.
 *
 * Visual language deliberately mirrors the existing ModelSelector trigger
 * (28px height, transparent background, accent on hover) so the composer
 * footer reads as a coherent row of chips rather than a button salad.
 */
export interface AttachmentMenuProps {
  /** Called when the user picks files via the native picker. */
  onFiles: (files: FileList) => void;
  /** Number of attachments currently in this draft — drives the chip count badge. */
  count: number;
  /** Hard cap on attachments per draft. */
  maxCount: number;
  /** Disabled when the cap is reached. */
  disabled?: boolean;
}

const ACCEPT_ATTR = SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(",");

export function AttachmentMenu({
  onFiles,
  count,
  maxCount,
  disabled,
}: AttachmentMenuProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleBrowse = () => {
    playUi("click");
    inputRef.current?.click();
  };

  const isFull = count >= maxCount;
  const effectivelyDisabled = disabled || isFull;

  return (
    <>
      {/* Hidden native file input — driven by the "Browse files" item.
          Living outside the dropdown so closing the menu doesn't unmount it
          mid-pick on slow filesystems. */}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onFiles(e.target.files);
          }
          // Reset so picking the same file twice fires onChange both times.
          e.target.value = "";
        }}
      />

      <DropdownMenu>
        {/* BaseUI's Trigger uses the `render` prop pattern (not Radix's
            `asChild`) — passing a JSX element clones it with the trigger's
            internal props (ARIA, click handler, focus management) merged in. */}
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              // Plain <button> rather than our <Button> for the same reason
              // PromptModelPicker uses one — bespoke composer-chip styling
              // shouldn't inherit the .btn class.
              onClick={() => playUi("click")}
              disabled={effectivelyDisabled}
              title={isFull ? `Max ${maxCount} attachments` : "Add attachment"}
              aria-label="Add attachment"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                padding: 0,
                background: count > 0 ? "var(--accent-soft)" : "transparent",
                color: count > 0 ? "var(--accent)" : "var(--fg-muted)",
                border: "0.5px solid transparent",
                borderRadius: 8,
                cursor: effectivelyDisabled ? "not-allowed" : "pointer",
                opacity: effectivelyDisabled ? 0.5 : 1,
                transition: "background 140ms ease, color 140ms ease",
              }}
            >
              <Icon.Plus size={16} />
            </button>
          }
        />

        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          // Width sized to the rules block. The menu is mostly informational
          // — only one actionable item — so we let the body breathe rather
          // than cramming it into a typical 220px menu.
          style={{
            width: 320,
            padding: 14,
            background: "var(--bg-card)",
            backdropFilter: "blur(40px) saturate(180%)",
            WebkitBackdropFilter: "blur(40px) saturate(180%)",
            border: "0.5px solid var(--border-strong)",
            borderRadius: 14,
            boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
          }}
        >
          <div
            style={{
              font: "600 13px var(--font-text)",
              color: "var(--fg)",
              marginBottom: 6,
              letterSpacing: "-0.01em",
            }}
          >
            Add attachments
          </div>
          <div
            style={{
              font: "400 12px var(--font-text)",
              color: "var(--fg-muted)",
              lineHeight: 1.55,
              marginBottom: 12,
            }}
          >
            Drop files into the prompt, paste an image with{" "}
            <kbd style={{ fontFamily: "var(--font-mono)" }}>⌘V</kbd>, or
            browse below.
          </div>

          <button
            type="button"
            onClick={handleBrowse}
            disabled={effectivelyDisabled}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              width: "100%",
              padding: "12px 14px",
              background: "var(--bg-elevated)",
              border: "0.5px dashed var(--border-strong)",
              borderRadius: 10,
              color: "var(--fg)",
              font: "500 12.5px var(--font-text)",
              cursor: effectivelyDisabled ? "not-allowed" : "pointer",
              opacity: effectivelyDisabled ? 0.5 : 1,
              transition: "background 140ms ease",
            }}
            onMouseEnter={(e) => {
              if (!effectivelyDisabled) {
                e.currentTarget.style.background = "var(--bg-active)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--bg-elevated)";
            }}
          >
            <Icon.Paperclip size={13} />
            Browse files
          </button>

          {/* Rules block. Phrased as guidance, not warnings — most users
              won't hit any of these caps in normal use. */}
          <div
            style={{
              marginTop: 12,
              paddingTop: 10,
              borderTop: "0.5px solid var(--border)",
              display: "grid",
              gap: 4,
              font: "400 11.5px var(--font-text)",
              color: "var(--fg-subtle)",
              lineHeight: 1.5,
            }}
          >
            <div>
              <strong style={{ color: "var(--fg-muted)", fontWeight: 500 }}>
                Formats
              </strong>{" "}
              · png, jpg, pdf, xlsx, docx, csv, txt
            </div>
            <div>
              <strong style={{ color: "var(--fg-muted)", fontWeight: 500 }}>
                Size
              </strong>{" "}
              · up to 10 MB per file
            </div>
            <div>
              <strong style={{ color: "var(--fg-muted)", fontWeight: 500 }}>
                Limit
              </strong>{" "}
              · {count} of {maxCount} attached
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
