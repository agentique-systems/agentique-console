/**
 * The execution Workspace port (execution-model §9.1; ports/
 * execution-workspace.ts): one detached worktree per writing Invocation,
 * created from the Run's current integration Snapshot under the Run's state
 * directory and kept across the Invocation's Attempts (a retry reattaches by
 * Invocation id; nothing here is called between Attempts); a read-only
 * Invocation runs against the Integration Workspace itself. The Changeset is
 * collected by committing the worktree's whole state and taking the exact
 * binary diff from the starting commit; an unchanged worktree is an empty
 * Changeset. Release removes exactly the Invocation's worktree, idempotently.
 */
import type { CollectedChangeset, ExecutionWorkspacePort, ExecutionWorkspaceRequest, PreparedExecutionWorkspace } from "../execution/ports/execution-workspace.ts";
import { git, text } from "./git.ts";
import { exists, runDirOfIntegration, WorkspaceStateError, worktreeDir, type WorkspaceStateLayout } from "./paths.ts";
import { commitOfIdentity, commitOfIdentitySync, diffBetween, identityOfCommit, identityOfCommitSync } from "./snapshots.ts";
import { addWorktreeSync, removeWorktree, removeWorktreeSync } from "./worktrees.ts";

export class WorkspaceExecution implements ExecutionWorkspacePort {
  constructor(private readonly layout: WorkspaceStateLayout) {}

  prepare(request: ExecutionWorkspaceRequest): PreparedExecutionWorkspace {
    if (request.integrationWorkspacePath === null) throw new WorkspaceStateError("workspace_missing", "the Run has no Integration Workspace");
    if (!request.writes) return { worktreePath: request.integrationWorkspacePath, startingSnapshot: null };
    if (request.integrationSnapshot === null) throw new WorkspaceStateError("unknown_snapshot", "a writing Invocation needs the Run's current integration Snapshot");
    const integration = request.integrationWorkspacePath;
    const worktreePath = worktreeDir(runDirOfIntegration(this.layout, integration), request.invocationId);
    const commit = commitOfIdentitySync(integration, request.integrationSnapshot);
    addWorktreeSync(this.layout, { fromCwd: integration, worktreePath, commit });
    return { worktreePath, startingSnapshot: identityOfCommitSync(integration, commit, request.integrationSnapshot.kind) };
  }

  discard(request: ExecutionWorkspaceRequest, prepared: PreparedExecutionWorkspace): void {
    if (!request.writes || prepared.worktreePath === null || request.integrationWorkspacePath === null) return;
    removeWorktreeSync(this.layout, request.integrationWorkspacePath, prepared.worktreePath);
  }

  async collectChangeset(request: ExecutionWorkspaceRequest, prepared: PreparedExecutionWorkspace): Promise<CollectedChangeset | null> {
    if (!request.writes || prepared.worktreePath === null || prepared.startingSnapshot === null || request.integrationWorkspacePath === null) return null;
    const worktree = prepared.worktreePath;
    if (!exists(worktree)) return null;
    const kind = prepared.startingSnapshot.kind;
    const startingCommit = await commitOfIdentity(worktree, prepared.startingSnapshot);
    // The whole state of the worktree, untracked files included, becomes the Invocation's commit; nothing is excluded by the runtime.
    await git(["add", "-A", "--", "."], { cwd: worktree });
    const staged = await git(["diff", "--cached", "--quiet"], { cwd: worktree, allowFailure: true });
    if (staged.exitCode === 0) return { afterSnapshot: prepared.startingSnapshot, diff: new Uint8Array(), empty: true };
    await git(["commit", "--quiet", "--no-verify", "-m", `Agentique Console: Invocation ${request.invocationId}`], { cwd: worktree, identity: true });
    const afterCommit = text(await git(["rev-parse", "HEAD"], { cwd: worktree }));
    const afterSnapshot = await identityOfCommit(worktree, afterCommit, kind);
    return { afterSnapshot, diff: await diffBetween(worktree, startingCommit, afterCommit), empty: false };
  }

  release(request: ExecutionWorkspaceRequest, prepared: PreparedExecutionWorkspace): void {
    if (!request.writes || prepared.worktreePath === null || request.integrationWorkspacePath === null) return;
    removeWorktreeSync(this.layout, request.integrationWorkspacePath, prepared.worktreePath);
  }

  /** The asynchronous release, for callers outside a transaction that prefer not to block. */
  async releaseAsync(request: ExecutionWorkspaceRequest, prepared: PreparedExecutionWorkspace): Promise<void> {
    if (!request.writes || prepared.worktreePath === null || request.integrationWorkspacePath === null) return;
    await removeWorktree(this.layout, request.integrationWorkspacePath, prepared.worktreePath);
  }
}
