/**
 * Compiler tests for every rule in execution-model §4.4 and the invariants
 * it serves: 3 (Patterns exist only as Plan Nodes and source expressions),
 * 4 (exactly six Patterns; join is not one), 14 (coordination depth one),
 * 15 (flat, acyclic, bounded, compiler-written plan), 21 (exact pinned
 * immutable scope). Snapshots are semantic: keys, kinds, shapes, and edges,
 * never database ids.
 */
import {
  canonicalJson,
  newId,
  type AgentDefinitionRevisionId,
  type PlanExpression,
  type PlanRejectionCode,
  type RequirementId,
  type RequirementRevisionId,
} from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { assertDraftAcyclic, collectSourceReferences, compileExecutionPlan, rawSourceRejections } from "./compile.ts";
import type { CompileInput, CompiledDraft } from "./input.ts";

const agentA = newId("agentDefinitionRevision");
const agentB = newId("agentDefinitionRevision");
const evaluatorAgent = newId("agentDefinitionRevision");
const conversationId = newId("conversation");
const otherConversationId = newId("conversation");
const revisionId = newId("requirementRevision");
const otherRevisionId = newId("requirementRevision");
const foreignRevisionId = newId("requirementRevision");
const reqRoot = newId("requirement");
const reqLeaf1 = newId("requirement");
const reqLeaf2 = newId("requirement");
const reqRetired = newId("requirement");
const reqForeign = newId("requirement");
const taskId = newId("task");
const decisionId = newId("decision");
const artifactId = newId("artifact");
const criterionId = newId("acceptanceCriterion");

const orchestratorAgent = newId("agentDefinitionRevision");

const DEFAULT_ALLOCATION = { costUsd: 1, tokens: 1000, attempts: 2 };

/** An already-resolved, executable revision as the plan-revision service hands it to the compiler. */
function revision(id: AgentDefinitionRevisionId, definitionName: string, tools: string[] = ["read", "write"]): CompileInput["agentDefinitionRevisions"][number] {
  return {
    id,
    definitionName,
    provenanceKind: "builtin",
    capabilities: { tools, mcpServers: [] },
    toolPolicy: Object.fromEntries(tools.map((t) => [t, "allowed" as const])),
    defaultLimits: { allocation: DEFAULT_ALLOCATION, maxWallClockMs: null },
  };
}

function input(source: PlanExpression[], overrides: Partial<CompileInput> = {}): CompileInput {
  return {
    runId: newId("run"),
    conversationId,
    revisionNumber: 2,
    source: { version: 1, expressions: source },
    agentDefinitionRevisions: [
      revision(agentA, "worker-a"),
      revision(agentB, "worker-b"),
      revision(evaluatorAgent, "reviewer", ["read", "write", "shell"]),
      revision(orchestratorAgent, "orchestrator"),
    ],
    requirementRevisions: [
      {
        id: revisionId,
        conversationId,
        tree: [
          { id: reqRoot, parentId: null, composition: "all", statement: "root", position: 0, acceptanceCriterionIds: [] },
          { id: reqLeaf2, parentId: reqRoot, composition: null, statement: "leaf 2", position: 1, acceptanceCriterionIds: [] },
          { id: reqLeaf1, parentId: reqRoot, composition: null, statement: "leaf 1", position: 0, acceptanceCriterionIds: [] },
          { id: reqRetired, parentId: null, composition: null, statement: "retired later", position: 1, acceptanceCriterionIds: [] },
        ],
      },
      { id: otherRevisionId, conversationId, tree: [{ id: reqLeaf1, parentId: null, composition: null, statement: "leaf 1", position: 0, acceptanceCriterionIds: [] }] },
      { id: foreignRevisionId, conversationId: otherConversationId, tree: [{ id: reqForeign, parentId: null, composition: null, statement: "foreign", position: 0, acceptanceCriterionIds: [] }] },
    ],
    requirements: [
      { id: reqRoot, conversationId, status: "open" },
      { id: reqLeaf1, conversationId, status: "open" },
      { id: reqLeaf2, conversationId, status: "open" },
      { id: reqRetired, conversationId, status: "retired" },
      { id: reqForeign, conversationId: otherConversationId, status: "open" },
    ],
    references: { taskIds: [taskId], decisionIds: [decisionId], artifactIds: [artifactId], acceptanceCriterionIds: [criterionId] },
    defaults: { nodeAllocation: DEFAULT_ALLOCATION, coordinatorWorkerBounds: { maxTasks: 8, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 } },
    limits: { maxPlanDepth: 4, maxUnrolledRounds: 6, maxPlanNodes: 200 },
    ...overrides,
  };
}

