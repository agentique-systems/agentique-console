import { WorkspaceSelector } from "@/workspaces/workspace-selector";

/**
 * The one piece of chrome that spans every column: which workspace the console
 * is looking at. The trailing spacer is deliberate — anything added later lands
 * on the right without touching the selector's position.
 */
export function Topbar() {
  return (
    <div
      data-testid="topbar"
      className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-sidebar px-3 text-[11px] text-muted-foreground"
    >
      <WorkspaceSelector />
      <span className="flex-1" />
    </div>
  );
}
