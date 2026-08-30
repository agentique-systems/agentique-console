/**
 * Canonical Pattern positions (execution-model §5, §6.2): a closed typed
 * union owned by the Pattern runtime, resolved against the immutable node
 * shape, never inferred from creation order or a rendered string.
 */
import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import {
  operationAt,
  PATTERN_POSITION_BINDINGS,
  PATTERN_POSITION_KINDS,
  patternPositionDefects,
  patternPositionKey,
  patternPositionSchema,
  positionsOf,
  renderPatternPosition,
  type PatternPosition,
} from "./pattern-positions.ts";
import { ROOT_SOURCE_PATH, type CompiledOperation, type PatternShape } from "./plans.ts";

const agent = newId("agentDefinitionRevision");
const other = newId("agentDefinitionRevision");
const taskId = newId("task");
const op = (id = agent, role: CompiledOperation["role"] = "worker", title = "op"): CompiledOperation => ({ agentDefinitionRevisionId: id, title, input: { taskIds: [], decisionIds: [], artifactIds: [] }, role, readOnly: role === "evaluator" });

const shapes: Record<string, PatternShape> = {
  root: { pattern: "single", role: "orchestrator", operation: op(agent, "orchestrator") },
  single: { pattern: "single", role: "worker", operation: op() },
  chain: { pattern: "chain", steps: [op(agent, "worker", "a"), op(other, "worker", "b"), op(agent, "worker", "c")] },
  route: { pattern: "route", selector: { kind: "evaluator", agentDefinitionRevisionId: other }, branches: [{ label: "x", inline: op() }, { label: "y", inline: null }] },
  parallel: { pattern: "parallel", items: [op(), op(other)], aggregate: op(agent, "worker", "agg"), requireAll: true },
  coordinatorWorker: { pattern: "coordinator_worker", coordinator: op(other, "coordinator"), worker: op(), bounds: { maxTasks: 4, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 3 } },
  evaluatorOptimizer: { pattern: "evaluator_optimizer", producer: op(), evaluator: op(other, "evaluator"), maxRounds: 3, round: null },
  evaluateOnly: { pattern: "evaluator_optimizer", producer: null, evaluator: op(other, "evaluator"), maxRounds: 3, round: 2 },
};