const leaf = (agent: AgentDefinitionRevisionId = agentA, title?: string): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: agent, ...(title ? { title } : {}) } });
const chain = (...steps: PlanExpression[]): PlanExpression => ({ pattern: "chain", steps });
const parallel = (items: PlanExpression[], aggregate?: boolean, requireAll?: boolean): PlanExpression => ({ pattern: "parallel", items, ...(aggregate ? { aggregate: { agentDefinitionRevisionId: agentB, title: "sum" } } : {}), ...(requireAll === undefined ? {} : { requireAll }) });
const route = (branches: Record<string, PlanExpression>): PlanExpression => ({ pattern: "route", selector: { kind: "evaluator", agentDefinitionRevisionId: evaluatorAgent }, branches });
const coordinatorWorker = (bounds?: { maxTasks: number; maxConcurrentWorkers: number; maxCoordinatorInvocations: number }): PlanExpression => ({ pattern: "coordinator_worker", coordinator: { agentDefinitionRevisionId: agentA }, worker: { agentDefinitionRevisionId: agentB }, ...(bounds ? { bounds } : {}) });
const evaluatorOptimizer = (producer: PlanExpression, maxRounds = 2): PlanExpression => ({ pattern: "evaluator_optimizer", producer, evaluator: { agentDefinitionRevisionId: evaluatorAgent }, maxRounds });

function compile(source: PlanExpression[], overrides: Partial<CompileInput> = {}): CompiledDraft {
  const result = compileExecutionPlan(input(source, overrides));
  if (!result.accepted) throw new Error(`rejected: ${result.reasons.map((r) => `${r.code} ${r.message}`).join("; ")}`);
  return result.draft;
}

function rejection(source: PlanExpression[], overrides: Partial<CompileInput> = {}): { code: PlanRejectionCode; path: string | null; message: string }[] {
  const result = compileExecutionPlan(input(source, overrides));
  if (result.accepted) throw new Error("expected a rejection");
  return result.reasons;
}

/** The semantic snapshot of a draft: `key kind[:pattern]` per node and `source -type-> target` per edge. */
function summarize(draft: CompiledDraft): { nodes: string[]; edges: string[] } {
  return {
    nodes: draft.nodes.map((n) => (n.definition.kind === "pattern" ? `${n.key} pattern:${n.definition.pattern}` : `${n.key} join:${n.definition.fanInPolicy}`)),
    edges: draft.edges.map((e) => `${e.sourceKey} -${e.type}${e.label !== undefined ? `(${e.label})` : ""}${e.round !== undefined ? `(${e.round})` : ""}@${e.position}-> ${e.targetKey}`),
  };
}

function node(draft: CompiledDraft, key: string) {
  const found = draft.nodes.find((n) => n.key === key);
  if (!found) throw new Error(`no node ${key} in ${draft.nodes.map((n) => n.key).join(", ")}`);
  return found.definition;
}

/** Entry keys (no incoming edge) and exit keys (no outgoing edge) of a draft. */
function boundary(draft: CompiledDraft): { entries: string[]; exits: string[] } {
  const targets = new Set(draft.edges.map((e) => e.targetKey));
  const sources = new Set(draft.edges.map((e) => e.sourceKey));
  return { entries: draft.nodes.map((n) => n.key).filter((k) => !targets.has(k)), exits: draft.nodes.map((n) => n.key).filter((k) => !sources.has(k)) };
}

