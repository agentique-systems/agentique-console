/**
 * The host driver over a scripted scheduler: notifications coalesce, a Run
 * that stops at its action limit yields and returns, concurrency is bounded
 * and fair, a `wakeAt` arms exactly one cancellable timer that a later
 * notification replaces and `stop` cancels, an infrastructure failure
 * re-notifies with a bounded growing delay and never loops hot,
 * reconstruction notifies every nonterminal Run and re-drives every
 * outstanding Publication from rows, and a committed capacity release
 * re-projects the Runs the rows record waiting on provider capacity (and
 * the ones this process saw wait) whether or not they hold a mark. No
 * readiness or budget decision is made here: the outcome of a pass and the
 * rows' wait reasons are all the host reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanNodeId, PublicationId, Run, RunId, Timestamp } from "@agentique-console/core";
import type { PublicationAdvanceOutcome } from "../execution/publication.ts";
import type { SchedulerOutcome } from "../execution/scheduler.ts";
import { RunHost, type RunHostDiagnostic } from "./run-host.ts";

type Script = (runId: RunId, pass: number) => Partial<SchedulerOutcome> | Promise<Partial<SchedulerOutcome>>;

function outcome(runId: RunId, partial: Partial<SchedulerOutcome>): SchedulerOutcome {
  return { runId, stop: "quiescent", actions: [], executed: [], waiting: [], remediating: [], wakeAt: null, failure: null, ...partial };
}

function harness(script: Script, options: { maxConcurrentRuns?: number; nonterminal?: RunId[]; publications?: PublicationId[]; publicationScript?: (id: PublicationId, step: number) => PublicationAdvanceOutcome } = {}) {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const passes: { runId: RunId; pass: number }[] = [];
  const counts = new Map<RunId, number>();
  const diagnostics: RunHostDiagnostic[] = [];
  const advances: { id: PublicationId; step: number }[] = [];
  const steps = new Map<PublicationId, number>();
  /** The Runs the rows record `waiting` on `provider_capacity` (a test edits it as the scheduler's wait_run would commit). */
  const waitingOnCapacity: RunId[] = [];
  const releaseListeners = new Set<() => void>();
  const host = new RunHost(
    {
      scheduler: {
        advanceRun: async (runId) => {
          const pass = (counts.get(runId) ?? 0) + 1;
          counts.set(runId, pass);
          passes.push({ runId, pass });
          return outcome(runId, await script(runId, pass));
        },
      },
      publication: {
        advance: async (id) => {
          const step = (steps.get(id) ?? 0) + 1;
          steps.set(id, step);
          advances.push({ id, step });
          return options.publicationScript?.(id, step) ?? { kind: "quiescent", publicationId: id };
        },
        reconcileOutstanding: async () => [],
      },
      governor: {
        onCapacityReleased: (listener) => {
          releaseListeners.add(listener);
          return () => {
            releaseListeners.delete(listener);
          };
        },
      },
      runs: { listNonterminal: () => (options.nonterminal ?? []).map((id) => ({ id }) as Run), listWaitingOn: (reason) => (reason === "provider_capacity" ? waitingOnCapacity : []).map((id) => ({ id }) as Run) },
      publications: { listNonterminal: () => (options.publications ?? []).map((id) => ({ id }) as never), listPendingCleanup: () => [] },
      clock: () => new Date(now).toISOString() as Timestamp,
    },
    { maxConcurrentRuns: options.maxConcurrentRuns ?? 2, onDiagnostic: (d) => diagnostics.push(d), failureBackoffMaxMs: 8_000 },
  );
  /** What the governor does after a transaction that released a lease committed. */
  const releaseCapacity = () => {
    for (const listener of [...releaseListeners]) listener();
  };
  return { host, passes, diagnostics, advances, waitingOnCapacity, releaseCapacity, subscribed: () => releaseListeners.size, advance: (ms: number) => (now += ms) };
}

const NODE = "pn_aaaaaaaaaaaaaaaaaaaaaaaa" as PlanNodeId;
const capacityWait = (): Partial<SchedulerOutcome> => ({ stop: "waiting", waiting: [{ nodeId: NODE, reason: "provider_capacity", wakeAt: null }], wakeAt: null });

