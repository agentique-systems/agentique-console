/**
 * Test support for coordinator_worker scenarios: a scoped coordinator node,
 * proposal and cancellation call builders, scripted Coordinator turns, and
 * Worker and synthesis steps derived from the Task each Invocation owns.
 */
import type { AgentDefinitionRevision, ArtifactId, Attempt, Invocation, PlanExpression, PlanNode, RequirementId, RuntimeToolCallRequest, TaskId, TaskProposal } from "@agentique-console/core";
import type { FakeStep } from "../provider/fake.ts";
import { RuntimeToolExecutor } from "./runtime-tools.ts";
import { COMPLETED_RESULT, fakeSnapshot, planNodes, seedPlanningRuntime, TEST_GOVERNOR, type RuntimeHarness } from "./test-support.ts";
import type { ExecutionDiagnosticSink } from "./workspace-cleanup.ts";

export const WIDE_GOVERNOR = { ...TEST_GOVERNOR, providers: { fake: { maxConcurrency: 8 } }, maxProcessConcurrency: 8 };
export const COORDINATOR_NODE_ALLOCATION = { costUsd: 40, tokens: 400_000, attempts: 40 };

export type PlanningSeed = ReturnType<typeof seedPlanningRuntime>;

export interface CoordinatorNodeOptions {
  bounds?: { maxTasks: number; maxConcurrentWorkers: number; maxCoordinatorInvocations: number };
  gate?: string[];
  leaves?: number;
  allocation?: { costUsd: number; tokens: number; attempts: number };
  /** The Coordinator Agent Definition revision; the seeded worker revision by default. */
  coordinator?: string;
}

/** A coordinator_worker node scoped to a fresh Requirement tree (one root, `leaves` leaves) of the Conversation. */
export function coordinatorNode(h: RuntimeHarness, s: PlanningSeed, options: CoordinatorNodeOptions = {}) {
  const rootId = h.ctx.ids("requirement");
  const leafIds = Array.from({ length: options.leaves ?? 2 }, () => h.ctx.ids("requirement"));
  const revision = h.stores.requirements.createRevision({
    conversationId: s.created.run.conversationId,
    approvedByDecisionId: null,
    tree: [
      { id: rootId, parentId: null, composition: "all", statement: "The CLI reports its version", position: 0, acceptanceCriterionIds: [] },
      ...leafIds.map((id, index) => ({ id, parentId: rootId, composition: null, statement: `Leaf ${index + 1}`, position: index, acceptanceCriterionIds: [] })),
    ],
  });
  const expression: PlanExpression = {
    pattern: "coordinator_worker",
    coordinator: { agentDefinitionRevisionId: (options.coordinator ?? s.worker.id) as never, title: "coordinator" },
    worker: { agentDefinitionRevisionId: s.worker.id, title: "worker" },
    bounds: options.bounds ?? { maxTasks: 6, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 },
    scope: { requirementRootIds: [rootId], requirementRevisionId: revision.id },
    allocation: options.allocation ?? COORDINATOR_NODE_ALLOCATION,
    ...(options.gate ? { gateAcceptanceCriterionIds: options.gate as never } : {}),
  };
  const { nodes, revisionNumber } = planNodes(h, s, [expression]);
  return { node: nodes[0]!, revisionNumber, leafIds, revision, rootId };
}

/** A Coordinator definition whose write capability needs approval, so a Coordinator turn can block on a side-effect approval. */
export function seedApprovalCoordinator(h: RuntimeHarness): AgentDefinitionRevision {
  const definition = h.stores.agents.ensureDefinition("coordinator");
  return h.stores.agents.appendRevision(definition.id, {
    provenance: { kind: "builtin" },
    modelPolicy: { model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8 },
    instructions: "You are the coordinator.",
    capabilities: { tools: ["read", "write"], mcpServers: [] },
    toolPolicy: { read: "allowed", write: "approval_required" },
    defaultLimits: { allocation: { costUsd: 2, tokens: 20_000, attempts: 2 }, maxWallClockMs: 600_000 },
  });
}

export function proposal(overrides: Partial<TaskProposal> & { key: string; requirementIds: RequirementId[] }): TaskProposal {
  return { subject: `task ${overrides.key}`, inputArtifactIds: [], requiredOutputs: ["report"], dependsOnKeys: [], dependsOnTaskIds: [], replacesTaskId: null, ...overrides };
}

export const propose = (tasks: TaskProposal[]): RuntimeToolCallRequest => ({ tool: "propose_tasks", input: { tasks } });
export const cancel = (taskId: TaskId, reason = "no longer needed"): RuntimeToolCallRequest => ({ tool: "update_task", input: { taskId, update: { kind: "cancel", reason } } });

/** A Coordinator turn step: the runtime-tool calls, then (by default) a completed result. */
export const turn = (calls: RuntimeToolCallRequest[], then: FakeStep = { kind: "succeed", result: COMPLETED_RESULT }): FakeStep => ({ kind: "runtime_tool_calls", calls, then });

