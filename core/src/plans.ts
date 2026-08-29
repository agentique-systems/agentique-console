import { z } from "zod";
import {
  allocationSchema,
  ON_ALLOCATION_EXHAUSTED_POLICIES,
  ZERO_ALLOCATION,
  type Allocation,
  type OnAllocationExhausted,
} from "./budgets.ts";
import { ValidationError } from "./errors.ts";
import type {
  AcceptanceCriterionId,
  AgentDefinitionRevisionId,
  ArtifactId,
  DecisionId,
  InvocationId,
  PlanEdgeId,
  PlanNodeId,
  RequirementId,
  RequirementRevisionId,
  RunId,
  TaskId,
} from "./ids.ts";
import { defineStateMachine } from "./transitions.ts";
import {
  idSchema,
  nonEmptyString,
  parseOrThrow,
  positiveCount,
  timestampSchema,
  uniqueIds,
  type Timestamp,
} from "./validation.ts";

// ---------------------------------------------------------------------------
// Closed value sets
// ---------------------------------------------------------------------------

/** The six orchestration Patterns. `join` is a node kind, not a Pattern. */
export const PATTERNS = [
  "single",
  "chain",
  "route",
  "parallel",
  "coordinator_worker",
  "evaluator_optimizer",
] as const;
export type Pattern = (typeof PATTERNS)[number];

export const PLAN_NODE_KINDS = ["pattern", "join"] as const;
export type PlanNodeKind = (typeof PLAN_NODE_KINDS)[number];

/** Join fan-in policies: a closed two-value set. */
export const FAN_IN_POLICIES = ["require_all", "require_any"] as const;
export type FanInPolicy = (typeof FAN_IN_POLICIES)[number];

export const PLAN_NODE_STATUSES = [
  "pending",
  "ready",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
] as const;
export type PlanNodeStatus = (typeof PLAN_NODE_STATUSES)[number];

export const PLAN_NODE_WAIT_REASONS = ["decision", "budget", "provider_capacity", "operator"] as const;
export type PlanNodeWaitReason = (typeof PLAN_NODE_WAIT_REASONS)[number];

export const PLAN_EDGE_TYPES = ["sequence", "branch", "fan_in", "retry"] as const;
export type PlanEdgeType = (typeof PLAN_EDGE_TYPES)[number];

/** The roles a Pattern node binds Agent Definition revisions to. */
export const PLAN_NODE_ROLES = ["orchestrator", "worker", "coordinator", "evaluator"] as const;
export type PlanNodeRole = (typeof PLAN_NODE_ROLES)[number];

/** The root Orchestrator node is not compiled from the source form. */
export const ROOT_SOURCE_PATH = "root";

// ---------------------------------------------------------------------------
// Source form
// ---------------------------------------------------------------------------

export interface PlanLimits {
  maxPlanDepth: number;
  maxUnrolledRounds: number;
  maxPlanNodes: number;
}

export const DEFAULT_PLAN_LIMITS: Readonly<PlanLimits> = Object.freeze({
  maxPlanDepth: 4,
  maxUnrolledRounds: 6,
  maxPlanNodes: 200,
});

/** The Context Manifest template of a node: what its Invocations receive. */
export interface ManifestTemplate {
  taskIds: TaskId[];
  decisionIds: DecisionId[];
  artifactIds: ArtifactId[];
}

export const manifestTemplateSchema: z.ZodType<ManifestTemplate> = z.strictObject({
  taskIds: uniqueIds(idSchema("task")),
  decisionIds: uniqueIds(idSchema("decision")),
  artifactIds: uniqueIds(idSchema("artifact")),
});

export const EMPTY_MANIFEST_TEMPLATE: Readonly<ManifestTemplate> = Object.freeze({
  taskIds: [],
  decisionIds: [],
  artifactIds: [],
});

/** A leaf operation: one Agent Definition revision plus an input specification. */
export interface PlanOperation {
  agentDefinitionRevisionId: AgentDefinitionRevisionId;
  title?: string;
  input?: ManifestTemplate;
}

