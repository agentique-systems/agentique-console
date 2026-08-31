/**
 * The read-tool authorization matrix (execution-model §6.4 "Runtime read
 * tools"): what each role sees — the root Orchestrator the Run's current
 * state, a Coordinator its node's pinned scope and ledger, a Worker its
 * own Tasks and their direct dependencies, an Evaluator only its immutable
 * manifest's records — and what nobody sees: a foreign Run's,
 * Workspace's, or Conversation's records, same-Run records outside the
 * caller's scope, and anything reachable only by manipulating pagination.
 * Authorization is canonical ownership; a supplied id proves nothing.
 */
import type { DecisionRequest, Invocation, TaskId } from "@agentique-console/core";
import type { FakeStep } from "../provider/fake.ts";
import { describe, expect, it } from "vitest";
import { cancel, decomposePort, portFor, proposal, propose, WIDE_GOVERNOR, workerStep as coordinatorWorkerStep } from "./coordinator-test-support.ts";
import {
  approveRevision,
  evaluatorPort,
  readAgents,
  readArtifact,
  readDecisions,
  readPlan,
  readRequirements,
  readResult,
  readTasks,
  rejectionCodes,
  runArtifact,
  seedForeignRun,
  writeArtifact,
  writtenArtifact,
} from "./data-access-test-support.ts";
import { drain, rootPort, waiver } from "./decision-test-support.ts";
import { scriptByRole } from "./gate-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

/** An open `operator_choice` Decision recorded by the operator, affecting the given ids. */
function operatorDecision(h: RuntimeHarness, conversationId: string, runId: string | null, affects: Partial<DecisionRequest["affects"]> = {}, question = "Which way?") {
  return h.stores.decisions.request({
    conversationId: conversationId as never,
    runId: runId as never,
    kind: "operator_choice",
    resolutionPolicy: "operator_required",
    requestedBy: { kind: "operator" },
    question,
    options: [
      { id: "a", label: "A", description: null },
      { id: "b", label: "B", description: null },
    ],
    recommendedOptionId: null,
    rationale: null,
    affects: { requirementIds: [], taskIds: [], planNodeIds: [], ...affects },
    deadlineAt: null,
    activationCondition: null,
    subject: null,
    supersedesDecisionId: null,
  });
}

