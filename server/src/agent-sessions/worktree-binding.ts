/**
 * The worktree binding: how an agent session's git isolation attaches to the
 * agent lifecycle — repo bootstrap at session creation, a lazy worktree per
 * assignment at spawn, per-turn snapshots, landing (merge/discard) when a
 * report journals, and removal at archive. All five behaviors are pinned by
 * seat-worktree.e2e.
 */
import fs from "node:fs";
import { profileWritesFiles, type AgentProfile } from "../agent-profiles/registry.ts";
import type { Config } from "../config.ts";
import type { Repo, AgentRow, AgentSessionRow } from "../db/repo.ts";
import type { ArtifactStore } from "../events/artifact-store.ts";
import type { EventBus } from "../events/bus.ts";
import { collectActiveWriteClaims, findCrossScopeWrites, scopeCoversPath, type ActiveScopeClaim } from "../portfolio/ownership.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import type { LandingLedger } from "../workspaces/landings.ts";
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
  /** True while the seat has an ACTIVE TURN — landing must not yank its cwd. */
  laneBusy: (agentSessionId: string, agent: string) => boolean;
  /**
   * True while the seat's PROCESS is live (turn or not). Removing a live
   * lane's directory deletes the inode under its cwd — the next injected
   * turn then dies with "Path … does not exist" (observed twice in a live
   * run). Landing keeps the directory for live lanes; the next provisioning
   * force-reset reclaims it.
   */
  laneLive: (agentSessionId: string, agent: string) => boolean;
  transfer: Transfer;
  simpleHandoff: SimpleHandoff;
  /** Canonical-landing truth (workspaces/landings.ts): records each merge, verifies reachability. */
  landings: LandingLedger;
}

