/**
 * The publication Workspace port (execution-model §9.4; ports/
 * publication-workspace.ts): the one Target boundary.
 *
 * Only the git kind publishes. `prepare` reads the Target's current state
 * without modifying it, selects or validates the strategy exactly
 * (`automatic` → `fast_forward` when the Target still equals the Run's base
 * Snapshot, else `merge`; `exact` is honored or refused), verifies that the
 * accepted final Changeset's bytes are exactly the base-to-final diff of the
 * repository, constructs the candidate in an isolated staging worktree (the
 * verification workspace) kept reachable through a candidate ref, and
 * records the prepared facts in a marker written atomically, so a replay
 * returns the same result — a damaged marker is discarded and the candidate
 * rebuilt deterministically, a lost staging worktree is recreated from the
 * candidate ref. `apply` compares the Target against the persisted
 * Target-before identity and updates it to the persisted candidate together
 * with a durable receipt ref in one atomic reference transaction; a replay
 * whose receipt exists returns the receipt's identity even when the Target
 * moved again, and success is never inferred from the Target equalling or
 * containing the candidate. The operator's checked-out working copy of the
 * Target branch is handled afterwards and separately: brought forward
 * non-destructively when git can do so without touching local work, left
 * exactly as it was otherwise, and reported truthfully either way — never
 * reset. `release` removes the staging and the candidate ref alone.
 *
 * The plain-directory kind offers no atomic update-plus-receipt, so its
 * publication is refused with `strategy_unsupported` before the directory is
 * read or touched; the accepted result stays available as the Run's final
 * Changeset and its Integration Workspace.
 */
import fs from "node:fs";
import path from "node:path";
import { publicationStrategySchema, snapshotIdentitySchema, type PublicationCheckout, type PublicationStrategy, type PublicationStrategyRequest, type SnapshotIdentity, type WorkspaceKind } from "@agentique-console/core";
import type { PublicationApplyOutcome, PublicationApplyRequest, PublicationPrepareOutcome, PublicationPrepareRequest, PublicationReleaseOutcome, PublicationReleaseRequest, PublicationWorkspacePort } from "../execution/ports/publication-workspace.ts";
import { supportsPublication, supportsStrategy } from "./capabilities.ts";
import { boundedStderr, git, isObjectId, text } from "./git.ts";
import { exists, publicationDir, removeOwned, WorkspaceStateError, type WorkspaceStateLayout } from "./paths.ts";
import { assertRepositoryRootSync, branchCommit, branchRefOf, candidateRefOf, fastForwardCheckout, publishRefTransaction, receiptCommit } from "./providers/git.ts";
import { commitOfIdentity, diffBetween, identitiesEqual, identityOfCommit } from "./snapshots.ts";
import { addWorktree, removeWorktree } from "./worktrees.ts";

const MARKER_VERSION = 1;

/** The prepared facts, recorded once the candidate exists; the candidate commit lets a lost staging worktree be rebuilt. */
interface PreparedMarker {
  version: typeof MARKER_VERSION;
  publicationId: string;
  targetBeforeSnapshot: SnapshotIdentity;
  candidateSnapshot: SnapshotIdentity;
  strategy: PublicationStrategy;
  candidateCommit: string;
}

/** A merge candidate is a pure function of its parents, tree, and message: fixed dates make a repeated preparation reproduce the same commit id. */
const DETERMINISTIC_COMMIT_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" });

/**
 * Test barriers around the two external boundaries a crash or a race can
 * fall between; production passes none. They exist so that a suite can
 * kill the process after the atomic Target update or commit to the Target
 * between the update and the checkout handling.
 */
export interface PublicationHooks {
  /** After the candidate is constructed in staging and its ref recorded, before the marker is written. */
  beforeMarker?: (publicationId: string) => void | Promise<void>;
  /** After the atomic Target update and receipt, before the checkout handling. */
  afterTargetUpdate?: (publicationId: string) => void | Promise<void>;
}

