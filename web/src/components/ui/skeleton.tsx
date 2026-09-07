import type * as React from "react";

import { cn } from "@/lib/utils";

/** A loading placeholder shaped like the content it stands in for. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" aria-hidden className={cn("console-skeleton rounded-md", className)} {...props} />;
}

/** A few text lines of skeleton, for a paragraph or a list. */
function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="h-3.5" style={{ width: `${i === lines - 1 ? 55 : 90 - (i % 3) * 10}%` }} />
      ))}
    </div>
  );
}

export { Skeleton, SkeletonLines };
