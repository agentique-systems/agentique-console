/**
 * Continuation after a requested Decision ends (execution-model §7.3, §8.2;
 * invariants 5, 13, 21): the scheduler prepares exactly one successor of
 * the blocked requester — the same Run, node, role, purpose, position, and
 * Task ownership, `continuedFromInvocationId` naming the blocked
 * Invocation, a fresh manifest carrying the logical turn's defining inputs
 * plus exactly one typed `decision_resolution` input — and executes it;
 * no Orchestrator relay turn is inserted for a Coordinator or Worker; a
 * successor is funded through the node's one capacity operation, so an
 * exhausted node fails, waits, or extends by its policy, and a Budget
 * Increase alone never enlarges a `wait` node.
 */
import { type Invocation, type ManifestInput, type PlanExpression, type PlanNode, type RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../persistence/test-support.ts";
import { coordinatorNode, finishRoot, proposal, propose, turn, WIDE_GOVERNOR, workerStep as coordinatorWorkerStep } from "./coordinator-test-support.ts";
import { choice, requesting, waiver } from "./decision-test-support.ts";
import { chainExpression, scriptByRole, workerStep } from "./gate-test-support.ts";
import { COMPLETED_RESULT, INVOCATION_ALLOCATION, openRuntimeHarness, planNodes, seedPlanningRuntime, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

/** Advances the Run until a pass performs nothing more (or `passes` elapse); returns the last pass. */
async function drain(h: RuntimeHarness, runId: RunId, passes = 12) {
  let last = await h.scheduler.advanceRun(runId);
  for (let i = 1; i < passes && last.actions.length > 0; i += 1) last = await h.scheduler.advanceRun(runId);
  return last;
}

const resolutionInputs = (h: RuntimeHarness, invocation: Pick<Invocation, "id">) => h.stores.invocations.getManifest(invocation.id).content.inputs.filter((i): i is Extract<ManifestInput, { kind: "decision_resolution" }> => i.kind === "decision_resolution");
const inputKinds = (h: RuntimeHarness, invocation: Pick<Invocation, "id">) => h.stores.invocations.getManifest(invocation.id).content.inputs.map((i) => i.kind);

/** The successor of `blocked` is the one Invocation continuing from it; it holds the same identity and exactly one resolution input. */
function expectSuccessor(h: RuntimeHarness, blocked: Invocation, decisionId: string): Invocation {
  const all = h.stores.invocations.listByRun(blocked.runId);
  const successors = all.filter((i) => i.continuedFromInvocationId === blocked.id);
  expect(successors).toHaveLength(1);
  const successor = successors[0]!;
  expect(successor).toMatchObject({ runId: blocked.runId, planNodeId: blocked.planNodeId, role: blocked.role, purpose: blocked.purpose, patternPosition: blocked.patternPosition, taskIds: blocked.taskIds, gateId: blocked.gateId });
  expect(successor.id).not.toBe(blocked.id);
  expect(h.stores.invocations.getManifest(successor.id).id).not.toBe(h.stores.invocations.getManifest(blocked.id).id);
  const resolutions = resolutionInputs(h, successor);
  expect(resolutions).toHaveLength(1);
  expect(resolutions[0]!.decisionId).toBe(decisionId);
  expect(resolutions[0]!.decisionKind).toBe(h.stores.decisions.get(decisionId as never).kind);
  return successor;
}

describe("continuation after a requested Decision", () => {
  it("continues the root Orchestrator in one successor of the same purpose carrying the turn-defining inputs and the resolution, twice over, with no relay turn", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      const { invocation: first } = startRun(h, s).prepared;
      const before = inputKinds(h, first);
      h.provider.script(requesting([choice()]), requesting([choice({ question: "And the test runner?", options: [{ key: "vitest", label: "Vitest" }, { key: "node", label: "node:test" }], recommendedOptionKey: "vitest" })]), { kind: "succeed", result: COMPLETED_RESULT });
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const firstDecision = h.stores.decisions.get(h.stores.invocations.get(first.id).blockedByDecisionId!);
      // Resolution writes nothing but the Decision; the successor appears on the next pass, funded through the root's capacity.
      h.decisionRequests.resolve({ decisionId: firstDecision.id, optionId: "express" });
      expect(h.stores.invocations.listByRun(runId)).toHaveLength(1);
      const pass = await h.scheduler.advanceRun(runId, { maxActions: 2 });
      expect(pass.actions.map((a) => a.action.kind)).toEqual(["resume_run", "settle_root"]);
      const second = expectSuccessor(h, h.stores.invocations.get(first.id), firstDecision.id);
      expect(second.purpose).toBe(first.purpose);
      expect(inputKinds(h, second)).toEqual([...before, "decision_resolution"]);
      expect(resolutionInputs(h, second)[0]).toEqual({ kind: "decision_resolution", decisionId: firstDecision.id, decisionKind: "operator_choice", status: "resolved", question: firstDecision.question, resolvedBy: "operator", selected: { optionId: "express", label: "Express", description: null }, waiver: null });
      expect(h.stores.invocations.getManifest(second.id).content.runtimeTools).toContain("request_decision");
      // The successor requests again: it blocks the same way, and its own successor carries only the newer resolution.
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const secondDecision = h.stores.decisions.get(h.stores.invocations.get(second.id).blockedByDecisionId!);
      expect(secondDecision.question).toBe("And the test runner?");
      h.decisionRequests.resolve({ decisionId: secondDecision.id, optionId: "vitest" });
      await drain(h, runId);
      const third = expectSuccessor(h, h.stores.invocations.get(second.id), secondDecision.id);
      expect(inputKinds(h, third)).toEqual([...before, "decision_resolution"]);
      expect(third.status).toBe("succeeded");
      expect(h.stores.invocations.listByRun(runId).map((i) => [i.role, i.purpose, i.status])).toEqual([["orchestrator", first.purpose, "blocked"], ["orchestrator", first.purpose, "blocked"], ["orchestrator", first.purpose, "succeeded"]]);
      expect(h.provider.requests).toHaveLength(3);
      expect(h.stores.runs.get(runId).status).toBe("running");
    } finally {
      h.close();
    }
  });

  it("continues the root after a requirement_waiver with the waiver facts — waived, denied, or superseded — and applies the waiver only once, to the pinned Requirement", async () => {
    for (const outcome of ["waive", "deny", "stale"] as const) {
      const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const s = seedRuntime(h);
        const runId = s.created.run.id;
        const conversationId = s.created.run.conversationId;
        const rootId = h.ctx.ids("requirement");
        const leaf = h.ctx.ids("requirement");
        const revision = h.stores.requirements.createRevision({ conversationId, approvedByDecisionId: null, tree: [{ id: rootId, parentId: null, composition: "all", statement: "The CLI reports its version", position: 0, acceptanceCriterionIds: [] }, { id: leaf, parentId: rootId, composition: null, statement: "Leaf", position: 0, acceptanceCriterionIds: [] }] });
        const { invocation: first } = startRun(h, s).prepared;
        h.provider.script(requesting([waiver(leaf)]), { kind: "succeed", result: COMPLETED_RESULT });
        expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
        const decisionId = h.stores.invocations.get(first.id).blockedByDecisionId!;
        if (outcome === "stale") h.stores.requirements.createRevision({ conversationId, approvedByDecisionId: null, tree: [{ id: rootId, parentId: null, composition: "all", statement: "The CLI reports its version", position: 0, acceptanceCriterionIds: [] }, { id: leaf, parentId: rootId, composition: null, statement: "Leaf (revised)", position: 0, acceptanceCriterionIds: [] }] });
        const resolved = h.decisionRequests.resolve({ decisionId, optionId: outcome === "deny" ? "deny" : "waive", rationale: "operator says so" });
        expect(resolved.kind, outcome).toBe(outcome === "stale" ? "superseded" : "resolved");
        await drain(h, runId);
        const successor = expectSuccessor(h, h.stores.invocations.get(first.id), decisionId);
        const input = resolutionInputs(h, successor)[0]!;
        expect(input, outcome).toMatchObject({ decisionKind: "requirement_waiver", status: outcome === "stale" ? "superseded" : "resolved", waiver: { requirementId: leaf, requirementRevisionId: revision.id, outcome: outcome === "waive" ? "waived" : outcome === "deny" ? "denied" : "superseded" } });
        expect(h.stores.requirements.get(leaf).status, outcome).toBe(outcome === "waive" ? "waived" : "open");
        expect(h.stores.requirements.history(leaf).filter((c) => c.to === "waived"), outcome).toHaveLength(outcome === "waive" ? 1 : 0);
        expect(successor.status, outcome).toBe("succeeded");
        expect(h.stores.invocations.listByRun(runId), outcome).toHaveLength(2);
        expect(h.stores.runs.get(runId).status, outcome).toBe("running");
      } finally {
        h.close();
      }
    }
  });

  it("continues a Coordinator turn at the same logical turn — the same purpose and ledger, no turn consumed — and a Worker at its Task, which it re-owns; the root never relays", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const scoped = coordinatorNode(h, s, { leaves: 1, bounds: { maxTasks: 4, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 3 } });
      await finishRoot(h, s);
      const nodeChoice = choice({ affects: { requirementIds: [], taskIds: [], planNodeIds: [scoped.node.id] } });
      scriptByRole(h, {
        coordinator: [turn([nodeChoice]), turn([propose([proposal({ key: "a", requirementIds: [scoped.leafIds[0]!] })])]), turn([])],
        worker: [requesting([nodeChoice]), coordinatorWorkerStep(h, { summary: "a", diff: "+a" })],
      });
      // The decompose turn requests: the node and Run wait on the Decision.
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const firstTurn = h.stores.invocations.listAtPosition(scoped.node.id, "coordinator_turn").at(-1)!;
      expect(firstTurn).toMatchObject({ status: "blocked", purpose: "decompose" });
      expect(h.stores.plans.getNode(scoped.node.id)).toMatchObject({ status: "waiting", waitReason: "decision" });
      const rootTurns = () => h.stores.invocations.listByPlanNode(h.stores.plans.rootNode(runId).id).length;
      const rootTurnsBefore = rootTurns();
      h.decisionRequests.resolve({ decisionId: firstTurn.blockedByDecisionId!, optionId: "fastify" });
      // The turn successor: same purpose, the same turnsUsed (a continuation consumes no turn), its Decision resolution; then it proposes the Task.
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const turnSuccessor = expectSuccessor(h, h.stores.invocations.get(firstTurn.id), firstTurn.blockedByDecisionId!);
      const turnInput = (i: Invocation) => h.stores.invocations.getManifest(i.id).content.inputs.find((x): x is Extract<ManifestInput, { kind: "coordinator_turn" }> => x.kind === "coordinator_turn")!;
      expect(turnInput(turnSuccessor)).toMatchObject({ purpose: "decompose", turnsUsed: turnInput(firstTurn).turnsUsed });
      expect(turnSuccessor.status).toBe("succeeded");
      // The Worker of the proposed Task requested next: its Task is blocked on the Decision; the node waits again.
      const task = h.stores.tasks.listByPlanNode(scoped.node.id)[0]!;
      const worker = h.stores.invocations.listByPlanNode(scoped.node.id).find((i) => i.role === "worker")!;
      expect(worker).toMatchObject({ status: "blocked", taskIds: [task.id] });
      expect(h.stores.tasks.get(task.id)).toMatchObject({ status: "blocked", blockReason: { kind: "decision", decisionId: worker.blockedByDecisionId } });
      h.decisionRequests.resolve({ decisionId: worker.blockedByDecisionId!, optionId: "express" });
      await drain(h, runId);
      const workerSuccessor = expectSuccessor(h, h.stores.invocations.get(worker.id), worker.blockedByDecisionId!);
      expect(workerSuccessor).toMatchObject({ purpose: "task", taskIds: [task.id], status: "succeeded", patternPosition: { kind: "worker_task", taskId: task.id } });
      expect(h.stores.tasks.get(task.id)).toMatchObject({ status: "completed", invocationId: workerSuccessor.id });
      // The Task's history: running under the first Worker, blocked on the Decision, running under the successor, completed.
      expect(h.stores.invocations.listByPlanNode(scoped.node.id).filter((i) => i.role === "worker")).toHaveLength(2);
      expect(h.stores.plans.getNode(scoped.node.id).status).toBe("succeeded");
      expect(rootTurns()).toBe(rootTurnsBefore);
    } finally {
      h.close();
    }
  });

  it("continues a chain step at its own position, never the next: the successor of step A runs before step B", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const { nodes } = planNodes(h, s, [chainExpression(s, ["A", "B"])]);
      const node = nodes[0]!;
      await finishRoot(h, s);
      scriptByRole(h, { worker: [requesting([choice({ affects: { requirementIds: [], taskIds: [], planNodeIds: [node.id] } })]), workerStep(h, "a"), workerStep(h, "b")] });
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const stepA = h.stores.invocations.listByPlanNode(node.id)[0]!;
      expect(stepA).toMatchObject({ status: "blocked", patternPosition: { kind: "chain_step", index: 0, count: 2 } });
      h.decisionRequests.resolve({ decisionId: stepA.blockedByDecisionId!, optionId: "fastify" });
      await drain(h, runId);
      const successor = expectSuccessor(h, h.stores.invocations.get(stepA.id), stepA.blockedByDecisionId!);
      expect(successor.patternPosition).toEqual({ kind: "chain_step", index: 0, count: 2 });
      const positions = h.stores.invocations.listByPlanNode(node.id).map((i) => [i.patternPosition, i.status, i.continuedFromInvocationId]);
      expect(positions).toEqual([[{ kind: "chain_step", index: 0, count: 2 }, "blocked", null], [{ kind: "chain_step", index: 0, count: 2 }, "succeeded", stepA.id], [{ kind: "chain_step", index: 1, count: 2 }, "succeeded", null]]);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });
});

