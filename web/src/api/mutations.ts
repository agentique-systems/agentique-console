import { useMutation, useQueryClient } from "@tanstack/react-query";

import type {
  OperatorRequirementStatusBody,
  RequirementNodeWire,
  CreateUserSessionBody,
  CreateUserSessionResponse,
  CreateWorkspaceBody,
  ImproveMessageBody,
  ImproveMessageResponse,
  Interaction,
  PatchUserSessionBody,
  PauseSystemBody,
  PauseSystemResponse,
  RunSignoffBody,
  SystemPauseState,
  PostMessageResponse,
  ResolveInteractionBody,
  ScheduledAssignment,
  UserSession,
  Workspace,
} from "@agentique-console/shared";

import { apiFetch } from "./client";
import { keys } from "./keys";

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkspaceBody) =>
      apiFetch<Workspace>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: keys.workspaces }),
  });
}

/** Create-on-first-message: this one call mints the session AND posts the text. */
export function useCreateUserSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUserSessionBody) =>
      apiFetch<CreateUserSessionResponse>("/api/user-sessions", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: keys.userSessions.all }),
  });
}

export function usePatchUserSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & PatchUserSessionBody) =>
      apiFetch<UserSession>(`/api/user-sessions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: keys.userSessions.all }),
  });
}

/** 202: the reply arrives over the spine, not in this response. */
export function usePostUserMessage() {
  return useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      apiFetch<PostMessageResponse>(`/api/user-sessions/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
  });
}

/**
 * The operator's verdict on a proposed run completion. 409 = the run is no
 * longer awaiting one (someone else resolved it, or a chat message already
 * reopened it).
 */
export function useResolveSignoff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, body }: { sessionId: string; body: RunSignoffBody }) =>
      apiFetch<UserSession>(`/api/user-sessions/${sessionId}/signoff`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, { sessionId }) => {
      void queryClient.invalidateQueries({ queryKey: keys.userSessions.detail(sessionId) });
      void queryClient.invalidateQueries({ queryKey: keys.userSessions.all });
    },
  });
}

/** Answers a question card or decides a plan. 409 = already resolved. */
export function useResolveInteraction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      sessionId,
      interactionId,
      body,
    }: {
      sessionId: string;
      interactionId: string;
      body: ResolveInteractionBody;
    }) =>
      apiFetch<Interaction>(
        `/api/user-sessions/${sessionId}/interactions/${interactionId}`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: (_data, { sessionId }) =>
      void queryClient.invalidateQueries({
        queryKey: keys.userSessions.detail(sessionId),
      }),
  });
}

/** The operator's own verdict on one requirement — their word IS the gate. */
export function useSetRequirementStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, requirementId, body }: {
      sessionId: string;
      requirementId: string;
      body: OperatorRequirementStatusBody;
    }) =>
      apiFetch<RequirementNodeWire>(
        `/api/user-sessions/${sessionId}/requirements/${requirementId}/status`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: (_data, { sessionId }) => {
      void queryClient.invalidateQueries({ queryKey: keys.userSessions.requirements(sessionId) });
      void queryClient.invalidateQueries({ queryKey: keys.userSessions.all });
    },
  });
}

/** Withdraw a scheduled assignment before dispatch. 409 = already settled. */
export function useCancelAssignment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) =>
      apiFetch<ScheduledAssignment>(`/api/scheduled-assignments/${assignmentId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.tasks.all });
      void queryClient.invalidateQueries({ queryKey: keys.workspaceTasksAll });
    },
  });
}

/** A rewrite of the draft. Nothing persists, so there is nothing to invalidate. */
export function useImproveMessage() {
  return useMutation({
    mutationFn: (body: ImproveMessageBody) =>
      apiFetch<ImproveMessageResponse>("/api/compose/improve", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}

/**
 * The top bar's Pause: the whole system, every lane. The response IS the new
 * state, so the cache flips at once instead of waiting on the spine.
 */
export function usePauseSystem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PauseSystemBody = {}) =>
      apiFetch<PauseSystemResponse>("/api/system/pause", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: ({ interrupted: _interrupted, ...state }) => queryClient.setQueryData<SystemPauseState>(keys.system.pause, state),
  });
}

export function useResumeSystem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<SystemPauseState>("/api/system/resume", { method: "POST" }),
    onSuccess: (state) => queryClient.setQueryData<SystemPauseState>(keys.system.pause, state),
  });
}

export function useInterruptUserSession() {
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiFetch<{ ok: true }>(`/api/user-sessions/${id}/interrupt`, {
        method: "POST",
      }),
  });
}

/** Per-agent stop: kills one wedged turn, never the session or the process. */
export function useInterruptAgent() {
  return useMutation({
    mutationFn: ({ agentSessionId, agent, reason }: { agentSessionId: string; agent: string; reason?: string }) =>
      apiFetch<undefined>(
        `/api/agent-sessions/${agentSessionId}/agents/${encodeURIComponent(agent)}/interrupt`,
        { method: "POST", body: JSON.stringify({ reason: reason ?? "" }) },
      ),
  });
}

export function useTrustProfile() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: ({ workspaceId, profileId, revision }: { workspaceId: string; profileId: string; revision: string }) => apiFetch<{ ok: true }>(`/api/workspaces/${workspaceId}/agent-profiles/${profileId}/trust`, { method: "POST", body: JSON.stringify({ revision }) }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.profiles.all }) });
}
