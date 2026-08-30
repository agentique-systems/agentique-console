/**
 * The integration-workspace port: the final boundary between Changeset
 * integration and the Workspace provider that applies a writing
 * Invocation's Changeset to the Run's Integration Workspace (execution-model
 * §9.2). The integration service calls `apply` outside any database
 * transaction and records the outcome afterwards, so the port must be
 * idempotent by Changeset id: a Changeset applied by a process that died
 * before recording it is reported `integrated` again, never applied twice.
 * The port never touches the operator's Target; it receives only the Run's
 * Integration Workspace. The provider implementation arrives in the
 * Workspace phase; tests use a deterministic fake.
 */
import type { ArtifactId, ChangesetId, RunId, SnapshotIdentity } from "@agentique-console/core";

export interface IntegrationApplyRequest {
  runId: RunId;
  changesetId: ChangesetId;
  integrationWorkspacePath: string | null;
  /** The Run's current integration Snapshot (its base Snapshot before any integration), which the Changeset is applied onto. */
  currentSnapshot: SnapshotIdentity;
  changeset: {
    beforeSnapshot: SnapshotIdentity;
    afterSnapshot: SnapshotIdentity;
    /** The diff Artifact; the provider reads its bytes through the persistence boundary, never the runtime. */
    diffArtifactId: ArtifactId;
    diffDigest: string;
    diffByteSize: number;
    /** An explicitly empty Changeset integrates trivially. */
    empty: boolean;
  };
}

export type IntegrationApplyOutcome =
  /** Applied cleanly (or found already applied by an earlier attempt); `snapshot` identifies the Integration Workspace afterwards. */
  | { kind: "integrated"; snapshot: SnapshotIdentity; alreadyApplied: boolean }
  /** Could not be applied cleanly; nothing was applied; `report` is a bounded, non-sensitive description for the conflict Artifact. */
  | { kind: "conflict"; report: string };

export interface IntegrationWorkspacePort {
  apply(request: IntegrationApplyRequest): Promise<IntegrationApplyOutcome>;
}
