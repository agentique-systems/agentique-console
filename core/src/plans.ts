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
  canonicalJson,
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

export const PLAN_NODE_WAIT_REASONS = ["decision", "budget", "provider_capacity", "integration_conflict", "operator"] as const;
export type PlanNodeWaitReason = (typeof PLAN_NODE_WAIT_REASONS)[number];

/** Why a pattern node ended `failed` (execution-model §5, §7.6, §9.2); recorded on the `plan_node.failed` Event. */
export const PLAN_NODE_FAILURE_REASONS = [
  /** The node's Invocation ended `failed` after its permitted Attempts. */
  "invocation_failed",
  /** The Invocation returned a valid result declaring the work `failed`. */
  "result_failed",
  /** The Invocation returned `blocked` without naming an open Decision of the Run. */
  "result_blocked",
  /** An operation names a Task the node cannot own: missing, assigned elsewhere, blocked, or already terminal. */
  "task_unavailable",
  /** The node's allocation cannot cover its next Invocation under policy `fail`. */
  "allocation_exhausted",
  /** The conflict Task of the node's Changeset ended without resolving the conflict. */
  "integration_conflict",
  /** A join node's fan-in policy was not met. */
  "join_fan_in_failed",
  /** A route node's selector produced no valid branch label: the selection Invocation failed, or a Decision answer maps to no branch. */
  "route_selection_failed",
  /** A parallel node's items ended without satisfying `requireAll` (or with no item succeeding). */
  "parallel_items_failed",
  /** A Coordinator turn succeeded without changing the node's canonical Task state: no accepted proposal, cancellation, or resolved blocker. */
  "coordinator_no_progress",
  /** The node's `maxCoordinatorInvocations` logical turns are spent while unresolved Tasks remain or synthesis is still due. */
  "coordinator_invocations_exhausted",
] as const;
export type PlanNodeFailureReason = (typeof PLAN_NODE_FAILURE_REASONS)[number];

export const PLAN_EDGE_TYPES = ["sequence", "branch", "fan_in", "retry"] as const;
export type PlanEdgeType = (typeof PLAN_EDGE_TYPES)[number];

/** The roles a `single` node's one Invocation may hold. */
export const SINGLE_NODE_ROLES = ["orchestrator", "worker"] as const;
export type SingleNodeRole = (typeof SINGLE_NODE_ROLES)[number];

/** The role a compiled operation's Invocations hold; the role policy of the runtime is applied by role. */
export const OPERATION_ROLES = ["orchestrator", "worker", "coordinator", "evaluator"] as const;
export type OperationRole = (typeof OPERATION_ROLES)[number];

/** Roles whose Invocations are read-only whatever their definition declares (execution-model §6.4). */
export const READ_ONLY_OPERATION_ROLES: readonly OperationRole[] = ["evaluator"];

/** The root Orchestrator node is runtime-created, not compiled from the source form. */
export const ROOT_SOURCE_PATH = "root";
export const ROOT_NODE_TITLE = "Orchestrator";

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

/**
 * The hard bound on raw source object nesting, applied before any schema
 * parse so that a malformed or cyclic proposal is rejected structurally and
 * never by exhausting the interpreter stack.
 */
export const MAX_SOURCE_OBJECT_DEPTH = 64;

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

