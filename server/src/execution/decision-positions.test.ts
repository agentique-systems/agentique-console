/**
 * Direct continuation at every position that can request a Decision
 * (execution-model §6.4, §8.2; invariants 5, 20, 28): the matrix is derived
 * from the canonical Pattern-position bindings and the role/purpose
 * handler bindings in core, never from a second handwritten mapping. At
 * each eligible position the blocked requester continues in exactly one
 * successor at the exact blocked position — the root Orchestrator at its
 * own purpose (an ordinary turn, a `gate_result` remediation turn, the
 * `decision_resolution` follow-up of a change request, and a continuation
 * that requests again), `single`, the first, a nonzero middle, and the
 * last `chain_step`, the inline `route_branch`, a nonzero `parallel_item`
 * and the `parallel_aggregation`, Coordinator `replan` and `synthesize`
 * turns and a `worker_task`, and a first and a later `producer_round` —
 * with the position's operation-defining inputs and Handoffs delivered
 * once, exactly one `decision_resolution` input, and no relay turn; and
 * every Evaluator position and the final synthesis can never call the
 * tool.
 */
import {
  COORDINATOR_PURPOSES,
  effectiveRuntimeTools,
  EVALUATOR_PURPOSES,
  ORCHESTRATOR_PURPOSES,
  parseParallelIndex,
  PATTERN_POSITION_BINDINGS,
  runtimeToolHandlerBound,
  runtimeToolsFor,
  type Invocation,
  type InvocationPurpose,
  type ArtifactId,
  type ManifestInput,
  type PlanNode,
} from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { advanceUntil, completionEvaluatorsOf, completionEvaluatorStep, requestingStep, synthesesOf, synthesisStep as finalSynthesisStep } from "./completion-test-support.ts";
import { cancel, coordinatorNode, finishRoot, portFor, proposal, propose, synthesisStep, tasksOf, turn, turnsOf, WIDE_GOVERNOR, workerStep as coordinatorWorkerStep } from "./coordinator-test-support.ts";
import { choice, dispatchByRole, drain, expectSuccessor, expectSuccessorManifest, positionOf, requestOnceAt, requesting } from "./decision-test-support.ts";
import { chainExpression, evaluatorsOf as gateEvaluatorsOf, gateEvaluatorStep, gatesOf, orchestratorStep, parallelExpression, remediationOf, rootTurnsOf, scriptByRole, seedCriteria as seedGateCriteria, singleExpression, workerStep } from "./gate-test-support.ts";
import { evaluatorsOf as optimizerEvaluatorsOf, evaluatorStep, optimizerNodes, producersOf, producerStep, seedCriteria, verdictsOf } from "./optimizer-test-support.ts";
import { awaitSignoff, followUpsOf, operatorMessage } from "./signoff-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, planNodes, seedPlanningRuntime, seedReadOnlyWorker, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

const WIDE_RESERVE = { costUsd: 20, tokens: 200_000, attempts: 8 };

/** A read-only Evaluator or final-synthesis Invocation: the tool is absent from its manifest, from the effective set, and from the port bound to its Attempt. */
async function expectNeverCallable(h: RuntimeHarness, invocation: Invocation) {
  const manifest = h.stores.invocations.getManifest(invocation.id).content;
  expect(manifest.runtimeTools, invocation.purpose).not.toContain("request_decision");
  expect(effectiveRuntimeTools(manifest.runtimeTools, invocation.role, invocation.purpose), invocation.purpose).not.toContain("request_decision");
  expect(runtimeToolHandlerBound("request_decision", invocation.role, invocation.purpose), invocation.purpose).toBe(false);
  const attempt = h.stores.invocations.listAttempts(invocation.id)[0]!;
  const port = portFor(h, invocation, attempt);
  expect(port.tools, invocation.purpose).not.toContain("request_decision");
  expect(await port.call(choice()), invocation.purpose).toEqual({ kind: "not_callable", tool: "request_decision" });
}