describe("leaf and chain (rules 1 and 2)", () => {
  it("compiles a leaf to one single node with resolved allocation and title", () => {
    const draft = compile([leaf()]);
    expect(summarize(draft)).toEqual({ nodes: ["e0 pattern:single"], edges: [] });
    const definition = node(draft, "e0");
    expect(definition).toMatchObject({ kind: "pattern", pattern: "single", title: "worker-a", allocation: DEFAULT_ALLOCATION, onAllocationExhausted: "fail", runOnDependencyFailure: false, scope: null });
    if (definition.kind === "pattern" && definition.shape.pattern === "single") expect(definition.shape.role).toBe("worker");
  });

  it("compiles a one-leaf chain to a single node and an all-leaf chain to one chain node", () => {
    expect(summarize(compile([chain(leaf())]))).toEqual({ nodes: ["e0 pattern:single"], edges: [] });
    const draft = compile([chain(leaf(agentA, "one"), leaf(agentB, "two"), leaf(agentA, "three"))]);
    expect(summarize(draft)).toEqual({ nodes: ["e0 pattern:chain"], edges: [] });
    const definition = node(draft, "e0");
    if (definition.kind === "pattern" && definition.shape.pattern === "chain") {
      expect(definition.shape.steps.map((s) => [s.agentDefinitionRevisionId, s.title])).toEqual([[agentA, "one"], [agentB, "two"], [agentA, "three"]]);
    } else {
      throw new Error("expected a chain shape");
    }
  });

  it("groups maximal consecutive leaf runs and wires composite steps with sequence edges, preserving order", () => {
    const draft = compile([chain(leaf(), leaf(), parallel([leaf(), chain(leaf(), leaf())]), leaf(), leaf(), leaf(), route({ x: leaf() }), leaf())]);
    expect(summarize(draft)).toEqual({
      nodes: [
        "e0/steps/0..1 pattern:chain",
        "e0/steps/2/leaves pattern:parallel",
        "e0/steps/2/items/1 pattern:chain",
        "e0/steps/2/join join:require_all",
        "e0/steps/3..5 pattern:chain",
        "e0/steps/6 pattern:route",
        "e0/steps/7 pattern:single",
      ],
      edges: [
        "e0/steps/2/leaves -fan_in@0-> e0/steps/2/join",
        "e0/steps/2/items/1 -fan_in@1-> e0/steps/2/join",
        "e0/steps/0..1 -sequence@0-> e0/steps/2/leaves",
        "e0/steps/0..1 -sequence@0-> e0/steps/2/items/1",
        "e0/steps/2/join -sequence@0-> e0/steps/3..5",
        "e0/steps/3..5 -sequence@0-> e0/steps/6",
        "e0/steps/6 -sequence@0-> e0/steps/7",
      ],
    });
    expect(boundary(draft)).toEqual({ entries: ["e0/steps/0..1"], exits: ["e0/steps/7"] });
  });

  it("a chain whose middle stage is a route (the §4.4 example)", () => {
    const draft = compile([chain(leaf(agentA, "A"), route({ x: leaf(agentB, "B"), y: chain(leaf(agentA, "C"), leaf(agentB, "D")) }), leaf(agentA, "E"))]);
    expect(summarize(draft)).toEqual({
      nodes: ["e0/steps/0 pattern:single", "e0/steps/1/branches/y pattern:chain", "e0/steps/1 pattern:route", "e0/steps/2 pattern:single"],
      edges: [
        "e0/steps/1 -branch(y)@0-> e0/steps/1/branches/y",
        "e0/steps/0 -sequence@0-> e0/steps/1",
        "e0/steps/1 -sequence@0-> e0/steps/2",
        "e0/steps/1/branches/y -sequence@1-> e0/steps/2",
      ],
    });
    const routeNode = node(draft, "e0/steps/1");
    if (routeNode.kind === "pattern" && routeNode.shape.pattern === "route") {
      expect(routeNode.shape.branches).toEqual([
        { label: "x", inline: { agentDefinitionRevisionId: agentB, title: "B", input: { taskIds: [], decisionIds: [], artifactIds: [] }, role: "worker", readOnly: false } },
        { label: "y", inline: null },
      ]);
    } else {
      throw new Error("expected a route shape");
    }
  });
});

describe("route (rule 3)", () => {
  it("keeps leaf branches inline, lifts composite branches behind branch(label) edges, and gives successors edges from every exit", () => {
    const draft = compile([chain(route({ b: chain(leaf(), leaf()), a: leaf(), c: parallel([leaf(), leaf()]) }), leaf())]);
    expect(summarize(draft)).toEqual({
      nodes: ["e0/steps/0/branches/b pattern:chain", "e0/steps/0/branches/c pattern:parallel", "e0/steps/0 pattern:route", "e0/steps/1 pattern:single"],
      edges: [
        "e0/steps/0 -branch(b)@0-> e0/steps/0/branches/b",
        "e0/steps/0 -branch(c)@0-> e0/steps/0/branches/c",
        "e0/steps/0 -sequence@0-> e0/steps/1",
        "e0/steps/0/branches/b -sequence@1-> e0/steps/1",
        "e0/steps/0/branches/c -sequence@2-> e0/steps/1",
      ],
    });
  });

  it("orders branch labels canonically regardless of object insertion order, and encodes any label safely", () => {
    const first = compile([route({ zeta: leaf(), alpha: leaf(), "with/slash and space": chain(leaf(), leaf()), "ünïcode": leaf() })]);
    const second = compile([route({ "ünïcode": leaf(), "with/slash and space": chain(leaf(), leaf()), alpha: leaf(), zeta: leaf() })]);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    const routeNode = node(first, "e0");
    if (routeNode.kind === "pattern" && routeNode.shape.pattern === "route") {
      expect(routeNode.shape.branches.map((b) => b.label)).toEqual(["alpha", "with/slash and space", "zeta", "ünïcode"]);
    }
    expect(first.nodes.map((n) => n.key)).toEqual(["e0/branches/with%2Fslash%20and%20space", "e0"]);
    expect(first.edges[0]).toMatchObject({ type: "branch", label: "with/slash and space", targetKey: "e0/branches/with%2Fslash%20and%20space" });
  });

  it("validates a decision_answer selector against the Decision and the branch labels", () => {
    const selector = { kind: "decision_answer" as const, decisionId, labelsByOptionId: { yes: "go", no: "stop" } };
    const draft = compile([{ pattern: "route", selector, branches: { go: leaf(), stop: leaf() } }]);
    expect(summarize(draft).nodes).toEqual(["e0 pattern:route"]);
    expect(rejection([{ pattern: "route", selector, branches: { go: leaf() } }])[0]).toMatchObject({ code: "invalid_role_binding", path: "e0" });
    expect(rejection([{ pattern: "route", selector: { ...selector, decisionId: newId("decision") }, branches: { go: leaf(), stop: leaf() } }])[0]).toMatchObject({ code: "invalid_decision_reference", path: "e0" });
    expect(rejection([{ pattern: "route", selector: { kind: "evaluator", agentDefinitionRevisionId: newId("agentDefinitionRevision") }, branches: { go: leaf() } }])[0]).toMatchObject({ code: "invalid_agent_definition_revision", path: "e0" });
  });
});

