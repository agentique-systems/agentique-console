/**
 * Snapshot identities over a repository (execution-model §9; glossary
 * "Snapshot"): a git Workspace identifies a state by commit id and tree id;
 * a plain-directory Workspace by a content digest of its tracked files. The
 * directory kind keeps its files in a console-owned shadow repository, so
 * its digest is computed from the canonical tree listing of a commit and the
 * commit is findable again through a provider-owned ref keyed by the digest
 * (`refs/agentique/snapshots/<digest>`): storage housekeeping, never a
 * second ledger. Nothing here reads or writes persistence.
 */
import { createHash } from "node:crypto";
import type { SnapshotIdentity, WorkspaceKind } from "@agentique-console/core";
import { git, gitSync, isObjectId, text, type GitOptions } from "./git.ts";
import { WorkspaceStateError } from "./paths.ts";

export const SNAPSHOT_REF_PREFIX = "refs/agentique/snapshots/";

export function identitiesEqual(a: SnapshotIdentity, b: SnapshotIdentity): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "git" && b.kind === "git") return a.commitId === b.commitId && a.treeId === b.treeId;
  if (a.kind === "directory" && b.kind === "directory") return a.contentDigest === b.contentDigest;
  return false;
}

/** The canonical content digest of a tree: SHA-256 over its recursive listing (mode, type, object id, path per entry). */
function digestOfListing(listing: string): string {
  return createHash("sha256").update(listing).digest("hex");
}

function assertObjectId(value: string, what: string): string {
  if (!isObjectId(value)) throw new WorkspaceStateError("unknown_snapshot", `${what} did not resolve to an object id`);
  return value;
}

/** Synchronous identity of a commit (preparation runs inside a transaction). */
export function identityOfCommitSync(cwd: string, commit: string, kind: WorkspaceKind, options: { record?: boolean } = {}): SnapshotIdentity {
  const commitId = assertObjectId(text(gitSync(["rev-parse", "--verify", `${commit}^{commit}`], { cwd })), "commit");
  const treeId = assertObjectId(text(gitSync(["rev-parse", "--verify", `${commit}^{tree}`], { cwd })), "tree");
  if (kind === "git") return { kind: "git", commitId, treeId };
  const contentDigest = digestOfListing(gitSync(["ls-tree", "-r", "--full-tree", treeId], { cwd }).stdout.toString("utf8"));
  if (options.record !== false) gitSync(["update-ref", `${SNAPSHOT_REF_PREFIX}${contentDigest}`, commitId], { cwd });
  return { kind: "directory", contentDigest };
}

export async function identityOfCommit(cwd: string, commit: string, kind: WorkspaceKind, options: { record?: boolean } = {}): Promise<SnapshotIdentity> {
  const commitId = assertObjectId(text(await git(["rev-parse", "--verify", `${commit}^{commit}`], { cwd })), "commit");
  const treeId = assertObjectId(text(await git(["rev-parse", "--verify", `${commit}^{tree}`], { cwd })), "tree");
  if (kind === "git") return { kind: "git", commitId, treeId };
  const contentDigest = digestOfListing((await git(["ls-tree", "-r", "--full-tree", treeId], { cwd })).stdout.toString("utf8"));
  if (options.record !== false) await git(["update-ref", `${SNAPSHOT_REF_PREFIX}${contentDigest}`, commitId], { cwd });
  return { kind: "directory", contentDigest };
}

/** The commit an identity names, or a typed error when the repository does not hold it. */
export function commitOfIdentitySync(cwd: string, identity: SnapshotIdentity): string {
  const ref = identity.kind === "git" ? identity.commitId : `${SNAPSHOT_REF_PREFIX}${identity.contentDigest}`;
  const result = gitSync(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd, allowFailure: true });
  if (result.exitCode !== 0) throw new WorkspaceStateError("unknown_snapshot", `the repository holds no commit for Snapshot ${identity.kind === "git" ? identity.commitId : identity.contentDigest}`);
  return assertObjectId(text(result), "Snapshot");
}

export async function commitOfIdentity(cwd: string, identity: SnapshotIdentity): Promise<string> {
  const ref = identity.kind === "git" ? identity.commitId : `${SNAPSHOT_REF_PREFIX}${identity.contentDigest}`;
  const result = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd, allowFailure: true });
  if (result.exitCode !== 0) throw new WorkspaceStateError("unknown_snapshot", `the repository holds no commit for Snapshot ${identity.kind === "git" ? identity.commitId : identity.contentDigest}`);
  return assertObjectId(text(result), "Snapshot");
}

/** The exact binary patch between two commits, as bytes; empty when the trees are equal. */
export async function diffBetween(cwd: string, fromCommit: string, toCommit: string, options: Pick<GitOptions, "timeoutMs"> = {}): Promise<Uint8Array> {
  const result = await git(["diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-renames", fromCommit, toCommit], { cwd, ...options });
  return new Uint8Array(result.stdout);
}

/** True when the working tree and index of `cwd` hold nothing beyond HEAD (untracked files included). */
export async function isClean(cwd: string): Promise<boolean> {
  return text(await git(["status", "--porcelain", "--untracked-files=all"], { cwd })) === "";
}

export function isCleanSync(cwd: string): boolean {
  return text(gitSync(["status", "--porcelain", "--untracked-files=all"], { cwd })) === "";
}
