/**
 * The worktree binding: how an agent session's git isolation attaches to the
 * agent lifecycle — repo bootstrap at session creation, a lazy worktree per
 * assignment at spawn, per-turn snapshots, landing (merge/discard) when a
 * report journals, and removal at archive. All five behaviors are pinned by
 * seat-worktree.e2e.
 */
import fs from "node:fs";
import type { AgentProfile } from "../agent-profiles/registry.ts";
import type { Config } from "../config.ts";
import type { Repo, AgentRow, AgentSessionRow } from "../db/repo.ts";
import type { ArtifactStore } from "../events/artifact-store.ts";
import type { EventBus } from "../events/bus.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import type { SimpleHandoff, Transfer } from "./seams.ts";

/** Agent names may contain chars git refs forbid; branch components drop them. */
function branchSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "-");
}

export interface WorktreeBindingDeps {
  repo: Repo;
  bus: EventBus;
  artifacts: ArtifactStore;
  config: Config;
  worktrees: WorktreeManager | null;
  getWorkspaceRoot: (workspaceId: string) => string;
  /** Where a merge-conflict failure escalates (routing's escalationTarget). */
  escalationTarget: (session: AgentSessionRow, agentName: string) => string;
  /** Routing's `isReviewRole` — decides which base a seat's snapshot is cut from. */
  isReviewRole: (session: AgentSessionRow, agentName: string) => boolean;
  transfer: Transfer;
  simpleHandoff: SimpleHandoff;
}

export class WorktreeBinding {
  readonly #deps: WorktreeBindingDeps;

