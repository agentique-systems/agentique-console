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
import type { Invocation, TaskId } from "@agentique-console/core";
import type { FakeStep } from "../provider/fake.ts";
import { describe, expect, it } from "vitest";
import { cancel, decomposePort, portFor, proposal, propose, WIDE_GOVERNOR, workerStep as coordinatorWorkerStep } from "./coordinator-test-support.ts";
import {
  approveRevision,
  cancelRun,
  evaluatorPort,
  laterRunInConversation,
  operatorDecision,
  orchestratorTask,
  readAgents,
  readArtifact,
  readDecisions,
  readPlan,
  readRequirements,
  readResult,
  readTasks,
  rejectionCodes,
  rootTurn,
  runArtifact,
  seedForeignRun,
  writeArtifact,
  writtenArtifact,
} from "./data-access-test-support.ts";
import { drain, rootPort, waiver, workerPort } from "./decision-test-support.ts";
import { scriptByRole } from "./gate-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, planNodes, seedPlanningRuntime } from "./test-support.ts";

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

  it("projects a Decision's affected ids through the caller's canonical scope: one mixed-scope Decision shows each role exactly its own references, while the canonical row keeps them all", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const conversationId = s.created.run.conversationId;
      const d = await decomposePort(h, s, { leaves: 3 });
      // The node's Tasks (a, b: b depends on a) and a root-side Task; the pinned scope's leaves and a newer revision's leaf.
      const accepted = await d.port.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] }), proposal({ key: "b", requirementIds: [d.leafIds[1]!], dependsOnKeys: ["a"] }), proposal({ key: "c", requirementIds: [d.leafIds[2]!] })]));
      if (accepted.kind !== "accepted" || accepted.result.tool !== "propose_tasks") throw new Error("proposal not accepted");
      const ids = accepted.result.taskIdsByKey as Record<string, TaskId>;
      const rootTask = orchestratorTask(h, runId, "root side work");
      // A newer current revision keeps every pinned Requirement (nothing retires) and adds one leaf the pinned scope cannot see.
      const newLeafId = h.ctx.ids("requirement");
      const newer = h.stores.requirements.createRevision({ conversationId, approvedByDecisionId: null, tree: [...d.revision.tree, { id: newLeafId, parentId: d.rootId, composition: null, statement: "Added later", position: d.revision.tree.length, acceptanceCriterionIds: [] }] });
      const mixed = operatorDecision(h, conversationId, runId, {
        requirementIds: [d.leafIds[0]!, d.leafIds[2]!, newLeafId, d.rootId],
        taskIds: [ids.a!, ids.b!, ids.c!, rootTask.id],
        planNodeIds: [d.node.id, s.created.root.id],
      });
      // The canonical row is untouched.
      expect(h.stores.decisions.get(mixed.id).affects).toEqual(mixed.affects);
      // The Coordinator: its pinned leaves (the scope root is not a scope row), its node's ledger, its own node.
      const coordinator = readResult(await d.port.call(readDecisions({ decisionId: mixed.id })), "read_decisions").items[0]!;
      expect(coordinator.affects).toEqual({ requirementIds: [d.leafIds[0]!, d.leafIds[2]!], taskIds: [ids.a!, ids.b!, ids.c!], planNodeIds: [d.node.id] });
      // The paginated read projects identically to the exact-id read.
      expect(readResult(await d.port.call(readDecisions()), "read_decisions").items.find((x) => x.decisionId === mixed.id)!.affects).toEqual(coordinator.affects);
      // The Orchestrator: the whole current revision (the internal root and the new leaf included), the Run's current Tasks, the current graph.
      const root = await rootTurn(h, s);
      expect(readResult(await root.port.call(readRequirements()), "read_requirements").requirementRevisionId).toBe(newer.id);
      const orchestrator = readResult(await root.port.call(readDecisions({ decisionId: mixed.id })), "read_decisions").items[0]!;
      expect(orchestrator.affects).toEqual({ requirementIds: [d.leafIds[0]!, d.leafIds[2]!, newLeafId, d.rootId], taskIds: [ids.a!, ids.b!, ids.c!, rootTask.id], planNodeIds: [d.node.id, s.created.root.id] });
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(root.attempt.id);
      // A Worker on Task b: its own Task and its direct dependency, its manifest Requirement, its node — and nothing of Task c or the root.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(d.attempt.id);
      const seen: Record<string, unknown> = {};
      const readingWorker = (): FakeStep => ({
        kind: "derived",
        step: (request) => {
          const invocation = h.stores.invocations.get(request.invocationId);
          return { kind: "runtime_tool_calls", calls: [readDecisions({ decisionId: mixed.id })], then: { kind: "derived", step: () => { seen[invocation.taskIds[0]!] = h.provider.runtimeToolCalls.at(-1)!.outcome; return coordinatorWorkerStep(h); } } };
        },
      });
      scriptByRole(h, { worker: [readingWorker(), readingWorker(), readingWorker()], coordinator: [{ kind: "succeed", result: COMPLETED_RESULT }] });
      await drain(h, runId, 64);
      expect(readResult(seen[ids.a!] as never, "read_decisions").items[0]!.affects).toEqual({ requirementIds: [d.leafIds[0]!], taskIds: [ids.a!], planNodeIds: [d.node.id] });
      expect(readResult(seen[ids.b!] as never, "read_decisions").items[0]!.affects).toEqual({ requirementIds: [], taskIds: [ids.a!, ids.b!], planNodeIds: [d.node.id] });
      expect(readResult(seen[ids.c!] as never, "read_decisions").items[0]!.affects).toEqual({ requirementIds: [d.leafIds[2]!], taskIds: [ids.c!], planNodeIds: [d.node.id] });
    } finally {
      h.close();
    }
  });

  it("keeps another Run's Decisions invisible to a scoped caller even when a Requirement id is shared; an Evaluator sees exactly its manifest's Decisions, projected to its scope", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const earlier = seedPlanningRuntime(h);
      const conversationId = earlier.created.run.conversationId;
      // An earlier Run of the Conversation records a Decision about the Conversation's Requirement, then ends.
      const earlierDecision = operatorDecision(h, conversationId, earlier.created.run.id, { requirementIds: [earlier.completion.requirementId] }, "Earlier Run's question");
      cancelRun(h, earlier);
      const s = laterRunInConversation(h, earlier);
      const runId = s.created.run.id;
      expect(runId).not.toBe(earlier.created.run.id);
      // The later Run's Coordinator pins a scope containing that same Requirement id (a new revision keeps the id).
      const revision = h.stores.requirements.createRevision({ conversationId, approvedByDecisionId: null, tree: [{ id: earlier.completion.requirementId, parentId: null, composition: null, statement: "The change builds and its tests pass", position: 0, acceptanceCriterionIds: [] }] });
      const { nodes, revisionNumber } = planNodes(h, s, [{ pattern: "coordinator_worker", coordinator: { agentDefinitionRevisionId: s.worker.id, title: "coordinator" }, worker: { agentDefinitionRevisionId: s.worker.id, title: "worker" }, scope: { requirementRootIds: [earlier.completion.requirementId], requirementRevisionId: revision.id }, allocation: { costUsd: 40, tokens: 400_000, attempts: 40 } }]);
      const node = nodes[0]!;
      // Decisions recorded after the manifest would be assembled: one of the earlier Run, one Conversation-level, one of this Run.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.advanceInvocation(s.invocation.id);
      h.stores.plans.transitionNode(node.id, { to: "ready" });
      const started = h.runners.coordinatorWorker.start(node.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      const lateForeign = operatorDecision(h, conversationId, earlier.created.run.id, { requirementIds: [earlier.completion.requirementId] }, "Recorded late for the earlier Run");
      const conversationLevel = operatorDecision(h, conversationId, null, { requirementIds: [earlier.completion.requirementId] }, "Conversation-wide");
      const own = operatorDecision(h, conversationId, runId, { requirementIds: [earlier.completion.requirementId], planNodeIds: [node.id] }, "This Run's");
      const prepared = await h.executor.prepareNextAttempt(started.invocationId);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const port = portFor(h, prepared.invocation, prepared.attempt);
      const manifest = h.stores.invocations.getManifest(prepared.invocation.id).content;
      // The manifest (assembled before the late Decisions) names the earlier Run's Decision that references the pinned Requirement: the one canonical
      // Conversation-level exception (execution-model §6.2). The late foreign Decision is visible through nothing.
      expect(manifest.decisions.map((x) => x.decisionId)).toContain(earlierDecision.id);
      expect(manifest.decisions.map((x) => x.decisionId)).not.toContain(lateForeign.id);
      const visible = readResult(await port.call(readDecisions()), "read_decisions").items.map((x) => x.decisionId);
      expect(visible).toEqual([earlierDecision.id, conversationLevel.id, own.id].sort());
      expect(visible).not.toContain(lateForeign.id);
      expect(rejectionCodes(await port.call(readDecisions({ decisionId: lateForeign.id })))).toEqual(["record_out_of_scope"]);
      expect(rejectionCodes(await port.call(readDecisions({ after: lateForeign.id })))).toEqual(["cursor_invalid"]);
      // A root turn assembled now names the late foreign Decision in its manifest (it references a current Requirement): visible through
      // that canonical route alone, and projected to the root's scope — the Requirement it shares, no Plan Node of the earlier Run.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(prepared.attempt.id);
      const root = await rootTurn(h, s);
      expect(h.stores.invocations.getManifest(root.invocation.id).content.decisions.map((x) => x.decisionId)).toContain(lateForeign.id);
      expect(readResult(await root.port.call(readDecisions({ decisionId: lateForeign.id })), "read_decisions").items[0]!.affects).toEqual({ requirementIds: [earlier.completion.requirementId], taskIds: [], planNodeIds: [] });
    } finally {
      h.close();
    }
  });

  it("a Worker's Decision projection and the Orchestrator's cover superseded Tasks and removed Plan Nodes exactly as read_tasks and read_execution_plan do", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const conversationId = s.created.run.conversationId;
      const w = await workerPort(h, s, { allocation: { costUsd: 12, tokens: 120_000, attempts: 12 } });
      const other = await workerPort(h, s, { allocation: { costUsd: 12, tokens: 120_000, attempts: 12 }, title: "other" });
      const decision = operatorDecision(h, conversationId, runId, { planNodeIds: [w.node.id, other.node.id, s.created.root.id] });
      // A Worker sees a Decision about its node, projected to its node alone; the other Worker likewise.
      expect(readResult(await w.port.call(readDecisions({ decisionId: decision.id })), "read_decisions").items[0]!.affects.planNodeIds).toEqual([w.node.id]);
      expect(readResult(await other.port.call(readDecisions({ decisionId: decision.id })), "read_decisions").items[0]!.affects.planNodeIds).toEqual([other.node.id]);
      // The Orchestrator sees every current node; a Decision naming only a removed node keeps that reference out of the projection.
      const root = await rootPort(h, s);
      expect(readResult(await root.port.call(readDecisions({ decisionId: decision.id })), "read_decisions").items[0]!.affects.planNodeIds).toEqual([w.node.id, other.node.id, s.created.root.id]);
      const stale = operatorDecision(h, conversationId, runId, { planNodeIds: [other.node.id] });
      // The Orchestrator revises the plan to drop the other node (still pending): its reference leaves the current graph.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(other.attempt.id);
      h.stores.plans.transitionNode(other.node.id, { to: "cancelled", reason: "orchestrator" });
      const remaining = h.stores.plans.getRevision(runId, h.stores.plans.latestRevisionNumber(runId)).source.expressions.filter((e) => !("operation" in e && e.operation.title === "other"));
      planNodes(h, s, remaining);
      expect(h.stores.plans.currentGraph(runId).nodes.map((n) => n.id)).not.toContain(other.node.id);
      expect(readResult(await root.port.call(readDecisions({ decisionId: stale.id })), "read_decisions").items[0]!.affects.planNodeIds).toEqual([]);
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
