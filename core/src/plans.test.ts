import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.ts";
import { newId } from "./ids.ts";
import {
  assertSourceObjectAcyclic,
  DEFAULT_PLAN_LIMITS,
  FAN_IN_POLICIES,
  isLeafExpression,
  PATTERNS,
  PLAN_EDGE_TYPES,
  PLAN_NODE_KINDS,
  PLAN_NODE_STATUSES,
  PLAN_REJECTION_CODES,
  planEdgeSchema,
  planExpressionDepth,
  planNodeDefinitionEquals,
  planNodeDefinitionOf,
  planNodeRequirementRows,
  planNodeSchema,
  planRevisionNodeSchema,
  ROOT_SOURCE_PATH,
  validateExecutionPlanSource,
  type PlanExpression,
  type PlanNode,
} from "./plans.ts";

const agdr = newId("agentDefinitionRevision");
const op = { agentDefinitionRevisionId: agdr };
const single = (): PlanExpression => ({ pattern: "single", operation: op });

describe("closed value sets", () => {
  it("has exactly the six Patterns, two node kinds, two join policies, four edge types (invariant 4)", () => {
    expect(PATTERNS).toEqual(["single", "chain", "route", "parallel", "coordinator_worker", "evaluator_optimizer"]);
    expect(PLAN_NODE_KINDS).toEqual(["pattern", "join"]);
    expect(FAN_IN_POLICIES).toEqual(["require_all", "require_any"]);
    expect(PLAN_EDGE_TYPES).toEqual(["sequence", "branch", "fan_in", "retry"]);
    expect(PLAN_NODE_STATUSES).toEqual(["pending", "ready", "running", "waiting", "succeeded", "failed", "cancelled", "skipped"]);
    expect(PLAN_REJECTION_CODES).toContain("explicit_join");
    expect(new Set(PLAN_REJECTION_CODES).size).toBe(PLAN_REJECTION_CODES.length);
  });
});

