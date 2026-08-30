/**
 * The integration-workspace port: the final boundary between Changeset
 * integration and the Workspace provider that applies a writing
 * Invocation's Changeset to the Run's Integration Workspace (execution-model
 * §9.2).
 *
 * Ownership rule: the execution runtime resolves and verifies Changeset
 * content. The Integration Workspace receives a capability bound to that
 * exact immutable content and has no persistence access. An implementation
 * of this port imports no store, blob store, database, transaction, or
 * storage key; everything it needs to apply the Changeset is in the
 * request.
 *
 * Contract for implementations:
 *
 * - `changeset.diff` is authoritative: the adapter applies exactly the
 *   bytes it reads from it, nothing recomputed from Snapshots or metadata.
 * - The integration service calls `apply` outside any database transaction
 *   and records the outcome afterwards, so a process that dies in between
 *   calls `apply` again for the same Changeset. Adapters therefore make
 *   `apply` idempotent by Changeset id: `alreadyApplied: true` means the
 *   external Integration Workspace had already accepted that exact
 *   Changeset, and `snapshot` identifies the Workspace as it stands.
 * - Adapters keep whatever they need for that idempotence in the
 *   Integration Workspace itself (for example its history); they never
 *   persist integration state in Agentique's database.
 * - The port never touches the operator's Target; it receives only the
 *   Run's Integration Workspace.
 *
 * The provider implementation arrives in the Workspace phase; tests use a
 * deterministic fake.
 */
import type { ArtifactId, ChangesetId, RunId, SnapshotIdentity } from "@agentique-console/core";

/**
 * Provider-neutral access to the verified content of exactly one immutable
 * Artifact. The runtime constructs it after resolving the Artifact through
 * the canonical Artifact Store and verifying its digest and byte size; the
 * holder can neither look up another Artifact nor enumerate any. Every
 * `read` either returns bytes that match `digest` and `byteSize` — verified
 * again on that read — or fails; it may be called again, for example while
 * reconciling after a crash, and returns the same content. The returned
 * bytes are the holder's to read, never to change.
 */
export interface ArtifactContentSource {
  readonly artifactId: ArtifactId;
  readonly mediaType: string;
  /** SHA-256 hex digest of the content. */
  readonly digest: string;
  readonly byteSize: number;
  read(): Promise<Uint8Array>;
}

export interface IntegrationApplyRequest {
  runId: RunId;
  changesetId: ChangesetId;
  integrationWorkspacePath: string | null;
  /** The Run's current integration Snapshot (its base Snapshot before any integration), which the Changeset is applied onto. */
  currentSnapshot: SnapshotIdentity;
  changeset: {
    beforeSnapshot: SnapshotIdentity;
    afterSnapshot: SnapshotIdentity;
    /** The Changeset's diff, verified by the runtime; a zero-byte diff is a valid, empty Changeset. */
    diff: ArtifactContentSource;
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
