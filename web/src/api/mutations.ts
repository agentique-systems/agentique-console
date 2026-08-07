import { useMutation, useQueryClient } from "@tanstack/react-query";

import type {
  CreateUserSessionBody,
  CreateUserSessionResponse,
  CreateWorkspaceBody,
  ImproveMessageBody,
  ImproveMessageResponse,
  Interaction,
  PatchUserSessionBody,
  PostMessageResponse,
  ResolveInteractionBody,
  UserSession,
  Workspace,
  ManagerSession,
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

export function useInterruptUserSession() {
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiFetch<{ ok: true }>(`/api/user-sessions/${id}/interrupt`, {
        method: "POST",
      }),
  });
}

export function useCreateManagerSession() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: ({ workspaceId, profileId, sourceProfileId }: { workspaceId: string; profileId?: string; sourceProfileId?: string }) => apiFetch<ManagerSession>(`/api/workspaces/${workspaceId}/manager-sessions`, { method: "POST", body: JSON.stringify({ profileId, sourceProfileId }) }), onSuccess: (_data, vars) => void queryClient.invalidateQueries({ queryKey: keys.managerSessions(vars.workspaceId) }) });
}
export function usePostManagerMessage() {
  return useMutation({ mutationFn: ({ id, text }: { id: string; text: string }) => apiFetch<PostMessageResponse>(`/api/manager-sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) }) });
}
export function useTrustProfile() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: ({ workspaceId, profileId, revision }: { workspaceId: string; profileId: string; revision: string }) => apiFetch<{ ok: true }>(`/api/workspaces/${workspaceId}/agent-profiles/${profileId}/trust`, { method: "POST", body: JSON.stringify({ revision }) }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.profiles.all }) });
}
