import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** The header of a top-level page: a title, an optional description, and the page's actions. */
export function PageHeader({ title, description, actions, children, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={cn("flex shrink-0 flex-col gap-3 border-b border-border px-4 py-3 md:px-6", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="text-base font-semibold leading-6">{title}</h1>
          {description !== undefined && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions !== undefined && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/** The scrolling body of a page, bounded to a comfortable reading width. */
export function PageBody({ children, className, width = "wide" }: { children: ReactNode; className?: string; width?: "narrow" | "wide" | "full" }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto flex w-full flex-col gap-4 p-4 md:p-6", width === "narrow" && "max-w-3xl", width === "wide" && "max-w-6xl", className)}>{children}</div>
    </div>
  );
}
