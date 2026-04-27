export type Theme = "system" | "light" | "dark";

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
}

/**
 * Apply a theme with a circular-reveal ripple originating at (x, y).
 * Falls back to plain `applyTheme` when:
 *  - The browser doesn't support View Transitions (older WebKit, etc.)
 *  - The user has reduceMotion turned on
 * Pattern: chanhdai.com/components/theme-toggle-effect
 */
export async function applyThemeWithRipple(
  theme: Theme,
  origin: { x: number; y: number },
  reduceMotion: boolean = false,
) {
  if (reduceMotion || typeof document.startViewTransition !== "function") {
    applyTheme(theme);
    return;
  }

  const transition = document.startViewTransition(() => applyTheme(theme));
  await transition.ready.catch(() => {});

  const { x, y } = origin;
  const endRadius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );

  document.documentElement.animate(
    {
      clipPath: [
        `circle(0 at ${x}px ${y}px)`,
        `circle(${endRadius}px at ${x}px ${y}px)`,
      ],
    },
    {
      duration: 480,
      easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
      pseudoElement: "::view-transition-new(root)",
    },
  );
}

/** Apply the user's reduce-motion preference to the document. */
export function applyReduceMotion(reduce: boolean) {
  if (reduce) {
    document.documentElement.dataset.reduceMotion = "true";
  } else {
    delete document.documentElement.dataset.reduceMotion;
  }
}
