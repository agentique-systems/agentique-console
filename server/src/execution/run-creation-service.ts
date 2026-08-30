/**
 * Atomic Run bootstrap (execution-model §3 `created`, §4.6). Creating a Run
 * establishes its complete initial canonical state in one root transaction:
 * the Run with its Budget and persisted final reserve, the base Snapshot
 * and Integration Workspace, accepted Execution Plan revision 1 (empty
 * source), the root Orchestrator node with its explicit initial allocation
 * reserved from ordinary Run capacity, revision-1 membership, the
 * Conversation's active-Run reference, and every corresponding Event. The
 * Run is left in `created`; the initial Orchestrator Invocation belongs to
 * the next phase.
 */
import {
  addAllocation,
  allocationFits,
  allocationOfLimits,
  allocationSchema,
  budgetLimitsSchema,
  EMPTY_MANIFEST_TEMPLATE,
  idSchema,
  MAX_NODE_GATE_CYCLES,
  MAX_RUN_COMPLETION_CYCLES,
  nonEmptyString,
  NotFoundError,
  ORCHESTRATOR_DEFINITION_NAME,
  orchestratorDefinitionDefects,
  parseOrThrow,
  ROOT_NODE_TITLE,
  ROOT_SOURCE_PATH,
  runTargetSchema,
  RUN_KINDS,
  ValidationError,
  verificationPolicySchema,
  type AcceptanceCriterionId,
  type AgentDefinitionRevisionId,
  type Allocation,
  type BudgetLimits,
  type ConversationId,
  type ExecutionPlanRevision,
  type PatternPlanNodeDefinition,
  type PlanGraph,
  type PlanNode,
  type Run,
  type RunKind,
  type RunTarget,
  type Snapshot,
  type VerificationPolicy,
} from "@agentique-console/core";
import { z } from "zod";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import { resolveExecutableAgentDefinitionRevision } from "./agent-definitions.ts";
import type { RunWorkspacePreparationPort, RunWorkspacePreparationRequest } from "./ports/workspace-preparation.ts";

/** Configurable defaults; the effective values are persisted on each Run. */
export interface RunCreationPolicy {
  /** The root Orchestrator node's explicit initial allocation; never the whole Run Budget. */
  initialOrchestratorAllocation: Allocation;
  /** The default final reserve per Run kind (enabled by default for `code`). */
  finalReserve: Record<RunKind, Allocation>;
  /** The default `node_exit` Gate cycle bound of a Run's verification policy. */
  maxNodeGateCycles: number;
  /** The default `run_completion` Gate cycle bound of a Run's verification policy. */
  maxRunCompletionCycles: number;
}

export const DEFAULT_RUN_CREATION_POLICY: Readonly<RunCreationPolicy> = Object.freeze({
  initialOrchestratorAllocation: { costUsd: 5, tokens: 500_000, attempts: 10 },
  finalReserve: {
    code: { costUsd: 2, tokens: 200_000, attempts: 4 },
    other: { costUsd: 0, tokens: 0, attempts: 0 },
  },
  maxNodeGateCycles: 3,
  maxRunCompletionCycles: 3,
});

/** The verification policy a Run is created with (execution-model §10); the effective values are persisted on the Run and immutable. */
export interface RunVerificationRequest {
  /** The Gate Evaluator revision, resolved through the executable-revision resolver; `null` for a Run with deterministic-only Gates. */
  evaluatorAgentDefinitionRevisionId: string | null;
  /** Overrides the policy default. */
  maxNodeGateCycles?: number;
  /** Overrides the policy default. */
  maxRunCompletionCycles?: number;
  /**
   * The Acceptance Criteria the Run declares for its `run_completion` Gate: each must exist in the Run's Conversation on a
   * Requirement (pinned to a revision of that Conversation) or on a Task of that Conversation; a coding Run declares at
   * least one deterministic one. Deduplicated and persisted in canonical id order.
   */
  runCompletionAcceptanceCriterionIds?: string[];
}

export interface RunCreationRequest {
  conversationId: ConversationId;
  kind: RunKind;
  target: RunTarget;
  budget: BudgetLimits;
  orchestratorAgentDefinitionRevisionId: AgentDefinitionRevisionId;
  /** Overrides the policy default; the effective value is persisted on the Run. */
  finalReserve?: Allocation;
  /** Overrides the policy default; the effective value is the root node's allocation. */
  orchestratorAllocation?: Allocation;
  /** The verification policy; defaults to no Gate Evaluator and the policy's cycle bound. */
  verificationPolicy?: RunVerificationRequest;
  correlationId?: string | null;
}

