/**
 * Animated gradient shimmer text — pure CSS, no `motion` dep. The keyframes
 * live in globals.css (`text-shimmer`): a transparent-window highlight slides
 * across a muted-foreground base via background-position.
 */
import type { CSSProperties } from "react";
import { memo } from "react";

import { cn } from "@/lib/utils";

export interface TextShimmerProps {
  children: string;
  as?: "p" | "span" | "div";
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
  const dynamicSpread = (children?.length ?? 0) * spread;

  return (
    <Component
      className={cn(
        "console-text-shimmer relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[background-repeat:no-repeat,padding-box]",
        className,
      )}
      style={
        {
          animationDuration: `${duration}s`,
          backgroundImage: `linear-gradient(90deg, #0000 calc(50% - ${dynamicSpread}px), var(--color-background), #0000 calc(50% + ${dynamicSpread}px)), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))`,
        } as CSSProperties
      }
    >
      {children}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