export const routeSelectorSchema: z.ZodType<RouteSelector> = z.discriminatedUnion("kind", [
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

export const coordinatorWorkerBoundsSchema: z.ZodType<CoordinatorWorkerBounds> = z.strictObject({
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

/**
 * A leaf operation is a `single` expression that carries no node-level
 * option other than a title. Such an expression is absorbed into its
 * enclosing Pattern node (a chain step, a parallel item, an inline route
 * branch, an inline producer). A `single` expression that declares its own
 * scope, allocation, limits, policies, or Gate criteria has node semantics
 * of its own and compiles to its own node.
 */
export function isLeafExpression(expression: PlanExpression): expression is PlanExpression & { pattern: "single" } {
  return (
    expression.pattern === "single" &&
    expression.scope === undefined &&
    expression.allocation === undefined &&
    expression.limits === undefined &&
    expression.onAllocationExhausted === undefined &&
    expression.runOnDependencyFailure === undefined &&
    expression.gateAcceptanceCriterionIds === undefined
  );
}

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
 * Walks a raw (unvalidated) source value iteratively and rejects an object
 * or array that is its own ancestor (a cyclic proposal) or that nests deeper
 * than `MAX_SOURCE_OBJECT_DEPTH`. This runs before schema parsing so that
 * cyclic input is detected structurally, never by a stack overflow.
 */
export function assertSourceObjectAcyclic(value: unknown, maxDepth: number = MAX_SOURCE_OBJECT_DEPTH): void {
  type Frame = { value: object; path: string; depth: number; ancestors: ReadonlySet<object> };
  if (value === null || typeof value !== "object") return;
  const stack: Frame[] = [{ value, path: "$", depth: 1, ancestors: new Set() }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.depth > maxDepth) {
      throw new ValidationError(`execution plan source nests deeper than ${maxDepth} objects at ${frame.path}`, {
        code: "excessive_source_depth",
        path: frame.path,
        maxDepth,
      });
    }
    if (frame.ancestors.has(frame.value)) {
      throw new ValidationError(`execution plan source references its own ancestor at ${frame.path}`, {
        code: "cyclic_source_object",
        path: frame.path,
      });
    }
    const ancestors = new Set(frame.ancestors);
    ancestors.add(frame.value);
    const entries: [string, unknown][] = Array.isArray(frame.value)
      ? frame.value.map((v, i) => [String(i), v] as [string, unknown])
      : Object.entries(frame.value as Record<string, unknown>);
    for (const [key, member] of entries) {
      if (member !== null && typeof member === "object") {
        stack.push({ value: member, path: `${frame.path}.${key}`, depth: frame.depth + 1, ancestors });
      }
    }
  }
}

/**
 * Validates a proposed source revision structurally: no cyclic object graph,
 * the closed Pattern set, well-formed operands, nesting depth, and
 * unrolled-round limits. Graph compilation (cycles, node counts, Requirement
 * existence, allocation reservation) is the compiler's job and is not
 * performed here.
 */
export function validateExecutionPlanSource(
  value: unknown,
  limits: PlanLimits = DEFAULT_PLAN_LIMITS,
): ExecutionPlanSource {
  assertSourceObjectAcyclic(value);
  const source = parseOrThrow(executionPlanSourceSchema, value, "execution plan source");
  source.expressions.forEach((expression, index) => {
    const depth = planExpressionDepth(expression);
    if (depth > limits.maxPlanDepth) {
      throw new ValidationError(
        `execution plan expression ${index} nests ${depth} levels; the limit is ${limits.maxPlanDepth}`,
        { code: "excessive_source_depth", index, depth, maxPlanDepth: limits.maxPlanDepth },
      );
    }
    const rounds: number[] = [];
    collectRounds(expression, rounds);
    for (const maxRounds of rounds) {
      if (maxRounds > limits.maxUnrolledRounds) {
        throw new ValidationError(
          `execution plan expression ${index} requests ${maxRounds} rounds; the limit is ${limits.maxUnrolledRounds}`,
          { code: "excessive_unrolled_rounds", index, maxRounds, maxUnrolledRounds: limits.maxUnrolledRounds },
        );
      }
    }
  });
  return source;
}

/**
 * One accepted, immutable source revision. Only accepted revisions are
 * persisted and numbered; a rejected proposal consumes no number.
 */
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
// Rejections
// ---------------------------------------------------------------------------

/** Stable, machine-readable reasons a proposed revision is rejected. */
export const PLAN_REJECTION_CODES = [
  "cyclic_source_object",
  "excessive_source_depth",
  "excessive_unrolled_rounds",
  "excessive_compiled_nodes",
  "compiled_graph_cycle",
  "unsupported_pattern",
  "explicit_join",
  "invalid_structure",
  "invalid_agent_definition_revision",
  "invalid_role_binding",
  "invalid_task_reference",
  "duplicate_task_assignment",
  "invalid_artifact_reference",
  "invalid_decision_reference",
  "invalid_acceptance_criterion_reference",
  "invalid_requirement_scope",
  "nested_coordinator_worker",
  "invalid_pattern_bounds",
  "insufficient_capacity",
  "started_node_changed",
] as const;
export type PlanRejectionCode = (typeof PLAN_REJECTION_CODES)[number];

export interface PlanRejectionReason {
  code: PlanRejectionCode;
  message: string;
  /** The source path of the offending expression or node, when one applies. */
  path: string | null;
}

export const planRejectionReasonSchema: z.ZodType<PlanRejectionReason> = z.strictObject({
  code: z.enum(PLAN_REJECTION_CODES),
  message: nonEmptyString,
  path: nonEmptyString.nullable(),
});

// ---------------------------------------------------------------------------
// Compiled form
// ---------------------------------------------------------------------------

/**
 * One resolved leaf operation bound inside a Pattern node. `role` and
 * `readOnly` make the effective role policy deterministic for later Context
 * Manifest construction: the manifest intersects the revision's Tool Policy
 * with the role policy (read-only roles deny every write-capable tool) and
 * the Workspace policy; the compiler records the role, never provider tool
 * semantics.
 */
export interface CompiledOperation {
  agentDefinitionRevisionId: AgentDefinitionRevisionId;
  title: string;
  input: ManifestTemplate;
  role: OperationRole;
  readOnly: boolean;
}

export const compiledOperationSchema: z.ZodType<CompiledOperation> = z
  .strictObject({
    agentDefinitionRevisionId: idSchema("agentDefinitionRevision"),
    title: nonEmptyString,
    input: manifestTemplateSchema,
    role: z.enum(OPERATION_ROLES),
    readOnly: z.boolean(),
  })
  .refine((o) => o.readOnly === READ_ONLY_OPERATION_ROLES.includes(o.role), {
    message: "readOnly follows the role policy: evaluators are read-only, every other role is not",
    path: ["readOnly"],
  });

/** A route branch: inline when it holds a leaf operation, otherwise reached by a `branch(label)` edge. */
export interface RouteBranchBinding {
  label: string;
  inline: CompiledOperation | null;
}

export const routeBranchBindingSchema: z.ZodType<RouteBranchBinding> = z.strictObject({
  label: nonEmptyString,
  inline: compiledOperationSchema.nullable(),
});

/**
 * The immutable, pattern-specific execution shape of a `pattern` node: which
 * Agent Definition revisions fill which positions, and the Pattern's bounds.
 * Every position an executor needs is explicit here; nothing is inferred
 * from the source expression at execution time.
 */
export type PatternShape =
  | { pattern: "single"; role: SingleNodeRole; operation: CompiledOperation }
  | { pattern: "chain"; steps: CompiledOperation[] }
  | { pattern: "route"; selector: RouteSelector; branches: RouteBranchBinding[] }
  | { pattern: "parallel"; items: CompiledOperation[]; aggregate: CompiledOperation | null; requireAll: boolean }
  | { pattern: "coordinator_worker"; coordinator: CompiledOperation; worker: CompiledOperation; bounds: CoordinatorWorkerBounds }
  | {
      pattern: "evaluator_optimizer";
      /** The inline producer; `null` for an evaluate-only node of an unrolled composite producer. */
      producer: CompiledOperation | null;
      evaluator: CompiledOperation;
      maxRounds: number;
      /** The unrolled round this evaluate-only node belongs to; `null` when the producer is inline. */
      round: number | null;
    };

/** The role each operation position holds; the shape's operations must record exactly these. */
function shapeOperationRolesAgree(shape: PatternShape): boolean {
  const is = (operation: CompiledOperation | null, role: OperationRole) => operation === null || operation.role === role;
  switch (shape.pattern) {
    case "single":
      return shape.operation.role === shape.role;
    case "chain":
      return shape.steps.every((s) => s.role === "worker");
    case "route":
      return shape.branches.every((b) => is(b.inline, "worker"));
    case "parallel":
      return shape.items.every((i) => i.role === "worker") && is(shape.aggregate, "worker");
    case "coordinator_worker":
      return shape.coordinator.role === "coordinator" && shape.worker.role === "worker";
    case "evaluator_optimizer":
      return is(shape.producer, "worker") && shape.evaluator.role === "evaluator";
  }
}

const sortedUniqueLabels = (branches: RouteBranchBinding[]): boolean => {
  for (let i = 0; i < branches.length; i += 1) {
    if (i > 0 && !(branches[i - 1]!.label < branches[i]!.label)) return false;
  }
  return true;
};

export const patternShapeSchema: z.ZodType<PatternShape> = z.discriminatedUnion("pattern", [
  z.strictObject({ pattern: z.literal("single"), role: z.enum(SINGLE_NODE_ROLES), operation: compiledOperationSchema }),
  z.strictObject({ pattern: z.literal("chain"), steps: z.array(compiledOperationSchema).min(2) }),
  z.strictObject({
    pattern: z.literal("route"),
    selector: routeSelectorSchema,
    branches: z.array(routeBranchBindingSchema).min(1).refine(sortedUniqueLabels, { message: "route branch labels are canonical: unique and sorted" }),
  }),
  z.strictObject({
    pattern: z.literal("parallel"),
    items: z.array(compiledOperationSchema).min(1),
    aggregate: compiledOperationSchema.nullable(),
    requireAll: z.boolean(),
  }),
  z.strictObject({
    pattern: z.literal("coordinator_worker"),
    coordinator: compiledOperationSchema,
    worker: compiledOperationSchema,
    bounds: coordinatorWorkerBoundsSchema,
  }),
  z
    .strictObject({
      pattern: z.literal("evaluator_optimizer"),
      producer: compiledOperationSchema.nullable(),
      evaluator: compiledOperationSchema,
      maxRounds: positiveCount,
      round: positiveCount.nullable(),
    })
    .refine((s) => (s.producer === null) === (s.round !== null), {
      message: "an evaluate-only node names its unrolled round; an inline producer has none",
      path: ["round"],
    })
    .refine((s) => s.round === null || s.round <= s.maxRounds, { message: "round exceeds maxRounds", path: ["round"] }),
]);

/** The exact Requirement scope of a pattern node: ordered leaf ids at one pinned revision. */
export interface PlanNodeScope {
  requirementRevisionId: RequirementRevisionId;
  requirementIds: RequirementId[];
}

export const planNodeScopeSchema: z.ZodType<PlanNodeScope> = z.strictObject({
  requirementRevisionId: idSchema("requirementRevision"),
  requirementIds: uniqueIds(idSchema("requirement")).min(1),
});

/**
 * The immutable execution semantics of a Plan Node: everything the compiler
 * decides and nothing the runtime changes afterwards. Two nodes with equal
 * definitions are interchangeable for reconciliation.
 */
interface PlanNodeDefinitionBase {
  title: string;
  /** Canonical position in the source form (see the source-path grammar). */
  sourcePath: string;
  allocation: Allocation;
  maxConcurrency: number | null;
  maxWallClockMs: number | null;
  runOnDependencyFailure: boolean;
}

export interface PatternPlanNodeDefinition extends PlanNodeDefinitionBase {
  kind: "pattern";
  pattern: Pattern;
  shape: PatternShape;
  /** The union of every operation input: the Artifact, Task, and Decision ids the node's Invocations may receive. */
  input: ManifestTemplate;
  onAllocationExhausted: OnAllocationExhausted;
  gateAcceptanceCriterionIds: AcceptanceCriterionId[];
  scope: PlanNodeScope | null;
}

export interface JoinPlanNodeDefinition extends PlanNodeDefinitionBase {
  kind: "join";
  fanInPolicy: FanInPolicy;
}

export type PlanNodeDefinition = PatternPlanNodeDefinition | JoinPlanNodeDefinition;

const planNodeDefinitionBaseShape = {
  title: nonEmptyString,
  sourcePath: nonEmptyString,
  allocation: allocationSchema,
  maxConcurrency: positiveCount.nullable(),
  maxWallClockMs: positiveCount.nullable(),
  runOnDependencyFailure: z.boolean(),
};

export const patternPlanNodeDefinitionSchema: z.ZodType<PatternPlanNodeDefinition> = z
  .strictObject({
    ...planNodeDefinitionBaseShape,
    kind: z.literal("pattern"),
    pattern: z.enum(PATTERNS),
    shape: patternShapeSchema,
    input: manifestTemplateSchema,
    onAllocationExhausted: z.enum(ON_ALLOCATION_EXHAUSTED_POLICIES),
    gateAcceptanceCriterionIds: uniqueIds(idSchema("acceptanceCriterion")),
    scope: planNodeScopeSchema.nullable(),
  })
  .refine((d) => d.shape.pattern === d.pattern, { message: "the node's Pattern and its shape agree", path: ["shape"] })
  .refine((d) => d.sourcePath !== ROOT_SOURCE_PATH || (d.shape.pattern === "single" && d.shape.role === "orchestrator" && d.scope === null), {
    message: "the root node is a single Orchestrator node without scope",
    path: ["sourcePath"],
  })
  .refine((d) => shapeOperationRolesAgree(d.shape), {
    message: "every operation's role matches its position in the Pattern",
    path: ["shape"],
  })
  .refine((d) => d.sourcePath === ROOT_SOURCE_PATH || d.shape.pattern !== "single" || d.shape.role === "worker", {
    message: "only the root node holds the orchestrator role",
    path: ["shape"],
  });

export const joinPlanNodeDefinitionSchema: z.ZodType<JoinPlanNodeDefinition> = z
  .strictObject({
    ...planNodeDefinitionBaseShape,
    kind: z.literal("join"),
    fanInPolicy: z.enum(FAN_IN_POLICIES),
  })
  .refine(
    (d) => d.allocation.costUsd === 0 && d.allocation.tokens === 0 && d.allocation.attempts === 0,
    { message: "a join node has zero allocation", path: ["allocation"] },
  );

export const planNodeDefinitionSchema: z.ZodType<PlanNodeDefinition> = z.discriminatedUnion("kind", [
  patternPlanNodeDefinitionSchema as never,
  joinPlanNodeDefinitionSchema as never,
]) as unknown as z.ZodType<PlanNodeDefinition>;

/** Byte-for-byte canonical form of a definition; equal definitions serialize identically. */
export function planNodeDefinitionDigest(definition: PlanNodeDefinition): string {
  return canonicalJson(definition);
}

export function planNodeDefinitionEquals(a: PlanNodeDefinition, b: PlanNodeDefinition): boolean {
  return planNodeDefinitionDigest(a) === planNodeDefinitionDigest(b);
}

/** The runtime-owned state of a Plan Node, layered over its immutable definition. */
interface PlanNodeState {
  id: PlanNodeId;
  runId: RunId;
  /** The accepted revision that created this node; membership in later revisions is recorded separately. */
  createdInRevisionNumber: number;
  status: PlanNodeStatus;
  waitReason: PlanNodeWaitReason | null;
  outputArtifactIds: ArtifactId[] | null;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  endedAt: Timestamp | null;
}

export type PatternPlanNode = PatternPlanNodeDefinition & PlanNodeState;
export type JoinPlanNode = JoinPlanNodeDefinition & PlanNodeState;
export type PlanNode = PatternPlanNode | JoinPlanNode;

const planNodeStateShape = {
  id: idSchema("planNode"),
  runId: idSchema("run"),
  createdInRevisionNumber: positiveCount,
  status: z.enum(PLAN_NODE_STATUSES),
  waitReason: z.enum(PLAN_NODE_WAIT_REASONS).nullable(),
  outputArtifactIds: uniqueIds(idSchema("artifact")).nullable(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
};

export const patternPlanNodeSchema: z.ZodType<PatternPlanNode> = z
  .strictObject({
    ...planNodeDefinitionBaseShape,
    ...planNodeStateShape,
    kind: z.literal("pattern"),
    pattern: z.enum(PATTERNS),
    shape: patternShapeSchema,
    input: manifestTemplateSchema,
    onAllocationExhausted: z.enum(ON_ALLOCATION_EXHAUSTED_POLICIES),
    gateAcceptanceCriterionIds: uniqueIds(idSchema("acceptanceCriterion")),
    scope: planNodeScopeSchema.nullable(),
  })
  .refine((n) => patternPlanNodeDefinitionSchema.safeParse(planNodeDefinitionOf(n as PlanNode)).success, {
    message: "the node's definition is well-formed",
    path: ["shape"],
  });

export const joinPlanNodeSchema: z.ZodType<JoinPlanNode> = z
  .strictObject({
    ...planNodeDefinitionBaseShape,
    ...planNodeStateShape,
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

/** Projects a persisted node onto its immutable definition. */
export function planNodeDefinitionOf(node: PlanNode): PlanNodeDefinition {
  const base = {
    title: node.title,
    sourcePath: node.sourcePath,
    allocation: node.allocation,
    maxConcurrency: node.maxConcurrency,
    maxWallClockMs: node.maxWallClockMs,
    runOnDependencyFailure: node.runOnDependencyFailure,
  };
  if (node.kind === "join") return { ...base, kind: "join", fanInPolicy: node.fanInPolicy };
  return {
    ...base,
    kind: "pattern",
    pattern: node.pattern,
    shape: node.shape,
    input: node.input,
    onAllocationExhausted: node.onAllocationExhausted,
    gateAcceptanceCriterionIds: node.gateAcceptanceCriterionIds,
    scope: node.scope,
  };
}

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

/** True for a node that has never started executing (reconciliation may cancel and replace it). */
export function planNodeIsUnstarted(status: PlanNodeStatus): boolean {
  return status === "pending" || status === "ready";
}

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

// ---------------------------------------------------------------------------
// Edges: revision-owned, append-only
// ---------------------------------------------------------------------------

interface PlanEdgeBase {
  id: PlanEdgeId;
  runId: RunId;
  /** The accepted revision this edge belongs to; edges are never shared between revisions. */
  revisionNumber: number;
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
  revisionNumber: positiveCount,
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

// ---------------------------------------------------------------------------
// Revision membership
// ---------------------------------------------------------------------------

/**
 * One row of an accepted revision's immutable, ordered membership list. The
 * current executable graph is exactly the member nodes of the Run's latest
 * accepted revision plus that revision's edges; nothing is inferred from
 * timestamps, node revision numbers, incident edges, or status.
 */
export interface PlanRevisionNode {
  runId: RunId;
  revisionNumber: number;
  planNodeId: PlanNodeId;
  position: number;
}

export const planRevisionNodeSchema: z.ZodType<PlanRevisionNode> = z.strictObject({
  runId: idSchema("run"),
  revisionNumber: positiveCount,
  planNodeId: idSchema("planNode"),
  position: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// Requirement scope rows
// ---------------------------------------------------------------------------

/** One row of a pattern node's exact Requirement scope at a pinned revision. */
export interface PlanNodeRequirement {
  planNodeId: PlanNodeId;
  runId: RunId;
  requirementId: RequirementId;
  requirementRevisionId: RequirementRevisionId;
  /** Deterministic order of the leaf within the node's scope. */
  position: number;
}

export const planNodeRequirementSchema: z.ZodType<PlanNodeRequirement> = z.strictObject({
  planNodeId: idSchema("planNode"),
  runId: idSchema("run"),
  requirementId: idSchema("requirement"),
  requirementRevisionId: idSchema("requirementRevision"),
  position: z.number().int().min(0),
});

/** The scope rows a node's definition materializes to, in scope order. */
export function planNodeRequirementRows(node: Pick<PlanNode, "id" | "runId"> & { scope: PlanNodeScope | null }): PlanNodeRequirement[] {
  if (node.scope === null) return [];
  const { requirementRevisionId } = node.scope;
  return node.scope.requirementIds.map((requirementId, position) => ({
    planNodeId: node.id,
    runId: node.runId,
    requirementId,
    requirementRevisionId,
    position,
  }));
}

/** A complete executable or historical graph of one accepted revision. */
export interface PlanGraph {
  runId: RunId;
  revisionNumber: number;
  /** Member nodes in membership order; the root is always first. */
  nodes: PlanNode[];
  edges: PlanEdge[];
}
