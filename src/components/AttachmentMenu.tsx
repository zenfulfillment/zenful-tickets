import { useCallback, useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useGlobalTooltip } from "./ui/global-tooltip";
import { Icon } from "./Icon";
import { playUi } from "../lib/ui-sounds";
import { SUPPORTED_EXTENSIONS } from "../lib/use-draft-attachments";

export interface AttachmentMenuProps {
  onFiles: (files: FileList) => void;
  count: number;
  maxCount: number;
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
  const wrapRef = useRef<HTMLSpanElement>(null);
  const { showTooltip, hideTooltip } = useGlobalTooltip();

  const handleBrowse = () => {
    playUi("click");
    inputRef.current?.click();
  };

  const isFull = count >= maxCount;
  const effectivelyDisabled = disabled || isFull;

  const handleMouseEnter = useCallback(() => {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    showTooltip({
      content: (
        <div>
          <div style={{ font: "600 12px var(--font-mono)", marginBottom: 2 }}>Attach Files</div>
          <div style={{ font: "400 11px var(--font-mono)", color: "var(--background)", opacity: 0.65, lineHeight: 1.5 }}>
            Files are uploaded to Jira as attachments.<br />
            Images, PDFs, spreadsheets, or documents.
          </div>
        </div>
      ),
      rect,
      side: "bottom",
      sideOffset: 10,
      align: "center",
      alignOffset: 0,
      id: "attachment-menu",
      arrow: true,
    });
  }, [showTooltip]);

  const handleMouseLeave = useCallback(() => {
    hideTooltip();
  }, [hideTooltip]);

  return (
    <>
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
          e.target.value = "";
        }}
      />

      <span
        ref={wrapRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{ display: "inline-flex" }}
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
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
                onMouseEnter={(e) => {
                  if (count === 0) {
                    e.currentTarget.style.background = "var(--bg-active)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (count === 0) {
                    e.currentTarget.style.background = "transparent";
                  }
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
          <div style={{ font: "600 13px var(--font-text)", color: "var(--fg)", marginBottom: 6, letterSpacing: "-0.01em" }}>
            Add attachments
          </div>
          <div style={{ font: "400 12px var(--font-text)", color: "var(--fg-muted)", lineHeight: 1.55, marginBottom: 12 }}>
            Drop files into the prompt, paste an image with{" "}
            <kbd style={{ fontFamily: "var(--font-mono)" }}>⌘V</kbd>, or browse below.
          </div>

          <button
            type="button"
            onClick={handleBrowse}
            disabled={effectivelyDisabled}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              width: "100%", padding: "12px 14px",
              background: "var(--bg-elevated)", border: "0.5px dashed var(--border-strong)",
              borderRadius: 10, color: "var(--fg)", font: "500 12.5px var(--font-text)",
              cursor: effectivelyDisabled ? "not-allowed" : "pointer",
              opacity: effectivelyDisabled ? 0.5 : 1, transition: "background 140ms ease",
            }}
            onMouseEnter={(e) => { if (!effectivelyDisabled) e.currentTarget.style.background = "var(--bg-active)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-elevated)"; }}
          >
            <Icon.Paperclip size={13} />
            Browse files
          </button>

          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "0.5px solid var(--border)", display: "grid", gap: 4, font: "400 11.5px var(--font-text)", color: "var(--fg-subtle)", lineHeight: 1.5 }}>
            <div><strong style={{ color: "var(--fg-muted)", fontWeight: 500 }}>Formats</strong> · png, jpg, pdf, xlsx, docx, csv, txt</div>
            <div><strong style={{ color: "var(--fg-muted)", fontWeight: 500 }}>Size</strong> · up to 10 MB per file</div>
            <div><strong style={{ color: "var(--fg-muted)", fontWeight: 500 }}>Limit</strong> · {count} of {maxCount} attached</div>
          </div>
        </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </>
  );
}
