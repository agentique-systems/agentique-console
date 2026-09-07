import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** Nothing here yet: says what would be here, and how it gets here. */
export function EmptyState({ icon: Icon, title, description, action, className, compact = false, ...props }: { icon?: LucideIcon; title: string; description?: ReactNode; action?: ReactNode; className?: string; compact?: boolean; "data-testid"?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "gap-1.5 px-4 py-6" : "gap-2 px-6 py-12", className)} {...props}>
      {Icon !== undefined && (
        <span className={cn("flex items-center justify-center rounded-lg border border-border bg-muted/50 text-muted-foreground", compact ? "size-8" : "mb-1 size-10")} aria-hidden>
          <Icon className={compact ? "size-4" : "size-5"} />
        </span>
      )}
      <p className={cn("font-medium text-foreground", compact ? "text-xs" : "text-sm")}>{title}</p>
      {description !== undefined && <p className={cn("max-w-sm text-muted-foreground", compact ? "text-2xs" : "text-xs")}>{description}</p>}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}