  constructor(deps: WorktreeBindingDeps) { this.#deps = deps; }

  /**
   * Fail-open, exactly like `ensureAgentWorktree`: if the workspace cannot
   * become a repository the run proceeds without isolation and says so, rather
   * than refusing to start.
   */
  ensureWorkspaceRepo(workspaceId: string, userSessionId: string): void {
    const worktrees = this.#deps.worktrees;
    if (!worktrees || !this.#deps.getWorkspaceRoot || this.#deps.config.infra.autoInitGit === false) return;
    if (this.#deps.config.policy.agentWorktrees === false) return;
    let root: string;
    try { root = this.#deps.getWorkspaceRoot(workspaceId); } catch { return; }
    if (worktrees.isGitRepo(root)) return;
    const forbidden = (this.#deps.config.infra.fsRoots ?? []).map((entry) => entry.path);
    const outcome = worktrees.initRepo(root, { forbiddenRoots: forbidden });
    this.#deps.bus.append({
      type: "user_session.runtime.noted", userSessionId,
      payload: {
        userSessionId,
        detail: outcome.initialized
          ? `workspace initialised as a git repository so each seat gets an isolated worktree (${outcome.reason})`
          : `seats will share the workspace directory — no isolation: ${outcome.reason}`,
      },
    });
  }

  /**
   * Default-on isolation for EVERY agent in a git workspace: a lazy worktree
   * per assignment, so completed work lands atomically and interrupted work
   * leaves zero residue. Fail-open — if the worktree cannot be created the
   * agent runs directly in the workspace, with a runtime notice.
   */
  ensureAgentWorktree(session: AgentSessionRow, seat: AgentRow, workspaceRoot: string): AgentRow {
    const { repo, bus } = this.#deps;
    const worktrees = this.#deps.worktrees;
    // Read-only agents get one too: a reviewer needs a STABLE SNAPSHOT of
    // what it is reviewing. Its worktree is discarded rather than merged —
    // `landOnReport` only merges an agent whose profile can write.
    if (!worktrees || this.#deps.config.policy.agentWorktrees === false || seat.role === "coordinator"
      || !worktrees.isGitRepo(workspaceRoot)) return seat;
    if (seat.worktreePath !== null) {
      if (fs.existsSync(seat.worktreePath)) return seat;
      // A dangling pointer (crash between removal and release, or an
      // out-of-band deletion) used to spawn the SDK into a nonexistent cwd —
      // 13 "Path does not exist" scheduler failures in one live run. Clear it,
      // keep a salvage pointer to the branch (it may still exist), re-provision.
      repo.patchAgent(session.id, seat.name, { worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null,
        ...(seat.salvageBranch === null && seat.worktreeBranch !== null ? { salvageBranch: seat.worktreeBranch } : {}) });
      bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: seat.name, detail: `worktree path ${seat.worktreePath} no longer exists; re-provisioning a fresh worktree` } });
      seat = repo.getAgent(session.id, seat.name) ?? seat;
    }
    try {
      // Stable path per seat: a resumed provider session's remembered cwd
      // stays valid across assignment cycles and build caches survive.
      // (Previously seat-<name>-<generation>-<random>: every re-provision was
      // a new world, and 37 of 64 worktree creations in one live run were
      // re-provisions of a seat that already had one.)
      const dirName = `seat-${branchSafe(seat.name)}`;
      const base = this.#reviewBase(session, seat);
      const ref = worktrees.addWorktree(workspaceRoot, session.id, dirName, `seat/${session.id}/${branchSafe(seat.name)}-${seat.generation}`,
        base === null ? {} : { base });
      repo.patchAgent(session.id, seat.name, { worktreePath: ref.path, worktreeBaseCommit: ref.baseCommit, worktreeBranch: ref.branch });
      bus.append({ type: "agent_session.worktree.created", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: seat.name, branch: ref.branch, baseCommit: ref.baseCommit } });
      return repo.getAgent(session.id, seat.name) ?? seat;
    } catch (error) {
      bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: seat.name, detail: `worktree isolation unavailable (${error instanceof Error ? error.message : String(error)}); working directly in the workspace` } });
      return seat;
    }
  }

  /**
   * The branch a reviewer's snapshot must be cut from: the unmerged worktree
   * branch of whoever handed it the work. Null for everyone else, and for a
   * sender whose work already landed.
   *
   * Without this a reviewer is given a snapshot that provably does not contain
   * the thing it was sent to review. That happened live — the judge found
   * nothing at the shared path, was blocked from serving the generator's
   * worktree, and ended up reading the file out of the branch with raw git.
   */
  #reviewBase(session: AgentSessionRow, seat: AgentRow): string | null {
    if (!this.#deps.isReviewRole(session, seat.name)) return null;
    const inbound = this.#deps.repo.latestHandoff({
      userSessionId: session.userSessionId, agentSessionId: session.id,
      recipient: seat.name, excludeCheckpoints: true,
    });
    if (!inbound || inbound.sender === seat.name) return null;
    return this.#deps.repo.getAgent(session.id, inbound.sender)?.worktreeBranch ?? null;
  }

  /**
   * The session reported: land every write seat that still holds a worktree.
   *
   * `landOnReport` fires on a SEAT declaring itself completed, which whole
   * patterns never do — an evaluator_optimizer generator reports
   * `needs_verification` to its evaluator, exactly as its brief instructs, so
   * that condition is unreachable and its work stayed on an unmerged branch
   * while the operator's workspace sat empty. Landing belongs to the moment the
   * SESSION concludes; the seat-level path stays as the eager optimisation.
   */
  landForSession(session: AgentSessionRow): void {
    if (!this.#deps.worktrees) return;
    for (const seat of this.#deps.repo.listAgents(session.id)) {
      if (seat.worktreePath) this.landOnReport(session, seat, "completed");
    }
  }

  /**
   * A worktree'd write agent reported terminal status: completed work merges
   * atomically into the workspace (conflict → failure handoff, workspace
   * untouched); failed work is discarded with its diff retained — EXCEPT when
   * the failure is console-synthesized (`opts.synthetic`): the agent never
   * judged its own work bad, the infrastructure died under it, so the branch
   * is archived rather than deleted and the salvage pointers are recorded on
   * the seat. A live run lost 35 minutes of verified work to the old
   * indiscriminate `branch -D`. Fail-open on git errors — the mailbox append
   * already happened.
   */
  landOnReport(session: AgentSessionRow, seat: AgentRow, status: "completed" | "failed", opts: { synthetic?: boolean } = {}): void {
    const { repo, bus } = this.#deps;
    const worktrees = this.#deps.worktrees;
    if (!worktrees || !seat.worktreePath || !seat.worktreeBranch || !seat.worktreeBaseCommit || !this.#deps.getWorkspaceRoot) return;
    const user = repo.getUserSession(session.userSessionId);
    if (!user) return;
    const workspaceRoot = this.#deps.getWorkspaceRoot(user.workspaceId);
    const release = (salvage: { salvageBranch?: string | null; salvageArtifactId?: string | null } = {}) =>
      repo.patchAgent(session.id, seat.name, { worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null, ...salvage });
    // A read-only agent's worktree exists to give it a stable snapshot;
    // discard it rather than merging incidental scratch files.
    const profile = seat.profileSnapshot as AgentProfile;
    if (!profile.tools.includes("Edit") && !profile.tools.includes("Write")) {
      try { worktrees.remove(workspaceRoot, seat.worktreePath, seat.worktreeBranch, { archiveBranch: false }); } catch { /* best effort */ }
      release();
      bus.append({ type: "agent_session.worktree.discarded", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: seat.name, reason: "read-only seat: snapshot discarded, nothing to land", artifactId: null } });
      return;
    }
    try {
      worktrees.commitAll(seat.worktreePath, `seat ${seat.name}: reported ${status}`, seat.ownership);
      const diff = worktrees.captureDiff(workspaceRoot, seat.worktreeBaseCommit, seat.worktreeBranch);
      const artifactId = diff.filesChanged === 0 ? null
        : this.#deps.artifacts.store(`${diff.stat}\n\n${diff.patch}`, "text/x-patch", { userSessionId: session.userSessionId, agentSessionId: session.id }).artifactId;
      if (status === "failed" || diff.filesChanged === 0) {
        // Infra failure with real work: archive, never delete. An agent that
        // ITSELF reported failed judged its work; the console judging FOR a
        // dead agent must not destroy what it cannot evaluate.
        const preserve = status === "failed" && opts.synthetic === true && diff.filesChanged > 0;
        const removed = worktrees.remove(workspaceRoot, seat.worktreePath, seat.worktreeBranch, { archiveBranch: preserve });
        release(preserve ? { salvageBranch: removed.archivedBranch, salvageArtifactId: artifactId } : {});
        bus.append({ type: "agent_session.worktree.discarded", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { agentSessionId: session.id, agent: seat.name,
            reason: preserve ? "seat turn failed under the console; work archived"
              : status === "failed" ? "seat reported failed" : "no changes to land",
            artifactId, archivedBranch: removed.archivedBranch } });
        return;
      }
      const outcome = worktrees.mergeBranch(workspaceRoot, seat.worktreeBranch,
        `Merge seat ${seat.name} (session ${session.id})\n\nSeat-Worktree: ${seat.worktreeBranch}`);
      const removed = worktrees.remove(workspaceRoot, seat.worktreePath, seat.worktreeBranch, { archiveBranch: !outcome.merged });
      release(outcome.merged ? {} : { salvageBranch: removed.archivedBranch, salvageArtifactId: artifactId });
      if (outcome.merged) {
        bus.append({ type: "agent_session.worktree.merged", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { agentSessionId: session.id, agent: seat.name, mergeCommit: outcome.commit, filesChanged: diff.filesChanged, artifactId } });
        return;
      }
      bus.append({ type: "agent_session.worktree.merge_failed", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: seat.name, kind: outcome.kind, conflicts: outcome.conflicts, detail: outcome.detail, artifactId } });
      // The remedy depends on WHAT blocked. A live run's orchestrator was told
      // "reassign against HEAD" for a dirty canonical checkout and burned five
      // seats across four sessions re-attempting a land no seat could fix.
      const explanation = outcome.kind === "conflict"
        ? `The workspace advanced past this seat's base; merging its changes conflicts in: ${outcome.conflicts.join(", ") || "unknown files"}.`
        : outcome.kind === "dirty_tree"
          ? `The canonical checkout has local changes the Console could not stash aside, so git refused the merge before it started. This is workspace state, not a defect in the seat's work — retrying the seat will not fix it. Detail: ${outcome.detail}`
          : `The merge failed: ${outcome.detail}`;
      const remedy = outcome.kind === "conflict"
        ? "Reassign the unit against the current HEAD."
        : outcome.kind === "dirty_tree"
          ? "Resolve the canonical checkout's local changes (ask the operator if they are theirs), then land the archived branch — do not respawn the seat."
          : "Inspect the detail; the work is preserved on the archived branch and as the diff artifact.";
      this.#deps.transfer({ agentSessionId: session.id, speaker: { kind: "agent", name: seat.name }, to: this.#deps.escalationTarget(session, seat.name),
        handoff: this.#deps.simpleHandoff("Completed work failed to merge", "failed",
          `${explanation} The diff is retained as artifact ${artifactId ?? "n/a"}${removed.archivedBranch === null ? "" : ` and on branch ${removed.archivedBranch}`}.`,
          remedy), category: "failure" });
    } catch (error) {
      bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: seat.name, detail: `worktree landing failed: ${error instanceof Error ? error.message : String(error)}` } });
    }
  }

  /**
   * File-state snapshot per settled turn: mid-assignment crash recovery is
   * lossless, and the completion diff (base..branch) is unaffected.
   */
  snapshotTurn(agentSessionId: string, agentName: string, turnId: string): void {
    this.snapshot(agentSessionId, agentName, `turn ${turnId}`);
  }

  /**
   * Commit whatever the seat has written so far. Also called when a seat hands
   * work to a teammate MID-TURN, which is the ordinary case: the transfer
   * happens long before the sender's turn settles, so without this a recipient
   * seated on the sender's branch gets a snapshot that does not yet contain the
   * thing it was sent.
   */
  snapshot(agentSessionId: string, agentName: string, message: string): void {
    const current = this.#deps.repo.getAgent(agentSessionId, agentName);
    if (current?.worktreePath && this.#deps.worktrees && fs.existsSync(current.worktreePath)) {
      try { this.#deps.worktrees.commitAll(current.worktreePath, message, current.ownership); } catch { /* snapshot is best-effort */ }
    }
  }

  /** Archive-time removal; branches are archived so nothing is lost. */
  removeForSession(session: AgentSessionRow): void {
    if (this.#deps.worktrees && this.#deps.getWorkspaceRoot) {
      const user = this.#deps.repo.getUserSession(session.userSessionId);
      for (const seat of this.#deps.repo.listAgents(session.id)) {
        if (!seat.worktreePath || !user) continue;
        let archivedBranch: string | null = null;
        try {
          archivedBranch = this.#deps.worktrees.remove(this.#deps.getWorkspaceRoot(user.workspaceId), seat.worktreePath, seat.worktreeBranch ?? "", { archiveBranch: true }).archivedBranch;
        } catch { /* best effort */ }
        this.#deps.repo.patchAgent(session.id, seat.name, { worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null,
          ...(archivedBranch === null ? {} : { salvageBranch: archivedBranch }) });
      }
    }
  }
}