export const planOperationSchema: z.ZodType<PlanOperation> = z.strictObject({
  agentDefinitionRevisionId: idSchema("agentDefinitionRevision"),
  title: nonEmptyString.optional(),
  input: manifestTemplateSchema.optional(),
});

/** Requirement roots an expression serves, at exactly one pinned revision. */
export interface PlanScope {
  requirementRootIds: RequirementId[];
  requirementRevisionId: RequirementRevisionId;
}

export const planScopeSchema: z.ZodType<PlanScope> = z.strictObject({
  requirementRootIds: uniqueIds(idSchema("requirement")).min(1),
  requirementRevisionId: idSchema("requirementRevision"),
});

export interface PlanNodeLimits {
  maxConcurrency?: number;
  maxWallClockMs?: number;
}

export const planNodeLimitsSchema: z.ZodType<PlanNodeLimits> = z.strictObject({
  maxConcurrency: positiveCount.optional(),
  maxWallClockMs: positiveCount.optional(),
});

/** Pattern-specific bounds, persisted on the compiled node. */
export interface PatternBounds {
  maxRounds?: number;
  maxTasks?: number;
  maxConcurrentWorkers?: number;
  maxCoordinatorInvocations?: number;
  requireAll?: boolean;
}

export const patternBoundsSchema: z.ZodType<PatternBounds> = z.strictObject({
  maxRounds: positiveCount.optional(),
  maxTasks: positiveCount.optional(),
  maxConcurrentWorkers: positiveCount.optional(),
  maxCoordinatorInvocations: positiveCount.optional(),
  requireAll: z.boolean().optional(),
});

export interface PlanExpressionCommon {
  title?: string;
  scope?: PlanScope;
  allocation?: Allocation;
  limits?: PlanNodeLimits;
  onAllocationExhausted?: OnAllocationExhausted;
  runOnDependencyFailure?: boolean;
  gateAcceptanceCriterionIds?: AcceptanceCriterionId[];
}

export type RouteSelector =
  | { kind: "decision_answer"; decisionId: DecisionId; labelsByOptionId: Record<string, string> }
  | { kind: "evaluator"; agentDefinitionRevisionId: AgentDefinitionRevisionId };

export interface CoordinatorWorkerBounds {
  maxTasks: number;
  maxConcurrentWorkers: number;
  maxCoordinatorInvocations: number;
}

export type PlanExpression = PlanExpressionCommon &
  (
    | { pattern: "single"; operation: PlanOperation }
    | { pattern: "chain"; steps: PlanExpression[] }
    | { pattern: "route"; selector: RouteSelector; branches: Record<string, PlanExpression> }
    | { pattern: "parallel"; items: PlanExpression[]; aggregate?: PlanOperation; requireAll?: boolean }
    | {
        pattern: "coordinator_worker";
        coordinator: PlanOperation;
        worker: PlanOperation;
        bounds?: CoordinatorWorkerBounds;
      }
    | { pattern: "evaluator_optimizer"; producer: PlanExpression; evaluator: PlanOperation; maxRounds: number }
  );

const commonShape = {
  title: nonEmptyString.optional(),
  scope: planScopeSchema.optional(),
  allocation: allocationSchema.optional(),
  limits: planNodeLimitsSchema.optional(),
  onAllocationExhausted: z.enum(ON_ALLOCATION_EXHAUSTED_POLICIES).optional(),
  runOnDependencyFailure: z.boolean().optional(),
  gateAcceptanceCriterionIds: uniqueIds(idSchema("acceptanceCriterion")).optional(),
};

const routeSelectorSchema: z.ZodType<RouteSelector> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("decision_answer"),
    decisionId: idSchema("decision"),
    labelsByOptionId: z.record(nonEmptyString, nonEmptyString).refine((m) => Object.keys(m).length > 0, {
      message: "a decision_answer selector needs at least one option label",
    }),
  }),
  z.strictObject({
    kind: z.literal("evaluator"),
    agentDefinitionRevisionId: idSchema("agentDefinitionRevision"),
  }),
]);

const coordinatorWorkerBoundsSchema: z.ZodType<CoordinatorWorkerBounds> = z.strictObject({
  maxTasks: positiveCount,
  maxConcurrentWorkers: positiveCount,
  maxCoordinatorInvocations: positiveCount,
});

