/**
 * The ONE session-tree module. AgentSession rows form a forest —
 * `parentAgentSessionId` is the edge, `depth` the stored level (0 =
 * top-level, capped by `config.policy.maxSessionDepth`) — and every consumer
 * that walks it must agree on the same relationship semantics: a local
 * parent+children view silently exempts grandchildren, which are legal at
 * the default cap. Subtree walks (commission budgets, lifecycle cascades),
 * ancestor walks (budget checks, status bubbling) and the deterministic
 * display order (timeline, portfolio) all live here so runtime, inspection
 * and UI cannot drift apart one traversal at a time.
 */
import type { AgentSessionRow } from "../db/repo.ts";

export interface SessionTreeSource {
  getAgentSession(id: string): AgentSessionRow | undefined;
  listChildSessions(parentAgentSessionId: string): AgentSessionRow[];
}

/**
 * The given session and every descendant — NO walk to the true root. The
 * commission-budget spend needs exactly this set: billing from the true root
 * would charge a sibling branch's spend against the wrong budget.
 */
export function sessionSubtree(repo: SessionTreeSource, agentSessionId: string): AgentSessionRow[] {
  const root = repo.getAgentSession(agentSessionId);
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

/**
 * The ancestor chain, nearest first, excluding the session itself. Bounded by
 * the depth cap in healthy data; the seen-set makes a corrupt cycle terminate
 * instead of hanging the caller.
 */
export function sessionAncestors(repo: SessionTreeSource, agentSessionId: string): AgentSessionRow[] {
  const ancestors: AgentSessionRow[] = [];
  const seen = new Set([agentSessionId]);
  let current = repo.getAgentSession(agentSessionId);
  while (current?.parentAgentSessionId) {
    if (seen.has(current.parentAgentSessionId)) break;
    const parent = repo.getAgentSession(current.parentAgentSessionId);
    if (!parent) break;
    seen.add(parent.id);
    ancestors.push(parent);
    current = parent;
  }
  return ancestors;
}

/** Siblings order by creation, id as the same-millisecond tiebreak — never DB return order. */
function byCreation(a: AgentSessionRow, b: AgentSessionRow): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * THE deterministic display/traversal order over one UserSession's rows:
 * depth-first pre-order (every session directly after its parent, before any
 * uncle), roots and siblings by (createdAt, id). A row whose parent is absent
 * from the input is treated as a root rather than dropped — a nested session
 * must never disappear from an inspection surface, whatever the data looks
 * like. Pure over the rows it is given; callers pass every lifecycle and
 * filter afterwards.
 */
export function orderedSessionForest(rows: readonly AgentSessionRow[]): AgentSessionRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const children = new Map<string, AgentSessionRow[]>();
  const roots: AgentSessionRow[] = [];
  for (const row of rows) {
    if (row.parentAgentSessionId !== null && byId.has(row.parentAgentSessionId)) {
      const siblings = children.get(row.parentAgentSessionId) ?? [];
      siblings.push(row);
      children.set(row.parentAgentSessionId, siblings);
    } else {
      roots.push(row);
    }
  }
  roots.sort(byCreation);
  for (const siblings of children.values()) siblings.sort(byCreation);
  const ordered: AgentSessionRow[] = [];
  const visit = (row: AgentSessionRow) => {
    ordered.push(row);
    for (const child of children.get(row.id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return ordered;
}
