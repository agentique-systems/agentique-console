/**
 * Restart and concurrency of Allocation Extensions and Budget Increases
 * (execution-model §7.6, §14; invariant 22): every crash window converges
 * from canonical rows alone, over a file-backed database opened by
 * successive processes — and by two connections at once — without a
 * duplicate Budget Increase, Allocation Extension, Task, Invocation,
 * reservation, Event, scheduler action, or Usage row.
 *
 * Windows: (1) crash before an Allocation Extension; (2) crash after the
 * extension, before the child; (3) child creation failure; (4) Event
 * failure; (5) COMMIT failure; (6) two processes funding the same
 * position; (7) two Task batches racing; (8) two Budget Increase requests
 * racing; (9) duplicate approval replay; (10) conflicting approval replay;
 * (11) an approved increase visible after reopen; (12) a waiting Run
 * resuming after reopen; (13) a signoff change request retried after
 * reopen; (14) a final-reserve increase followed by the completion
 * preflight; (15) a released reservation refusing a late extension; (16) a
 * terminal node refusing an extension; (17) overrun plus extension
 * accounting; (18) negative available capacity followed by a sufficient
 * Budget Increase.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DecisionId, PlanExpression, PlanNodeId, RunId } from "@agentique-console/core";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDGET, openHarness } from "../persistence/test-support.ts";
import { DEFAULT_USAGE } from "../provider/fake.ts";
import { CompletionFacts } from "./completion-requests.ts";
import { finishRoot, portFor, proposal, propose, tasksOf, WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { awaitSignoff, followUpsOf, operatorMessage } from "./signoff-test-support.ts";
import { competitor, newWorld as worldAt, withProcess as withProcessOver, type World } from "./recovery-test-support.ts";
import { COMPLETED_RESULT, INVOCATION_ALLOCATION, openRuntimeHarness, planNodes, seedPlanningRuntime, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

/** A World in a fresh temporary directory. */
function newWorld(prefix: string): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return worldAt(dir, path.join(dir, "console.db"));
}

/** A process over the World whose injected failures (vitest spies) are restored when it ends. */
const withProcess = <T>(w: World, body: (h: RuntimeHarness) => Promise<T> | T, options: { recover?: boolean } = {}) => withProcessOver(w, body, { ...options, after: () => vi.restoreAllMocks() });

/** Everything a repeated capacity operation could duplicate, from rows alone. */
function work(h: RuntimeHarness, runId: RunId) {
  const nodes = h.stores.plans.listNodes(runId);
  return {
    increases: h.stores.budgetIncreases.listByRun(runId).map((i) => i.id),
    decisions: h.stores.decisions.budgetIncreaseDecisionsOf(runId).map((d) => [d.id, d.status, d.resolution?.chosenOptionId ?? null]),
    extensions: h.stores.allocationExtensions.listByRun(runId).map((e) => [e.id, e.planNodeId, e.trigger, e.added]),
    invocations: h.stores.invocations.listByRun(runId).map((i) => [i.id, i.purpose, i.status]),
    tasks: h.stores.tasks.listByRun(runId).map((t) => [t.id, t.status]),
    reservations: [...h.stores.reservations.listByParent({ type: "run", id: runId }), ...nodes.flatMap((n) => h.stores.reservations.listByParent({ type: "plan_node", id: n.id }))].map((r) => [r.id, r.status]),
    usage: h.stores.usage.totalsForRun(runId).rows,
    nodes: nodes.map((n) => [n.id, n.status, n.waitReason]),
    run: [h.stores.runs.get(runId).status, h.stores.runs.get(runId).waitReason],
    events: h.ctx.journal.read({ runId }).map((e) => e.type),
    capacity: h.stores.reservations.runCapacity(runId),
  };
}

const SMALL = { costUsd: 1, tokens: 1_000, attempts: 1 };
const SHORTFALL = { costUsd: 1, tokens: 19_000, attempts: 1 };

/** A single worker expression with `allocation` and the `extend` policy. */
function extendable(s: ReturnType<typeof seedPlanningRuntime>, title: string, allocation = SMALL): PlanExpression {
  return { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title }, allocation, onAllocationExhausted: "extend" } as PlanExpression;
}

