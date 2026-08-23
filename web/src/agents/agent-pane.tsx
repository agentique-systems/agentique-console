/**
 * The right pane: the selected agent session's inspector — header (title,
 * mode/phase chips, seating legend), the read-only notice, and the read-along
 * transcript. Selection lives in the ui store's per-user-session map, so
 * switching user sessions restores each one's pick.
 */
import { useAgentSession } from "@/api/queries";
import type { AgentRunSummary, AgentSession } from "@agentique-console/shared";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";

import { buildAccents } from "./accents";
import { AgentTranscript } from "./agent-transcript";

export function AgentPane() {
  const selectedId = useUiStore((s) => s.activeAgentSessionId ?? undefined);
  const detail = useAgentSession(selectedId ?? null);

  if (selectedId === undefined) {
    return (
      <div className="flex min-h-0 items-center justify-center px-6 text-center">
        <span className="text-xs text-muted-foreground">
          select an agent session to read along
        </span>
      </div>
    );
  }

  if (detail.isPending) {
    return (
      <div className="flex min-h-0 items-center justify-center">
        <Spinner className="size-4 text-muted-foreground" />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="flex min-h-0 items-center justify-center px-6 text-center">
        <span className="text-xs text-status-failed">
          couldn't load this agent session — {detail.error.message}
        </span>
      </div>
    );
  }

  return <PaneBody session={detail.data.session} runs={detail.data.runs} />;
}

function PaneBody({ session, runs }: { session: AgentSession; runs: AgentRunSummary[] }) {
  const accents = buildAccents(session.agents);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {session.title}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {session.agents.map((name) => (
            <span
              key={name}
              className="flex items-center gap-1 font-mono text-3xs text-muted-foreground"
            >
              <span
                aria-hidden
                className={cn(
                  "size-2 rounded-full bg-current",
                  accents.get(name) ?? "text-muted-foreground",
                )}
              />
              {name}
            </span>
          ))}
        </div>
        <div className="mt-1 text-2xs text-muted-foreground">
          Console-managed · durable mailbox · read-only inspector
          {session.budget !== null && (
            <span
              className={session.budget.spendUsd >= session.budget.budgetUsd ? " text-attention" : ""}
              title="commission budget (session + children); crossing it notifies and escalates, never pauses"
            >
              {" "}· ${session.budget.spendUsd.toFixed(2)} / ${session.budget.budgetUsd.toFixed(2)} budget
            </span>
          )}
        </div>
        <div className="mt-1 grid gap-0.5">
          {runs.map((run) => (
            <div key={run.agent} className="flex min-w-0 items-center gap-1 font-mono text-3xs text-muted-foreground">
              <span className="truncate" title={run.ownership.join(", ")}>{run.agent} · {run.profileId} · {run.ownership.join(", ") || "coordination"}</span>
              <span className="ml-auto shrink-0">gen {run.generation} · {run.totalTurns} turns · ${run.totalCostUsd.toFixed(2)} · {run.contextTokens.toLocaleString()} peak ctx</span>
            </div>
          ))}
        </div>
      </div>
      <AgentTranscript session={session} />
    </div>
  );
}