describe("request_decision eligibility, from the canonical bindings", () => {
  it("is bound exactly at the Worker and Coordinator positions and every Orchestrator purpose but final_synthesis, and never at an Evaluator position", () => {
    const rows: [string, InvocationPurpose, boolean][] = [];
    for (const [kind, binding] of Object.entries(PATTERN_POSITION_BINDINGS)) {
      const purposes: readonly InvocationPurpose[] = binding.purpose !== null ? [binding.purpose] : binding.role === "orchestrator" ? ORCHESTRATOR_PURPOSES : COORDINATOR_PURPOSES;
      for (const purpose of purposes) {
        const expected = binding.role !== "evaluator" && purpose !== "final_synthesis";
        rows.push([kind, purpose, expected]);
        expect(runtimeToolHandlerBound("request_decision", binding.role, purpose), `${kind}/${purpose}`).toBe(expected);
        expect(effectiveRuntimeTools(runtimeToolsFor(binding.role, purpose), binding.role, purpose).includes("request_decision"), `${kind}/${purpose}`).toBe(expected);
      }
    }
    for (const purpose of EVALUATOR_PURPOSES) expect(runtimeToolHandlerBound("request_decision", "evaluator", purpose)).toBe(false);
    expect(rows.filter(([, , bound]) => bound).map(([kind, purpose]) => `${kind}/${purpose}`)).toEqual([
      "orchestrator/operator_input",
      "orchestrator/plan_revision",
      "orchestrator/node_result",
      "orchestrator/decision_resolution",
      "orchestrator/gate_result",
      "single/step",
      "chain_step/step",
      "route_branch/step",
      "parallel_item/step",
      "parallel_aggregation/step",
      "coordinator_turn/decompose",
      "coordinator_turn/replan",
      "coordinator_turn/synthesize",
      "worker_task/task",
      "producer_round/step",
    ]);
    expect(rows.filter(([, , bound]) => !bound).map(([kind, purpose]) => `${kind}/${purpose}`)).toEqual(["orchestrator/final_synthesis", "route_selection/select", "evaluator_round/evaluate"]);
  });
});

