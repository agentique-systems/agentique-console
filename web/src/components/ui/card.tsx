import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * One card treatment for the whole console. Before this, plan cards, question
 * cards, agent cards, and PLAN blocks each hand-rolled their own
 * `rounded-lg border bg-card` string and drifted apart.
 *
 * `surface-raised` is the inset top highlight from globals.css — layering
 * without a drop shadow, which reads as mud against a near-black background.
 */
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "surface-raised flex flex-col rounded-lg border border-border bg-card text-card-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex items-center gap-2 px-3 py-2", className)}
      {...props}
    />
  );
}

/** The small uppercase label that names a card's kind ("plan", "question"). */
function CardEyebrow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-eyebrow"
      className={cn(
        "flex items-center gap-2 text-3xs font-medium uppercase tracking-wider",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("text-sm font-medium leading-none", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-3 py-2 text-sm", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center gap-2 px-3 py-2", className)}
      {...props}
    />
  );
}

export { Card, CardHeader, CardEyebrow, CardTitle, CardContent, CardFooter };
