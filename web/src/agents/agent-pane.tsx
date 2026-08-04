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
import { useActiveUserSessionId } from "./active-session";
import { AgentTranscript } from "./agent-transcript";

export function AgentPane() {
  const userSessionId = useActiveUserSessionId();
  const selectedId = useUiStore((s) =>
    userSessionId === null
      ? undefined
      : s.selectedAgentSessionByUserSession[userSessionId],
  );
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
  const accents = buildAccents(session.participants);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {session.title}
          </span>
          <Badge variant="outline" className="text-3xs uppercase">
            {session.mode === "plan_execute" ? "plan + execute" : "execute"}
          </Badge>
          {session.mode === "plan_execute" && (
            <Badge
              variant="outline"
              className={cn(
                "text-3xs uppercase",
                session.phase === "planning"
                  ? "text-status-waiting"
                  : "text-status-running",
              )}
            >
              {session.phase}
            </Badge>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {session.participants.map((name) => (
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
        </div>
        <div className="mt-1 grid gap-0.5">
          {runs.map((run) => (
            <div key={run.participant} className="flex min-w-0 items-center gap-1 font-mono text-3xs text-muted-foreground">
              <span className="truncate" title={run.ownership.join(", ")}>{run.participant} · {run.profileId} · {run.ownership.join(", ") || "coordination"}</span>
              <span className="ml-auto shrink-0">gen {run.generation} · {run.turnCount} turns · {run.contextTokens.toLocaleString()} ctx</span>
            </div>
          ))}
        </div>
      </div>
      <AgentTranscript session={session} />
    </div>
  );
}