export const planExpressionSchema: z.ZodType<PlanExpression> = z.lazy(() =>
  z.discriminatedUnion("pattern", [
    z.strictObject({ ...commonShape, pattern: z.literal("single"), operation: planOperationSchema }),
    z.strictObject({ ...commonShape, pattern: z.literal("chain"), steps: z.array(planExpressionSchema).min(1) }),
    z.strictObject({
      ...commonShape,
      pattern: z.literal("route"),
      selector: routeSelectorSchema,
      branches: z
        .record(nonEmptyString, planExpressionSchema)
        .refine((b) => Object.keys(b).length > 0, { message: "a route needs at least one branch" }),
    }),
    z.strictObject({
      ...commonShape,
      pattern: z.literal("parallel"),
      items: z.array(planExpressionSchema).min(1),
      aggregate: planOperationSchema.optional(),
      requireAll: z.boolean().optional(),
    }),
    z.strictObject({
      ...commonShape,
      pattern: z.literal("coordinator_worker"),
      coordinator: planOperationSchema,
      worker: planOperationSchema,
      bounds: coordinatorWorkerBoundsSchema.optional(),
    }),
    z.strictObject({
      ...commonShape,
      pattern: z.literal("evaluator_optimizer"),
      producer: planExpressionSchema,
      evaluator: planOperationSchema,
      maxRounds: positiveCount,
    }),
  ]),
) as z.ZodType<PlanExpression>;

/** The persisted source form of one Execution Plan revision. */
export interface ExecutionPlanSource {
  version: 1;
  expressions: PlanExpression[];
}

export const executionPlanSourceSchema: z.ZodType<ExecutionPlanSource> = z.strictObject({
  version: z.literal(1),
  expressions: z.array(planExpressionSchema),
});

/** Structural depth of an expression: a `single` is 1, nesting adds 1 per level. */
export function planExpressionDepth(expression: PlanExpression): number {
  switch (expression.pattern) {
    case "single":
    case "coordinator_worker":
      return 1;
    case "chain":
      return 1 + Math.max(...expression.steps.map(planExpressionDepth));
    case "parallel":
      return 1 + Math.max(...expression.items.map(planExpressionDepth));
    case "route":
      return 1 + Math.max(...Object.values(expression.branches).map(planExpressionDepth));
    case "evaluator_optimizer":
      return 1 + planExpressionDepth(expression.producer);
  }
}

function collectRounds(expression: PlanExpression, out: number[]): void {
  switch (expression.pattern) {
    case "single":
    case "coordinator_worker":
      return;
    case "chain":
      for (const step of expression.steps) collectRounds(step, out);
      return;
    case "parallel":
      for (const item of expression.items) collectRounds(item, out);
      return;
    case "route":
      for (const branch of Object.values(expression.branches)) collectRounds(branch, out);
      return;
    case "evaluator_optimizer":
      out.push(expression.maxRounds);
      collectRounds(expression.producer, out);
      return;
  }
}

/**
 * Validates a proposed source revision structurally: the closed Pattern set,
 * well-formed operands, nesting depth, and unrolled-round limits. Graph
 * compilation (cycles, node counts, Requirement existence, allocation
 * reservation) is the compiler's job and is not performed here.
 */
export function validateExecutionPlanSource(
  value: unknown,
  limits: PlanLimits = DEFAULT_PLAN_LIMITS,
): ExecutionPlanSource {
  const source = parseOrThrow(executionPlanSourceSchema, value, "execution plan source");
  source.expressions.forEach((expression, index) => {
    const depth = planExpressionDepth(expression);
    if (depth > limits.maxPlanDepth) {
      throw new ValidationError(
        `execution plan expression ${index} nests ${depth} levels; the limit is ${limits.maxPlanDepth}`,
        { index, depth, maxPlanDepth: limits.maxPlanDepth },
      );
    }
    const rounds: number[] = [];
    collectRounds(expression, rounds);
    for (const maxRounds of rounds) {
      if (maxRounds > limits.maxUnrolledRounds) {
        throw new ValidationError(
          `execution plan expression ${index} requests ${maxRounds} rounds; the limit is ${limits.maxUnrolledRounds}`,
          { index, maxRounds, maxUnrolledRounds: limits.maxUnrolledRounds },
        );
      }
    }
  });
  return source;
}

