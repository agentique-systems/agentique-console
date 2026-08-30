/**
 * The `route` Pattern runner (execution-model §5.3, §4.3; invariants 5 the
 * runtime owns fan-in and dependencies, 7 Workers receive only their
 * manifest, 9 canonical objects by id, 20 one Invocation per turn): a
 * Decision selector that selects without an Attempt, a canonical wait on an
 * open Decision, an Evaluator selector with exactly one read-only selection
 * Invocation and exactly one Evaluation, an invalid label failing
 * deterministically, an inline branch executing and integrating, a
 * composite selection activating only its edge and skipping every other
 * branch while successors wait for the selected exit, restart without
 * duplicate Evaluations or Invocations, and selection uniqueness under
 * repeated and concurrent settlement.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DecisionId, InvocationId, PlanExpression, PlanNode, PlanNodeId, RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import type { MemoryBlobStore } from "../../persistence/blob-store.ts";
import { openHarness, type TestClock } from "../../persistence/test-support.ts";
import { COMPLETED_RESULT, fakeSnapshot, openRuntimeHarness, planNodes, seedPlanningRuntime, seedReadOnlyWorker, type RuntimeHarness } from "../test-support.ts";

const CALL = { tool: "shell", input: { command: "npm test" } };
const ALLOCATION = { costUsd: 6, tokens: 60_000, attempts: 6 };

function leaf(s: ReturnType<typeof seedPlanningRuntime>, title: string): PlanExpression {
  return { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title } };
}

function requestDecision(h: RuntimeHarness, s: ReturnType<typeof seedPlanningRuntime>, optionIds: string[]) {
  return h.stores.decisions.request({
    conversationId: s.created.run.conversationId,
    runId: s.created.run.id,
    kind: "operator_choice",
    resolutionPolicy: "operator_required",
    requestedBy: { kind: "operator" },
    question: "Which path?",
    options: optionIds.map((id) => ({ id, label: id, description: null })),
    recommendedOptionId: null,
    rationale: null,
    affects: { requirementIds: [], taskIds: [], planNodeIds: [] },
    deadlineAt: null,
    activationCondition: null,
    subject: null,
    supersedesDecisionId: null,
  });
}

function resolve(h: RuntimeHarness, decisionId: DecisionId, chosenOptionId: string) {
  return h.stores.decisions.resolve(decisionId, { resolvedBy: "operator", chosenOptionId, rationale: null, artifactIds: [] });
}

/** Scripts a completed result producing one Artifact with a content Changeset and executes the Invocation. */
async function complete(h: RuntimeHarness, invocationId: InvocationId, summary: string) {
  const runId = h.stores.invocations.get(invocationId).runId;
  const artifact = h.stores.artifacts.create({ runId, mediaType: "text/plain", producer: { kind: "invocation", invocationId, attemptId: null }, taskId: null, title: summary }, new TextEncoder().encode(`content of ${summary}`));
  h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("after", invocationId), diff: new TextEncoder().encode(`+${summary}`), empty: false };
  h.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [artifact.id], summary } });
  const outcome = await h.executor.advanceInvocation(invocationId);
  if (outcome.kind !== "finalized" || outcome.settlement.invocation.status !== "succeeded") throw new Error(`did not succeed: ${outcome.kind}`);
  return artifact;
}

const statusOf = (h: RuntimeHarness, node: PlanNode | PlanNodeId) => h.stores.plans.getNode(typeof node === "string" ? node : node.id).status;
const selections = (h: RuntimeHarness, nodeId: PlanNodeId) => h.stores.evaluations.listByPlanNode(nodeId).filter((e) => e.subject.kind === "route_selection");

