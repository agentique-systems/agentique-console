import type { QueryClient } from "@tanstack/react-query";

import type { AgentActivityChangedPayload, ConsoleEvent, EventScope, SystemPauseState } from "@agentique-console/shared";

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
  /** activity.changed ALWAYS lands here, watched or not — it drives shimmer rows. */
  ingestAgentActivity(payload: AgentActivityChangedPayload): void;
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
  /** The whole-system pause flipped: the payload IS the state — written straight into the cache. */
  setSystemPause(state: SystemPauseState): void;
}

/** The session id a transient frame's scope names — the owning stream. */
function scopeSessionId(scope: EventScope): string {
  return scope.kind === "user" ? scope.userSessionId : scope.agentSessionId;
}

/**
 * One dispatch point for every spine event. Three independent concerns:
 *  1. cache invalidation for list/detail queries (coarse, coalesced)
 *  2. stream append for the owning session's live transcript
 *  3. the runtime + attention side-tables
 */
export function routeEvent(event: ConsoleEvent, deps: RouterDeps): void {
  if (event.userSessionId && event.seq !== undefined) deps.invalidate(keys.timelineAll);

  // 1. Cache invalidation, by exact type. Agent-session invalidation is the
  // LIFECYCLE subset on purpose: message/tool events arrive in storms
  // and already reach the strip via the stream store — refetching the list
  // for each would be waste.
  switch (event.type) {
    case "user_session.created":
    case "user_session.updated":
    case "user_session.message.appended":
    case "user_session.turn.started":
    case "user_session.turn.settled":
    case "user_session.context.rotated":
    case "user_session.runtime.noted":
    case "user_session.retry.recorded":
    case "user_session.tool.called":
    case "user_session.tool.completed":
    case "user_session.question.asked":
    case "user_session.question.answered":
    case "user_session.plan.proposed":
    case "user_session.plan.resolved":
    // The orchestration surfaces (spec chip, requirements panel, working-state
    // panel) live under the user-sessions prefix; these events previously
    // invalidated NOTHING, so the panel would sit stale until an unrelated
    // event swept it. The requirement.* trio are panel-level facts — they
    // invalidate but never append to the conversation stream.
    case "user_session.spec.updated":
    case "user_session.requirements.updated":
    case "requirement.status.changed":
    case "requirement.decomposed":
    case "requirement.delegated":
    case "assumption.recorded":
    case "assumption.resolved":
    case "requirement.link.changed":
    case "user_session.state.updated":
      deps.invalidate(keys.userSessions.all);
      deps.invalidate(keys.sessionTreeAll);
      break;
    case "workspace.created":
    case "workspace.updated":
      deps.invalidate(keys.workspaces);
      break;
    // Per-session pause columns (pauseReason/pausedUntil) ride the detail rows.
    case "run.capacity.paused":
    case "run.capacity.resumed":
      deps.invalidate(keys.userSessions.all);
      break;
    case "agent_session.created":
    case "agent_session.status.changed":
    case "agent_session.turn.started":
    case "agent_session.turn.settled":
      deps.invalidate(keys.agentSessions.all);
      deps.invalidate(keys.sessionTreeAll);
      break;
    case "task.created":
    case "task.updated":
      deps.invalidate(keys.tasks.all);
      deps.invalidate(keys.workspaceTasksAll);
      break;
    case "task.dependency.created":
    case "task.dependency.deleted":
      deps.invalidate(keys.workspaceTasksAll);
      break;
    case "task.assignment.scheduled":
    case "task.assignment.dispatched":
    case "task.assignment.canceled":
      deps.invalidate(keys.tasks.all);
      deps.invalidate(keys.workspaceTasksAll);
      break;
    case "agent_profile.changed":
      deps.invalidate(keys.profiles.all);
      break;
    default:
      break;
  }

  switch (event.type) {
    // 3a. Runtime states bypass the watched gate: the sidebar/header read them
    // for sessions whose transcript may not be mounted.
    case "agent_session.activity.changed":
      deps.ingestAgentActivity(event.payload);
      return;
    // The install-wide pause: one scopeless event, one cache write.
    case "system.pause.changed":
      deps.setSystemPause(event.payload);
      return;

    // 2a. Transient stream frames: watched sessions only — an unwatched
    // session has no stream to accumulate into, and the next watch re-hydrates.
    case "stream.delta":
    case "stream.reasoning": {
      const scope = event.payload.scope;
      if (scope.kind === "user") {
        if (deps.isWatched(userStreamKey(scope.userSessionId))) {
          deps.appendUserStreamEvent(scope.userSessionId, event);
        }
      } else if (deps.isWatched(agentStreamKey(scope.agentSessionId))) {
        deps.appendAgentStreamEvent(scope.agentSessionId, event);
      }
      return;
    }

    // 2b. Persisted transcript-shaped user_session events. Forwarded without a
    // watched check on purpose: the store itself drops events for ids it holds
    // no stream for, and a LINGERING (recently unwatched) stream must keep
    // receiving persisted rows or a quick re-watch would show a gapped view.
    case "user_session.message.appended":
      deps.appendUserStreamEvent(event.payload.userSessionId, event);
      // OPERATOR chat while a card is pending dismisses it server-side
      // (runner.postOperatorMessage → interactions.dismissPendingForChat), so
      // clearing here keeps the dot honest before those resolution events land.
      //
      // It must be gated on the speaker. Clearing on ANY appended message
      // meant an orchestrator reply, a system notice, or the post-restart
      // recovery notice silently cleared "needs you" while the question was
      // still pending — the one signal the operator has that a run is waiting
      // on them, switched off by the run talking to them.
      if (event.payload.message.speaker.kind === "operator") {
        deps.setAwaitingInput(event.payload.userSessionId, false);
      }
      return;
    case "user_session.tool.called":
    case "user_session.tool.completed":
    case "user_session.turn.started":
    case "user_session.turn.settled":
    // An approved governing revision is a conversation-level fact — the fold
    // renders it as a marker between messages.
    case "user_session.spec.updated":
    case "user_session.requirements.updated":
      deps.appendUserStreamEvent(event.payload.userSessionId, event);
      return;

    // 2c. Persisted transcript-shaped agent_session events — same ungated
    // deviation as the user lane: the store drops unknown ids, and LINGERING
    // streams must keep receiving persisted rows to stay gapless.
    case "agent_session.message.appended":
    case "agent_session.turn.started":
    case "agent_session.turn.settled":
    case "agent_session.tool.called":
    case "agent_session.tool.completed":
      deps.appendAgentStreamEvent(event.payload.agentSessionId, event);
      return;

    // 3c. Flow pulses — the store's freshness guard (via eventTs) keeps a
    // reconnect replay from animating stale hops.
    case "agent_session.delegation.sent":
      deps.pulseFlow(event.payload.agentSessionId, "delegation", event.ts);
      return;
    // Boundary hops pulse the PARENT card — the child's own card already
    // pulses via the delegation.sent its creation emitted.
    case "agent_session.child.spawned":
      deps.pulseFlow(event.payload.agentSessionId, "delegation", event.ts);
      return;
    case "agent_session.child.reported":
      deps.pulseFlow(event.payload.agentSessionId, "result", event.ts);
      return;
    case "agent_session.result.returned":
      deps.pulseFlow(event.payload.agentSessionId, "result", event.ts);
      return;

    // 3b. Question/plan events both append AND flip the attention map.
    case "user_session.question.asked":
    case "user_session.plan.proposed":
      deps.appendUserStreamEvent(event.payload.userSessionId, event);
      deps.setAwaitingInput(event.payload.userSessionId, true);
      return;
    case "user_session.question.answered":
    case "user_session.plan.resolved":
      deps.appendUserStreamEvent(event.payload.userSessionId, event);
      deps.setAwaitingInput(event.payload.userSessionId, false);
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