describe("parallel (rule 4)", () => {
  it("compiles an all-leaf parallel to one node, with or without inline aggregation", () => {
    const plain = compile([parallel([leaf(), leaf(agentB)])]);
    expect(summarize(plain)).toEqual({ nodes: ["e0 pattern:parallel"], edges: [] });
    const definition = node(plain, "e0");
    if (definition.kind === "pattern" && definition.shape.pattern === "parallel") {
      expect(definition.shape.items.map((i) => i.agentDefinitionRevisionId)).toEqual([agentA, agentB]);
      expect(definition.shape.aggregate).toBeNull();
      expect(definition.shape.requireAll).toBe(true);
    }
    const aggregated = compile([parallel([leaf(), leaf()], true, false)]);
    expect(summarize(aggregated)).toEqual({ nodes: ["e0 pattern:parallel"], edges: [] });
    const agg = node(aggregated, "e0");
    if (agg.kind === "pattern" && agg.shape.pattern === "parallel") {
      expect(agg.shape.aggregate?.title).toBe("sum");
      expect(agg.shape.requireAll).toBe(false);
    }
  });

  it("lifts composite items into subgraphs, keeps leaf items in one leaves node, fans into one join in item order, and aggregates as a subsequent single", () => {
    const draft = compile([chain(parallel([chain(leaf(), leaf()), leaf(), route({ p: leaf(), q: chain(leaf(), leaf()) }), leaf()], true), leaf())]);
    expect(summarize(draft)).toEqual({
      nodes: [
        "e0/steps/0/items/0 pattern:chain",
        "e0/steps/0/leaves pattern:parallel",
        "e0/steps/0/items/2/branches/q pattern:chain",
        "e0/steps/0/items/2 pattern:route",
        "e0/steps/0/join join:require_all",
        "e0/steps/0/aggregate pattern:single",
        "e0/steps/1 pattern:single",
      ],
      edges: [
        "e0/steps/0/items/2 -branch(q)@0-> e0/steps/0/items/2/branches/q",
        "e0/steps/0/items/0 -fan_in@0-> e0/steps/0/join",
        "e0/steps/0/leaves -fan_in@1-> e0/steps/0/join",
        "e0/steps/0/items/2 -fan_in@2-> e0/steps/0/join",
        "e0/steps/0/items/2/branches/q -fan_in@3-> e0/steps/0/join",
        "e0/steps/0/join -sequence@0-> e0/steps/0/aggregate",
        "e0/steps/0/aggregate -sequence@0-> e0/steps/1",
      ],
    });
    const leaves = node(draft, "e0/steps/0/leaves");
    if (leaves.kind === "pattern" && leaves.shape.pattern === "parallel") {
      expect(leaves.shape.items).toHaveLength(2);
      expect(leaves.shape.aggregate).toBeNull();
    }
    expect(node(draft, "e0/steps/0/join")).toMatchObject({ kind: "join", allocation: { costUsd: 0, tokens: 0, attempts: 0 } });
    expect(boundary(draft).entries.sort()).toEqual(["e0/steps/0/items/0", "e0/steps/0/items/2", "e0/steps/0/leaves"]);
  });

  it("compiles an all-composite parallel without a leaves node, and a terminal parallel without aggregation ends at its join", () => {
    const draft = compile([parallel([chain(leaf(), leaf()), chain(leaf(), leaf())])]);
    expect(summarize(draft)).toEqual({
      nodes: ["e0/items/0 pattern:chain", "e0/items/1 pattern:chain", "e0/join join:require_all"],
      edges: ["e0/items/0 -fan_in@0-> e0/join", "e0/items/1 -fan_in@1-> e0/join"],
    });
    expect(boundary(draft)).toEqual({ entries: ["e0/items/0", "e0/items/1"], exits: ["e0/join"] });
    const anyPolicy = compile([parallel([chain(leaf(), leaf()), leaf()], false, false)]);
    expect(node(anyPolicy, "e0/join")).toMatchObject({ kind: "join", fanInPolicy: "require_any" });
  });

  it("never emits a zero-item parallel node and never a parallel that only fans in (rule 4)", () => {
    for (const draft of [compile([parallel([chain(leaf(), leaf())])]), compile([parallel([chain(leaf(), leaf()), chain(leaf(), leaf())], true)])]) {
      for (const n of draft.nodes) {
        if (n.definition.kind === "pattern" && n.definition.shape.pattern === "parallel") expect(n.definition.shape.items.length).toBeGreaterThan(0);
      }
      const joins = draft.nodes.filter((n) => n.definition.kind === "join");
      expect(joins).toHaveLength(1);
      expect(draft.edges.filter((e) => e.type === "fan_in").every((e) => e.targetKey === joins[0]!.key)).toBe(true);
    }
  });
});

