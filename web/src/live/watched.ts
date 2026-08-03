/**
 * Watched-stream registry: transient events (streaming deltas) for sessions
 * without a mounted transcript view are dropped at the router — persisted
 * events still flow so lingering streams stay complete.
 */
const watchedKeys = new Set<string>();

export const watched = {
  add(key: string): void {
    watchedKeys.add(key);
  },
  remove(key: string): void {
    watchedKeys.delete(key);
  },
  has(key: string): boolean {
    return watchedKeys.has(key);
  },
  clear(): void {
    watchedKeys.clear();
  },
};

/** Stream-store/watched key for a user session's transcript. */
export function userStreamKey(sessionId: string): string {
  return `us:${sessionId}`;
}

/** Stream-store/watched key for an agent session's transcript (M6/M7). */
export function agentStreamKey(sessionId: string): string {
  return `as:${sessionId}`;
}