describe("execution plan source validation", () => {
  it("accepts every Pattern and nested composition", () => {
    const source = validateExecutionPlanSource({
      version: 1,
      expressions: [
        single(),
        { pattern: "chain", steps: [single(), single()] },
        {
          pattern: "route",
          selector: { kind: "evaluator", agentDefinitionRevisionId: agdr },
          branches: { fast: single(), slow: { pattern: "chain", steps: [single(), single()] } },
        },
        { pattern: "parallel", items: [single(), { pattern: "chain", steps: [single()] }], aggregate: op },
        { pattern: "coordinator_worker", coordinator: op, worker: op, bounds: { maxTasks: 5, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 } },
        { pattern: "evaluator_optimizer", producer: { pattern: "chain", steps: [single(), single()] }, evaluator: op, maxRounds: 3 },
      ],
    });
    expect(source.expressions).toHaveLength(6);
  });

  it("rejects unknown Pattern names, including an explicit join", () => {
    // Retired Pattern names are rejected outright.
    for (const pattern of ["join", "pipeline", "map_reduce", "hub_and_spoke", "debate", "single "]) { // rejected legacy names
      expect(() => validateExecutionPlanSource({ version: 1, expressions: [{ pattern, operation: op }] }), pattern).toThrow(ValidationError);
    }
  });

  it("rejects malformed expressions", () => {
    expect(() => validateExecutionPlanSource({ version: 1, expressions: [{ pattern: "parallel", items: [] }] })).toThrow(ValidationError);
    expect(() => validateExecutionPlanSource({ version: 1, expressions: [{ pattern: "chain", steps: [] }] })).toThrow(ValidationError);
    expect(() => validateExecutionPlanSource({ version: 1, expressions: [{ pattern: "route", selector: { kind: "evaluator", agentDefinitionRevisionId: agdr }, branches: {} }] })).toThrow(ValidationError);
    expect(() => validateExecutionPlanSource({ version: 1, expressions: [{ pattern: "single", operation: { agentDefinitionRevisionId: "nope" } }] })).toThrow(ValidationError);
    expect(() => validateExecutionPlanSource({ version: 1, expressions: [{ pattern: "single", operation: op, extra: true }] })).toThrow(ValidationError);
    expect(() => validateExecutionPlanSource({ version: 2, expressions: [] })).toThrow(ValidationError);
    expect(() => validateExecutionPlanSource(null)).toThrow(ValidationError);
  });

  it("detects a cyclic source object structurally, without a stack overflow", () => {
    const cyclic: Record<string, unknown> = { version: 1, expressions: [] };
    const chain: Record<string, unknown> = { pattern: "chain", steps: [] };
    (chain.steps as unknown[]).push(chain);
    (cyclic.expressions as unknown[]).push(chain);
    expect(() => assertSourceObjectAcyclic(cyclic)).toThrow(/references its own ancestor/);
    expect(() => validateExecutionPlanSource(cyclic)).toThrow(ValidationError);
    // A shared (non-ancestral) sibling object is not a cycle.
    const shared = single();
    expect(() => assertSourceObjectAcyclic({ version: 1, expressions: [shared, shared] })).not.toThrow();
    // Depth is bounded before any recursion.
    let deep: unknown = { pattern: "single", operation: op };
    for (let i = 0; i < 80; i += 1) deep = { pattern: "chain", steps: [deep] };
    expect(() => validateExecutionPlanSource({ version: 1, expressions: [deep] })).toThrow(/nests deeper than/);
  });

  it("coordinator_worker operands are leaves by construction", () => {
    expect(() =>
      validateExecutionPlanSource({ version: 1, expressions: [{ pattern: "coordinator_worker", coordinator: op, worker: { pattern: "single", operation: op } }] }),
    ).toThrow(ValidationError);
    expect(() =>
      validateExecutionPlanSource({ version: 1, expressions: [{ pattern: "coordinator_worker", coordinator: { pattern: "coordinator_worker", coordinator: op, worker: op }, worker: op }] }),
    ).toThrow(ValidationError);
  });

  it("enforces nesting depth and unrolled round limits", () => {
    const deep: PlanExpression = { pattern: "chain", steps: [{ pattern: "chain", steps: [{ pattern: "chain", steps: [{ pattern: "chain", steps: [single()] }] }] }] };
    expect(planExpressionDepth(deep)).toBe(5);
    expect(() => validateExecutionPlanSource({ version: 1, expressions: [deep] })).toThrow(/nests 5 levels/);
    expect(validateExecutionPlanSource({ version: 1, expressions: [deep] }, { ...DEFAULT_PLAN_LIMITS, maxPlanDepth: 5 })).toBeTruthy();
    expect(() =>
      validateExecutionPlanSource({ version: 1, expressions: [{ pattern: "evaluator_optimizer", producer: single(), evaluator: op, maxRounds: 7 }] }),
    ).toThrow(/7 rounds/);
  });

  it("requires a pinned revision with Requirement roots and bounded allocations", () => {
    const scope = { requirementRootIds: [newId("requirement")], requirementRevisionId: newId("requirementRevision") };
    expect(validateExecutionPlanSource({ version: 1, expressions: [{ ...single(), scope, allocation: { costUsd: 1, tokens: 10, attempts: 2 } }] })).toBeTruthy();
    expect(() => validateExecutionPlanSource({ version: 1, expressions: [{ ...single(), scope: { requirementRootIds: [] , requirementRevisionId: scope.requirementRevisionId } }] })).toThrow(ValidationError);
    expect(() => validateExecutionPlanSource({ version: 1, expressions: [{ ...single(), scope: { requirementRootIds: scope.requirementRootIds } }] })).toThrow(ValidationError);
    expect(() => validateExecutionPlanSource({ version: 1, expressions: [{ ...single(), allocation: { costUsd: -1, tokens: 0, attempts: 0 } }] })).toThrow(ValidationError);
  });

  it("a leaf is a single expression with no node-level option other than a title", () => {
    expect(isLeafExpression(single())).toBe(true);
    expect(isLeafExpression({ ...single(), title: "t" })).toBe(true);
    expect(isLeafExpression({ ...single(), allocation: { costUsd: 1, tokens: 1, attempts: 1 } })).toBe(false);
    expect(isLeafExpression({ ...single(), scope: { requirementRootIds: [newId("requirement")], requirementRevisionId: newId("requirementRevision") } })).toBe(false);
    expect(isLeafExpression({ pattern: "chain", steps: [single()] })).toBe(false);
  });
});

