/**
 * Reservable Plan Node capacity (execution-model §7.6; invariant 22): the
 * one operation every node-funded path goes through. `fail` never extends,
 * `wait` never extends, `extend` creates exactly the component-wise
 * shortfall from the Run's effective ordinary capacity — atomically with the
 * work it funds, never from the final reserve, never speculatively — and
 * waits on budget otherwise; a Coordinator's Task batch is funded by one
 * exact aggregate extension or refused whole; a Gate Evaluator is funded the
 * same way; a Task-to-Worker transfer needs none; an existing Invocation is
 * never enlarged.
 */
import type { Allocation, PlanExpression, PlanNode } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, seedBudgetIncrease } from "../persistence/test-support.ts";
import { COORDINATOR_NODE_ALLOCATION, finishRoot, portFor, proposal, propose, tasksOf, WIDE_GOVERNOR, workersOf, workerStep as coordinatorWorkerStep, type PlanningSeed } from "./coordinator-test-support.ts";
import { evaluatorsOf, gateEvaluatorStep, gatesOf, scriptByRole, seedCriteria, singleExpression, workerStep } from "./gate-test-support.ts";
import { asSeeded, INVOCATION_ALLOCATION, openRuntimeHarness, planNodes, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

const ZERO: Allocation = { costUsd: 0, tokens: 0, attempts: 0 };

/** A ready single worker node with the given allocation and policy. */
function readySingle(h: RuntimeHarness, s: PlanningSeed, allocation: Allocation, policy: "fail" | "wait" | "extend") {
  const expression: PlanExpression = { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "work" }, allocation, onAllocationExhausted: policy } as PlanExpression;
  const { nodes, revisionNumber } = planNodes(h, s, [expression]);
  h.stores.plans.transitionNode(nodes[0]!.id, { to: "ready" });
  return { node: h.stores.plans.getNode(nodes[0]!.id) as PlanNode & { kind: "pattern" }, revisionNumber };
}

/** Every row a capacity operation may write, for "nothing was written" assertions. */
function capacityWork(h: RuntimeHarness, runId: string) {
  return {
    extensions: h.stores.allocationExtensions.listByRun(runId as never).map((e) => e.id),
    invocations: h.stores.invocations.listByRun(runId as never).map((i) => i.id),
    tasks: h.stores.tasks.listByRun(runId as never).map((t) => t.id),
    reservations: h.stores.reservations.listByParent({ type: "run", id: runId as never }).length + h.stores.plans.listNodes(runId as never).reduce((n, node) => n + h.stores.reservations.listByParent({ type: "plan_node", id: node.id }).length, 0),
    usage: h.stores.usage.totalsForRun(runId as never).rows,
    events: h.ctx.journal.read({ runId: runId as never }).length,
  };
}

