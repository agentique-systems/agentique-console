/**
 * Persistence test harness: an in-memory database on the fresh schema, a
 * memory blob store, a deterministic clock, and factories that build valid
 * domain objects through the stores themselves.
 */
import {
  effectiveCapabilityPolicy,
  EMPTY_MANIFEST_TEMPLATE,
  EMPTY_WORKSPACE_CAPABILITY_POLICY,
  ROOT_NODE_TITLE,
  ROOT_SOURCE_PATH,
  RUNTIME_TOOLS_BY_ROLE,
  type AgentDefinitionRevision,
  type AgentDefinitionRevisionId,
  type Allocation,
  type BudgetLimits,
  type CompiledOperation,
  type Conversation,
  type Invocation,
  type InvocationPurpose,
  type InvocationRole,
  type JoinPlanNodeDefinition,
  type PatternPlanNodeDefinition,
  type PlanGraph,
  type PlanNode,
  type PlanNodeScope,
  type RequirementId,
  type RequirementRevision,
  type Run,
  type Workspace,
} from "@agentique-console/core";
import { MemoryBlobStore } from "./blob-store.ts";
import { createPersistenceContext, type PersistenceContext, type PersistenceDiagnostic } from "./context.ts";
import { openDatabase, type OpenedDatabase } from "./database.ts";
import { createStores, type Stores } from "./stores/index.ts";
import type { RevisionEdgeInput, RevisionNodeInput } from "./stores/plans.ts";

export interface TestClock {
  now: () => string;
  advance: (ms: number) => void;
  set: (iso: string) => void;
}

export function testClock(start = "2026-01-01T00:00:00.000Z"): TestClock {
  let current = Date.parse(start);
  return {
    now: () => {
      current += 1;
      return new Date(current).toISOString();
    },
    advance: (ms) => {
      current += ms;
    },
    set: (iso) => {
      current = Date.parse(iso);
    },
  };
}

export interface Harness {
  database: OpenedDatabase;
  ctx: PersistenceContext;
  stores: Stores;
  blobs: MemoryBlobStore;
  clock: TestClock;
  /** Every diagnostic the persistence layer reported, in order. */
  diagnostics: PersistenceDiagnostic[];
  close(): void;
}

/** A harness over `file` (`:memory:` by default); a reopened file keeps its rows, and the clock and blobs may be carried over to simulate one restarted process. */
export function openHarness(file = ":memory:", carried: { clock?: TestClock; blobs?: MemoryBlobStore } = {}): Harness {
  const database = openDatabase(file);
  const blobs = carried.blobs ?? new MemoryBlobStore();
  const clock = carried.clock ?? testClock();
  const diagnostics: PersistenceDiagnostic[] = [];
  const ctx = createPersistenceContext(database, blobs, { clock: clock.now, diagnostics: (d) => diagnostics.push(d) });
  const stores = createStores(ctx);
  return { database, ctx, stores, blobs, clock, diagnostics, close: () => database.close() };
}

export const DEFAULT_BUDGET: BudgetLimits = {
  maxCostUsd: 100,
  maxTokens: 1_000_000,
  maxAttempts: 50,
  maxWallClockMs: null,
  maxConcurrency: 4,
};

export const ZERO_RESERVE: Allocation = { costUsd: 0, tokens: 0, attempts: 0 };
export const DEFAULT_FINAL_RESERVE: Allocation = { costUsd: 5, tokens: 50_000, attempts: 3 };
export const SMALL_ALLOCATION: Allocation = { costUsd: 10, tokens: 100_000, attempts: 5 };
export const INVOCATION_ALLOCATION: Allocation = { costUsd: 2, tokens: 20_000, attempts: 2 };

export interface Seeded {
  workspace: Workspace;
  conversation: Conversation;
  run: Run;
  definition: AgentDefinitionRevision;
  root: PlanNode;
}

export function seedAgentRevision(h: Harness, name = "orchestrator"): AgentDefinitionRevision {
  const definition = h.stores.agents.ensureDefinition(name);
  return h.stores.agents.appendRevision(definition.id, {
    provenance: { kind: "builtin" },
    modelPolicy: { model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8 },
    instructions: `You are the ${name}.`,
    capabilities: { tools: ["read", "write", "shell"], mcpServers: [] },
    toolPolicy: { read: "allowed", write: "allowed", shell: "approval_required" },
    defaultLimits: { allocation: INVOCATION_ALLOCATION, maxWallClockMs: 600_000 },
  });
}

export function operation(agentDefinitionRevisionId: string, title = "step", role: CompiledOperation["role"] = "worker"): CompiledOperation {
  return { agentDefinitionRevisionId: agentDefinitionRevisionId as AgentDefinitionRevisionId, title, input: { ...EMPTY_MANIFEST_TEMPLATE }, role, readOnly: role === "evaluator" };
}

