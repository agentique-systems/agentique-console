/**
 * Rendering for agent-session transcript items — the single dispatch point;
 * new item types land here. The v1 session-parts shape with v2's items:
 * speaker-accented bubbles (seating-order accents), PLAN blocks, tool cards
 * under a participant label, routed micro-rows, per-participant turn
 * hairlines.
 */
import { FileTextIcon, OctagonXIcon } from "lucide-react";

import type { Speaker } from "@agentique-console/shared";
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

import { accentOf, accentOfName, type AccentMap } from "./accents";
import type { AgentItem, RoutedItem } from "./agent-fold";

export function SpeakerLabel({
  speaker,
  to,
  accents,
}: {
  speaker: Speaker;
  to?: string | undefined;
  accents: AccentMap;
}) {
  return (
    <div
      className={cn(
        "mb-1 text-[10px] uppercase tracking-wide opacity-80",
        accentOf(accents, speaker),
      )}
    >
      {speaker.name}
      {to !== undefined && <span className="opacity-70"> → {to}</span>}
    </div>
  );
}

/** "→ scout, coder (mention)" — reasons collapse when they all agree. */
function routedLabel(item: RoutedItem): string {
  if (item.decisions.length === 0) return "→ nobody";
  const reasons = new Set(item.decisions.map((decision) => decision.reason));
  const only = [...reasons][0];
  const base =
    reasons.size === 1
      ? `→ ${item.decisions.map((d) => d.recipient).join(", ")}${
          only === undefined || only === "" ? "" : ` (${only})`
        }`
      : `→ ${item.decisions
          .map((d) => `${d.recipient} (${d.reason})`)
          .join(", ")}`;
  return item.hopCount > 1 ? `${base} · hop ${item.hopCount}` : base;
}

export function AgentPart({
  item,
  accents,
}: {
  item: AgentItem;
  accents: AccentMap;
}) {
  switch (item.type) {
    case "message": {
      if (item.kind === "notice" || item.speaker.kind === "system") {
        return (
          <div className="my-1 px-1 text-center text-[11px] text-muted-foreground">
            {item.text}
          </div>
        );
      }
      if (item.kind === "plan") {
        return (
          <div className="my-2 rounded-lg border border-border bg-card px-4 py-3">
            <div
              className={cn(
                "mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wide",
                accentOf(accents, item.speaker),
              )}
            >
              <FileTextIcon className="size-3.5 shrink-0" />
              <span className="font-medium">plan — {item.speaker.name}</span>
            </div>
            <div className="text-sm">
              <MessageResponse>{item.text}</MessageResponse>
            </div>
          </div>
        );
      }
      return (
        <Message from="assistant">
          <MessageContent>
            <SpeakerLabel
              speaker={item.speaker}
              to={item.to}
              accents={accents}
            />
            <MessageResponse>{item.text}</MessageResponse>
          </MessageContent>
        </Message>
      );
    }

    case "tool":
      return (
        <div>
          <div
            className={cn(
              "mb-1 text-[10px] uppercase tracking-wide opacity-80",
              accentOfName(accents, item.participant),
            )}
          >
            {item.participant}
          </div>
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
        </div>
      );

    case "routed":
      return (
        <div className="my-1 px-1 font-mono text-[10px] text-muted-foreground">
          {routedLabel(item)}
        </div>
      );

    case "turn":
      return (
        <div className="my-3 flex items-center gap-2 text-xs">
          <div className="h-px flex-1 bg-border" />
          <span
            className={cn(
              "font-mono text-[10px] uppercase tracking-wider",
              accentOfName(accents, item.participant),
            )}
          >
            {item.participant}
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>
      );

    case "turn_error":
      return (
        <div className="my-1 flex items-center gap-2 px-1 text-xs text-status-failed">
          <OctagonXIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            {item.participant}: {item.errorMessage}
          </span>
        </div>
      );

    case "phase":
      return (
        <div className="my-1 px-1 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          phase: {item.phase}
        </div>
      );
  }
}