/** A Run-scoped Task recorded by the runtime for the Orchestrator's ledger. */
function orchestratorTask(h: RuntimeHarness, runId: string, subject: string, requirementIds: string[] = []) {
  return h.stores.tasks.create({ runId: runId as never, planNodeId: null, origin: "orchestrator", subject, requirementIds: requirementIds as never, requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
}

describe("read scope by role", () => {
  it("root Orchestrator: the current Requirement revision (never a stale manifest's), every current Task, the Run's Decisions — and nothing of a foreign Run, Workspace, or Conversation", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const foreign = seedForeignRun(h);
      const root = await rootPort(h, s);
      // The manifest pinned the seed's revision; a newer approved revision is what the root reads: current, not stale.
      const manifestRevision = h.stores.invocations.getManifest(root.invocation.id).content.requirementRevisionId;
      const approved = approveRevision(h, s, 2);
      expect(approved.revision.id).not.toBe(manifestRevision);
      const requirements = readResult(await root.port.call(readRequirements({ includeAcceptanceCriteria: true })), "read_requirements");
      expect(requirements.requirementRevisionId).toBe(approved.revision.id);
      expect(requirements.items.map((r) => r.requirementId)).toEqual([approved.rootId, ...approved.leafIds]);
      expect(requirements.items[0]).toMatchObject({ composition: "all", leaf: false, childIds: approved.leafIds, acceptanceCriteria: [] });
      expect(requirements.items[1]).toMatchObject({ parentId: approved.rootId, composition: null, leaf: true, childIds: [], status: "open", waiverDecisionId: null });
      // Tasks: every current Task of the Run, by id; a foreign Run's Task neither readable nor confirmed to exist.
      const mine = [orchestratorTask(h, runId, "first"), orchestratorTask(h, runId, "second")];
      const other = orchestratorTask(h, foreign.created.run.id, "foreign work");
      const tasks = readResult(await root.port.call(readTasks()), "read_tasks");
      expect(tasks.items.map((t) => t.taskId)).toEqual(mine.map((t) => t.id).sort());
      expect(rejectionCodes(await root.port.call(readTasks({ taskId: other.id })))).toEqual(["record_out_of_scope"]);
      expect(rejectionCodes(await root.port.call(readTasks({ after: other.id })))).toEqual(["cursor_invalid"]);
      // Decisions: the Run's and the Conversation-level ones; a foreign Conversation's never, an unknown id never confirmed.
      const runScoped = operatorDecision(h, s.created.run.conversationId, runId, { taskIds: [mine[0]!.id] });
      const conversationScoped = operatorDecision(h, s.created.run.conversationId, null);
      const foreignDecision = operatorDecision(h, foreign.created.run.conversationId, foreign.created.run.id);
      const decisions = readResult(await root.port.call(readDecisions()), "read_decisions");
      expect(decisions.items.map((d) => d.decisionId)).toEqual([runScoped.id, conversationScoped.id].sort());
      expect(decisions.items.find((d) => d.decisionId === runScoped.id)).toMatchObject({ kind: "operator_choice", status: "open", question: "Which way?", options: [{ id: "a", label: "A", description: null }, { id: "b", label: "B", description: null }], affects: { taskIds: [mine[0]!.id], requirementIds: [], planNodeIds: [] } });
      expect(rejectionCodes(await root.port.call(readDecisions({ decisionId: foreignDecision.id })))).toEqual(["record_out_of_scope"]);
      // A status filter over the visible set only.
      h.stores.decisions.resolve(conversationScoped.id, { resolvedBy: "operator", chosenOptionId: "a", rationale: null, artifactIds: [] });
      const resolved = readResult(await root.port.call(readDecisions({ status: "resolved" })), "read_decisions");
      expect(resolved.items.map((d) => d.decisionId)).toEqual([conversationScoped.id]);
      expect(resolved.items[0]).toMatchObject({ chosenOptionId: "a", resolvedBy: "operator" });
      // Requirements and Artifacts of the foreign Run, Workspace, and Conversation stay invisible.
      expect(rejectionCodes(await root.port.call(readRequirements({ requirementId: foreign.completion.requirementId })))).toEqual(["record_out_of_scope"]);
      expect(rejectionCodes(await root.port.call(readArtifact({ artifactId: foreign.artifact.id })))).toEqual(["artifact_not_readable"]);
      // A same-Run Artifact that no canonical route delivered is just as unreadable: an id is not authorization.
      const unrouted = runArtifact(h, s, new TextEncoder().encode("secret"), "unrouted");
      expect(rejectionCodes(await root.port.call(readArtifact({ artifactId: unrouted.id })))).toEqual(["artifact_not_readable"]);
      // The graph projection is always the caller's own Run; there is no Run selector to abuse.
      const plan = readResult(await root.port.call(readPlan()), "read_execution_plan");
      expect(rejectionCodes(await root.port.call({ tool: "read_execution_plan", input: { view: "nodes", runId: foreign.created.run.id } } as never))).toEqual(["invalid_input"]);
      if (plan.view !== "nodes") throw new Error("nodes view expected");
      for (const node of plan.items) expect(h.stores.plans.getNode(node.planNodeId).runId).toBe(runId);
    } finally {
      h.close();
    }
  });

  it("root Orchestrator: a waived Requirement names its operator-resolved waiver Decision", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const root = await rootPort(h, s);
      const asked = await root.port.call(waiver(s.completion.requirementId));
      if (asked.kind !== "accepted" || asked.result.tool !== "request_decision") throw new Error("waiver not accepted");
      // The requesting turn ended; the operator waives; the scheduler prepares the successor.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(root.attempt.id);
      const resolution = h.decisionRequests.resolve({ decisionId: asked.result.decisionId, optionId: "waive", rationale: "accepted without its criteria" });
      expect(resolution.kind).toBe("resolved");
      expect(h.stores.requirements.get(s.completion.requirementId).status).toBe("waived");
      await h.scheduler.advanceRun(runId, { maxActions: 1 });
      const successor = h.stores.invocations.listByRun(runId).find((i) => i.continuedFromInvocationId === root.invocation.id);
      if (!successor) throw new Error("no successor was prepared");
      const prepared = await h.executor.prepareNextAttempt(successor.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const port = portFor(h, prepared.invocation, prepared.attempt);
      const read = readResult(await port.call(readRequirements({ requirementId: s.completion.requirementId })), "read_requirements");
      expect(read.items[0]).toMatchObject({ requirementId: s.completion.requirementId, status: "waived", waiverDecisionId: asked.result.decisionId });
    } finally {
      h.close();
    }
  });

  it("Coordinator: exactly its pinned scope at the pinned revision (never silently the newer one), its node's complete Task ledger with replacement history, and the Decisions that concern its node", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const d = await decomposePort(h, s);
      // Requirements: the exact pinned leaves, leaves only — the internal root of the scope tree is not a scope row.
      const requirements = readResult(await d.port.call(readRequirements()), "read_requirements");
      expect(requirements.requirementRevisionId).toBe(d.revision.id);
      expect(requirements.items.map((r) => r.requirementId)).toEqual(d.leafIds);
      expect(requirements.items.every((r) => r.leaf && r.childIds.length === 0)).toBe(true);
      expect(rejectionCodes(await d.port.call(readRequirements({ requirementId: d.rootId })))).toEqual(["record_out_of_scope"]);
      // The ledger: proposed Tasks with dependencies; a cancelled Task stays in the ledger; the Orchestrator-side Task does not appear.
      const accepted = await d.port.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] }), proposal({ key: "b", requirementIds: [d.leafIds[1]!], dependsOnKeys: ["a"] })]));
      if (accepted.kind !== "accepted" || accepted.result.tool !== "propose_tasks") throw new Error("proposal not accepted");
      // A newer current revision never reaches a pinned node: the same pinned revision reads back, and the new leaves stay out of scope.
      const newer = approveRevision(h, s, 2);
      const pinnedStill = readResult(await d.port.call(readRequirements()), "read_requirements");
      expect(pinnedStill.requirementRevisionId).toBe(d.revision.id);
      expect(pinnedStill.items.map((r) => r.requirementId)).toEqual(d.leafIds);
      expect(rejectionCodes(await d.port.call(readRequirements({ requirementId: newer.leafIds[0]! })))).toEqual(["record_out_of_scope"]);
      const { taskIdsByKey } = accepted.result;
      await d.port.call(cancel(taskIdsByKey.b!));
      const outside = orchestratorTask(h, runId, "root side work");
      const ledger = readResult(await d.port.call(readTasks()), "read_tasks");
      expect(ledger.items.map((t) => t.taskId)).toEqual([taskIdsByKey.a!, taskIdsByKey.b!].sort());
      expect(ledger.items.find((t) => t.taskId === taskIdsByKey.b)).toMatchObject({ status: "cancelled", dependsOnTaskIds: [taskIdsByKey.a], planNodeId: d.node.id });
      expect(rejectionCodes(await d.port.call(readTasks({ taskId: outside.id })))).toEqual(["record_out_of_scope"]);
      expect(rejectionCodes(await d.port.call(readTasks({ after: outside.id })))).toEqual(["cursor_invalid"]);
      // Decisions: those affecting the node, its Tasks, or its scope; an unrelated Run Decision stays invisible.
      const aboutNode = operatorDecision(h, s.created.run.conversationId, runId, { planNodeIds: [d.node.id] });
      const aboutScope = operatorDecision(h, s.created.run.conversationId, runId, { requirementIds: [d.leafIds[0]!] });
      const unrelated = operatorDecision(h, s.created.run.conversationId, runId, {});
      const decisions = readResult(await d.port.call(readDecisions()), "read_decisions");
      expect(decisions.items.map((x) => x.decisionId)).toEqual([aboutNode.id, aboutScope.id].sort());
      expect(rejectionCodes(await d.port.call(readDecisions({ decisionId: unrelated.id })))).toEqual(["record_out_of_scope"]);
      // Its own written Artifact is immediately readable; an unrouted one of the same Run is not.
      const written = writtenArtifact(await d.port.call(writeArtifact({ title: "coordination notes", content: "plan" })));
      expect(readResult(await d.port.call(readArtifact({ artifactId: written.artifactId })), "read_artifact").content).toBe("plan");
      const unrouted = runArtifact(h, s, new TextEncoder().encode("private"));
      expect(rejectionCodes(await d.port.call(readArtifact({ artifactId: unrouted.id })))).toEqual(["artifact_not_readable"]);
    } finally {
      h.close();
    }
  });

  it("Worker: its assigned Task and that Task's direct dependencies, nothing more — pagination cannot enumerate the node's other Tasks", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const d = await decomposePort(h, s, { bounds: { maxTasks: 6, maxConcurrentWorkers: 1, maxCoordinatorInvocations: 4 } });
      const accepted = await d.port.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] }), proposal({ key: "b", requirementIds: [d.leafIds[1]!], dependsOnKeys: ["a"] }), proposal({ key: "c", requirementIds: [d.leafIds[1]!] })]));
      if (accepted.kind !== "accepted" || accepted.result.tool !== "propose_tasks") throw new Error("proposal not accepted");
      const ids = accepted.result.taskIdsByKey as Record<string, TaskId>;
      const all = [ids.a!, ids.b!, ids.c!];
      // Each Worker reads before completing its Task: its ledger view, its Requirements, and a cursor at an out-of-scope sibling.
      const readingWorker = (): FakeStep => ({
        kind: "derived",
        step: (request) => {
          const invocation = h.stores.invocations.get(request.invocationId);
          const own = invocation.taskIds[0]!;
          const visible = new Set([own, ...h.stores.tasks.dependenciesOf(own).map((e) => e.dependsOnTaskId)]);
          const outside = all.find((id) => !visible.has(id))!;
          return { kind: "runtime_tool_calls", calls: [readTasks(), readRequirements(), readTasks({ after: outside })], then: coordinatorWorkerStep(h) };
        },
      });
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(d.attempt.id);
      scriptByRole(h, { worker: [readingWorker(), readingWorker(), readingWorker()], coordinator: [{ kind: "succeed", result: COMPLETED_RESULT }] });
      await drain(h, runId, 64);
      expect(h.stores.plans.getNode(d.node.id).status).toBe("succeeded");
      const byInvocation = new Map<string, typeof h.provider.runtimeToolCalls>();
      for (const call of h.provider.runtimeToolCalls) {
        const invocationId = h.stores.invocations.getAttempt(call.attemptId).invocationId;
        byInvocation.set(invocationId, [...(byInvocation.get(invocationId) ?? []), call]);
      }
      const workerOf = (taskId: TaskId) => h.stores.invocations.listByPlanNode(d.node.id).find((i) => i.taskIds[0] === taskId)!;
      // Worker a: only its own Task (it has no dependencies); an out-of-scope sibling is not even a valid cursor.
      const aCalls = byInvocation.get(workerOf(ids.a!).id)!;
      expect(readResult(aCalls[0]!.outcome, "read_tasks").items.map((t) => t.taskId)).toEqual([ids.a]);
      expect(readResult(aCalls[1]!.outcome, "read_requirements").items.map((r) => r.requirementId)).toEqual([d.leafIds[0]]);
      expect(rejectionCodes(aCalls[2]!.outcome)).toEqual(["cursor_invalid"]);
      // Worker b: its Task plus the completed dependency it needs — and no way to page past that set.
      const bCalls = byInvocation.get(workerOf(ids.b!).id)!;
      const bTasks = readResult(bCalls[0]!.outcome, "read_tasks");
      expect(bTasks.items.map((t) => t.taskId)).toEqual([ids.a!, ids.b!].sort());
      expect(bTasks.items.find((t) => t.taskId === ids.a)).toMatchObject({ status: "completed", outputArtifactIds: [expect.any(String)] });
      expect(readResult(bCalls[1]!.outcome, "read_requirements").items.map((r) => r.requirementId)).toEqual([d.leafIds[1]]);
      expect(rejectionCodes(bCalls[2]!.outcome)).toEqual(["cursor_invalid"]);
      // Worker c: independent, so its ledger view is itself alone; the other Tasks of its node stay unreachable.
      const cCalls = byInvocation.get(workerOf(ids.c!).id)!;
      expect(readResult(cCalls[0]!.outcome, "read_tasks").items.map((t) => t.taskId)).toEqual([ids.c]);
      expect(rejectionCodes(cCalls[2]!.outcome)).toEqual(["cursor_invalid"]);
    } finally {
      h.close();
    }
  });

  it("Evaluator: its immutable manifest's Requirements, the Gate candidate's Tasks and Artifacts, and manifest Decisions only — it may write a bounded Evidence Artifact and read it back, and result validation admits that Artifact as Evidence", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const e = await evaluatorPort(h);
      const runId = e.runId;
      expect(e.port.tools).toContain("read_artifact");
      expect(e.port.tools).toContain("write_artifact");
      expect(e.port.tools).not.toContain("request_decision");
      // Requirements: the manifest's pinned view; a revision approved after assembly changes nothing for this Evaluator.
      const manifest = h.stores.invocations.getManifest(e.invocation.id).content;
      const before = readResult(await e.port.call(readRequirements()), "read_requirements");
      expect(before.requirementRevisionId).toBe(manifest.requirementRevisionId);
      expect(before.items.map((r) => r.requirementId)).toEqual(manifest.requirements.map((r) => r.requirementId));
      approveRevision(h, e.s, 2);
      const after = readResult(await e.port.call(readRequirements()), "read_requirements");
      expect(after.requirementRevisionId).toBe(manifest.requirementRevisionId);
      // Tasks: only what the Gate candidate represents (a node_exit candidate names none).
      const stray = orchestratorTask(h, runId, "elsewhere");
      expect(readResult(await e.port.call(readTasks()), "read_tasks").items).toEqual([]);
      expect(rejectionCodes(await e.port.call(readTasks({ taskId: stray.id })))).toEqual(["record_out_of_scope"]);
      // Decisions: only the manifest's — a Decision affecting the gated node is not automatically an Evaluator's business.
      const aboutNode = operatorDecision(h, e.s.created.run.conversationId, runId, { planNodeIds: [e.node.id] });
      expect(readResult(await e.port.call(readDecisions()), "read_decisions").items).toEqual([]);
      expect(rejectionCodes(await e.port.call(readDecisions({ decisionId: aboutNode.id })))).toEqual(["record_out_of_scope"]);
      // Artifacts: the Gate candidate is readable; the Worker's Changeset diff of the same Run is not routed to the Evaluator.
      const candidate = readResult(await e.port.call(readArtifact({ artifactId: e.candidate[0]! })), "read_artifact");
      expect(candidate.artifactId).toBe(e.candidate[0]);
      const diff = h.stores.changesets.listByRun(runId)[0]!.diffArtifactId;
      expect(rejectionCodes(await e.port.call(readArtifact({ artifactId: diff })))).toEqual(["artifact_not_readable"]);
      // The graph of its own Run is inspectable by every role.
      const plan = readResult(await e.port.call(readPlan()), "read_execution_plan");
      if (plan.view !== "nodes") throw new Error("nodes view expected");
      expect(plan.items.map((n) => n.planNodeId)).toContain(e.node.id);
      expect(readResult(await e.port.call(readAgents()), "read_agent_definitions").items.length).toBeGreaterThan(0);
      // A bounded Evidence report: written, immediately readable, admitted as Evidence by result validation, no Workspace mutation.
      const written = writtenArtifact(await e.port.call(writeArtifact({ title: "evaluation report", content: "the candidate satisfies the criterion" })));
      expect(readResult(await e.port.call(readArtifact({ artifactId: written.artifactId })), "read_artifact").content).toBe("the candidate satisfies the criterion");
      h.provider.script({
        kind: "derived",
        step: (request) => {
          const content = h.stores.invocations.getManifest(request.invocationId).content;
          const candidate = content.inputs.find((i) => i.kind === "gate_candidate");
          if (candidate?.kind !== "gate_candidate") throw new Error("no gate_candidate input");
          const evidence = [{ kind: "artifact" as const, artifactId: written.artifactId }];
          return {
            kind: "succeed",
            result: { ...COMPLETED_RESULT, summary: "judged", evaluation: { verdict: "pass", criteria: candidate.acceptanceCriterionIds.map((id) => ({ acceptanceCriterionId: id, verdict: "pass", evidence })), evidence } },
          };
        },
      });
      const outcome = await h.executor.executePreparedAttempt(e.attempt.id);
      expect(outcome).toMatchObject({ kind: "finalized", attempt: { status: "succeeded" } });
      const settled = h.runners.single.settleGate(e.node.id, e.revisionNumber);
      expect(settled).toMatchObject({ kind: "gate_passed", gateId: e.gateId });
      const evaluations = h.stores.evaluations.listByGate(e.gateId).filter((x) => x.producedBy.kind === "evaluator");
      expect(evaluations.some((x) => x.evidence.some((v) => v.kind === "artifact" && v.artifactId === written.artifactId))).toBe(true);
      expect(h.stores.changesets.listByRun(runId).filter((c) => c.invocationId === e.invocation.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("a successor Invocation reads a predecessor's Artifact only when canonically routed to it", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const root = await rootPort(h, s);
      const routed = writtenArtifact(await root.port.call(writeArtifact({ title: "kept", content: "routed onward" })));
      const unrouted = writtenArtifact(await root.port.call(writeArtifact({ title: "dropped", content: "never routed" })));
      // The turn ends on a requested Decision; its resolution prepares the one successor.
      const asked = await root.port.call({ tool: "request_decision", input: { kind: "operator_choice", question: "Keep going?", options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], resolutionPolicy: { kind: "operator_required" }, affects: { requirementIds: [], taskIds: [], planNodeIds: [] } } });
      if (asked.kind !== "accepted" || asked.result.tool !== "request_decision") throw new Error("request not accepted");
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(root.attempt.id);
      h.decisionRequests.resolve({ decisionId: asked.result.decisionId, optionId: "yes" });
      await h.scheduler.advanceRun(runId, { maxActions: 1 });
      const successor = h.stores.invocations.listByRun(runId).find((i) => i.continuedFromInvocationId === root.invocation.id) as Invocation;
      const prepared = await h.executor.prepareNextAttempt(successor.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const port = portFor(h, prepared.invocation, prepared.attempt);
      // A successor is a new logical turn: the predecessor requested a Decision, so nothing of its production is inherited
      // by producer ownership; only canonical routing (here: none) grants visibility.
      expect(rejectionCodes(await port.call(readArtifact({ artifactId: routed.artifactId })))).toEqual(["artifact_not_readable"]);
      expect(rejectionCodes(await port.call(readArtifact({ artifactId: unrouted.artifactId })))).toEqual(["artifact_not_readable"]);
    } finally {
      h.close();
    }
  });
});