describe("plan node capacity", () => {
  it("funds by policy: fail never extends, wait never extends, extend creates exactly the shortfall inside a transaction and only when the Run's ordinary capacity covers it; the final reserve is never used", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const small = { costUsd: 1, tokens: 1_000, attempts: 1 };
      const required = INVOCATION_ALLOCATION;
      for (const policy of ["fail", "wait"] as const) {
        const { node } = readySingle(h, s, small, policy);
        const admission = h.capacity.admits(node, required);
        expect(admission).toEqual({ required, available: small, shortfall: { costUsd: 1, tokens: 19_000, attempts: 1 }, fits: false, extension: null, ineligible: null });
        const before = capacityWork(h, runId);
        expect(() => h.capacity.ensure(node, required, "invocation", {})).toThrow(/inside the root transaction/);
        expect(h.ctx.tx.write(() => h.capacity.ensure(node, required, "invocation", {}))).toEqual({ kind: "refused", policy });
        expect(capacityWork(h, runId)).toEqual(before);
      }
      const { node } = readySingle(h, s, small, "extend");
      // Zero shortfall: funded, no extension.
      expect(h.ctx.tx.write(() => h.capacity.ensure(node, small, "invocation", {}))).toEqual({ kind: "funded", extension: null });
      expect(h.capacity.admits(node, small)).toMatchObject({ fits: true, ineligible: null });
      expect(h.stores.allocationExtensions.listByRun(runId)).toEqual([]);
      // A positive shortfall the Run covers: exactly that extension, no remainder, and the node's effective allocation grew by it alone.
      const admission = h.capacity.admits(node, required);
      expect(admission).toMatchObject({ fits: true, shortfall: { costUsd: 1, tokens: 19_000, attempts: 1 }, extension: { costUsd: 1, tokens: 19_000, attempts: 1 } });
      const runBefore = h.stores.reservations.runCapacity(runId);
      const funded = h.ctx.tx.write(() => h.capacity.ensure(node, required, "gate_evaluator", {}));
      expect(funded).toMatchObject({ kind: "funded", extension: { planNodeId: node.id, trigger: "gate_evaluator", added: { costUsd: 1, tokens: 19_000, attempts: 1 } } });
      expect(h.stores.reservations.planNodeAllocation(node.id).effective).toEqual(required);
      expect(h.capacity.admits(node, required)).toMatchObject({ fits: true, shortfall: ZERO, extension: null });
      const runAfter = h.stores.reservations.runCapacity(runId);
      expect(runAfter.ordinary.available).toEqual({ costUsd: runBefore.ordinary.available.costUsd - 1, tokens: runBefore.ordinary.available.tokens - 19_000, attempts: runBefore.ordinary.available.attempts - 1 });
      expect(runAfter.final).toEqual(runBefore.final);
      expect(runAfter.increases).toEqual(runBefore.increases);
      // Every runtime call site is a closed trigger; an open-ended one is refused at the store.
      expect(() => h.ctx.tx.write(() => h.stores.allocationExtensions.record({ runId, planNodeId: node.id, added: { costUsd: 1, tokens: 0, attempts: 0 }, trigger: "because" as never }))).toThrow();
    } finally {
      h.close();
    }
  });

  it("refuses a node that may not fund a child — pending, terminal, cancelled, skipped, a join, or foreign — with a typed ineligibility before any arithmetic, under every policy, whatever capacity it holds", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h, { budget: { ...DEFAULT_BUDGET, maxAttempts: 200, maxCostUsd: 500, maxTokens: 5_000_000 } });
      const runId = s.created.run.id;
      // Every node holds exactly the child's allocation: its arithmetic admits the child in every state below; only its lifecycle refuses.
      const required = INVOCATION_ALLOCATION;
      const single = (title: string, policy?: "fail" | "wait" | "extend"): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title }, allocation: required, ...(policy ? { onAllocationExhausted: policy } : {}) }) as PlanExpression;
      const policies = ["fail", "wait", "extend"] as const;
      const states = ["pending", "skipped", "cancelled", "succeeded", "failed"] as const;
      const expressions: PlanExpression[] = [
        ...policies.flatMap((policy) => states.map((state) => single(`${policy} ${state}`, policy))),
        single("ready"),
        single("running"),
        single("waiting"),
        single("own"),
        { pattern: "parallel", items: [{ pattern: "chain", steps: [single("a"), single("b")], allocation: required }], allocation: required } as PlanExpression,
      ];
      const { nodes } = planNodes(h, s, expressions);
      const byTitle = new Map(nodes.map((n) => [n.title, n] as const));
      const ready = (id: string) => h.stores.plans.transitionNode(id as never, { to: "ready" });
      const running = (id: string) => {
        ready(id);
        h.stores.plans.transitionNode(id as never, { to: "running" });
      };
      const drive: Record<(typeof states)[number], (id: string) => void> = {
        pending: () => {},
        skipped: (id) => h.stores.plans.transitionNode(id as never, { to: "skipped" }),
        cancelled: (id) => h.stores.plans.transitionNode(id as never, { to: "cancelled", reason: "operator" }),
        succeeded: (id) => {
          running(id);
          h.stores.plans.transitionNode(id as never, { to: "succeeded", outputArtifactIds: [] });
        },
        failed: (id) => {
          running(id);
          h.stores.plans.transitionNode(id as never, { to: "failed", reason: "invocation_failed", artifactIds: [] });
        },
      };
      for (const policy of policies) {
        for (const state of states) {
          const id = byTitle.get(`${policy} ${state}`)!.id;
          drive[state](id);
          const node = h.stores.plans.getNode(id) as PlanNode & { kind: "pattern" };
          const expected = { kind: "node_not_active", status: state };
          const before = capacityWork(h, runId);
          expect(h.capacity.admits(node, required), `${policy} ${state}`).toEqual({ required, available: ZERO, shortfall: required, fits: false, extension: null, ineligible: expected });
          expect(h.ctx.tx.write(() => h.capacity.ensure(node, required, "invocation", {})), `${policy} ${state}`).toEqual({ kind: "ineligible", reason: expected });
          expect(h.capacity.eligibility(node)).toEqual(expected);
          expect(capacityWork(h, runId)).toEqual(before);
        }
      }
      // The admissible states: ready, running, and waiting all consult the arithmetic and fit.
      ready(byTitle.get("ready")!.id);
      running(byTitle.get("running")!.id);
      running(byTitle.get("waiting")!.id);
      h.stores.plans.transitionNode(byTitle.get("waiting")!.id, { to: "waiting", waitReason: "budget" });
      for (const title of ["ready", "running", "waiting"]) {
        const node = h.stores.plans.getNode(byTitle.get(title)!.id) as PlanNode & { kind: "pattern" };
        expect(h.capacity.admits(node, required), title).toMatchObject({ fits: true, ineligible: null, available: required, shortfall: ZERO });
        expect(h.capacity.eligibility(node)).toBeNull();
      }
      // A foreign node object (another Run's id) and a join node are refused by identity, never funded.
      running(byTitle.get("own")!.id);
      const own = h.stores.plans.getNode(byTitle.get("own")!.id) as PlanNode & { kind: "pattern" };
      const foreign = { ...own, runId: "run_000000000000000000000000" as never };
      expect(h.capacity.admits(foreign, required)).toMatchObject({ fits: false, ineligible: { kind: "foreign_run", runId } });
      expect(h.ctx.tx.write(() => h.capacity.ensure(foreign, required, "invocation", {}))).toEqual({ kind: "ineligible", reason: { kind: "foreign_run", runId } });
      const join = nodes.find((n) => n.kind === "join")!;
      expect(h.capacity.admits({ ...own, id: join.id }, required)).toMatchObject({ fits: false, ineligible: { kind: "join_node" } });
      expect(h.ctx.tx.write(() => h.capacity.ensure({ ...own, id: join.id }, required, "invocation", {}))).toEqual({ kind: "ineligible", reason: { kind: "join_node" } });
    } finally {
      h.close();
    }
  });

  it("waits without partial state when the Run's effective ordinary capacity cannot cover the shortfall — even with an idle final reserve — and funds the same work once an ordinary Budget Increase covers it", () => {
    // Ordinary Attempts exactly reserved: reserve 3 + root 5 + node 1 = 9; the final reserve holds 3 idle Attempts that are never ordinary capacity.
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h, { budget: { ...DEFAULT_BUDGET, maxAttempts: 9 } });
      const runId = s.created.run.id;
      const { node, revisionNumber } = readySingle(h, s, { costUsd: 1, tokens: 1_000, attempts: 1 }, "extend");
      expect(h.stores.reservations.runCapacity(runId).ordinary.effectiveAvailable.attempts).toBe(0);
      expect(h.stores.reservations.runCapacity(runId).final.effectiveAvailable.attempts).toBe(3);
      expect(h.capacity.admits(node, INVOCATION_ALLOCATION)).toMatchObject({ fits: false, shortfall: { costUsd: 1, tokens: 19_000, attempts: 1 }, extension: null });
      const before = capacityWork(h, runId);
      expect(h.ctx.tx.write(() => h.capacity.ensure(node, INVOCATION_ALLOCATION, "invocation", {}))).toEqual({ kind: "refused", policy: "wait" });
      expect(capacityWork(h, runId)).toEqual(before);
      // Through the runner: the node waits on budget, nothing else exists.
      expect(h.runners.single.start(node.id, revisionNumber)).toEqual({ kind: "waiting", reason: "budget", wakeAt: null });
      expect(h.stores.invocations.listByPlanNode(node.id)).toEqual([]);
      expect(h.stores.allocationExtensions.listByRun(runId)).toEqual([]);
      expect(h.runners.single.inspect(node.id)).toEqual({ kind: "waiting", reason: "budget", cleared: false, wakeAt: null });
      // A final-reserve increase changes nothing for ordinary work; an ordinary increase of exactly one Attempt clears the wait.
      seedBudgetIncrease(h, asSeeded(s), "final_reserve", { costUsd: 0, tokens: 0, attempts: 1 });
      expect(h.runners.single.inspect(node.id)).toEqual({ kind: "waiting", reason: "budget", cleared: false, wakeAt: null });
      seedBudgetIncrease(h, asSeeded(s), "ordinary", { costUsd: 0, tokens: 0, attempts: 1 });
      expect(h.runners.single.inspect(node.id)).toEqual({ kind: "waiting", reason: "budget", cleared: true, wakeAt: null });
      expect(h.runners.single.resume(node.id, revisionNumber)).toEqual({ kind: "resumed", reason: "budget" });
      expect(h.runners.single.start(node.id, revisionNumber)).toMatchObject({ kind: "started" });
      expect(h.stores.allocationExtensions.listByRun(runId)).toMatchObject([{ planNodeId: node.id, trigger: "invocation", added: { costUsd: 1, tokens: 19_000, attempts: 1 } }]);
      expect(h.stores.reservations.runCapacity(runId).final.effectiveAvailable.attempts).toBe(4);
      expect(h.stores.reservations.runCapacity(runId).ordinary.effectiveAvailable.attempts).toBe(0);
    } finally {
      h.close();
    }
  });

  it("funds a Coordinator Task batch with one exact aggregate extension atomically with every Task and reservation, transfers Task reservations without extending, and refuses a batch the Run cannot cover whole", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      // The node holds exactly its decompose turn: three Workers need 6 USD / 60 000 tokens / 6 Attempts more.
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const expressionPolicy = (allocation: Allocation): Partial<PlanExpression> => ({ allocation, onAllocationExhausted: "extend" }) as never;
      const scoped = await decomposeWithPolicy(h, s, expressionPolicy(INVOCATION_ALLOCATION));
      const node = h.stores.plans.getNode(scoped.node.id) as PlanNode & { kind: "pattern" };
      expect(h.stores.reservations.capacity({ type: "plan_node", id: node.id }).available).toEqual(ZERO);
      const before = capacityWork(h, runId);
      const batch = propose(scoped.leafIds.slice(0, 1).flatMap((leaf) => ["a", "b", "c"].map((key) => proposal({ key, requirementIds: [leaf] }))));
      const accepted = await scoped.port.call(batch);
      expect(accepted.kind).toBe("accepted");
      const extensions = h.stores.allocationExtensions.listByPlanNode(node.id);
      expect(extensions).toHaveLength(1);
      expect(extensions[0]).toMatchObject({ trigger: "task_batch", added: { costUsd: 6, tokens: 60_000, attempts: 6 } });
      expect(tasksOf(h, scoped.node)).toHaveLength(3);
      expect(tasksOf(h, scoped.node).every((t) => h.stores.reservations.activeForChild({ type: "task", id: t.id }) !== null)).toBe(true);
      expect(h.stores.reservations.capacity({ type: "plan_node", id: node.id }).available).toEqual(ZERO);
      const events = h.ctx.journal.read({ runId }).slice(before.events).map((e) => e.type);
      expect(events.indexOf("allocation_extension.created")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("allocation_extension.created")).toBeLessThan(events.indexOf("task.created"));
      expect(events.filter((t) => t === "allocation_extension.created")).toHaveLength(1);
      // A replay of the same call creates nothing more; a second batch in the turn is refused before any capacity operation.
      expect((await scoped.port.call(batch)).kind).toBe("accepted");
      expect(h.stores.allocationExtensions.listByPlanNode(node.id)).toHaveLength(1);
      expect((await scoped.port.call(propose([proposal({ key: "d", requirementIds: [scoped.leafIds[0]!] })]))).kind).toBe("rejected");
      expect(h.stores.allocationExtensions.listByPlanNode(node.id)).toHaveLength(1);
      // The decompose turn completes; each Worker is funded by transferring its Task reservation — no extension, the node's capacity unchanged.
      h.provider.script({ kind: "succeed", result: { status: "completed", artifactIds: [], tasks: [], evidence: [], summary: "proposed", openItems: [], blocker: null, runOutcome: null, routeSelection: null, evaluation: null, finalReport: null } });
      await h.executor.executePreparedAttempt(scoped.attempt.id);
      scriptByRole(h, { worker: [coordinatorWorkerStep(h), coordinatorWorkerStep(h), coordinatorWorkerStep(h)] });
      for (let i = 0; i < 12 && workersOf(h, scoped.node).length < 3; i += 1) await h.scheduler.advanceRun(runId, { maxActions: 2 });
      expect(workersOf(h, scoped.node).length).toBeGreaterThanOrEqual(1);
      expect(h.stores.allocationExtensions.listByPlanNode(node.id)).toHaveLength(1);
      for (const worker of workersOf(h, scoped.node)) {
        const reservation = h.stores.reservations.activeForChild({ type: "invocation", id: worker.id }) ?? h.stores.reservations.listByChild({ type: "invocation", id: worker.id })[0]!;
        expect(reservation.transferredFromReservationId).not.toBeNull();
        expect(worker.allocation).toEqual(INVOCATION_ALLOCATION);
      }
      // A batch the Run cannot cover whole: refused typed, with no Task, reservation, extension, or Event.
      const starved = openRuntimeHarness({ governor: WIDE_GOVERNOR });
      try {
        const t = seedPlanningRuntime(starved, { budget: { ...DEFAULT_BUDGET, maxAttempts: 12 } });
        // reserve 3 + root 5 + node 2 = 10: two Attempts of ordinary capacity remain, a two-Task batch needs four more.
        const scopedStarved = await decomposeWithPolicy(starved, t, expressionPolicy(INVOCATION_ALLOCATION));
        const beforeStarved = capacityWork(starved, t.created.run.id);
        const refused = await scopedStarved.port.call(propose(["a", "b"].map((key) => proposal({ key, requirementIds: [scopedStarved.leafIds[0]!] }))));
        expect(refused).toMatchObject({ kind: "rejected", reasons: [{ code: "allocation_insufficient" }] });
        expect(capacityWork(starved, t.created.run.id)).toEqual(beforeStarved);
        // One Task fits through an exact extension of two Attempts' worth — never more than the shortfall.
        const one = await scopedStarved.port.call(propose([proposal({ key: "a", requirementIds: [scopedStarved.leafIds[0]!] })]));
        expect(one.kind).toBe("accepted");
        expect(starved.stores.allocationExtensions.listByPlanNode(scopedStarved.node.id)).toMatchObject([{ trigger: "task_batch", added: INVOCATION_ALLOCATION }]);
        expect(starved.stores.reservations.runCapacity(t.created.run.id).ordinary.effectiveAvailable.attempts).toBe(0);
      } finally {
        starved.close();
      }
    } finally {
      h.close();
    }
  });

  it("funds a node_exit Gate Evaluator through the same operation, leaves the Worker's Invocation and reservation untouched, and never extends under wait", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      for (const policy of ["extend", "wait"] as const) {
        const s = seedPlanningRuntime(h);
        const runId = s.created.run.id;
        const criteria = seedCriteria(h, s, { evaluated: 1 });
        // The node holds exactly its Worker; the Gate Evaluator needs the same again.
        const { nodes } = planNodes(h, s, [{ ...singleExpression(s, "A", { gate: criteria.all, allocation: INVOCATION_ALLOCATION }), onAllocationExhausted: policy } as PlanExpression]);
        const node = nodes[0]!;
        await finishRoot(h, s);
        scriptByRole(h, { worker: [workerStep(h, "a")], evaluator: [gateEvaluatorStep(h, "pass")] });
        const outcome = await h.scheduler.advanceRun(runId);
        const worker = h.stores.invocations.listByPlanNode(node.id).find((i) => i.role === "worker")!;
        const workerReservation = h.stores.reservations.listByChild({ type: "invocation", id: worker.id })[0]!;
        if (policy === "extend") {
          expect(h.stores.plans.getNode(node.id).status).toBe("succeeded");
          const gate = gatesOf(h, node.id)[0]!;
          expect(evaluatorsOf(h, gate.id)).toHaveLength(1);
          const extensions = h.stores.allocationExtensions.listByPlanNode(node.id);
          expect(extensions).toHaveLength(1);
          expect(extensions[0]!.trigger).toBe("gate_evaluator");
          // Exactly the shortfall the Evaluator needed after the Worker's consumption — no more.
          const consumed = h.stores.usage.totalsForInvocation(worker.id);
          expect(extensions[0]!.added.attempts).toBe(Math.max(0, INVOCATION_ALLOCATION.attempts - (INVOCATION_ALLOCATION.attempts - h.stores.invocations.listAttempts(worker.id).length)));
          expect(extensions[0]!.added.costUsd).toBeCloseTo(Math.max(0, INVOCATION_ALLOCATION.costUsd - (INVOCATION_ALLOCATION.costUsd - consumed.costUsd)), 9);
          // The existing Worker Invocation and its reservation are unchanged.
          expect(h.stores.invocations.get(worker.id).allocation).toEqual(INVOCATION_ALLOCATION);
          expect(h.stores.reservations.get(workerReservation.id).reserved).toEqual(INVOCATION_ALLOCATION);
          expect(h.stores.reservations.listByChild({ type: "invocation", id: worker.id })).toHaveLength(1);
        } else {
          expect(outcome.stop).toBe("waiting");
          expect(h.stores.plans.getNode(node.id)).toMatchObject({ status: "waiting", waitReason: "budget" });
          expect(h.stores.runs.get(runId)).toMatchObject({ status: "waiting", waitReason: "budget" });
          expect(evaluatorsOf(h, gatesOf(h, node.id)[0]!.id)).toEqual([]);
          expect(h.stores.allocationExtensions.listByRun(runId)).toEqual([]);
        }
      }
    } finally {
      h.close();
    }
  });
});

