import * as React from "react";
import { cn } from "@/lib/utils";

// Wrapper over the app's existing `.input` CSS class
// (src/styles/index.css). Same rationale as ui/button.tsx — keep the
// styling in CSS land using our design tokens rather than the shadcn /
// Tailwind defaults that fresh registry installs assume. Re-applied each
// time the shadcn CLI overwrites this file.
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      data-slot="input"
      className={cn("input", className)}
      {...props}
    />
  ),
);
Input.displayName = "Input";