describe("evaluator_optimizer (rule 5)", () => {
  it("keeps a leaf producer inline in one node", () => {
    const draft = compile([evaluatorOptimizer(leaf(agentA, "draft"), 3)]);
    expect(summarize(draft)).toEqual({ nodes: ["e0 pattern:evaluator_optimizer"], edges: [] });
    const definition = node(draft, "e0");
    if (definition.kind === "pattern" && definition.shape.pattern === "evaluator_optimizer") {
      expect(definition.shape).toMatchObject({ maxRounds: 3, round: null, producer: { title: "draft" }, evaluator: { agentDefinitionRevisionId: evaluatorAgent } });
    }
  });

  it("unrolls a composite producer per round with evaluate-only nodes, retry(round) edges, and edges to successors from every round", () => {
    const draft = compile([chain(evaluatorOptimizer(chain(leaf(agentA, "a"), leaf(agentB, "b")), 3), leaf(agentA, "next"))]);
    expect(summarize(draft)).toEqual({
      nodes: [
        "e0/steps/0/rounds/1/producer pattern:chain",
        "e0/steps/0/rounds/1/evaluate pattern:evaluator_optimizer",
        "e0/steps/0/rounds/2/producer pattern:chain",
        "e0/steps/0/rounds/2/evaluate pattern:evaluator_optimizer",
        "e0/steps/0/rounds/3/producer pattern:chain",
        "e0/steps/0/rounds/3/evaluate pattern:evaluator_optimizer",
        "e0/steps/1 pattern:single",
      ],
      edges: [
        "e0/steps/0/rounds/1/producer -sequence@0-> e0/steps/0/rounds/1/evaluate",
        "e0/steps/0/rounds/2/producer -sequence@0-> e0/steps/0/rounds/2/evaluate",
        "e0/steps/0/rounds/1/evaluate -retry(2)@0-> e0/steps/0/rounds/2/producer",
        "e0/steps/0/rounds/3/producer -sequence@0-> e0/steps/0/rounds/3/evaluate",
        "e0/steps/0/rounds/2/evaluate -retry(3)@0-> e0/steps/0/rounds/3/producer",
        "e0/steps/0/rounds/1/evaluate -sequence@0-> e0/steps/1",
        "e0/steps/0/rounds/2/evaluate -sequence@1-> e0/steps/1",
        "e0/steps/0/rounds/3/evaluate -sequence@2-> e0/steps/1",
      ],
    });
    for (const round of [1, 2, 3]) {
      const evaluate = node(draft, `e0/steps/0/rounds/${round}/evaluate`);
      if (evaluate.kind === "pattern" && evaluate.shape.pattern === "evaluator_optimizer") expect(evaluate.shape).toMatchObject({ producer: null, round, maxRounds: 3 });
    }
    expect(boundary(draft)).toEqual({ entries: ["e0/steps/0/rounds/1/producer"], exits: ["e0/steps/1"] });
  });

  it("enforces maxUnrolledRounds", () => {
    expect(rejection([evaluatorOptimizer(chain(leaf(), leaf()), 3)], { limits: { maxPlanDepth: 4, maxUnrolledRounds: 2, maxPlanNodes: 200 } })[0]).toMatchObject({ code: "excessive_unrolled_rounds", path: "e0" });
  });
});

