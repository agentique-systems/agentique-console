/**
 * Rendering for user-session transcript items — the single dispatch point;
 * new item types land here. The shape follows v1's session-parts, trimmed to
 * the two-party conversation: operator bubbles right-aligned, orchestrator
 * plain markdown, everything else is cards and micro-rows between them.
 */
import { OctagonXIcon } from "lucide-react";

import type { Interaction } from "@agentique-console/shared";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";

import { PlanCard } from "./plan-card";
import { QuestionCard } from "./question-card";
import type { UserItem } from "./user-fold";

export function UserPart({
  sessionId,
  item,
  pendingById,
  onRequestChanges,
}: {
  sessionId: string;
  item: UserItem;
  /** Live interaction rows from GET /:id — carries the "stale" status. */
  pendingById: ReadonlyMap<string, Interaction>;
  onRequestChanges: () => void;
}) {
  switch (item.type) {
    case "message": {
      if (item.kind === "notice") {
        return (
          <div className="my-1 px-1 text-center text-[11px] text-muted-foreground">
            {item.text}
          </div>
        );
      }
      const operator = item.speaker.kind === "operator";
      return (
        <Message from={operator ? "user" : "assistant"}>
          <MessageContent>
            <MessageResponse>{item.text}</MessageResponse>
          </MessageContent>
        </Message>
      );
    }

    case "tool":
      return (
        <Tool>
          <ToolHeader
            toolName={item.name}
            state={
              item.output === undefined && item.isError !== true
                ? "input-available"
                : item.isError === true
                  ? "output-error"
                  : "output-available"
            }
          />
          <ToolContent>
            <ToolInput input={item.input} />
            {(item.output !== undefined || item.isError === true) && (
              <ToolOutput
                output={item.isError === true ? undefined : item.output}
                errorText={
                  item.isError === true
                    ? typeof item.output === "string"
                      ? item.output
                      : "tool failed"
                    : undefined
                }
              />
            )}
          </ToolContent>
        </Tool>
      );

    case "question":
      return (
        <QuestionCard
          sessionId={sessionId}
          item={item}
          pendingStatus={pendingById.get(item.interactionId)?.status}
        />
      );

    case "plan":
      return (
        <PlanCard
          sessionId={sessionId}
          item={item}
          onRequestChanges={onRequestChanges}
        />
      );

    case "turn":
      return (
        <div className="my-3 flex items-center gap-2 text-xs text-muted-foreground">
          <div className="h-px flex-1 bg-border" />
          <span className="font-mono text-[10px] uppercase tracking-wider">
            {item.trigger}
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>
      );

    case "turn_error":
      return (
        <div
          className={cn(
            "my-1 flex items-center gap-2 px-1 text-xs text-status-failed",
          )}
        >
          <OctagonXIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{item.errorMessage}</span>
        </div>
      );
  }
}
