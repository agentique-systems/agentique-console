import type { QueryClient } from "@tanstack/react-query";

import type { ConsoleEvent, StatsResponse } from "@agentique-console/shared";

import { apiFetch } from "@/api/client";
import { useConnectionStore } from "@/stores/connection";

export interface SpineOptions {
  readonly queryClient: QueryClient;
  readonly route: (event: ConsoleEvent, seq: number | undefined) => void;
  /** Called after every reconnect-with-a-gap; transcripts re-hydrate here. */
  readonly onReconnect?: () => void;
  /** Test seams. */
  readonly makeEventSource?: (url: string) => EventSource;
  readonly fetchStats?: () => Promise<StatsResponse>;
  readonly backoffBaseMs?: number;
}

export interface Spine {
  start(): void;
  stop(): void;
}

/**
 * The ONE EventSource. Contract with the server (verified in source):
 *  - a bare connect tails from the head only, so the spine always connects
 *    with fromSeq = stats.lastEventSeq + 1 (race-free: events between the
 *    stats read and the connect are replayed by fromSeq)
 *  - `id:` fields carry the global seq for persisted events only; transient
 *    frames are never replayed, so reconnects reconcile via invalidate-all
 *  - `: hb` heartbeats are SSE comments, invisible to EventSource — stall
 *    detection is impossible; visibilitychange + CLOSED-recreate cover it
 */
export function createSpine(options: SpineOptions): Spine {
  const makeEventSource =
    options.makeEventSource ?? ((url: string) => new EventSource(url));
  const fetchStats =
    options.fetchStats ?? (() => apiFetch<StatsResponse>("/api/stats"));
  const backoffBaseMs = options.backoffBaseMs ?? 500;
  const connection = useConnectionStore;
  // Per-spec readyState value; the global EventSource may be absent (tests/jsdom).
  const CLOSED = 2;

  let source: EventSource | null = null;
  let stopped = false;
  let hadDrop = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * True once a stats fetch has supplied the seq baseline. Until then we must
   * NOT connect (a low fromSeq against a populated store replays history), so
   * reconnects re-run the bootstrap instead.
   */
  let bootstrapped = false;

  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible" || stopped) return;
    if (source !== null && source.readyState === CLOSED) {
      reconnectNow();
    }
    // Whatever happened while hidden (missed transients, dropped stream
    // windows) is reconciled by refetching canonical state.
    void options.queryClient.invalidateQueries();
  };

  const onOpen = () => {
    attempt = 0;
    connection.getState().setStatus("open");
    if (hadDrop) {
      hadDrop = false;
      connection.getState().noteReconnect();
      // Anything missed while disconnected is reconciled wholesale.
      void options.queryClient.invalidateQueries();
      options.onReconnect?.();
    }
  };

  const onError = () => {
    if (stopped) return;
    hadDrop = true;
    if (source !== null && source.readyState === CLOSED) {
      // Native auto-reconnect gave up — recreate with an explicit cursor.
      connection.getState().setStatus("closed");
      scheduleReconnect();
    } else {
      // Native auto-reconnect in flight (it resends Last-Event-ID itself).
      connection.getState().setStatus("connecting");
    }
  };

  const onConsoleEvent = (raw: MessageEvent<string>) => {
    let event: ConsoleEvent;
    try {
      event = JSON.parse(raw.data) as ConsoleEvent;
    } catch {
      return; // malformed frame — never let one poison the stream
    }
    const seq = raw.lastEventId === "" ? undefined : Number(raw.lastEventId);
    if (seq !== undefined && Number.isFinite(seq)) {
      connection.getState().noteSeq(seq);
    }
    options.route(event, seq);
  };

  function connect(fromSeq: number): void {
    source = makeEventSource(`/api/events?fromSeq=${fromSeq}`);
    source.onopen = onOpen;
    source.onerror = onError;
    source.addEventListener("console", onConsoleEvent as EventListener);
  }

  function reconnectNow(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    source?.close();
    connection.getState().setStatus("connecting");
    if (bootstrapped) {
      connect(connection.getState().lastSeq + 1);
    } else {
      bootstrap();
    }
  }

  function scheduleReconnect(): void {
    if (retryTimer !== null || stopped) return;
    const delay = Math.min(backoffBaseMs * 2 ** attempt, 15_000);
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!stopped) reconnectNow();
    }, delay);
  }

  function bootstrap(): void {
    fetchStats()
      .then((stats) => {
        if (stopped) return;
        bootstrapped = true;
        connection.getState().noteSeq(stats.lastEventSeq);
        connect(stats.lastEventSeq + 1);
      })
      .catch(() => {
        if (stopped) return;
        connection.getState().setStatus("closed");
        hadDrop = true;
        scheduleReconnect();
      });
  }

  return {
    start() {
      stopped = false;
      connection.getState().setStatus("connecting");
      document.addEventListener("visibilitychange", onVisibilityChange);
      bootstrap();
    },
    stop() {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      source?.close();
      source = null;
    },
  };
}
