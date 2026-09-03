/**
 * Restart and concurrency of Decision continuations at Pattern-specific
 * positions (execution-model §8.2, §14; invariants 5, 20, 22, 28), over a
 * file-backed database opened by successive processes: a nonzero chain
 * step, the inline route branch, a nonzero parallel item, a later optimizer
 * producer round, and a Coordinator Worker Task each hold their exact
 * position across reopen, repeat no provider work before the resolution,
 * gain exactly one successor with one reservation and one workspace and
 * (for a Task) one ownership transition, and duplicate no Handoff,
 * integration, Evaluation, Artifact, or runtime-tool call; a continuation
 * whose node waits for fixed `wait` capacity stays exactly where it is
 * across reopen and after a Run Budget Increase; and two scheduler
 * processes racing for the same continuation prepare at most one
 * successor — the write lock, the runners' re-read, and the one-successor
 * index all standing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Invocation, type ManifestInput, type PlanNodeId, type RunId } from "@agentique-console/core";
import { describe, expect, it, vi } from "vitest";
import { coordinatorNode, finishRoot, proposal, propose, synthesisStep, tasksOf, turn, workerStep as coordinatorWorkerStep } from "./coordinator-test-support.ts";
import { choice, dispatchByRole, positionOf, requestOnceAt, requesting } from "./decision-test-support.ts";
import { chainExpression, parallelExpression, singleExpression, workerStep } from "./gate-test-support.ts";
import { evaluatorStep, optimizerNodes, producerStep, seedCriteria, verdictsOf } from "./optimizer-test-support.ts";
import { competitor, newWorld as worldAt, openProcess, withProcess as withProcessOver, type World } from "./recovery-test-support.ts";
import { COMPLETED_RESULT, INVOCATION_ALLOCATION, planNodes, seedPlanningRuntime, seedReadOnlyWorker, type RuntimeHarness } from "./test-support.ts";

function newWorld(prefix: string): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return worldAt(dir, path.join(dir, "console.db"));
}
const removeWorld = (w: World) => fs.rmSync(w.dir, { recursive: true, force: true });
const withProcess = <T>(w: World, body: (h: RuntimeHarness) => Promise<T> | T, options: { recover?: boolean } = {}) => withProcessOver(w, body, { ...options, after: () => vi.restoreAllMocks() });

/** A Pattern-specific scenario: how its node is planned, how each process scripts the provider, which position requests, and what the successor carries. */
interface Scenario {
  name: string;
  /** Plans the node in the seeding process and returns its id. */
  plan: (h: RuntimeHarness, s: ReturnType<typeof seedPlanningRuntime>) => PlanNodeId;
  /** Scripts the provider for a process (fresh per process): with `request`, the target position requests once; everything else completes. */
  script: (h: RuntimeHarness, nodeId: PlanNodeId, request: boolean) => void;
  /** The exact position the blocked requester and its successor hold. */
  position: (nodeId: PlanNodeId, h: RuntimeHarness) => unknown;
  /** The successor's exact manifest inputs. */
  inputs: ManifestInput["kind"][];
}

