import { useMutation, useQueryClient } from "@tanstack/react-query";

import type {
  CreateWorkspaceBody,
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