type StrategySelection = { kind: "selected"; strategy: PublicationStrategy } | Extract<PublicationPrepareOutcome, { kind: "refused" }>;

/** The concrete strategy for a request against a Target at or off the base Snapshot, exactly as §9.4 specifies; a kind without publication refuses every request. */
export function selectStrategy(kind: WorkspaceKind, requested: PublicationStrategyRequest, atBase: boolean): StrategySelection {
  if (!supportsPublication(kind)) {
    const strategy: PublicationStrategy = requested.kind === "exact" ? requested.strategy : { kind: "fast_forward" };
    return { kind: "refused", refusal: "strategy_unsupported", strategy, message: `a ${kind} Workspace has no atomic publication: its Target is never updated by the runtime; apply the Run's final Changeset yourself` };
  }
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

/** Reads a marker: `prepared` with its validated facts, `missing`, or `damaged` (unreadable, malformed, foreign, or a partial write). */
function readMarker(file: string, publicationId: string): { kind: "prepared"; marker: PreparedMarker } | { kind: "missing" } | { kind: "damaged" } {
  if (!exists(file)) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { kind: "damaged" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "damaged" };
  const record = parsed as Record<string, unknown>;
  const before = snapshotIdentitySchema.safeParse(record.targetBeforeSnapshot);
  const candidate = snapshotIdentitySchema.safeParse(record.candidateSnapshot);
  const strategy = publicationStrategySchema.safeParse(record.strategy);
  if (record.version !== MARKER_VERSION || record.publicationId !== publicationId || !before.success || !candidate.success || !strategy.success || typeof record.candidateCommit !== "string" || !isObjectId(record.candidateCommit)) {
    return { kind: "damaged" };
  }
  if (candidate.data.kind !== "git" || candidate.data.commitId !== record.candidateCommit) return { kind: "damaged" };
  return { kind: "prepared", marker: { version: MARKER_VERSION, publicationId, targetBeforeSnapshot: before.data, candidateSnapshot: candidate.data, strategy: strategy.data, candidateCommit: record.candidateCommit } };
}

/** Writes the marker atomically: a complete temporary file renamed into place, so a death mid-write leaves no partial marker. */
function writeMarker(file: string, marker: PreparedMarker): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(marker), { flag: "w" });
  fs.renameSync(temporary, file);
}

export class WorkspacePublication implements PublicationWorkspacePort {
  constructor(
    private readonly layout: WorkspaceStateLayout,
    private readonly hooks: PublicationHooks = {},
  ) {}

  private stagingOf(request: { workspaceId: string; runId: string; publicationId: string }): { dir: string; staging: string; marker: string } {
    const dir = publicationDir(this.layout, request.workspaceId, request.runId, request.publicationId);
    return { dir, staging: path.join(dir, "staging"), marker: path.join(dir, "prepared.json") };
  }

  /** The repository every git operation of a Publication runs in: the Workspace root of a git Workspace. */
  private repositoryOf(request: { workspaceRootPath: string }): string {
    assertRepositoryRootSync(request.workspaceRootPath);
    return request.workspaceRootPath;
  }