const scenarios: Scenario[] = [
  {
    name: "a nonzero chain step",
    plan: (h, s) => planNodes(h, s, [chainExpression(s, ["A", "B", "C"])]).nodes[0]!.id,
    script: (h, _nodeId, request) => dispatchByRole(h, { worker: requestOnceAt((i) => request && positionOf(i)?.kind === "chain_step" && (positionOf(i) as { index: number }).index === 1, (i) => workerStep(h, `step${(positionOf(i) as { index: number }).index}`)) }),
    position: () => ({ kind: "chain_step", index: 1, count: 3 }),
    inputs: ["decision_resolution"],
  },
  {
    name: "the inline route branch",
    plan: (h, s) => {
      const selector = seedReadOnlyWorker(h, "selector");
      const leaf = (title: string) => ({ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title } });
      return planNodes(h, s, [{ pattern: "route", selector: { kind: "evaluator", agentDefinitionRevisionId: selector.id }, branches: { quick: leaf("quick"), careful: leaf("careful") }, allocation: { costUsd: 12, tokens: 120_000, attempts: 12 } } as never]).nodes[0]!.id;
    },
    script: (h, _nodeId, request) =>
      dispatchByRole(h, {
        evaluator: () => ({ kind: "succeed", result: { ...COMPLETED_RESULT, routeSelection: { selectedLabel: "quick" } } }),
        worker: requestOnceAt((i) => request && positionOf(i)?.kind === "route_branch", () => workerStep(h, "quick")),
      }),
    position: () => ({ kind: "route_branch", label: "quick" }),
    inputs: ["route_selection", "decision_resolution"],
  },
  {
    name: "a nonzero parallel item",
    plan: (h, s) => planNodes(h, s, [parallelExpression(s, 3)]).nodes[0]!.id,
    script: (h, _nodeId, request) => dispatchByRole(h, { worker: requestOnceAt((i) => request && positionOf(i)?.kind === "parallel_item" && (positionOf(i) as { index: number }).index === 2, (i) => workerStep(h, `item${(positionOf(i) as { index: number }).index}`)) }),
    position: () => ({ kind: "parallel_item", index: 2, count: 3 }),
    inputs: ["decision_resolution"],
  },
  {
    name: "a later optimizer producer round",
    plan: (h, s) => optimizerNodes(h, s, seedCriteria(h, s, { deterministic: 1, evaluated: 1 }), { maxRounds: 3 }).byPath["e0"]!.id,
    script: (h, nodeId, request) => {
      let produced = 0;
      dispatchByRole(h, {
        worker: requestOnceAt((i) => request && positionOf(i)?.kind === "producer_round" && (positionOf(i) as { round: number }).round === 2, () => producerStep(h, `v${(produced += 1)}`)),
        evaluator: () => evaluatorStep(h, verdictsOf(h, nodeId).length >= 1 ? "pass" : "fail"),
      });
    },
    position: () => ({ kind: "producer_round", round: 2, maxRounds: 3 }),
    inputs: ["optimizer_feedback", "decision_resolution"],
  },
  {
    name: "a Coordinator Worker Task",
    plan: (h, s) => coordinatorNode(h, s, { leaves: 1, bounds: { maxTasks: 2, maxConcurrentWorkers: 1, maxCoordinatorInvocations: 3 } }).node.id,
    script: (h, nodeId, request) => {
      const final: { artifactId?: never } = {};
      dispatchByRole(h, {
        coordinator: (i) => (i.purpose === "decompose" ? turn([propose([proposal({ key: "a", requirementIds: [h.stores.plans.listScope(nodeId)[0]!.requirementId] })])]) : synthesisStep(h, i.runId, final)),
        worker: requestOnceAt((i) => request && positionOf(i)?.kind === "worker_task", () => coordinatorWorkerStep(h, { summary: "a", diff: "+a" }), (i) => ({ requirementIds: [], taskIds: i.taskIds, planNodeIds: [nodeId] })),
      });
    },
    position: (nodeId, h) => ({ kind: "worker_task", taskId: tasksOf(h, h.stores.plans.getNode(nodeId))[0]!.id }),
    inputs: ["decision_resolution"],
  },
];

/** Everything a repeated continuation could duplicate at a node, from rows alone. */
function facts(h: RuntimeHarness, runId: RunId, nodeId: PlanNodeId) {
  const invocations = h.stores.invocations.listByPlanNode(nodeId);
  return {
    invocations: invocations.map((i) => [i.id, i.patternPosition, i.status, i.continuedFromInvocationId, i.workspaceCleanup, i.taskIds]),
    attempts: invocations.flatMap((i) => h.stores.invocations.listAttempts(i.id).map((a) => [a.id, a.status])),
    reservations: invocations.flatMap((i) => h.stores.reservations.listByChild({ type: "invocation", id: i.id }).map((r) => [r.id, r.status])),
    taskReservations: h.stores.tasks.listByPlanNode(nodeId).flatMap((t) => h.stores.reservations.listByChild({ type: "task", id: t.id }).map((r) => [r.id, r.status])),
    tasks: h.stores.tasks.listByPlanNode(nodeId).map((t) => [t.id, t.status, t.invocationId]),
    taskBlocks: h.ctx.journal.read({ runId, type: "task.blocked" }).length,
    handoffs: h.stores.handoffs.listByRun(runId).map((x) => x.id),
    evaluations: h.stores.evaluations.listByPlanNode(nodeId).map((e) => e.id),
    artifacts: h.stores.artifacts.listByRun(runId).map((a) => a.id),
    changesets: h.stores.changesets.listByRun(runId).map((c) => [c.id, c.integrationStatus]),
    calls: invocations.flatMap((i) => h.stores.runtimeToolCalls.listByInvocation(i.id).map((c) => c.id)),
    decisions: h.stores.decisions.listByRun(runId).map((d) => [d.id, d.status]),
    node: [h.stores.plans.getNode(nodeId).status, h.stores.plans.getNode(nodeId).waitReason],
    run: [h.stores.runs.get(runId).status, h.stores.runs.get(runId).waitReason],
    extensions: h.stores.allocationExtensions.listByRun(runId).map((e) => e.id),
    events: h.ctx.journal.read({ runId }).length,
  };
}

