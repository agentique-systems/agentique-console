/**
 * Runtime test harness: the persistence harness plus the execution services
 * over a deterministic fake Workspace preparation port.
 */
import { DEFAULT_PLAN_LIMITS, type AgentDefinitionRevision, type Invocation, type PlanExpression, type PlanLimits } from "@agentique-console/core";
import { DEFAULT_BUDGET, INVOCATION_ALLOCATION, openHarness, seedAgentRevision, type Harness } from "../persistence/test-support.ts";
import { PlanRevisionService, type PlanRevisionOutcome } from "./plan-revision-service.ts";
import type { PreparedRunWorkspace, RunWorkspacePreparationPort, RunWorkspacePreparationRequest } from "./ports/workspace-preparation.ts";
import { RunCreationService, type CreatedRun, type RunCreationPolicy, type RunCreationRequest } from "./run-creation-service.ts";

/** A deterministic Workspace preparation port that records what it did and can be told to fail. */
export class FakeWorkspacePreparation implements RunWorkspacePreparationPort {
  readonly prepared: { request: RunWorkspacePreparationRequest; result: PreparedRunWorkspace }[] = [];
  readonly discarded: { request: RunWorkspacePreparationRequest; prepared: PreparedRunWorkspace }[] = [];
  failWith: Error | null = null;
  /** When set, the next preparation returns this Snapshot identity (to provoke a persistence failure after preparation). */
  nextBaseSnapshot: PreparedRunWorkspace["baseSnapshot"] | null = null;

  prepare(request: RunWorkspacePreparationRequest): PreparedRunWorkspace {
    if (this.failWith) {
      const error = this.failWith;
      this.failWith = null;
      throw error;
    }
    const baseSnapshot = this.nextBaseSnapshot ?? (request.workspace.kind === "git" ? { kind: "git" as const, commitId: "a".repeat(40), treeId: "b".repeat(40) } : { kind: "directory" as const, contentDigest: "c".repeat(64) });
    this.nextBaseSnapshot = null;
    const result = { baseSnapshot, integrationWorkspacePath: `${request.workspace.rootPath}/.agentique/runs/${request.runId}` };
    this.prepared.push({ request, result });
    return result;
  }

  discard(request: RunWorkspacePreparationRequest, prepared: PreparedRunWorkspace): void {
    this.discarded.push({ request, prepared });
  }
}

export const TEST_POLICY: RunCreationPolicy = {
  initialOrchestratorAllocation: { costUsd: 10, tokens: 100_000, attempts: 5 },
  finalReserve: { code: { costUsd: 5, tokens: 50_000, attempts: 3 }, other: { costUsd: 0, tokens: 0, attempts: 0 } },
};

export const TEST_NODE_ALLOCATION = { costUsd: 4, tokens: 40_000, attempts: 2 };

export interface RuntimeHarness extends Harness {
  workspacePreparation: FakeWorkspacePreparation;
  runCreation: RunCreationService;
  planRevisions: PlanRevisionService;
}

export function openRuntimeHarness(limits: PlanLimits = DEFAULT_PLAN_LIMITS): RuntimeHarness {
  const h = openHarness();
  const workspacePreparation = new FakeWorkspacePreparation();
  return {
    ...h,
    workspacePreparation,
    runCreation: new RunCreationService(h.ctx, h.stores, workspacePreparation, TEST_POLICY),
    planRevisions: new PlanRevisionService(h.ctx, h.stores, {
      defaults: { nodeAllocation: TEST_NODE_ALLOCATION, coordinatorWorkerBounds: { maxTasks: 8, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 } },
      limits,
    }),
  };
}

export interface RuntimeSeed {
  created: CreatedRun;
  orchestrator: AgentDefinitionRevision;
  worker: AgentDefinitionRevision;
  invocation: Invocation;
}

/** Workspace, Conversation, Orchestrator and worker definitions, a created Run, and an Orchestrator Invocation to propose with. */
export function seedRuntime(h: RuntimeHarness, overrides: Partial<RunCreationRequest> = {}): RuntimeSeed {
  const workspace = h.stores.workspaces.create({ name: "demo", rootPath: `/tmp/demo-${h.ctx.ids("workspace")}`, kind: "git" });
  const conversation = h.stores.conversations.create({ workspaceId: workspace.id, title: "demo" });
  const orchestrator = seedAgentRevision(h, "orchestrator");
  const worker = seedAgentRevision(h, "worker");
  const created = h.runCreation.create({
    conversationId: conversation.id,
    kind: "code",
    target: { kind: "branch", branch: "main" },
    budget: DEFAULT_BUDGET,
    orchestratorAgentDefinitionRevisionId: orchestrator.id,
    ...overrides,
  });
  const invocation = h.stores.invocations.create({
    runId: created.run.id,
    planNodeId: created.root.id,
    role: "orchestrator",
    purpose: "operator_input",
    agentDefinitionRevisionId: orchestrator.id,
    continuedFromInvocationId: null,
    taskIds: [],
    allocation: INVOCATION_ALLOCATION,
  });
  return { created, orchestrator, worker, invocation };
}

export function propose(h: RuntimeHarness, seed: RuntimeSeed, expressions: PlanExpression[], options: { correlationId?: string; causationSeq?: number } = {}): PlanRevisionOutcome {
  return h.planRevisions.propose({
    runId: seed.created.run.id,
    proposedByInvocationId: seed.invocation.id,
    source: { version: 1, expressions },
    correlationId: options.correlationId ?? null,
    causationSeq: options.causationSeq ?? null,
  });
}

export function accepted(outcome: PlanRevisionOutcome): Extract<PlanRevisionOutcome, { accepted: true }> {
  if (!outcome.accepted) throw new Error(`rejected: ${outcome.reasons.map((r) => `${r.code}: ${r.message}`).join("; ")}`);
  return outcome;
}

export function rejected(outcome: PlanRevisionOutcome): Extract<PlanRevisionOutcome, { accepted: false }> {
  if (outcome.accepted) throw new Error("expected a rejection");
  return outcome;
}
