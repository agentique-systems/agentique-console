"use client";

import {
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
  ExternalLinkIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** Inlined from the `ai` dependency: the console's three tool phases. */
export type ToolState =
  | "input-available"
  | "output-available"
  | "output-error";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose mb-4 w-full rounded-md border", className)}
    {...props}
  />
);

const statusLabels: Record<ToolState, string> = {
  "input-available": "Running",
  "output-available": "Completed",
  "output-error": "Error",
};

const statusIcons: Record<ToolState, ReactNode> = {
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "output-available": (
    <CheckCircleIcon className="size-4 text-status-completed" />
  ),
  "output-error": <XCircleIcon className="size-4 text-status-failed" />,
};

export const getStatusBadge = (status: ToolState) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export type ToolHeaderProps = {
  toolName: string;
  state: ToolState;
  className?: string;
  /**
   * Local addition: the card also nests inside a chain-of-thought step, where
   * the step already carries the human sentence and this is only the "show me
   * the raw call" affordance. Compact shrinks it to that job.
   */
  compact?: boolean;
};

export const ToolHeader = ({
  className,
  toolName,
  state,
  compact = false,
}: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn(
      "flex w-full items-center justify-between gap-4",
      compact ? "gap-2 p-1.5" : "p-3",
      className,
    )}
  >
    <div className="flex min-w-0 items-center gap-2">
      <WrenchIcon
        className={cn("shrink-0 text-muted-foreground", compact ? "size-3" : "size-4")}
      />
      <span
        className={cn(
          "truncate font-medium",
          compact ? "font-mono text-2xs" : "text-sm",
        )}
      >
        {toolName}
      </span>
      {compact ? null : getStatusBadge(state)}
    </div>
    <ChevronDownIcon
      className={cn(
        "shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180",
        compact ? "size-3" : "size-4",
      )}
    />
  </CollapsibleTrigger>
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
);

/** Plain <pre> JSON — deliberately no CodeBlock/shiki (no heavy deps). */
const JsonBlock = ({ value }: { value: unknown }) => (
  <pre className="overflow-x-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap break-words">
    {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
  </pre>
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: unknown;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <JsonBlock value={input} />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: unknown;
  errorText?: string | undefined;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (output === undefined && errorText === undefined) {
    return null;
  }

  const artifact = typeof output === "object" && output !== null && typeof (output as { artifactId?: unknown }).artifactId === "string"
    ? output as { artifactId: string; bytes?: number }
    : null;

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText !== undefined ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs",
          errorText !== undefined
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground",
        )}
      >
        {errorText !== undefined && <div className="px-3 pt-2">{errorText}</div>}
        {artifact !== null && (
          <a className="mx-3 mt-3 flex w-fit items-center gap-1 text-xs text-primary underline underline-offset-2" href={`/api/artifacts/${artifact.artifactId}`} target="_blank" rel="noreferrer">
            Open complete artifact{artifact.bytes === undefined ? "" : ` (${artifact.bytes.toLocaleString()} bytes)`}
            <ExternalLinkIcon className="size-3" />
          </a>
        )}
        {output !== undefined && <JsonBlock value={output} />}
      </div>
    </div>
  );
};
