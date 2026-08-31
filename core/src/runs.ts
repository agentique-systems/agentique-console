import { z } from "zod";
import {
  allocationFits,
  allocationOfLimits,
  allocationSchema,
  budgetLimitsSchema,
  type Allocation,
  type BudgetIncreasePartition,
  type BudgetLimits,
} from "./budgets.ts";
import type { AcceptanceCriterionId, AgentDefinitionRevisionId, ChangesetId, ConversationId, RunId, SnapshotId, WorkspaceId } from "./ids.ts";
import { defineStateMachine } from "./transitions.ts";
import { idSchema, nonEmptyString, timestampSchema, uniqueIds, type Timestamp } from "./validation.ts";

/** The hard validation bound on `VerificationPolicy.maxNodeGateCycles`. */
export const MAX_NODE_GATE_CYCLES = 10;

/** The hard validation bound on `VerificationPolicy.maxRunCompletionCycles`. */
export const MAX_RUN_COMPLETION_CYCLES = 10;

/**
 * The Run's immutable verification policy (execution-model §10): which Agent
 * Definition revision every Gate Evaluator Invocation of the Run executes,
 * how many `node_exit` Gates one Plan Node may open before it fails with
 * `gate_cycles_exhausted`, how many `run_completion` Gates the Run may open
 * before a further Completion Request is refused with
 * `run_completion_cycles_exhausted`, and the Acceptance Criteria the Run
 * itself declares for its `run_completion` Gate (deduplicated, in canonical
 * id order; a coding Run declares at least one deterministic one at
 * creation). Chosen at Run creation, persisted on the Run, and never read
 * from ambient Workspace state, a latest revision, a provider default, or
 * mutable configuration afterwards. `null` names no Evaluator: a Run whose
 * Gates carry only deterministic criteria; a plan revision that gates a node
 * on an evaluated criterion is then rejected, and a Completion Request whose
 * criterion set holds an evaluated criterion is refused.
 */
export interface VerificationPolicy {
  evaluatorAgentDefinitionRevisionId: AgentDefinitionRevisionId | null;
  maxNodeGateCycles: number;
  maxRunCompletionCycles: number;
  runCompletionAcceptanceCriterionIds: AcceptanceCriterionId[];
}

const canonicalIds = (ids: readonly string[]): boolean => ids.every((id, i) => i === 0 || ids[i - 1]! < id);

export const verificationPolicySchema: z.ZodType<VerificationPolicy> = z.strictObject({
  evaluatorAgentDefinitionRevisionId: idSchema("agentDefinitionRevision").nullable(),
  maxNodeGateCycles: z.number().int().min(1).max(MAX_NODE_GATE_CYCLES),
  maxRunCompletionCycles: z.number().int().min(1).max(MAX_RUN_COMPLETION_CYCLES),
  runCompletionAcceptanceCriterionIds: uniqueIds(idSchema("acceptanceCriterion")).refine(canonicalIds, { message: "completion criteria are in canonical id order" }),
});

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
export const RUN_WAIT_REASONS = ["decision", "budget", "provider_capacity", "integration_conflict", "operator"] as const;
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
  /**
   * The immutable base Run Budget: the global cap and allocation pool as
   * supplied at creation. The effective limits derive from it plus the Run's
   * approved Budget Increases (`RunCapacity`); no effective aggregate is stored.
   */
  budget: BudgetLimits;
  /**
   * The immutable base final reserve, chosen at Run creation: Run capacity
   * that ordinary Plan Node allocations never consume, spent only on
   * `final_synthesis` Orchestrator Invocations and `run_completion` Gate
   * Evaluator Invocations. The effective final reserve adds the approved
   * `final_reserve` Budget Increases.
   */
  finalReserve: Allocation;
  /** The immutable verification policy: the Gate Evaluator revision and the `node_exit` Gate cycle bound. */
  verificationPolicy: VerificationPolicy;
  baseSnapshotId: SnapshotId | null;
  integrationSnapshotId: SnapshotId | null;
  /** The accepted integration Snapshot of a `completed` Run (execution-model §9.3): the signoff Gate's verified Snapshot; `null` otherwise. */
  finalSnapshotId: SnapshotId | null;
  /** The Run's one `final` Changeset (base Snapshot to final Snapshot), recorded at signoff acceptance; set exactly when the Run is `completed`. */
  finalChangesetId: ChangesetId | null;
  integrationWorkspacePath: string | null;
  failure: RunFailure | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  endedAt: Timestamp | null;
}

/**
 * The Run statuses in which a Budget Increase of each partition may be
 * requested and approved (execution-model §7.6): the ordinary pool may grow
 * until the Run ends, including while it awaits signoff (the follow-up turn
 * of a change request is ordinary work); the final reserve may grow only
 * before completion verification has begun — never while the Run is
 * `verifying` or `awaiting_signoff`, and never on a terminal Run.
 */
export const BUDGET_INCREASE_PERMITTED_STATUSES: Readonly<Record<BudgetIncreasePartition, readonly RunStatus[]>> = Object.freeze({
  ordinary: ["created", "running", "waiting", "awaiting_signoff"],
  final_reserve: ["created", "running", "waiting"],
});

export function budgetIncreasePermitted(status: RunStatus, partition: BudgetIncreasePartition): boolean {
  return BUDGET_INCREASE_PERMITTED_STATUSES[partition].includes(status);
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
    finalReserve: allocationSchema,
    verificationPolicy: verificationPolicySchema,
    baseSnapshotId: idSchema("snapshot").nullable(),
    integrationSnapshotId: idSchema("snapshot").nullable(),
    finalSnapshotId: idSchema("snapshot").nullable(),
    finalChangesetId: idSchema("changeset").nullable(),
    integrationWorkspacePath: nonEmptyString.nullable(),
    failure: runFailureSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    endedAt: timestampSchema.nullable(),
  })
  .refine((run) => (run.status === "completed" ? run.finalSnapshotId !== null && run.finalChangesetId !== null : run.finalSnapshotId === null && run.finalChangesetId === null), {
    message: "a completed Run records its final Snapshot and final Changeset; no other Run carries either",
    path: ["finalChangesetId"],
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
  })
  .refine((run) => allocationFits(run.finalReserve, allocationOfLimits(run.budget)), {
    message: "the final reserve fits within the Run Budget",
    path: ["finalReserve"],
  });

export interface RunInput {
  conversationId: ConversationId;
  kind: RunKind;
  target: RunTarget;
  budget: BudgetLimits;
  /** Selected and validated at creation; persisted on the Run and never changed. */
  finalReserve: Allocation;
  /** Selected and validated at creation; persisted on the Run and never changed. */
  verificationPolicy: VerificationPolicy;
}

export const runInputSchema: z.ZodType<RunInput> = z
  .strictObject({
    conversationId: idSchema("conversation"),
    kind: z.enum(RUN_KINDS),
    target: runTargetSchema,
    budget: budgetLimitsSchema,
    finalReserve: allocationSchema,
    verificationPolicy: verificationPolicySchema,
  })
  .refine((input) => allocationFits(input.finalReserve, allocationOfLimits(input.budget)), {
    message: "the final reserve fits within the Run Budget",
    path: ["finalReserve"],
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
  /** Acceptance at the `operator_signoff` Gate (execution-model §9.3): the verified Snapshot becomes the final Snapshot and the Run's `final` Changeset is named. */
  | { to: "completed"; finalSnapshotId: SnapshotId; finalChangesetId: ChangesetId }
  | { to: "failed"; failure: RunFailure }
  | { to: "cancelled" };
