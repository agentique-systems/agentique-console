import { useQuery } from "@tanstack/react-query";

import type {
  FsDirsResponse,
  FsRootsResponse,
  GetAgentSessionResponse,
  GetUserSessionResponse,
  ListAgentSessionsResponse,
  ListTasksResponse,
  ListUserSessionsResponse,
  StatsResponse,
  TranscriptResponse,
  Workspace,
} from "@agentique-console/shared";

import { apiFetch, withQuery } from "./client";
import { keys } from "./keys";

/**
 * Belt-and-braces liveness until the SSE spine lands: hot surfaces refetch on
 * an 8s interval so the operator never needs to reload.
 */
const LIVE = { refetchInterval: 8_000 } as const;

export function useStats() {
  return useQuery({
    queryKey: keys.stats.all,
    queryFn: () => apiFetch<StatsResponse>("/api/stats"),
    ...LIVE,
  });
}

/** Deliberately unscoped — this is the gate's and the boot check's corpus. */
export function useWorkspaces() {
  return useQuery({
    queryKey: keys.workspaces,
    queryFn: () => apiFetch<readonly Workspace[]>("/api/workspaces"),
    // No spine event announces a new workspace — the interval is its liveness.
    ...LIVE,
  });
}

// User sessions ride the spine: user_session.* events invalidate the
// ["user-sessions"] prefix, so no interval is needed here.

/** The sidebar's corpus — the server sorts by updatedAt desc. */
export function useUserSessions(workspaceId: string | null) {
  return useQuery({
    queryKey: keys.userSessions.list(workspaceId ?? ""),
    queryFn: () =>
      apiFetch<ListUserSessionsResponse>(
        withQuery("/api/user-sessions", { workspaceId: workspaceId ?? "" }),
      ),
    enabled: workspaceId !== null,
  });
}

/** Detail + pendingInteractions (question/plan cards' authoritative status). */
export function useUserSession(id: string | null) {
  return useQuery({
    queryKey: keys.userSessions.detail(id ?? ""),
    queryFn: () =>
      apiFetch<GetUserSessionResponse>(`/api/user-sessions/${id}`),
    enabled: id !== null,
  });
}

/**
 * Raw transcript envelopes for stream hydration. The caller gates `enabled`
 * on spine-open + stream-buffering (the buffer-then-hydrate handshake) — this
 * query must never race an unopened spine.
 */
export function useUserTranscript(
  id: string,
  options: { enabled: boolean },
) {
  return useQuery({
    queryKey: keys.userTranscript(id),
    queryFn: () =>
      apiFetch<TranscriptResponse>(`/api/user-sessions/${id}/transcript`),
    enabled: options.enabled,
    staleTime: Infinity,
  });
}

// Agent sessions and tasks ride the spine too: the router invalidates the
// ["agent-sessions"] / ["tasks"] prefixes on their lifecycle events.

/** The strip's corpus — every agent session under the active user session. */
export function useAgentSessions(userSessionId: string | null) {
  return useQuery({
    queryKey: keys.agentSessions.list(userSessionId ?? ""),
    queryFn: () =>
      apiFetch<ListAgentSessionsResponse>(
        `/api/user-sessions/${userSessionId}/agent-sessions`,
      ),
    enabled: userSessionId !== null,
  });
}

/** The inspector header's session row (messages come from the transcript). */
export function useAgentSession(id: string | null) {
  return useQuery({
    queryKey: keys.agentSessions.detail(id ?? ""),
    queryFn: () =>
      apiFetch<GetAgentSessionResponse>(`/api/agent-sessions/${id}`),
    enabled: id !== null,
  });
}

/**
 * Raw transcript envelopes for agent-stream hydration. Same handshake as the
 * user lane: the caller gates `enabled` on spine-open + stream-buffering.
 */
export function useAgentTranscript(
  id: string,
  options: { enabled: boolean },
) {
  return useQuery({
    queryKey: keys.agentTranscript(id),
    queryFn: () =>
      apiFetch<TranscriptResponse>(`/api/agent-sessions/${id}/transcript`),
    enabled: options.enabled,
    staleTime: Infinity,
  });
}

/** The strip's task ledger for the active user session (all lists merged). */
export function useTasks(userSessionId: string | null) {
  return useQuery({
    queryKey: keys.tasks.list(userSessionId ?? ""),
    queryFn: () =>
      apiFetch<ListTasksResponse>(`/api/user-sessions/${userSessionId}/tasks`),
    enabled: userSessionId !== null,
  });
}

// Its own `fs` key topic: nothing on the event spine announces a filesystem
// change, so these must never be swept up by a prefix invalidation. retry:0
// throughout — a 403/404 on a path is an answer to show the operator
// immediately, not something to retry behind their back.

export function useFsRoots() {
  return useQuery({
    queryKey: keys.fs.roots,
    queryFn: () => apiFetch<FsRootsResponse>("/api/fs/roots"),
    staleTime: 60_000,
    retry: 0,
  });
}

export function useFsDirs(path: string | null, showHidden: boolean) {
  return useQuery({
    queryKey: keys.fs.dirs(path ?? "", showHidden),
    queryFn: () =>
      apiFetch<FsDirsResponse>(
        withQuery("/api/fs/dirs", {
          path: path ?? undefined,
          showHidden: showHidden ? 1 : undefined,
        }),
      ),
    enabled: path !== null,
    staleTime: 30_000,
    retry: 0,
  });
}
