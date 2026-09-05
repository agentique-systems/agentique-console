import type * as React from "react";

import { cn } from "@/lib/utils";

/** A keyboard key hint. */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return <kbd data-slot="kbd" className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-muted px-1 font-mono text-2xs text-muted-foreground", className)} {...props} />;
}

export { Kbd };
