import type { QueryClient } from "@tanstack/react-query";

import { useRuntimeStore } from "@/stores/runtime";
import { useUiStore } from "@/stores/ui";
import { useUserSessionStreamsStore } from "@/stores/user-session-streams";

import { createInvalidationCoalescer, routeEvent } from "./event-router";
import { createSpine, type Spine } from "./spine";
import { userStreamKey, watched } from "./watched";

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
        ingestAgentState: (payload) =>
          useRuntimeStore.getState().ingest(payload),
        setAwaitingInput: (sessionId, awaiting) =>
          useUiStore.getState().setAwaitingInput(sessionId, awaiting),
        isWatched: (key) => watched.has(key),
      });
    },
    onReconnect: () => {
      useUserSessionStreamsStore.getState().onReconnect();
      // Runtime states are transient and never replayed — a reconnect must not
      // leave a stale "thinking" seat glowing forever.
      useRuntimeStore.getState().clearAll();
    },
  });
}
