/**
 * The ONE session-tree walk. Ownership disjointness and the resident-lane
 * budget both need "every session sharing this workspace merge target", which
 * at a depth cap above one means the TRUE root's whole subtree — a local
 * parent+children view silently exempts cousins and grandparents.
 */
import type { AgentSessionRow } from "../db/repo.ts";

export interface SessionTreeSource {
  getAgentSession(id: string): AgentSessionRow | undefined;
  listChildSessions(parentAgentSessionId: string): AgentSessionRow[];
}

/** Walk to the true root, then BFS every descendant. Root first; includes every lifecycle — callers filter. */
export function sessionTree(repo: SessionTreeSource, agentSessionId: string): AgentSessionRow[] {
  let root = repo.getAgentSession(agentSessionId);
  while (root?.parentAgentSessionId) {
    const parent = repo.getAgentSession(root.parentAgentSessionId);
    if (!parent) break;
    root = parent;
  }
  if (!root) return [];
  const rows = [root];
  const seen = new Set([root.id]);
  const frontier = [root.id];
  while (frontier.length > 0) {
    const current = frontier.pop()!;
    for (const child of repo.listChildSessions(current)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      rows.push(child);
      frontier.push(child.id);
    }
  }
  return rows;
}
