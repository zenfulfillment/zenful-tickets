import * as React from "react";
import { cn } from "@/lib/utils";

// Wrapper over the app's existing `.textarea` CSS class. Same story as
// ui/input.tsx — re-applied each time the shadcn CLI overwrites this
// file as a transitive dep of a registry install.
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn("textarea", className)}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
