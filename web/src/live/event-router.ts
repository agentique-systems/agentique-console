import type { QueryClient } from "@tanstack/react-query";

import type { AgentStatePayload, ConsoleEvent } from "@agentique-console/shared";

import { keys } from "@/api/keys";
import { agentStreamKey, userStreamKey } from "@/live/watched";
import type { FlowDirection } from "@/stores/flow";

export interface RouterDeps {
  /** Prefix invalidation (coalesced) — see createInvalidationCoalescer. */
  invalidate(prefix: readonly unknown[]): void;
  /** User-session transcript sink; the stream store folds these. */
  appendUserStreamEvent(sessionId: string, event: ConsoleEvent): void;
  /** Agent-session transcript sink; the agent stream store folds these. */
  appendAgentStreamEvent(sessionId: string, event: ConsoleEvent): void;
  /** agent.state ALWAYS lands here, watched or not — it drives shimmer rows. */
  ingestAgentState(payload: AgentStatePayload): void;
  /**
   * Sidebar attention dots: the list endpoint doesn't carry "awaiting input",
   * so the router keeps a client-side map fed by question/plan events.
   */
  setAwaitingInput(sessionId: string, awaiting: boolean): void;
  /**
   * Flow pulses (strip stem + edge tick). `eventTs` is the wire ts — the flow
   * store's freshness guard drops stale reconnect replays there.
   */
  pulseFlow(
    agentSessionId: string,
    direction: FlowDirection,
    eventTs: string,
  ): void;
  /** Transient gate: deltas for unwatched sessions are dropped here. */
  isWatched(key: string): boolean;
}

/**
 * One dispatch point for every spine event. Three independent concerns:
 *  1. cache invalidation for list/detail queries (coarse, coalesced)
 *  2. stream append for the owning session's live transcript
 *  3. the runtime + attention side-tables
 */
export function routeEvent(event: ConsoleEvent, deps: RouterDeps): void {
  const type = event.type;

  // 1. Cache invalidation, by topic prefix. Agent-session invalidation is the
  // LIFECYCLE subset on purpose: message/tool/routed events arrive in storms
  // and already reach the strip via the stream store — refetching the list
  // for each would be waste.
  if (type.startsWith("user_session.")) {
    deps.invalidate(keys.userSessions.all);
  } else if (type.startsWith("workspace.")) {
    deps.invalidate(keys.workspaces);
  } else if (
    type === "agent_session.created" ||
    type === "agent_session.status" ||
    type === "agent_session.phase" ||
    type === "agent_session.turn.started" ||
    type === "agent_session.turn.settled"
  ) {
    deps.invalidate(keys.agentSessions.all);
  } else if (type.startsWith("task.")) {
    deps.invalidate(keys.tasks.all);
  }

  switch (event.type) {
    // 3a. Runtime states bypass the watched gate: the sidebar/header read them
    // for sessions whose transcript may not be mounted.
    case "agent.state":
      deps.ingestAgentState(event.payload);
      return;

    // 2a. Transient stream frames: watched sessions only — an unwatched
    // session has no stream to accumulate into, and the next watch re-hydrates.
    case "stream.delta":
    case "stream.reasoning": {
      const scope = event.payload.scope;
      if (scope.kind === "user") {
        if (deps.isWatched(userStreamKey(scope.sessionId))) {
          deps.appendUserStreamEvent(scope.sessionId, event);
        }
      } else if (deps.isWatched(agentStreamKey(scope.sessionId))) {
        deps.appendAgentStreamEvent(scope.sessionId, event);
      }
      return;
    }

    // 2b. Persisted transcript-shaped user_session events. Forwarded without a
    // watched check on purpose: the store itself drops events for ids it holds
    // no stream for, and a LINGERING (recently unwatched) stream must keep
    // receiving persisted rows or a quick re-watch would show a gapped view.
    case "user_session.message":
      deps.appendUserStreamEvent(event.payload.sessionId, event);
      // Chat while a card is pending dismisses it server-side; clearing here
      // keeps the dot honest even before those resolution events land.
      deps.setAwaitingInput(event.payload.sessionId, false);
      return;
    case "user_session.tool.call":
    case "user_session.tool.result":
    case "user_session.turn.started":
    case "user_session.turn.settled":
      deps.appendUserStreamEvent(event.payload.sessionId, event);
      return;

    // 2c. Persisted transcript-shaped agent_session events — same ungated
    // deviation as the user lane: the store drops unknown ids, and LINGERING
    // streams must keep receiving persisted rows to stay gapless.
    case "agent_session.message":
    case "agent_session.routed":
    case "agent_session.turn.started":
    case "agent_session.turn.settled":
    case "agent_session.phase":
      deps.appendAgentStreamEvent(event.payload.agentSessionId, event);
      return;
    // Tool payloads inherit the user-lane shape: `sessionId` IS the agent
    // session id there (the envelope's agentSessionId agrees).
    case "agent_session.tool.call":
    case "agent_session.tool.result":
      deps.appendAgentStreamEvent(event.payload.sessionId, event);
      return;

    // 3c. Flow pulses — the store's freshness guard (via eventTs) keeps a
    // reconnect replay from animating stale hops.
    case "flow.delegation":
      deps.pulseFlow(event.payload.agentSessionId, "delegation", event.ts);
      return;
    case "flow.result":
      deps.pulseFlow(event.payload.agentSessionId, "result", event.ts);
      return;

    // 3b. Question/plan events both append AND flip the attention map.
    case "user_session.question.asked":
    case "user_session.plan.proposed":
      deps.appendUserStreamEvent(event.payload.sessionId, event);
      deps.setAwaitingInput(event.payload.sessionId, true);
      return;
    case "user_session.question.answered":
    case "user_session.plan.resolved":
      deps.appendUserStreamEvent(event.payload.sessionId, event);
      deps.setAwaitingInput(event.payload.sessionId, false);
      return;

    default:
      return;
  }
}

/**
 * Trailing-edge coalescer: turn storms emit dozens of events in a burst;
 * one invalidation sweep per 200ms window is plenty for list queries.
 */
export function createInvalidationCoalescer(
  queryClient: QueryClient,
  delayMs = 200,
): { invalidate(prefix: readonly unknown[]): void; flush(): void } {
  const pending = new Map<string, readonly unknown[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const prefixes = [...pending.values()];
    pending.clear();
    for (const queryKey of prefixes) {
      void queryClient.invalidateQueries({ queryKey: queryKey as unknown[] });
    }
  };

  return {
    invalidate(prefix) {
      pending.set(JSON.stringify(prefix), prefix);
      timer ??= setTimeout(flush, delayMs);
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        flush();
      }
    },
  };
}