export interface ExecutionPlanRevision {
  runId: RunId;
  number: number;
  source: ExecutionPlanSource;
  /** The Orchestrator Invocation that proposed it; `null` for the runtime-created initial revision. */
  proposedByInvocationId: InvocationId | null;
  createdAt: Timestamp;
}

export const executionPlanRevisionSchema: z.ZodType<ExecutionPlanRevision> = z.strictObject({
  runId: idSchema("run"),
  number: positiveCount,
  source: executionPlanSourceSchema,
  proposedByInvocationId: idSchema("invocation").nullable(),
  createdAt: timestampSchema,
});

// ---------------------------------------------------------------------------
// Compiled form
// ---------------------------------------------------------------------------

export type PlanNodeAgents = Partial<Record<PlanNodeRole, AgentDefinitionRevisionId>>;

export const planNodeAgentsSchema: z.ZodType<PlanNodeAgents> = z
  .strictObject({
    orchestrator: idSchema("agentDefinitionRevision").optional(),
    worker: idSchema("agentDefinitionRevision").optional(),
    coordinator: idSchema("agentDefinitionRevision").optional(),
    evaluator: idSchema("agentDefinitionRevision").optional(),
  })
  .refine((agents) => Object.keys(agents).length > 0, { message: "a pattern node binds at least one role" });

interface PlanNodeBase {
  id: PlanNodeId;
  runId: RunId;
  /** The source revision that produced this node. */
  revisionNumber: number;
  title: string;
  /** Position in the source expression the node was compiled from. */
  sourcePath: string;
  status: PlanNodeStatus;
  waitReason: PlanNodeWaitReason | null;
  allocation: Allocation;
  maxConcurrency: number | null;
  maxWallClockMs: number | null;
  runOnDependencyFailure: boolean;
  outputArtifactIds: ArtifactId[] | null;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  endedAt: Timestamp | null;
}

export interface PatternPlanNode extends PlanNodeBase {
  kind: "pattern";
  pattern: Pattern;
  input: ManifestTemplate;
  agents: PlanNodeAgents;
  bounds: PatternBounds;
  onAllocationExhausted: OnAllocationExhausted;
  gateAcceptanceCriterionIds: AcceptanceCriterionId[];
}

export interface JoinPlanNode extends PlanNodeBase {
  kind: "join";
  fanInPolicy: FanInPolicy;
}

export type PlanNode = PatternPlanNode | JoinPlanNode;