/** A single worker node with `allocation` and the `extend` policy, compiled into the seeded Run. */
function extendableNode(h: RuntimeHarness, s: ReturnType<typeof seedPlanningRuntime>, allocation = SMALL, title = "work") {
  const { nodes, revisionNumber } = planNodes(h, s, [extendable(s, title, allocation)]);
  return { nodeId: nodes[0]!.id, revisionNumber };
}

/** A world whose first process seeded a Run with one ready extendable node whose first Invocation needs an extension. */
async function extendableWorld(prefix: string, budget = DEFAULT_BUDGET): Promise<World> {
  const w = newWorld(prefix);
  await withProcess(w, async (h) => {
    w.clock = h.clock;
    w.blobs = h.blobs;
    const s = seedPlanningRuntime(h, { budget });
    w.runId = s.created.run.id;
    const { nodeId, revisionNumber } = extendableNode(h, s);
    w.nodeId = nodeId;
    w.revisionNumber = revisionNumber;
    await finishRoot(h, s);
    h.stores.plans.transitionNode(nodeId, { to: "ready" });
  }, { recover: false });
  return w;
}

describe("allocation extension recovery", () => {
  it("converges across the five crash windows of an extended Invocation: nothing half-written, then exactly one extension and one Invocation, never repeated (windows 1–5)", async () => {
    const w = await extendableWorld("agentique-alloc-crash-");
    try {
      const before = await withProcess(w, (h) => work(h, w.runId));
      const injections: [string, (h: RuntimeHarness) => { extended: () => boolean }][] = [
        // Window 1: the process dies before the extension is written.
        ["before the extension", (h) => {
          vi.spyOn(h.stores.allocationExtensions, "record").mockImplementationOnce(() => { throw new Error("injected: died before the extension"); });
          return { extended: () => false };
        }],
        // Window 2: the extension is written, the Invocation creation fails: one transaction, so the extension rolls back with it.
        ["after the extension, before the child", (h) => {
          const record = vi.spyOn(h.stores.allocationExtensions, "record");
          vi.spyOn(h.stores.invocations, "create").mockImplementationOnce(() => { throw new Error("injected: died before the child"); });
          return { extended: () => record.mock.calls.length === 1 };
        }],
        // Window 3: the child's manifest creation fails.
        ["at manifest creation", (h) => {
          const record = vi.spyOn(h.stores.allocationExtensions, "record");
          vi.spyOn(h.stores.invocations, "putManifest").mockImplementationOnce(() => { throw new Error("injected: manifest"); });
          return { extended: () => record.mock.calls.length === 1 };
        }],
        // Window 4: an Event append fails after the extension.
        ["at an Event append", (h) => {
          const record = vi.spyOn(h.stores.allocationExtensions, "record");
          const append = h.ctx.journal.append.bind(h.ctx.journal);
          vi.spyOn(h.ctx.journal, "append").mockImplementation((input) => {
            if (input.type === "invocation.created") throw new Error("injected: event");
            return append(input);
          });
          return { extended: () => record.mock.calls.length === 1 };
        }],
        // Window 5: every callback mutation succeeded, COMMIT fails.
        ["at COMMIT", (h) => {
          const record = vi.spyOn(h.stores.allocationExtensions, "record");
          const exec = h.ctx.sqlite.exec.bind(h.ctx.sqlite);
          const spy = vi.spyOn(h.ctx.sqlite, "exec").mockImplementation((sql: string) => {
            if (sql === "COMMIT") {
              spy.mockRestore();
              throw new Error("injected: COMMIT failed");
            }
            return exec(sql);
          });
          return { extended: () => record.mock.calls.length === 1 };
        }],
      ];
      for (const [label, inject] of injections) {
        await withProcess(w, (h) => {
          const probe = inject(h);
          expect(() => h.runners.single.start(w.nodeId, w.revisionNumber), label).toThrow(/injected/);
          if (label !== "before the extension") expect(probe.extended(), label).toBe(true);
        });
        // The next process finds nothing: no extension, no Invocation, no reservation, no Event, the node still ready.
        await withProcess(w, (h) => expect(work(h, w.runId), label).toEqual(before));
      }
      // Then the one successful start, and restarts that repeat nothing.
      const after = await withProcess(w, (h) => {
        expect(h.runners.single.start(w.nodeId, w.revisionNumber)).toMatchObject({ kind: "started" });
        const done = work(h, w.runId);
        expect(done.extensions).toMatchObject([[expect.any(String), w.nodeId, "invocation", SHORTFALL]]);
        expect(done.invocations.filter(([, purpose]) => purpose === "step")).toHaveLength(1);
        expect(done.events.filter((t) => t === "allocation_extension.created")).toHaveLength(1);
        return done;
      });
      await withProcess(w, (h) => {
        expect(h.runners.single.start(w.nodeId, w.revisionNumber)).toEqual({ kind: "no_change" });
        expect(h.runners.single.inspect(w.nodeId)).toMatchObject({ kind: "execute" });
        expect(work(h, w.runId)).toEqual(after);
        expect(h.scheduler.reconcileRun(w.runId).actions.filter((a) => a.kind === "start_node")).toEqual([]);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("lets two processes fund the same position with one committed extension and one Invocation (window 6)", async () => {
    const w = await extendableWorld("agentique-alloc-race-");
    const a = openRuntimeHarness({ base: openHarness(w.file, { clock: w.clock, blobs: w.blobs }), governor: WIDE_GOVERNOR, integrationWorkspace: w.integration, criterionExecution: w.checks, finalizationWorkspace: w.finalization });
    let b: RuntimeHarness | null = null;
    try {
      b = competitor(w);
      const rival = b;
      const outcome = a.ctx.tx.write(() => {
        const started = a.runners.single.start(w.nodeId, w.revisionNumber);
        // While the funding transaction holds the write lock the competitor cannot even begin; nothing of its attempt persists.
        expect(() => rival.runners.single.start(w.nodeId, w.revisionNumber)).toThrow(/SQLITE_BUSY|database is locked/);
        return started;
      });
      expect(outcome).toMatchObject({ kind: "started" });
      expect(rival.runners.single.start(w.nodeId, w.revisionNumber)).toEqual({ kind: "no_change" });
      expect(rival.stores.allocationExtensions.listByRun(w.runId)).toHaveLength(1);
      expect(rival.stores.invocations.listByPlanNode(w.nodeId)).toHaveLength(1);
      expect(rival.stores.reservations.listByParent({ type: "plan_node", id: w.nodeId })).toHaveLength(1);
      expect(rival.ctx.journal.read({ runId: w.runId, type: "allocation_extension.created" })).toHaveLength(1);
      expect(work(a, w.runId)).toEqual(work(rival, w.runId));
    } finally {
      b?.close();
      a.close();
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("lets two Task batches race: one committed batch with its one aggregate extension, the identical retry replayed, a different one refused (window 7)", async () => {
    const w = newWorld("agentique-alloc-batch-");
    const a = openRuntimeHarness({ base: openHarness(w.file), governor: WIDE_GOVERNOR });
    let b: RuntimeHarness | null = null;
    try {
      w.clock = a.clock;
      w.blobs = a.blobs;
      const s = seedPlanningRuntime(a);
      w.runId = s.created.run.id;
      const rootId = a.ctx.ids("requirement");
      const leafId = a.ctx.ids("requirement");
      const revision = a.stores.requirements.createRevision({ conversationId: s.created.run.conversationId, approvedByDecisionId: null, tree: [{ id: rootId, parentId: null, composition: "all", statement: "root", position: 0, acceptanceCriterionIds: [] }, { id: leafId, parentId: rootId, composition: null, statement: "leaf", position: 0, acceptanceCriterionIds: [] }] });
      const expression = { pattern: "coordinator_worker", coordinator: { agentDefinitionRevisionId: s.worker.id, title: "coordinator" }, worker: { agentDefinitionRevisionId: s.worker.id, title: "worker" }, bounds: { maxTasks: 6, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 }, scope: { requirementRootIds: [rootId], requirementRevisionId: revision.id }, allocation: INVOCATION_ALLOCATION, onAllocationExhausted: "extend" } as PlanExpression;
      const { nodes, revisionNumber } = planNodes(a, s, [expression]);
      const node = nodes[0]!;
      await finishRoot(a, s);
      a.stores.plans.transitionNode(node.id, { to: "ready" });
      const started = a.runners.coordinatorWorker.start(node.id, revisionNumber);
      if (started.kind !== "started") throw new Error(started.kind);
      const prepared = await a.executor.prepareNextAttempt(started.invocationId);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      b = competitor(w);
      const rival = b;
      const rivalPort = portFor(rival, rival.stores.invocations.get(prepared.invocation.id), rival.stores.invocations.getAttempt(prepared.attempt.id));
      const batch = propose(["a", "b", "c"].map((key) => proposal({ key, requirementIds: [leafId] })));
      // While the accepting transaction holds the lock (after the extension, during Task creation) the competitor's identical call fails typed.
      let racing: Promise<unknown> | null = null;
      const create = a.stores.tasks.create.bind(a.stores.tasks);
      vi.spyOn(a.stores.tasks, "create").mockImplementationOnce((input, options) => {
        racing = rivalPort.call(batch);
        return create(input, options);
      });
      const accepted = await portFor(a, prepared.invocation, prepared.attempt).call(batch);
      expect(accepted.kind).toBe("accepted");
      expect(await racing!).toMatchObject({ kind: "failed", message: expect.stringMatching(/SQLITE_BUSY|database is locked/) });
      vi.restoreAllMocks();
      // The node held exactly its decompose turn, so the batch needed the whole Worker sum — one aggregate extension.
      expect(a.stores.allocationExtensions.listByPlanNode(node.id)).toMatchObject([{ trigger: "task_batch", added: { costUsd: 6, tokens: 60_000, attempts: 6 } }]);
      expect(tasksOf(a, node)).toHaveLength(3);
      // The competitor's identical call replays by digest; a different batch is refused; nothing more is written.
      const replayed = await rivalPort.call(batch);
      expect(replayed).toMatchObject({ kind: "accepted", replayed: true });
      expect((await rivalPort.call(propose([proposal({ key: "d", requirementIds: [leafId] })]))).kind).toBe("rejected");
      expect(rival.stores.allocationExtensions.listByPlanNode(node.id)).toHaveLength(1);
      expect(tasksOf(rival, node)).toHaveLength(3);
      expect(rival.stores.runtimeToolCalls.listByInvocation(prepared.invocation.id)).toHaveLength(1);
      expect(rival.ctx.journal.read({ runId: w.runId, type: "task.created" })).toHaveLength(3);
      expect(rival.ctx.journal.read({ runId: w.runId, type: "allocation_extension.created" })).toHaveLength(1);
    } finally {
      b?.close();
      a.close();
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });
});

describe("budget increase recovery", () => {
  it("serializes racing requests, replays duplicate approvals, refuses conflicting ones, and shows the approved increase after reopen (windows 8–11)", async () => {
    const w = await extendableWorld("agentique-increase-race-");
    const a = openRuntimeHarness({ base: openHarness(w.file, { clock: w.clock, blobs: w.blobs }), governor: WIDE_GOVERNOR });
    let b: RuntimeHarness | null = null;
    let decisionId!: DecisionId;
    let capacity!: unknown;
    try {
      b = competitor(w);
      const rival = b;
      const added = { costUsd: 2, tokens: 0, attempts: 1 };
      // Window 8: while the request transaction holds the lock the competitor's request fails; afterwards its identical request replays.
      const request = a.stores.decisions.request.bind(a.stores.decisions);
      vi.spyOn(a.stores.decisions, "request").mockImplementationOnce((input, options) => {
        expect(() => rival.budgetIncreases.request({ runId: w.runId, partition: "ordinary", added })).toThrow(/SQLITE_BUSY|database is locked/);
        return request(input, options);
      });
      const { decision } = a.budgetIncreases.request({ runId: w.runId, partition: "ordinary", added });
      vi.restoreAllMocks();
      decisionId = decision.id;
      expect(rival.budgetIncreases.request({ runId: w.runId, partition: "ordinary", added })).toEqual({ decision, replayed: true });
      expect(() => rival.budgetIncreases.request({ runId: w.runId, partition: "ordinary", added: { ...added, tokens: 5 } })).toThrow(expect.objectContaining({ refusal: "budget_increase_decision_open" }));
      expect(rival.stores.decisions.budgetIncreaseDecisionsOf(w.runId)).toHaveLength(1);
      // Windows 9–10: the approval, its duplicate replay, and a conflicting denial.
      const approved = a.budgetIncreases.resolve({ runId: w.runId, decisionId, option: "approve" });
      expect(approved).toMatchObject({ kind: "approved", replayed: false });
      expect(rival.budgetIncreases.resolve({ runId: w.runId, decisionId, option: "approve" })).toEqual({ ...approved, replayed: true });
      expect(() => rival.budgetIncreases.resolve({ runId: w.runId, decisionId, option: "deny" })).toThrow(expect.objectContaining({ refusal: "conflicting_resolution" }));
      expect(rival.stores.budgetIncreases.listByRun(w.runId)).toHaveLength(1);
      expect(rival.ctx.journal.read({ runId: w.runId, type: "budget_increase.recorded" })).toHaveLength(1);
      expect(rival.ctx.journal.read({ runId: w.runId, type: "decision.resolved" })).toHaveLength(1);
      capacity = a.stores.reservations.runCapacity(w.runId);
      expect((capacity as { increases: { ordinary: unknown } }).increases.ordinary).toEqual(added);
    } finally {
      b?.close();
      a.close();
    }
    try {
      // Window 11: the approved increase and the effective limits read back identically in a new process; the base Budget is unchanged.
      await withProcess(w, (h) => {
        expect(h.stores.reservations.runCapacity(w.runId)).toEqual(capacity);
        expect(h.stores.runs.get(w.runId).budget).toEqual(DEFAULT_BUDGET);
        expect(h.budgetIncreases.inspect(w.runId).decisions.map((d) => [d.decisionId, d.chosenOptionId, d.budgetIncreaseId !== null])).toEqual([[decisionId, "approve", true]]);
        expect(h.budgetIncreases.resolve({ runId: w.runId, decisionId, option: "approve" })).toMatchObject({ kind: "approved", replayed: true });
        expect(h.stores.budgetIncreases.listByRun(w.runId)).toHaveLength(1);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("resumes a Run waiting on budget after an approved increase and a reopen: one resume, one extension, one Invocation (window 12)", async () => {
    // Ordinary Attempts exactly reserved (reserve 3 + root 5 + node 1 = 9): the extension cannot fit and the Run waits.
    const w = await extendableWorld("agentique-increase-resume-", { ...DEFAULT_BUDGET, maxAttempts: 9 });
    try {
      const waiting = await withProcess(w, async (h) => {
        const outcome = await h.scheduler.advanceRun(w.runId);
        expect(outcome.stop).toBe("waiting");
        expect(outcome.waiting).toEqual([{ nodeId: w.nodeId, reason: "budget", wakeAt: null }]);
        expect(h.stores.runs.get(w.runId)).toMatchObject({ status: "waiting", waitReason: "budget" });
        expect(h.stores.plans.getNode(w.nodeId)).toMatchObject({ status: "waiting", waitReason: "budget" });
        return work(h, w.runId);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w.runId)).toEqual(waiting);
        expect((await h.scheduler.advanceRun(w.runId)).actions).toEqual([]);
        const { decision } = h.budgetIncreases.request({ runId: w.runId, partition: "ordinary", added: { costUsd: 0, tokens: 0, attempts: 1 } });
        expect(h.budgetIncreases.resolve({ runId: w.runId, decisionId: decision.id, option: "approve" })).toMatchObject({ kind: "approved" });
        // The approval moves nothing by itself.
        expect(h.stores.runs.get(w.runId)).toMatchObject({ status: "waiting", waitReason: "budget" });
        expect(h.stores.allocationExtensions.listByRun(w.runId)).toEqual([]);
      });
      const resumed = await withProcess(w, async (h) => {
        expect(h.scheduler.reconcileRun(w.runId).actions.map((a) => a.kind)).toEqual(["resume_run", "resume_node"]);
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        const pass = await h.scheduler.advanceRun(w.runId);
        expect(pass.actions.map((a) => a.action.kind).slice(0, 3)).toEqual(["resume_run", "resume_node", "start_node"]);
        expect(h.ctx.journal.read({ runId: w.runId, type: "run.wait_cleared" })).toHaveLength(1);
        expect(h.stores.allocationExtensions.listByRun(w.runId)).toMatchObject([{ planNodeId: w.nodeId, trigger: "invocation", added: SHORTFALL }]);
        expect(h.stores.invocations.listByPlanNode(w.nodeId)).toHaveLength(1);
        expect(h.stores.plans.getNode(w.nodeId).status).toBe("succeeded");
        return work(h, w.runId);
      });
      await withProcess(w, async (h) => {
        expect(work(h, w.runId)).toEqual(resumed);
        expect((await h.scheduler.advanceRun(w.runId)).actions).toEqual([]);
        expect(work(h, w.runId)).toEqual(resumed);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("lets a refused signoff change request be retried after an approved increase and a reopen: one extension, one follow-up, identical replay (window 13)", async () => {
    const w = newWorld("agentique-increase-signoff-");
    let gateId!: string;
    let decisionId!: string;
    let messageId!: string;
    try {
      await withProcess(w, async (h) => {
        w.clock = h.clock;
        w.blobs = h.blobs;
        const starved = await awaitSignoff(h, { seed: { orchestratorAllocation: { costUsd: 10, tokens: 100_000, attempts: 2 }, budget: { ...DEFAULT_BUDGET, maxAttempts: 5 } } });
        w.runId = starved.runId;
        gateId = starved.gate.id;
        decisionId = starved.decisionId;
        messageId = operatorMessage(h, w.runId).id;
        expect(() => h.signoff.requestChanges({ runId: w.runId, gateId: gateId as never, decisionId: decisionId as never, operatorMessageId: messageId as never })).toThrow(expect.objectContaining({ refusal: "ordinary_capacity_insufficient" }));
      }, { recover: false });
      await withProcess(w, (h) => {
        expect(h.stores.runs.get(w.runId).status).toBe("awaiting_signoff");
        expect(followUpsOf(h, w.runId)).toEqual([]);
        const { decision } = h.budgetIncreases.request({ runId: w.runId, partition: "ordinary", added: { costUsd: 0, tokens: 0, attempts: 1 } });
        h.budgetIncreases.resolve({ runId: w.runId, decisionId: decision.id, option: "approve" });
        expect(h.stores.runs.get(w.runId).status).toBe("awaiting_signoff");
      });
      const done = await withProcess(w, (h) => {
        const retried = h.signoff.requestChanges({ runId: w.runId, gateId: gateId as never, decisionId: decisionId as never, operatorMessageId: messageId as never });
        expect(retried).toMatchObject({ kind: "changes_requested", replayed: false });
        expect(h.stores.allocationExtensions.listByRun(w.runId)).toMatchObject([{ trigger: "signoff_follow_up", added: { costUsd: 0, tokens: 0, attempts: 1 } }]);
        expect(followUpsOf(h, w.runId)).toHaveLength(1);
        expect(h.stores.runs.get(w.runId).status).toBe("running");
        return { work: work(h, w.runId), retried };
      });
      await withProcess(w, (h) => {
        expect(h.signoff.requestChanges({ runId: w.runId, gateId: gateId as never, decisionId: decisionId as never, operatorMessageId: messageId as never })).toEqual({ ...done.retried, replayed: true });
        expect(work(h, w.runId)).toEqual(done.work);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("admits a previously refused completion preflight after a final-reserve increase, without touching ordinary capacity (window 14)", async () => {
    const w = newWorld("agentique-increase-final-");
    let invocationId!: string;
    try {
      await withProcess(w, (h) => {
        w.clock = h.clock;
        w.blobs = h.blobs;
        const s = seedRuntime(h, { finalReserve: { costUsd: 0.5, tokens: 5_000, attempts: 1 } });
        w.runId = s.created.run.id;
        invocationId = startRun(h, s).prepared.invocation.id;
        const facts = new CompletionFacts(h.stores);
        expect(facts.preflight(h.stores.runs.get(w.runId), invocationId as never)).toContain("final_reserve_insufficient");
        const ordinary = h.stores.reservations.runCapacity(w.runId).ordinary;
        const { decision } = h.budgetIncreases.request({ runId: w.runId, partition: "final_reserve", added: { costUsd: 1.5, tokens: 15_000, attempts: 1 } });
        h.budgetIncreases.resolve({ runId: w.runId, decisionId: decision.id, option: "approve" });
        expect(h.stores.reservations.runCapacity(w.runId).ordinary).toEqual(ordinary);
      }, { recover: false });
      await withProcess(w, (h) => {
        const capacity = h.stores.reservations.runCapacity(w.runId);
        expect(capacity.finalReserve).toEqual({ costUsd: 2, tokens: 20_000, attempts: 2 });
        expect(capacity.increases.finalReserve).toEqual({ costUsd: 1.5, tokens: 15_000, attempts: 1 });
        expect(h.stores.runs.get(w.runId).finalReserve).toEqual({ costUsd: 0.5, tokens: 5_000, attempts: 1 });
        // The preflight now admits the final synthesis; no Completion Request was created by the increase.
        expect(new CompletionFacts(h.stores).preflight(h.stores.runs.get(w.runId), invocationId as never)).not.toContain("final_reserve_insufficient");
        expect(h.stores.completionRequests.listByRun(w.runId)).toEqual([]);
        expect(h.stores.allocationExtensions.listByRun(w.runId)).toEqual([]);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });
});

describe("allocation extension accounting across reopen", () => {
  it("refuses a late extension of a released reservation and of a terminal node after reopen, at the store and at the database (windows 15–16)", async () => {
    const w = newWorld("agentique-alloc-late-");
    let cancelledId!: PlanNodeId;
    let succeededId!: PlanNodeId;
    let releasedReservationId!: string;
    try {
      await withProcess(w, async (h) => {
        w.clock = h.clock;
        w.blobs = h.blobs;
        const s = seedPlanningRuntime(h);
        w.runId = s.created.run.id;
        const { nodes } = planNodes(h, s, [extendable(s, "a"), extendable(s, "b"), extendable(s, "c")]);
        cancelledId = nodes.find((n) => n.title === "a")!.id;
        releasedReservationId = h.stores.reservations.activeForChild({ type: "plan_node", id: cancelledId })!.id;
        h.stores.plans.transitionNode(cancelledId, { to: "cancelled", reason: "operator" });
        succeededId = nodes.find((n) => n.title === "c")!.id;
        h.stores.plans.transitionNode(succeededId, { to: "ready" });
        h.stores.plans.transitionNode(succeededId, { to: "running" });
        h.stores.plans.transitionNode(succeededId, { to: "succeeded", outputArtifactIds: [] });
      }, { recover: false });
      await withProcess(w, (h) => {
        expect(h.stores.reservations.get(releasedReservationId as never).status).toBe("released");
        const before = work(h, w.runId);
        expect(() => h.stores.allocationExtensions.record({ runId: w.runId, planNodeId: cancelledId, added: { costUsd: 1, tokens: 0, attempts: 0 }, trigger: "invocation" })).toThrow(/released reservation is never extended|no active reservation|terminal node.s allocation is never extended/);
        expect(() => h.stores.allocationExtensions.record({ runId: w.runId, planNodeId: succeededId, added: { costUsd: 1, tokens: 0, attempts: 0 }, trigger: "invocation" })).toThrow(/terminal node's allocation is never extended/);
        expect(() => h.database.sqlite.prepare("INSERT INTO allocation_extensions (id, run_id, plan_node_id, reservation_id, added_cost_usd, added_tokens, added_attempts, trigger, created_at) VALUES (?, ?, ?, ?, 1, 0, 0, 'invocation', ?)").run(`aext_${"1".repeat(24)}`, w.runId, cancelledId, releasedReservationId, "2026-01-01T00:00:00.000Z")).toThrow(/active ordinary run-to-plan-node reservation/);
        expect(h.stores.allocationExtensions.listByReservation(releasedReservationId as never)).toEqual([]);
        expect(work(h, w.runId)).toEqual(before);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("records an overrun above an extended allocation once, keeps the extension as provenance, shows negative availability, and funds the next node only once a sufficient increase is approved (windows 17–18)", async () => {
    // Cost: reserve 5 + root 10 + A 1 + B 1 = 17; one USD of ordinary capacity remains for A's extension, none for B's.
    const w = newWorld("agentique-alloc-overrun-");
    let a!: PlanNodeId;
    let b!: PlanNodeId;
    let revisionNumber!: number;
    try {
      const overrun = await withProcess(w, async (h) => {
        w.clock = h.clock;
        w.blobs = h.blobs;
        const s = seedPlanningRuntime(h, { budget: { ...DEFAULT_BUDGET, maxCostUsd: 18 } });
        w.runId = s.created.run.id;
        const { nodes, revisionNumber: revision } = planNodes(h, s, [extendable(s, "a"), extendable(s, "b")]);
        revisionNumber = revision;
        a = nodes.find((n) => n.title === "a")!.id;
        b = nodes.find((n) => n.title === "b")!.id;
        h.stores.plans.transitionNode(a, { to: "ready" });
        h.stores.plans.transitionNode(b, { to: "ready" });
        // A extends by exactly its shortfall (1 USD); B's shortfall then fits nothing: it waits on budget.
        const started = h.runners.single.start(a, revisionNumber);
        if (started.kind !== "started") throw new Error(started.kind);
        expect(h.stores.reservations.runCapacity(w.runId).ordinary.effectiveAvailable.costUsd).toBe(0);
        expect(h.runners.single.start(b, revisionNumber)).toEqual({ kind: "waiting", reason: "budget", wakeAt: null });
        // Window 17: A's Invocation overruns its 2 USD allocation five-fold; Usage is recorded once, the release records it unclamped.
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT, usage: [{ ...DEFAULT_USAGE, costUsd: 10 }] });
        expect(await h.executor.advanceInvocation(started.invocationId)).toMatchObject({ kind: "finalized", attempt: { status: "succeeded" } });
        expect(await h.runners.single.settle(a, revisionNumber)).toMatchObject({ kind: "succeeded" });
        const reservation = h.stores.reservations.listByChild({ type: "plan_node", id: a })[0]!;
        expect(reservation.status).toBe("released");
        expect(reservation.reserved).toEqual(SMALL);
        expect(reservation.consumed).toMatchObject({ costUsd: 10, attempts: 1 });
        const capacity = h.stores.reservations.runCapacity(w.runId);
        expect(capacity.ordinary.consumed.costUsd).toBe(10);
        // Root 10 (active, reserved) + B 1 (active) + A 10 (released) = 21 committed of 13 ordinary: −8 available, never clamped.
        expect(capacity.ordinary.available.costUsd).toBe(-8);
        expect(h.stores.usage.totalsForRun(w.runId).costUsd).toBe(10);
        expect(h.stores.allocationExtensions.listByPlanNode(a)).toHaveLength(1);
        expect(h.stores.reservations.planNodeAllocation(a)).toMatchObject({ reservationStatus: "released", extended: SHORTFALL });
        expect(h.runners.single.inspect(b)).toEqual({ kind: "waiting", reason: "budget", cleared: false, wakeAt: null });
        return work(h, w.runId);
      }, { recover: false });
      await withProcess(w, (h) => {
        expect(work(h, w.runId)).toEqual(overrun);
        // Window 18: an increase that does not cover the deficit plus B's shortfall changes nothing; one that does resumes B with its exact extension.
        const short = h.budgetIncreases.request({ runId: w.runId, partition: "ordinary", added: { costUsd: 8, tokens: 0, attempts: 0 } }).decision;
        h.budgetIncreases.resolve({ runId: w.runId, decisionId: short.id, option: "approve" });
        expect(h.stores.reservations.runCapacity(w.runId).ordinary.available.costUsd).toBe(0);
        expect(h.runners.single.inspect(b)).toEqual({ kind: "waiting", reason: "budget", cleared: false, wakeAt: null });
        const enough = h.budgetIncreases.request({ runId: w.runId, partition: "ordinary", added: { costUsd: 1, tokens: 0, attempts: 0 } }).decision;
        h.budgetIncreases.resolve({ runId: w.runId, decisionId: enough.id, option: "approve" });
        expect(h.runners.single.inspect(b)).toEqual({ kind: "waiting", reason: "budget", cleared: true, wakeAt: null });
      });
      await withProcess(w, (h) => {
        expect(h.runners.single.resume(b, revisionNumber)).toEqual({ kind: "resumed", reason: "budget" });
        expect(h.runners.single.start(b, revisionNumber)).toMatchObject({ kind: "started" });
        expect(h.stores.allocationExtensions.listByPlanNode(b)).toMatchObject([{ trigger: "invocation", added: SHORTFALL }]);
        expect(h.stores.allocationExtensions.listByRun(w.runId)).toHaveLength(2);
        expect(h.stores.reservations.runCapacity(w.runId).ordinary.available.costUsd).toBe(0);
        expect(h.stores.usage.totalsForRun(w.runId).costUsd).toBe(10);
        expect(h.stores.budgetIncreases.listByRun(w.runId)).toHaveLength(2);
        expect(h.ctx.journal.read({ runId: w.runId, type: "usage.recorded" })).toHaveLength(1);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });
});
