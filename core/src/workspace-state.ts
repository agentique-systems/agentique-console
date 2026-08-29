import { z } from "zod";
import type {
  ArtifactId,
  ChangesetId,
  DecisionId,
  InvocationId,
  PublicationId,
  RunId,
  SnapshotId,
  TaskId,
  WorkspaceId,
} from "./ids.ts";
import { defineStateMachine } from "./transitions.ts";
import { idSchema, nonEmptyString, sha256Hex, timestampSchema, type Timestamp } from "./validation.ts";

/** Why a Snapshot was taken. */
export const SNAPSHOT_REASONS = [
  "run_start",
  "before_invocation",
  "after_invocation",
  "integration",
  "run_completion",
  "publish_before",
  "publish_after",
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

export const CHANGESET_INTEGRATION_STATUSES = ["pending", "integrated", "conflict"] as const;
export type ChangesetIntegrationStatus = (typeof CHANGESET_INTEGRATION_STATUSES)[number];

export const CHANGESET_MACHINE = defineStateMachine<ChangesetIntegrationStatus>(
  "Changeset",
  CHANGESET_INTEGRATION_STATUSES,
  {
    pending: ["integrated", "conflict"],
    integrated: [],
    conflict: ["integrated"],
  },
);

/** The difference between two Snapshots, stored as a diff Artifact. */
export interface Changeset {
  id: ChangesetId;
  runId: RunId;
  /** The writing Invocation; `null` for the Run's final Changeset. */
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

export const changesetSchema: z.ZodType<Changeset> = z
  .strictObject({
    id: idSchema("changeset"),
    runId: idSchema("run"),
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
  .refine((c) => (c.integrationStatus === "integrated") === (c.integratedSnapshotId !== null && c.integratedAt !== null), {
    message: "integration fields are set exactly when the Changeset is integrated",
    path: ["integratedSnapshotId"],
  })
  .refine((c) => (c.integrationStatus === "conflict") === (c.conflictTaskId !== null), {
    message: "conflictTaskId is set exactly when the Changeset conflicts",
    path: ["conflictTaskId"],
  });

export interface ChangesetInput {
  runId: RunId;
  invocationId: InvocationId | null;
  beforeSnapshotId: SnapshotId;
  afterSnapshotId: SnapshotId;
  diffArtifactId: ArtifactId;
}

export const changesetInputSchema: z.ZodType<ChangesetInput> = z.strictObject({
  runId: idSchema("run"),
  invocationId: idSchema("invocation").nullable(),
  beforeSnapshotId: idSchema("snapshot"),
  afterSnapshotId: idSchema("snapshot"),
  diffArtifactId: idSchema("artifact"),
});

export type ChangesetTransition =
  | { to: "integrated"; integratedSnapshotId: SnapshotId }
  | { to: "conflict"; conflictTaskId: TaskId };

export const PUBLICATION_OUTCOMES = ["succeeded", "failed"] as const;
export type PublicationOutcome = (typeof PUBLICATION_OUTCOMES)[number];

/** Strategies the Workspace provider may select at publish time; `other` carries the provider's name. */
export type PublicationStrategy = { kind: "fast_forward" } | { kind: "merge" } | { kind: "other"; name: string };

export const publicationStrategySchema: z.ZodType<PublicationStrategy> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fast_forward") }),
  z.strictObject({ kind: z.literal("merge") }),
  z.strictObject({ kind: z.literal("other"), name: nonEmptyString }),
]);

/** One publish action on a `completed` Run. */
export interface Publication {
  id: PublicationId;
  runId: RunId;
  /** The `publish` Decision or the `operator_choice` publish authorization. */
  decisionId: DecisionId;
  changesetId: ChangesetId;
  targetBeforeSnapshotId: SnapshotId;
  targetAfterSnapshotId: SnapshotId | null;
  strategy: PublicationStrategy;
  outcome: PublicationOutcome;
  failureReason: string | null;
  artifactId: ArtifactId | null;
  createdAt: Timestamp;
}

export const publicationSchema: z.ZodType<Publication> = z
  .strictObject({
    id: idSchema("publication"),
    runId: idSchema("run"),
    decisionId: idSchema("decision"),
    changesetId: idSchema("changeset"),
    targetBeforeSnapshotId: idSchema("snapshot"),
    targetAfterSnapshotId: idSchema("snapshot").nullable(),
    strategy: publicationStrategySchema,
    outcome: z.enum(PUBLICATION_OUTCOMES),
    failureReason: nonEmptyString.nullable(),
    artifactId: idSchema("artifact").nullable(),
    createdAt: timestampSchema,
  })
  .refine((p) => (p.outcome === "failed") === (p.failureReason !== null), {
    message: "failureReason is set exactly when the Publication failed",
    path: ["failureReason"],
  })
  .refine((p) => p.outcome !== "succeeded" || p.targetAfterSnapshotId !== null, {
    message: "a succeeded Publication records the Target's after Snapshot",
    path: ["targetAfterSnapshotId"],
  })
  .refine((p) => p.outcome !== "failed" || p.targetAfterSnapshotId === null, {
    message: "a failed Publication wrote nothing to the Target",
    path: ["targetAfterSnapshotId"],
  });

export type PublicationInput = Omit<Publication, "id" | "createdAt">;

export const publicationInputSchema: z.ZodType<PublicationInput> = z
  .strictObject({
    runId: idSchema("run"),
    decisionId: idSchema("decision"),
    changesetId: idSchema("changeset"),
    targetBeforeSnapshotId: idSchema("snapshot"),
    targetAfterSnapshotId: idSchema("snapshot").nullable(),
    strategy: publicationStrategySchema,
    outcome: z.enum(PUBLICATION_OUTCOMES),
    failureReason: nonEmptyString.nullable(),
    artifactId: idSchema("artifact").nullable(),
  })
  .refine((p) => (p.outcome === "failed") === (p.failureReason !== null), {
    message: "failureReason is set exactly when the Publication failed",
    path: ["failureReason"],
  })
  .refine((p) => (p.outcome === "succeeded") === (p.targetAfterSnapshotId !== null), {
    message: "a succeeded Publication records the Target after Snapshot; a failed one wrote nothing",
    path: ["targetAfterSnapshotId"],
  });