const runCreationRequestSchema: z.ZodType<RunCreationRequest> = z.strictObject({
  conversationId: idSchema("conversation"),
  kind: z.enum(RUN_KINDS),
  target: runTargetSchema,
  budget: budgetLimitsSchema,
  orchestratorAgentDefinitionRevisionId: idSchema("agentDefinitionRevision"),
  finalReserve: allocationSchema.optional(),
  orchestratorAllocation: allocationSchema.optional(),
  verificationPolicy: z
    .strictObject({
      evaluatorAgentDefinitionRevisionId: nonEmptyString.nullable(),
      maxNodeGateCycles: z.number().int().min(1).max(MAX_NODE_GATE_CYCLES).optional(),
      maxRunCompletionCycles: z.number().int().min(1).max(MAX_RUN_COMPLETION_CYCLES).optional(),
      runCompletionAcceptanceCriterionIds: z.array(idSchema("acceptanceCriterion")).optional(),
    })
    .optional(),
  correlationId: nonEmptyString.nullable().optional(),
});

/** The complete initial state a Run creation establishes. */
export interface CreatedRun {
  run: Run;
  root: PlanNode;
  baseSnapshot: Snapshot;
  revision: ExecutionPlanRevision;
  graph: PlanGraph;
}

export class RunCreationService {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
    private readonly workspacePreparation: RunWorkspacePreparationPort,
    private readonly policy: RunCreationPolicy = DEFAULT_RUN_CREATION_POLICY,
  ) {}

  /**
   * Validates the request against the architecture (Conversation and
   * Workspace ownership, one active Run per Conversation, an Orchestrator
   * definition with the required capabilities, an initial allocation and a
   * final reserve that fit the Run Budget together, no whole-Budget
   * allocation) and then builds the Run atomically. A Workspace preparation
   * failure creates nothing; a persistence failure after preparation runs
   * the port's compensation after the database rolls back.
   */
  create(request: RunCreationRequest): CreatedRun {
    const valid = parseOrThrow(runCreationRequestSchema, request, "Run creation request");
    const finalReserve = valid.finalReserve ?? this.policy.finalReserve[valid.kind];
    const allocation = valid.orchestratorAllocation ?? this.policy.initialOrchestratorAllocation;
    const budget = allocationOfLimits(valid.budget);
    if (!allocationFits(finalReserve, budget)) {
      throw new ValidationError("the final reserve does not fit within the Run Budget", { finalReserve, budget });
    }
    if (!allocationFits(allocation, budget)) {
      throw new ValidationError("the initial Orchestrator allocation does not fit within the Run Budget", { allocation, budget });
    }
    if (!allocationFits(addAllocation(allocation, finalReserve), budget)) {
      throw new ValidationError("the initial Orchestrator allocation plus the final reserve does not fit within the Run Budget", { allocation, finalReserve, budget });
    }
    if (allocation.costUsd >= budget.costUsd && allocation.tokens >= budget.tokens && allocation.attempts >= budget.attempts) {
      throw new ValidationError("the root Orchestrator node receives an explicit initial allocation, never the whole Run Budget", { allocation, budget });
    }

    const conversation = this.stores.conversations.get(valid.conversationId);
    const workspace = this.stores.workspaces.get(conversation.workspaceId);
    // Provenance ownership and the Orchestrator role policy are settled before any Workspace preparation or canonical write.
    const resolved = resolveExecutableAgentDefinitionRevision(this.stores, { workspaceId: workspace.id, conversationId: conversation.id }, valid.orchestratorAgentDefinitionRevisionId);
    if (!resolved.ok) throw new ValidationError(`the Orchestrator Agent Definition revision is not executable by this Run: ${resolved.message}`, { revisionId: resolved.revisionId });
    const revision = resolved.revision;
    const defects = orchestratorDefinitionDefects(revision.definitionName, revision);
    if (defects.length > 0) {
      throw new ValidationError(`Agent Definition revision ${revision.id} cannot hold the Orchestrator role: ${defects.join("; ")}`, { defects });
    }
    // The immutable verification policy: the Gate Evaluator revision resolves through the same executable-revision resolver
    // (provenance ownership), is never the Orchestrator definition, and is read-only by role policy at every Gate.
    const evaluatorId = valid.verificationPolicy?.evaluatorAgentDefinitionRevisionId ?? null;
    if (evaluatorId !== null) {
      const evaluator = resolveExecutableAgentDefinitionRevision(this.stores, { workspaceId: workspace.id, conversationId: conversation.id }, evaluatorId);
      if (!evaluator.ok) throw new ValidationError(`the Gate Evaluator Agent Definition revision is not executable by this Run: ${evaluator.message}`, { revisionId: evaluator.revisionId });
      if (evaluator.revision.definitionName === ORCHESTRATOR_DEFINITION_NAME) throw new ValidationError(`the ${ORCHESTRATOR_DEFINITION_NAME} definition cannot be the Run's Gate Evaluator`, { revisionId: evaluator.revision.id });
    }
    // The declared completion criteria: each exists in this Conversation on a Requirement pinned to a revision of this Conversation or
    // on a Task of this Conversation; deduplicated and canonically ordered; a coding Run declares at least one deterministic one.
    const criterionIds = [...new Set(valid.verificationPolicy?.runCompletionAcceptanceCriterionIds ?? [])].sort() as AcceptanceCriterionId[];
    let deterministic = 0;
    for (const id of criterionIds) {
      let criterion;
      try {
        criterion = this.stores.requirements.getAcceptanceCriterion(id);
      } catch (error) {
        if (error instanceof NotFoundError) throw new ValidationError(`completion criterion ${id} does not exist`, { acceptanceCriterionId: id });
        throw error;
      }
      if (criterion.conversationId !== conversation.id) throw new ValidationError(`completion criterion ${id} belongs to another Conversation`, { acceptanceCriterionId: id });
      if (criterion.requirementId !== null) {
        const requirement = this.stores.requirements.get(criterion.requirementId);
        if (requirement.conversationId !== conversation.id) throw new ValidationError(`completion criterion ${id} belongs to a Requirement of another Conversation`, { acceptanceCriterionId: id });
        const revision = criterion.requirementRevisionId === null ? null : this.stores.requirements.getRevision(criterion.requirementRevisionId);
        if (revision === null || revision.conversationId !== conversation.id) throw new ValidationError(`completion criterion ${id} is not pinned to a Requirement revision of this Conversation`, { acceptanceCriterionId: id });
      } else if (criterion.taskId !== null) {
        const task = this.stores.tasks.get(criterion.taskId);
        if (this.stores.runs.get(task.runId).conversationId !== conversation.id) throw new ValidationError(`completion criterion ${id} belongs to a Task of another Conversation`, { acceptanceCriterionId: id });
      }
      if (criterion.check.kind === "deterministic") deterministic += 1;
    }
    if (valid.kind === "code" && deterministic === 0) throw new ValidationError("a coding Run declares at least one deterministic completion criterion", { runCompletionAcceptanceCriterionIds: criterionIds });
    if (criterionIds.length > deterministic && evaluatorId === null) throw new ValidationError("a Run whose completion criteria include an evaluated criterion names a Gate Evaluator", { runCompletionAcceptanceCriterionIds: criterionIds });
    const verificationPolicy: VerificationPolicy = parseOrThrow(
      verificationPolicySchema,
      {
        evaluatorAgentDefinitionRevisionId: evaluatorId,
        maxNodeGateCycles: valid.verificationPolicy?.maxNodeGateCycles ?? this.policy.maxNodeGateCycles,
        maxRunCompletionCycles: valid.verificationPolicy?.maxRunCompletionCycles ?? this.policy.maxRunCompletionCycles,
        runCompletionAcceptanceCriterionIds: criterionIds,
      },
      "verification policy",
    );

    const meta = { correlationId: valid.correlationId ?? null };
    return this.ctx.tx.write(() => {
      const created = this.stores.runs.create(
        { conversationId: conversation.id, kind: valid.kind, target: valid.target, budget: valid.budget, finalReserve, verificationPolicy },
        meta,
      );
      const preparation: RunWorkspacePreparationRequest = { runId: created.id, workspace, target: valid.target };
      const prepared = this.workspacePreparation.prepare(preparation);
      this.ctx.tx.afterRollback(() => this.workspacePreparation.discard(preparation, prepared));
      const baseSnapshot = this.stores.snapshots.record(
        { workspaceId: workspace.id, runId: created.id, identity: prepared.baseSnapshot, reason: "run_start" },
        meta,
      );
      this.stores.runs.recordWorkspaceState(created.id, { baseSnapshotId: baseSnapshot.id, integrationWorkspacePath: prepared.integrationWorkspacePath });
      const planRevision = this.stores.plans.appendRevision(created.id, { version: 1, expressions: [] }, null, meta);
      const rootId = this.ctx.ids("planNode");
      const root: PatternPlanNodeDefinition = {
        kind: "pattern",
        pattern: "single",
        title: ROOT_NODE_TITLE,
        sourcePath: ROOT_SOURCE_PATH,
        shape: {
          pattern: "single",
          role: "orchestrator",
          operation: { agentDefinitionRevisionId: revision.id, title: ROOT_NODE_TITLE, input: { ...EMPTY_MANIFEST_TEMPLATE }, role: "orchestrator", readOnly: false },
        },
        input: { ...EMPTY_MANIFEST_TEMPLATE },
        allocation,
        maxConcurrency: null,
        maxWallClockMs: null,
        onAllocationExhausted: "extend",
        runOnDependencyFailure: false,
        gateAcceptanceCriterionIds: [],
        scope: null,
      };
      const graph = this.stores.plans.materializeRevision(
        { runId: created.id, revisionNumber: planRevision.number, membership: [rootId], createdNodes: [{ id: rootId, definition: root }], edges: [], cancelledNodeIds: [] },
        meta,
      );
      return { run: this.stores.runs.get(created.id), root: graph.nodes[0]!, baseSnapshot, revision: planRevision, graph };
    });
  }
}
