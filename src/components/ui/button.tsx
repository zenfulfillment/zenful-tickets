import * as React from "react";
import { cn } from "@/lib/utils";
import { playUi } from "@/lib/ui-sounds";

// Hybrid Button.
//
// This file gets repeatedly overwritten by shadcn registry installs (every
// time we add a component that depends on `@/components/ui/button`). To
// keep the rest of the app from breaking each time, this version supports
// BOTH:
//
//   1. Our app's legacy API — variant="primary" / size="iconSm" / silent —
//      which is what most call sites already use, and styles via the
//      existing `.btn` CSS family in src/styles/index.css using app design
//      tokens (--accent, --bg-input, --fg, etc).
//
//   2. The shadcn defaults — variant="outline"|"secondary"|"link",
//      size="icon-sm"|"icon-xs"|"icon-lg"|"xs"|"lg" — that fresh registry
//      installs (dialog, model-selector, etc.) reach for. We translate
//      them onto the closest legacy equivalent so they render correctly
//      against our design tokens instead of expecting Tailwind's
//      `bg-primary` / `text-primary-foreground` (we don't define those).
//
// If you're tempted to "clean this up" by adopting one or the other —
// don't, until either every call site has been migrated or shadcn lets us
// pin a non-overwriting copy. The dual surface is the path of least
// breakage.

type ButtonVariant =
  | "default"
  | "primary"
  | "ghost"
  | "destructive"
  | "outline"
  | "secondary"
  | "link";

type ButtonSize =
  | "default"
  | "sm"
  | "lg"
  | "xs"
  | "pill"
  | "icon"
  | "iconSm"
  | "icon-sm"
  | "icon-xs"
  | "icon-lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Plays the UI click sound on press unless `false`. */
  sound?: boolean;
  /** Suppress the UI click sound. Inverse alias of `sound`. */
  silent?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", sound, silent, onClick, children, type, ...props }, ref) => {
    const playSound = sound !== false && silent !== true;

    const sizeStyle: React.CSSProperties = (() => {
      switch (size) {
        case "sm":
        case "xs":
          return { height: 26, padding: "0 10px", fontSize: 12.5 };
        case "lg":
          return { height: 34, padding: "0 16px", fontSize: 13.5 };
        case "icon":
          return { width: 30, height: 30, padding: 0, justifyContent: "center" };
        case "iconSm":
        case "icon-sm":
          return { width: 26, height: 26, padding: 0, justifyContent: "center" };
        case "icon-xs":
          return { width: 22, height: 22, padding: 0, justifyContent: "center", fontSize: 11 };
        case "icon-lg":
          return { width: 34, height: 34, padding: 0, justifyContent: "center" };
        default:
          return {};
      }
    })();

    return (
      <button
        ref={ref}
        type={type ?? "button"}
        data-slot="button"
        className={cn(
          "btn",
          variant === "primary" && "btn-primary",
          variant === "ghost" && "btn-ghost",
          variant === "destructive" && "btn-destructive",
          variant === "link" && "btn-link",
          // outline + secondary fall through to the base .btn appearance —
          // intentional, since our base `.btn` already reads as a subtle
          // outlined button against the app's surface tokens.
          size === "pill" && "btn-pill",
          className,
        )}
        style={{ ...sizeStyle, ...(props.style ?? {}) }}
        onClick={(e) => {
          if (playSound && !props.disabled) playUi("click");
          onClick?.(e);
        }}
        {...props}
      >
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