/** A Worker step that completes (or blocks, or fails) the one Task it owns, with an output Artifact of that Task when it completes. */
export function workerStep(h: RuntimeHarness, options: { summary?: string; status?: "completed" | "blocked" | "failed"; diff?: string } = {}): FakeStep {
  return {
    kind: "derived",
    step: (request) => {
      const invocation = h.stores.invocations.get(request.invocationId);
      const taskId = invocation.taskIds[0]!;
      const status = options.status ?? "completed";
      if (options.diff !== undefined) h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot(options.diff, invocation.id), diff: new TextEncoder().encode(options.diff), empty: false };
      if (status === "completed") {
        const output = h.stores.artifacts.create({ runId: invocation.runId, mediaType: "text/plain", producer: { kind: "invocation", invocationId: invocation.id, attemptId: null }, taskId, title: `output of ${taskId}` }, new TextEncoder().encode(`output ${taskId}`));
        return { kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [output.id], summary: options.summary ?? `done ${taskId}`, tasks: [{ taskId, status: "completed", evidence: [{ kind: "artifact", artifactId: output.id }], blocker: null }] } };
      }
      if (status === "blocked") return { kind: "succeed", result: { ...COMPLETED_RESULT, status: "blocked", blocker: "the spec is ambiguous", summary: "stuck", tasks: [{ taskId, status: "blocked", evidence: [], blocker: "the spec is ambiguous" }] } };
      return { kind: "succeed", result: { ...COMPLETED_RESULT, status: "failed", summary: "cannot", tasks: [{ taskId, status: "failed", evidence: [], blocker: null }] } };
    },
  };
}

/** A synthesize step producing the node's final Artifact, recorded into `holder`. */
export function synthesisStep(h: RuntimeHarness, runId: string, holder: { artifactId?: ArtifactId }): FakeStep {
  return {
    kind: "derived",
    step: () => {
      const final = h.stores.artifacts.create({ runId: runId as never, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: "final" }, new TextEncoder().encode("final report"));
      holder.artifactId = final.id;
      return { kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [final.id], summary: "synthesized" } };
    },
  };
}

/** Finishes the root Orchestrator turn so a pass starts with the plan. */
export async function finishRoot(h: RuntimeHarness, s: PlanningSeed) {
  h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
  await h.executor.advanceInvocation(s.invocation.id);
}

export const workersOf = (h: RuntimeHarness, node: PlanNode) => h.stores.invocations.listByPlanNode(node.id).filter((i) => i.patternPosition?.kind === "worker_task");
export const turnsOf = (h: RuntimeHarness, node: PlanNode) => h.stores.invocations.listAtPosition(node.id, "coordinator_turn");
export const tasksOf = (h: RuntimeHarness, node: PlanNode) => h.stores.tasks.listByPlanNode(node.id).filter((t) => t.origin === "coordinator");

/**
 * A running `decompose` Attempt of a fresh coordinator node with a runtime-tool port bound to it exactly as the
 * executor binds one; the provider is never called, so tests drive the port directly.
 */
export async function decomposePort(h: RuntimeHarness, s: PlanningSeed, options: CoordinatorNodeOptions = {}, sink: ExecutionDiagnosticSink = () => {}) {
  const scoped = coordinatorNode(h, s, options);
  await finishRoot(h, s);
  h.stores.plans.transitionNode(scoped.node.id, { to: "ready" });
  const started = h.runners.coordinatorWorker.start(scoped.node.id, scoped.revisionNumber);
  if (started.kind !== "started") throw new Error(`decompose did not start: ${started.kind}`);
  const prepared = await h.executor.prepareNextAttempt(started.invocationId);
  if (prepared.kind !== "prepared") throw new Error(`Attempt not prepared: ${prepared.kind}`);
  const port = portFor(h, prepared.invocation, prepared.attempt, sink);
  return { ...scoped, invocation: prepared.invocation, attempt: prepared.attempt, port };
}

/** A runtime-tool port bound to an Attempt from its canonical rows, as the executor binds one. */
export function portFor(h: RuntimeHarness, invocation: Invocation, attempt: Attempt, sink: ExecutionDiagnosticSink = () => {}): RuntimeToolExecutor {
  const manifest = h.stores.invocations.getManifest(invocation.id);
  return new RuntimeToolExecutor(h.ctx, h.stores, { runId: invocation.runId, planNodeId: invocation.planNodeId, invocationId: invocation.id, attemptId: attempt.id, role: invocation.role, purpose: invocation.purpose, manifestTools: manifest.content.runtimeTools }, {}, sink, { planRevisions: h.planRevisions });
}

/** Yields to the event loop until `done` holds, never sleeping on a timer. */
export async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000; i += 1) {
    if (done()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("the pass did not reach the expected state");
}