/** A running `decompose` port on a coordinator node compiled with the given expression options (allocation and policy). */
async function decomposeWithPolicy(h: RuntimeHarness, s: PlanningSeed, options: Partial<PlanExpression>) {
  const rootId = h.ctx.ids("requirement");
  const leafIds = [h.ctx.ids("requirement"), h.ctx.ids("requirement")];
  const revision = h.stores.requirements.createRevision({
    conversationId: s.created.run.conversationId,
    approvedByDecisionId: null,
    tree: [
      { id: rootId, parentId: null, composition: "all", statement: "The CLI reports its version", position: 0, acceptanceCriterionIds: [] },
      ...leafIds.map((id, index) => ({ id, parentId: rootId, composition: null, statement: `Leaf ${index + 1}`, position: index, acceptanceCriterionIds: [] })),
    ],
  });
  const expression = {
    pattern: "coordinator_worker",
    coordinator: { agentDefinitionRevisionId: s.worker.id, title: "coordinator" },
    worker: { agentDefinitionRevisionId: s.worker.id, title: "worker" },
    bounds: { maxTasks: 6, maxConcurrentWorkers: 3, maxCoordinatorInvocations: 4 },
    scope: { requirementRootIds: [rootId], requirementRevisionId: revision.id },
    allocation: COORDINATOR_NODE_ALLOCATION,
    ...options,
  } as PlanExpression;
  const { nodes, revisionNumber } = planNodes(h, s, [expression]);
  await finishRoot(h, s);
  h.stores.plans.transitionNode(nodes[0]!.id, { to: "ready" });
  const started = h.runners.coordinatorWorker.start(nodes[0]!.id, revisionNumber);
  if (started.kind !== "started") throw new Error(`decompose did not start: ${started.kind}`);
  const prepared = await h.executor.prepareNextAttempt(started.invocationId);
  if (prepared.kind !== "prepared") throw new Error(`Attempt not prepared: ${prepared.kind}`);
  return { node: nodes[0]!, revisionNumber, leafIds, invocation: prepared.invocation, attempt: prepared.attempt, port: portFor(h, prepared.invocation, prepared.attempt) };
}