const blockedOf = (h: RuntimeHarness, nodeId: PlanNodeId) => h.stores.invocations.listByPlanNode(nodeId).find((i) => i.status === "blocked")!;
const successorsOf = (h: RuntimeHarness, nodeId: PlanNodeId, blocked: Invocation) => h.stores.invocations.listByPlanNode(nodeId).filter((i) => i.continuedFromInvocationId === blocked.id);

describe("decision continuation recovery at Pattern positions", () => {
  for (const scenario of scenarios) {
    it(`holds ${scenario.name} across reopen, resolves, and continues exactly once`, async () => {
      const w = newWorld("agentique-decision-pos-");
      try {
        // Process A: plan, run to the blocked request.
        await withProcess(w, async (h) => {
          const s = seedPlanningRuntime(h);
          w.runId = s.created.run.id;
          w.nodeId = scenario.plan(h, s);
          await finishRoot(h, s);
          scenario.script(h, w.nodeId, true);
          const pass = await h.scheduler.advanceRun(w.runId);
          for (let i = 0; i < 16 && h.stores.invocations.listByPlanNode(w.nodeId).every((x) => x.status !== "blocked"); i += 1) await h.scheduler.advanceRun(w.runId);
          expect(pass.failure ?? null, scenario.name).toBeNull();
          const blocked = blockedOf(h, w.nodeId);
          expect(blocked, scenario.name).toBeDefined();
          expect(blocked.patternPosition, scenario.name).toEqual(scenario.position(w.nodeId, h));
        }, { recover: false });
        const atBlocked = await withProcess(w, (h) => facts(h, w.runId, w.nodeId));
        // Process B: nothing moves before the resolution — no provider call, no successor — then the operator resolves; the process dies.
        await withProcess(w, async (h) => {
          scenario.script(h, w.nodeId, false);
          expect((await h.scheduler.advanceRun(w.runId)).stop, scenario.name).toBe("waiting");
          expect(h.provider.requests, scenario.name).toHaveLength(0);
          expect(facts(h, w.runId, w.nodeId), scenario.name).toEqual(atBlocked);
          const blocked = blockedOf(h, w.nodeId);
          h.decisionRequests.resolve({ decisionId: blocked.blockedByDecisionId!, optionId: "fastify" });
        });
        // Process C: exactly one successor at the exact position, with one reservation and one workspace; nothing else touched.
        const prepared = await withProcess(w, async (h) => {
          scenario.script(h, w.nodeId, false);
          const blocked = blockedOf(h, w.nodeId);
          const pass = await h.scheduler.advanceRun(w.runId, { maxActions: 2 });
          expect(pass.actions.map((a) => [a.action.kind, a.outcome.kind]), scenario.name).toEqual([["resume_run", "transitioned"], ["continue_decision_request", "successor_prepared"]]);
          expect(h.provider.requests, scenario.name).toHaveLength(0);
          const successors = successorsOf(h, w.nodeId, blocked);
          expect(successors, scenario.name).toHaveLength(1);
          const successor = successors[0]!;
          expect(successor, scenario.name).toMatchObject({ patternPosition: scenario.position(w.nodeId, h), role: blocked.role, purpose: blocked.purpose, taskIds: blocked.taskIds, status: "pending", workspaceCleanup: "pending" });
          expect(h.stores.invocations.getManifest(successor.id).content.inputs.map((i) => i.kind), scenario.name).toEqual(scenario.inputs);
          expect(h.stores.reservations.listByChild({ type: "invocation", id: successor.id }).map((r) => r.status), scenario.name).toEqual(["active"]);
          const f = facts(h, w.runId, w.nodeId);
          for (const key of ["handoffs", "evaluations", "artifacts", "changesets", "calls", "taskBlocks", "extensions"] as const) expect(f[key], `${scenario.name}: ${key}`).toEqual(atBlocked[key]);
          expect(f.taskReservations, scenario.name).toEqual(atBlocked.taskReservations);
          expect(f.tasks, scenario.name).toEqual(atBlocked.tasks.map(([id, status, owner]) => (blocked.taskIds.includes(id as never) ? [id, "running", successor.id] : [id, status, owner])));
          return f;
        });
        // Process D: a repeated pass prepares no second successor; the successor executes once and the node completes.
        await withProcess(w, async (h) => {
          scenario.script(h, w.nodeId, false);
          expect(facts(h, w.runId, w.nodeId), scenario.name).toEqual(prepared);
          expect(h.scheduler.reconcileRun(w.runId).actions.filter((a) => a.kind === "continue_decision_request"), scenario.name).toEqual([]);
          for (let i = 0; i < 16 && h.stores.plans.getNode(w.nodeId).status !== "succeeded"; i += 1) await h.scheduler.advanceRun(w.runId);
          const blocked = blockedOf(h, w.nodeId);
          expect(successorsOf(h, w.nodeId, blocked).map((i) => i.status), scenario.name).toEqual(["succeeded"]);
          expect(h.stores.plans.getNode(w.nodeId).status, scenario.name).toBe("succeeded");
          expect(h.stores.invocations.listByPlanNode(w.nodeId).filter((i) => i.status === "blocked"), scenario.name).toHaveLength(1);
        });
        // Process E: settled rows change nothing more.
        const settled = await withProcess(w, (h) => facts(h, w.runId, w.nodeId));
        await withProcess(w, async (h) => {
          scenario.script(h, w.nodeId, false);
          await h.scheduler.advanceRun(w.runId);
          expect(facts(h, w.runId, w.nodeId), scenario.name).toEqual(settled);
          expect(h.provider.requests, scenario.name).toHaveLength(0);
        });
      } finally {
        removeWorld(w);
      }
    });
  }

  it("holds a continuation whose node waits for fixed wait capacity exactly where it is across reopen and after a Run Budget Increase", async () => {
    const w = newWorld("agentique-decision-wait-");
    try {
      await withProcess(w, async (h) => {
        const s = seedPlanningRuntime(h);
        w.runId = s.created.run.id;
        w.nodeId = planNodes(h, s, [{ ...singleExpression(s, "work", { allocation: INVOCATION_ALLOCATION }), onAllocationExhausted: "wait" } as never]).nodes[0]!.id;
        await finishRoot(h, s);
        h.provider.script(requesting([choice({ affects: { requirementIds: [], taskIds: [], planNodeIds: [w.nodeId] } })]));
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("waiting");
        const blocked = blockedOf(h, w.nodeId);
        h.decisionRequests.resolve({ decisionId: blocked.blockedByDecisionId!, optionId: "fastify" });
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("waiting");
        expect(h.stores.plans.getNode(w.nodeId)).toMatchObject({ status: "waiting", waitReason: "budget" });
        expect(h.stores.runs.get(w.runId)).toMatchObject({ status: "waiting", waitReason: "budget" });
      }, { recover: false });
      const waiting = await withProcess(w, (h) => facts(h, w.runId, w.nodeId));
      await withProcess(w, async (h) => {
        expect(h.scheduler.reconcileRun(w.runId).actions).toEqual([]);
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("waiting");
        expect(facts(h, w.runId, w.nodeId)).toEqual(waiting);
        // More Run budget changes nothing for a `wait` node: no extension, no successor, the same wait.
        const increase = h.budgetIncreases.request({ runId: w.runId, partition: "ordinary", added: { costUsd: 10, tokens: 100_000, attempts: 10 } }).decision;
        expect(h.budgetIncreases.resolve({ runId: w.runId, decisionId: increase.id, option: "approve" }).kind).toBe("approved");
        expect((await h.scheduler.advanceRun(w.runId)).stop).toBe("waiting");
        expect(h.stores.plans.getNode(w.nodeId)).toMatchObject({ status: "waiting", waitReason: "budget" });
        expect(successorsOf(h, w.nodeId, blockedOf(h, w.nodeId))).toEqual([]);
        expect(h.stores.allocationExtensions.listByRun(w.runId)).toEqual([]);
        expect(h.provider.requests).toHaveLength(0);
      });
      const still = await withProcess(w, (h) => facts(h, w.runId, w.nodeId));
      await withProcess(w, async (h) => {
        await h.scheduler.advanceRun(w.runId);
        expect(facts(h, w.runId, w.nodeId)).toEqual(still);
        expect(h.decisionRequests.pendingContinuations(w.runId).map((c) => c.invocation.id)).toEqual([blockedOf(h, w.nodeId).id]);
      });
    } finally {
      removeWorld(w);
    }
  });

  it("lets two scheduler processes race for the same continuation with exactly one successor: the write lock, the runner's re-read, and the one-successor index", async () => {
    const w = newWorld("agentique-decision-race-");
    let a: RuntimeHarness | null = null;
    let b: RuntimeHarness | null = null;
    try {
      await withProcess(w, async (h) => {
        const s = seedPlanningRuntime(h);
        w.runId = s.created.run.id;
        w.nodeId = planNodes(h, s, [chainExpression(s, ["A", "B", "C"])]).nodes[0]!.id;
        w.revisionNumber = h.stores.plans.latestRevisionNumber(w.runId);
        await finishRoot(h, s);
        dispatchByRole(h, { worker: requestOnceAt((i) => positionOf(i)?.kind === "chain_step" && (positionOf(i) as { index: number }).index === 1, (i) => workerStep(h, `step${(positionOf(i) as { index: number }).index}`)) });
        for (let i = 0; i < 8 && h.stores.invocations.listByPlanNode(w.nodeId).every((x) => x.status !== "blocked"); i += 1) await h.scheduler.advanceRun(w.runId);
        const blocked = blockedOf(h, w.nodeId);
        h.decisionRequests.resolve({ decisionId: blocked.blockedByDecisionId!, optionId: "fastify" });
      }, { recover: false });
      a = openProcess(w);
      b = competitor(w);
      const rival = b;
      const blocked = blockedOf(a, w.nodeId);
      expect(a.scheduler.reconcileRun(w.runId).actions.map((x) => x.kind)).toEqual(["resume_run", "continue_decision_request"]);
      expect(rival.scheduler.reconcileRun(w.runId).actions.map((x) => x.kind)).toEqual(["resume_run", "continue_decision_request"]);
      a.stores.runs.transition(w.runId, { to: "running", clearedWaitReason: "decision" });
      // While one process prepares the successor inside its transaction the other cannot begin; afterwards it finds nothing to continue.
      const outcome = a.ctx.tx.write(() => {
        const prepared = a!.runners.chain.resume(w.nodeId, w.revisionNumber, {}, blocked.id);
        expect(() => rival.runners.chain.resume(w.nodeId, w.revisionNumber, {}, blocked.id)).toThrow(/SQLITE_BUSY|database is locked/);
        return prepared;
      });
      expect(outcome).toMatchObject({ kind: "successor_prepared", position: { kind: "chain_step", index: 1, count: 3 } });
      expect(rival.runners.chain.resume(w.nodeId, w.revisionNumber, {}, blocked.id)).toEqual({ kind: "no_change" });
      expect(rival.scheduler.reconcileRun(w.runId).actions.filter((x) => x.kind === "continue_decision_request")).toEqual([]);
      expect(rival.decisionRequests.pendingContinuations(w.runId)).toEqual([]);
      expect(successorsOf(rival, w.nodeId, blocked)).toHaveLength(1);
      // The database refuses a second Invocation continuing from the same predecessor whatever the process believes.
      const other = rival.stores.invocations.listByPlanNode(w.nodeId).find((i) => i.continuedFromInvocationId === null && i.id !== blocked.id)!;
      expect(() => rival.ctx.sqlite.prepare("UPDATE invocations SET continued_from_invocation_id = ? WHERE id = ?").run(blocked.id, other.id)).toThrow(/UNIQUE|immutable|never changes/i);
      expect(successorsOf(a, w.nodeId, blocked)).toHaveLength(1);
      expect(facts(a, w.runId, w.nodeId)).toEqual(facts(rival, w.runId, w.nodeId));
    } finally {
      b?.close();
      a?.close();
      removeWorld(w);
    }
  });
});