describe("pattern positions", () => {
  it("is a closed union with a stable key and a concise rendering per kind", () => {
    const positions: PatternPosition[] = [
      { kind: "orchestrator" },
      { kind: "single" },
      { kind: "chain_step", index: 1, count: 3 },
      { kind: "route_selection" },
      { kind: "route_branch", label: "x" },
      { kind: "parallel_item", index: 0, count: 2 },
      { kind: "parallel_aggregation" },
      { kind: "coordinator_turn" },
      { kind: "worker_task", taskId },
      { kind: "producer_round", round: 2, maxRounds: 3 },
      { kind: "evaluator_round", round: 2, maxRounds: 3 },
    ];
    expect(positions.map((p) => p.kind)).toEqual([...PATTERN_POSITION_KINDS]);
    expect(positions.map(patternPositionKey)).toEqual(["orchestrator", "single", "chain_step:1", "route_selection", "route_branch:x", "parallel_item:0", "parallel_aggregation", "coordinator_turn", `worker_task:${taskId}`, "producer_round:2", "evaluator_round:2"]);
    expect(positions.map(renderPatternPosition)).toEqual(["orchestrator", "single", "chain step 2 of 3", "route selection", "route branch x", "parallel item 1 of 2", "parallel aggregation", "coordinator turn", `worker task ${taskId}`, "producer round 2 of 3", "evaluator round 2 of 3"]);
    for (const position of positions) expect(patternPositionSchema.safeParse(position).success, position.kind).toBe(true);
    // Bounds and unknown kinds are rejected at the schema.
    expect(patternPositionSchema.safeParse({ kind: "chain_step", index: 3, count: 3 }).success).toBe(false);
    expect(patternPositionSchema.safeParse({ kind: "parallel_item", index: -1, count: 2 }).success).toBe(false);
    expect(patternPositionSchema.safeParse({ kind: "producer_round", round: 4, maxRounds: 3 }).success).toBe(false);
    expect(patternPositionSchema.safeParse({ kind: "chain step 2 of 3" }).success).toBe(false);
    expect(patternPositionSchema.safeParse({ kind: "single", index: 0 }).success).toBe(false);
    // Every kind binds a role; the worker and evaluator kinds fix the purpose too.
    for (const kind of PATTERN_POSITION_KINDS) expect(PATTERN_POSITION_BINDINGS[kind].role).toBeDefined();
    expect(PATTERN_POSITION_BINDINGS.chain_step).toEqual({ role: "worker", purpose: "step" });
    expect(PATTERN_POSITION_BINDINGS.orchestrator).toEqual({ role: "orchestrator", purpose: null });
  });

  it("resolves the operation at a position from the shape alone, and nothing outside the shape", () => {
    expect(operationAt(shapes.root!, { kind: "orchestrator" })).toEqual(shapes.root!.pattern === "single" ? shapes.root!.operation : null);
    expect(operationAt(shapes.root!, { kind: "single" })).toBeNull();
    expect(operationAt(shapes.single!, { kind: "single" })?.title).toBe("op");
    expect(operationAt(shapes.single!, { kind: "orchestrator" })).toBeNull();
    expect(operationAt(shapes.chain!, { kind: "chain_step", index: 1, count: 3 })?.title).toBe("b");
    expect(operationAt(shapes.chain!, { kind: "chain_step", index: 1, count: 2 })).toBeNull();
    expect(operationAt(shapes.chain!, { kind: "single" })).toBeNull();
    expect(operationAt(shapes.route!, { kind: "route_selection" })).toMatchObject({ agentDefinitionRevisionId: other, role: "evaluator", readOnly: true });
    expect(operationAt(shapes.route!, { kind: "route_branch", label: "x" })?.title).toBe("op");
    expect(operationAt(shapes.route!, { kind: "route_branch", label: "y" })).toBeNull();
    expect(operationAt(shapes.route!, { kind: "route_branch", label: "z" })).toBeNull();
    expect(operationAt(shapes.parallel!, { kind: "parallel_item", index: 1, count: 2 })?.agentDefinitionRevisionId).toBe(other);
    expect(operationAt(shapes.parallel!, { kind: "parallel_aggregation" })?.title).toBe("agg");
    expect(operationAt(shapes.coordinatorWorker!, { kind: "coordinator_turn" })?.role).toBe("coordinator");
    expect(operationAt(shapes.coordinatorWorker!, { kind: "worker_task", taskId })?.role).toBe("worker");
    expect(operationAt(shapes.evaluatorOptimizer!, { kind: "producer_round", round: 2, maxRounds: 3 })?.role).toBe("worker");
    expect(operationAt(shapes.evaluatorOptimizer!, { kind: "evaluator_round", round: 2, maxRounds: 3 })?.role).toBe("evaluator");
    expect(operationAt(shapes.evaluateOnly!, { kind: "producer_round", round: 2, maxRounds: 3 })).toBeNull();
    expect(operationAt(shapes.evaluateOnly!, { kind: "evaluator_round", round: 2, maxRounds: 3 })?.role).toBe("evaluator");
    expect(operationAt(shapes.evaluateOnly!, { kind: "evaluator_round", round: 1, maxRounds: 3 })).toBeNull();
    // The fixed sequences of the Phase 2C Patterns; every other Pattern's order is decided by its runner.
    expect(positionsOf(shapes.single!)).toEqual([{ kind: "single" }]);
    expect(positionsOf(shapes.root!)).toEqual([{ kind: "orchestrator" }]);
    expect(positionsOf(shapes.chain!)).toEqual([0, 1, 2].map((index) => ({ kind: "chain_step", index, count: 3 })));
    expect(positionsOf(shapes.parallel!)).toBeNull();
  });

  it("reports every disagreement between a position, its node, and the Invocation's role, purpose, and revision", () => {
    const worker = { role: "worker" as const, purpose: "step" as const, agentDefinitionRevisionId: agent };
    expect(patternPositionDefects({ sourcePath: "e0", shape: shapes.single! }, { kind: "single" }, worker)).toEqual([]);
    expect(patternPositionDefects({ sourcePath: ROOT_SOURCE_PATH, shape: shapes.root! }, { kind: "orchestrator" }, { role: "orchestrator", purpose: "node_result", agentDefinitionRevisionId: agent })).toEqual([]);
    // The root holds only the orchestrator position and no other node holds it.
    expect(patternPositionDefects({ sourcePath: "e0", shape: shapes.single! }, { kind: "orchestrator" }, { ...worker, role: "orchestrator" })).toContain("only the root node holds the orchestrator position");
    expect(patternPositionDefects({ sourcePath: ROOT_SOURCE_PATH, shape: shapes.root! }, { kind: "single" }, worker)).toContain("the root node holds only the orchestrator position");
    // A chain index within bounds of this shape's steps; the count must be the shape's.
    expect(patternPositionDefects({ sourcePath: "e0", shape: shapes.chain! }, { kind: "chain_step", index: 1, count: 3 }, { ...worker, agentDefinitionRevisionId: other })).toEqual([]);
    expect(patternPositionDefects({ sourcePath: "e0", shape: shapes.chain! }, { kind: "chain_step", index: 3, count: 3 }, worker)).toEqual([expect.stringContaining("within bounds")]);
    expect(patternPositionDefects({ sourcePath: "e0", shape: shapes.chain! }, { kind: "chain_step", index: 0, count: 2 }, worker)).toEqual(["the chain shape has no chain step 1 of 2 position"]);
    // Role, purpose, and revision agree with the operation at the position.
    expect(patternPositionDefects({ sourcePath: "e0", shape: shapes.chain! }, { kind: "chain_step", index: 1, count: 3 }, worker)).toEqual([expect.stringContaining(`runs Agent Definition revision ${other}`)]);
    expect(patternPositionDefects({ sourcePath: "e0", shape: shapes.single! }, { kind: "single" }, { ...worker, purpose: "task" })).toEqual([expect.stringContaining("purpose step")]);
    expect(patternPositionDefects({ sourcePath: "e0", shape: shapes.single! }, { kind: "single" }, { ...worker, role: "evaluator", purpose: "evaluate" })).toEqual([expect.stringContaining("holds the worker role"), expect.stringContaining("purpose step")]);
    expect(patternPositionDefects({ sourcePath: "e0", shape: shapes.coordinatorWorker! }, { kind: "worker_task", taskId }, { ...worker, purpose: "task" })).toEqual([]);
    expect(patternPositionDefects({ sourcePath: "e0", shape: shapes.coordinatorWorker! }, { kind: "coordinator_turn" }, { role: "coordinator", purpose: "replan", agentDefinitionRevisionId: other })).toEqual([]);
    expect(patternPositionDefects({ sourcePath: "e0", shape: shapes.route! }, { kind: "route_selection" }, { role: "evaluator", purpose: "select", agentDefinitionRevisionId: other })).toEqual([]);
    expect(patternPositionDefects({ sourcePath: "e0", shape: shapes.single! }, { kind: "route_branch", label: "x" }, worker)).toEqual(["the single shape has no route branch x position"]);
  });
});
