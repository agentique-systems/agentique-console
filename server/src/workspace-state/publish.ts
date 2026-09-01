/**
 * The publication Workspace port (execution-model §9.4; ports/
 * publication-workspace.ts): the one Target boundary, for both Workspace
 * kinds.
 *
 * `prepare` reads the Target's current state without modifying it, selects
 * or validates the strategy exactly (`automatic` → `fast_forward` when the
 * Target still equals the Run's base Snapshot, else `merge` where the kind
 * supports it; `exact` is honored or refused), verifies that the accepted
 * final Changeset's bytes are exactly the base-to-final diff of the
 * repository, constructs the candidate in an isolated staging worktree (the
 * verification workspace), and records the prepared facts in a marker so a
 * replay returns the same result. `apply` compares the Target against the
 * persisted Target-before identity and updates it to the persisted candidate
 * with a durable receipt keyed by the Publication id — for git, one atomic
 * reference transaction moving the Target ref and creating the receipt ref;
 * for a directory, a content-digest compare-and-swap, the candidate tree's
 * files written, then a receipt file — and a replay whose receipt exists
 * returns the receipt's identity even when the Target moved again. Success is
 * never inferred from the Target equalling or containing the candidate, and
 * nothing is ever force-updated. `release` removes the staging alone.
 */
import fs from "node:fs";
import path from "node:path";
import type { PublicationStrategy, PublicationStrategyRequest, SnapshotIdentity, WorkspaceKind } from "@agentique-console/core";
import type { PublicationApplyOutcome, PublicationApplyRequest, PublicationPrepareOutcome, PublicationPrepareRequest, PublicationReleaseOutcome, PublicationReleaseRequest, PublicationWorkspacePort } from "../execution/ports/publication-workspace.ts";
import { supportsStrategy } from "./capabilities.ts";
import { boundedStderr, git, text } from "./git.ts";
import { exists, publicationDir, receiptPath, removeOwned, WorkspaceStateError, type WorkspaceStateLayout } from "./paths.ts";
import { assertDirectoryRootSync, assertDirectoryTarget, importDirectory, materializeTree, shadowRepositoryOf, treeOfCommit } from "./providers/directory.ts";
import { assertRepositoryRootSync, branchCommit, branchRefOf, publishRefTransaction, receiptCommit, synchronizeCheckout } from "./providers/git.ts";
import { commitOfIdentity, diffBetween, identitiesEqual, identityOfCommit, isClean } from "./snapshots.ts";
import { addWorktree, removeWorktree } from "./worktrees.ts";

interface PreparedMarker {
  targetBeforeSnapshot: SnapshotIdentity;
  candidateSnapshot: SnapshotIdentity;
  strategy: PublicationStrategy;
}

interface DirectoryReceipt {
  publicationId: string;
  targetSnapshot: SnapshotIdentity;
}

type StrategySelection = { kind: "selected"; strategy: PublicationStrategy } | Extract<PublicationPrepareOutcome, { kind: "refused" }>;

