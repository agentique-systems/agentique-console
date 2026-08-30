/**
 * The deterministic plan compiler (execution-model §4.4). Pure: it reads
 * only its `CompileInput`, emits logical nodes keyed by canonical source
 * path and edges between those keys, and reports rejections as structured
 * reasons. Materialization (ids, reconciliation, reservation, persistence)
 * is the plan-revision service's job.
 */
import {
  expandRequirementRoots,
  isLeafExpression,
  ORCHESTRATOR_DEFINITION_NAME,
  PATTERNS,
  planNodeDefinitionSchema,
  parseOrThrow,
  READ_ONLY_OPERATION_ROLES,
  type Allocation,
  type CompiledOperation,
  type CoordinatorWorkerBounds,
  type ManifestTemplate,
  type OperationRole,
  type PatternPlanNodeDefinition,
  type PlanExpression,
  type PlanNodeDefinition,
  type PlanNodeScope,
  type PlanOperation,
  type PlanRejectionCode,
  type PlanRejectionReason,
  type PlanScope,
  type RouteBranchBinding,
} from "@agentique-console/core";
import type { CompileInput, CompileResult, CompiledDraft, CompiledDraftEdge, CompiledDraftNode } from "./input.ts";
import { ROOT_PATH, sourcePath } from "./source-path.ts";

/** A rejection raised inside compilation; converted to a `CompileResult` at the boundary. */
export class PlanRejection extends Error {
  readonly reasons: PlanRejectionReason[];

  constructor(reasons: PlanRejectionReason[]) {
    super(reasons.map((r) => r.message).join("; "));
    this.name = "PlanRejection";
    this.reasons = reasons;
  }
}

function reject(code: PlanRejectionCode, message: string, path: string | null): never {
  throw new PlanRejection([{ code, message, path }]);
}

/** The entry and exit node keys of a compiled subgraph. */
interface Subgraph {
  entries: string[];
  exits: string[];
}

/** Node-level options an expression declares, applied to every node compiled directly from it. */
interface NodeOptions {
  allocation: Allocation;
  maxConcurrency: number | null;
  maxWallClockMs: number | null;
  onAllocationExhausted: PatternPlanNodeDefinition["onAllocationExhausted"];
  runOnDependencyFailure: boolean;
  gateAcceptanceCriterionIds: PatternPlanNodeDefinition["gateAcceptanceCriterionIds"];
}

interface Frame {
  scope: PlanNodeScope | null;
  insideCoordinatorWorker: boolean;
}

interface RawEdge {
  sourceKey: string;
  targetKey: string;
  type: CompiledDraftEdge["type"];
  label?: string;
  round?: number;
}

class Compilation {
  readonly nodes: CompiledDraftNode[] = [];
  readonly edges: RawEdge[] = [];
  private readonly keys = new Set<string>();
  private readonly agents: ReadonlyMap<string, CompileInput["agentDefinitionRevisions"][number]>;
  private readonly requirementRevisions: ReadonlyMap<string, CompileInput["requirementRevisions"][number]>;
  private readonly requirements: ReadonlyMap<string, CompileInput["requirements"][number]>;
  private readonly taskIds: ReadonlySet<string>;
  private readonly decisionIds: ReadonlySet<string>;
  private readonly artifactIds: ReadonlySet<string>;
  private readonly acceptanceCriterionIds: ReadonlySet<string>;

  constructor(private readonly input: CompileInput) {
    this.agents = new Map(input.agentDefinitionRevisions.map((r) => [r.id, r]));
    this.requirementRevisions = new Map(input.requirementRevisions.map((r) => [r.id, r]));
    this.requirements = new Map(input.requirements.map((r) => [r.id, r]));
    this.taskIds = new Set(input.references.taskIds);
    this.decisionIds = new Set(input.references.decisionIds);
    this.artifactIds = new Set(input.references.artifactIds);
    this.acceptanceCriterionIds = new Set(input.references.acceptanceCriterionIds);
  }