const planNodeBaseShape = {
  id: idSchema("planNode"),
  runId: idSchema("run"),
  revisionNumber: positiveCount,
  title: nonEmptyString,
  sourcePath: nonEmptyString,
  status: z.enum(PLAN_NODE_STATUSES),
  waitReason: z.enum(PLAN_NODE_WAIT_REASONS).nullable(),
  allocation: allocationSchema,
  maxConcurrency: positiveCount.nullable(),
  maxWallClockMs: positiveCount.nullable(),
  runOnDependencyFailure: z.boolean(),
  outputArtifactIds: uniqueIds(idSchema("artifact")).nullable(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
};

export const patternPlanNodeSchema: z.ZodType<PatternPlanNode> = z.strictObject({
  ...planNodeBaseShape,
  kind: z.literal("pattern"),
  pattern: z.enum(PATTERNS),
  input: manifestTemplateSchema,
  agents: planNodeAgentsSchema,
  bounds: patternBoundsSchema,
  onAllocationExhausted: z.enum(ON_ALLOCATION_EXHAUSTED_POLICIES),
  gateAcceptanceCriterionIds: uniqueIds(idSchema("acceptanceCriterion")),
});

export const joinPlanNodeSchema: z.ZodType<JoinPlanNode> = z
  .strictObject({
    ...planNodeBaseShape,
    kind: z.literal("join"),
    fanInPolicy: z.enum(FAN_IN_POLICIES),
  })
  .refine(
    (node) =>
      node.allocation.costUsd === 0 && node.allocation.tokens === 0 && node.allocation.attempts === 0,
    { message: "a join node has zero allocation", path: ["allocation"] },
  );

export const planNodeSchema: z.ZodType<PlanNode> = z
  .discriminatedUnion("kind", [patternPlanNodeSchema as never, joinPlanNodeSchema as never])
  .refine((node: PlanNode) => (node.status === "waiting") === (node.waitReason !== null), {
    message: "waitReason is set exactly when the node is waiting",
    path: ["waitReason"],
  })
  .refine((node: PlanNode) => node.kind === "pattern" || node.status !== "waiting", {
    message: "a join node never waits on anything but its edges",
    path: ["status"],
  }) as unknown as z.ZodType<PlanNode>;

export const PLAN_NODE_MACHINE = defineStateMachine<PlanNodeStatus>("PlanNode", PLAN_NODE_STATUSES, {
  pending: ["ready", "cancelled", "skipped"],
  ready: ["running", "succeeded", "failed", "cancelled", "skipped"],
  running: ["waiting", "succeeded", "failed", "cancelled"],
  waiting: ["running", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped: [],
});

/**
 * Transition validation that also applies the kind-specific rules: a join
 * executes deterministically from `ready` and never runs or waits; a pattern
 * node must run before it can succeed or fail.
 */
export function assertPlanNodeTransition(node: Pick<PlanNode, "kind" | "status">, to: PlanNodeStatus): void {
  PLAN_NODE_MACHINE.assertTransition(node.status, to, { kind: node.kind });
  if (node.kind === "join" && (to === "running" || to === "waiting")) {
    throw new ValidationError(`a join node cannot be ${to}; it executes deterministically from ready`, { to });
  }
  if (node.kind === "pattern" && node.status === "ready" && (to === "succeeded" || to === "failed")) {
    throw new ValidationError(`a pattern node must be running before it can be ${to}`, { to });
  }
}

export const ZERO_JOIN_ALLOCATION: Readonly<Allocation> = ZERO_ALLOCATION;

interface PlanEdgeBase {
  id: PlanEdgeId;
  runId: RunId;
  sourceNodeId: PlanNodeId;
  targetNodeId: PlanNodeId;
  /** Order among edges into the same target (fan-in index order). */
  position: number;
  createdAt: Timestamp;
}

export type PlanEdge = PlanEdgeBase &
  (
    | { type: "sequence" }
    | { type: "branch"; label: string }
    | { type: "fan_in" }
    | { type: "retry"; round: number }
  );

const planEdgeBaseShape = {
  id: idSchema("planEdge"),
  runId: idSchema("run"),
  sourceNodeId: idSchema("planNode"),
  targetNodeId: idSchema("planNode"),
  position: z.number().int().min(0),
  createdAt: timestampSchema,
};

export const planEdgeSchema: z.ZodType<PlanEdge> = z
  .discriminatedUnion("type", [
    z.strictObject({ ...planEdgeBaseShape, type: z.literal("sequence") }),
    z.strictObject({ ...planEdgeBaseShape, type: z.literal("branch"), label: nonEmptyString }),
    z.strictObject({ ...planEdgeBaseShape, type: z.literal("fan_in") }),
    z.strictObject({ ...planEdgeBaseShape, type: z.literal("retry"), round: z.number().int().min(2) }),
  ])
  .refine((edge) => edge.sourceNodeId !== edge.targetNodeId, {
    message: "a plan edge cannot loop a node onto itself",
    path: ["targetNodeId"],
  });

/** One row of a pattern node's exact Requirement scope at a pinned revision. */
export interface PlanNodeRequirement {
  planNodeId: PlanNodeId;
  runId: RunId;
  requirementId: RequirementId;
  requirementRevisionId: RequirementRevisionId;
}

export const planNodeRequirementSchema: z.ZodType<PlanNodeRequirement> = z.strictObject({
  planNodeId: idSchema("planNode"),
  runId: idSchema("run"),
  requirementId: idSchema("requirement"),
  requirementRevisionId: idSchema("requirementRevision"),
});