describe("coordinator_worker (rule 6, invariant 14)", () => {
  it("compiles to one node with leaf operands and resolved bounds", () => {
    const draft = compile([coordinatorWorker()]);
    expect(summarize(draft)).toEqual({ nodes: ["e0 pattern:coordinator_worker"], edges: [] });
    const definition = node(draft, "e0");
    if (definition.kind === "pattern" && definition.shape.pattern === "coordinator_worker") {
      expect(definition.shape.coordinator.agentDefinitionRevisionId).toBe(agentA);
      expect(definition.shape.worker.agentDefinitionRevisionId).toBe(agentB);
      expect(definition.shape.bounds).toEqual({ maxTasks: 8, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 });
    }
  });

  it("rejects a nested or non-leaf coordinator_worker before schema parsing, with a precise code", () => {
    const nested = { pattern: "coordinator_worker", coordinator: { pattern: "coordinator_worker", coordinator: { agentDefinitionRevisionId: agentA }, worker: { agentDefinitionRevisionId: agentB } }, worker: { agentDefinitionRevisionId: agentB } };
    expect(rawSourceRejections({ version: 1, expressions: [nested] }).map((r) => r.code)).toEqual(["nested_coordinator_worker", "nested_coordinator_worker"]);
    const composite = { pattern: "coordinator_worker", coordinator: { agentDefinitionRevisionId: agentA }, worker: { pattern: "chain", steps: [] } };
    expect(rawSourceRejections({ version: 1, expressions: [composite] })[0]).toMatchObject({ code: "nested_coordinator_worker", path: "$/expressions/0/worker" });
    expect(rejection([coordinatorWorker({ maxTasks: 1, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 1 })])[0]).toMatchObject({ code: "invalid_pattern_bounds" });
  });

  it("rejects an explicit join and unknown Patterns, keeping exactly six (invariant 4)", () => {
    expect(rawSourceRejections({ version: 1, expressions: [{ pattern: "join" }] })[0]).toMatchObject({ code: "explicit_join", path: "$/expressions/0" });
    expect(rawSourceRejections({ version: 1, expressions: [{ pattern: "chain", steps: [{ pattern: "map_reduce" }] }] })[0]).toMatchObject({ code: "unsupported_pattern", path: "$/expressions/0/steps/0" });
    expect(rawSourceRejections({ version: 1, expressions: [leaf(), chain(leaf()), route({ a: leaf() }), parallel([leaf()]), coordinatorWorker(), evaluatorOptimizer(leaf())] })).toEqual([]);
  });
});

describe("role bindings and role policy", () => {
  it("records each operation's role and read-only policy without evaluating provider tool semantics", () => {
    const draft = compile([chain(leaf(), route({ a: leaf() }), coordinatorWorker(), evaluatorOptimizer(leaf(agentA), 2))]);
    const roles = (key: string) => {
      const definition = node(draft, key);
      if (definition.kind !== "pattern") throw new Error("pattern expected");
      const ops: { role: string; readOnly: boolean }[] = [];
      const shape = definition.shape;
      switch (shape.pattern) {
        case "single": ops.push(shape.operation); break;
        case "route": for (const b of shape.branches) if (b.inline) ops.push(b.inline); break;
        case "coordinator_worker": ops.push(shape.coordinator, shape.worker); break;
        case "evaluator_optimizer": if (shape.producer) ops.push(shape.producer); ops.push(shape.evaluator); break;
        default: break;
      }
      return ops.map((o) => `${o.role}${o.readOnly ? ":read-only" : ""}`);
    };
    expect(roles("e0/steps/0")).toEqual(["worker"]);
    expect(roles("e0/steps/1")).toEqual(["worker"]);
    expect(roles("e0/steps/2")).toEqual(["coordinator", "worker"]);
    // The evaluator declares write and shell tools; it is still bound, read-only, for the manifest to intersect later.
    expect(roles("e0/steps/3")).toEqual(["worker", "evaluator:read-only"]);
  });

  it("rejects binding the Orchestrator's own definition to any other role (invalid_role_binding)", () => {
    expect(rejection([leaf(orchestratorAgent)])[0]).toMatchObject({ code: "invalid_role_binding", path: "e0" });
    expect(rejection([{ pattern: "coordinator_worker", coordinator: { agentDefinitionRevisionId: orchestratorAgent }, worker: { agentDefinitionRevisionId: agentB } }])[0]).toMatchObject({ code: "invalid_role_binding" });
    expect(rejection([{ pattern: "evaluator_optimizer", producer: leaf(), evaluator: { agentDefinitionRevisionId: orchestratorAgent }, maxRounds: 2 }])[0]).toMatchObject({ code: "invalid_role_binding" });
    expect(rejection([{ pattern: "route", selector: { kind: "evaluator", agentDefinitionRevisionId: orchestratorAgent }, branches: { a: leaf() } }])[0]).toMatchObject({ code: "invalid_role_binding" });
  });

  it("receives only revisions the service already resolved; an unresolved id is rejected without any lookup", () => {
    expect(rejection([leaf(newId("agentDefinitionRevision"))])[0]).toMatchObject({ code: "invalid_agent_definition_revision", message: expect.stringContaining("not executable by this Run") });
  });
});

