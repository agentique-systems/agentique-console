import * as React from "react";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** The browser's own select, styled like an Input: closed option sets need nothing more. */
function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <span className="relative inline-flex w-full">
      <select
        data-slot="native-select"
        className={cn(
          "h-8 w-full appearance-none rounded-md border border-input bg-background py-1 pr-8 pl-2.5 text-sm outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}

export { NativeSelect };
