/**
 * Query-key factory. The convention is load-bearing: every key starts with its
 * topic prefix, and live invalidation (the event spine) works BY PREFIX — a
 * key outside the convention silently stops updating live.
 *
 * Topics: stats · workspaces · fs · user-sessions · agent-sessions · tasks ·
 * user-transcript — each its own prefix, never a suffix on an existing one.
 */
export const keys = {
  stats: {
    all: ["stats"] as const,
  },
  /** Server-resolved defaults. Fixed for the life of the process. */
  config: ["config"] as const,
  workspaces: ["workspaces"] as const,
  userSessions: {
    all: ["user-sessions"] as const,
    list: (workspaceId: string) =>
      ["user-sessions", "list", workspaceId] as const,
    detail: (id: string) => ["user-sessions", "detail", id] as const,
  },
  /**
   * Transcripts deliberately live OUTSIDE the user-sessions prefix: they are
   * hydrate-once + SSE-continued, and must not refetch on every list-level
   * invalidation. Reconnect's invalidate-all still reaches them, which is
   * exactly the re-hydration path.
   */
  userTranscript: (id: string) => ["user-transcript", id] as const,
  agentTranscript: (id: string) => ["agent-transcript", id] as const,
  agentSessions: {
    all: ["agent-sessions"] as const,
    list: (userSessionId: string) =>
      ["agent-sessions", "list", userSessionId] as const,
    detail: (id: string) => ["agent-sessions", "detail", id] as const,
  },
  tasks: {
    all: ["tasks"] as const,
    list: (userSessionId: string) => ["tasks", "list", userSessionId] as const,
  },
  sessionTreeAll: ["session-tree"] as const,
  sessionTree: (workspaceId: string) => ["session-tree", workspaceId] as const,
  workspaceTasksAll: ["workspace-tasks"] as const,
  workspaceTasks: (workspaceId: string, userSessionId?: string, agentSessionId?: string) => ["workspace-tasks", workspaceId, userSessionId ?? "", agentSessionId ?? ""] as const,
  profiles: { all: ["agent-profiles"] as const, list: (workspaceId: string) => ["agent-profiles", workspaceId] as const, detail: (workspaceId: string, id: string) => ["agent-profiles", workspaceId, id] as const },
  managerSessions: (workspaceId: string) => ["manager-sessions", workspaceId] as const,
  managerSession: (id: string) => ["manager-session", id] as const,
  timeline: (id: string, beforeSeq?: number) => ["timeline", id, beforeSeq ?? "latest"] as const,
  timelineAll: ["timeline"] as const,
  /**
   * Filesystem browsing for the workspace wizard. Its own topic on purpose:
   * NOTHING on the event spine announces a filesystem change, so these must
   * never be swept up by a prefix invalidation.
   */
  fs: {
    all: ["fs"] as const,
    roots: ["fs", "roots"] as const,
    dirs: (path: string, showHidden: boolean) =>
      ["fs", "dirs", path, showHidden] as const,
  },
} as const;
