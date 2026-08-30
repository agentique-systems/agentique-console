/**
 * The execution-workspace port: the final boundary between Invocation
 * execution and the Workspace provider that implements per-Invocation
 * worktrees, Snapshots, and Changesets (execution-model §9.1, §9.2). The
 * preparation service calls `prepare` inside its root transaction and
 * registers `discard` as compensation; the Attempt executor calls
 * `collectChangeset` after the provider returns, outside any transaction,
 * and `release` once the Invocation is terminal. The provider
 * implementation arrives in the Workspace phase; nothing behind this port
 * may call legacy worktree code, and tests use a deterministic fake.
 */
import type { InvocationId, InvocationRole, RunId, SnapshotIdentity } from "@agentique-console/core";

export interface ExecutionWorkspaceRequest {
  runId: RunId;
  invocationId: InvocationId;
  role: InvocationRole;
  /** True when the effective capability policy grants a write-capable tool: the Invocation needs an isolated worktree and produces a Changeset. */
  writes: boolean;
  integrationWorkspacePath: string | null;
}

export interface PreparedExecutionWorkspace {
  /** The directory the Attempt runs in: an isolated worktree for a writing Invocation, the Integration Workspace otherwise. */
  worktreePath: string | null;
  /** The Snapshot a writing Invocation starts from (taken `before_invocation`); `null` for a read-only Invocation, which starts from the Run's current integration Snapshot. */
  startingSnapshot: SnapshotIdentity | null;
}

/** What a writing Invocation produced, stated explicitly even when nothing changed. */
export interface CollectedChangeset {
  afterSnapshot: SnapshotIdentity;
  /** The diff bytes stored as the Changeset's diff Artifact; empty for an empty Changeset. */
  diff: Uint8Array;
  empty: boolean;
}

export interface ExecutionWorkspacePort {
  /** Synchronous, because it runs inside the preparation transaction; a failure aborts preparation and must leave nothing behind. */
  prepare(request: ExecutionWorkspaceRequest): PreparedExecutionWorkspace;
  /** Compensation: removes what `prepare` created. Called once, only when preparation rolls back after a successful `prepare`. */
  discard(request: ExecutionWorkspaceRequest, prepared: PreparedExecutionWorkspace): void;
  /**
   * The Changeset a writing Invocation's worktree holds after its provider
   * execution ended, or `null` when the port cannot produce one (which the
   * result validator reports as `changeset_missing`). Called outside any
   * transaction.
   */
  collectChangeset(request: ExecutionWorkspaceRequest, prepared: PreparedExecutionWorkspace): Promise<CollectedChangeset | null>;
  /** Releases the Invocation's worktree once the Invocation is terminal; a retry reattaches by Invocation id, so this is never called between Attempts. */
  release(request: ExecutionWorkspaceRequest, prepared: PreparedExecutionWorkspace): void;
}