/** A `single` worker node definition; override any field. */
export function patternDefinition(
  agentDefinitionRevisionId: string,
  overrides: Partial<Omit<PatternPlanNodeDefinition, "kind" | "shape">> & { shape?: PatternPlanNodeDefinition["shape"]; scope?: PlanNodeScope | null } = {},
): PatternPlanNodeDefinition {
  const shape = overrides.shape ?? { pattern: "single", role: "worker", operation: operation(agentDefinitionRevisionId, overrides.title ?? "node") };
  return {
    kind: "pattern",
    pattern: shape.pattern,
    title: "node",
    sourcePath: "e0",
    allocation: SMALL_ALLOCATION,
    maxConcurrency: null,
    maxWallClockMs: null,
    runOnDependencyFailure: false,
    input: { ...EMPTY_MANIFEST_TEMPLATE },
    onAllocationExhausted: "fail",
    gateAcceptanceCriterionIds: [],
    scope: null,
    ...overrides,
    shape,
  };
}

export function coordinatorWorkerDefinition(agentDefinitionRevisionId: string, overrides: Partial<Omit<PatternPlanNodeDefinition, "kind" | "shape">> = {}): PatternPlanNodeDefinition {
  return patternDefinition(agentDefinitionRevisionId, {
    ...overrides,
    shape: {
      pattern: "coordinator_worker",
      coordinator: operation(agentDefinitionRevisionId, "coordinator", "coordinator"),
      worker: operation(agentDefinitionRevisionId, "worker"),
      bounds: { maxTasks: 8, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 },
    },
  });
}

export function joinDefinition(overrides: Partial<Omit<JoinPlanNodeDefinition, "kind">> = {}): JoinPlanNodeDefinition {
  return {
    kind: "join",
    fanInPolicy: "require_all",
    title: "join",
    sourcePath: "e0/join",
    allocation: { costUsd: 0, tokens: 0, attempts: 0 },
    maxConcurrency: null,
    maxWallClockMs: null,
    runOnDependencyFailure: false,
    ...overrides,
  };
}

export function rootDefinition(agentDefinitionRevisionId: string, allocation: Allocation = SMALL_ALLOCATION): PatternPlanNodeDefinition {
  return patternDefinition(agentDefinitionRevisionId, {
    title: ROOT_NODE_TITLE,
    sourcePath: ROOT_SOURCE_PATH,
    allocation,
    onAllocationExhausted: "extend",
    shape: { pattern: "single", role: "orchestrator", operation: operation(agentDefinitionRevisionId, ROOT_NODE_TITLE, "orchestrator") },
  });
}

/** Mints an id for a definition so it can be handed to `materializeRevision`. */
export function nodeInput(h: Harness, definition: RevisionNodeInput["definition"]): RevisionNodeInput {
  return { id: h.ctx.ids("planNode"), definition };
}

/**
 * Workspace, Conversation, Run (running), an Agent Definition revision, and
 * the root node: the Run's complete initial state built through the stores,
 * the way the Run creation service builds it.
 */
export function seedRun(h: Harness, options: { budget?: BudgetLimits; kind?: "code" | "other"; finalReserve?: Allocation; rootAllocation?: Allocation } = {}): Seeded {
  const workspace = h.stores.workspaces.create({ name: "demo", rootPath: `/tmp/demo-${h.ctx.ids("workspace")}`, kind: "git" });
  const conversation = h.stores.conversations.create({ workspaceId: workspace.id, title: "demo" });
  const definition = seedAgentRevision(h);
  const rootId = h.ctx.ids("planNode");
  let run!: Run;
  h.ctx.tx.write(() => {
    run = h.stores.runs.create({
      conversationId: conversation.id,
      kind: options.kind ?? "code",
      target: { kind: "branch", branch: "main" },
      budget: options.budget ?? DEFAULT_BUDGET,
      finalReserve: options.finalReserve ?? ZERO_RESERVE,
    });
    h.stores.plans.appendRevision(run.id, { version: 1, expressions: [] }, null);
    h.stores.plans.materializeRevision({
      runId: run.id,
      revisionNumber: 1,
      membership: [rootId],
      createdNodes: [{ id: rootId, definition: rootDefinition(definition.id, options.rootAllocation) }],
      edges: [],
      cancelledNodeIds: [],
    });
  });
  run = h.stores.runs.transition(run.id, { to: "running" });
  return { workspace, conversation, run, definition, root: h.stores.plans.transitionNode(rootId, { to: "ready" }) };
}

/**
 * Appends an accepted revision that keeps every current member and adds
 * `nodes` with `edges`, the way the plan-revision service does after
 * reconciliation; returns the new graph.
 */