describe("root Orchestrator continuation", () => {
  it("continues a gate_result remediation turn at its own purpose with its gate_result input once and its remediation Task under the successor, and the Gate Evaluator can never call the tool", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const criteria = seedGateCriteria(h, s, { evaluated: 1 });
      const { nodes } = planNodes(h, s, [singleExpression(s, "A", { gate: criteria.all })]);
      const node = nodes[0]!;
      await finishRoot(h, s);
      scriptByRole(h, {
        worker: [workerStep(h, "a")],
        evaluator: [gateEvaluatorStep(h, "fail"), gateEvaluatorStep(h, "pass")],
        orchestrator: [requesting([choice()]), orchestratorStep(h, (tasks) => ({ outputsFor: tasks.map((t) => t.id), diff: "+fix" }))],
      });
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const [gate] = gatesOf(h, node.id);
      const task = remediationOf(h, gate!.id)!;
      const turns = rootTurnsOf(h, runId);
      expect(turns.map((t) => [t.purpose, t.status])).toEqual([["operator_input", "succeeded"], ["gate_result", "blocked"]]);
      const blocked = turns[1]!;
      // A root-owned remediation Task is assigned to the turn (never listed in its taskIds): it stays running under the blocked turn and is taken over by the successor.
      expect(h.stores.tasks.get(task.id)).toMatchObject({ status: "running", invocationId: blocked.id });
      await expectNeverCallable(h, gateEvaluatorsOf(h, gate!.id)[0]!);
      h.decisionRequests.resolve({ decisionId: blocked.blockedByDecisionId!, optionId: "fastify" });
      const pass = await h.scheduler.advanceRun(runId, { maxActions: 2 });
      expect(pass.actions.map((a) => [a.action.kind, a.outcome.kind])).toEqual([["resume_run", "transitioned"], ["continue_decision_request", "successor_prepared"]]);
      const successor = expectSuccessor(h, h.stores.invocations.get(blocked.id), blocked.blockedByDecisionId!);
      expect(successor.purpose).toBe("gate_result");
      const content = expectSuccessorManifest(h, successor, ["gate_result", "decision_resolution"]);
      expect(content.inputs[0]).toEqual(h.stores.invocations.getManifest(blocked.id).content.inputs[0]);
      expect(h.stores.tasks.get(task.id)).toMatchObject({ status: "running", invocationId: successor.id });
      await drain(h, runId);
      expect(rootTurnsOf(h, runId).map((t) => [t.purpose, t.status])).toEqual([["operator_input", "succeeded"], ["gate_result", "blocked"], ["gate_result", "succeeded"], ["node_result", "succeeded"]]);
      expect(h.stores.tasks.get(task.id).status).toBe("completed");
      expect(gatesOf(h, node.id).map((g) => g.status)).toEqual(["failed", "passed"]);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });

  it("continues the decision_resolution follow-up of a change request at its own purpose with the signoff_resolution input once, and the run-completion Evaluator and the final synthesis can never call the tool", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h, { finalReserve: WIDE_RESERVE });
      const runId = s.created.run.id;
      seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
      scriptByRole(h, { orchestrator: [requestingStep(), finalSynthesisStep(h)], evaluator: [completionEvaluatorStep(h, "pass")] });
      await advanceUntil(h, runId, () => h.stores.runs.get(runId).status === "awaiting_signoff");
      await expectNeverCallable(h, completionEvaluatorsOf(h, runId)[0]!);
      await expectNeverCallable(h, synthesesOf(h, runId)[0]!);
      const gate = h.stores.gates.listByKind(runId, "operator_signoff").at(-1)!;
      const decisionId = h.stores.decisions.signoffOf(gate.id)!.id;
      h.signoff.requestChanges({ runId, gateId: gate.id, decisionId, operatorMessageId: operatorMessage(h, runId).id });
      const [followUp] = followUpsOf(h, runId);
      expect(followUp).toMatchObject({ purpose: "decision_resolution", status: "pending" });
      const turnsBefore = rootTurnsOf(h, runId).length;
      scriptByRole(h, { orchestrator: [requesting([choice()]), { kind: "succeed", result: COMPLETED_RESULT }] });
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const blocked = h.stores.invocations.get(followUp!.id);
      expect(blocked.status).toBe("blocked");
      h.decisionRequests.resolve({ decisionId: blocked.blockedByDecisionId!, optionId: "express" });
      await drain(h, runId);
      const successor = expectSuccessor(h, blocked, blocked.blockedByDecisionId!);
      expect(successor.purpose).toBe("decision_resolution");
      const content = expectSuccessorManifest(h, successor, ["signoff_resolution", "operator_message", "decision_resolution"]);
      expect(content.inputs.slice(0, 2)).toEqual(h.stores.invocations.getManifest(blocked.id).content.inputs);
      expect(successor.status).toBe("succeeded");
      expect(rootTurnsOf(h, runId)).toHaveLength(turnsBefore + 1);
      expect(followUpsOf(h, runId).map((t) => t.status)).toEqual(["blocked", "succeeded"]);
    } finally {
      h.close();
    }
  });

  it("delivers a continuation that requests again only the newer resolution: the third turn names no earlier Decision", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      const { invocation: first } = startRun(h, s).prepared;
      const before = h.stores.invocations.getManifest(first.id).content.inputs.map((i) => i.kind);
      h.provider.script(requesting([choice()]), requesting([choice({ question: "And the test runner?", options: [{ key: "vitest", label: "Vitest" }, { key: "node", label: "node:test" }], recommendedOptionKey: "vitest" })]), { kind: "succeed", result: COMPLETED_RESULT });
      await drain(h, runId);
      const firstDecision = h.stores.invocations.get(first.id).blockedByDecisionId!;
      h.decisionRequests.resolve({ decisionId: firstDecision, optionId: "express" });
      await drain(h, runId);
      const second = expectSuccessor(h, h.stores.invocations.get(first.id), firstDecision);
      expectSuccessorManifest(h, second, [...before, "decision_resolution"] as ManifestInput["kind"][]);
      const secondDecision = h.stores.invocations.get(second.id).blockedByDecisionId!;
      h.decisionRequests.resolve({ decisionId: secondDecision, optionId: "vitest" });
      await drain(h, runId);
      const third = expectSuccessor(h, h.stores.invocations.get(second.id), secondDecision);
      const content = expectSuccessorManifest(h, third, [...before, "decision_resolution"] as ManifestInput["kind"][]);
      expect(content.inputs.filter((i) => i.kind === "decision_resolution").map((i) => (i as { decisionId: string }).decisionId)).toEqual([secondDecision]);
      expect(content.decisions.map((d) => d.decisionId)).toEqual([secondDecision]);
      expect(rootTurnsOf(h, runId)).toHaveLength(3);
    } finally {
      h.close();
    }
  });
});

