import type { QueryClient } from "@tanstack/react-query";

import { useAgentSessionStreamsStore } from "@/stores/agent-session-streams";
import { useFlowStore } from "@/stores/flow";
import { useRuntimeStore } from "@/stores/runtime";
import { useUiStore } from "@/stores/ui";
import { useUserSessionStreamsStore } from "@/stores/user-session-streams";

import { createInvalidationCoalescer, routeEvent } from "./event-router";
import { createSpine, type Spine } from "./spine";
import { agentStreamKey, userStreamKey, watched } from "./watched";

/**
 * Wires spine → router → stores, once, from main.tsx. Everything live flows
 * through this single dispatch; the stores it feeds are module singletons.
 */
export function bootSpine(queryClient: QueryClient): Spine {
  const coalescer = createInvalidationCoalescer(queryClient);
  return createSpine({
    queryClient,
    route: (event) => {
      routeEvent(event, {
        invalidate: coalescer.invalidate,
        appendUserStreamEvent: (sessionId, streamEvent) =>
          useUserSessionStreamsStore
            .getState()
            .appendEvent(userStreamKey(sessionId), streamEvent),
        appendAgentStreamEvent: (sessionId, streamEvent) =>
          useAgentSessionStreamsStore
            .getState()
            .appendEvent(agentStreamKey(sessionId), streamEvent),
        ingestAgentActivity: (payload) =>
          useRuntimeStore.getState().ingest(payload),
        setAwaitingInput: (sessionId, awaiting) =>
          useUiStore.getState().setAwaitingInput(sessionId, awaiting),
        pulseFlow: (agentSessionId, direction, eventTs) =>
          useFlowStore.getState().pulse(agentSessionId, direction, eventTs),
        isWatched: (key) => watched.has(key),
      });
    },
    onReconnect: () => {
      useUserSessionStreamsStore.getState().onReconnect();
      useAgentSessionStreamsStore.getState().onReconnect();
      // Runtime states are transient and never replayed — a reconnect must not
      // leave a stale "thinking" agent glowing forever.
      useRuntimeStore.getState().clearAll();
    },
  });
}
