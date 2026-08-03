/**
 * Query-key factory. The convention is load-bearing: every key starts with its
 * topic prefix, and live invalidation (the event spine, once it lands) works
 * BY PREFIX — a key outside the convention silently stops updating live.
 *
 * Topics so far: stats · workspaces · fs. Later milestones add user-sessions,
 * agent-sessions, tasks, transcripts — each as its own prefix, never as a
 * suffix on an existing one.
 */
export const keys = {
  stats: {
    all: ["stats"] as const,
  },
  workspaces: ["workspaces"] as const,
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