describe("capacity of a continuation", () => {
  /** A single node holding exactly one Invocation's allocation, whose Worker requests a Decision and later completes. */
  async function exhaustedNode(h: RuntimeHarness, policy: "fail" | "wait" | "extend") {
    const s = seedPlanningRuntime(h);
    const runId = s.created.run.id;
    const expression = { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "work" }, allocation: INVOCATION_ALLOCATION, onAllocationExhausted: policy } as PlanExpression;
    const { nodes } = planNodes(h, s, [expression]);
    const node = nodes[0] as PlanNode;
    await finishRoot(h, s);
    scriptByRole(h, { worker: [requesting([choice({ affects: { requirementIds: [], taskIds: [], planNodeIds: [node.id] } })]), workerStep(h, "a")] });
    expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
    const blocked = h.stores.invocations.listByPlanNode(node.id)[0]!;
    expect(blocked.status).toBe("blocked");
    expect(h.capacity.admits(h.stores.plans.getNode(node.id) as never, INVOCATION_ALLOCATION).fits).toBe(policy === "extend");
    return { s, runId, node, blocked, decisionId: blocked.blockedByDecisionId! };
  }

  it("funds the successor through the node's policy: fail ends the node, wait holds it (a Budget Increase alone never enlarges it), extend writes exactly the shortfall", async () => {
    for (const policy of ["fail", "wait", "extend"] as const) {
      const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const { runId, node, blocked, decisionId } = await exhaustedNode(h, policy);
        h.decisionRequests.resolve({ decisionId, optionId: "fastify" });
        const pass = await drain(h, runId);
        const successors = h.stores.invocations.listByPlanNode(node.id).filter((i) => i.continuedFromInvocationId === blocked.id);
        const extensions = h.stores.allocationExtensions.listByPlanNode(node.id);
        switch (policy) {
          case "fail":
            expect(successors).toEqual([]);
            expect(h.stores.plans.getNode(node.id).status).toBe("failed");
            expect(h.ctx.journal.read({ runId, type: "plan_node.failed" }).map((e) => [e.subjectId, (e.payload as { reason: string }).reason])).toEqual([[node.id, "allocation_exhausted"]]);
            expect(extensions).toEqual([]);
            break;
          case "wait": {
            expect(successors).toEqual([]);
            expect(pass.stop).toBe("waiting");
            expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "waiting", waitReason: "budget" });
            expect(h.stores.runs.get(runId)).toMatchObject({ status: "waiting", waitReason: "budget" });
            // More Run budget changes nothing for a `wait` node: its own allocation is what it waits for, and nothing extends it.
            const increase = h.budgetIncreases.request({ runId, partition: "ordinary", added: { costUsd: 10, tokens: 100_000, attempts: 10 } }).decision;
            expect(h.budgetIncreases.resolve({ runId, decisionId: increase.id, option: "approve" }).kind).toBe("approved");
            expect((await drain(h, runId)).stop).toBe("waiting");
            expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "waiting", waitReason: "budget" });
            expect(h.stores.invocations.listByPlanNode(node.id).filter((i) => i.continuedFromInvocationId === blocked.id)).toEqual([]);
            expect(h.stores.allocationExtensions.listByPlanNode(node.id)).toEqual([]);
            expect(h.provider.requests).toHaveLength(2);
            break;
          }
          case "extend": {
            expect(successors).toHaveLength(1);
            expect(successors[0]!.status).toBe("succeeded");
            expect(extensions).toHaveLength(1);
            expect(extensions[0]!.trigger).toBe("invocation");
            expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
            break;
          }
        }
      } finally {
        h.close();
      }
    }
  });

  it("holds the root's successor as a Run budget wait when its extension does not fit, and prepares it once a Budget Increase makes it fit", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      // The Run's ordinary capacity is exactly the root's allocation: one turn; a successor needs an extension the Run cannot admit.
      const s = seedRuntime(h, { orchestratorAllocation: INVOCATION_ALLOCATION, finalReserve: { costUsd: 0, tokens: 0, attempts: 0 }, budget: { ...DEFAULT_BUDGET, maxAttempts: INVOCATION_ALLOCATION.attempts } });
      const runId = s.created.run.id;
      const { invocation: first } = startRun(h, s).prepared;
      h.provider.script(requesting([choice()]), { kind: "succeed", result: COMPLETED_RESULT });
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const decisionId = h.stores.invocations.get(first.id).blockedByDecisionId!;
      h.decisionRequests.resolve({ decisionId, optionId: "fastify" });
      const pass = await drain(h, runId);
      expect(pass.stop).toBe("waiting");
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "waiting", waitReason: "budget" });
      expect(h.stores.invocations.listByRun(runId)).toHaveLength(1);
      expect(h.stores.allocationExtensions.listByRun(runId)).toEqual([]);
      const increase = h.budgetIncreases.request({ runId, partition: "ordinary", added: { costUsd: 0, tokens: 0, attempts: INVOCATION_ALLOCATION.attempts } }).decision;
      expect(h.budgetIncreases.resolve({ runId, decisionId: increase.id, option: "approve" }).kind).toBe("approved");
      await drain(h, runId);
      const successor = expectSuccessor(h, h.stores.invocations.get(first.id), decisionId);
      expect(successor.status).toBe("succeeded");
      expect(h.stores.allocationExtensions.listByRun(runId).map((e) => e.trigger)).toEqual(["root_turn"]);
      expect(h.stores.runs.get(runId).status).toBe("running");
    } finally {
      h.close();
    }
  });
});
