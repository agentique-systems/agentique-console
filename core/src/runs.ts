import { z } from "zod";
import { budgetLimitsSchema, type BudgetLimits } from "./budgets.ts";
import type { ConversationId, RunId, SnapshotId, WorkspaceId } from "./ids.ts";
import { defineStateMachine } from "./transitions.ts";
import { idSchema, nonEmptyString, timestampSchema, type Timestamp } from "./validation.ts";

export const RUN_KINDS = ["code", "other"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = [
  "created",
  "running",
  "waiting",
  "verifying",
  "awaiting_signoff",
  "completed",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Why a Run is `waiting`; recorded exactly when the status is `waiting`. */
export const RUN_WAIT_REASONS = ["decision", "budget", "provider_capacity", "operator"] as const;
export type RunWaitReason = (typeof RUN_WAIT_REASONS)[number];

/**
 * The only terminal failure transitions (execution-model §3): the root Plan
 * Node failed, or the Orchestrator declared the Run infeasible with Evidence.
 */
export const RUN_FAILURE_KINDS = ["root_node_failed", "infeasible"] as const;
export type RunFailureKind = (typeof RUN_FAILURE_KINDS)[number];

export interface RunFailure {
  kind: RunFailureKind;
  summary: string;
  /** Artifact ids supporting the failure (required for `infeasible`). */
  evidenceArtifactIds: string[];
}

export const runFailureSchema: z.ZodType<RunFailure> = z
  .strictObject({
    kind: z.enum(RUN_FAILURE_KINDS),
    summary: nonEmptyString,
    evidenceArtifactIds: z.array(idSchema("artifact")),
  })
  .refine((f) => f.kind !== "infeasible" || f.evidenceArtifactIds.length > 0, {
    message: "an infeasible Run failure requires Evidence Artifacts",
    path: ["evidenceArtifactIds"],
  });

/** The operator-controlled place a Run's result is intended for. */
export type RunTarget = { kind: "branch"; branch: string } | { kind: "directory" };

export const runTargetSchema: z.ZodType<RunTarget> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("branch"), branch: nonEmptyString }),
  z.strictObject({ kind: z.literal("directory") }),
]);

export interface Run {
  id: RunId;
  conversationId: ConversationId;
  workspaceId: WorkspaceId;
  kind: RunKind;
  status: RunStatus;
  waitReason: RunWaitReason | null;
  target: RunTarget;
  /** The Run Budget: the global cap and allocation pool. */
  budget: BudgetLimits;
  baseSnapshotId: SnapshotId | null;
  integrationSnapshotId: SnapshotId | null;
  finalSnapshotId: SnapshotId | null;
  integrationWorkspacePath: string | null;
  failure: RunFailure | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  endedAt: Timestamp | null;
}

export const RUN_MACHINE = defineStateMachine<RunStatus>("Run", RUN_STATUSES, {
  created: ["running", "cancelled"],
  running: ["verifying", "waiting", "failed", "cancelled"],
  waiting: ["running", "cancelled"],
  verifying: ["awaiting_signoff", "running", "cancelled"],
  awaiting_signoff: ["completed", "running", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
});

export const runSchema: z.ZodType<Run> = z
  .strictObject({
    id: idSchema("run"),
    conversationId: idSchema("conversation"),
    workspaceId: idSchema("workspace"),
    kind: z.enum(RUN_KINDS),
    status: z.enum(RUN_STATUSES),
    waitReason: z.enum(RUN_WAIT_REASONS).nullable(),
    target: runTargetSchema,
    budget: budgetLimitsSchema,
    baseSnapshotId: idSchema("snapshot").nullable(),
    integrationSnapshotId: idSchema("snapshot").nullable(),
    finalSnapshotId: idSchema("snapshot").nullable(),
    integrationWorkspacePath: nonEmptyString.nullable(),
    failure: runFailureSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    endedAt: timestampSchema.nullable(),
  })
  .refine((run) => (run.status === "waiting") === (run.waitReason !== null), {
    message: "waitReason is set exactly when the Run is waiting",
    path: ["waitReason"],
  })
  .refine((run) => (run.status === "failed") === (run.failure !== null), {
    message: "failure is set exactly when the Run failed",
    path: ["failure"],
  })
  .refine((run) => RUN_MACHINE.isTerminal(run.status) === (run.endedAt !== null), {
    message: "endedAt is set exactly when the Run is terminal",
    path: ["endedAt"],
  });

export interface RunInput {
  conversationId: ConversationId;
  kind: RunKind;
  target: RunTarget;
  budget: BudgetLimits;
}

export const runInputSchema: z.ZodType<RunInput> = z.strictObject({
  conversationId: idSchema("conversation"),
  kind: z.enum(RUN_KINDS),
  target: runTargetSchema,
  budget: budgetLimitsSchema,
});

/**
 * A Run transition request. `waitReason` is required when entering
 * `waiting`; leaving `waiting` for `running` is the reason-clearing
 * transition and must state which reason cleared; `failure` is required when
 * entering `failed`.
 */
export type RunTransition =
  | { to: "running"; clearedWaitReason?: RunWaitReason }
  | { to: "waiting"; waitReason: RunWaitReason }
  | { to: "verifying" }
  | { to: "awaiting_signoff" }
  | { to: "completed"; finalSnapshotId: SnapshotId }
  | { to: "failed"; failure: RunFailure }
  | { to: "cancelled" };
