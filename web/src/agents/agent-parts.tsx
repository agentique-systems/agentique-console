/**
 * Rendering for agent-session transcript items — the single dispatch point;
 * new item types land here. The v1 session-parts shape with v2's items:
 * speaker-accented bubbles (seating-order accents), PLAN blocks, routed
 * micro-rows, per-participant turn hairlines.
 *
 * Input is an AgentGroup, not a raw AgentItem: a seat's consecutive tool calls
 * arrive pre-collapsed into one run (agent-groups.ts) and render as a single
 * Task block, because a working seat produces tool cards faster than anyone
 * can read them.
 */
import { FileTextIcon, OctagonXIcon, WrenchIcon } from "lucide-react";

import type { Speaker } from "@agentique-console/shared";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from "@/components/ai-elements/task";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { shortenPath, subjectOf } from "@/lib/tool-text";
import { cn } from "@/lib/utils";
import { HandoffCard } from "@/components/handoff-card";

import { accentOf, accentOfName, type AccentMap } from "./accents";
import type { AgentToolItem, RoutedItem } from "./agent-fold";
import { runSummary, type AgentGroup, type ToolRunItem } from "./agent-groups";

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
        "mb-1 text-3xs uppercase tracking-wide opacity-80",
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

function toolState(item: AgentToolItem) {
  if (item.isError === true) return "output-error" as const;
  return item.output === undefined
    ? ("input-available" as const)
    : ("output-available" as const);
}

/** One call inside a run: a sentence, with the raw call folded behind it. */
function RunStep({ item }: { item: AgentToolItem }) {
  const subject = subjectOf(item.input);

  return (
    <TaskItem>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "font-mono",
            item.isError === true && "text-status-failed",
          )}
        >
          {item.name}
        </span>
        {subject !== undefined && (
          <TaskItemFile>
            <span className="truncate">{shortenPath(subject, 2)}</span>
          </TaskItemFile>
        )}
      </div>
      <Tool className="mt-1 mb-0 rounded-sm border-border-subtle">
        <ToolHeader compact toolName={item.name} state={toolState(item)} />
        <ToolContent className="space-y-2 p-2">
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
    </TaskItem>
  );
}

function ToolRun({ item, accents }: { item: ToolRunItem; accents: AccentMap }) {
  return (
    <div className="my-1">
      <div
        className={cn(
          "mb-1 text-3xs uppercase tracking-wide opacity-80",
          accentOfName(accents, item.participant),
        )}
      >
        {item.participant}
      </div>
      <Task>
        <TaskTrigger
          icon={WrenchIcon}
          title={`${runSummary(item.tools)}${item.active ? "…" : ""}`}
        />
        <TaskContent>
          {item.tools.map((tool) => (
            <RunStep key={tool.uid} item={tool} />
          ))}
        </TaskContent>
      </Task>
    </div>
  );
}

export function AgentPart({
  item,
  accents,
}: {
  item: AgentGroup;
  accents: AccentMap;
}) {
  switch (item.type) {
    case "tool_run":
      return <ToolRun item={item} accents={accents} />;

    case "message": {
      if (item.handoff) return <HandoffCard handoff={item.handoff} sender={item.speaker.name} recipient={item.to} />;
      if (item.kind === "notice" || item.speaker.kind === "system") {
        return (
          <div className="my-1 px-1 text-center text-2xs text-muted-foreground">
            {item.text}
          </div>
        );
      }
      if (item.kind === "plan") {
        return (
          <div className="surface-raised my-2 rounded-lg border border-border bg-card px-4 py-3">
            <div
              className={cn(
                "mb-2 flex items-center gap-2 text-3xs uppercase tracking-wide",
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

    case "routed":
      return (
        <div className="my-1 px-1 font-mono text-3xs text-muted-foreground">
          {routedLabel(item)}
        </div>
      );

    case "turn":
      return (
        <div className="my-3 flex items-center gap-2 text-xs">
          <div className="h-px flex-1 bg-border-subtle" />
          <span
            className={cn(
              "font-mono text-3xs uppercase tracking-wider",
              accentOfName(accents, item.participant),
            )}
          >
            {item.participant}
          </span>
          <div className="h-px flex-1 bg-border-subtle" />
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
        <div className="my-1 px-1 text-center font-mono text-3xs uppercase tracking-wider text-muted-foreground">
          phase: {item.phase}
        </div>
      );

    case "trace":
      return (
        <div className={cn("my-1 rounded border border-border-subtle bg-muted/20 px-2 py-1 font-mono text-3xs text-muted-foreground", item.tone === "error" && "border-status-failed/40 text-status-failed")}>
          <div className="mb-0.5 uppercase tracking-wide">{item.participant} · {item.label}</div>
          <div className="whitespace-pre-wrap break-words">{item.detail}</div>
        </div>
      );
  }
}
