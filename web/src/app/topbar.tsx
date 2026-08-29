import { NavLink } from "react-router";
import { Bot, Clock3, Command, ListChecks, MessageSquareMore } from "lucide-react";
import { SystemPauseControl } from "@/app/system-pause";
import { ThemeToggle } from "@/app/theme-toggle";
import { WorkspaceSelector } from "@/workspaces/workspace-selector";
import { cn } from "@/lib/utils";

const VIEWS = [
  ["/sessions", "Sessions", MessageSquareMore],
  ["/agents", "Agents", Bot],
  ["/tasks", "Tasks", ListChecks],
  ["/timelines", "Timeline", Clock3],
] as const;

export function Topbar() {
  return <header data-testid="topbar" className="surface-raised flex h-14 shrink-0 items-center gap-4 border-b border-border bg-sidebar px-3 text-xs md:px-4">
    <div className="flex shrink-0 items-center gap-2.5">
      <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm" aria-hidden="true"><Command className="size-4" /></div>
      <div className="hidden leading-none sm:block"><div className="font-semibold tracking-tight">Agentique</div><div className="mt-1 text-3xs uppercase tracking-widest text-muted-foreground">Console</div></div>
    </div>
    <nav className="flex h-9 items-center gap-1 rounded-lg border border-border bg-background/70 p-1" aria-label="Primary navigation">{VIEWS.map(([to, label, Icon]) => <NavLink key={to} to={to} aria-label={label} className={({ isActive }) => cn("flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", isActive && "bg-card text-foreground shadow-sm ring-1 ring-border") }><Icon className="size-3.5" /><span className="hidden lg:inline">{label}</span></NavLink>)}</nav>
    <div className="hidden h-5 w-px bg-border md:block" /><div className="hidden md:block"><WorkspaceSelector /></div><span className="flex-1" />
    <div className="hidden items-center gap-1.5 text-3xs text-muted-foreground xl:flex"><span className="size-1.5 rounded-full bg-status-completed" />System healthy</div>
    <SystemPauseControl /><ThemeToggle />
  </header>;
}
