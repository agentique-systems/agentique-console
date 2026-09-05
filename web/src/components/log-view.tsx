import { useState } from "react";
import { ArrowDownToLineIcon, WrapTextIcon } from "lucide-react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface LogChunk {
  kind: "text" | "tool_call";
  text: string;
}

/**
 * A terminal-like view of streamed output: monospace on the console surface,
 * tool calls marked, following the tail until the reader scrolls up.
 */
export function LogView({ chunks, className, maxHeight = "16rem", title, live = false }: { chunks: readonly LogChunk[]; className?: string; maxHeight?: string; title?: string; live?: boolean }) {
  const [wrap, setWrap] = useState(true);
  const text = chunks.map((c) => (c.kind === "tool_call" ? `▶ ${c.text}` : c.text)).join("\n");
  return (
    <div className={cn("flex flex-col overflow-hidden rounded-md border border-border bg-console", className)} data-live={live || undefined}>
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">{title ?? (live ? "live output" : "output")}</span>
        {live && (
          <span className="flex items-center gap-1 text-2xs text-status-running">
            <span className="console-live-dot inline-block size-1.5 rounded-full bg-status-running" aria-hidden />
            live
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-pressed={wrap} aria-label="Wrap long lines" className={cn("text-muted-foreground", wrap && "bg-accent text-foreground")} onClick={() => setWrap((v) => !v)}>
              <WrapTextIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Wrap long lines</TooltipContent>
        </Tooltip>
        <CopyButton value={text} label="Copy output" />
      </div>
      <StickToBottom className="relative min-h-0" resize="smooth" initial="instant" style={{ maxHeight }}>
        <StickToBottom.Content className={cn("p-2 font-mono text-xs leading-relaxed", wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre overflow-x-auto")}>
          {chunks.length === 0 ? (
            <span className="text-muted-foreground">Nothing yet.</span>
          ) : (
            chunks.map((chunk, i) =>
              chunk.kind === "tool_call" ? (
                <div key={i} className="text-status-running">
                  <span aria-hidden>▶ </span>
                  {chunk.text}
                </div>
              ) : (
                <div key={i}>{chunk.text}</div>
              ),
            )
          )}
        </StickToBottom.Content>
        <FollowTail />
      </StickToBottom>
    </div>
  );
}

function FollowTail() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <Button size="xs" variant="outline" className="absolute right-2 bottom-2 shadow-sm" onClick={() => void scrollToBottom()}>
      <ArrowDownToLineIcon />
      Follow
    </Button>
  );
}

/** Static preformatted text (a transcript, an artifact) on the console surface. */
export function CodeBlock({ text, className, maxHeight = "24rem" }: { text: string; className?: string; maxHeight?: string }) {
  return (
    <div className={cn("relative rounded-md border border-border bg-console", className)}>
      <div className="absolute top-1 right-1">
        <CopyButton value={text} />
      </div>
      <pre className="overflow-auto p-3 pr-8 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words" style={{ maxHeight }}>
        {text}
      </pre>
    </div>
  );
}
