import type * as React from "react";
import { Separator as SeparatorPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * `subtle` picks --border-subtle: a divider INSIDE a card, one step nearer the
 * surface than the structural borders that separate panels.
 */
function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  subtle = false,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root> & {
  subtle?: boolean;
}) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        subtle ? "bg-border-subtle" : "bg-border",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