describe("compiled node schema", () => {
  const operation = { agentDefinitionRevisionId: agdr, title: "step", input: { taskIds: [], decisionIds: [], artifactIds: [] }, role: "worker", readOnly: false };
  const coordinator = { ...operation, role: "coordinator" };
  const evaluator = { ...operation, role: "evaluator", readOnly: true };
  const orchestratorOperation = { ...operation, role: "orchestrator" };
  const base = {
    id: newId("planNode"),
    runId: newId("run"),
    createdInRevisionNumber: 1,
    title: "n",
    sourcePath: "e0",
    status: "pending",
    waitReason: null,
    allocation: { costUsd: 1, tokens: 10, attempts: 2 },
    maxConcurrency: null,
    maxWallClockMs: null,
    runOnDependencyFailure: false,
    outputArtifactIds: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
  };
  const pattern = {
    ...base,
    kind: "pattern",
    pattern: "single",
    shape: { pattern: "single", role: "worker", operation },
    input: { taskIds: [], decisionIds: [], artifactIds: [] },
    onAllocationExhausted: "fail",
    gateAcceptanceCriterionIds: [],
    scope: null,
  };
  const join = { ...base, kind: "join", fanInPolicy: "require_all", allocation: { costUsd: 0, tokens: 0, attempts: 0 } };

  it("accepts a valid pattern node and a valid join node", () => {
    expect(planNodeSchema.safeParse(pattern).success).toBe(true);
    expect(planNodeSchema.safeParse(join).success).toBe(true);
  });

  it("accepts every Pattern shape and rejects a shape that disagrees with the Pattern (invariant 3)", () => {
    const shapes = [
      { pattern: "chain", steps: [operation, operation] },
      { pattern: "route", selector: { kind: "evaluator", agentDefinitionRevisionId: agdr }, branches: [{ label: "a", inline: operation }, { label: "b", inline: null }] },
      { pattern: "parallel", items: [operation], aggregate: null, requireAll: true },
      { pattern: "coordinator_worker", coordinator, worker: operation, bounds: { maxTasks: 4, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 3 } },
      { pattern: "evaluator_optimizer", producer: operation, evaluator, maxRounds: 3, round: null },
      { pattern: "evaluator_optimizer", producer: null, evaluator, maxRounds: 3, round: 2 },
    ] as const;
    for (const shape of shapes) {
      expect(planNodeSchema.safeParse({ ...pattern, pattern: shape.pattern, shape }).success, shape.pattern).toBe(true);
    }
    expect(planNodeSchema.safeParse({ ...pattern, pattern: "chain" }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, pattern: "chain", shape: { pattern: "chain", steps: [operation] } }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, pattern: "route", shape: { pattern: "route", selector: { kind: "evaluator", agentDefinitionRevisionId: agdr }, branches: [{ label: "b", inline: null }, { label: "a", inline: null }] } }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, pattern: "parallel", shape: { pattern: "parallel", items: [], aggregate: null, requireAll: true } }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, pattern: "evaluator_optimizer", shape: { pattern: "evaluator_optimizer", producer: null, evaluator, maxRounds: 3, round: null } }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, pattern: "evaluator_optimizer", shape: { pattern: "evaluator_optimizer", producer: null, evaluator, maxRounds: 3, round: 4 } }).success).toBe(false);
    // Every operation records the role of its position, and readOnly follows the role policy.
    expect(planNodeSchema.safeParse({ ...pattern, pattern: "coordinator_worker", shape: { pattern: "coordinator_worker", coordinator: operation, worker: operation, bounds: { maxTasks: 4, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 3 } } }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, pattern: "evaluator_optimizer", shape: { pattern: "evaluator_optimizer", producer: operation, evaluator: operation, maxRounds: 3, round: null } }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, pattern: "evaluator_optimizer", shape: { pattern: "evaluator_optimizer", producer: operation, evaluator: { ...evaluator, readOnly: false }, maxRounds: 3, round: null } }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, shape: { pattern: "single", role: "worker", operation: { ...operation, readOnly: true } } }).success).toBe(false);
  });

  it("only the root node holds the orchestrator role, with no scope", () => {
    const orchestrator = { pattern: "single", role: "orchestrator", operation: orchestratorOperation };
    expect(planNodeSchema.safeParse({ ...pattern, shape: orchestrator }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, sourcePath: ROOT_SOURCE_PATH, shape: orchestrator }).success).toBe(true);
    expect(planNodeSchema.safeParse({ ...pattern, sourcePath: ROOT_SOURCE_PATH }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, sourcePath: ROOT_SOURCE_PATH, shape: orchestrator, scope: { requirementRevisionId: newId("requirementRevision"), requirementIds: [newId("requirement")] } }).success).toBe(false);
  });

  it("rejects a join with a Pattern, shape, scope-bearing fields, or allocation", () => {
    expect(planNodeSchema.safeParse({ ...join, pattern: "single" }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...join, shape: pattern.shape }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...join, allocation: { costUsd: 1, tokens: 0, attempts: 0 } }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...join, fanInPolicy: "best_effort" }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...join, fanInPolicy: "threshold" }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...join, status: "waiting", waitReason: "decision" }).success).toBe(false);
  });

  it("rejects a pattern node without a valid Pattern or with join fields", () => {
    const { pattern: _omit, ...withoutPattern } = pattern;
    expect(planNodeSchema.safeParse(withoutPattern).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, pattern: "join" }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, pattern: "pipeline" }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, fanInPolicy: "require_all" }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, shape: {} }).success).toBe(false);
  });

  it("ties waitReason to the waiting status", () => {
    expect(planNodeSchema.safeParse({ ...pattern, status: "waiting" }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, status: "waiting", waitReason: "budget" }).success).toBe(true);
    expect(planNodeSchema.safeParse({ ...pattern, waitReason: "budget" }).success).toBe(false);
  });

  it("projects a node onto its immutable definition and compares definitions canonically", () => {
    const node = planNodeSchema.parse(pattern) as PlanNode;
    const definition = planNodeDefinitionOf(node);
    expect(definition).not.toHaveProperty("status");
    expect(definition).not.toHaveProperty("id");
    expect(planNodeDefinitionEquals(definition, planNodeDefinitionOf({ ...node, status: "running", id: newId("planNode") }))).toBe(true);
    expect(planNodeDefinitionEquals(definition, planNodeDefinitionOf({ ...node, title: "other" }))).toBe(false);
    const revisionId = newId("requirementRevision");
    const leaves = [newId("requirement"), newId("requirement")];
    expect(planNodeRequirementRows({ id: node.id, runId: node.runId, scope: { requirementRevisionId: revisionId, requirementIds: leaves } })).toEqual([
      { planNodeId: node.id, runId: node.runId, requirementId: leaves[0], requirementRevisionId: revisionId, position: 0 },
      { planNodeId: node.id, runId: node.runId, requirementId: leaves[1], requirementRevisionId: revisionId, position: 1 },
    ]);
    expect(planNodeRequirementRows({ id: node.id, runId: node.runId, scope: null })).toEqual([]);
  });
});

