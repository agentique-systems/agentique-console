import { z } from "zod";
import type {
  ArtifactId,
  ChangesetId,
  InvocationId,
  RunId,
  SnapshotId,
  TaskId,
  WorkspaceId,
} from "./ids.ts";
import { defineStateMachine } from "./transitions.ts";
import { idSchema, nonEmptyString, sha256Hex, timestampSchema, type Timestamp } from "./validation.ts";

/**
 * Why a Snapshot was taken. `publish_before` identifies the Target as a
 * Publication found it; `publish_candidate` identifies the prospective
 * post-publication state a Publication prepared without touching the Target
 * — on success the Target-after reference points at the same candidate row,
 * so no third Snapshot renames its purpose.
 */
export const SNAPSHOT_REASONS = [
  "run_start",
  "before_invocation",
  "after_invocation",
  "integration",
  "run_completion",
  "publish_before",
  "publish_candidate",
  "agent_definition_read",
] as const;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];

/** Git: commit plus tree id; directory: content digest of the tracked files. */
export type SnapshotIdentity =
  | { kind: "git"; commitId: string; treeId: string }
  | { kind: "directory"; contentDigest: string };

const gitObjectId = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "expected a git object id");

export const snapshotIdentitySchema: z.ZodType<SnapshotIdentity> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("git"), commitId: gitObjectId, treeId: gitObjectId }),
  z.strictObject({ kind: z.literal("directory"), contentDigest: sha256Hex }),
]);

export interface Snapshot {
  id: SnapshotId;
  workspaceId: WorkspaceId;
  runId: RunId | null;
  identity: SnapshotIdentity;
  reason: SnapshotReason;
  takenAt: Timestamp;
}

export const snapshotSchema: z.ZodType<Snapshot> = z.strictObject({
  id: idSchema("snapshot"),
  workspaceId: idSchema("workspace"),
  runId: idSchema("run").nullable(),
  identity: snapshotIdentitySchema,
  reason: z.enum(SNAPSHOT_REASONS),
  takenAt: timestampSchema,
});

export interface SnapshotInput {
  workspaceId: WorkspaceId;
  runId: RunId | null;
  identity: SnapshotIdentity;
  reason: SnapshotReason;
}

export const snapshotInputSchema: z.ZodType<SnapshotInput> = z.strictObject({
  workspaceId: idSchema("workspace"),
  runId: idSchema("run").nullable(),
  identity: snapshotIdentitySchema,
  reason: z.enum(SNAPSHOT_REASONS),
});

/**
 * Which Changeset a row is (execution-model §9.2, §9.3). An `invocation`
 * Changeset is what one writing Invocation produced in its isolated worktree
 * and is applied into the Run's Integration Workspace through the
 * integration lifecycle; the Run's one `final` Changeset is the descriptive
 * record of the complete base-to-final difference the operator accepted at
 * the `operator_signoff` Gate — it is never applied, retried, or resolved,
 * because the Integration Workspace already holds that state.
 */
export const CHANGESET_KINDS = ["invocation", "final"] as const;
export type ChangesetKind = (typeof CHANGESET_KINDS)[number];

/**
 * `pending`, `integrated`, and `conflict` are the integration lifecycle of
 * an `invocation` Changeset; `recorded` is the one terminal state of a
 * `final` Changeset, which exists in it from creation and never leaves it.
 */
export const CHANGESET_INTEGRATION_STATUSES = ["pending", "integrated", "conflict", "recorded"] as const;
export type ChangesetIntegrationStatus = (typeof CHANGESET_INTEGRATION_STATUSES)[number];

/** The statuses an `invocation` Changeset may hold. */
export const INVOCATION_CHANGESET_STATUSES = ["pending", "integrated", "conflict"] as const satisfies readonly ChangesetIntegrationStatus[];

export const CHANGESET_MACHINE = defineStateMachine<ChangesetIntegrationStatus>(
  "Changeset",
  CHANGESET_INTEGRATION_STATUSES,
  {
    pending: ["integrated", "conflict"],
    integrated: [],
    conflict: ["integrated"],
    recorded: [],
  },
);

/** The media type of every Changeset diff Artifact (execution-model §9.2). */
export const CHANGESET_DIFF_MEDIA_TYPE = "text/x-diff";

/** The difference between two Snapshots, stored as a diff Artifact. */
export interface Changeset {
  id: ChangesetId;
  runId: RunId;
  kind: ChangesetKind;
  /** The writing Invocation of an `invocation` Changeset; `null` for the Run's `final` Changeset. */
  invocationId: InvocationId | null;
  beforeSnapshotId: SnapshotId;
  afterSnapshotId: SnapshotId;
  diffArtifactId: ArtifactId;
  integrationStatus: ChangesetIntegrationStatus;
  integratedSnapshotId: SnapshotId | null;
  conflictTaskId: TaskId | null;
  createdAt: Timestamp;
  integratedAt: Timestamp | null;
}

type ChangesetShape = Pick<Changeset, "kind" | "invocationId" | "integrationStatus" | "integratedSnapshotId" | "conflictTaskId" | "integratedAt">;

