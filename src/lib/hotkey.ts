// Helpers for rendering Tauri global-shortcut combo strings as readable
// keyboard glyphs, and for capturing combos from a keyboard event.

const MOD_GLYPHS_MAC: Record<string, string> = {
  cmd: "⌘", command: "⌘", super: "⌘", meta: "⌘",
  ctrl: "⌃", control: "⌃",
  alt: "⌥", option: "⌥", opt: "⌥",
  shift: "⇧",
  cmdorctrl: "⌘", commandorcontrol: "⌘",
};

const MOD_GLYPHS_OTHER: Record<string, string> = {
  cmd: "Win", command: "Win", super: "Win", meta: "Win",
  ctrl: "Ctrl", control: "Ctrl",
  alt: "Alt", option: "Alt", opt: "Alt",
  shift: "Shift",
  cmdorctrl: "Ctrl", commandorcontrol: "Ctrl",
};

const KEY_GLYPHS: Record<string, string> = {
  Space: "Space", Enter: "↩", Escape: "Esc", Tab: "⇥",
  Backspace: "⌫", Delete: "⌦",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  PageUp: "PgUp", PageDown: "PgDn", Home: "Home", End: "End",
  Backquote: "`", Minus: "-", Equal: "=",
  BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
};

function isMac() {
  return document.documentElement.dataset.platform === "macos";
}

/** Split a combo string into [modifiers[], key] */
function parseCombo(combo: string): { mods: string[]; key: string } {
  const parts = combo.split("+").filter(Boolean);
  if (parts.length === 0) return { mods: [], key: "" };
  return { mods: parts.slice(0, -1), key: parts[parts.length - 1] };
}

/** "CommandOrControl+Alt+KeyT" → ["⌘", "⌥", "T"] (or platform-appropriate). */
export function formatComboParts(combo: string): string[] {
  const { mods, key } = parseCombo(combo);
  const glyphs = isMac() ? MOD_GLYPHS_MAC : MOD_GLYPHS_OTHER;
  const out: string[] = [];
  for (const m of mods) out.push(glyphs[m.toLowerCase()] ?? m);
  out.push(formatKey(key));
  return out;
}

function formatKey(key: string): string {
  if (KEY_GLYPHS[key]) return KEY_GLYPHS[key];
  if (key.startsWith("Key") && key.length === 4) return key.slice(3); // KeyT → T
  if (key.startsWith("Digit") && key.length === 6) return key.slice(5); // Digit5 → 5
  if (key.startsWith("F") && /^F\d+$/.test(key)) return key; // F1, F12
  if (key.startsWith("Numpad")) return key.replace("Numpad", "Num");
  return key;
}

/** True iff a string is a "modifier" code from KeyboardEvent.code. */
function isModifierCode(code: string): boolean {
  return (
    code.startsWith("Meta") ||
    code.startsWith("Control") ||
    code.startsWith("Alt") ||
    code.startsWith("Shift") ||
    code.startsWith("OS")
  );
}

export interface CapturedCombo {
  combo: string | null;
  /** A reason the capture isn't usable yet, or null if it is. */
  hint: string | null;
}

/**
 * Build a Tauri-parseable combo from a `keydown` event. Returns `combo: null`
 * if only modifiers were pressed (still waiting for the actual key) or if the
 * combo is rejected (no modifiers — would catch every keystroke).
 */
export function captureFromEvent(e: KeyboardEvent | React.KeyboardEvent): CapturedCombo {
  const code = (e as KeyboardEvent).code ?? "";
  if (!code || isModifierCode(code)) {
    return { combo: null, hint: "Press a combo with at least one modifier (⌘, ⌃, ⌥, or ⇧)." };
  }
  const mods: string[] = [];
  if (e.metaKey) mods.push(isMac() ? "Cmd" : "Super");
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (mods.length === 0) {
    return { combo: null, hint: "Add at least one modifier to avoid catching plain keystrokes." };
  }
  return { combo: [...mods, code].join("+"), hint: null };
}
