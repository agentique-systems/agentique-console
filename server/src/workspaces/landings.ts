/**
 * The landing ledger: canonical-workspace landing truth. A worker's commit
 * is evidence of PRODUCED work; only a recorded merge into the canonical
 * workspace is a LANDED result — and this ledger is what keeps that second
 * fact honest over time.
 *
 * Doctrine:
 * - Landing identity is the immutable merge-commit SHA, never a branch name:
 *   branches are movable references, and a live run's "landed" branch reset
 *   left the reported commits dangling until main salvaged them by hand.
 * - Verification is boundary-driven, never polled: each new landing and each
 *   completion-coverage evaluation re-asks git whether every currently-held
 *   landing is still an ancestor of workspace HEAD. Out-of-band git (main's
 *   own shell, the operator) is exactly what this catches.
 * - Invalidation is visible and recoverable, never silent: the row keeps its
 *   historical fact (this commit landed at T), current truth flips to
 *   invalidated with a reason, a salvage branch is minted while the commit
 *   object still exists, main is woken with the remedy, and completion
 *   coverage carries a `landing_invalidated` exception until the operator
 *   waives it or reachability returns.
 */
import type { UserSessionRow } from "../db/repo.ts";
import type { LandingStore, WorktreeLandingRow } from "../db/stores/landing-store.ts";
import type { EventBus } from "../events/bus.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";

export interface LandingLedgerDeps {
  store: LandingStore;
  bus: EventBus;
  worktrees: WorktreeManager | null;
  getWorkspaceRoot: (workspaceId: string) => string;
  getUserSession: (userSessionId: string) => UserSessionRow | undefined;
}

const short = (sha: string): string => sha.slice(0, 12);

export class LandingLedger {
  readonly #deps: LandingLedgerDeps;
  #wakeNote: ((userSessionId: string, text: string) => void) | null = null;

  constructor(deps: LandingLedgerDeps) {
    this.#deps = deps;
  }

  /** Wired once in createApp: how an invalidated landing wakes main. */
  setWakeNote(wake: (userSessionId: string, text: string) => void): void {
    this.#wakeNote = wake;
  }

  /**
   * Record one successful merge, then re-verify the run's other current
   * landings against the new HEAD — the "subsequent landing" boundary, which
   * is where the live run's dangling canon commits would first have become
   * mechanically visible.
   */
  record(input: {
    userSessionId: string;
    agentSessionId: string;
    agent: string;
    branch: string;
    baseCommit: string;
    mergeCommit: string;
    filesChanged: number;
    artifactId: string | null;
  }): WorktreeLandingRow {
    const row = this.#deps.store.insert(input);
    try { this.verify(input.userSessionId); } catch { /* verification is best-effort; the landing row stands */ }
    return row;
  }

  list(userSessionId: string): WorktreeLandingRow[] {
    return this.#deps.store.listByUserSession(userSessionId);
  }

  /** Landings whose merge commit is currently NOT reachable — the coverage read. */
  invalidated(userSessionId: string): WorktreeLandingRow[] {
    return this.#deps.store.listInvalidated(userSessionId);
  }

  /**
   * Re-ask git about every landing of this run: currently-held rows whose
   * merge commit is no longer an ancestor of workspace HEAD are invalidated
   * (event + one aggregated wake note + salvage ref); invalidated rows whose
   * commit is reachable again are restored. Cheap-exits when the run has no
   * landings or no git workspace, so callers may run it at every boundary.
   */
  verify(userSessionId: string): { invalidated: WorktreeLandingRow[]; restored: WorktreeLandingRow[] } {
    const none = { invalidated: [], restored: [] };
    const worktrees = this.#deps.worktrees;
    if (!worktrees) return none;
    const rows = this.#deps.store.listByUserSession(userSessionId);
    if (rows.length === 0) return none;
    const user = this.#deps.getUserSession(userSessionId);
    if (!user) return none;
    let root: string;
    try { root = this.#deps.getWorkspaceRoot(user.workspaceId); } catch { return none; }
    let head: string;
    try {
      if (!worktrees.isGitRepo(root)) return none;
      head = worktrees.headCommit(root);
    } catch { return none; }

    const invalidated: WorktreeLandingRow[] = [];
    const restored: WorktreeLandingRow[] = [];
    for (const row of rows) {
      const reachable = worktrees.isAncestorOfHead(root, row.mergeCommit);
      if (row.invalidatedAt === null && !reachable) {
        // Preserve first: the salvage branch pins the commit against gc, so
        // the invalidation record always names a recoverable reference when
        // one could still be made.
        const salvageRef = worktrees.mintArchiveBranch(root, `landing/${row.agentSessionId}/${row.agent}`, row.mergeCommit);
        const reason = `merge commit ${short(row.mergeCommit)} is no longer reachable from workspace HEAD ${short(head)}`;
        this.#deps.store.invalidate(row.id, reason, salvageRef);
        this.#deps.bus.append({
          type: "agent_session.worktree.landing_invalidated",
          userSessionId, agentSessionId: row.agentSessionId,
          payload: { agentSessionId: row.agentSessionId, agent: row.agent, landingId: row.id, mergeCommit: row.mergeCommit, reason, salvageRef },
        });
        invalidated.push(this.#deps.store.get(row.id)!);
      } else if (row.invalidatedAt !== null && reachable) {
        this.#deps.store.restore(row.id);
        this.#deps.bus.append({
          type: "agent_session.worktree.landing_restored",
          userSessionId, agentSessionId: row.agentSessionId,
          payload: { agentSessionId: row.agentSessionId, agent: row.agent, landingId: row.id, mergeCommit: row.mergeCommit },
        });
        restored.push(this.#deps.store.get(row.id)!);
      }
    }
    if (invalidated.length > 0 && user.lifecycle === "open") {
      const lines = invalidated.map((row) =>
        `${row.agent} (session ${row.agentSessionId}): merge ${short(row.mergeCommit)}, landed ${row.landedAt}` +
        `${row.salvageRef === null ? ", commit object gone — recover from the diff artifact" + (row.artifactId === null ? "" : ` ${row.artifactId}`) : `, preserved on branch ${row.salvageRef}`}`);
      this.#wakeNote?.(userSessionId,
        `Landed work is no longer in the canonical workspace: a reset or rollback made ${invalidated.length} previously landed result(s) unreachable from HEAD — ` +
        `${lines.join("; ")}. The historical landing record is preserved and current truth is marked invalidated. ` +
        `Re-land from the named salvage branch (merge it) or accept the loss at sign-off — completion coverage will carry a landing_invalidated exception until then.`);
    }
    return { invalidated, restored };
  }
}