  run(): CompiledDraft {
    this.input.source.expressions.forEach((expression, index) => {
      this.compileExpression(expression, sourcePath.expression(index), { scope: null, insideCoordinatorWorker: false });
    });
    if (this.nodes.length > this.input.limits.maxPlanNodes) {
      reject("excessive_compiled_nodes", `the revision compiles to ${this.nodes.length} nodes; the limit is ${this.input.limits.maxPlanNodes}`, null);
    }
    const edges = assignPositions(this.edges);
    assertDraftAcyclic(this.nodes, edges);
    return { nodes: this.nodes, edges };
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  private compileExpression(expression: PlanExpression, path: string, frame: Frame): Subgraph {
    const scope = this.resolveScope(expression.scope, frame.scope, path);
    const inner: Frame = { scope, insideCoordinatorWorker: frame.insideCoordinatorWorker };
    const options = this.nodeOptions(expression, path);
    switch (expression.pattern) {
      case "single":
        return this.emitSingle(path, expression, options, scope);
      case "chain":
        return this.compileChain(expression, path, options, inner);
      case "route":
        return this.compileRoute(expression, path, options, inner);
      case "parallel":
        return this.compileParallel(expression, path, options, inner);
      case "coordinator_worker":
        return this.compileCoordinatorWorker(expression, path, options, inner);
      case "evaluator_optimizer":
        return this.compileEvaluatorOptimizer(expression, path, options, inner);
      default:
        return reject("unsupported_pattern", `unsupported Pattern ${String((expression as { pattern: unknown }).pattern)}`, path);
    }
  }

  /** Rule 1: a leaf operation compiles to one `single` node. */
  private emitSingle(path: string, expression: PlanExpression & { pattern: "single" }, options: NodeOptions, scope: PlanNodeScope | null): Subgraph {
    const operation = this.operation(expression.operation, path, "worker", expression.title);
    this.emitPattern(path, expression.title ?? operation.title, { pattern: "single", role: "worker", operation }, [operation], options, scope);
    return { entries: [path], exits: [path] };
  }

  /** Rule 2: maximal leaf runs become one `chain` (or `single`) node; composite steps become subgraphs joined by `sequence`. */
  private compileChain(expression: PlanExpression & { pattern: "chain" }, path: string, options: NodeOptions, frame: Frame): Subgraph {
    const steps = expression.steps;
    if (steps.every(isLeafExpression)) {
      const operations = steps.map((step, index) => this.operation((step as PlanExpression & { pattern: "single" }).operation, sourcePath.step(path, index), "worker", step.title));
      if (operations.length === 1) {
        this.emitPattern(path, expression.title ?? operations[0]!.title, { pattern: "single", role: "worker", operation: operations[0]! }, operations, options, frame.scope);
      } else {
        this.emitPattern(path, expression.title ?? "chain", { pattern: "chain", steps: operations }, operations, options, frame.scope);
      }
      return { entries: [path], exits: [path] };
    }
    const segments: Subgraph[] = [];
    let index = 0;
    while (index < steps.length) {
      const step = steps[index]!;
      if (isLeafExpression(step)) {
        let end = index;
        while (end + 1 < steps.length && isLeafExpression(steps[end + 1]!)) end += 1;
        const operations = steps.slice(index, end + 1).map((leaf, offset) => this.operation((leaf as PlanExpression & { pattern: "single" }).operation, sourcePath.step(path, index + offset), "worker", leaf.title));
        if (operations.length === 1) {
          const key = sourcePath.step(path, index);
          this.emitPattern(key, step.title ?? operations[0]!.title, { pattern: "single", role: "worker", operation: operations[0]! }, operations, options, frame.scope);
          segments.push({ entries: [key], exits: [key] });
        } else {
          const key = sourcePath.stepRun(path, index, end);
          this.emitPattern(key, `${expression.title ?? "chain"} steps ${index}..${end}`, { pattern: "chain", steps: operations }, operations, options, frame.scope);
          segments.push({ entries: [key], exits: [key] });
        }
        index = end + 1;
      } else {
        segments.push(this.compileExpression(step, sourcePath.step(path, index), frame));
        index += 1;
      }
    }
    for (let i = 0; i + 1 < segments.length; i += 1) this.connect(segments[i]!.exits, segments[i + 1]!.entries, "sequence");
    return { entries: segments[0]!.entries, exits: segments[segments.length - 1]!.exits };
  }

  /** Rule 3: one `route` node; leaf branches inline; composite branches as subgraphs behind `branch(label)`. */
  private compileRoute(expression: PlanExpression & { pattern: "route" }, path: string, options: NodeOptions, frame: Frame): Subgraph {
    const labels = Object.keys(expression.branches).sort(compareLabels);
    const selector = expression.selector;
    if (selector.kind === "evaluator") {
      this.requireAgent(selector.agentDefinitionRevisionId, path, "evaluator");
    } else {
      if (!this.decisionIds.has(selector.decisionId)) reject("invalid_decision_reference", `route selector names unknown Decision ${selector.decisionId}`, path);
      for (const [optionId, label] of Object.entries(selector.labelsByOptionId)) {
        if (!labels.includes(label)) reject("invalid_role_binding", `route selector maps option ${optionId} to a branch ${label} that does not exist`, path);
      }
    }
    const bindings: RouteBranchBinding[] = [];
    const inlineOperations: CompiledOperation[] = [];
    const composites: { label: string; subgraph: Subgraph }[] = [];
    for (const label of labels) {
      const branch = expression.branches[label]!;
      if (isLeafExpression(branch)) {
        const operation = this.operation(branch.operation, sourcePath.branch(path, label), "worker", branch.title);
        bindings.push({ label, inline: operation });
        inlineOperations.push(operation);
      } else {
        bindings.push({ label, inline: null });
        composites.push({ label, subgraph: this.compileExpression(branch, sourcePath.branch(path, label), frame) });
      }
    }
    if (selector.kind === "evaluator") inlineOperations.push({ agentDefinitionRevisionId: selector.agentDefinitionRevisionId, title: "selector", input: emptyInput(), role: "evaluator", readOnly: true });
    this.emitPattern(path, expression.title ?? "route", { pattern: "route", selector, branches: bindings }, inlineOperations, options, frame.scope);
    const exits = [path];
    for (const composite of composites) {
      this.connect([path], composite.subgraph.entries, "branch", { label: composite.label });
      exits.push(...composite.subgraph.exits);
    }
    return { entries: [path], exits };
  }

  /** Rule 4: all-leaf parallel is one node; otherwise subgraphs and a leaves node fan into one join. */
  private compileParallel(expression: PlanExpression & { pattern: "parallel" }, path: string, options: NodeOptions, frame: Frame): Subgraph {
    const requireAll = expression.requireAll ?? true;
    const items = expression.items;
    if (items.every(isLeafExpression)) {
      const operations = items.map((item, index) => this.operation((item as PlanExpression & { pattern: "single" }).operation, sourcePath.item(path, index), "worker", item.title));
      const aggregate = expression.aggregate ? this.operation(expression.aggregate, sourcePath.aggregate(path), "worker", undefined, "aggregate") : null;
      this.emitPattern(path, expression.title ?? "parallel", { pattern: "parallel", items: operations, aggregate, requireAll }, aggregate ? [...operations, aggregate] : operations, options, frame.scope);
      return { entries: [path], exits: [path] };
    }
    const entries: string[] = [];
    const fanIn: string[] = [];
    const leavesKey = sourcePath.leaves(path);
    // The leaf items form one parallel node without aggregation, emitted at the position of the first leaf item.
    const leafOperations = items.flatMap((item, index) => (isLeafExpression(item) ? [this.operation(item.operation, sourcePath.item(path, index), "worker", item.title)] : []));
    let leavesEmitted = false;
    items.forEach((item, index) => {
      if (isLeafExpression(item)) {
        if (!leavesEmitted) {
          leavesEmitted = true;
          this.emitPattern(leavesKey, `${expression.title ?? "parallel"} leaves`, { pattern: "parallel", items: leafOperations, aggregate: null, requireAll }, leafOperations, options, frame.scope);
          entries.push(leavesKey);
          fanIn.push(leavesKey);
        }
        return;
      }
      const subgraph = this.compileExpression(item, sourcePath.item(path, index), frame);
      entries.push(...subgraph.entries);
      fanIn.push(...subgraph.exits);
    });
    const joinKey = sourcePath.join(path);
    this.emitJoin(joinKey, `${expression.title ?? "parallel"} join`, requireAll ? "require_all" : "require_any", options.runOnDependencyFailure);
    for (const source of fanIn) this.edges.push({ sourceKey: source, targetKey: joinKey, type: "fan_in" });
    if (expression.aggregate) {
      const aggregateKey = sourcePath.aggregate(path);
      const operation = this.operation(expression.aggregate, aggregateKey, "worker", undefined, "aggregate");
      this.emitPattern(aggregateKey, `${expression.title ?? "parallel"} aggregate`, { pattern: "single", role: "worker", operation }, [operation], options, frame.scope);
      this.connect([joinKey], [aggregateKey], "sequence");
      return { entries, exits: [aggregateKey] };
    }
    return { entries, exits: [joinKey] };
  }

  /** Rule 6: one `coordinator_worker` node with leaf operands; never nested (invariant 14). */
  private compileCoordinatorWorker(expression: PlanExpression & { pattern: "coordinator_worker" }, path: string, options: NodeOptions, frame: Frame): Subgraph {
    if (frame.insideCoordinatorWorker) reject("nested_coordinator_worker", "a coordinator_worker expression cannot contain another coordinator_worker", path);
    const bounds: CoordinatorWorkerBounds = expression.bounds ?? this.input.defaults.coordinatorWorkerBounds;
    if (bounds.maxConcurrentWorkers > bounds.maxTasks) {
      reject("invalid_pattern_bounds", `maxConcurrentWorkers ${bounds.maxConcurrentWorkers} exceeds maxTasks ${bounds.maxTasks}`, path);
    }
    const coordinator = this.operation(expression.coordinator, path, "coordinator", undefined, "coordinator");
    const worker = this.operation(expression.worker, path, "worker", undefined, "worker");
    this.emitPattern(path, expression.title ?? "coordinator_worker", { pattern: "coordinator_worker", coordinator, worker, bounds }, [coordinator, worker], options, frame.scope);
    return { entries: [path], exits: [path] };
  }

  /** Rule 5: a leaf producer stays inline; a composite producer is unrolled per round with `retry(round)` edges. */
  private compileEvaluatorOptimizer(expression: PlanExpression & { pattern: "evaluator_optimizer" }, path: string, options: NodeOptions, frame: Frame): Subgraph {
    if (expression.maxRounds > this.input.limits.maxUnrolledRounds) {
      reject("excessive_unrolled_rounds", `${expression.maxRounds} rounds exceed the limit of ${this.input.limits.maxUnrolledRounds}`, path);
    }
    const evaluator = this.operation(expression.evaluator, path, "evaluator", undefined, "evaluator");
    if (isLeafExpression(expression.producer)) {
      const producer = this.operation(expression.producer.operation, path, "worker", expression.producer.title, "producer");
      this.emitPattern(path, expression.title ?? "evaluator_optimizer", { pattern: "evaluator_optimizer", producer, evaluator, maxRounds: expression.maxRounds, round: null }, [producer, evaluator], options, frame.scope);
      return { entries: [path], exits: [path] };
    }
    let entries: string[] = [];
    let previousEvaluate: string | null = null;
    const exits: string[] = [];
    for (let round = 1; round <= expression.maxRounds; round += 1) {
      const producer = this.compileExpression(expression.producer, sourcePath.producerRound(path, round), frame);
      const evaluateKey = sourcePath.evaluateRound(path, round);
      this.emitPattern(
        evaluateKey,
        `${expression.title ?? "evaluator_optimizer"} round ${round}`,
        { pattern: "evaluator_optimizer", producer: null, evaluator, maxRounds: expression.maxRounds, round },
        [evaluator],
        options,
        frame.scope,
      );
      this.connect(producer.exits, [evaluateKey], "sequence");
      if (previousEvaluate === null) entries = producer.entries;
      else this.connect([previousEvaluate], producer.entries, "retry", { round });
      previousEvaluate = evaluateKey;
      exits.push(evaluateKey);
    }
    return { entries, exits };
  }

  // -------------------------------------------------------------------------
  // Emission
  // -------------------------------------------------------------------------

  private emitPattern(
    key: string,
    title: string,
    shape: PatternPlanNodeDefinition["shape"],
    operations: CompiledOperation[],
    options: NodeOptions,
    scope: PlanNodeScope | null,
  ): void {
    // An executable Task is owned by exactly one operation of a node: two chain steps or two parallel items naming the
    // same Task would each own and transition it, which no result application can reconcile.
    if (shape.pattern === "chain" || shape.pattern === "parallel") {
      const owners = new Map<string, number>();
      operations.forEach((operation, index) => {
        for (const taskId of operation.input.taskIds) {
          const first = owners.get(taskId);
          if (first !== undefined) reject("duplicate_task_assignment", `Task ${taskId} is assigned to operations ${first} and ${index} of the ${shape.pattern}; an executable Task belongs to exactly one`, key);
          owners.set(taskId, index);
        }
      });
    }
    const definition: PatternPlanNodeDefinition = {
      kind: "pattern",
      pattern: shape.pattern,
      title,
      sourcePath: key,
      shape,
      input: unionInputs(operations.map((o) => o.input)),
      allocation: options.allocation,
      maxConcurrency: options.maxConcurrency,
      maxWallClockMs: options.maxWallClockMs,
      onAllocationExhausted: options.onAllocationExhausted,
      runOnDependencyFailure: options.runOnDependencyFailure,
      gateAcceptanceCriterionIds: options.gateAcceptanceCriterionIds,
      scope,
    };
    this.emit(key, definition);
  }

  private emitJoin(key: string, title: string, fanInPolicy: "require_all" | "require_any", runOnDependencyFailure: boolean): void {
    this.emit(key, {
      kind: "join",
      title,
      sourcePath: key,
      fanInPolicy,
      allocation: { costUsd: 0, tokens: 0, attempts: 0 },
      maxConcurrency: null,
      maxWallClockMs: null,
      runOnDependencyFailure,
    });
  }

  private emit(key: string, definition: PlanNodeDefinition): void {
    if (key === ROOT_PATH || this.keys.has(key)) reject("invalid_structure", `source path ${key} is produced twice`, key);
    let valid: PlanNodeDefinition;
    try {
      valid = parseOrThrow(planNodeDefinitionSchema, definition, `node ${key}`);
    } catch (error) {
      reject("invalid_structure", error instanceof Error ? error.message : String(error), key);
    }
    this.keys.add(key);
    this.nodes.push({ key, definition: valid });
    if (this.nodes.length > this.input.limits.maxPlanNodes) {
      reject("excessive_compiled_nodes", `the revision compiles to more than ${this.input.limits.maxPlanNodes} nodes`, key);
    }
  }

  private connect(sources: string[], targets: string[], type: RawEdge["type"], extra: { label?: string; round?: number } = {}): void {
    for (const targetKey of targets) {
      for (const sourceKey of sources) this.edges.push({ sourceKey, targetKey, type, ...extra });
    }
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Resolves an operation for `role`; its title is the expression's, else the
   * operation's, else the role fallback, else the definition's name. The
   * role policy is recorded (`readOnly` for evaluators) for the manifest to
   * apply against the revision's Tool Policy later; no provider tool
   * semantics are evaluated here.
   */
  private operation(operation: PlanOperation, path: string, role: OperationRole, title: string | undefined, fallback?: string): CompiledOperation {
    const revision = this.requireAgent(operation.agentDefinitionRevisionId, path, role);
    const input = operation.input ?? emptyInput();
    for (const id of input.taskIds) if (!this.taskIds.has(id)) reject("invalid_task_reference", `operation names unknown Task ${id}`, path);
    for (const id of input.decisionIds) if (!this.decisionIds.has(id)) reject("invalid_decision_reference", `operation names unknown Decision ${id}`, path);
    for (const id of input.artifactIds) if (!this.artifactIds.has(id)) reject("invalid_artifact_reference", `operation names unknown Artifact ${id}`, path);
    return {
      agentDefinitionRevisionId: operation.agentDefinitionRevisionId,
      title: title ?? operation.title ?? fallback ?? revision.definitionName,
      input: normalizeInput(input),
      role,
      readOnly: READ_ONLY_OPERATION_ROLES.includes(role),
    };
  }

  /**
   * A revision the service resolved as executable, bound to `role`. The one
   * contradictory binding is the Orchestrator's own definition in any other
   * role: it would lend Orchestrator instructions to a Worker, Coordinator,
   * or Evaluator that the runtime never grants Orchestrator authority.
   * Declared tools are never a reason to reject: the role policy intersects
   * them at manifest time.
   */
  private requireAgent(id: string, path: string, role: OperationRole): CompileInput["agentDefinitionRevisions"][number] {
    const revision = this.agents.get(id);
    if (revision === undefined) reject("invalid_agent_definition_revision", `Agent Definition revision ${id} is not executable by this Run`, path);
    if (revision.definitionName === ORCHESTRATOR_DEFINITION_NAME && role !== "orchestrator") {
      reject("invalid_role_binding", `the ${ORCHESTRATOR_DEFINITION_NAME} definition cannot be bound to the ${role} role`, path);
    }
    return revision;
  }

  private nodeOptions(expression: PlanExpression, path: string): NodeOptions {
    for (const id of expression.gateAcceptanceCriterionIds ?? []) {
      if (!this.acceptanceCriterionIds.has(id)) reject("invalid_acceptance_criterion_reference", `node_exit Gate names unknown Acceptance Criterion ${id}`, path);
    }
    return {
      allocation: expression.allocation ?? this.input.defaults.nodeAllocation,
      maxConcurrency: expression.limits?.maxConcurrency ?? null,
      maxWallClockMs: expression.limits?.maxWallClockMs ?? null,
      onAllocationExhausted: expression.onAllocationExhausted ?? "fail",
      runOnDependencyFailure: expression.runOnDependencyFailure ?? false,
      gateAcceptanceCriterionIds: [...(expression.gateAcceptanceCriterionIds ?? [])],
    };
  }

  /** Rule 7: expand named roots to the exact leaf set at the pinned revision; otherwise inherit. */
  private resolveScope(scope: PlanScope | undefined, inherited: PlanNodeScope | null, path: string): PlanNodeScope | null {
    if (scope === undefined) return inherited;
    const revision = this.requirementRevisions.get(scope.requirementRevisionId);
    if (!revision) reject("invalid_requirement_scope", `Requirement revision ${scope.requirementRevisionId} does not exist`, path);
    if (revision.conversationId !== this.input.conversationId) {
      reject("invalid_requirement_scope", `Requirement revision ${scope.requirementRevisionId} belongs to another Conversation`, path);
    }
    const inTree = new Set(revision.tree.map((e) => e.id));
    for (const rootId of scope.requirementRootIds) {
      if (!inTree.has(rootId)) reject("invalid_requirement_scope", `Requirement ${rootId} does not exist at revision ${scope.requirementRevisionId}`, path);
    }
    const leaves = expandRequirementRoots(revision.tree, scope.requirementRootIds);
    for (const leafId of leaves) {
      const requirement = this.requirements.get(leafId);
      if (!requirement) reject("invalid_requirement_scope", `Requirement ${leafId} is not a Requirement of this Conversation`, path);
      if (requirement.conversationId !== this.input.conversationId) reject("invalid_requirement_scope", `Requirement ${leafId} belongs to another Conversation`, path);
      if (requirement.status === "retired") reject("invalid_requirement_scope", `Requirement ${leafId} is retired`, path);
    }
    return { requirementRevisionId: scope.requirementRevisionId, requirementIds: leaves };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyInput(): ManifestTemplate {
  return { taskIds: [], decisionIds: [], artifactIds: [] };
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareLabels);
}

function normalizeInput(input: ManifestTemplate): ManifestTemplate {
  return { taskIds: sortedUnique(input.taskIds), decisionIds: sortedUnique(input.decisionIds), artifactIds: sortedUnique(input.artifactIds) };
}

function unionInputs(inputs: ManifestTemplate[]): ManifestTemplate {
  return normalizeInput({
    taskIds: inputs.flatMap((i) => i.taskIds),
    decisionIds: inputs.flatMap((i) => i.decisionIds),
    artifactIds: inputs.flatMap((i) => i.artifactIds),
  });
}

/** Canonical label order: UTF-16 code-unit order, independent of locale and insertion order. */
export function compareLabels(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Numbers edges into each target 0..n-1 in emission order (fan-in and item order). */
function assignPositions(edges: RawEdge[]): CompiledDraftEdge[] {
  const counters = new Map<string, number>();
  return edges.map((edge) => {
    const position = counters.get(edge.targetKey) ?? 0;
    counters.set(edge.targetKey, position + 1);
    return { ...edge, position };
  });
}

/** Rejects a draft whose edges form a cycle or name a key that is not a draft node. */
export function assertDraftAcyclic(nodes: readonly CompiledDraftNode[], edges: readonly CompiledDraftEdge[]): void {
  const keys = new Set(nodes.map((n) => n.key));
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!keys.has(edge.sourceKey) || !keys.has(edge.targetKey)) reject("invalid_structure", `edge ${edge.sourceKey} -> ${edge.targetKey} names a node outside the draft`, edge.targetKey);
    const list = adjacency.get(edge.sourceKey) ?? [];
    list.push(edge.targetKey);
    adjacency.set(edge.sourceKey, list);
  }
  const state = new Map<string, "visiting" | "done">();
  const stack: { key: string; next: number }[] = [];
  for (const start of keys) {
    if (state.has(start)) continue;
    state.set(start, "visiting");
    stack.push({ key: start, next: 0 });
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const successors = adjacency.get(frame.key) ?? [];
      if (frame.next >= successors.length) {
        state.set(frame.key, "done");
        stack.pop();
        continue;
      }
      const successor = successors[frame.next]!;
      frame.next += 1;
      const seen = state.get(successor);
      if (seen === "visiting") reject("compiled_graph_cycle", `the compiled graph contains a cycle through ${successor}`, successor);
      if (seen === undefined) {
        state.set(successor, "visiting");
        stack.push({ key: successor, next: 0 });
      }
    }
  }
}

/**
 * Pre-schema checks on a raw proposal that need the precise rejection code
 * the closed set names: a retired or unknown Pattern, an explicit join, and
 * a coordinator_worker whose operands are not leaves or that nests another.
 * Runs after `assertSourceObjectAcyclic`, so recursion is bounded.
 */
export function rawSourceRejections(raw: unknown): PlanRejectionReason[] {
  const reasons: PlanRejectionReason[] = [];
  const known = new Set<string>(PATTERNS);
  const visit = (value: unknown, path: string, insideCoordinatorWorker: boolean): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}/${index}`, insideCoordinatorWorker));
      return;
    }
    const record = value as Record<string, unknown>;
    const pattern = record.pattern;
    if (typeof pattern === "string") {
      if (pattern === "join") reasons.push({ code: "explicit_join", message: "join is a compiler-emitted node kind and cannot be authored", path });
      else if (!known.has(pattern)) reasons.push({ code: "unsupported_pattern", message: `unsupported Pattern ${pattern}`, path });
      else if (pattern === "coordinator_worker") {
        if (insideCoordinatorWorker) reasons.push({ code: "nested_coordinator_worker", message: "a coordinator_worker cannot be nested inside another coordinator_worker", path });
        for (const role of ["coordinator", "worker"] as const) {
          const operand = record[role];
          if (operand !== null && typeof operand === "object" && "pattern" in (operand as object)) {
            reasons.push({ code: "nested_coordinator_worker", message: `coordinator_worker operand ${role} must be a leaf operation`, path: `${path}/${role}` });
          }
        }
      }
    }
    const nested = pattern === "coordinator_worker" || insideCoordinatorWorker;
    for (const [key, member] of Object.entries(record)) visit(member, `${path}/${key}`, nested);
  };
  visit(raw, "$", false);
  return reasons;
}

/** Compiles a validated source into a draft, or reports why it cannot be. */
export function compileExecutionPlan(input: CompileInput): CompileResult {
  try {
    return { accepted: true, draft: new Compilation(input).run() };
  } catch (error) {
    if (error instanceof PlanRejection) return { accepted: false, reasons: error.reasons };
    throw error;
  }
}

/** The ids a source names, so the service can resolve exactly the facts compilation needs. */
export function collectSourceReferences(source: CompileInput["source"]): {
  agentDefinitionRevisionIds: string[];
  requirementRevisionIds: string[];
  taskIds: string[];
  decisionIds: string[];
  artifactIds: string[];
  acceptanceCriterionIds: string[];
} {
  const agents = new Set<string>();
  const revisions = new Set<string>();
  const tasks = new Set<string>();
  const decisions = new Set<string>();
  const artifacts = new Set<string>();
  const criteria = new Set<string>();
  const operation = (op: PlanOperation) => {
    agents.add(op.agentDefinitionRevisionId);
    for (const id of op.input?.taskIds ?? []) tasks.add(id);
    for (const id of op.input?.decisionIds ?? []) decisions.add(id);
    for (const id of op.input?.artifactIds ?? []) artifacts.add(id);
  };
  const visit = (expression: PlanExpression): void => {
    if (expression.scope) revisions.add(expression.scope.requirementRevisionId);
    for (const id of expression.gateAcceptanceCriterionIds ?? []) criteria.add(id);
    switch (expression.pattern) {
      case "single":
        operation(expression.operation);
        return;
      case "chain":
        expression.steps.forEach(visit);
        return;
      case "route":
        if (expression.selector.kind === "evaluator") agents.add(expression.selector.agentDefinitionRevisionId);
        else decisions.add(expression.selector.decisionId);
        Object.values(expression.branches).forEach(visit);
        return;
      case "parallel":
        expression.items.forEach(visit);
        if (expression.aggregate) operation(expression.aggregate);
        return;
      case "coordinator_worker":
        operation(expression.coordinator);
        operation(expression.worker);
        return;
      case "evaluator_optimizer":
        visit(expression.producer);
        operation(expression.evaluator);
        return;
    }
  };
  source.expressions.forEach(visit);
  const sorted = (set: Set<string>) => [...set].sort(compareLabels);
  return {
    agentDefinitionRevisionIds: sorted(agents),
    requirementRevisionIds: sorted(revisions),
    taskIds: sorted(tasks),
    decisionIds: sorted(decisions),
    artifactIds: sorted(artifacts),
    acceptanceCriterionIds: sorted(criteria),
  };
}