describe("Worker position continuation", () => {
  it("continues a single node's Worker at its one position with no operation input and the same Handoffs", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const { nodes } = planNodes(h, s, [singleExpression(s, "A")]);
      const node = nodes[0]!;
      await finishRoot(h, s);
      dispatchByRole(h, { worker: requestOnceAt(() => true, () => workerStep(h, "a")) });
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const blocked = h.stores.invocations.listByPlanNode(node.id)[0]!;
      expect(blocked).toMatchObject({ status: "blocked", patternPosition: { kind: "single" }, purpose: "step" });
      h.decisionRequests.resolve({ decisionId: blocked.blockedByDecisionId!, optionId: "fastify" });
      await drain(h, runId);
      const successor = expectSuccessor(h, blocked, blocked.blockedByDecisionId!);
      expectSuccessorManifest(h, successor, ["decision_resolution"]);
      expect(h.stores.invocations.listByPlanNode(node.id).map((i) => [i.patternPosition, i.status])).toEqual([[{ kind: "single" }, "blocked"], [{ kind: "single" }, "succeeded"]]);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });

  it("continues a chain at the exact blocked step — first, a nonzero middle, and last — never restarting at step 0 nor advancing early, with the incoming chain Handoff delivered once", async () => {
    for (const index of [0, 1, 2]) {
      const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const s = seedPlanningRuntime(h);
        const runId = s.created.run.id;
        const { nodes } = planNodes(h, s, [chainExpression(s, ["A", "B", "C"])]);
        const node = nodes[0]!;
        await finishRoot(h, s);
        dispatchByRole(h, { worker: requestOnceAt((i) => positionOf(i)?.kind === "chain_step" && (positionOf(i) as { index: number }).index === index, (i) => workerStep(h, `step${(positionOf(i) as { index: number }).index}`)) });
        expect(await drain(h, runId), `step ${index}`).toMatchObject({ stop: "waiting" });
        const steps = () => h.stores.invocations.listByPlanNode(node.id).map((i) => [(i.patternPosition as { index: number }).index, i.status, i.continuedFromInvocationId]);
        const blocked = h.stores.invocations.listByPlanNode(node.id).at(-1)!;
        expect(blocked.patternPosition, `step ${index}`).toEqual({ kind: "chain_step", index, count: 3 });
        // Nothing after the blocked step exists yet; everything before it succeeded once.
        expect(steps(), `step ${index}`).toEqual([...Array.from({ length: index }, (_, i) => [i, "succeeded", null]), [index, "blocked", null]]);
        const handoffsBefore = h.stores.handoffs.listByRun(runId).length;
        h.decisionRequests.resolve({ decisionId: blocked.blockedByDecisionId!, optionId: "fastify" });
        const pass = await h.scheduler.advanceRun(runId, { maxActions: 2 });
        expect(pass.actions.map((a) => [a.action.kind, a.outcome.kind]), `step ${index}`).toEqual([["resume_run", "transitioned"], ["continue_decision_request", "successor_prepared"]]);
        const successor = expectSuccessor(h, blocked, blocked.blockedByDecisionId!);
        expect(successor.patternPosition, `step ${index}`).toEqual({ kind: "chain_step", index, count: 3 });
        expectSuccessorManifest(h, successor, ["decision_resolution"]);
        // The continuation created no chain-step Handoff: the successor received exactly the blocked step's incoming Handoffs.
        expect(h.stores.handoffs.listByRun(runId), `step ${index}`).toHaveLength(handoffsBefore);
        expect(h.stores.invocations.getManifest(successor.id).content.handoffs, `step ${index}`).toHaveLength(index === 0 ? 0 : 1);
        await drain(h, runId);
        expect(steps(), `step ${index}`).toEqual([...Array.from({ length: index }, (_, i) => [i, "succeeded", null]), [index, "blocked", null], [index, "succeeded", blocked.id], ...Array.from({ length: 2 - index }, (_, i) => [index + 1 + i, "succeeded", null])]);
        expect(h.stores.handoffs.listByRun(runId), `step ${index}`).toHaveLength(2);
        expect(h.stores.plans.getNode(node.id).status, `step ${index}`).toBe("succeeded");
      } finally {
        h.close();
      }
    }
  });

  it("continues the inline route_branch at the selected label with the route_selection input once, starting no other branch and recording no second selection; the route_selection Evaluator can never call the tool", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const selector = seedReadOnlyWorker(h, "selector");
      const leaf = (title: string) => ({ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title } }) as const;
      const { nodes } = planNodes(h, s, [{ pattern: "route", selector: { kind: "evaluator", agentDefinitionRevisionId: selector.id }, branches: { quick: leaf("quick"), careful: leaf("careful") }, allocation: { costUsd: 12, tokens: 120_000, attempts: 12 } } as never]);
      const node = nodes[0]!;
      await finishRoot(h, s);
      dispatchByRole(h, {
        evaluator: () => ({ kind: "succeed", result: { ...COMPLETED_RESULT, routeSelection: { selectedLabel: "quick" } } }),
        worker: requestOnceAt((i) => positionOf(i)?.kind === "route_branch", () => workerStep(h, "quick")),
      });
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const selections = () => h.stores.evaluations.listByPlanNode(node.id).filter((e) => e.subject.kind === "route_selection");
      expect(selections()).toHaveLength(1);
      const selection = h.stores.invocations.listAtPosition(node.id, "route_selection")[0]!;
      await expectNeverCallable(h, selection);
      const blocked = h.stores.invocations.listByPlanNode(node.id).find((i) => i.patternPosition?.kind === "route_branch")!;
      expect(blocked).toMatchObject({ status: "blocked", patternPosition: { kind: "route_branch", label: "quick" } });
      h.decisionRequests.resolve({ decisionId: blocked.blockedByDecisionId!, optionId: "fastify" });
      await drain(h, runId);
      const successor = expectSuccessor(h, blocked, blocked.blockedByDecisionId!);
      expect(successor.patternPosition).toEqual({ kind: "route_branch", label: "quick" });
      const content = expectSuccessorManifest(h, successor, ["route_selection", "decision_resolution"]);
      expect(content.inputs[0]).toEqual({ kind: "route_selection", evaluationId: selections()[0]!.id, selectedLabel: "quick" });
      expect(selections()).toHaveLength(1);
      expect(h.stores.invocations.listByPlanNode(node.id).map((i) => [i.patternPosition, i.status])).toEqual([[{ kind: "route_selection" }, "succeeded"], [{ kind: "route_branch", label: "quick" }, "blocked"], [{ kind: "route_branch", label: "quick" }, "succeeded"]]);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });

  it("continues a nonzero parallel item and the aggregation at their exact positions: one index, canonical integration order, no other item touched, the index delivered once", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const { nodes } = planNodes(h, s, [parallelExpression(s, 3, { aggregate: true })]);
      const node = nodes[0]!;
      await finishRoot(h, s);
      const itemRequest = requestOnceAt((i) => positionOf(i)?.kind === "parallel_item" && (positionOf(i) as { index: number }).index === 1, (i) => workerStep(h, `item${(positionOf(i) as { index: number }).index}`));
      const aggregationRequest = requestOnceAt((i) => positionOf(i)?.kind === "parallel_aggregation", () => workerStep(h, "aggregate"));
      dispatchByRole(h, { worker: (i) => (positionOf(i)?.kind === "parallel_aggregation" ? aggregationRequest(i) : itemRequest(i)) });
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const at = (key: string) => h.stores.invocations.listAtPosition(node.id, key);
      const blockedItem = at("parallel_item:1")[0]!;
      expect(blockedItem).toMatchObject({ status: "blocked", patternPosition: { kind: "parallel_item", index: 1, count: 3 } });
      expect([at("parallel_item:0")[0]!.status, at("parallel_item:2")[0]!.status]).toEqual(["succeeded", "succeeded"]);
      expect(at("parallel_aggregation")).toEqual([]);
      const indexArtifacts = () => h.stores.artifacts.listByRun(runId).filter((a) => a.producer.kind === "runtime" && a.producer.component === "parallel_index");
      expect(indexArtifacts()).toEqual([]);
      h.decisionRequests.resolve({ decisionId: blockedItem.blockedByDecisionId!, optionId: "fastify" });
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const itemSuccessor = expectSuccessor(h, blockedItem, blockedItem.blockedByDecisionId!);
      expect(itemSuccessor.patternPosition).toEqual({ kind: "parallel_item", index: 1, count: 3 });
      expectSuccessorManifest(h, itemSuccessor, ["decision_resolution"]);
      expect(at("parallel_item:1").map((i) => i.status)).toEqual(["blocked", "succeeded"]);
      expect([at("parallel_item:0"), at("parallel_item:2")].map((l) => l.length)).toEqual([1, 1]);
      // Items integrated in item order, the successor standing for item 1; one index; the aggregation requested and blocked.
      const itemIds = new Set(h.stores.invocations.listByPlanNode(node.id).map((i) => i.id));
      const integrated = h.stores.changesets.listByRun(runId).filter((c) => c.integrationStatus === "integrated" && c.invocationId !== null && itemIds.has(c.invocationId)).map((c) => c.invocationId);
      expect([...integrated].sort()).toEqual([at("parallel_item:0")[0]!.id, itemSuccessor.id, at("parallel_item:2")[0]!.id].sort());
      expect(indexArtifacts()).toHaveLength(1);
      const index = parseParallelIndex(new TextDecoder().decode(h.stores.artifacts.read(indexArtifacts()[0]!.id).bytes));
      expect(index.items.map((i) => [i.index, i.invocationId, i.outcome])).toEqual([[0, at("parallel_item:0")[0]!.id, "succeeded"], [1, itemSuccessor.id, "succeeded"], [2, at("parallel_item:2")[0]!.id, "succeeded"]]);
      const blockedAggregation = at("parallel_aggregation")[0]!;
      expect(blockedAggregation).toMatchObject({ status: "blocked", patternPosition: { kind: "parallel_aggregation" } });
      h.decisionRequests.resolve({ decisionId: blockedAggregation.blockedByDecisionId!, optionId: "express" });
      await drain(h, runId);
      const aggregationSuccessor = expectSuccessor(h, blockedAggregation, blockedAggregation.blockedByDecisionId!);
      expect(aggregationSuccessor.patternPosition).toEqual({ kind: "parallel_aggregation" });
      const content = expectSuccessorManifest(h, aggregationSuccessor, ["decision_resolution"]);
      expect(content.handoffs).toHaveLength(1);
      expect(indexArtifacts()).toHaveLength(1);
      expect(at("parallel_aggregation").map((i) => i.status)).toEqual(["blocked", "succeeded"]);
      expect(h.stores.invocations.listByPlanNode(node.id)).toHaveLength(6);
      expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });
});