export function extendPlan(h: Harness, seeded: Seeded, nodes: RevisionNodeInput[], edges: RevisionEdgeInput[] = []): PlanGraph {
  return h.ctx.tx.write(() => {
    const current = h.stores.plans.currentGraph(seeded.run.id);
    const revision = h.stores.plans.appendRevision(seeded.run.id, { version: 1, expressions: [] }, null);
    return h.stores.plans.materializeRevision({
      runId: seeded.run.id,
      revisionNumber: revision.number,
      membership: [...current.nodes.map((n) => n.id), ...nodes.map((n) => n.id)],
      createdNodes: nodes,
      edges: [...current.edges.map((e) => ({ sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId, type: e.type, position: e.position, ...(e.type === "branch" ? { label: e.label } : {}), ...(e.type === "retry" ? { round: e.round } : {}) })), ...edges],
      cancelledNodeIds: [],
    });
  });
}

export function seedInvocation(
  h: Harness,
  seeded: Seeded,
  overrides: Partial<{ role: InvocationRole; purpose: InvocationPurpose; planNodeId: string; allocation: Allocation; continuedFromInvocationId: string | null }> = {},
): Invocation {
  return h.stores.invocations.create({
    runId: seeded.run.id,
    planNodeId: (overrides.planNodeId ?? seeded.root.id) as never,
    role: overrides.role ?? "orchestrator",
    purpose: overrides.purpose ?? "operator_input",
    agentDefinitionRevisionId: seeded.definition.id,
    continuedFromInvocationId: (overrides.continuedFromInvocationId ?? null) as never,
    taskIds: [],
    allocation: overrides.allocation ?? INVOCATION_ALLOCATION,
  });
}

/** A minimal valid manifest for a seeded Invocation: the effective policy of its definition in its role, no inputs. */
export function seedManifest(h: Harness, seeded: Seeded, invocation: Invocation, definition: AgentDefinitionRevision = seeded.definition) {
  const policy = effectiveCapabilityPolicy(definition, invocation.role, EMPTY_WORKSPACE_CAPABILITY_POLICY);
  const tasks = [...invocation.taskIds].sort().map((taskId) => ({ taskId, subject: h.stores.tasks.get(taskId).subject }));
  return h.stores.invocations.putManifest(invocation.id, {
    agentDefinitionRevisionId: invocation.agentDefinitionRevisionId,
    agentDefinitionContentHash: definition.contentHash,
    instructions: definition.instructions,
    modelPolicy: definition.modelPolicy,
    role: invocation.role,
    purpose: invocation.purpose,
    patternPosition: null,
    continuedFromInvocationId: invocation.continuedFromInvocationId,
    runId: invocation.runId,
    planNodeId: invocation.planNodeId,
    tasks,
    requirementRevisionId: null,
    requirements: [],
    acceptanceCriteria: [],
    decisions: [],
    inputs: [],
    handoffs: [],
    artifacts: [],
    startingSnapshotId: null,
    worktreePath: null,
    allocation: invocation.allocation,
    allocationSource: invocation.allocationSource,
    finalReserveUse: invocation.finalReserveUse,
    maxWallClockMs: null,
    capabilities: policy.capabilities,
    toolPolicy: policy.toolPolicy,
    runtimeTools: [...RUNTIME_TOOLS_BY_ROLE[invocation.role]],
    approvedCalls: [],
  });
}

export function seedRequirements(h: Harness, seeded: Seeded, leafCount = 2): { revision: RequirementRevision; rootId: RequirementId; leafIds: RequirementId[] } {
  const rootId = h.ctx.ids("requirement");
  const leafIds = Array.from({ length: leafCount }, () => h.ctx.ids("requirement"));
  const revision = h.stores.requirements.createRevision({
    conversationId: seeded.conversation.id,
    approvedByDecisionId: null,
    tree: [
      { id: rootId, parentId: null, composition: "all", statement: "The feature works", position: 0, acceptanceCriterionIds: [] },
      ...leafIds.map((id, index) => ({ id, parentId: rootId, composition: null, statement: `Leaf ${index + 1}`, position: index, acceptanceCriterionIds: [] })),
    ],
  });
  return { revision, rootId, leafIds };
}

export function seedArtifact(h: Harness, seeded: Seeded, content = "hello", producer?: { invocationId: string }) {
  return h.stores.artifacts.create(
    {
      runId: seeded.run.id,
      mediaType: "text/plain",
      producer: producer ? { kind: "invocation", invocationId: producer.invocationId as never, attemptId: null } : { kind: "runtime", component: "command" },
      taskId: null,
      title: null,
    },
    new TextEncoder().encode(content),
  );
}

export function seedSnapshot(h: Harness, seeded: Seeded, reason: "run_start" | "integration" | "run_completion" = "run_start") {
  return h.stores.snapshots.record({
    workspaceId: seeded.workspace.id,
    runId: seeded.run.id,
    identity: { kind: "git", commitId: "a".repeat(40), treeId: "b".repeat(40) },
    reason,
  });
}
