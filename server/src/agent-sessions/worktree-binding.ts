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
import { newId } from "../ids.ts";
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
      || seat.worktreePath !== null || !worktrees.isGitRepo(workspaceRoot)) return seat;
    try {
      const dirName = `seat-${branchSafe(seat.name)}-${seat.generation}-${newId("rnd").slice(-6)}`;
      const ref = worktrees.addWorktree(workspaceRoot, session.id, dirName, `seat/${session.id}/${branchSafe(seat.name)}-${seat.generation}`);
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
   * A worktree'd write agent reported terminal status: completed work merges
   * atomically into the workspace (conflict → failure handoff, workspace
   * untouched); failed work is discarded with its diff retained. Fail-open on
   * git errors — the mailbox append already happened.
   */
  landOnReport(session: AgentSessionRow, seat: AgentRow, status: "completed" | "failed"): void {
    const { repo, bus } = this.#deps;
    const worktrees = this.#deps.worktrees;
    if (!worktrees || !seat.worktreePath || !seat.worktreeBranch || !seat.worktreeBaseCommit || !this.#deps.getWorkspaceRoot) return;
    const user = repo.getUserSession(session.userSessionId);
    if (!user) return;
    const workspaceRoot = this.#deps.getWorkspaceRoot(user.workspaceId);
    const release = () => repo.patchAgent(session.id, seat.name, { worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null });
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
        worktrees.remove(workspaceRoot, seat.worktreePath, seat.worktreeBranch);
        release();
        bus.append({ type: "agent_session.worktree.discarded", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { agentSessionId: session.id, agent: seat.name, reason: status === "failed" ? "seat reported failed" : "no changes to land", artifactId } });
        return;
      }
      const outcome = worktrees.mergeBranch(workspaceRoot, seat.worktreeBranch,
        `Merge seat ${seat.name} (session ${session.id})\n\nSeat-Worktree: ${seat.worktreeBranch}`);
      worktrees.remove(workspaceRoot, seat.worktreePath, seat.worktreeBranch, { archiveBranch: !outcome.merged });
      release();
      if (outcome.merged) {
        bus.append({ type: "agent_session.worktree.merged", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { agentSessionId: session.id, agent: seat.name, mergeCommit: outcome.commit, filesChanged: diff.filesChanged, artifactId } });
        return;
      }
      bus.append({ type: "agent_session.worktree.merge_failed", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: seat.name, conflicts: outcome.conflicts, detail: outcome.detail, artifactId } });
      this.#deps.transfer({ agentSessionId: session.id, speaker: { kind: "agent", name: seat.name }, to: this.#deps.escalationTarget(session, seat.name),
        handoff: this.#deps.simpleHandoff("Completed work failed to merge", "failed",
          `The workspace advanced past this seat's base; merging its changes conflicts in: ${outcome.conflicts.join(", ") || "unknown files"}. The diff is retained as artifact ${artifactId ?? "n/a"}.`,
          "Reassign the unit against the current HEAD."), category: "failure" });
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
    const current = this.#deps.repo.getAgent(agentSessionId, agentName);
    if (current?.worktreePath && this.#deps.worktrees && fs.existsSync(current.worktreePath)) {
      try { this.#deps.worktrees.commitAll(current.worktreePath, `turn ${turnId}`, current.ownership); } catch { /* snapshot is best-effort */ }
    }
  }

  /** Archive-time removal; branches are archived so nothing is lost. */
  removeForSession(session: AgentSessionRow): void {
    if (this.#deps.worktrees && this.#deps.getWorkspaceRoot) {
      const user = this.#deps.repo.getUserSession(session.userSessionId);
      for (const seat of this.#deps.repo.listAgents(session.id)) {
        if (!seat.worktreePath || !user) continue;
        try { this.#deps.worktrees.remove(this.#deps.getWorkspaceRoot(user.workspaceId), seat.worktreePath, seat.worktreeBranch ?? "", { archiveBranch: true }); } catch { /* best effort */ }
        this.#deps.repo.patchAgent(session.id, seat.name, { worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null });
      }
    }
  }
}
