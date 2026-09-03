/**
 * The git Workspace kind (glossary "Workspace provider"): the Workspace is a
 * repository root, the Target is one of its branches, and every runtime copy
 * is a worktree of that repository under the state root. The operator's own
 * checkout is never modified by a Run; a Publication moves the Target ref in
 * one reference transaction together with its receipt ref, then brings a
 * checked-out working copy of that branch forward non-destructively or
 * leaves it exactly as it was — it is never reset.
 */
import fs from "node:fs";
import path from "node:path";
import type { PublicationCheckout, RunTarget, SnapshotIdentity } from "@agentique-console/core";
import { git, gitSync, isObjectId, text } from "../git.ts";
import { WorkspaceStateError } from "../paths.ts";
import { identityOfCommit } from "../snapshots.ts";

export const RUN_BRANCH_PREFIX = "agentique/run/";
export const PUBLICATION_RECEIPT_REF_PREFIX = "refs/agentique/publications/";
/** A prepared candidate stays reachable through this ref until the Publication's staging is released. */
export const PUBLICATION_CANDIDATE_REF_PREFIX = "refs/agentique/candidates/";
export const INTEGRATION_REF_PREFIX = "refs/agentique/integrations/";

function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** The Workspace root must be a repository's own top level, not a directory inside some other repository. */
export function assertRepositoryRootSync(root: string): void {
  if (!fs.existsSync(root)) throw new WorkspaceStateError("workspace_missing", "the Workspace root does not exist");
  const inside = gitSync(["rev-parse", "--is-inside-work-tree"], { cwd: root, allowFailure: true });
  if (inside.exitCode !== 0 || text(inside) !== "true") throw new WorkspaceStateError("not_a_repository", "the Workspace root is not inside a git working tree");
  const toplevel = text(gitSync(["rev-parse", "--show-toplevel"], { cwd: root }));
  if (!samePath(toplevel, root)) throw new WorkspaceStateError("not_a_repository", "the Workspace root is inside another repository, not a repository root");
}

export function branchRefOf(target: RunTarget): string {
  if (target.kind !== "branch") throw new WorkspaceStateError("target_mismatch", "a git Workspace publishes to a branch Target");
  if (target.branch.startsWith("refs/") || target.branch.includes("..") || /[\s~^:?*[\\]/.test(target.branch) || target.branch.startsWith(RUN_BRANCH_PREFIX) || target.branch.startsWith("agentique/")) {
    throw new WorkspaceStateError("target_mismatch", "the Target branch name is not a plain branch the runtime may publish to");
  }
  return `refs/heads/${target.branch}`;
}

/** The commit a branch points at, or `null` when the branch does not exist. */
export function branchCommitSync(root: string, ref: string): string | null {
  const result = gitSync(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd: root, allowFailure: true });
  if (result.exitCode !== 0) return null;
  const commit = text(result);
  return isObjectId(commit) ? commit : null;
}

export async function branchCommit(root: string, ref: string): Promise<string | null> {
  const result = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd: root, allowFailure: true });
  if (result.exitCode !== 0) return null;
  const commit = text(result);
  return isObjectId(commit) ? commit : null;
}

export function runBranchOf(runId: string): string {
  return `${RUN_BRANCH_PREFIX}${runId}`;
}

/** The receipt ref of a Publication (its commit is the resulting Target identity), or `null` when none was written. */
export async function receiptCommit(root: string, publicationId: string): Promise<string | null> {
  return branchCommit(root, `${PUBLICATION_RECEIPT_REF_PREFIX}${publicationId}`);
}

export type RefTransactionOutcome = { kind: "committed" } | { kind: "rejected"; message: string };

/**
 * One atomic reference transaction: the Target ref moves from `expected` to
 * `candidate` and the receipt ref is created, both or neither. A Target that
 * no longer holds `expected` rejects the whole transaction; nothing is ever
 * force-updated.
 */
export async function publishRefTransaction(root: string, targetRef: string, expected: string, candidate: string, publicationId: string): Promise<RefTransactionOutcome> {
  const script = ["start", `update ${targetRef} ${candidate} ${expected}`, `create ${PUBLICATION_RECEIPT_REF_PREFIX}${publicationId} ${candidate}`, "prepare", "commit", ""].join("\n");
  const result = await git(["update-ref", "--stdin"], { cwd: root, input: new TextEncoder().encode(script), allowFailure: true });
  if (result.exitCode === 0) return { kind: "committed" };
  return { kind: "rejected", message: result.stderr.trim() };
}

export function candidateRefOf(publicationId: string): string {
  return `${PUBLICATION_CANDIDATE_REF_PREFIX}${publicationId}`;
}

/** The messages git prints when a two-tree fast-forward would overwrite local work: the update was refused as a whole. */
const LOCAL_CHANGES = /not uptodate|would be overwritten|would be lost|Untracked working tree|Your local changes|needs merge/i;

/**
 * Brings the operator's checked-out working copy of the Target branch
 * forward after the ref transaction moved the branch from `before` to
 * `candidate`, without ever discarding anything: a two-tree fast-forward of
 * the index and the working tree (`git read-tree -m -u`) that touches only
 * the paths that differ between the two trees and that git refuses as a
 * whole when such a path carries local changes or an untracked file would
 * be overwritten. A checkout of another branch, and a branch whose head has
 * moved again since the transaction, are left exactly as they are. The
 * returned fact is what happened, never a claim; it is distinct from the
 * authoritative Target update, which the reference transaction already made.
 */
export async function fastForwardCheckout(root: string, targetRef: string, before: string, candidate: string): Promise<PublicationCheckout> {
  const head = await git(["symbolic-ref", "-q", "HEAD"], { cwd: root, allowFailure: true });
  if (head.exitCode !== 0 || text(head) !== targetRef) return { kind: "not_checked_out" };
  const resolved = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: root, allowFailure: true });
  if (resolved.exitCode !== 0 || text(resolved) !== candidate) return { kind: "unchanged", reason: "head_moved" };
  const updated = await git(["read-tree", "-m", "-u", before, candidate], { cwd: root, allowFailure: true });
  if (updated.exitCode !== 0) return { kind: "unchanged", reason: LOCAL_CHANGES.test(updated.stderr) ? "local_changes" : "operation_failed" };
  return { kind: "synchronized" };
}

export function identityOf(root: string, commit: string): Promise<SnapshotIdentity> {
  return identityOfCommit(root, commit, "git");
}
