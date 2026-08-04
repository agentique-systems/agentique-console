"use client";

/**
 * Vendored from AI Elements (elements.ai-sdk.dev/components/queue). Local
 * changes, all deliberate:
 *   - registry import paths rewritten to this repo's `@/components/ui/*`
 *   - the attachment parts (QueueItemImage/Attachment/File) and the
 *     QueueMessage types are dropped — this console queues tasks, not uploads
 *   - QueueList no longer hardcodes max-h-40; it lives inside a resizable
 *     panel, so the caller owns the height
 *   - sizes stepped down to the console's density
 */
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export type QueueItemProps = ComponentProps<"li">;

export const QueueItem = ({ className, ...props }: QueueItemProps) => (
  <li
    className={cn(
      "group flex flex-col gap-0.5 rounded-sm px-2 py-1 text-xs transition-colors hover:bg-accent/60",
      className,
    )}
    {...props}
  />
);

export type QueueItemIndicatorProps = ComponentProps<"span"> & {
  completed?: boolean;
};

export const QueueItemIndicator = ({
  completed = false,
  className,
  ...props
}: QueueItemIndicatorProps) => (
  <span
    className={cn(
      "mt-px inline-block size-2 shrink-0 rounded-full border",
      completed
        ? "border-muted-foreground/20 bg-muted-foreground/10"
        : "border-muted-foreground/50",
      className,
    )}
    {...props}
  />
);

export type QueueItemContentProps = ComponentProps<"span"> & {
  completed?: boolean;
};

export const QueueItemContent = ({
  completed = false,
  className,
  ...props
}: QueueItemContentProps) => (
  <span
    className={cn(
      "line-clamp-1 grow break-words text-left",
      completed
        ? "text-muted-foreground/50 line-through"
        : "text-muted-foreground",
      className,
    )}
    {...props}
  />
);

export type QueueItemDescriptionProps = ComponentProps<"div"> & {
  completed?: boolean;
};

export const QueueItemDescription = ({
  completed = false,
  className,
  ...props
}: QueueItemDescriptionProps) => (
  <div
    className={cn(
      "ml-4 text-3xs",
      completed
        ? "text-muted-foreground/40 line-through"
        : "text-muted-foreground",
      className,
    )}
    {...props}
  />
);

export type QueueItemActionsProps = ComponentProps<"div">;

export const QueueItemActions = ({
  className,
  ...props
}: QueueItemActionsProps) => (
  <div className={cn("flex shrink-0 gap-1", className)} {...props} />
);

export type QueueItemActionProps = Omit<
  ComponentProps<typeof Button>,
  "variant" | "size"
>;

export const QueueItemAction = ({
  className,
  ...props
}: QueueItemActionProps) => (
  <Button
    className={cn(
      "size-auto rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted-foreground/10 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100",
      className,
    )}
    size="icon"
    type="button"
    variant="ghost"
    {...props}
  />
);

export type QueueListProps = ComponentProps<typeof ScrollArea>;

export const QueueList = ({ children, className, ...props }: QueueListProps) => (
  <ScrollArea className={cn("mt-1", className)} {...props}>
    <ul>{children}</ul>
  </ScrollArea>
);

export type QueueSectionProps = ComponentProps<typeof Collapsible>;

export const QueueSection = ({
  className,
  defaultOpen = true,
  ...props
}: QueueSectionProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

export type QueueSectionTriggerProps = ComponentProps<"button">;

export const QueueSectionTrigger = ({
  children,
  className,
  ...props
}: QueueSectionTriggerProps) => (
  <CollapsibleTrigger asChild>
    <button
      className={cn(
        "group flex w-full items-center justify-between rounded-sm px-2 py-1 text-left text-3xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent/60",
        className,
      )}
      type="button"
      {...props}
    >
      {children}
    </button>
  </CollapsibleTrigger>
);

export type QueueSectionLabelProps = ComponentProps<"span"> & {
  count?: number;
  label: string;
  icon?: ReactNode;
};

export const QueueSectionLabel = ({
  count,
  label,
  icon,
  className,
  ...props
}: QueueSectionLabelProps) => (
  <span className={cn("flex items-center gap-1.5", className)} {...props}>
    <ChevronDownIcon className="size-3 transition-transform group-data-[state=closed]:-rotate-90" />
    {icon}
    <span>
      {count} {label}
    </span>
  </span>
);

export type QueueSectionContentProps = ComponentProps<typeof CollapsibleContent>;

export const QueueSectionContent = ({
  className,
  ...props
}: QueueSectionContentProps) => (
  <CollapsibleContent className={cn(className)} {...props} />
);

export type QueueProps = ComponentProps<"div">;

export const Queue = ({ className, ...props }: QueueProps) => (
  <div className={cn("flex flex-col gap-1", className)} {...props} />
);
