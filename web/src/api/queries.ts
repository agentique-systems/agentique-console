import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import type {
  ConfigResponse,
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
  SessionTreeResponse,
  WorkspaceTasksResponse,
  ListAgentProfilesResponse,
  GetAgentProfileResponse,
  ManagerSession,
  ManagerSessionResponse,
  TimelinePageResponse,
} from "@agentique-console/shared";

import { apiFetch, withQuery } from "./client";
import { keys } from "./keys";

/**
 * Belt-and-braces liveness until the SSE spine lands: hot surfaces refetch on
 * an 8s interval so the operator never needs to reload.
 */
const LIVE = { refetchInterval: 8_000 } as const;

/**
 * The server's defaults — currently just the orchestrator model the operator's
 * `CONSOLE_MODEL` resolves to. It cannot change without a server restart, so
 * this is fetched once and never revalidated.
 */
export function useConfig() {
  return useQuery({
    queryKey: keys.config,
    queryFn: () => apiFetch<ConfigResponse>("/api/config"),
    staleTime: Infinity,
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

export function useSessionTree(workspaceId: string | null) {
  return useQuery({ queryKey: keys.sessionTree(workspaceId ?? ""), queryFn: () => apiFetch<SessionTreeResponse>(`/api/workspaces/${workspaceId}/session-tree`), enabled: workspaceId !== null });
}

export function useWorkspaceTasks(workspaceId: string | null, filter: { userSessionId?: string; agentSessionId?: string } = {}) {
  return useQuery({ queryKey: keys.workspaceTasks(workspaceId ?? "", filter.userSessionId, filter.agentSessionId), queryFn: () => apiFetch<WorkspaceTasksResponse>(withQuery(`/api/workspaces/${workspaceId}/tasks`, filter)), enabled: workspaceId !== null });
}

export function useAgentProfiles(workspaceId: string | null) {
  return useQuery({ queryKey: keys.profiles.list(workspaceId ?? ""), queryFn: () => apiFetch<ListAgentProfilesResponse>(`/api/workspaces/${workspaceId}/agent-profiles`), enabled: workspaceId !== null });
}
export function useAgentProfile(workspaceId: string | null, id: string | null) {
  return useQuery({ queryKey: keys.profiles.detail(workspaceId ?? "", id ?? ""), queryFn: () => apiFetch<GetAgentProfileResponse>(`/api/workspaces/${workspaceId}/agent-profiles/${id}`), enabled: workspaceId !== null && id !== null });
}
export function useManagerSessions(workspaceId: string | null) {
  return useQuery({ queryKey: keys.managerSessions(workspaceId ?? ""), queryFn: () => apiFetch<ManagerSession[]>(`/api/workspaces/${workspaceId}/profile-manager-sessions`), enabled: workspaceId !== null });
}
export function useManagerSession(id: string | null) {
  return useQuery({ queryKey: keys.managerSession(id ?? ""), queryFn: () => apiFetch<ManagerSessionResponse>(`/api/profile-manager-sessions/${id}`), enabled: id !== null, refetchInterval: id ? 4_000 : false });
}
export function useTimeline(id: string | null) {
  return useInfiniteQuery({ queryKey: keys.timeline(id ?? ""), initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => apiFetch<TimelinePageResponse>(withQuery(`/api/user-sessions/${id}/timeline`, { beforeSeq: pageParam, limit: 1000 })),
    getNextPageParam: (last) => last.nextBeforeSeq ?? undefined, enabled: id !== null,
    select: (result) => { const pages = [...result.pages].reverse(); const items = pages.flatMap((page) => page.items); const unique = [...new Map(items.map((item) => [item.id, item])).values()];
      return { lanes: result.pages[0]?.lanes ?? [], items: unique, nextBeforeSeq: result.pages.at(-1)?.nextBeforeSeq ?? null }; },
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