describe("coordinator_worker continuation", () => {
  it("continues replan and synthesize turns at the same logical turn (no turn consumed, ledger and blockers once) and a Worker Task re-owned once, with no root relay", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const { node, leafIds } = coordinatorNode(h, s, { bounds: { maxTasks: 8, maxConcurrentWorkers: 3, maxCoordinatorInvocations: 4 } });
      await finishRoot(h, s);
      const rootTurns = () => rootTurnsOf(h, runId).length;
      const final: { artifactId?: ArtifactId } = {};
      const subjectOf = (i: Invocation) => h.stores.tasks.get(i.taskIds[0]!).subject;
      const asked = new Set<string>();
      const ask = (key: string, i: Invocation) => {
        asked.add(key);
        return requesting([choice({ affects: { requirementIds: [], taskIds: i.taskIds, planNodeIds: [node.id] } })]);
      };
      dispatchByRole(h, {
        coordinator: (i) => {
          if (i.purpose === "decompose") return turn([propose([proposal({ key: "a", requirementIds: [leafIds[0]!] }), proposal({ key: "b", requirementIds: [leafIds[1]!] }), proposal({ key: "c", requirementIds: [leafIds[1]!], dependsOnKeys: ["a"] })])]);
          if (i.purpose === "replan") {
            if (!asked.has("replan")) return ask("replan", i);
            const [a, b] = tasksOf(h, node);
            return turn([propose([proposal({ key: "a2", requirementIds: [leafIds[0]!], replacesTaskId: a!.id })]), cancel(b!.id)]);
          }
          if (!asked.has("synthesize")) return ask("synthesize", i);
          return synthesisStep(h, runId, final);
        },
        worker: (i) => {
          const subject = subjectOf(i);
          if (subject === "task a") return coordinatorWorkerStep(h, { status: "failed" });
          if (subject === "task b") return coordinatorWorkerStep(h, { status: "blocked" });
          if (subject === "task a2" && !asked.has("a2")) return ask("a2", i);
          return coordinatorWorkerStep(h, { summary: subject, diff: `+${subject}` });
        },
      });
      // 1. The replan turn requests: the node and Run wait; the turn is blocked at its logical turn.
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const turnInput = (i: Invocation) => h.stores.invocations.getManifest(i.id).content.inputs.find((x): x is Extract<ManifestInput, { kind: "coordinator_turn" }> => x.kind === "coordinator_turn")!;
      const blockerKeys = (i: Invocation) => h.stores.invocations.getManifest(i.id).content.inputs.filter((x) => x.kind === "coordinator_blocker").length;
      let turns = turnsOf(h, node);
      expect(turns.map((t) => [t.purpose, t.status])).toEqual([["decompose", "succeeded"], ["replan", "blocked"]]);
      const replan = turns[1]!;
      expect(turnInput(replan).turnsUsed).toBe(2);
      h.decisionRequests.resolve({ decisionId: replan.blockedByDecisionId!, optionId: "fastify" });
      const pass = await h.scheduler.advanceRun(runId, { maxActions: 2 });
      expect(pass.actions.map((a) => [a.action.kind, a.outcome.kind])).toEqual([["resume_run", "transitioned"], ["continue_decision_request", "successor_prepared"]]);
      const replanSuccessor = expectSuccessor(h, h.stores.invocations.get(replan.id), replan.blockedByDecisionId!);
      expect(replanSuccessor.purpose).toBe("replan");
      const replanContent = expectSuccessorManifest(h, replanSuccessor, ["coordinator_turn", ...Array.from({ length: blockerKeys(replan) }, () => "coordinator_blocker" as const), "decision_resolution"]);
      expect(turnInput(replanSuccessor)).toMatchObject({ purpose: "replan", turnsUsed: 2, blockerKeys: turnInput(replan).blockerKeys });
      expect(replanContent.inputs.filter((x) => x.kind === "coordinator_blocker")).toEqual(h.stores.invocations.getManifest(replan.id).content.inputs.filter((x) => x.kind === "coordinator_blocker"));
      // 2. The replacement Task's Worker requests: its Task blocks on the Decision; the successor re-owns it once.
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const a2 = tasksOf(h, node).find((t) => t.subject === "task a2")!;
      const blockedWorker = h.stores.invocations.listByPlanNode(node.id).find((i) => i.taskIds[0] === a2.id)!;
      expect(blockedWorker).toMatchObject({ status: "blocked", purpose: "task", patternPosition: { kind: "worker_task", taskId: a2.id } });
      expect(h.stores.tasks.get(a2.id)).toMatchObject({ status: "blocked", blockReason: { kind: "decision", decisionId: blockedWorker.blockedByDecisionId } });
      const taskReservations = () => h.stores.reservations.listByChild({ type: "task", id: a2.id });
      expect(taskReservations()).toHaveLength(1);
      h.decisionRequests.resolve({ decisionId: blockedWorker.blockedByDecisionId!, optionId: "express" });
      expect(await drain(h, runId)).toMatchObject({ stop: "waiting" });
      const workerSuccessor = expectSuccessor(h, blockedWorker, blockedWorker.blockedByDecisionId!);
      expect(workerSuccessor).toMatchObject({ purpose: "task", taskIds: [a2.id], patternPosition: { kind: "worker_task", taskId: a2.id }, status: "succeeded" });
      expectSuccessorManifest(h, workerSuccessor, ["decision_resolution"]);
      expect(h.stores.tasks.get(a2.id)).toMatchObject({ status: "completed", invocationId: workerSuccessor.id });
      expect(taskReservations()).toHaveLength(1);
      expect(h.stores.invocations.listByPlanNode(node.id).filter((i) => i.taskIds[0] === a2.id)).toHaveLength(2);
      expect(h.ctx.journal.read({ runId, type: "task.blocked" }).filter((e) => e.subjectId === a2.id)).toHaveLength(1);
      // 3. The synthesize turn requests and continues at its own logical turn with the ledger once.
      turns = turnsOf(h, node);
      const synthesize = turns.at(-1)!;
      expect(synthesize).toMatchObject({ purpose: "synthesize", status: "blocked" });
      expect(turnInput(synthesize).turnsUsed).toBe(3);
      h.decisionRequests.resolve({ decisionId: synthesize.blockedByDecisionId!, optionId: "fastify" });
      await drain(h, runId);
      const synthesizeSuccessor = expectSuccessor(h, h.stores.invocations.get(synthesize.id), synthesize.blockedByDecisionId!);
      expect(synthesizeSuccessor.purpose).toBe("synthesize");
      const synthesizeContent = expectSuccessorManifest(h, synthesizeSuccessor, ["coordinator_turn", "decision_resolution"]);
      expect(turnInput(synthesizeSuccessor)).toMatchObject({ purpose: "synthesize", turnsUsed: 3 });
      expect(synthesizeContent.inputs.filter((x) => x.kind === "coordinator_turn")).toHaveLength(1);
      expect(turnsOf(h, node).map((t) => [t.purpose, t.status, turnInput(t).turnsUsed])).toEqual([["decompose", "succeeded", 1], ["replan", "blocked", 2], ["replan", "succeeded", 2], ["synthesize", "blocked", 3], ["synthesize", "succeeded", 3]]);
      expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [final.artifactId] });
      // No relay: the one further root turn is the node_result turn of the succeeded node (the ended node's result reaches the Orchestrator as one node_result turn (execution-model §4.6)).
      expect(rootTurns()).toBe(2);
    } finally {
      h.close();
    }
  });
});

