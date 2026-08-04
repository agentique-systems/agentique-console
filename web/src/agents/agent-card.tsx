/**
 * One agent session in the strip: title, a pill per seat with a live state
 * dot (runtime store), and the meta row. The card breathes the running ring
 * while any seat works or the session row says "working" — liveness reads
 * from across the room, detail waits for the inspector.
 */
import type { AgentRuntimeState, AgentSession } from "@agentique-console/shared";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/status";
import { cn } from "@/lib/utils";
import { useRuntimeStore } from "@/stores/runtime";
import { useUiStore } from "@/stores/ui";

const SEAT_DOT: Record<AgentRuntimeState, string> = {
  thinking: "bg-status-running animate-pulse",
  responding: "bg-status-running",
  tool: "bg-status-waiting",
  waiting: "bg-status-pending",
  idle: "bg-status-cancelled",
};

const BUSY_STATES: ReadonlySet<AgentRuntimeState> = new Set([
  "thinking",
  "responding",
  "tool",
]);

export function AgentCard({
  session,
  taskCount,
  selected,
}: {
  session: AgentSession;
  taskCount: number;
  selected: boolean;
}) {
  const seats = useRuntimeStore((s) => s.bySession[session.id]);
  const selectAgentSession = useUiStore((s) => s.selectAgentSession);

  const runtimes = session.participants.map((name) => seats?.[name]);
  const anySeatBusy = runtimes.some(
    (runtime) => runtime !== undefined && BUSY_STATES.has(runtime.state),
  );
  const running = anySeatBusy || session.status === "working";
  const toolSeat = runtimes.find((runtime) => runtime?.state === "tool");

  return (
    <button
      type="button"
      data-testid="agent-card"
      className={cn(
        "surface-raised flex w-full flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent",
        // --primary is near-white in dark / near-black in light, so this is a
        // crisp selection edge. --ring is mid-grey and reads as unselected.
        selected && "border-primary bg-accent",
        running && "console-running-ring",
        session.status === "archived" && "opacity-60",
      )}
      onClick={() => selectAgentSession(session.userSessionId, session.id)}
    >
      <div className="truncate text-xs font-medium">{session.title}</div>

      <div className="flex flex-wrap items-center gap-1">
        {session.participants.map((name) => (
          <span
            key={name}
            className="flex items-center gap-1 rounded-full border border-border/60 px-1.5 py-0.5"
          >
            <span
              data-testid={`seat-dot-${name}`}
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                SEAT_DOT[seats?.[name]?.state ?? "idle"],
              )}
            />
            <span className="font-mono text-3xs text-muted-foreground">
              {name}
            </span>
          </span>
        ))}
      </div>

      <div className="flex min-w-0 items-center gap-1.5 text-3xs text-muted-foreground">
        <span>{timeAgo(session.updatedAt)}</span>
        <span aria-hidden>·</span>
        <span>
          {taskCount} task{taskCount === 1 ? "" : "s"}
        </span>
        {session.phase === "planning" && (
          <Badge
            variant="outline"
            className="px-1 py-0 text-3xs uppercase text-status-waiting"
          >
            planning
          </Badge>
        )}
        {toolSeat !== undefined && (
          <span className="min-w-0 truncate text-status-waiting">
            running {toolSeat.toolName ?? "a tool"}
          </span>
        )}
      </div>
    </button>
  );
}