describe("Requirement scope (rule 7, invariant 21)", () => {
  it("expands roots to the exact leaf set in tree order, materializes inherited scope, lets a child override it, and leaves joins without scope", () => {
    const scoped: PlanExpression = {
      ...chain(parallel([chain(leaf(), leaf()), leaf()]), { ...leaf(), scope: { requirementRootIds: [reqLeaf2], requirementRevisionId: revisionId } }),
      scope: { requirementRootIds: [reqRoot], requirementRevisionId: revisionId },
    };
    const draft = compile([scoped]);
    const full = { requirementRevisionId: revisionId, requirementIds: [reqLeaf1, reqLeaf2] };
    expect(node(draft, "e0/steps/0/items/0")).toMatchObject({ scope: full });
    expect(node(draft, "e0/steps/0/leaves")).toMatchObject({ scope: full });
    expect(node(draft, "e0/steps/0/join")).not.toHaveProperty("scope");
    expect(node(draft, "e0/steps/1")).toMatchObject({ scope: { requirementRevisionId: revisionId, requirementIds: [reqLeaf2] } });
    // An internal root is expanded and never appears in the scope itself.
    expect((node(draft, "e0/steps/0/items/0") as { scope: { requirementIds: string[] } }).scope.requirementIds).not.toContain(reqRoot);
    // A leaf root is itself the scope.
    expect(node(compile([{ ...leaf(), scope: { requirementRootIds: [reqLeaf1], requirementRevisionId: revisionId } }]), "e0")).toMatchObject({ scope: { requirementIds: [reqLeaf1] } });
  });

  it("rejects missing, foreign, wrong-revision, and retired Requirements", () => {
    const at = (rootIds: RequirementId[], rev: RequirementRevisionId) => rejection([{ ...leaf(), scope: { requirementRootIds: rootIds, requirementRevisionId: rev } }])[0];
    expect(at([newId("requirement")], revisionId)).toMatchObject({ code: "invalid_requirement_scope", path: "e0" });
    expect(at([reqLeaf1], newId("requirementRevision"))).toMatchObject({ code: "invalid_requirement_scope" });
    expect(at([reqForeign], foreignRevisionId)).toMatchObject({ code: "invalid_requirement_scope", message: expect.stringContaining("another Conversation") });
    expect(at([reqLeaf2], otherRevisionId)).toMatchObject({ code: "invalid_requirement_scope", message: expect.stringContaining("does not exist at revision") });
    expect(at([reqRetired], revisionId)).toMatchObject({ code: "invalid_requirement_scope", message: expect.stringContaining("retired") });
  });
});

describe("allocation and references (rule 8, invariant 22)", () => {
  it("resolves omitted allocations to the configured default, keeps explicit ones, and gives joins zero", () => {
    const draft = compile([chain({ ...leaf(), allocation: { costUsd: 3, tokens: 30, attempts: 3 } }, parallel([chain(leaf(), leaf()), leaf()]))]);
    expect(node(draft, "e0/steps/0").allocation).toEqual({ costUsd: 3, tokens: 30, attempts: 3 });
    expect(node(draft, "e0/steps/1/items/0").allocation).toEqual(DEFAULT_ALLOCATION);
    expect(node(draft, "e0/steps/1/join").allocation).toEqual({ costUsd: 0, tokens: 0, attempts: 0 });
    const explicit = compile([{ ...chain(leaf(), leaf(), parallel([leaf(), chain(leaf(), leaf())])), allocation: { costUsd: 2, tokens: 20, attempts: 2 }, limits: { maxConcurrency: 3, maxWallClockMs: 1000 }, onAllocationExhausted: "wait", runOnDependencyFailure: true }]);
    // An expression's options apply to every pattern node compiled directly from it.
    expect(node(explicit, "e0/steps/0..1")).toMatchObject({ allocation: { costUsd: 2, tokens: 20, attempts: 2 }, maxConcurrency: 3, maxWallClockMs: 1000, onAllocationExhausted: "wait", runOnDependencyFailure: true });
    expect(node(explicit, "e0/steps/2/leaves")).toMatchObject({ allocation: DEFAULT_ALLOCATION, runOnDependencyFailure: false });
  });

  it("unions operation inputs into the node input and rejects unknown references", () => {
    const draft = compile([chain({ pattern: "single", operation: { agentDefinitionRevisionId: agentA, input: { taskIds: [taskId], decisionIds: [], artifactIds: [artifactId] } } }, { pattern: "single", operation: { agentDefinitionRevisionId: agentB, input: { taskIds: [], decisionIds: [decisionId], artifactIds: [] } } })]);
    expect(node(draft, "e0")).toMatchObject({ input: { taskIds: [taskId], decisionIds: [decisionId], artifactIds: [artifactId] } });
    // The union is for validation and authorization only; each step's own input stays exact on its operation, and one executable Task cannot be owned by two steps.
    const definition = node(draft, "e0");
    expect(definition.kind === "pattern" && definition.shape.pattern === "chain" ? definition.shape.steps.map((step) => step.input) : null).toEqual([{ taskIds: [taskId], decisionIds: [], artifactIds: [artifactId] }, { taskIds: [], decisionIds: [decisionId], artifactIds: [] }]);
    const duplicated = rejection([chain({ pattern: "single", operation: { agentDefinitionRevisionId: agentA, input: { taskIds: [taskId], decisionIds: [], artifactIds: [] } } }, { pattern: "single", operation: { agentDefinitionRevisionId: agentB, input: { taskIds: [taskId], decisionIds: [], artifactIds: [] } } })]);
    expect(duplicated[0]).toMatchObject({ code: "duplicate_task_assignment", path: "e0" });
    expect(rejection([parallel([{ pattern: "single", operation: { agentDefinitionRevisionId: agentA, input: { taskIds: [taskId], decisionIds: [], artifactIds: [] } } }, { pattern: "single", operation: { agentDefinitionRevisionId: agentB, input: { taskIds: [taskId], decisionIds: [], artifactIds: [] } } }])])[0]!.code).toBe("duplicate_task_assignment");
    const withInput = (input: Record<string, string[]>): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: agentA, input: { taskIds: [], decisionIds: [], artifactIds: [], ...input } as never } });
    expect(rejection([withInput({ taskIds: [newId("task")] })])[0]!.code).toBe("invalid_task_reference");
    expect(rejection([withInput({ decisionIds: [newId("decision")] })])[0]!.code).toBe("invalid_decision_reference");
    expect(rejection([withInput({ artifactIds: [newId("artifact")] })])[0]!.code).toBe("invalid_artifact_reference");
    expect(rejection([{ ...leaf(), gateAcceptanceCriterionIds: [newId("acceptanceCriterion")] }])[0]!.code).toBe("invalid_acceptance_criterion_reference");
    expect(rejection([leaf(newId("agentDefinitionRevision"))])[0]).toMatchObject({ code: "invalid_agent_definition_revision", path: "e0" });
    expect(node(compile([{ ...leaf(), gateAcceptanceCriterionIds: [criterionId] }]), "e0")).toMatchObject({ gateAcceptanceCriterionIds: [criterionId] });
  });
});

