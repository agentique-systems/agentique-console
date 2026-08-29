import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.ts";
import { newId } from "./ids.ts";
import {
  DEFAULT_PLAN_LIMITS,
  FAN_IN_POLICIES,
  PATTERNS,
  PLAN_EDGE_TYPES,
  PLAN_NODE_KINDS,
  PLAN_NODE_STATUSES,
  planEdgeSchema,
  planExpressionDepth,
  planNodeSchema,
  validateExecutionPlanSource,
  type PlanExpression,
} from "./plans.ts";

const agdr = newId("agentDefinitionRevision");
const op = { agentDefinitionRevisionId: agdr };
const single = (): PlanExpression => ({ pattern: "single", operation: op });

describe("closed value sets", () => {
  it("has exactly the six Patterns, two node kinds, two join policies, four edge types", () => {
    expect(PATTERNS).toEqual(["single", "chain", "route", "parallel", "coordinator_worker", "evaluator_optimizer"]);
    expect(PLAN_NODE_KINDS).toEqual(["pattern", "join"]);
    expect(FAN_IN_POLICIES).toEqual(["require_all", "require_any"]);
    expect(PLAN_EDGE_TYPES).toEqual(["sequence", "branch", "fan_in", "retry"]);
    expect(PLAN_NODE_STATUSES).toEqual(["pending", "ready", "running", "waiting", "succeeded", "failed", "cancelled", "skipped"]);
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
});

describe("compiled node schema", () => {
  const base = {
    id: newId("planNode"),
    runId: newId("run"),
    revisionNumber: 1,
    title: "n",
    sourcePath: "0",
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
  const pattern = { ...base, kind: "pattern", pattern: "single", input: { taskIds: [], decisionIds: [], artifactIds: [] }, agents: { worker: agdr }, bounds: {}, onAllocationExhausted: "fail", gateAcceptanceCriterionIds: [] };
  const join = { ...base, kind: "join", fanInPolicy: "require_all", allocation: { costUsd: 0, tokens: 0, attempts: 0 } };

  it("accepts a valid pattern node and a valid join node", () => {
    expect(planNodeSchema.safeParse(pattern).success).toBe(true);
    expect(planNodeSchema.safeParse(join).success).toBe(true);
  });

  it("rejects a join with a Pattern, agents, scope-bearing fields, or allocation", () => {
    expect(planNodeSchema.safeParse({ ...join, pattern: "single" }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...join, agents: { worker: agdr } }).success).toBe(false);
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
    expect(planNodeSchema.safeParse({ ...pattern, agents: {} }).success).toBe(false);
  });

  it("ties waitReason to the waiting status", () => {
    expect(planNodeSchema.safeParse({ ...pattern, status: "waiting" }).success).toBe(false);
    expect(planNodeSchema.safeParse({ ...pattern, status: "waiting", waitReason: "budget" }).success).toBe(true);
    expect(planNodeSchema.safeParse({ ...pattern, waitReason: "budget" }).success).toBe(false);
  });
});

describe("plan edge schema", () => {
  const base = { id: newId("planEdge"), runId: newId("run"), sourceNodeId: newId("planNode"), targetNodeId: newId("planNode"), position: 0, createdAt: "2026-01-01T00:00:00.000Z" };

  it("requires typed metadata per edge type", () => {
    expect(planEdgeSchema.safeParse({ ...base, type: "sequence" }).success).toBe(true);
    expect(planEdgeSchema.safeParse({ ...base, type: "fan_in" }).success).toBe(true);
    expect(planEdgeSchema.safeParse({ ...base, type: "branch", label: "x" }).success).toBe(true);
    expect(planEdgeSchema.safeParse({ ...base, type: "branch" }).success).toBe(false);
    expect(planEdgeSchema.safeParse({ ...base, type: "retry", round: 2 }).success).toBe(true);
    expect(planEdgeSchema.safeParse({ ...base, type: "retry", round: 1 }).success).toBe(false);
    expect(planEdgeSchema.safeParse({ ...base, type: "sequence", label: "x" }).success).toBe(false);
    expect(planEdgeSchema.safeParse({ ...base, type: "delegation" }).success).toBe(false);
  });

  it("rejects a self loop", () => {
    expect(planEdgeSchema.safeParse({ ...base, type: "sequence", targetNodeId: base.sourceNodeId }).success).toBe(false);
  });
});