/**
 * An `invocation` Changeset names its writing Invocation and lives in the
 * integration lifecycle; a `final` Changeset names no Invocation, is
 * `recorded` from creation, and carries no integration or conflict fact.
 */
function changesetShape(changeset: ChangesetShape, ctx: z.RefinementCtx): void {
  if (changeset.kind === "invocation") {
    if (changeset.invocationId === null) ctx.addIssue({ code: "custom", path: ["invocationId"], message: "an invocation Changeset names the writing Invocation that produced it" });
    if (changeset.integrationStatus === "recorded") ctx.addIssue({ code: "custom", path: ["integrationStatus"], message: "an invocation Changeset is pending, integrated, or in conflict; recorded is the final Changeset's state" });
  } else {
    if (changeset.invocationId !== null) ctx.addIssue({ code: "custom", path: ["invocationId"], message: "the final Changeset is produced by no Invocation" });
    if (changeset.integrationStatus !== "recorded") ctx.addIssue({ code: "custom", path: ["integrationStatus"], message: "the final Changeset is recorded, never pending, integrated, or in conflict" });
  }
  if ((changeset.integrationStatus === "integrated") !== (changeset.integratedSnapshotId !== null && changeset.integratedAt !== null)) {
    ctx.addIssue({ code: "custom", path: ["integratedSnapshotId"], message: "integration fields are set exactly when the Changeset is integrated" });
  }
  if ((changeset.integrationStatus === "conflict") !== (changeset.conflictTaskId !== null)) {
    ctx.addIssue({ code: "custom", path: ["conflictTaskId"], message: "conflictTaskId is set exactly when the Changeset conflicts" });
  }
}

export const changesetSchema: z.ZodType<Changeset> = z
  .strictObject({
    id: idSchema("changeset"),
    runId: idSchema("run"),
    kind: z.enum(CHANGESET_KINDS),
    invocationId: idSchema("invocation").nullable(),
    beforeSnapshotId: idSchema("snapshot"),
    afterSnapshotId: idSchema("snapshot"),
    diffArtifactId: idSchema("artifact"),
    integrationStatus: z.enum(CHANGESET_INTEGRATION_STATUSES),
    integratedSnapshotId: idSchema("snapshot").nullable(),
    conflictTaskId: idSchema("task").nullable(),
    createdAt: timestampSchema,
    integratedAt: timestampSchema.nullable(),
  })
  .superRefine(changesetShape);

/** What records an `invocation` Changeset: the writing Invocation's before and after Snapshots and its diff Artifact. */
export interface ChangesetInput {
  runId: RunId;
  invocationId: InvocationId;
  beforeSnapshotId: SnapshotId;
  afterSnapshotId: SnapshotId;
  diffArtifactId: ArtifactId;
}

export const changesetInputSchema: z.ZodType<ChangesetInput> = z.strictObject({
  runId: idSchema("run"),
  invocationId: idSchema("invocation"),
  beforeSnapshotId: idSchema("snapshot"),
  afterSnapshotId: idSchema("snapshot"),
  diffArtifactId: idSchema("artifact"),
});

/**
 * What records the Run's `final` Changeset at signoff acceptance
 * (execution-model §9.3): the Run's base Snapshot, the accepted final
 * Snapshot, and the exact base-to-final diff Artifact.
 */
export interface FinalChangesetInput {
  runId: RunId;
  beforeSnapshotId: SnapshotId;
  afterSnapshotId: SnapshotId;
  diffArtifactId: ArtifactId;
}

export const finalChangesetInputSchema: z.ZodType<FinalChangesetInput> = z.strictObject({
  runId: idSchema("run"),
  beforeSnapshotId: idSchema("snapshot"),
  afterSnapshotId: idSchema("snapshot"),
  diffArtifactId: idSchema("artifact"),
});

export type ChangesetTransition =
  | { to: "integrated"; integratedSnapshotId: SnapshotId }
  | { to: "conflict"; conflictTaskId: TaskId };

/** The concrete strategies a Workspace provider may apply at publication time; `other` carries the provider's name. */
export type PublicationStrategy = { kind: "fast_forward" } | { kind: "merge" } | { kind: "other"; name: string };

export const publicationStrategySchema: z.ZodType<PublicationStrategy> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fast_forward") }),
  z.strictObject({ kind: z.literal("merge") }),
  z.strictObject({ kind: z.literal("other"), name: nonEmptyString }),
]);

/**
 * What a `publish` Decision asks for (execution-model §9.4): `automatic`
 * lets the provider select `fast_forward` when the Target still equals the
 * Run's base Snapshot and a clean `merge` otherwise; `exact` names one
 * concrete strategy that is honored exactly or refused, never silently
 * widened or replaced. The concrete strategy is selected at publication
 * time, never at Run creation, and is invisible to every Invocation.
 */
export type PublicationStrategyRequest = { kind: "automatic" } | { kind: "exact"; strategy: PublicationStrategy };

export const publicationStrategyRequestSchema: z.ZodType<PublicationStrategyRequest> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("automatic") }),
  z.strictObject({ kind: z.literal("exact"), strategy: publicationStrategySchema }),
]);
