import { NavLink } from "react-router";
import type { WorkspaceResponse } from "@agentique-console/core";
import { ThemeToggle } from "@/app/theme-toggle";
import { ConnectionStatus } from "@/components/connection-status";
import { cn } from "@/lib/utils";
import { WorkspaceSelector } from "@/workspaces/workspace-selector";

const VIEWS = [
  ["/conversations", "Conversations"],
  ["/agents", "Agents"],
  ["/system", "System"],
] as const;

export function Topbar({ workspace }: { workspace: WorkspaceResponse }) {
  return (
    <header data-testid="topbar" className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-sidebar px-3 text-2xs">
      <nav className="flex h-full items-center gap-1" aria-label="Primary navigation">
        {VIEWS.map(([to, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => cn("flex h-full items-center border-b-2 border-transparent px-2 text-muted-foreground hover:text-foreground", isActive && "border-primary text-foreground")}>
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="h-4 w-px bg-border" />
      <WorkspaceSelector selected={workspace} />
      <span className="flex-1" />
      <ConnectionStatus />
      <ThemeToggle />
    </header>
  );
}
