"use client";

import { cn } from "@/lib/utils";
import type { MotionProps } from "motion/react";
import { motion } from "motion/react";
import type { CSSProperties, ElementType, JSX } from "react";
import { memo, useMemo } from "react";

type MotionHTMLProps = MotionProps & Record<string, unknown>;

// Cache motion components at module level to avoid creating during render
const motionComponentCache = new Map<
  keyof JSX.IntrinsicElements,
  React.ComponentType<MotionHTMLProps>
>();

const getMotionComponent = (element: keyof JSX.IntrinsicElements) => {
  let component = motionComponentCache.get(element);
  if (!component) {
    component = motion.create(element);
    motionComponentCache.set(element, component);
  }
  return component;
};

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const MotionComponent = getMotionComponent(
    Component as keyof JSX.IntrinsicElements
  );

  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread]
  );

  // Map onto OUR app's design tokens, not Tailwind's defaults.
  //
  // The upstream component used `--color-muted-foreground` for the base
  // text colour and `--color-background` for the sweep highlight. Neither
  // token is defined in our CSS (we use `--fg-subtle` / `--bg-window`
  // family), so on light-mode the text rendered with `text-transparent`
  // and an undefined fill colour — i.e. completely invisible.
  //
  // We use `--shimmer-base` (the resting text colour) and
  // `--shimmer-highlight` (the bright sweeping band) so the effect is
  // visible against any background. Defaults map to the app's foreground
  // tokens; callers can override per-instance via inline CSS variables.
  return (
    <MotionComponent
      animate={{ backgroundPosition: "0% center" }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--shimmer-highlight),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className
      )}
      initial={{ backgroundPosition: "100% center" }}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          "--shimmer-base":
            "var(--shimmer-base-color, var(--fg-subtle, #6c6c70))",
          "--shimmer-highlight":
            "var(--shimmer-highlight-color, var(--fg, #1d1d1f))",
          backgroundImage:
            "var(--bg), linear-gradient(var(--shimmer-base), var(--shimmer-base))",
        } as CSSProperties
      }
      transition={{
        duration,
        ease: "linear",
        repeat: Number.POSITIVE_INFINITY,
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
