/**
 * Persistence test harness: an in-memory database on the fresh schema, a
 * memory blob store, a deterministic clock, and factories that build valid
 * domain objects through the stores themselves.
 */
import {
  canonicalFinalReport,
  CHANGESET_DIFF_MEDIA_TYPE,
  effectiveCapabilityPolicy,
  EMPTY_MANIFEST_TEMPLATE,
  EMPTY_WORKSPACE_CAPABILITY_POLICY,
  FINAL_REPORT_MEDIA_TYPE,
  ROOT_NODE_TITLE,
  ROOT_SOURCE_PATH,
  runtimeToolsFor,
  BUDGET_INCREASE_OPTIONS,
  PUBLISH_OPTIONS,
  SIGNOFF_OPTIONS,
  type PublicationStrategyRequest,
  type AgentDefinitionRevision,
  type AgentDefinitionRevisionId,
  type Allocation,
  type Artifact,
  type BudgetIncrease,
  type BudgetIncreaseOption,
  type BudgetIncreasePartition,
  type BudgetLimits,
  type Changeset,
  type CompiledOperation,
  type CompletionRequest,
  type Conversation,
  type Decision,
  type FinalReport,
  type Gate,
  type Invocation,
  type InvocationPurpose,
  type InvocationRole,
  type JoinPlanNodeDefinition,
  type PatternPlanNodeDefinition,
  type PatternPosition,
  type PlanGraph,
  type PlanNode,
  type PlanNodeScope,
  type RequirementId,
  type RequirementRevision,
  type Run,
  type RuntimeToolCall,
  type SnapshotId,
  type VerificationPolicy,
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

/**
 * A harness over `file` (`:memory:` by default); a reopened file keeps its rows, and the clock, blobs, and id minting may be carried over to
 * simulate one restarted process (or, for `ids`, to mint ids whose order a test controls).
 */
export function openHarness(file = ":memory:", carried: { clock?: TestClock; blobs?: MemoryBlobStore; ids?: PersistenceContext["ids"] } = {}): Harness {
  const database = openDatabase(file);
  const blobs = carried.blobs ?? new MemoryBlobStore();
  const clock = carried.clock ?? testClock();
  const diagnostics: PersistenceDiagnostic[] = [];
  const ctx = createPersistenceContext(database, blobs, { clock: clock.now, diagnostics: (d) => diagnostics.push(d), ...(carried.ids === undefined ? {} : { ids: carried.ids }) });
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
  /** The Run's Gate Evaluator revision (its verification policy names it). */
  evaluator: AgentDefinitionRevision;
  root: PlanNode;
}

export const DEFAULT_MAX_NODE_GATE_CYCLES = 3;

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
export function seedRun(h: Harness, options: { budget?: BudgetLimits; kind?: "code" | "other"; finalReserve?: Allocation; rootAllocation?: Allocation; verificationPolicy?: VerificationPolicy } = {}): Seeded {
  const workspace = h.stores.workspaces.create({ name: "demo", rootPath: `/tmp/demo-${h.ctx.ids("workspace")}`, kind: "git" });
  const conversation = h.stores.conversations.create({ workspaceId: workspace.id, title: "demo" });
  const definition = seedAgentRevision(h);
  const evaluator = seedAgentRevision(h, "evaluator");
  const rootId = h.ctx.ids("planNode");
  let run!: Run;
  h.ctx.tx.write(() => {
    run = h.stores.runs.create({
      conversationId: conversation.id,
      kind: options.kind ?? "code",
      target: { kind: "branch", branch: "main" },
      budget: options.budget ?? DEFAULT_BUDGET,
      finalReserve: options.finalReserve ?? ZERO_RESERVE,
      verificationPolicy: options.verificationPolicy ?? { evaluatorAgentDefinitionRevisionId: evaluator.id, maxNodeGateCycles: DEFAULT_MAX_NODE_GATE_CYCLES, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [] },
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
  return { workspace, conversation, run, definition, evaluator, root: h.stores.plans.transitionNode(rootId, { to: "ready" }) };
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

/**
 * Appends a running worker node to the seeded Run: a `single` worker node
 * or a `coordinator_worker` node, at a fresh source path. Worker, Task, and
 * Coordinator Invocations belong on such a node, never on the root.
 */
export function seedWorkerNode(h: Harness, seeded: Seeded, pattern: "single" | "coordinator_worker" = "single", overrides: Partial<Omit<PatternPlanNodeDefinition, "kind" | "shape">> = {}): PlanNode {
  const sourcePath = overrides.sourcePath ?? `e${h.stores.plans.listNodes(seeded.run.id).length}`;
  const definition = pattern === "single" ? patternDefinition(seeded.definition.id, { ...overrides, sourcePath }) : coordinatorWorkerDefinition(seeded.definition.id, { ...overrides, sourcePath });
  const node = nodeInput(h, definition);
  extendPlan(h, seeded, [node]);
  h.stores.plans.transitionNode(node.id, { to: "ready" });
  return h.stores.plans.transitionNode(node.id, { to: "running" });
}

/** The position a test Invocation occupies by default, from its role, purpose, and owned Task. */
export function defaultPatternPosition(role: InvocationRole, purpose: InvocationPurpose, taskIds: readonly string[]): PatternPosition | null {
  switch (role) {
    case "orchestrator":
      return { kind: "orchestrator" };
    case "worker":
      return purpose === "task" ? { kind: "worker_task", taskId: taskIds[0] as never } : { kind: "single" };
    case "coordinator":
      return { kind: "coordinator_turn" };
    case "evaluator":
      return purpose === "select" ? { kind: "route_selection" } : null;
  }
}

/**
 * A `requested` Completion Request of the seeded Run, built the way the runtime-tool executor builds it: a running root
 * Orchestrator turn with a running Attempt, its accepted `request_completion` call, and the request the call names. The
 * requesting turn then completes (as it must before verification begins), so the root position is free again.
 */
export function seedCompletionRequest(h: Harness, seeded: Seeded): { request: CompletionRequest; invocation: Invocation; call: RuntimeToolCall } {
  // The latest root turn requests completion: an active one is driven through its Attempt, a terminal one is continued by a fresh turn.
  const latest = h.stores.invocations.latestAtPosition(seeded.root.id, "orchestrator");
  const orchestrator = latest !== null && (latest.status === "pending" || latest.status === "running") ? latest : seedInvocation(h, seeded, { role: "orchestrator", purpose: "operator_input", continuedFromInvocationId: latest?.id ?? null, allocation: { costUsd: 0, tokens: 0, attempts: 1 } });
  try {
    h.stores.invocations.getManifest(orchestrator.id);
  } catch {
    seedManifest(h, seeded, orchestrator);
  }
  const attempt = h.stores.invocations.activeAttempt(orchestrator.id) ?? h.stores.invocations.createAttempt({ invocationId: orchestrator.id, startMode: "fresh", resumedFromAttemptId: null });
  if (attempt.status === "pending") h.stores.invocations.transitionAttempt(attempt.id, { to: "running", capacityLeaseId: null });
  const running = orchestrator.status === "pending" ? h.stores.invocations.transition(orchestrator.id, { to: "running" }) : orchestrator;
  const id = h.ctx.ids("completionRequest");
  const { request, call } = h.ctx.tx.write(() => {
    const call = h.stores.runtimeToolCalls.record({ invocationId: running.id, attemptId: attempt.id, tool: "request_completion", callDigest: "0".repeat(64), result: { tool: "request_completion", completionRequestId: id, status: "requested" } });
    const request = h.stores.completionRequests.create({ runId: seeded.run.id, invocationId: running.id, runtimeToolCallId: call.id }, { id });
    return { request, call };
  });
  const result = { status: "completed" as const, artifactIds: [], tasks: [], evidence: [], summary: "requested completion", openItems: [], blocker: null, runOutcome: null, routeSelection: null, evaluation: null, finalReport: null };
  h.stores.invocations.transitionAttempt(attempt.id, { to: "succeeded", result, transcriptArtifactId: null });
  const invocation = h.stores.invocations.transition(running.id, { to: "succeeded", result });
  return { request, invocation, call };
}

/**
 * An open `run_completion` Gate of the seeded Run for a fresh Completion Request, pinning the Conversation's current
 * Requirement revision (a one-leaf revision is created when none exists) and the Run's current or base Snapshot (a
 * Snapshot is taken when none exists); the request is moved to `verifying` on it.
 */
export function seedRunCompletionGate(h: Harness, seeded: Seeded, overrides: Partial<{ acceptanceCriterionIds: string[]; candidateArtifactIds: string[] }> = {}) {
  const open = h.stores.gates.openRunGateOf(seeded.run.id, "run_completion");
  if (open !== null) {
    // Idempotent: the Run's one open completion Gate serves every fixture of a test.
    return { gate: open, request: h.stores.completionRequests.get(open.completionRequestId!), revision: h.stores.requirements.getRevision(open.requirementRevisionId!), snapshotId: open.snapshotId! };
  }
  const { request } = seedCompletionRequest(h, seeded);
  const revision = h.stores.requirements.currentRevision(seeded.conversation.id) ?? seedRequirements(h, seeded, 1).revision;
  const run = h.stores.runs.get(seeded.run.id);
  const snapshotId = run.integrationSnapshotId ?? run.baseSnapshotId ?? seedSnapshot(h, seeded, "integration").id;
  const parents = new Set(revision.tree.map((e) => e.parentId).filter((id) => id !== null));
  const requirementIds = revision.tree.filter((e) => !parents.has(e.id)).map((e) => e.id).sort();
  return h.ctx.tx.write(() => {
    const gate = h.stores.gates.open({
      runId: seeded.run.id,
      planNodeId: null,
      kind: "run_completion",
      acceptanceCriterionIds: [...(overrides.acceptanceCriterionIds ?? [])].sort() as never,
      snapshotId,
      candidateArtifactIds: [...(overrides.candidateArtifactIds ?? [])].sort() as never,
      completionRequestId: request.id,
      requirementRevisionId: revision.id,
      requirementIds,
    });
    const verifying = h.stores.completionRequests.transition(request.id, { to: "verifying", gateId: gate.id });
    return { gate, request: verifying, revision, snapshotId };
  });
}

/**
 * A test Invocation. A position-less Evaluator (`evaluate` outside a Pattern position) is a Gate Evaluator and needs a
 * Gate: `gateId` names one, or a `run_completion` Gate of the Run is opened for it (with its Completion Request); it
 * then executes the Run's verification-policy Evaluator revision.
 */
export function seedInvocation(
  h: Harness,
  seeded: Seeded,
  overrides: Partial<{ role: InvocationRole; purpose: InvocationPurpose; planNodeId: string; allocation: Allocation; continuedFromInvocationId: string | null; patternPosition: PatternPosition | null; gateId: string | null; taskIds: string[]; agentDefinitionRevisionId: string }> = {},
): Invocation {
  const role = overrides.role ?? "orchestrator";
  const purpose = overrides.purpose ?? "operator_input";
  const taskIds = overrides.taskIds ?? [];
  const patternPosition = overrides.patternPosition === undefined ? defaultPatternPosition(role, purpose, taskIds) : overrides.patternPosition;
  const gateId = patternPosition !== null ? null : (overrides.gateId ?? seedRunCompletionGate(h, seeded).gate.id);
  return h.stores.invocations.create({
    runId: seeded.run.id,
    planNodeId: (overrides.planNodeId ?? seeded.root.id) as never,
    role,
    purpose,
    agentDefinitionRevisionId: (overrides.agentDefinitionRevisionId ?? (gateId !== null ? seeded.run.verificationPolicy.evaluatorAgentDefinitionRevisionId ?? seeded.evaluator.id : seeded.definition.id)) as never,
    continuedFromInvocationId: (overrides.continuedFromInvocationId ?? null) as never,
    patternPosition,
    gateId: gateId as never,
    taskIds: taskIds as never,
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
    patternPosition: invocation.patternPosition,
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
    runtimeTools: runtimeToolsFor(invocation.role, invocation.purpose),
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

/** The open signoff boundary of a Run built through the stores: what the completion engine leaves behind when its Gate passed. */
export interface SeededSignoffBoundary {
  run: Run;
  completionGate: Gate;
  request: CompletionRequest;
  report: Artifact;
  /** The open `operator_signoff` Gate. */
  gate: Gate;
  /** Its open `signoff` Decision. */
  decision: Decision;
  baseSnapshotId: SnapshotId;
  /** The verified Snapshot the operator is asked to accept (the completion Gate's pinned Snapshot). */
  verifiedSnapshotId: SnapshotId;
}

/**
 * Moves the seeded Run to `awaiting_signoff` the way the completion engine does: a base Snapshot recorded when none
 * exists (and, with `distinctIntegrationSnapshot`, a separate integration Snapshot), a passed `run_completion` Gate with
 * its final-report Artifact, the passed Completion Request, the open `operator_signoff` Gate, and its one `signoff`
 * Decision, all in one transaction.
 */
export function seedSignoffBoundary(h: Harness, seeded: Seeded, options: { distinctIntegrationSnapshot?: boolean } = {}): SeededSignoffBoundary {
  const runId = seeded.run.id;
  let run = h.stores.runs.get(runId);
  if (run.baseSnapshotId === null) run = h.stores.runs.recordWorkspaceState(runId, { baseSnapshotId: seedSnapshot(h, seeded, "run_start").id });
  if (options.distinctIntegrationSnapshot && run.integrationSnapshotId === null) {
    const integration = h.stores.snapshots.record({ workspaceId: seeded.workspace.id, runId, identity: { kind: "git", commitId: "c".repeat(40), treeId: "d".repeat(40) }, reason: "integration" });
    run = h.stores.runs.recordWorkspaceState(runId, { integrationSnapshotId: integration.id });
  }
  const { gate, request, revision } = seedRunCompletionGate(h, seeded);
  if (h.stores.runs.get(runId).status === "running") h.stores.runs.transition(runId, { to: "verifying" });
  return h.ctx.tx.write(() => {
    const report: FinalReport = { version: 1, runId, completionRequestId: request.id, gateId: gate.id, snapshotId: gate.snapshotId!, requirementRevisionId: revision.id, report: { summary: "done", completed: [], verification: [], risks: [], followUps: [] } };
    const artifact = h.stores.artifacts.create({ runId, mediaType: FINAL_REPORT_MEDIA_TYPE, producer: { kind: "runtime", component: "final_report" }, taskId: null, title: `final report of ${request.id}` }, new TextEncoder().encode(canonicalFinalReport(report)));
    const passed = h.stores.gates.close(gate.id, "passed", null, { reportArtifactId: artifact.id });
    const passedRequest = h.stores.completionRequests.transition(request.id, { to: "passed", reportArtifactId: artifact.id });
    const signoff = h.stores.gates.open({ runId, planNodeId: null, kind: "operator_signoff", acceptanceCriterionIds: [], snapshotId: gate.snapshotId, candidateArtifactIds: gate.candidateArtifactIds, completionRequestId: request.id, requirementRevisionId: gate.requirementRevisionId, requirementIds: gate.requirementIds, completionGateId: gate.id, reportArtifactId: artifact.id });
    const decision = h.stores.decisions.request({
      conversationId: seeded.conversation.id,
      runId,
      kind: "signoff",
      resolutionPolicy: "operator_required",
      requestedBy: { kind: "runtime" },
      question: `Accept the verified result of Run ${runId}?`,
      options: [
        { id: SIGNOFF_OPTIONS[0], label: "Accept", description: null },
        { id: SIGNOFF_OPTIONS[1], label: "Request changes", description: null },
      ],
      recommendedOptionId: null,
      rationale: null,
      affects: { requirementIds: gate.requirementIds, taskIds: [], planNodeIds: [seeded.root.id] },
      deadlineAt: null,
      activationCondition: null,
      subject: { kind: "signoff", runId, gateId: signoff.id, completionGateId: gate.id, completionRequestId: request.id, snapshotId: gate.snapshotId!, reportArtifactId: artifact.id },
      supersedesDecisionId: null,
    });
    const awaiting = h.stores.runs.transition(runId, { to: "awaiting_signoff" });
    return { run: awaiting, completionGate: passed, request: passedRequest, report: artifact, gate: signoff, decision, baseSnapshotId: run.baseSnapshotId!, verifiedSnapshotId: gate.snapshotId! };
  });
}

/** The Run's `final` Changeset over the open signoff boundary: a `text/x-diff` Artifact of `content` (empty by default) from the base to the verified Snapshot. */
export function seedFinalChangeset(h: Harness, seeded: Seeded, boundary: Pick<SeededSignoffBoundary, "baseSnapshotId" | "verifiedSnapshotId">, content = ""): { artifact: Artifact; changeset: Changeset } {
  return h.ctx.tx.write(() => {
    const artifact = h.stores.artifacts.create({ runId: seeded.run.id, mediaType: CHANGESET_DIFF_MEDIA_TYPE, producer: { kind: "runtime", component: "changeset" }, taskId: null, title: `final changeset of ${seeded.run.id}` }, new TextEncoder().encode(content));
    const changeset = h.stores.changesets.recordFinal({ runId: seeded.run.id, beforeSnapshotId: boundary.baseSnapshotId, afterSnapshotId: boundary.verifiedSnapshotId, diffArtifactId: artifact.id });
    return { artifact, changeset };
  });
}

export interface SeededCompletedRun {
  run: Run;
  boundary: SeededSignoffBoundary;
  finalChangeset: Changeset;
}

/** Completes the seeded Run the way signoff acceptance does: boundary, final Changeset, accepted Decision, closed Gate, completed Run. */
export function seedCompletedRun(h: Harness, seeded: Seeded, content = "+final"): SeededCompletedRun {
  const boundary = seedSignoffBoundary(h, seeded, { distinctIntegrationSnapshot: true });
  const { changeset } = seedFinalChangeset(h, seeded, boundary, content);
  return h.ctx.tx.write(() => {
    h.stores.signoffResolutions.record({ runId: seeded.run.id, gateId: boundary.gate.id, decisionId: boundary.decision.id, outcome: "accept", finalChangesetId: changeset.id });
    h.stores.decisions.resolve(boundary.decision.id, { resolvedBy: "operator", chosenOptionId: "accept", rationale: null, artifactIds: [] });
    h.stores.gates.close(boundary.gate.id, "passed", null);
    const run = h.stores.runs.transition(seeded.run.id, { to: "completed", finalSnapshotId: boundary.verifiedSnapshotId, finalChangesetId: changeset.id });
    return { run, boundary, finalChangeset: changeset };
  });
}

/** A resolved `publish` Decision of the completed Run: the operator's exact publication authorization. */
export function seedPublishDecision(h: Harness, seeded: Seeded, completed: SeededCompletedRun, options: { requestedStrategy?: PublicationStrategyRequest; resolve?: "publish" | "cancel" | null } = {}): Decision {
  const requestedStrategy = options.requestedStrategy ?? { kind: "automatic" as const };
  const decision = h.stores.decisions.request({
    conversationId: seeded.conversation.id,
    runId: seeded.run.id,
    kind: "publish",
    resolutionPolicy: "operator_required",
    requestedBy: { kind: "operator" },
    question: `Publish the accepted result of Run ${seeded.run.id}?`,
    options: [
      { id: PUBLISH_OPTIONS[0], label: "Publish", description: null },
      { id: PUBLISH_OPTIONS[1], label: "Cancel", description: null },
    ],
    recommendedOptionId: null,
    rationale: null,
    affects: { requirementIds: [], taskIds: [], planNodeIds: [] },
    deadlineAt: null,
    activationCondition: null,
    subject: { kind: "publish", runId: seeded.run.id, workspaceId: seeded.workspace.id, target: completed.run.target, finalSnapshotId: completed.run.finalSnapshotId!, finalChangesetId: completed.run.finalChangesetId!, requestedStrategy },
    supersedesDecisionId: null,
  });
  const resolve = options.resolve === undefined ? "publish" : options.resolve;
  if (resolve === null) return decision;
  return h.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: resolve, rationale: null, artifactIds: [] });
}

/** A `budget_increase` Decision of the seeded Run, requested the way the Budget Increase service requests it; resolved by the operator when `resolve` names an option. */
export function seedBudgetIncreaseDecision(h: Harness, seeded: Pick<Seeded, "conversation" | "run">, partition: BudgetIncreasePartition, added: Allocation, options: { resolve?: BudgetIncreaseOption | null } = {}): Decision {
  const decision = h.stores.decisions.request({
    conversationId: seeded.conversation.id,
    runId: seeded.run.id,
    kind: "budget_increase",
    resolutionPolicy: "operator_required",
    requestedBy: { kind: "operator" },
    question: `Increase the ${partition} Budget of Run ${seeded.run.id}?`,
    options: [
      { id: BUDGET_INCREASE_OPTIONS[0], label: "Approve", description: null },
      { id: BUDGET_INCREASE_OPTIONS[1], label: "Deny", description: null },
    ],
    recommendedOptionId: null,
    rationale: null,
    affects: { requirementIds: [], taskIds: [], planNodeIds: [] },
    deadlineAt: null,
    activationCondition: null,
    subject: { kind: "budget_increase", runId: seeded.run.id, partition, added },
    supersedesDecisionId: null,
  });
  const resolve = options.resolve === undefined ? "approve" : options.resolve;
  if (resolve === null) return decision;
  return h.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: resolve, rationale: null, artifactIds: [] });
}

/** An approved Budget Increase of the seeded Run: its Decision resolved `approve` by the operator and the one increase it authorizes, in one transaction. */
export function seedBudgetIncrease(h: Harness, seeded: Pick<Seeded, "conversation" | "run">, partition: BudgetIncreasePartition, added: Allocation): { decision: Decision; increase: BudgetIncrease } {
  return h.ctx.tx.write(() => {
    const decision = seedBudgetIncreaseDecision(h, seeded, partition, added);
    const increase = h.stores.budgetIncreases.record({ runId: seeded.run.id, decisionId: decision.id, partition, added });
    return { decision, increase };
  });
}

/** A Snapshot of the publication flow: the Target as found (`publish_before`) or the prepared candidate (`publish_candidate`). */
export function seedPublicationSnapshot(h: Harness, seeded: Seeded, reason: "publish_before" | "publish_candidate", commit = "e".repeat(40)) {
  return h.stores.snapshots.record({ workspaceId: seeded.workspace.id, runId: seeded.run.id, identity: { kind: "git", commitId: commit, treeId: commit.slice(0, 40) }, reason });
}
