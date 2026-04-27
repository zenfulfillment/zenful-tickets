// Sonner Toaster — wired to our app's design tokens and theme.
//
// Two routing rules per the app's UX spec:
//   - regular notifications  → bottom-left, auto-dismiss
//   - "update available"     → bottom-right, never auto-dismisses (waits for
//                              the user to take an action like "Skip" / "Install")
//
// One Toaster instance handles both: the bottom-left position is the default,
// and individual toast calls override `position` when they need bottom-right
// (see lib/notify.ts → notifyUpdate).
//
// We don't rely on `next-themes` (we own our theme via `data-theme` on
// documentElement). The toast's surface colours come from our existing
// `--bg-card`, `--fg`, `--border` tokens so it visually matches the rest of
// the app's glass-card aesthetic.

import { useEffect, useState } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const readTheme = (): "light" | "dark" => {
  if (typeof window === "undefined") return "light";
  const pinned = document.documentElement.getAttribute("data-theme");
  if (pinned === "dark") return "dark";
  if (pinned === "light") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const Toaster = (props: ToasterProps) => {
  const [theme, setTheme] = useState<"light" | "dark">(readTheme);

  useEffect(() => {
    const ob = new MutationObserver(() => setTheme(readTheme()));
    ob.observe(document.documentElement, { attributeFilter: ["data-theme"], attributes: true });
    const mql = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(readTheme());
    mql?.addEventListener("change", onChange);
    return () => {
      ob.disconnect();
      mql?.removeEventListener("change", onChange);
    };
  }, []);

  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      className="cn-toaster"
      style={
        {
          "--normal-bg": "var(--bg-card)",
          "--normal-text": "var(--fg)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--bg-card)",
          "--success-text": "var(--fg)",
          "--error-bg": "var(--bg-card)",
          "--error-text": "var(--fg)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: { toast: "cn-toast" },
      }}
      {...props}
    />
  );
};

export { Toaster };
