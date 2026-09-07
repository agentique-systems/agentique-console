import { PanelLeftCloseIcon, PanelLeftOpenIcon, SearchIcon } from "lucide-react";
import { NavLink, useLocation } from "react-router";
import type { WorkspaceResponse } from "@agentique-console/core";

import { BrandMark, Wordmark } from "@/app/brand";
import { NAV_ITEMS } from "@/app/navigation";
import { ThemeToggle } from "@/app/theme-toggle";
import { ConnectionStatus } from "@/components/connection-status";
import { CountBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MOD_KEY } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import { useNeedsOperatorCount } from "@/runs/needs-operator";
import { useUiStore } from "@/stores/ui";
import { WorkspaceSelector } from "@/workspaces/workspace-selector";

/**
 * The primary navigation. On a wide viewport it is a rail that collapses to
 * icons; inside the drawer (`inSheet`) it is always expanded and closes on
 * navigation.
 */
export function Sidebar({ workspace, onOpenPalette, inSheet = false, onNavigate }: { workspace: WorkspaceResponse; onOpenPalette: () => void; inSheet?: boolean; onNavigate?: () => void }) {
  const collapsedPreference = useUiStore((s) => s.sidebarCollapsed);
  const toggle = useUiStore((s) => s.toggleSidebar);
  const collapsed = inSheet ? false : collapsedPreference;
  const { pathname } = useLocation();
  const needsOperator = useNeedsOperatorCount(workspace.workspace.id);
  return (
    <aside data-testid="sidebar" data-collapsed={collapsed || undefined} className={cn("flex h-full shrink-0 flex-col bg-sidebar text-sidebar-foreground", inSheet ? "w-full" : "border-r border-sidebar-border", collapsed ? "w-14" : "w-60")}>
      <div className={cn("flex h-12 shrink-0 items-center gap-2 px-3", collapsed && "justify-center px-0")}>
        <BrandMark />
        {!collapsed && <Wordmark className="flex-1" />}
        {!inSheet && !collapsed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-xs" variant="ghost" className="text-muted-foreground" onClick={toggle} aria-label="Collapse sidebar">
                <PanelLeftCloseIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Collapse sidebar</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className={cn("flex flex-col gap-1 px-2 pb-2", collapsed && "items-center")}>
        <WorkspaceSelector selected={workspace} variant={collapsed ? "icon" : "sidebar"} />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onOpenPalette}
              className={cn("flex h-8 items-center gap-2 rounded-md border border-border bg-background/60 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", collapsed ? "w-8 justify-center" : "w-full px-2")}
              aria-label="Search and commands"
              data-testid="palette-trigger"
            >
              <SearchIcon className="size-3.5 shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">Search…</span>
                  <Kbd>{MOD_KEY}</Kbd>
                  <Kbd>K</Kbd>
                </>
              )}
            </button>
          </TooltipTrigger>
          {collapsed && <TooltipContent side="right">Search and commands ({MOD_KEY} K)</TooltipContent>}
        </Tooltip>
      </div>

      <nav aria-label="Primary navigation" className={cn("flex flex-1 flex-col gap-0.5 px-2", collapsed && "items-center")}>
        {NAV_ITEMS.map((item) => {
          const active = item.matches(pathname);
          const badge = item.to === "/runs" ? needsOperator : 0;
          const link = (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              aria-label={collapsed ? item.label : undefined}
              className={cn(
                "group relative flex h-8 items-center gap-2.5 rounded-md text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                collapsed ? "w-8 justify-center" : "w-full px-2",
                active ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <item.Icon className="size-4 shrink-0" aria-hidden />
              {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
              {badge > 0 && <CountBadge count={badge} className={cn(collapsed && "absolute -top-1 -right-1")} data-testid="needs-operator-count" />}
            </NavLink>
          );
          return collapsed ? (
            <Tooltip key={item.to}>
              <TooltipTrigger asChild>{link}</TooltipTrigger>
              <TooltipContent side="right">
                {item.label}
                {badge > 0 && ` · ${badge} need${badge === 1 ? "s" : ""} you`}
              </TooltipContent>
            </Tooltip>
          ) : (
            link
          );
        })}
      </nav>

      <div className={cn("flex shrink-0 flex-col gap-2 border-t border-sidebar-border p-2", collapsed && "items-center")}>
        <div className={cn("flex items-center", collapsed ? "flex-col gap-2" : "justify-between gap-2 px-1")}>
          <ConnectionStatus compact={collapsed} />
          {!collapsed && <ThemeToggle />}
          {!inSheet && collapsed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-xs" variant="ghost" className="text-muted-foreground" onClick={toggle} aria-label="Expand sidebar">
                  <PanelLeftOpenIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Expand sidebar</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </aside>
  );
}
