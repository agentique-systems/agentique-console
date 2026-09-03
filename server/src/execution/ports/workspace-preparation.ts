/**
 * The Workspace preparation port: the final boundary between Run creation
 * and the Workspace provider that implements Snapshots and the Integration
 * Workspace for a Workspace kind (execution-model §9.1). Run creation calls
 * it inside its root transaction; the provider implementation arrives in
 * the Workspace phase and depends on nothing here. This is a capability
 * boundary, not an adapter: nothing behind it may call legacy worktree code.
 */
import type { RunId, RunTarget, SnapshotIdentity, Workspace } from "@agentique-console/core";

export interface RunWorkspacePreparationRequest {
  runId: RunId;
  workspace: Workspace;
  target: RunTarget;
}

/** What preparing a Run's Workspace yields: the base Snapshot of the Target and the Integration Workspace. */
export interface PreparedRunWorkspace {
  baseSnapshot: SnapshotIdentity;
  integrationWorkspacePath: string;
}

export interface RunWorkspacePreparationPort {
  /**
   * Takes the base Snapshot of the Target and creates the Run's Integration
   * Workspace from it. Synchronous, because it runs inside the persistence
   * transactor's root transaction; a failure aborts Run creation and must
   * leave nothing behind.
   */
  prepare(request: RunWorkspacePreparationRequest): PreparedRunWorkspace;

  /**
   * Compensation: removes what `prepare` created. Called exactly once, only
   * when Run creation rolls back after a successful `prepare`, after the
   * database has rolled back. Must be safe to call for a partially removed
   * Workspace.
   */
  discard(request: RunWorkspacePreparationRequest, prepared: PreparedRunWorkspace): void;
}
