// Tiny façade over sonner so the rest of the app doesn't import sonner
// directly — keeps positioning + persistence policy consistent everywhere.

import { toast } from "sonner";

export type NotifyKind = "info" | "success" | "warning" | "error";

/**
 * Regular ephemeral notification — bottom-right, auto-dismisses. Use for
 * "Saved", "Couldn't reach the API", confirmation-of-action and other
 * transient feedback.
 *
 * Position is pinned per-call so it's deterministic regardless of which
 * sub-container sonner spun up last.
 */
export function notify(message: string, opts?: { kind?: NotifyKind; description?: string }) {
  const kind = opts?.kind ?? "info";
  const fn =
    kind === "success" ? toast.success
    : kind === "warning" ? toast.warning
    : kind === "error" ? toast.error
    : toast.info;
  fn(message, { description: opts?.description, position: "bottom-right" });
}

/**
 * Persistent update-available toast — bottom-left, no auto-dismiss. Stays
 * onscreen until the user picks an action (Install or Skip). The id is stable
 * so calling notifyUpdate twice doesn't stack duplicate toasts.
 */
export function notifyUpdate(opts: {
  version: string;
  onInstall: () => void | Promise<void>;
  onSkip: () => void;
}) {
  toast(`Update available: v${opts.version}`, {
    id: "update-available",
    position: "bottom-left",
    duration: Infinity,
    description: "Restart to install the latest version.",
    action: {
      label: "Install",
      onClick: () => void opts.onInstall(),
    },
    cancel: {
      label: "Skip",
      onClick: () => opts.onSkip(),
    },
  });
}

export function dismissUpdate() {
  toast.dismiss("update-available");
}
