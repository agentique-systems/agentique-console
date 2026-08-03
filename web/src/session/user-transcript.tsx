/**
 * The operator↔Orchestrator transcript: hydrated once from raw events via the
 * pure fold, continued live by the spine (buffer-then-hydrate — hydration is
 * gated on the spine being OPEN so no event falls between live start and the
 * server snapshot). One streaming overlay per speaker, retired by that
 * speaker's persisted message; a silent-worker shimmer covers the stretch
 * where the orchestrator works without streaming text.
 */
import { useEffect, useMemo, useState } from "react";

import { useUserSession, useUserTranscript } from "@/api/queries";
import type { ConsoleEvent, UserSession } from "@agentique-console/shared";
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
import { userStreamKey } from "@/live/watched";
import { useConnectionStore } from "@/stores/connection";
import { useRuntimeStore } from "@/stores/runtime";
import { useUserSessionStreamsStore } from "@/stores/user-session-streams";

import { foldUserItems, itemKey } from "./user-fold";
import { UserPart } from "./user-parts";

const TAIL_LIMIT = 500;
const EMPTY_EVENTS: readonly ConsoleEvent[] = [];

export function UserTranscript({
  session,
  onRequestChanges,
}: {
  session: UserSession;
  onRequestChanges: () => void;
}) {
  const id = session.id;
  const key = userStreamKey(id);
  const spineOpen = useConnectionStore((s) => s.status === "open");
  const stream = useUserSessionStreamsStore((s) => s.streams[key]);
  const watch = useUserSessionStreamsStore((s) => s.watch);
  const unwatch = useUserSessionStreamsStore((s) => s.unwatch);
  const hydrateStream = useUserSessionStreamsStore((s) => s.hydrateStream);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    watch(key);
    return () => unwatch(key);
  }, [key, watch, unwatch]);

  // Hydration is gated on the spine being open (buffer-then-hydrate).
  const buffering = stream?.phase !== "hydrated";
  const transcript = useUserTranscript(id, {
    enabled: spineOpen && buffering,
  });
  useEffect(() => {
    if (transcript.data !== undefined && buffering) {
      hydrateStream(key, transcript.data);
    }
  }, [transcript.data, buffering, hydrateStream, key]);

  // The card statuses (notably "stale") come from the detail endpoint.
  const detail = useUserSession(id);
  const pendingById = useMemo(
    () =>
      new Map(
        (detail.data?.pendingInteractions ?? []).map(
          (interaction) => [interaction.id, interaction] as const,
        ),
      ),
    [detail.data],
  );

  const events = stream?.items ?? EMPTY_EVENTS;
  const items = useMemo(() => foldUserItems(events), [events]);
  const visible = showAll ? items : items.slice(-TAIL_LIMIT);

  // Streaming overlays, one per speaker key with any text.
  const deltas = stream?.deltas;
  const overlays = useMemo(() => {
    const list: { key: string; message: string; reasoning: string }[] = [];
    if (deltas === undefined) return list;
    for (const [speaker, delta] of deltas) {
      if (delta.message === "" && delta.reasoning === "") continue;
      list.push({ key: speaker, message: delta.message, reasoning: delta.reasoning });
    }
    return list;
  }, [deltas]);

  // Silent worker: the runtime store says the orchestrator is busy but no
  // overlay text has arrived — a shimmer row keeps the silence honest.
  const orchestrator = useRuntimeStore(
    (s) => s.bySession[id]?.["orchestrator"],
  );
  const orchestratorOverlay = overlays.find((o) => o.key === "orchestrator");
  const silentlyWorking =
    orchestratorOverlay === undefined &&
    (orchestrator?.state === "thinking" || orchestrator?.state === "tool");

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
        {visible.length === 0 && overlays.length === 0 && !silentlyWorking && (
          <ChatEmptyState
            title="A fresh session"
            description={
              buffering
                ? "hydrating…"
                : "say something — the orchestrator is listening"
            }
          />
        )}
        {visible.map((item) => (
          <UserPart
            key={itemKey(item)}
            sessionId={id}
            item={item}
            pendingById={pendingById}
            onRequestChanges={onRequestChanges}
          />
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
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground opacity-80">
                    {overlay.key}
                  </div>
                  <MessageResponse>{overlay.message}</MessageResponse>
                </MessageContent>
              </Message>
            )}
          </div>
        ))}
        {silentlyWorking && orchestrator !== undefined && (
          <WorkingLine name="orchestrator" runtime={orchestrator} />
        )}
      </ChatContent>
      <ChatScrollButton />
    </ChatRoot>
  );
}
