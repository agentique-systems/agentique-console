/**
 * Persistence test harness: an in-memory database on the fresh schema, a
 * memory blob store, a deterministic clock, and factories that build valid
 * domain objects through the stores themselves.
 */
import {
  ROOT_SOURCE_PATH,
  type AgentDefinitionRevision,
  type Allocation,
  type BudgetLimits,
  type Conversation,
  type Invocation,
  type InvocationPurpose,
  type InvocationRole,
  type PlanNode,
  type RequirementId,
  type RequirementRevision,
  type Run,
  type Workspace,
} from "@agentique-console/core";
import { MemoryBlobStore } from "./blob-store.ts";
import { createPersistenceContext, type PersistenceContext, type PersistenceDiagnostic } from "./context.ts";
import { openDatabase, type OpenedDatabase } from "./database.ts";
import { createStores, type Stores } from "./stores/index.ts";
import type { CompiledPlanNode } from "./stores/plans.ts";

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

export function openHarness(): Harness {
  const database = openDatabase(":memory:");
  const blobs = new MemoryBlobStore();
  const clock = testClock();
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

export function patternNode(h: Harness, run: Run, overrides: Partial<CompiledPlanNode> & { agentDefinitionRevisionId: string }): CompiledPlanNode {
  const { agentDefinitionRevisionId, ...rest } = overrides;
  return {
    id: h.ctx.ids("planNode"),
    runId: run.id,
    revisionNumber: 1,
    kind: "pattern",
    pattern: "single",
    title: "node",
    sourcePath: "0",
    allocation: SMALL_ALLOCATION,
    maxConcurrency: null,
    maxWallClockMs: null,
    runOnDependencyFailure: false,
    input: { taskIds: [], decisionIds: [], artifactIds: [] },
    agents: { worker: agentDefinitionRevisionId as never },
    bounds: {},
    onAllocationExhausted: "fail",
    gateAcceptanceCriterionIds: [],
    ...rest,
  } as CompiledPlanNode;
}

export function joinNode(h: Harness, run: Run, overrides: Partial<CompiledPlanNode> = {}): CompiledPlanNode {
  return {
    id: h.ctx.ids("planNode"),
    runId: run.id,
    revisionNumber: 1,
    kind: "join",
    fanInPolicy: "require_all",
    title: "join",
    sourcePath: "0.join",
    allocation: { costUsd: 0, tokens: 0, attempts: 0 },
    maxConcurrency: null,
    maxWallClockMs: null,
    runOnDependencyFailure: false,
    ...overrides,
  } as CompiledPlanNode;
}

/** Workspace, Conversation, Run (running), an Agent Definition revision, and the root node. */
export function seedRun(h: Harness, options: { budget?: BudgetLimits; kind?: "code" | "other" } = {}): Seeded {
  const workspace = h.stores.workspaces.create({ name: "demo", rootPath: `/tmp/demo-${h.ctx.ids("workspace")}`, kind: "git" });
  const conversation = h.stores.conversations.create({ workspaceId: workspace.id, title: "demo" });
  const definition = seedAgentRevision(h);
  let run = h.stores.runs.create({
    conversationId: conversation.id,
    kind: options.kind ?? "code",
    target: { kind: "branch", branch: "main" },
    budget: options.budget ?? DEFAULT_BUDGET,
  });
  h.stores.plans.appendRevision(run.id, { version: 1, expressions: [] }, null);
  const { nodes } = h.stores.plans.insertCompiledGraph({
    runId: run.id,
    revisionNumber: 1,
    nodes: [
      patternNode(h, run, {
        agentDefinitionRevisionId: definition.id,
        title: "Orchestrator",
        sourcePath: ROOT_SOURCE_PATH,
        agents: { orchestrator: definition.id },
        onAllocationExhausted: "extend",
      }),
    ],
    edges: [],
    requirements: [],
  });
  run = h.stores.runs.transition(run.id, { to: "running" });
  const root = nodes[0] as PlanNode;
  return { workspace, conversation, run, definition, root: h.stores.plans.transitionNode(root.id, { to: "ready" }) };
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

export function seedManifest(h: Harness, seeded: Seeded, invocation: Invocation) {
  return h.stores.invocations.putManifest(invocation.id, {
    agentDefinitionRevisionId: invocation.agentDefinitionRevisionId,
    agentDefinitionContentHash: seeded.definition.contentHash,
    instructions: seeded.definition.instructions,
    role: invocation.role,
    purpose: invocation.purpose,
    patternPosition: null,
    continuedFromInvocationId: invocation.continuedFromInvocationId,
    runId: invocation.runId,
    planNodeId: invocation.planNodeId,
    tasks: [],
    requirementRevisionId: null,
    requirements: [],
    decisions: [],
    handoffIds: [],
    readableArtifactIds: [],
    startingSnapshotId: null,
    worktreePath: null,
    allocation: invocation.allocation,
    maxWallClockMs: null,
    toolPolicy: seeded.definition.toolPolicy,
    runtimeTools: ["return_result"],
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
