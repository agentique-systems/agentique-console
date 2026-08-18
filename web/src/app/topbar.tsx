import { NavLink } from "react-router";
import { SystemPauseControl } from "@/app/system-pause";
import { ThemeToggle } from "@/app/theme-toggle";
import { WorkspaceSelector } from "@/workspaces/workspace-selector";
import { cn } from "@/lib/utils";

const VIEWS = [["/sessions", "Sessions"], ["/agents", "Agents"], ["/tasks", "Tasks"], ["/timelines", "Timelines"]] as const;
export function Topbar() {
  return <header data-testid="topbar" className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-sidebar px-3 text-2xs">
    <nav className="flex h-full items-center gap-1" aria-label="Primary navigation">{VIEWS.map(([to, label]) => <NavLink key={to} to={to} className={({ isActive }) => cn("flex h-full items-center border-b-2 border-transparent px-2 text-muted-foreground hover:text-foreground", isActive && "border-primary text-foreground")}>{label}</NavLink>)}</nav>
    <div className="h-4 w-px bg-border" /><WorkspaceSelector /><span className="flex-1" /><SystemPauseControl /><ThemeToggle />
  </header>;
}