describe("evaluator_optimizer continuation", () => {
  it("continues a first and a later producer round at the exact round with the feedback once, advancing no round and duplicating no Evaluation; the optimizer Evaluator can never call the tool", async () => {
    for (const round of [1, 2]) {
      const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const s = seedPlanningRuntime(h);
        const runId = s.created.run.id;
        const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
        const { byPath } = optimizerNodes(h, s, criteria, { maxRounds: 3 });
        const node = byPath["e0"] as PlanNode;
        await finishRoot(h, s);
        let produced = 0;
        dispatchByRole(h, {
          worker: requestOnceAt((i) => positionOf(i)?.kind === "producer_round" && (positionOf(i) as { round: number }).round === round, () => producerStep(h, `v${(produced += 1)}`)),
          evaluator: () => evaluatorStep(h, verdictsOf(h, node).length + 1 >= round ? "pass" : "fail"),
        });
        expect(await drain(h, runId), `round ${round}`).toMatchObject({ stop: "waiting" });
        const blocked = producersOf(h, node).at(-1)!;
        expect(blocked.patternPosition, `round ${round}`).toEqual({ kind: "producer_round", round, maxRounds: 3 });
        expect(blocked.status, `round ${round}`).toBe("blocked");
        const verdictsBefore = verdictsOf(h, node).length;
        const evaluationsBefore = h.stores.evaluations.listByPlanNode(node.id).length;
        expect(verdictsBefore, `round ${round}`).toBe(round - 1);
        if (round > 1) await expectNeverCallable(h, optimizerEvaluatorsOf(h, node)[0]!);
        h.decisionRequests.resolve({ decisionId: blocked.blockedByDecisionId!, optionId: "fastify" });
        const pass = await h.scheduler.advanceRun(runId, { maxActions: 2 });
        expect(pass.actions.map((a) => [a.action.kind, a.outcome.kind]), `round ${round}`).toEqual([["resume_run", "transitioned"], ["continue_decision_request", "successor_prepared"]]);
        const successor = expectSuccessor(h, blocked, blocked.blockedByDecisionId!);
        expect(successor.patternPosition, `round ${round}`).toEqual({ kind: "producer_round", round, maxRounds: 3 });
        const content = expectSuccessorManifest(h, successor, round === 1 ? ["decision_resolution"] : ["optimizer_feedback", "decision_resolution"]);
        if (round > 1) expect(content.inputs[0], `round ${round}`).toEqual(h.stores.invocations.getManifest(blocked.id).content.inputs[0]);
        // The continuation advanced nothing: no new verdict, check, or Evaluation, and no round beyond the blocked one.
        expect(verdictsOf(h, node), `round ${round}`).toHaveLength(verdictsBefore);
        expect(h.stores.evaluations.listByPlanNode(node.id), `round ${round}`).toHaveLength(evaluationsBefore);
        expect(producersOf(h, node).map((p) => (p.patternPosition as { round: number }).round), `round ${round}`).toEqual([...Array.from({ length: round - 1 }, (_, i) => i + 1), round, round]);
        await drain(h, runId);
        expect(h.stores.invocations.listByPlanNode(node.id).map((i) => [`${i.patternPosition!.kind}:${(i.patternPosition as { round: number }).round}`, i.status]), `round ${round}`).toEqual([
          ...Array.from({ length: round - 1 }, (_, i) => [[`producer_round:${i + 1}`, "succeeded"], [`evaluator_round:${i + 1}`, "succeeded"]]).flat(),
          [`producer_round:${round}`, "blocked"],
          [`producer_round:${round}`, "succeeded"],
          [`evaluator_round:${round}`, "succeeded"],
        ]);
        expect(verdictsOf(h, node).map((v) => v.verdict), `round ${round}`).toEqual([...Array.from({ length: round - 1 }, () => "fail"), "pass"]);
        expect(h.stores.plans.getNode(node.id).status, `round ${round}`).toBe("succeeded");
      } finally {
        h.close();
      }
    }
  });
});
