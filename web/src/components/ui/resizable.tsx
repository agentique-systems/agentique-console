/**
 * Thin wrapper over react-resizable-panels v4.
 *
 * v4 renamed the whole surface — `Group` / `Panel` / `Separator`, not the
 * `PanelGroup` / `PanelResizeHandle` of v2-3 that shadcn's snippet assumes —
 * and replaced `autoSaveId` with the explicit `useDefaultLayout` hook. This
 * file exists so the rest of the app never has to know that.
 */
import type * as React from "react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
} from "react-resizable-panels";

import { cn } from "@/lib/utils";

function ResizableGroup({
  className,
  ...props
}: React.ComponentProps<typeof Group>) {
  return (
    <Group
      data-slot="resizable-group"
      className={cn("flex min-h-0 w-full", className)}
      {...props}
    />
  );
}

function ResizablePanel({
  className,
  ...props
}: React.ComponentProps<typeof Panel>) {
  // min-h-0 so a scrolling child can actually shrink inside the flex row.
  return (
    <Panel
      data-slot="resizable-panel"
      className={cn("flex min-h-0 min-w-0 flex-col", className)}
      {...props}
    />
  );
}

/**
 * A 1px hairline with a wider invisible hit area. The grab target is 9px, but
 * only the centre line paints — dragging a panel edge should feel like
 * dragging the border, not a widget.
 */
function ResizableHandle({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        "relative w-[9px] shrink-0 -mx-1 z-10 bg-transparent",
        "after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border after:transition-colors",
        "hover:after:bg-ring data-[state=dragging]:after:bg-ring",
        "focus-visible:outline-none focus-visible:after:bg-ring",
        className,
      )}
      {...props}
    />
  );
}

export {
  ResizableGroup,
  ResizablePanel,
  ResizableHandle,
  useDefaultLayout,
};
