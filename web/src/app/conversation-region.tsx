/**
 * Center stage: the operator↔Orchestrator conversation. Three postures:
 * draft (nothing persists until send), an active session (header + transcript
 * + composer), or the empty invite. With no explicit pick, the column
 * auto-lands on the most recent session (the sidebar's first row) — a null
 * activeUserSessionId keeps following "most recent" until the operator
 * chooses one.
 */
import { useMemo, useRef } from "react";

import { FlowEdgeTick } from "@/agents/flow-stem";
import { useUserSessions } from "@/api/queries";
import type {
  ConsoleEvent,
  UserSessionListItem,
} from "@agentique-console/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { deriveSessionState } from "@/lib/session-state";
import { userStreamKey } from "@/live/watched";
import { Composer, type ComposerHandle } from "@/session/composer";
import { DraftView } from "@/session/draft-view";
import { SessionHeader } from "@/session/session-header";
import { foldPosture } from "@/session/user-fold";
import { UserTranscript } from "@/session/user-transcript";
import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";
import { useUserSessionStreamsStore } from "@/stores/user-session-streams";

export function ConversationRegion() {
  const workspaceId = useScopeStore((s) => s.selectedWorkspaceId);
  const sessions = useUserSessions(workspaceId);
  const draftOpen = useUiStore((s) => s.draftOpen);
  const activeId = useUiStore((s) => s.activeUserSessionId);
  const beginDraft = useUiStore((s) => s.beginDraft);

  if (draftOpen) {
    return (
      <div className="flex min-h-0 flex-col border-r border-border">
        <DraftView />
      </div>
    );
  }

  if (sessions.isPending) {
    return (
      <div className="flex min-h-0 items-center justify-center border-r border-border">
        <Spinner className="size-4 text-muted-foreground" />
      </div>
    );
  }

  const rows = sessions.data ?? [];
  // Auto-land: an explicit pick wins; otherwise the most recent row.
  const session = rows.find((row) => row.id === activeId) ?? rows[0];

  if (session === undefined) {
    return (
      <div className="flex min-h-0 flex-col items-center justify-center gap-3 border-r border-border">
        <p className="text-sm text-muted-foreground">
          Nothing in flight — start a session.
        </p>
        <Button size="sm" onClick={() => beginDraft()}>
          New session
        </Button>
      </div>
    );
  }

  return <ActiveSession session={session} />;
}

/** Shared empty tail so a stream that has not hydrated yet keeps one identity. */
const NO_EVENTS: readonly ConsoleEvent[] = [];

function ActiveSession({ session }: { session: UserSessionListItem }) {
  const composerRef = useRef<ComposerHandle>(null);
  // Posture is fold-derived from the live stream's turn events; the rest of
  // the state inputs are server-authoritative fields off the list row.
  //
  // The selector MUST return the stored reference, never the fold: zustand v5
  // reads it through useSyncExternalStore with no equality check, so a selector
  // that allocates (a fresh posture object, or a `?? []` tail) never settles and
  // React unmounts the tree with "maximum update depth exceeded". Fold outside.
  const events = useUserSessionStreamsStore(
    (s) => s.streams[userStreamKey(session.id)]?.items,
  );
  const posture = useMemo(() => foldPosture(events ?? NO_EVENTS), [events]);
  const overlay = useUiStore((s) => s.awaitingInput.has(session.id));
  const state = deriveSessionState({
    runState: session.runState,
    archived: session.lifecycle === "archived",
    needsYou: session.pendingInteractions > 0 || overlay,
    posture,
    lastTurnErrored: posture.lastTurnErrored,
    // No live connection signal is plumbed yet; the spine reconnects itself.
    spineOpen: true,
  });

  return (
    <div className="relative flex min-h-0 flex-col border-r border-border">
      {/* Flow pulses glow this edge tick — the eye's cue toward the strip. */}
      <FlowEdgeTick />
      <SessionHeader session={session} state={state} />
      <UserTranscript
        session={session}
        onRequestChanges={() => composerRef.current?.focus()}
      />
      <Composer ref={composerRef} session={session} busy={posture.busy} />
    </div>
  );
}
