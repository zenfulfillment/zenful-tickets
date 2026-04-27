import * as React from "react";
import { cn } from "@/lib/utils";

// Re-uses the existing `siri-rotate-fast` keyframe defined in src/styles/index.css
// so the spinner spins at the same cadence as the orb's micro-rotation —
// visually consistent with the rest of the app instead of lucide's stock spin.

interface SpinnerProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
}

function Spinner({ size = 14, className, style, ...props }: SpinnerProps) {
  return (
    <svg
      role="status"
      aria-label="Loading"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      data-slot="spinner"
      className={cn(className)}
      style={{ animation: "siri-rotate-fast 0.9s linear infinite", ...style }}
      {...props}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeDasharray="12 42"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export { Spinner };
