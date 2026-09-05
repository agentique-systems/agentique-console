import { useEffect, useRef } from "react";
import { NavLink } from "react-router";
import type { RunOverview } from "@agentique-console/core";

import { CountBadge } from "@/components/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { RUN_SECTIONS, type RunTab } from "@/run/sections";

/**
 * The Run's sections. `rail` is the vertical list beside the content on a wide
 * viewport; `strip` is the horizontally scrolling row above it elsewhere. Both
 * carry the same badges, so nothing needing the operator hides in a section.
 */
export function RunNav({ overview, active, orientation }: { overview: RunOverview; active: RunTab; orientation: "rail" | "strip" }) {
  const activeRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (orientation === "strip") activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, orientation]);
  const rail = orientation === "rail";
  return (
    <nav aria-label="Run sections" className={cn(rail ? "flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-sidebar/60 p-2" : "scrollbar-none flex shrink-0 gap-0.5 overflow-x-auto border-b border-border px-2")}>
      {RUN_SECTIONS.map((section) => {
        const count = section.needsOperator(overview);
        const current = section.id === active;
        const link = (
          <NavLink
            key={section.id}
            ref={current ? activeRef : undefined}
            to={`/runs/${overview.run.id}/${section.id}`}
            aria-current={current ? "page" : undefined}
            data-testid={`tab-${section.id}`}
            className={cn(
              "flex shrink-0 items-center gap-2 text-sm whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
              rail ? "h-8 rounded-md px-2" : "h-9 border-b-2 px-2.5 text-xs",
              current ? (rail ? "bg-sidebar-accent font-medium text-foreground" : "border-foreground font-medium text-foreground") : rail ? "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <section.Icon className={cn("shrink-0", rail ? "size-4" : "size-3.5")} aria-hidden />
            <span className={cn(rail && "flex-1 truncate")}>{section.label}</span>
            <CountBadge count={count} data-testid={count > 0 ? `tab-${section.id}-count` : undefined} />
          </NavLink>
        );
        return rail ? (
          <Tooltip key={section.id}>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right" className="max-w-56">
              {section.description}
            </TooltipContent>
          </Tooltip>
        ) : (
          link
        );
      })}
    </nav>
  );
}