const RUN_A = "run_aaaaaaaaaaaaaaaaaaaaaaaa" as RunId;
const RUN_B = "run_bbbbbbbbbbbbbbbbbbbbbbbb" as RunId;
const RUN_C = "run_cccccccccccccccccccccccc" as RunId;
const PUB = "pub_aaaaaaaaaaaaaaaaaaaaaaaa" as PublicationId;

describe("RunHost", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces repeated notifications into one pass and re-passes a Run notified while its pass ran", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness(async (_runId, pass) => {
      if (pass === 1) await gate;
      return { stop: "quiescent" };
    });
    h.host.notifyRun(RUN_A);
    h.host.notifyRun(RUN_A);
    h.host.notifyRun(RUN_A);
    await Promise.resolve();
    expect(h.passes).toEqual([{ runId: RUN_A, pass: 1 }]);
    // Notified during the pass: exactly one more pass follows it.
    h.host.notifyRun(RUN_A);
    h.host.notifyRun(RUN_A);
    release();
    await h.host.idle();
    expect(h.passes).toEqual([{ runId: RUN_A, pass: 1 }, { runId: RUN_A, pass: 2 }]);
  });

  it("bounds concurrent Runs and lets a Run that hit its action limit yield to the others before it continues", async () => {
    const order: string[] = [];
    const h = harness(async (runId, pass) => {
      order.push(`${runId.slice(4, 5)}${pass}`);
      await Promise.resolve();
      return runId === RUN_A && pass < 3 ? { stop: "action_limit" } : { stop: "quiescent" };
    }, { maxConcurrentRuns: 1 });
    h.host.notifyRun(RUN_A);
    h.host.notifyRun(RUN_B);
    h.host.notifyRun(RUN_C);
    await h.host.idle();
    // A's first pass hit the limit: B and C take their turns before A continues; A returns until quiescent.
    expect(order).toEqual(["a1", "b1", "c1", "a2", "a3"]);
    expect(h.host.snapshot()).toEqual({ stopped: false, queued: [], active: [], armed: [], capacityWaiters: [] });
  });

  it("arms exactly one cancellable timer from the scheduler's wakeAt, replaces it on a later notification, fires it once, and cancels it on stop", async () => {
    const h = harness(async (_runId, pass) => (pass === 1 ? { stop: "waiting", wakeAt: "2026-01-01T00:00:30.000Z" as Timestamp } : { stop: "quiescent" }));
    h.host.notifyRun(RUN_A);
    await h.host.idle();
    expect(h.host.snapshot().armed).toEqual([{ runId: RUN_A, at: "2026-01-01T00:00:30.000Z" }]);
    expect(vi.getTimerCount()).toBe(1);
    // A notification replaces the timer with a pass; the pass ends quiescent, so nothing stays armed.
    h.host.notifyRun(RUN_A);
    await h.host.idle();
    expect(h.host.snapshot().armed).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.passes.map((p) => p.pass)).toEqual([1, 2]);
    // A fresh wait arms again; the timer fires once at the resumption time and the pass re-projects.
    const again = harness(async (_runId, pass) => (pass === 1 ? { stop: "waiting", wakeAt: "2026-01-01T00:00:10.000Z" as Timestamp } : { stop: "quiescent" }));
    again.host.notifyRun(RUN_B);
    await again.host.idle();
    expect(vi.getTimerCount()).toBe(1);
    again.advance(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await again.host.idle();
    expect(again.passes.map((p) => p.pass)).toEqual([1, 2]);
    expect(vi.getTimerCount()).toBe(0);
    // Stop cancels an armed timer; nothing fires afterwards and no pass starts.
    const stopped = harness(async () => ({ stop: "waiting", wakeAt: "2026-01-01T00:00:05.000Z" as Timestamp }));
    stopped.host.notifyRun(RUN_C);
    await stopped.host.idle();
    expect(vi.getTimerCount()).toBe(1);
    await stopped.host.stop();
    expect(vi.getTimerCount()).toBe(0);
    stopped.host.notifyRun(RUN_C);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopped.passes).toHaveLength(1);
  });

  it("re-notifies after an infrastructure failure with a bounded growing delay, reports it, and resets on success", async () => {
    let fail = 3;
    const h = harness(async () => {
      if (fail > 0) {
        fail -= 1;
        return { stop: "infrastructure_failure", failure: { message: "database busy" } };
      }
      return { stop: "quiescent" };
    });
    h.host.notifyRun(RUN_A);
    await h.host.idle();
    expect(h.diagnostics).toEqual([{ kind: "pass_failed", runId: RUN_A, message: "database busy", retryInMs: 1_000 }]);
    h.advance(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await h.host.idle();
    expect(h.diagnostics.at(-1)).toMatchObject({ retryInMs: 2_000 });
    h.advance(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await h.host.idle();
    expect(h.diagnostics.at(-1)).toMatchObject({ retryInMs: 4_000 });
    h.advance(4_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await h.host.idle();
    expect(h.passes).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
    // The delay is bounded: many failures never exceed the maximum.
    fail = 20;
    for (let i = 0; i < 10; i += 1) {
      h.host.notifyRun(RUN_A);
      await h.host.idle();
      const last = h.diagnostics.at(-1);
      expect(last?.kind === "pass_failed" ? last.retryInMs : null).toBeLessThanOrEqual(8_000);
    }
  });

  it("reconstructs from rows: every nonterminal Run is notified and every outstanding Publication is driven to its terminal boundary", async () => {
    const h = harness(async () => ({ stop: "quiescent" }), { nonterminal: [RUN_A, RUN_B], publications: [PUB], publicationScript: (id, step) => (step < 3 ? { kind: "prepared", publicationId: id } : { kind: "released", publicationId: id }) });
    expect(await h.host.reconstruct()).toEqual({ runs: 2, publications: 1 });
    await h.host.idle();
    expect(h.passes.map((p) => p.runId).sort()).toEqual([RUN_A, RUN_B]);
    expect(h.advances.map((a) => a.step)).toEqual([1, 2, 3]);
    expect(h.diagnostics.filter((d) => d.kind === "reconstructed")).toEqual([{ kind: "reconstructed", runs: 2, publications: 1 }]);
    // A Publication advanced concurrently by two notifications is driven once.
    const twice = harness(async () => ({ stop: "quiescent" }), { publicationScript: (id, step) => (step < 2 ? { kind: "verified", publicationId: id, checks: 0 } : { kind: "quiescent", publicationId: id }) });
    await Promise.all([twice.host.notifyPublication(PUB), twice.host.notifyPublication(PUB)]);
    expect(twice.advances.map((a) => a.step)).toEqual([1, 2]);
  });

  it("re-projects the Runs the rows record waiting on provider capacity when a committed lease release is signalled, whether or not they hold a mark; a Decision or budget waiter is not named; nothing after stop", async () => {
    // B's pass ends waiting on provider capacity with no resumption time: no mark, no timer, nothing queued — the defect's shape.
    const h = harness(async (runId, pass) => (runId === RUN_B && pass === 1 ? capacityWait() : { stop: "quiescent" }));
    expect(h.subscribed()).toBe(1);
    h.host.notifyRun(RUN_B);
    await h.host.idle();
    expect(h.host.snapshot()).toEqual({ stopped: false, queued: [], active: [], armed: [], capacityWaiters: [RUN_B] });
    expect(vi.getTimerCount()).toBe(0);
    // The scheduler's wait_run committed: the rows say B waits on capacity. Another Run's finalization releases its lease and commits.
    h.waitingOnCapacity.push(RUN_B);
    h.releaseCapacity();
    await h.host.idle();
    expect(h.passes.filter((p) => p.runId === RUN_B).map((p) => p.pass)).toEqual([1, 2]);
    expect(h.diagnostics.filter((d) => d.kind === "capacity_released")).toEqual([{ kind: "capacity_released", runIds: [RUN_B] }]);
    expect(h.host.snapshot().capacityWaiters).toEqual([]);
    // B's second pass was quiescent; while the rows still list it (a stale row the next pass would settle) a release re-projects it once more,
    // and once the rows no longer list it, a release starts nothing: the host decides nothing itself.
    h.releaseCapacity();
    await h.host.idle();
    expect(h.passes.filter((p) => p.runId === RUN_B)).toHaveLength(3);
    h.waitingOnCapacity.length = 0;
    h.releaseCapacity();
    await h.host.idle();
    expect(h.passes.filter((p) => p.runId === RUN_B)).toHaveLength(3);
    expect(h.diagnostics.filter((d) => d.kind === "capacity_released")).toHaveLength(2);
    // A Run whose rows stay `running` (a node held back by its own concurrency limit beside the refused one) is remembered from its pass
    // alone and re-projected from process memory on the next release; a Run waiting on a Decision or budget is neither listed nor remembered.
    const memory = harness(async (runId, pass) => (runId === RUN_A && pass === 1 ? capacityWait() : runId === RUN_C ? { stop: "waiting", waiting: [{ nodeId: NODE, reason: "decision", wakeAt: null }] } : { stop: "quiescent" }));
    memory.host.notifyRun(RUN_A);
    memory.host.notifyRun(RUN_C);
    await memory.host.idle();
    expect(memory.host.snapshot().capacityWaiters).toEqual([RUN_A]);
    memory.releaseCapacity();
    await memory.host.idle();
    expect(memory.passes.map((p) => `${p.runId.slice(4, 5)}${p.pass}`)).toEqual(["a1", "c1", "a2"]);
    expect(memory.diagnostics.filter((d) => d.kind === "capacity_released")).toEqual([{ kind: "capacity_released", runIds: [RUN_A] }]);
    // Releases signalled while the waiter's pass is still running coalesce into its one pending mark: one more pass, not one per release.
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => (releaseB = resolve));
    const burst = harness(async (runId, pass) => {
      if (runId === RUN_B && pass === 1) return capacityWait();
      if (runId === RUN_B && pass === 2) await gateB;
      return { stop: "quiescent" };
    });
    burst.host.notifyRun(RUN_B);
    await burst.host.idle();
    burst.waitingOnCapacity.push(RUN_B);
    burst.releaseCapacity();
    await Promise.resolve();
    expect(burst.host.snapshot().active).toEqual([RUN_B]);
    burst.releaseCapacity();
    burst.releaseCapacity();
    burst.releaseCapacity();
    releaseB();
    await burst.host.idle();
    expect(burst.passes.filter((p) => p.runId === RUN_B).map((p) => p.pass)).toEqual([1, 2, 3]);
    // Stop drops the signal: a release after shutdown began admits nothing, so no successor or retry starts through a late notification.
    const stopped = harness(async (runId, pass) => (runId === RUN_B && pass === 1 ? capacityWait() : { stop: "quiescent" }));
    stopped.host.notifyRun(RUN_B);
    await stopped.host.idle();
    stopped.waitingOnCapacity.push(RUN_B);
    await stopped.host.stop();
    expect(stopped.subscribed()).toBe(0);
    stopped.releaseCapacity();
    await stopped.host.idle();
    expect(stopped.passes).toHaveLength(1);
    expect(stopped.host.snapshot()).toEqual({ stopped: true, queued: [], active: [], armed: [], capacityWaiters: [] });
  });

  it("re-queues the other marked Runs when a pass ends, so freed capacity reaches them without a timer", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => (releaseA = resolve));
    const h = harness(async (runId, pass) => {
      if (runId === RUN_A && pass === 1) await gateA;
      return { stop: "quiescent" };
    }, { maxConcurrentRuns: 1 });
    h.host.notifyRun(RUN_A);
    h.host.notifyRun(RUN_B);
    await Promise.resolve();
    expect(h.host.snapshot()).toMatchObject({ active: [RUN_A], queued: [RUN_B] });
    releaseA();
    await h.host.idle();
    expect(h.passes.map((p) => p.runId)).toEqual([RUN_A, RUN_B]);
  });
});
