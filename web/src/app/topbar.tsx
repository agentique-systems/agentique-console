import { Columns3Icon, PanelLeftIcon, PanelRightIcon } from "lucide-react";

import { ThemeToggle } from "@/app/theme-toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  PANEL_LABEL,
  usePanelsStore,
  type CollapsiblePanel,
} from "@/stores/panels";
import { WorkspaceSelector } from "@/workspaces/workspace-selector";

const RAILS: readonly { panel: CollapsiblePanel; Icon: typeof PanelLeftIcon }[] =
  [
    { panel: "sidebar", Icon: PanelLeftIcon },
    { panel: "strip", Icon: Columns3Icon },
    { panel: "inspector", Icon: PanelRightIcon },
  ];

function RailToggle({
  panel,
  Icon,
}: {
  panel: CollapsiblePanel;
  Icon: typeof PanelLeftIcon;
}) {
  const collapsed = usePanelsStore((s) => s.collapsed[panel]);
  const toggle = usePanelsStore((s) => s.toggle);
  const label = `${collapsed ? "show" : "hide"} ${PANEL_LABEL[panel]}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={!collapsed}
          className={cn(
            "rounded-sm p-1 transition-colors hover:bg-accent",
            collapsed ? "text-muted-foreground/50" : "text-muted-foreground",
          )}
          onClick={() => toggle(panel)}
        >
          <Icon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The one piece of chrome that spans every column: which workspace the console
 * is looking at, which rails are folded, and the colour theme. Rails on the
 * left next to the thing they fold; global settings on the right.
 */
export function Topbar() {
  return (
    <div
      data-testid="topbar"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2 text-2xs text-muted-foreground"
    >
      <div className="flex items-center gap-0.5">
        {RAILS.map(({ panel, Icon }) => (
          <RailToggle key={panel} panel={panel} Icon={Icon} />
        ))}
      </div>
      <div className="h-4 w-px shrink-0 bg-border" />
      <WorkspaceSelector />
      <span className="flex-1" />
      <ThemeToggle />
    </div>
  );
}
