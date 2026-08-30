/**
 * The Run finalization Workspace port: the final boundary between signoff
 * acceptance and the Workspace provider that observes the Run's Integration
 * Workspace (execution-model §9.3, §10 `operator_signoff`).
 *
 * Ownership rule: the execution runtime decides what is verified and
 * records every outcome canonically; the port observes and computes, and
 * nothing else. It receives exactly the facts in the request — the Run and
 * Workspace identity, the Integration Workspace, the base Snapshot, and the
 * verified Snapshot — and never a store, a database handle, a Blob Store,
 * an Artifact lookup, a provider transcript, or any authority over the
 * operator's branch. An implementation imports no persistence module.
 *
 * Contract for implementations:
 *
 * - `inspect` is read-only. It never modifies the Integration Workspace,
 *   never writes the operator's branch, never commits, never combines
 *   histories, never switches what the Integration Workspace holds, and
 *   creates no provider-side marker that correctness would depend on.
 * - It reports the Snapshot the Integration Workspace currently holds
 *   (`currentSnapshot`), so the runtime can confirm it is still exactly the
 *   verified Snapshot, and whether the working state is clean; any other
 *   observation is drift, never acceptance.
 * - `diff` is the exact, untruncated difference from `baseSnapshot` to
 *   `verifiedSnapshot`; a zero-byte diff is valid (nothing changed). The
 *   bytes live only in the Artifact Store once the runtime persists them.
 * - The signoff service calls `inspect` outside every database transaction
 *   and refuses to call it from inside one; a failure is a closed
 *   infrastructure outcome (`failed`), never an acceptance and never a
 *   change request.
 *
 * The provider implementation arrives in the Workspace phase; tests use a
 * deterministic fake.
 */
import type { RunId, SnapshotIdentity, WorkspaceId } from "@agentique-console/core";

export interface RunFinalizationRequest {
  runId: RunId;
  workspaceId: WorkspaceId;
  /** The Run's Integration Workspace; `null` for a Run without one. */
  integrationWorkspacePath: string | null;
  /** The Run's base Snapshot: where the final diff starts. */
  baseSnapshot: SnapshotIdentity;
  /** The Snapshot the signoff Gate verified: what the Integration Workspace must still hold exactly, and where the final diff ends. */
  verifiedSnapshot: SnapshotIdentity;
}

export const RUN_FINALIZATION_FAILURES = ["workspace_unavailable", "snapshot_unreadable", "diff_unavailable"] as const;
export type RunFinalizationFailure = (typeof RUN_FINALIZATION_FAILURES)[number];

export type RunFinalizationOutcome =
  /** The Integration Workspace was observed: the Snapshot it holds now, the exact base-to-verified diff, and the safe facts identity is validated with. */
  | { kind: "inspected"; currentSnapshot: SnapshotIdentity; diff: Uint8Array; workspace: { clean: boolean } }
  /** The Integration Workspace could not be observed: an infrastructure failure with a bounded message; nothing is inferred from it. */
  | { kind: "failed"; failure: RunFinalizationFailure; message: string };

export interface RunFinalizationWorkspacePort {
  inspect(request: RunFinalizationRequest): Promise<RunFinalizationOutcome>;
}