export class WorktreeBinding {
  readonly #deps: WorktreeBindingDeps;
  /** Landings deferred because the seat's turn was still running; flushed at settle. */
  readonly #deferredLandings = new Map<string, { status: "completed" | "failed"; synthetic: boolean }>();

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
   * leaves zero residue. Fail-open only for read-only profiles — a seat that
   * can write or run commands fails the spawn loudly rather than running at
   * the canonical root (see the catch below).
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
      // preserve any surviving work, re-provision.
      //
      // Preservation must happen BEFORE re-provisioning: the fresh worktree is
      // created with `-B` on the same branch name, which force-resets it — the
      // old code recorded `salvageBranch: seat.worktreeBranch` and then reset
      // that very branch, orphaning the commits its own salvage pointer named
      // (a live run's canon commits went dangling exactly this way). Archive-
      // rename the branch while it still has the work, so the salvage pointer
      // stays true past the reset.
      let salvage: { salvageBranch: string } | Record<string, never> = {};
      if (seat.salvageBranch === null && seat.worktreeBranch !== null) {
        const branchCommit = worktrees.commitOf(workspaceRoot, seat.worktreeBranch);
        if (branchCommit !== null && branchCommit !== seat.worktreeBaseCommit) {
          const archived = worktrees.remove(workspaceRoot, seat.worktreePath, seat.worktreeBranch, { archiveBranch: true }).archivedBranch;
          if (archived !== null) salvage = { salvageBranch: archived };
        }
      }
      repo.patchAgent(session.id, seat.name, { worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null, ...salvage });
      bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: seat.name, detail: `worktree path ${seat.worktreePath} no longer exists; re-provisioning a fresh worktree${"salvageBranch" in salvage ? ` (previous work preserved on ${salvage.salvageBranch})` : ""}` } });
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
      const detail = error instanceof Error ? error.message : String(error);
      const profile = seat.profileSnapshot as AgentProfile;
      // Fail-open into the canonical root is only safe for a seat that can
      // neither edit files nor run commands. A write/Bash seat spawned at the
      // root is how a live run's canonical checkout grew the stray state that
      // wedged four merges — those seats fail loudly instead.
      // Undefined tools (inherit-everything) counts as writing — conservative,
      // like profileWritesFiles.
      if (profile.tools === undefined || profile.tools.includes("Edit") || profile.tools.includes("Write") || profile.tools.includes("Bash")) {
        try {
          this.#deps.transfer({ agentSessionId: session.id, speaker: { kind: "agent", name: seat.name },
            to: this.#deps.escalationTarget(session, seat.name),
            handoff: this.#deps.simpleHandoff("Worktree provisioning failed", "failed",
              `${seat.name} could not get an isolated worktree (${detail}) and holds write/Bash tools, so it was NOT spawned into the canonical workspace.`,
              "Fix the workspace's git state (or disable isolation deliberately), then reassign."), category: "failure" });
        } catch { /* the throw below still reports through the spawn path */ }
        throw new Error(`worktree isolation unavailable for write-capable seat ${seat.name}: ${detail}`);
      }
      bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: seat.name, detail: `worktree isolation unavailable (${detail}); working directly in the workspace (read-only profile)` } });
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
    // A report journaled MID-TURN (send_handoff during the seat's own turn)
    // must not land yet: landing removes the worktree directory while the
    // process is cwd'd in it — a live run had three worktrees yanked under
    // running cargo builds this way. Defer to the turn settle.
    if (this.#deps.laneBusy(session.id, seat.name)) {
      this.#deferredLandings.set(`${session.id}/${seat.name}`, { status, synthetic: opts.synthetic === true });
      bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: seat.name, detail: `landing deferred until the turn settles (${status})` } });
      return;
    }
    const user = repo.getUserSession(session.userSessionId);
    if (!user) return;
    const workspaceRoot = this.#deps.getWorkspaceRoot(user.workspaceId);
    const release = (salvage: { salvageBranch?: string | null; salvageArtifactId?: string | null } = {}) =>
      repo.patchAgent(session.id, seat.name, { worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null, ...salvage });
    // A read-only agent's worktree exists to give it a stable snapshot;
    // discard it rather than merging incidental scratch files.
    const profile = seat.profileSnapshot as AgentProfile;
    const keepDirectory = this.#deps.laneLive(session.id, seat.name);
    if (!profileWritesFiles(profile.tools)) {
      try { worktrees.remove(workspaceRoot, seat.worktreePath, seat.worktreeBranch, { archiveBranch: false, keepDirectory }); } catch { /* best effort */ }
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
        const removed = worktrees.remove(workspaceRoot, seat.worktreePath, seat.worktreeBranch, { archiveBranch: preserve, keepDirectory });
        release(preserve ? { salvageBranch: removed.archivedBranch, salvageArtifactId: artifactId } : {});
        bus.append({ type: "agent_session.worktree.discarded", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { agentSessionId: session.id, agent: seat.name,
            reason: preserve ? "seat turn failed under the console; work archived"
              : status === "failed" ? "seat reported failed" : "no changes to land",
            artifactId, archivedBranch: removed.archivedBranch } });
        return;
      }
      // The declared-responsibility gate, at the one boundary where git
      // already knows the truth. An unplanned write into ANOTHER active
      // seat's declared scope must not silently land — the live latency/
      // pacing collision surfaced only as a raw merge conflict, after the
      // fact. The check is deliberately narrow (portfolio/ownership.ts):
      // own-scope and unclaimed paths always land, identical shared claims
      // pass by construction — authorized overlap is explicit coordination,
      // not automatic merge success; git still decides mergeability below.
      const claims = profile.exemptFromOwnership === true
        ? new Map<string, ActiveScopeClaim[]>()
        : collectActiveWriteClaims(repo, session.userSessionId);
      const crossScope = findCrossScopeWrites({
        changedPaths: worktrees.changedPaths(workspaceRoot, seat.worktreeBaseCommit, seat.worktreeBranch),
        seat: { agentSessionId: session.id, agent: seat.name, scopes: seat.ownership },
        claims,
      });
      if (crossScope.length > 0) {
        const removed = worktrees.remove(workspaceRoot, seat.worktreePath, seat.worktreeBranch, { archiveBranch: true, keepDirectory });
        release({ salvageBranch: removed.archivedBranch, salvageArtifactId: artifactId });
        const capped = crossScope.slice(0, 20);
        bus.append({ type: "agent_session.worktree.ownership_violation", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { agentSessionId: session.id, agent: seat.name,
            violations: capped.map((violation) => ({ path: violation.path, scope: violation.scope,
              ownerAgent: violation.holder.agent, ownerAgentSessionId: violation.holder.agentSessionId, ownerSessionTitle: violation.holder.sessionTitle })),
            declaredScopes: [...seat.ownership], artifactId, archivedBranch: removed.archivedBranch } });
        const lines = capped.map((violation) =>
          `${violation.path} — declared owner ${violation.holder.agent} in ${violation.holder.agentSessionId} ("${violation.holder.sessionTitle}"), scope "${violation.scope}"${violation.holder.shared ? " (held shared, but not by this seat)" : ""}`);
        this.#deps.transfer({ agentSessionId: session.id, speaker: { kind: "agent", name: seat.name }, to: this.#deps.escalationTarget(session, seat.name),
          handoff: this.#deps.simpleHandoff("Completed work blocked from landing: writes outside declared ownership", "failed",
            `${seat.name} changed path(s) inside another active seat's declared write scope without shared ownership: ${lines.join("; ")}${crossScope.length > capped.length ? `; and ${crossScope.length - capped.length} more` : ""}. ` +
            `${seat.name}'s declared write scope: ${seat.ownership.join(", ") || "(none)"}. The workspace is untouched; the work is preserved on branch ${removed.archivedBranch ?? "n/a"} and as diff artifact ${artifactId ?? "n/a"}.`,
            `Make the overlap an explicit decision — ownership is NOT changed automatically. Either route these files through their owner (send the owner the diff to apply); ` +
            `or re-commission the seat with the scope declared in sharedOwns (with why) on EVERY claimant, then reapply from the salvage branch; ` +
            `or reassign against the current HEAD without the cross-scope changes.`), category: "failure" });
        return;
      }
      const outcome = worktrees.mergeBranch(workspaceRoot, seat.worktreeBranch,
        `Merge seat ${seat.name} (session ${session.id})\n\nSeat-Worktree: ${seat.worktreeBranch}`);
      const removed = worktrees.remove(workspaceRoot, seat.worktreePath, seat.worktreeBranch, { archiveBranch: !outcome.merged, keepDirectory });
      release(outcome.merged ? {} : { salvageBranch: removed.archivedBranch, salvageArtifactId: artifactId });
      if (outcome.merged) {
        bus.append({ type: "agent_session.worktree.merged", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { agentSessionId: session.id, agent: seat.name, mergeCommit: outcome.commit, filesChanged: diff.filesChanged, artifactId } });
        // The durable distinction between "committed in a worktree" and
        // "canonically landed": the merge commit is recorded by immutable id
        // and re-verified at later boundaries (workspaces/landings.ts).
        try {
          this.#deps.landings.record({ userSessionId: session.userSessionId, agentSessionId: session.id, agent: seat.name,
            branch: seat.worktreeBranch, baseCommit: seat.worktreeBaseCommit, mergeCommit: outcome.commit,
            filesChanged: diff.filesChanged, artifactId });
        } catch (error) {
          bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
            payload: { agentSessionId: session.id, agent: seat.name, detail: `landing record failed: ${error instanceof Error ? error.message : String(error)}` } });
        }
        return;
      }
      bus.append({ type: "agent_session.worktree.merge_failed", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: seat.name, kind: outcome.kind, conflicts: outcome.conflicts, detail: outcome.detail, artifactId } });
      // The remedy depends on WHAT blocked. A live run's orchestrator was told
      // "reassign against HEAD" for a dirty canonical checkout and burned five
      // seats across four sessions re-attempting a land no seat could fix.
      // Conflicting paths carry their declared owners so the orchestrator gets
      // structural context instead of reconstructing ownership from reports.
      const conflictOwners = outcome.kind !== "conflict" ? [] : outcome.conflicts.flatMap((conflictPath) => {
        for (const [scope, holders] of claims) {
          if (!scopeCoversPath(scope, conflictPath)) continue;
          const holder = holders.find((entry) => entry.agentSessionId !== session.id || entry.agent !== seat.name);
          if (holder) return [`${conflictPath} is declared-owned by ${holder.agent} in ${holder.agentSessionId} ("${holder.sessionTitle}")`];
        }
        return [];
      });
      const explanation = outcome.kind === "conflict"
        ? `The workspace advanced past this seat's base; merging its changes conflicts in: ${outcome.conflicts.join(", ") || "unknown files"}.${conflictOwners.length > 0 ? ` ${conflictOwners.join("; ")}.` : ""}`
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

  /** The settle-side flush of a landing deferred mid-turn (see landOnReport). */
  flushDeferredLanding(session: AgentSessionRow, seatName: string): void {
    const key = `${session.id}/${seatName}`;
    const deferred = this.#deferredLandings.get(key);
    if (deferred === undefined) return;
    this.#deferredLandings.delete(key);
    const seat = this.#deps.repo.getAgent(session.id, seatName);
    if (!seat) return;
    this.landOnReport(session, seat, deferred.status, { synthetic: deferred.synthetic });
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