describe("plan edge and membership schemas", () => {
  const base = { id: newId("planEdge"), runId: newId("run"), revisionNumber: 1, sourceNodeId: newId("planNode"), targetNodeId: newId("planNode"), position: 0, createdAt: "2026-01-01T00:00:00.000Z" };

  it("requires typed metadata per edge type and an owning revision", () => {
    expect(planEdgeSchema.safeParse({ ...base, type: "sequence" }).success).toBe(true);
    expect(planEdgeSchema.safeParse({ ...base, type: "fan_in" }).success).toBe(true);
    expect(planEdgeSchema.safeParse({ ...base, type: "branch", label: "x" }).success).toBe(true);
    expect(planEdgeSchema.safeParse({ ...base, type: "branch" }).success).toBe(false);
    expect(planEdgeSchema.safeParse({ ...base, type: "retry", round: 2 }).success).toBe(true);
    expect(planEdgeSchema.safeParse({ ...base, type: "retry", round: 1 }).success).toBe(false);
    expect(planEdgeSchema.safeParse({ ...base, type: "sequence", label: "x" }).success).toBe(false);
    expect(planEdgeSchema.safeParse({ ...base, type: "delegation" }).success).toBe(false);
    const { revisionNumber: _omit, ...unowned } = base;
    expect(planEdgeSchema.safeParse({ ...unowned, type: "sequence" }).success).toBe(false);
  });

  it("rejects a self loop", () => {
    expect(planEdgeSchema.safeParse({ ...base, type: "sequence", targetNodeId: base.sourceNodeId }).success).toBe(false);
  });

  it("membership rows name a Run, a revision, a node, and a position", () => {
    expect(planRevisionNodeSchema.safeParse({ runId: base.runId, revisionNumber: 2, planNodeId: base.sourceNodeId, position: 0 }).success).toBe(true);
    expect(planRevisionNodeSchema.safeParse({ runId: base.runId, revisionNumber: 0, planNodeId: base.sourceNodeId, position: 0 }).success).toBe(false);
    expect(planRevisionNodeSchema.safeParse({ runId: base.runId, revisionNumber: 1, planNodeId: base.sourceNodeId, position: -1 }).success).toBe(false);
  });
});
