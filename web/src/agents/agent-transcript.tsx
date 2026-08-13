/**
 * The read-along transcript of one agent session: hydrated once from raw
 * events via the pure fold, continued live by the spine (buffer-then-hydrate,
 * gated on the spine being OPEN). One streaming overlay per speaker
 * (accent-labelled), silent-worker shimmers from the runtime store, and NO
 * composer — the orchestrator runs this session, the operator reads along.
 */
import { useEffect, useMemo, useState } from "react";

import { useAgentTranscript } from "@/api/queries";
import { useInterruptAgent } from "@/api/mutations";
import type { AgentSession, ConsoleEvent } from "@agentique-console/shared";
import {
  Conversation as ChatRoot,
  ConversationContent as ChatContent,
  ConversationEmptyState as ChatEmptyState,
  ConversationScrollButton as ChatScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { WorkingLine } from "@/components/working-line";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { agentStreamKey } from "@/live/watched";
import { useAgentSessionStreamsStore } from "@/stores/agent-session-streams";
import { useConnectionStore } from "@/stores/connection";
import { useRuntimeStore } from "@/stores/runtime";

import { accentOfName, buildAccents } from "./accents";
import { foldAgentItems } from "./agent-fold";
import { agentGroupKey, groupAgentItems } from "./agent-groups";
import { AgentPart } from "./agent-parts";

const TAIL_LIMIT = 500;
const EMPTY_EVENTS: readonly ConsoleEvent[] = [];

export function AgentTranscript({ session }: { session: AgentSession }) {
  const id = session.id;
  const interrupt = useInterruptAgent();
  const key = agentStreamKey(id);
  const spineOpen = useConnectionStore((s) => s.status === "open");
  const stream = useAgentSessionStreamsStore((s) => s.streams[key]);
  const watch = useAgentSessionStreamsStore((s) => s.watch);
  const unwatch = useAgentSessionStreamsStore((s) => s.unwatch);
  const hydrateStream = useAgentSessionStreamsStore((s) => s.hydrateStream);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    watch(key);
    return () => unwatch(key);
  }, [key, watch, unwatch]);

  // Hydration is gated on the spine being open (buffer-then-hydrate).
  const buffering = stream?.phase !== "hydrated";
  const transcript = useAgentTranscript(id, {
    enabled: spineOpen && buffering,
  });
  useEffect(() => {
    if (transcript.data !== undefined && buffering) {
      hydrateStream(key, transcript.data);
    }
  }, [transcript.data, buffering, hydrateStream, key]);

  const events = stream?.items ?? EMPTY_EVENTS;
  // Fold to items, then collapse each agent's tool run into one Task block.
  // Trimming happens on the grouped list so a run is never cut in half.
  const items = useMemo(() => groupAgentItems(foldAgentItems(events)), [events]);
  const visible = showAll ? items : items.slice(-TAIL_LIMIT);

  const accents = useMemo(
    () => buildAccents(session.agents),
    [session.agents],
  );

  // Streaming overlays, one per speaker key with any text.
  const deltas = stream?.deltas;
  const overlays = useMemo(() => {
    const list: { key: string; message: string; reasoning: string }[] = [];
    if (deltas === undefined) return list;
    for (const [speaker, delta] of deltas) {
      if (delta.message === "" && delta.reasoning === "") continue;
      list.push({
        key: speaker,
        message: delta.message,
        reasoning: delta.reasoning,
      });
    }
    return list;
  }, [deltas]);

  // Silent workers: agents the runtime store says are busy without any
  // overlay text yet — a shimmer row per agent keeps the silence honest.
  const seats = useRuntimeStore((s) => s.bySession[id]);
  const silentWorkers = session.agents.flatMap((name) => {
    const runtime = seats?.[name];
    if (runtime === undefined) return [];
    if (runtime.state !== "thinking" && runtime.state !== "tool") return [];
    if (overlays.some((overlay) => overlay.key === name)) return [];
    return [{ name, runtime }];
  });

  return (
    <ChatRoot className="h-full">
      <ChatContent className="mx-auto w-full max-w-3xl gap-2 px-4 py-3">
        {items.length > TAIL_LIMIT && !showAll && (
          <Button
            variant="ghost"
            size="sm"
            className="mx-auto mb-2 block text-xs text-muted-foreground"
            onClick={() => setShowAll(true)}
          >
            show {items.length - TAIL_LIMIT} earlier items
          </Button>
        )}
        {visible.length === 0 &&
          overlays.length === 0 &&
          silentWorkers.length === 0 && (
            <ChatEmptyState
              title="Nothing yet"
              description={
                buffering
                  ? "hydrating…"
                  : "the table is seated — waiting for the first word"
              }
            />
          )}
        {visible.map((item) => (
          <AgentPart key={agentGroupKey(item)} item={item} accents={accents} />
        ))}
        {overlays.map((overlay) => (
          <div key={overlay.key}>
            {overlay.reasoning !== "" && (
              <Reasoning isStreaming defaultOpen>
                <ReasoningTrigger />
                <ReasoningContent>{overlay.reasoning}</ReasoningContent>
              </Reasoning>
            )}
            {overlay.message !== "" && (
              <Message from="assistant">
                <MessageContent>
                  <div
                    className={cn(
                      "mb-1 text-3xs uppercase tracking-wide opacity-80",
                      accentOfName(accents, overlay.key),
                    )}
                  >
                    {overlay.key}
                  </div>
                  <MessageResponse>{overlay.message}</MessageResponse>
                </MessageContent>
              </Message>
            )}
          </div>
        ))}
        {silentWorkers.map((worker) => (
          <div key={worker.name} className="flex items-baseline gap-2">
            <div className="min-w-0 flex-1">
              <WorkingLine name={worker.name} runtime={worker.runtime} />
            </div>
            {/* The per-agent stop the roguelike run lacked: a wedged tool call
                had no lever short of killing the whole process. */}
            <Button
              variant="ghost"
              size="sm"
              className="h-5 shrink-0 px-1.5 text-3xs text-muted-foreground hover:text-status-failed"
              disabled={interrupt.isPending}
              onClick={() => interrupt.mutate({ agentSessionId: id, agent: worker.name })}
              title={`stop ${worker.name}'s current turn (the agent and its inbox survive)`}
            >
              stop
            </Button>
          </div>
        ))}
      </ChatContent>
      <ChatScrollButton />
    </ChatRoot>
  );
}
