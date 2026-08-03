import { useQuery } from "@tanstack/react-query";

import type {
  FsDirsResponse,
  FsRootsResponse,
  StatsResponse,
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