describe("determinism, limits, and acyclicity (invariant 15)", () => {
  const everything = (): PlanExpression[] => [
    chain(leaf(), route({ b: chain(leaf(), leaf()), a: leaf() }), parallel([chain(leaf(), leaf()), leaf()], true), evaluatorOptimizer(chain(leaf(), leaf()), 2), coordinatorWorker()),
    { ...leaf(), scope: { requirementRootIds: [reqRoot], requirementRevisionId: revisionId } },
  ];

  it("produces byte-for-byte identical output for identical input, and is stable when later siblings are appended", () => {
    expect(canonicalJson(compile(everything()))).toBe(canonicalJson(compile(everything())));
    const before = compile(everything());
    const after = compile([...everything(), leaf(agentB)]);
    expect(after.nodes.slice(0, before.nodes.length)).toEqual(before.nodes);
    expect(after.nodes.at(-1)?.key).toBe("e2");
  });

  it("emits unique keys, an acyclic graph, edges only between draft nodes, and flat nodes only", () => {
    const draft = compile(everything());
    expect(new Set(draft.nodes.map((n) => n.key)).size).toBe(draft.nodes.length);
    expect(() => assertDraftAcyclic(draft.nodes, draft.edges)).not.toThrow();
    for (const n of draft.nodes) expect(JSON.stringify(n.definition)).not.toMatch(/"steps":\[\{"pattern"/);
    expect(() => assertDraftAcyclic(draft.nodes, [...draft.edges, { sourceKey: "e1", targetKey: "e0/steps/0", type: "sequence", position: 0 }, { sourceKey: "e0/steps/4", targetKey: "e1", type: "sequence", position: 0 }])).toThrow(/cycle/);
    expect(() => assertDraftAcyclic(draft.nodes, [{ sourceKey: "e0", targetKey: "nowhere", type: "sequence", position: 0 }])).toThrow(/outside the draft/);
  });

  it("enforces the compiled node limit", () => {
    expect(rejection([parallel([chain(leaf(), leaf()), chain(leaf(), leaf()), chain(leaf(), leaf())])], { limits: { maxPlanDepth: 4, maxUnrolledRounds: 6, maxPlanNodes: 3 } })[0]).toMatchObject({ code: "excessive_compiled_nodes" });
    expect(compile([parallel([chain(leaf(), leaf()), chain(leaf(), leaf()), chain(leaf(), leaf())])], { limits: { maxPlanDepth: 4, maxUnrolledRounds: 6, maxPlanNodes: 4 } }).nodes).toHaveLength(4);
  });

  it("collects exactly the references a source names, sorted", () => {
    const refs = collectSourceReferences({ version: 1, expressions: [...everything(), { pattern: "route", selector: { kind: "decision_answer", decisionId, labelsByOptionId: { o: "x" } }, branches: { x: { ...leaf(), gateAcceptanceCriterionIds: [criterionId] } } }] });
    expect(refs.agentDefinitionRevisionIds).toEqual([agentA, agentB, evaluatorAgent].sort());
    expect(refs.requirementRevisionIds).toEqual([revisionId]);
    expect(refs.decisionIds).toEqual([decisionId]);
    expect(refs.acceptanceCriterionIds).toEqual([criterionId]);
    expect(refs.taskIds).toEqual([]);
  });
});
