// Shared UI primitives. Visual style ported from _design/; behavior rebuilt.
//
// `Toggle` and `Spinner` were removed in favor of:
//   - `Switch` (animate-ui-base) — for all on/off settings
//   - `Spinner` (ui/spinner)      — for all loading affordances
// `Button`, `Input`, `Textarea` live under `components/ui/` and should be used
// instead of raw HTML elements at every call site.

import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { playUi } from "../lib/ui-sounds";

// ─── Segmented ───────────────────────────────────────────────

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: { label: string; value: T }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className={clsx("segmented", size === "sm" && "segmented-sm")}>
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? "active" : ""}
          onClick={() => {
            if (o.value !== value) playUi("toggle");
            onChange(o.value);
          }}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Menu (popover select) ───────────────────────────────────

export interface MenuItem<V> {
  value: V;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export function Menu<V extends string | number>({
  trigger,
  items,
  value,
  onSelect,
  align = "left",
}: {
  trigger: ReactNode;
  items: MenuItem<V>[];
  value?: V;
  onSelect: (v: V) => void;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-block" }}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div
          className="card fade-in"
          style={{
            position: "absolute",
            [align]: 0,
            top: "calc(100% + 6px)",
            minWidth: 200,
            maxHeight: 320,
            overflowY: "auto",
            padding: 4,
            zIndex: 50,
            background: "var(--bg-elevated)",
          }}
        >
          {items.map((item) => {
            const active = item.value === value;
            return (
              <button
                key={String(item.value)}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  onSelect(item.value);
                  setOpen(false);
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 10px",
                  background: active ? "var(--accent-soft)" : "transparent",
                  color: active ? "var(--accent)" : "var(--fg)",
                  border: 0,
                  borderRadius: 7,
                  font: "500 13px var(--font-text)",
                  cursor: item.disabled ? "not-allowed" : "pointer",
                  opacity: item.disabled ? 0.5 : 1,
                  textAlign: "left",
                  letterSpacing: "-0.005em",
                  transition: "background 120ms ease",
                }}
                onMouseEnter={(e) => {
                  if (!active && !item.disabled) e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = "transparent";
                }}
              >
                {item.icon}
                <span style={{ flex: 1 }}>{item.label}</span>
                {active && <Icon.Check size={12} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── ThinkingDots ────────────────────────────────────────────

export function ThinkingDots() {
  return (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 4, height: 4, borderRadius: "50%",
            background: "currentColor",
            animation: `pulse-dot 1.1s ease-in-out ${i * 0.15}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

// ─── VoiceWave ───────────────────────────────────────────────

export function VoiceWave({ active }: { active: boolean }) {
  return (
    <span style={{ display: "inline-flex", gap: 2, alignItems: "center", height: 14 }}>
      {[0.5, 1, 0.7, 1.1, 0.6].map((scale, i) => (
        <span
          key={i}
          style={{
            width: 2, height: 10,
            borderRadius: 1,
            background: "currentColor",
            transformOrigin: "center",
            animation: active
              ? `wave ${0.75 + scale * 0.3}s ease-in-out ${i * 0.08}s infinite`
              : undefined,
            transform: active ? undefined : "scaleY(0.3)",
          }}
        />
      ))}
    </span>
  );
}

// ─── HotkeyCapture ───────────────────────────────────────────

import { captureFromEvent, formatComboParts } from "../lib/hotkey";
import { Button } from "./ui/button";

export function HotkeyCapture({
  value,
  onChange,
  defaultValue,
}: {
  value: string;
  onChange: (combo: string) => void;
  /** If provided, shows a "Reset" button. */
  defaultValue?: string;
}) {
  const [capturing, setCapturing] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const onKey = (e: React.KeyboardEvent) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setCapturing(false);
      setPending(null);
      setHint(null);
      return;
    }
    const r = captureFromEvent(e);
    if (r.combo) {
      setPending(r.combo);
      setHint(null);
    } else if (r.hint) {
      setHint(r.hint);
    }
  };

  const commit = () => {
    if (pending) onChange(pending);
    setCapturing(false);
    setPending(null);
    setHint(null);
  };

  const cancel = () => {
    setCapturing(false);
    setPending(null);
    setHint(null);
  };

  const display = pending ?? value;
  const parts = formatComboParts(display);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {capturing ? (
        <div
          tabIndex={0}
          autoFocus
          ref={(el) => el?.focus()}
          onKeyDown={onKey}
          onBlur={cancel}
          style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            minWidth: 120, height: 28, padding: "0 10px",
            borderRadius: 7,
            border: "0.5px solid var(--accent)",
            background: "var(--accent-soft)",
            color: "var(--fg)",
            font: "500 12.5px var(--font-text)",
            outline: "none",
            cursor: "text",
          }}
        >
          {pending ? (
            parts.map((p, i) => <kbd key={i} style={{ fontSize: 11 }}>{p}</kbd>)
          ) : (
            <span style={{ color: "var(--fg-muted)" }}>Press a combo…</span>
          )}
        </div>
      ) : (
        <Button
          variant="default"
          size="sm"
          onClick={() => setCapturing(true)}
          style={{ minWidth: 120, gap: 4 }}
        >
          {parts.map((p, i) => <kbd key={i} style={{ fontSize: 11 }}>{p}</kbd>)}
        </Button>
      )}
      {capturing && pending && (
        <Button variant="primary" size="sm" onMouseDown={(e) => { e.preventDefault(); commit(); }}>
          Save
        </Button>
      )}
      {capturing && (
        <Button variant="ghost" size="sm" onMouseDown={(e) => { e.preventDefault(); cancel(); }}>
          Cancel
        </Button>
      )}
      {!capturing && defaultValue && value !== defaultValue && (
        <Button variant="ghost" size="sm" onClick={() => onChange(defaultValue)}>
          Reset
        </Button>
      )}
      {capturing && hint && (
        <span style={{ font: "400 11px var(--font-text)", color: "var(--fg-subtle)" }}>{hint}</span>
      )}
    </div>
  );
}

// ─── Kbd ─────────────────────────────────────────────────────

export function Kbd({ children, dark }: { children: ReactNode; dark?: boolean }) {
  return (
    <kbd
      style={
        dark
          ? {
              background: "rgba(255,255,255,0.18)",
              border: "0.5px solid rgba(255,255,255,0.18)",
              color: "white",
            }
          : undefined
      }
    >
      {children}
    </kbd>
  );
}