describe("RoutePatternRunner", () => {
  it("selects an inline branch from a resolved Decision without any selection Attempt, executes and integrates the branch, and hands its output to the successor", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const decision = resolve(h, requestDecision(h, s, ["fast", "slow"]).id, "slow");
      const { nodes, revisionNumber } = planNodes(h, s, [
        {
          pattern: "chain",
          steps: [
            { pattern: "route", selector: { kind: "decision_answer", decisionId: decision.id, labelsByOptionId: { fast: "quick", slow: "careful" } }, branches: { quick: leaf(s, "quick"), careful: leaf(s, "careful") }, allocation: ALLOCATION },
            { ...leaf(s, "after"), allocation: ALLOCATION },
          ],
        },
      ]);
      const [route, after] = nodes as [PlanNode, PlanNode];
      expect(route.kind === "pattern" && route.pattern).toBe("route");
      h.stores.plans.transitionNode(route.id, { to: "ready" });
      const runner = h.runners.route;
      expect(runner.inspect(route.id)).toEqual({ kind: "start" });
      const seq = h.ctx.journal.lastSeq();
      const started = runner.start(route.id, revisionNumber);
      // One transaction: the node runs, the selection is recorded once, the inline branch is prepared; no selection Invocation, no Attempt.
      expect(started).toMatchObject({ kind: "selected", selectedLabel: "careful" });
      if (started.kind !== "selected" || started.invocationId === null) throw new Error(started.kind);
      expect(h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type)).toEqual(["plan_node.started", "evaluation.recorded", "invocation.created", "budget_reservation.created", "invocation.workspace_prepared", "snapshot.taken", "context_manifest.created"]);
      const recorded = selections(h, route.id);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ id: started.evaluationId, planNodeId: route.id, gateId: null, subject: { kind: "route_selection", selectedLabel: "careful" }, verdict: "pass", producedBy: { kind: "runtime" }, artifactIds: [], evidence: [] });
      const branch = h.stores.invocations.get(started.invocationId);
      expect(branch).toMatchObject({ role: "worker", purpose: "step", patternPosition: { kind: "route_branch", label: "careful" }, continuedFromInvocationId: null });
      expect(h.stores.invocations.listByPlanNode(route.id)).toHaveLength(1);
      expect(h.stores.invocations.listAttempts(branch.id)).toEqual([]);
      expect(h.provider.requests).toHaveLength(0);
      // The branch's manifest carries the selection as its typed input and nothing of the selector beyond it; the label is nowhere else.
      const manifest = h.stores.invocations.getManifest(branch.id).content;
      expect(manifest.inputs).toEqual([{ kind: "route_selection", evaluationId: started.evaluationId, selectedLabel: "careful" }]);
      expect(manifest.handoffs).toEqual([]);
      expect(JSON.stringify(manifest).split("careful")).toHaveLength(3);
      expect(runner.start(route.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(runner.inspect(route.id)).toEqual({ kind: "execute", invocationId: branch.id });
      // The branch executes and integrates; the node's output is the branch's Artifacts and the successor receives them.
      const artifact = await complete(h, branch.id, "careful work");
      expect(runner.inspect(route.id)).toEqual({ kind: "settle", invocationId: branch.id });
      const settled = await runner.settle(route.id, revisionNumber);
      expect(settled).toMatchObject({ kind: "succeeded", outputArtifactIds: [artifact.id] });
      if (settled.kind !== "succeeded") throw new Error(settled.kind);
      expect(h.stores.changesets.listByRun(s.created.run.id).map((c) => c.integrationStatus)).toEqual(["integrated"]);
      expect(h.stores.plans.getNode(route.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [artifact.id] });
      expect(settled.handoffIds).toHaveLength(1);
      expect(h.stores.handoffs.get(settled.handoffIds[0]!)).toMatchObject({ handoffKey: `sequence:${route.id}:${after.id}`, artifactIds: [artifact.id], summary: "careful work" });
      expect(selections(h, route.id)).toHaveLength(1);
      expect(await runner.settle(route.id, revisionNumber)).toEqual({ kind: "no_change" });
      // The scheduler readies and runs the successor from the recorded selection.
      const outcome = await h.scheduler.advanceRun(s.created.run.id);
      expect(outcome.stop).toBe("quiescent");
      expect(statusOf(h, after)).toBe("succeeded");
      expect(h.stores.invocations.getManifest(h.stores.invocations.listByPlanNode(after.id)[0]!.id).content.handoffs.map((x) => x.artifactIds)).toEqual([[artifact.id]]);
    } finally {
      h.close();
    }
  });

  it("waits canonically on an unresolved selector Decision, resumes after resolution, and fails deterministically on an unmapped or superseded answer", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const open = requestDecision(h, s, ["fast", "slow", "odd"]);
      const { nodes } = planNodes(h, s, [{ pattern: "route", selector: { kind: "decision_answer", decisionId: open.id, labelsByOptionId: { fast: "quick", slow: "careful" } }, branches: { quick: leaf(s, "quick"), careful: leaf(s, "careful") }, allocation: ALLOCATION }]);
      const route = nodes[0]!;
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.advanceInvocation(s.invocation.id);
      const waiting = await h.scheduler.advanceRun(s.created.run.id);
      // The node and the Run wait with reason `decision`; no Invocation, Attempt, or Evaluation exists.
      expect(waiting).toMatchObject({ stop: "waiting", waiting: [{ nodeId: route.id, reason: "decision" }] });
      expect(h.stores.plans.getNode(route.id)).toMatchObject({ status: "waiting", waitReason: "decision" });
      expect(h.stores.runs.get(s.created.run.id)).toMatchObject({ status: "waiting", waitReason: "decision" });
      expect(h.stores.invocations.listByPlanNode(route.id)).toEqual([]);
      expect(selections(h, route.id)).toEqual([]);
      expect(h.runners.route.inspect(route.id)).toEqual({ kind: "waiting", reason: "decision", cleared: false, wakeAt: null });
      const seq = h.ctx.journal.lastSeq();
      expect(await h.scheduler.advanceRun(s.created.run.id)).toMatchObject({ stop: "waiting", actions: [] });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      // Resolution clears the wait; the resumed pass selects, runs the branch, and completes the node.
      resolve(h, open.id, "fast");
      expect(h.runners.route.inspect(route.id)).toEqual({ kind: "waiting", reason: "decision", cleared: true, wakeAt: null });
      const resumed = await h.scheduler.advanceRun(s.created.run.id);
      expect(resumed.stop).toBe("quiescent");
      expect(resumed.actions.map((p) => p.action.kind).slice(0, 2)).toEqual(["resume_run", "resume_node"]);
      expect(resumed.actions[1]!.outcome).toMatchObject({ kind: "selected", selectedLabel: "quick" });
      expect(statusOf(h, route)).toBe("succeeded");
      expect(selections(h, route.id).map((e) => e.subject)).toEqual([{ kind: "route_selection", selectedLabel: "quick" }]);
      expect(h.stores.invocations.listByPlanNode(route.id).map((i) => i.patternPosition)).toEqual([{ kind: "route_branch", label: "quick" }]);
    } finally {
      h.close();
    }
    // An answer mapped to no branch fails the node deterministically, with no Invocation and no Evaluation.
    const u = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(u);
      const decision = resolve(u, requestDecision(u, s, ["fast", "odd"]).id, "odd");
      const { nodes, revisionNumber } = planNodes(u, s, [{ pattern: "route", selector: { kind: "decision_answer", decisionId: decision.id, labelsByOptionId: { fast: "quick" } }, branches: { quick: leaf(s, "quick") }, allocation: ALLOCATION }]);
      u.stores.plans.transitionNode(nodes[0]!.id, { to: "ready" });
      expect(u.runners.route.start(nodes[0]!.id, revisionNumber)).toEqual({ kind: "failed", reason: "route_selection_failed" });
      expect(u.stores.plans.getNode(nodes[0]!.id).status).toBe("failed");
      expect(u.stores.invocations.listByPlanNode(nodes[0]!.id)).toEqual([]);
      expect(selections(u, nodes[0]!.id)).toEqual([]);
    } finally {
      u.close();
    }
  });

  it("runs exactly one read-only Evaluator selection Invocation, records exactly one Evaluation from its typed label, and fails deterministically on an invalid label", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const selector = seedReadOnlyWorker(h, "selector");
      const { nodes, revisionNumber } = planNodes(h, s, [{ pattern: "route", selector: { kind: "evaluator", agentDefinitionRevisionId: selector.id }, branches: { quick: leaf(s, "quick"), careful: leaf(s, "careful") }, allocation: ALLOCATION }]);
      const route = nodes[0]!;
      h.stores.plans.transitionNode(route.id, { to: "ready" });
      const runner = h.runners.route;
      const started = runner.start(route.id, revisionNumber);
      expect(started).toMatchObject({ kind: "started", position: { kind: "route_selection" } });
      if (started.kind !== "started") throw new Error(started.kind);
      const selection = h.stores.invocations.get(started.invocationId);
      expect(selection).toMatchObject({ role: "evaluator", purpose: "select", agentDefinitionRevisionId: selector.id, workspaceCleanup: "none" });
      const manifest = h.stores.invocations.getManifest(selection.id).content;
      // Read-only by role policy, no worktree, no write tool, exactly the selector's (empty) operation input.
      expect(manifest.capabilities.tools).toEqual(["read"]);
      expect(manifest.worktreePath).toBe(h.stores.runs.get(s.created.run.id).integrationWorkspacePath);
      expect(manifest.startingSnapshotId).toBe(s.created.run.baseSnapshotId);
      expect(manifest.tasks).toEqual([]);
      expect(manifest.artifacts).toEqual([]);
      expect(manifest.runtimeTools).not.toContain("request_decision");
      expect(runner.start(route.id, revisionNumber)).toEqual({ kind: "no_change" });
      // A label the shape does not bind is an invalid result: the Attempt fails with the exact violation and a retry is permitted.
      h.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, routeSelection: { selectedLabel: "sideways" } } });
      const invalid = await h.executor.advanceInvocation(selection.id);
      expect(invalid).toMatchObject({ kind: "finalized", attempt: { status: "failed", failureClass: "result_invalid", failureDetail: { violations: [{ code: "selection_invalid", path: "routeSelection.selectedLabel" }] } }, settlement: { kind: "retry_pending" } });
      expect(selections(h, route.id)).toEqual([]);
      expect(await runner.settle(route.id, revisionNumber)).toEqual({ kind: "no_change" });
      // A completed result without a selection is invalid too; a valid label ends the Invocation and the settle records exactly one Evaluation.
      h.clock.advance(5_000);
      h.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, routeSelection: { selectedLabel: "careful" }, summary: "careful is right" } });
      const selected = await h.executor.advanceInvocation(selection.id);
      expect(selected).toMatchObject({ kind: "finalized", settlement: { invocation: { status: "succeeded" } } });
      expect(h.provider.requests).toHaveLength(2);
      expect(h.provider.requests[1]!.request.input.text).toContain("selection_invalid");
      expect(h.stores.changesets.listByRun(s.created.run.id)).toEqual([]);
      expect(runner.inspect(route.id)).toEqual({ kind: "settle", invocationId: selection.id });
      const settled = await runner.settle(route.id, revisionNumber);
      expect(settled).toMatchObject({ kind: "selected", selectedLabel: "careful" });
      if (settled.kind !== "selected" || settled.invocationId === null) throw new Error(settled.kind);
      const recorded = selections(h, route.id);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ id: settled.evaluationId, subject: { kind: "route_selection", selectedLabel: "careful" }, verdict: "pass", producedBy: { kind: "evaluator", invocationId: selection.id, agentDefinitionRevisionId: selector.id } });
      // Exactly one selection Invocation, one branch Invocation; the branch receives the selection input, never the selector's transcript or summary.
      expect(h.stores.invocations.listByPlanNode(route.id).map((i) => i.patternPosition)).toEqual([{ kind: "route_selection" }, { kind: "route_branch", label: "careful" }]);
      const branch = h.stores.invocations.getManifest(settled.invocationId).content;
      expect(branch.inputs).toEqual([{ kind: "route_selection", evaluationId: settled.evaluationId, selectedLabel: "careful" }]);
      expect(JSON.stringify(branch)).not.toContain("careful is right");
      // Repeated settlement records nothing twice.
      expect(await runner.settle(route.id, revisionNumber)).toEqual({ kind: "no_change" });
      expect(selections(h, route.id)).toHaveLength(1);
    } finally {
      h.close();
    }
    // No valid label within the permitted Attempts fails the node with the stable route-selection reason.
    const f = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(f);
      const selector = seedReadOnlyWorker(f, "selector");
      const { nodes, revisionNumber } = planNodes(f, s, [{ pattern: "route", selector: { kind: "evaluator", agentDefinitionRevisionId: selector.id }, branches: { quick: leaf(s, "quick") }, allocation: ALLOCATION }]);
      const route = nodes[0]!;
      f.stores.plans.transitionNode(route.id, { to: "ready" });
      const started = f.runners.route.start(route.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      f.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, routeSelection: { selectedLabel: "nope" } } }, { kind: "succeed", result: COMPLETED_RESULT });
      await f.executor.advanceInvocation(started.invocationId);
      f.clock.advance(5_000);
      const last = await f.executor.advanceInvocation(started.invocationId);
      expect(last).toMatchObject({ kind: "finalized", settlement: { invocation: { status: "failed", failureReason: "result_invalid" } } });
      expect(await f.runners.route.settle(route.id, revisionNumber)).toEqual({ kind: "failed", reason: "route_selection_failed" });
      expect(f.stores.plans.getNode(route.id).status).toBe("failed");
      expect(selections(f, route.id)).toEqual([]);
      expect(f.stores.invocations.listByPlanNode(route.id)).toHaveLength(1);
      // An Evaluator that declares write tools is still read-only and records no Changeset.
      expect(f.stores.changesets.listByRun(s.created.run.id)).toEqual([]);
    } finally {
      f.close();
    }
  });

  it("activates only the selected composite branch, skips every other branch, and makes successors wait for the selected exit", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const decision = resolve(h, requestDecision(h, s, ["b"]).id, "b");
      // chain(route(d, { a: leaf, b: chain(B0, B1), c: chain(C0, C1) }), S)
      const { nodes, outcome } = planNodes(h, s, [
        {
          pattern: "chain",
          steps: [
            {
              pattern: "route",
              selector: { kind: "decision_answer", decisionId: decision.id, labelsByOptionId: { b: "b" } },
              branches: { a: leaf(s, "a"), b: { pattern: "chain", steps: [leaf(s, "B0"), leaf(s, "B1")], allocation: ALLOCATION }, c: { pattern: "chain", steps: [leaf(s, "C0"), leaf(s, "C1")], allocation: ALLOCATION } },
              allocation: ALLOCATION,
            },
            { ...leaf(s, "S"), allocation: ALLOCATION },
          ],
        },
      ]);
      const byPath = Object.fromEntries(nodes.map((n) => [n.sourcePath, n]));
      const route = byPath["e0/steps/0"]!;
      const b = byPath["e0/steps/0/branches/b"]!;
      const c = byPath["e0/steps/0/branches/c"]!;
      const after = byPath["e0/steps/1"]!;
      expect(outcome.graph.edges.map((e) => [e.type, e.sourceNodeId === route.id ? "route" : e.sourceNodeId === b.id ? "b" : "c", e.targetNodeId === after.id ? "S" : e.targetNodeId === b.id ? "b" : "c"])).toEqual([["branch", "route", "b"], ["branch", "route", "c"], ["sequence", "route", "S"], ["sequence", "b", "S"], ["sequence", "c", "S"]]);
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.advanceInvocation(s.invocation.id);
      // Pass 1: the route settles as a composite selection; the pass bounds itself so the intermediate state is observable.
      const first = await h.scheduler.advanceRun(s.created.run.id, { maxActions: 3 });
      expect(first.actions.map((p) => p.action.kind)).toEqual(["settle_root", "ready_node", "start_node"]);
      expect(first.actions[2]!.outcome).toMatchObject({ kind: "selected", selectedLabel: "b", invocationId: null });
      expect(h.stores.plans.getNode(route.id)).toMatchObject({ status: "succeeded", outputArtifactIds: [] });
      expect(h.stores.invocations.listByPlanNode(route.id)).toEqual([]);
      // Exactly one Handoff exists: the branch transfer to b; nothing to c or S.
      expect(h.stores.handoffs.listByRun(s.created.run.id).map((x) => x.handoffKey)).toEqual([`branch:${route.id}:${b.id}`]);
      const projection = h.scheduler.reconcileRun(s.created.run.id);
      expect(projection.actions).toEqual([{ kind: "ready_node", nodeId: b.id }, { kind: "skip_node", nodeId: c.id, cause: "all_predecessors_skipped", failed: [] }]);
      expect(projection.nodes.find((n) => n.nodeId === after.id)!.readiness).toEqual({ kind: "remain_pending", nodeId: after.id, awaiting: [b.id, c.id] });
      // Pass 2: b runs (both steps), c is skipped, and S waits until b's exit is terminal, then runs with b's Handoff only.
      const rest = await h.scheduler.advanceRun(s.created.run.id);
      expect(rest.stop).toBe("quiescent");
      expect([statusOf(h, b), statusOf(h, c), statusOf(h, after)]).toEqual(["succeeded", "skipped", "succeeded"]);
      expect(h.stores.invocations.listByPlanNode(c.id)).toEqual([]);
      const startedS = rest.actions.findIndex((p) => p.action.kind === "start_node" && p.action.nodeId === after.id);
      const settledB = rest.actions.findIndex((p) => p.action.kind === "settle_node" && p.action.nodeId === b.id && p.outcome.kind === "succeeded");
      expect(settledB).toBeGreaterThanOrEqual(0);
      expect(startedS).toBeGreaterThan(settledB);
      const sManifest = h.stores.invocations.getManifest(h.stores.invocations.listByPlanNode(after.id)[0]!.id).content;
      expect(sManifest.handoffs.map((x) => x.source)).toEqual([{ kind: "plan_node", planNodeId: b.id }]);
      expect(h.stores.handoffs.listByRun(s.created.run.id).map((x) => x.handoffKey).sort()).toEqual([`branch:${route.id}:${b.id}`, `chain_step:${b.id}:0`, `sequence:${b.id}:${after.id}`].sort());
      // b's first step received the branch Handoff (no Artifacts) as its incoming edge Handoff.
      const b0 = h.stores.invocations.listByPlanNode(b.id)[0]!;
      expect(h.stores.invocations.getManifest(b0.id).content.handoffs).toEqual([expect.objectContaining({ source: { kind: "plan_node", planNodeId: route.id }, artifactIds: [], summary: expect.stringContaining("selected b") })]);
      expect(selections(h, route.id)).toHaveLength(1);
    } finally {
      h.close();
    }
    // An inline selection beside composite alternatives: every composite branch is skipped and the successor proceeds from the route alone.
    const i = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(i);
      const decision = resolve(i, requestDecision(i, s, ["a"]).id, "a");
      const { nodes } = planNodes(i, s, [
        {
          pattern: "chain",
          steps: [
            { pattern: "route", selector: { kind: "decision_answer", decisionId: decision.id, labelsByOptionId: { a: "a" } }, branches: { a: leaf(s, "a"), b: { pattern: "chain", steps: [leaf(s, "B0"), leaf(s, "B1")], allocation: ALLOCATION } }, allocation: ALLOCATION },
            { ...leaf(s, "S"), allocation: ALLOCATION },
          ],
        },
      ]);
      const byPath = Object.fromEntries(nodes.map((n) => [n.sourcePath, n]));
      const outcome = await i.scheduler.advanceRun(s.created.run.id);
      expect(outcome.stop).toBe("quiescent");
      expect([statusOf(i, byPath["e0/steps/0"]!), statusOf(i, byPath["e0/steps/0/branches/b"]!), statusOf(i, byPath["e0/steps/1"]!)]).toEqual(["succeeded", "skipped", "succeeded"]);
      expect(i.stores.handoffs.listByRun(s.created.run.id).map((x) => x.handoffKey)).toEqual([`sequence:${byPath["e0/steps/0"]!.id}:${byPath["e0/steps/1"]!.id}`]);
      expect(i.stores.invocations.listByPlanNode(byPath["e0/steps/0"]!.id).map((x) => x.patternPosition)).toEqual([{ kind: "route_branch", label: "a" }]);
    } finally {
      i.close();
    }
  });

  it("keeps an approval-blocked inline branch at its position with the selection re-delivered, and fails the node when the branch fails", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const decision = resolve(h, requestDecision(h, s, ["a"]).id, "a");
      const { nodes, revisionNumber } = planNodes(h, s, [{ pattern: "route", selector: { kind: "decision_answer", decisionId: decision.id, labelsByOptionId: { a: "a" } }, branches: { a: leaf(s, "a") }, allocation: ALLOCATION }]);
      const route = nodes[0]!;
      h.stores.plans.transitionNode(route.id, { to: "ready" });
      const runner = h.runners.route;
      const started = runner.start(route.id, revisionNumber);
      if (started.kind !== "selected" || started.invocationId === null) throw new Error(started.kind);
      h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
      const blocked = await h.executor.advanceInvocation(started.invocationId);
      if (blocked.kind !== "approval_required") throw new Error(blocked.kind);
      expect(await runner.settle(route.id, revisionNumber)).toEqual({ kind: "waiting", reason: "decision", wakeAt: null });
      expect(runner.inspect(route.id)).toEqual({ kind: "waiting", reason: "decision", cleared: false, wakeAt: null });
      resolve(h, blocked.decision.id, "approve_once");
      const resumed = runner.resume(route.id, revisionNumber);
      expect(resumed).toMatchObject({ kind: "successor_prepared", position: { kind: "route_branch", label: "a" }, decisionId: blocked.decision.id });
      if (resumed.kind !== "successor_prepared") throw new Error(resumed.kind);
      const successor = h.stores.invocations.getManifest(resumed.invocationId).content;
      expect(successor.continuedFromInvocationId).toBe(started.invocationId);
      expect(successor.inputs.map((x) => x.kind)).toEqual(["route_selection", "side_effect_approval_resolution"]);
      expect(selections(h, route.id)).toHaveLength(1);
      h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "permanent_error", message: "compiler crashed" } });
      await h.executor.advanceInvocation(resumed.invocationId);
      expect(await runner.settle(route.id, revisionNumber)).toEqual({ kind: "failed", reason: "invocation_failed" });
      expect(h.stores.invocations.listByPlanNode(route.id).map((x) => [x.patternPosition?.kind, x.status])).toEqual([["route_branch", "blocked"], ["route_branch", "failed"]]);
    } finally {
      h.close();
    }
  });

  it("records one selection under repeated or concurrent settlement: the store, the database, and the runner all refuse a second", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const selector = seedReadOnlyWorker(h, "selector");
      const { nodes, revisionNumber } = planNodes(h, s, [{ pattern: "route", selector: { kind: "evaluator", agentDefinitionRevisionId: selector.id }, branches: { x: leaf(s, "x"), y: leaf(s, "y") }, allocation: ALLOCATION }]);
      const route = nodes[0]!;
      h.stores.plans.transitionNode(route.id, { to: "ready" });
      const started = h.runners.route.start(route.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      h.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, routeSelection: { selectedLabel: "y" } } });
      await h.executor.advanceInvocation(started.invocationId);
      // Two settlements racing in one process run one after the other; the second finds the selection and writes nothing.
      const [first, second] = await Promise.all([h.runners.route.settle(route.id, revisionNumber), h.runners.route.settle(route.id, revisionNumber)]);
      expect([first.kind, second.kind].sort()).toEqual(["no_change", "selected"]);
      expect(selections(h, route.id)).toHaveLength(1);
      expect(h.stores.invocations.listAtPosition(route.id, "route_branch:y")).toHaveLength(1);
      // The store refuses a second selection (any label), and the database refuses a row that bypasses the store.
      expect(() => h.stores.evaluations.record({ context: null, snapshotId: null, runId: s.created.run.id, planNodeId: route.id, gateId: null, subject: { kind: "route_selection", selectedLabel: "x" }, verdict: "pass", evidence: [], producedBy: { kind: "runtime" }, artifactIds: [] })).toThrow(/already selected/);
      expect(() => h.stores.evaluations.record({ context: null, snapshotId: null, runId: s.created.run.id, planNodeId: route.id, gateId: null, subject: { kind: "route_selection", selectedLabel: "y" }, verdict: "pass", evidence: [], producedBy: { kind: "runtime" }, artifactIds: [] })).toThrow(/already selected/);
      expect(() =>
        h.database.sqlite
          .prepare("INSERT INTO evaluations (id, run_id, plan_node_id, gate_id, subject, verdict, evidence, produced_by, artifact_ids, created_at) VALUES (?, ?, ?, NULL, ?, 'pass', '[]', ?, '[]', ?)")
          .run("eval_" + "0".repeat(24), s.created.run.id, route.id, JSON.stringify({ kind: "route_selection", selectedLabel: "x" }), JSON.stringify({ kind: "runtime" }), "2026-01-01T00:00:00.000Z"),
      ).toThrow(/UNIQUE constraint failed: evaluations.plan_node_id/);
      // A selection is admitted only for a route node binding the label, never for another node or with a null verdict.
      expect(() => h.stores.evaluations.record({ context: null, snapshotId: null, runId: s.created.run.id, planNodeId: s.created.root.id, gateId: null, subject: { kind: "route_selection", selectedLabel: "x" }, verdict: "pass", evidence: [], producedBy: { kind: "runtime" }, artifactIds: [] })).toThrow(/not a route node/);
      expect(() => h.stores.evaluations.record({ context: null, snapshotId: null, runId: s.created.run.id, planNodeId: route.id, gateId: null, subject: { kind: "route_selection", selectedLabel: "x" }, verdict: "fail", evidence: [], producedBy: { kind: "runtime" }, artifactIds: [] })).toThrow(/selection that was made/);
      expect(h.stores.evaluations.routeSelectionOf(route.id)?.subject).toEqual({ kind: "route_selection", selectedLabel: "y" });
    } finally {
      h.close();
    }
  });

  it("stops the scheduler with a typed failure when a succeeded route carries no selection fact, never guessing a branch", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const decision = resolve(h, requestDecision(h, s, ["b"]).id, "b");
      const { nodes } = planNodes(h, s, [{ pattern: "route", selector: { kind: "decision_answer", decisionId: decision.id, labelsByOptionId: { b: "b" } }, branches: { a: leaf(s, "a"), b: { pattern: "chain", steps: [leaf(s, "B0"), leaf(s, "B1")], allocation: ALLOCATION } }, allocation: ALLOCATION }]);
      const route = nodes.find((n) => n.sourcePath === "e0")!;
      const b = nodes.find((n) => n.sourcePath === "e0/branches/b")!;
      // The route ends succeeded without its canonical selection (a contradiction the runtime never produces itself).
      h.stores.plans.transitionNode(route.id, { to: "ready" });
      h.stores.plans.transitionNode(route.id, { to: "running" });
      h.stores.plans.transitionNode(route.id, { to: "succeeded", outputArtifactIds: [] });
      expect(() => h.scheduler.reconcileRun(s.created.run.id)).toThrow(/without a recorded route-selection Evaluation/);
      const outcome = await h.scheduler.advanceRun(s.created.run.id);
      expect(outcome).toMatchObject({ stop: "infrastructure_failure", actions: [], failure: { message: expect.stringContaining("route-selection Evaluation") } });
      expect(h.stores.plans.getNode(b.id).status).toBe("pending");
      expect(h.stores.handoffs.listByRun(s.created.run.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("converges across restarts between selection and branch execution without a second Evaluation or Invocation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-route-"));
    try {
      const file = path.join(dir, "console.db");
      let clock: TestClock;
      let blobs: MemoryBlobStore;
      let runId: RunId;
      let routeId: PlanNodeId;
      let afterId: PlanNodeId;
      let selectionId: InvocationId;
      // Process 1: the selection Invocation succeeds with its label; the process dies before the settle records the selection.
      {
        const h = openRuntimeHarness({ base: openHarness(file) });
        clock = h.clock;
        blobs = h.blobs;
        const s = seedPlanningRuntime(h);
        runId = s.created.run.id;
        const selector = seedReadOnlyWorker(h, "selector");
        const { nodes } = planNodes(h, s, [{ pattern: "chain", steps: [{ pattern: "route", selector: { kind: "evaluator", agentDefinitionRevisionId: selector.id }, branches: { x: leaf(s, "x"), y: leaf(s, "y") }, allocation: ALLOCATION }, { ...leaf(s, "S"), allocation: ALLOCATION }] }]);
        routeId = nodes[0]!.id;
        afterId = nodes[1]!.id;
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT }, { kind: "succeed", result: { ...COMPLETED_RESULT, routeSelection: { selectedLabel: "x" } } });
        await h.executor.advanceInvocation(s.invocation.id);
        const pass = await h.scheduler.advanceRun(runId, { maxActions: 4 });
        expect(pass.actions.map((p) => p.action.kind)).toEqual(["settle_root", "ready_node", "start_node", "execute_invocation"]);
        selectionId = h.stores.invocations.listByPlanNode(routeId)[0]!.id;
        expect(h.stores.invocations.get(selectionId).status).toBe("succeeded");
        expect(selections(h, routeId)).toEqual([]);
        h.close();
      }
      // Process 2: the settle records the one selection and prepares the branch in one transaction; the process dies before the branch runs.
      let branchId: InvocationId;
      {
        const h = openRuntimeHarness({ base: openHarness(file, { clock, blobs }) });
        expect(h.recovery.recover().interruptedAttemptIds).toEqual([]);
        expect(h.scheduler.reconcileRun(runId).actions).toEqual([{ kind: "settle_node", nodeId: routeId, invocationId: selectionId }]);
        const pass = await h.scheduler.advanceRun(runId, { maxActions: 1 });
        expect(pass.actions[0]!.outcome).toMatchObject({ kind: "selected", selectedLabel: "x" });
        expect(selections(h, routeId)).toHaveLength(1);
        branchId = h.stores.invocations.listAtPosition(routeId, "route_branch:x")[0]!.id;
        expect(h.provider.requests).toHaveLength(0);
        h.close();
      }
      // Process 3: nothing is repeated — the same Evaluation and the same branch Invocation are found from rows; the branch runs and the chain completes.
      {
        const h = openRuntimeHarness({ base: openHarness(file, { clock, blobs }) });
        h.recovery.recover();
        expect(h.scheduler.reconcileRun(runId).actions).toEqual([{ kind: "execute_invocation", nodeId: routeId, invocationId: branchId, worktrees: 1 }]);
        const outcome = await h.scheduler.advanceRun(runId);
        expect(outcome.stop).toBe("quiescent");
        expect(selections(h, routeId)).toHaveLength(1);
        expect(h.stores.invocations.listByPlanNode(routeId).map((x) => [x.patternPosition?.kind, x.status])).toEqual([["route_selection", "succeeded"], ["route_branch", "succeeded"]]);
        expect(h.stores.plans.getNode(routeId).status).toBe("succeeded");
        expect(h.stores.plans.getNode(afterId).status).toBe("succeeded");
        expect(h.provider.requests).toHaveLength(2);
        h.close();
      }
      {
        const h = openRuntimeHarness({ base: openHarness(file, { clock, blobs }) });
        h.recovery.recover();
        const before = h.ctx.journal.lastSeq();
        expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "quiescent", actions: [] });
        expect(h.ctx.journal.lastSeq()).toBe(before);
        h.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