  async prepare(request: PublicationPrepareRequest): Promise<PublicationPrepareOutcome> {
    const kind = request.baseSnapshot.kind;
    // A kind without atomic publication is refused here, before the Target is read or touched and before anything is staged.
    if (!supportsPublication(kind) || kind !== "git") {
      const selection = selectStrategy(kind, request.requestedStrategy, false);
      return selection.kind === "refused" ? selection : { kind: "refused", refusal: "strategy_unsupported", strategy: selection.strategy, message: `a ${kind} Workspace has no atomic publication` };
    }
    const { dir, staging, marker } = this.stagingOf(request);
    try {
      const repository = this.repositoryOf(request);
      const recorded = readMarker(marker, request.publicationId);
      if (recorded.kind === "prepared") {
        // The prepared facts are the record; a staging worktree a previous process lost is rebuilt from the candidate ref.
        await this.ensureStaging(repository, staging, recorded.marker.candidateCommit);
        return { kind: "prepared", targetBeforeSnapshot: recorded.marker.targetBeforeSnapshot, candidateSnapshot: recorded.marker.candidateSnapshot, strategy: recorded.marker.strategy, verificationWorkspacePath: staging, alreadyPrepared: true };
      }
      if (recorded.kind === "damaged") {
        // A partial or malformed marker records nothing: its staging is discarded and the candidate is constructed again, deterministically.
        await this.discardStaging(repository, request.publicationId, dir, staging);
      }
      const target = await this.targetCurrent(request, repository);
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
        // A git Target fast-forwards only along history.
        const ancestor = await git(["merge-base", "--is-ancestor", target.commit, afterCommit], { cwd: repository, allowFailure: true });
        if (ancestor.exitCode !== 0) return { kind: "refused", refusal: "candidate_invalid", strategy, message: "the final Snapshot does not descend from the Target" };
        candidateCommit = afterCommit;
        await addWorktree(this.layout, { fromCwd: repository, worktreePath: staging, commit: candidateCommit });
      } else {
        await addWorktree(this.layout, { fromCwd: repository, worktreePath: staging, commit: target.commit });
        const applied = await git(["apply", "--3way", "--index", "--whitespace=nowarn"], { cwd: staging, input: bytes, allowFailure: true, timeoutMs: 300_000 });
        if (applied.exitCode !== 0) {
          await this.discardStaging(repository, request.publicationId, dir, staging);
          return { kind: "refused", refusal: "candidate_conflict", strategy, message: boundedStderr(applied.stderr === "" ? "the final Changeset does not apply cleanly onto the Target" : applied.stderr) };
        }
        const tree = text(await git(["write-tree"], { cwd: staging }));
        candidateCommit = text(await git(["commit-tree", tree, "-p", target.commit, "-p", afterCommit, "-m", `Agentique Console: publish Run ${request.runId}`], { cwd: staging, identity: true, env: { ...DETERMINISTIC_COMMIT_ENV } }));
        await git(["reset", "--hard", "--quiet", candidateCommit], { cwd: staging, identity: true });
      }
      // The candidate stays reachable through its own ref until the staging is released, whatever happens to the worktree.
      await git(["update-ref", candidateRefOf(request.publicationId), candidateCommit], { cwd: repository });
      await this.hooks.beforeMarker?.(request.publicationId);
      const prepared: PreparedMarker = { version: MARKER_VERSION, publicationId: request.publicationId, targetBeforeSnapshot: target.identity, candidateSnapshot: await identityOfCommit(repository, candidateCommit, kind), strategy, candidateCommit };
      writeMarker(marker, prepared);
      return { kind: "prepared", targetBeforeSnapshot: prepared.targetBeforeSnapshot, candidateSnapshot: prepared.candidateSnapshot, strategy: prepared.strategy, verificationWorkspacePath: staging, alreadyPrepared: false };
    } catch (error) {
      if (error instanceof WorkspaceStateError && (error.code === "unknown_snapshot" || error.code === "target_mismatch" || error.code === "not_a_repository")) {
        return { kind: "refused", refusal: "candidate_invalid", strategy: null, message: boundedStderr(error.message, 500) };
      }
      return { kind: "unavailable", message: boundedStderr(error instanceof Error ? error.message : String(error), 500) };
    }
  }

  /** The staging worktree holds the candidate commit; a missing or stale one is recreated from the candidate commit (kept by its ref). */
  private async ensureStaging(repository: string, staging: string, candidateCommit: string): Promise<void> {
    if (exists(staging)) {
      const head = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: staging, allowFailure: true });
      if (head.exitCode === 0 && text(head) === candidateCommit) return;
    }
    await addWorktree(this.layout, { fromCwd: repository, worktreePath: staging, commit: candidateCommit });
  }

  /** Removes the staging worktree, the publication directory, and the candidate ref; a Publication that never staged is unaffected. */
  private async discardStaging(repository: string, publicationId: string, dir: string, staging: string): Promise<void> {
    if (exists(staging)) await removeWorktree(this.layout, repository, staging);
    removeOwned(this.layout, dir);
    await git(["update-ref", "-d", candidateRefOf(publicationId)], { cwd: repository, allowFailure: true });
  }

  /** The Target's current commit and identity; reading it never modifies the Target. */
  private async targetCurrent(request: PublicationPrepareRequest, repository: string): Promise<{ kind: "current"; commit: string; identity: SnapshotIdentity } | { kind: "missing"; message: string }> {
    const commit = await branchCommit(repository, branchRefOf(request.target));
    if (commit === null) return { kind: "missing", message: "the Target branch does not exist" };
    return { kind: "current", commit, identity: await identityOfCommit(repository, commit, "git") };
  }

  async apply(request: PublicationApplyRequest): Promise<PublicationApplyOutcome> {
    if (request.expectedTargetSnapshot.kind !== "git" || request.candidateSnapshot.kind !== "git") {
      // Unreachable through the runtime (no prepared Publication exists for a kind without publication); nothing is touched and nothing is concluded.
      return { kind: "unavailable", message: `a ${request.expectedTargetSnapshot.kind} Workspace has no atomic publication; nothing was applied` };
    }
    try {
      const root = this.repositoryOf(request);
      // The durable receipt decides replays first: even when the Target has since moved again, the recorded identity is returned.
      const receipt = await receiptCommit(root, request.publicationId);
      if (receipt !== null) return { kind: "applied", targetSnapshot: await identityOfCommit(root, receipt, "git"), alreadyApplied: true, checkout: { kind: "unknown" } };
      const ref = branchRefOf(request.target);
      const transaction = await publishRefTransaction(root, ref, request.expectedTargetSnapshot.commitId, request.candidateSnapshot.commitId, request.publicationId);
      if (transaction.kind === "committed") {
        await this.hooks.afterTargetUpdate?.(request.publicationId);
        // The authoritative result is the committed transaction above; the checkout is handled afterwards, non-destructively, and reported as it went.
        let checkout: PublicationCheckout;
        try {
          checkout = await fastForwardCheckout(root, ref, request.expectedTargetSnapshot.commitId, request.candidateSnapshot.commitId);
        } catch {
          checkout = { kind: "unchanged", reason: "operation_failed" };
        }
        return { kind: "applied", targetSnapshot: await identityOfCommit(root, request.candidateSnapshot.commitId, "git"), alreadyApplied: false, checkout };
      }
      const current = await branchCommit(root, ref);
      if (current !== null && current !== request.expectedTargetSnapshot.commitId) return { kind: "target_changed", currentTargetSnapshot: await identityOfCommit(root, current, "git") };
      return { kind: "unavailable", message: boundedStderr(transaction.message === "" ? "the reference transaction was rejected" : transaction.message, 500) };
    } catch (error) {
      return { kind: "unavailable", message: boundedStderr(error instanceof Error ? error.message : String(error), 500) };
    }
  }

  async release(request: PublicationReleaseRequest): Promise<PublicationReleaseOutcome> {
    const { dir, staging } = this.stagingOf(request);
    try {
      if (request.target.kind === "branch" && exists(request.workspaceRootPath)) {
        await this.discardStaging(request.workspaceRootPath, request.publicationId, dir, staging);
      } else {
        removeOwned(this.layout, dir);
      }
      return { kind: "released" };
    } catch (error) {
      return { kind: "failed", message: boundedStderr(error instanceof Error ? error.message : String(error), 500) };
    }
  }
}
