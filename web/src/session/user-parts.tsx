/**
 * Rendering for user-session transcript items — the single dispatch point;
 * new item types land here. The shape follows v1's session-parts, trimmed to
 * the two-party conversation: operator bubbles right-aligned, orchestrator
 * plain markdown, everything else is cards and micro-rows between them.
 *
 * Input is a UserGroup, not a raw UserItem: consecutive tool calls arrive
 * pre-collapsed into a chain (user-groups.ts) so one stretch of thinking
 * renders as one block instead of a stack of boxes.
 */
import type { LucideIcon } from "lucide-react";
import {
  FileTextIcon,
  LayersIcon,
  ListTodoIcon,
  OctagonXIcon,
  SearchIcon,
  SendIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";

import type { DecisionIssueWire, Interaction } from "@agentique-console/shared";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
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
import { HandoffCard } from "@/components/handoff-card";
import { shortenPath, subjectOf } from "@/lib/tool-text";

import { PlanCard } from "./plan-card";
import { RunSummaryCard } from "./run-summary-card";
import { QuestionCard } from "./question-card";
import type { ToolItem } from "./user-fold";
import {
  categoryOf,
  chainSummary,
  searchResultsOf,
  toolStatus,
  type ChainItem,
  type UserGroup,
} from "./user-groups";

const STEP_ICON: Record<ReturnType<typeof categoryOf>, LucideIcon> = {
  search: SearchIcon,
  read: FileTextIcon,
  fetch: FileTextIcon,
  delegate: UsersIcon,
  speak: SendIcon,
  task: ListTodoIcon,
  console: LayersIcon,
  other: WrenchIcon,
};

/** The Tool card's three phases, derived from the same paired result. */
function toolState(item: ToolItem) {
  const status = toolStatus(item);
  if (status === "failed") return "output-error" as const;
  return status === "active"
    ? ("input-available" as const)
    : ("output-available" as const);
}

/** The raw call, folded away behind the step's human sentence. */
function ToolDetails({ item }: { item: ToolItem }) {
  return (
    <Tool className="mb-0 rounded-sm border-border-subtle">
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
  );
}

/**
 * One tool call as a step. The subject — a path, a pattern, a url — is what
 * makes the row worth reading, so it is pulled out where there is one.
 */
function ChainStep({ item }: { item: ToolItem }) {
  const status = toolStatus(item);
  const subject = subjectOf(item.input);
  const results = searchResultsOf(item);

  return (
    <ChainOfThoughtStep
      icon={STEP_ICON[categoryOf(item.name)]}
      status={status === "active" ? "active" : "complete"}
      label={
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span
            className={cn(
              "font-mono",
              status === "failed" && "text-status-failed",
            )}
          >
            {item.name}
          </span>
          {subject !== undefined && (
            <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
              {shortenPath(subject, 3)}
            </span>
          )}
        </span>
      }
    >
      {results.length > 0 && (
        <ChainOfThoughtSearchResults>
          {results.map((result) => (
            <ChainOfThoughtSearchResult key={result}>
              {shortenPath(result, 2)}
            </ChainOfThoughtSearchResult>
          ))}
        </ChainOfThoughtSearchResults>
      )}
      <ToolDetails item={item} />
    </ChainOfThoughtStep>
  );
}

function Chain({ item }: { item: ChainItem }) {
  return (
    <ChainOfThought className="my-1">
      <ChainOfThoughtHeader>
        {chainSummary(item.tools)}
        {item.active && "…"}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {item.tools.map((tool) => (
          <ChainStep key={tool.uid} item={tool} />
        ))}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

export function UserPart({
  sessionId,
  item,
  pendingById,
  issuesById,
  onRequestChanges,
}: {
  sessionId: string;
  item: UserGroup;
  /** Live interaction rows from GET /:id — carries the "stale" status. */
  pendingById: ReadonlyMap<string, Interaction>;
  /** Open decision issues from GET /:id — a shared-issue card names its co-askers. */
  issuesById?: ReadonlyMap<string, DecisionIssueWire>;
  onRequestChanges: () => void;
}) {
  switch (item.type) {
    case "chain":
      return <Chain item={item} />;

    case "handoff":
      return <HandoffCard handoff={item.handoff} sender={item.sender} recipient={item.recipient} />;

    case "message": {
      if (item.kind === "notice") {
        return (
          <div className="my-1 px-1 text-center text-2xs text-muted-foreground">
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

    case "question":
      return (
        <QuestionCard
          sessionId={sessionId}
          item={item}
          pendingStatus={pendingById.get(item.interactionId)?.status}
          issue={item.issueId === undefined ? undefined : issuesById?.get(item.issueId)}
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

    case "run_summary":
      return (
        <RunSummaryCard
          sessionId={sessionId}
          item={item}
          onRequestChanges={onRequestChanges}
        />
      );

    case "turn":
      return (
        <div className="my-3 flex items-center gap-2 text-xs text-muted-foreground">
          <div className="h-px flex-1 bg-border-subtle" />
          <span className="font-mono text-3xs uppercase tracking-wider">
            {item.trigger}
          </span>
          <div className="h-px flex-1 bg-border-subtle" />
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
    case "runtime":
      return (
        <div className="my-1 rounded border border-border-subtle bg-muted/20 px-2 py-1 font-mono text-3xs text-muted-foreground">
          <div className="mb-0.5 uppercase tracking-wide">{item.label}</div>
          <div className="whitespace-pre-wrap break-words">{item.detail}</div>
        </div>
      );
  }
}