/** The concrete strategy for a request against a Target at or off the base Snapshot, exactly as §9.4 specifies. */
export function selectStrategy(kind: WorkspaceKind, requested: PublicationStrategyRequest, atBase: boolean): StrategySelection {
  if (requested.kind === "automatic") {
    if (atBase) return { kind: "selected", strategy: { kind: "fast_forward" } };
    const merge: PublicationStrategy = { kind: "merge" };
    if (!supportsStrategy(kind, merge)) return { kind: "refused", refusal: "strategy_unsupported", strategy: merge, message: `a ${kind} Workspace cannot merge; the Target no longer equals the Run's base Snapshot` };
    return { kind: "selected", strategy: merge };
  }
  const strategy = requested.strategy;
  if (!supportsStrategy(kind, strategy)) return { kind: "refused", refusal: "strategy_unsupported", strategy, message: `strategy ${strategy.kind === "other" ? strategy.name : strategy.kind} is not supported for a ${kind} Workspace` };
  if (strategy.kind === "fast_forward" && !atBase) return { kind: "refused", refusal: "fast_forward_unavailable", strategy: null, message: "the Target no longer equals the Run's base Snapshot" };
  return { kind: "selected", strategy };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

export class WorkspacePublication implements PublicationWorkspacePort {
  constructor(private readonly layout: WorkspaceStateLayout) {}

  private stagingOf(request: { workspaceId: string; runId: string; publicationId: string }): { dir: string; staging: string; marker: string } {
    const dir = publicationDir(this.layout, request.workspaceId, request.runId, request.publicationId);
    return { dir, staging: path.join(dir, "staging"), marker: path.join(dir, "prepared.json") };
  }

  /** The repository every git operation of a Publication runs in: the Workspace root for git, the shadow for a directory. */
  private repositoryOf(kind: WorkspaceKind, request: { workspaceId: string; workspaceRootPath: string }): string {
    if (kind === "git") {
      assertRepositoryRootSync(request.workspaceRootPath);
      return request.workspaceRootPath;
    }
    assertDirectoryRootSync(request.workspaceRootPath);
    return shadowRepositoryOf(this.layout, request.workspaceId);
  }

  async prepare(request: PublicationPrepareRequest): Promise<PublicationPrepareOutcome> {
    const kind = request.baseSnapshot.kind;
    const { dir, staging, marker } = this.stagingOf(request);
    if (exists(marker)) {
      const prepared = JSON.parse(fs.readFileSync(marker, "utf8")) as PreparedMarker;
      return { kind: "prepared", ...prepared, verificationWorkspacePath: staging, alreadyPrepared: true };
    }
    try {
      const repository = this.repositoryOf(kind, request);
      const target = await this.targetCurrent(kind, request, repository);
      if (target.kind === "missing") return { kind: "refused", refusal: "candidate_invalid", strategy: null, message: target.message };
      const atBase = identitiesEqual(target.identity, request.baseSnapshot);
      const selection = selectStrategy(kind, request.requestedStrategy, atBase);
      if (selection.kind === "refused") return selection;
      const strategy = selection.strategy;
      // The runtime-verified final Changeset must be exactly the repository's base-to-final diff; the candidate is built from those bytes.
      const bytes = await request.changeset.diff.read();
      const baseCommit = await commitOfIdentity(repository, request.changeset.beforeSnapshot);
      const afterCommit = await commitOfIdentity(repository, request.changeset.afterSnapshot);
      if (!equalBytes(bytes, await diffBetween(repository, baseCommit, afterCommit))) {
        return { kind: "refused", refusal: "candidate_invalid", strategy, message: "the final Changeset's bytes are not the base-to-final diff of the Workspace" };
      }
      let candidateCommit: string;
      if (strategy.kind === "fast_forward") {
        // A git Target fast-forwards only along history; a directory Target's current state is a fresh import whose digest equality already decided.
        const ancestor = kind === "git" ? await git(["merge-base", "--is-ancestor", target.commit, afterCommit], { cwd: repository, allowFailure: true }) : { exitCode: 0 };
        if (ancestor.exitCode !== 0) return { kind: "refused", refusal: "candidate_invalid", strategy, message: "the final Snapshot does not descend from the Target" };
        candidateCommit = afterCommit;
        await addWorktree(this.layout, { fromCwd: repository, worktreePath: staging, commit: candidateCommit });
      } else {
        await addWorktree(this.layout, { fromCwd: repository, worktreePath: staging, commit: target.commit });
        const applied = await git(["apply", "--3way", "--index", "--whitespace=nowarn"], { cwd: staging, input: bytes, allowFailure: true, timeoutMs: 300_000 });
        if (applied.exitCode !== 0) {
          await removeWorktree(this.layout, repository, staging);
          removeOwned(this.layout, dir);
          return { kind: "refused", refusal: "candidate_conflict", strategy, message: boundedStderr(applied.stderr === "" ? "the final Changeset does not apply cleanly onto the Target" : applied.stderr) };
        }
        const tree = text(await git(["write-tree"], { cwd: staging }));
        candidateCommit = text(await git(["commit-tree", tree, "-p", target.commit, "-p", afterCommit, "-m", `Agentique Console: publish Run ${request.runId}`], { cwd: staging, identity: true }));
        await git(["reset", "--hard", "--quiet", candidateCommit], { cwd: staging, identity: true });
      }
      const prepared: PreparedMarker = { targetBeforeSnapshot: target.identity, candidateSnapshot: await identityOfCommit(repository, candidateCommit, kind), strategy };
      fs.writeFileSync(marker, JSON.stringify(prepared));
      return { kind: "prepared", ...prepared, verificationWorkspacePath: staging, alreadyPrepared: false };
    } catch (error) {
      if (error instanceof WorkspaceStateError && (error.code === "unknown_snapshot" || error.code === "target_mismatch" || error.code === "not_a_repository")) {
        return { kind: "refused", refusal: "candidate_invalid", strategy: null, message: boundedStderr(error.message, 500) };
      }
      return { kind: "unavailable", message: boundedStderr(error instanceof Error ? error.message : String(error), 500) };
    }
  }

  /** The Target's current commit and identity; reading it never modifies the Target. */
  private async targetCurrent(kind: WorkspaceKind, request: PublicationPrepareRequest, repository: string): Promise<{ kind: "current"; commit: string; identity: SnapshotIdentity } | { kind: "missing"; message: string }> {
    if (kind === "git") {
      const commit = await branchCommit(repository, branchRefOf(request.target));
      if (commit === null) return { kind: "missing", message: "the Target branch does not exist" };
      return { kind: "current", commit, identity: await identityOfCommit(repository, commit, "git") };
    }
    assertDirectoryTarget(request.target);
    const imported = await importDirectory(this.layout, request.workspaceId, request.workspaceRootPath, `Agentique Console: Target state before Publication ${request.publicationId}`);
    return { kind: "current", commit: imported.commit, identity: imported.identity };
  }

  async apply(request: PublicationApplyRequest): Promise<PublicationApplyOutcome> {
    const kind = request.expectedTargetSnapshot.kind;
    try {
      if (kind === "git") return await this.applyGit(request);
      return await this.applyDirectory(request);
    } catch (error) {
      return { kind: "unavailable", message: boundedStderr(error instanceof Error ? error.message : String(error), 500) };
    }
  }

  private async applyGit(request: PublicationApplyRequest): Promise<PublicationApplyOutcome> {
    const root = this.repositoryOf("git", request);
    // The durable receipt decides replays first: even when the Target has since moved again, the recorded identity is returned.
    const receipt = await receiptCommit(root, request.publicationId);
    if (receipt !== null) return { kind: "applied", targetSnapshot: await identityOfCommit(root, receipt, "git"), alreadyApplied: true };
    if (request.expectedTargetSnapshot.kind !== "git" || request.candidateSnapshot.kind !== "git") throw new WorkspaceStateError("target_mismatch", "a git Publication carries git identities");
    const ref = branchRefOf(request.target);
    const wasClean = await isClean(root);
    const transaction = await publishRefTransaction(root, ref, request.expectedTargetSnapshot.commitId, request.candidateSnapshot.commitId, request.publicationId);
    if (transaction.kind === "committed") {
      await synchronizeCheckout(root, ref, request.candidateSnapshot.commitId, wasClean);
      return { kind: "applied", targetSnapshot: await identityOfCommit(root, request.candidateSnapshot.commitId, "git"), alreadyApplied: false };
    }
    const current = await branchCommit(root, ref);
    if (current !== null && current !== request.expectedTargetSnapshot.commitId) return { kind: "target_changed", currentTargetSnapshot: await identityOfCommit(root, current, "git") };
    return { kind: "unavailable", message: boundedStderr(transaction.message === "" ? "the reference transaction was rejected" : transaction.message, 500) };
  }

  private async applyDirectory(request: PublicationApplyRequest): Promise<PublicationApplyOutcome> {
    const receiptFile = receiptPath(this.layout, request.workspaceId, request.publicationId);
    if (exists(receiptFile)) {
      const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as DirectoryReceipt;
      return { kind: "applied", targetSnapshot: receipt.targetSnapshot, alreadyApplied: true };
    }
    assertDirectoryTarget(request.target);
    const shadow = this.repositoryOf("directory", request);
    const current = await importDirectory(this.layout, request.workspaceId, request.workspaceRootPath, `Agentique Console: Target state at Publication ${request.publicationId}`);
    if (!identitiesEqual(current.identity, request.expectedTargetSnapshot)) return { kind: "target_changed", currentTargetSnapshot: current.identity };
    const candidateCommit = await commitOfIdentity(shadow, request.candidateSnapshot);
    await materializeTree(shadow, request.workspaceRootPath, current.tree, await treeOfCommit(shadow, candidateCommit));
    const receipt: DirectoryReceipt = { publicationId: request.publicationId, targetSnapshot: request.candidateSnapshot };
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    return { kind: "applied", targetSnapshot: request.candidateSnapshot, alreadyApplied: false };
  }

  async release(request: PublicationReleaseRequest): Promise<PublicationReleaseOutcome> {
    const { dir, staging } = this.stagingOf(request);
    try {
      if (exists(staging)) {
        const kind: WorkspaceKind = request.target.kind === "branch" ? "git" : "directory";
        const repository = kind === "git" ? request.workspaceRootPath : shadowRepositoryOf(this.layout, request.workspaceId);
        await removeWorktree(this.layout, repository, staging);
      }
      removeOwned(this.layout, dir);
      return { kind: "released" };
    } catch (error) {
      return { kind: "failed", message: boundedStderr(error instanceof Error ? error.message : String(error), 500) };
    }
  }
}
