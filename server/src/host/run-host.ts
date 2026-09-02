/**
 * The host driver of the one scheduler (execution-model §7.1, §13, §14;
 * roadmap Phase 9): the thin production loop around `RunScheduler.advanceRun`
 * and `RunPublicationService.advance`.
 *
 * What it does:
 * - It is told that a Run may have work (`notifyRun`): after a committed
 *   operator action, after a Publication step, after a committed capacity
 *   release (below), and at startup for every nonterminal Run
 *   (`reconstruct`). Notifications for one Run coalesce into one pending
 *   mark; the mark is process memory only — the rows are the truth and the
 *   pass re-projects from them.
 * - **Capacity.** A Run the governor refused waits on `provider_capacity`
 *   with no resumption time (execution-model §7.8, §14): nothing but a
 *   released lease can make it runnable, and the release is committed by
 *   another Run's finalization, by recovery, or by a cancellation. The
 *   governor signals every committed release once (`onCapacityReleased`);
 *   the host then notifies every Run the rows record `waiting` on
 *   `provider_capacity` — whether or not it still holds a mark or sits in
 *   the queue — plus every Run whose last pass in this process reported a
 *   capacity wait while the Run row stayed `running` (a node held back by
 *   the Run's own concurrency limit beside the refused one). Readiness and
 *   admission stay the scheduler's and the governor's: the notified pass
 *   asks the governor again from rows, a paused, cancelled, or terminal Run
 *   projects nothing, and a Decision or budget wait is untouched because
 *   only capacity waiters are named. Notices coalesce through the same
 *   marks, dispatch stays bounded and fair, and a stopped host ignores them.
 * - A bounded number of Runs advance concurrently; each pass is bounded by
 *   the scheduler's own action limit, and a Run whose pass stopped at that
 *   limit goes to the back of the queue so no Run starves another.
 * - Every readiness, continuation, limit, and action decision is the
 *   scheduler's; the host reads only the outcome of a pass.
 * - **The one timer.** When a pass reports `wakeAt` — a retry backoff, a
 *   provider retry-after, a Decision deadline, or an Attempt deadline the
 *   scheduler derived from rows — the host arms one cancellable one-shot
 *   timer for that Run and nothing else: it re-notifies the Run, so the
 *   scheduler re-projects from rows. It holds no readiness or budget logic,
 *   is replaced by every later notification, is cancelled by `stop`, and
 *   never repeats on an interval. A pass that ended in an infrastructure
 *   failure (a busy database, a lost view) is re-notified once after a
 *   bounded, growing delay so a transient fault does not stall a Run until
 *   the next operator action; a successful pass resets it. Neither is a
 *   governance sweep: no timer decides anything about a Run.
 * - Publications advance the same way (`notifyPublication`): one durable
 *   boundary per `advance` until the Publication is terminal and released or
 *   an infrastructure failure stops it for the operator to retry.
 * - `stop` closes admission: no further pass starts, every armed timer is
 *   cancelled, and the caller interrupts the executing Attempts through the
 *   executor's lifecycle.
 */
import type { PublicationId, RunId, Timestamp } from "@agentique-console/core";
import type { ResourceGovernor } from "../execution/governor.ts";
import type { PublicationAdvanceOutcome, RunPublicationService } from "../execution/publication.ts";
import type { RunScheduler, SchedulerOutcome } from "../execution/scheduler.ts";
import type { RunStore } from "../persistence/stores/runs.ts";
import type { PublicationStore } from "../persistence/stores/publications.ts";

export interface RunHostDependencies {
  scheduler: Pick<RunScheduler, "advanceRun">;
  publication: Pick<RunPublicationService, "advance" | "reconcileOutstanding">;
  /** The governor's committed capacity signal: the host subscribes on construction and unsubscribes on `stop`. */
  governor: Pick<ResourceGovernor, "onCapacityReleased">;
  runs: Pick<RunStore, "listNonterminal" | "listWaitingOn">;
  publications: Pick<PublicationStore, "listNonterminal" | "listPendingCleanup">;
  clock: () => Timestamp;
}

export interface RunHostOptions {
  /** Runs advanced concurrently. */
  maxConcurrentRuns?: number;
  /** The bound on actions per pass handed to the scheduler. */
  maxActionsPerPass?: number;
  /** Receives every bounded host diagnostic. */
  onDiagnostic?: (diagnostic: RunHostDiagnostic) => void;
  /** The upper bound of the growing delay after a pass ended in an infrastructure failure. */
  failureBackoffMaxMs?: number;
}

export type RunHostDiagnostic =
  | { kind: "pass_failed"; runId: RunId; message: string; retryInMs: number | null }
  | { kind: "publication_advance"; publicationId: PublicationId; outcome: PublicationAdvanceOutcome["kind"]; message: string | null }
  | { kind: "reconstructed"; runs: number; publications: number }
  /** A committed capacity release re-projected these Runs (the rows' capacity waiters plus this process's remembered ones). */
  | { kind: "capacity_released"; runIds: RunId[] };

interface RunState {
  pending: boolean;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
}

export interface RunHostSnapshot {
  stopped: boolean;
  queued: RunId[];
  active: RunId[];
  armed: { runId: RunId; at: Timestamp }[];
  /** Runs whose last pass in this process reported a capacity wait; re-notified on the next committed release. */
  capacityWaiters: RunId[];
}

export class RunHost {
  readonly #runs = new Map<RunId, RunState>();
  readonly #queue: RunId[] = [];
  readonly #active = new Set<RunId>();
  readonly #armed = new Map<RunId, Timestamp>();
  readonly #publications = new Map<PublicationId, Promise<void>>();
  readonly #capacityWaiters = new Set<RunId>();
  readonly #unsubscribeCapacity: () => void;
  #stopped = false;
  #draining = false;
  #idle: Promise<void> = Promise.resolve();
  #resolveIdle: (() => void) | null = null;
  private readonly maxConcurrentRuns: number;
  private readonly maxActionsPerPass: number | undefined;
  private readonly failureBackoffMaxMs: number;
  private readonly onDiagnostic: (diagnostic: RunHostDiagnostic) => void;

  constructor(
    private readonly deps: RunHostDependencies,
    options: RunHostOptions = {},
  ) {
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 4;
    this.maxActionsPerPass = options.maxActionsPerPass;
    this.failureBackoffMaxMs = options.failureBackoffMaxMs ?? 60_000;
    this.onDiagnostic = options.onDiagnostic ?? (() => {});
    this.#unsubscribeCapacity = deps.governor.onCapacityReleased(() => this.capacityReleased());
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** The host's process-memory view, for tests and the health projection; never a source of truth. */
  snapshot(): RunHostSnapshot {
    return { stopped: this.#stopped, queued: [...this.#queue], active: [...this.#active].sort(), armed: [...this.#armed].map(([runId, at]) => ({ runId, at })).sort((a, b) => (a.runId < b.runId ? -1 : 1)), capacityWaiters: [...this.#capacityWaiters].sort() };
  }

  /** Marks the Run as possibly having work; coalesces with a pending mark; cancels an armed timer (the pass re-projects anyway). */
  notifyRun(runId: RunId): void {
    if (this.#stopped) return;
    const state = this.stateOf(runId);
    this.disarm(runId, state);
    this.#capacityWaiters.delete(runId);
    if (state.pending) return;
    state.pending = true;
    if (!state.running) this.#queue.push(runId);
    this.drain();
  }

  /**
   * A lease release committed: every Run the rows record waiting on provider capacity is re-projected, and so is every Run this
   * process saw report a capacity wait since its last pass. The rows are read after the commit, so a Run that recorded its wait
   * before the release is found here, and one that records it afterwards revalidates the governor inside its own transaction.
   */
  private capacityReleased(): void {
    if (this.#stopped) return;
    const runIds = new Set<RunId>(this.#capacityWaiters);
    for (const run of this.deps.runs.listWaitingOn("provider_capacity")) runIds.add(run.id);
    if (runIds.size === 0) return;
    this.onDiagnostic({ kind: "capacity_released", runIds: [...runIds].sort() });
    for (const runId of runIds) this.notifyRun(runId);
  }

  /** Drives one Publication through its durable boundaries until it is terminal and released, or an infrastructure failure stops it. */
  notifyPublication(publicationId: PublicationId): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    const existing = this.#publications.get(publicationId);
    if (existing) return existing;
    const work = this.advancePublication(publicationId).finally(() => {
      this.#publications.delete(publicationId);
    });
    this.#publications.set(publicationId, work);
    return work;
  }

  /** After a restart: every nonterminal Run and every outstanding Publication is re-driven from rows; nothing depends on a browser. */
  async reconstruct(): Promise<{ runs: number; publications: number }> {
    const outstanding = [...this.deps.publications.listNonterminal(), ...this.deps.publications.listPendingCleanup()];
    const publications = new Set(outstanding.map((p) => p.id));
    await Promise.all([...publications].map((id) => this.notifyPublication(id)));
    const runs = this.deps.runs.listNonterminal();
    for (const run of runs) this.notifyRun(run.id);
    this.onDiagnostic({ kind: "reconstructed", runs: runs.length, publications: publications.size });
    return { runs: runs.length, publications: publications.size };
  }

  /** Resolves once no pass is active and nothing is queued (armed timers excluded). */
  idle(): Promise<void> {
    if (this.#active.size === 0 && this.#queue.length === 0) return Promise.resolve();
    return this.#idle;
  }

  /** Closes admission: no further pass starts, every armed timer is cancelled, the capacity signal is dropped; resolves once the active passes returned. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#unsubscribeCapacity();
    this.#capacityWaiters.clear();
    for (const [runId, state] of this.#runs) this.disarm(runId, state);
    this.#queue.length = 0;
    for (const state of this.#runs.values()) state.pending = false;
    await this.idle();
    await Promise.allSettled([...this.#publications.values()]);
  }

  private stateOf(runId: RunId): RunState {
    let state = this.#runs.get(runId);
    if (!state) {
      state = { pending: false, running: false, timer: null, failures: 0 };
      this.#runs.set(runId, state);
    }
    return state;
  }

  private disarm(runId: RunId, state: RunState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.#armed.delete(runId);
  }

  /** Arms the one cancellable timer of the Run at `at`; a later notification replaces it. */
  private arm(runId: RunId, state: RunState, at: Timestamp): void {
    this.disarm(runId, state);
    if (this.#stopped) return;
    const delay = Math.max(0, Date.parse(at) - Date.parse(this.deps.clock()));
    state.timer = setTimeout(() => {
      state.timer = null;
      this.#armed.delete(runId);
      this.notifyRun(runId);
    }, Math.min(delay, 2_147_483_647));
    state.timer.unref?.();
    this.#armed.set(runId, at);
  }

  private drain(): void {
    if (this.#draining || this.#stopped) return;
    this.#draining = true;
    try {
      while (this.#active.size < this.maxConcurrentRuns) {
        const runId = this.#queue.shift();
        if (runId === undefined) break;
        const state = this.stateOf(runId);
        if (!state.pending || state.running) continue;
        state.pending = false;
        state.running = true;
        this.#active.add(runId);
        if (this.#resolveIdle === null) this.#idle = new Promise<void>((resolve) => (this.#resolveIdle = resolve));
        void this.pass(runId, state).finally(() => {
          state.running = false;
          this.#active.delete(runId);
          if (state.pending) this.#queue.push(runId);
          if (this.#active.size === 0 && this.#queue.length === 0 && this.#resolveIdle !== null) {
            const resolve = this.#resolveIdle;
            this.#resolveIdle = null;
            resolve();
          }
          this.drain();
        });
      }
    } finally {
      this.#draining = false;
    }
  }

  private async pass(runId: RunId, state: RunState): Promise<void> {
    let outcome: SchedulerOutcome;
    try {
      // A stopping host ends the pass before the next action: nothing new is admitted once the shutdown began.
      outcome = await this.deps.scheduler.advanceRun(runId, { stopRequested: () => this.#stopped, ...(this.maxActionsPerPass === undefined ? {} : { maxActions: this.maxActionsPerPass }) });
    } catch (error) {
      this.failed(runId, state, error instanceof Error ? error.message : String(error));
      return;
    }
    if (outcome.stop === "infrastructure_failure") {
      this.failed(runId, state, outcome.failure?.message ?? "infrastructure failure");
      return;
    }
    state.failures = 0;
    switch (outcome.stop) {
      case "action_limit":
        // The Run has more to do: it yields to the other queued Runs and comes back.
        state.pending = true;
        break;
      case "waiting":
        if (outcome.wakeAt !== null) this.arm(runId, state, outcome.wakeAt);
        // A capacity wait the pass reported is remembered until the next committed release re-projects it, whatever the Run row says
        // (a Run whose other node is held back by its own concurrency limit stays `running` while a node waits on capacity).
        if (!this.#stopped && !state.pending && outcome.waiting.some((w) => w.reason === "provider_capacity")) this.#capacityWaiters.add(runId);
        break;
      case "quiescent":
      case "run_terminal":
        break;
    }
    // A pass that ended may have freed provider or process capacity: every other Run with a mark gets its turn (the scheduler decides).
    for (const [other, otherState] of this.#runs) {
      if (other !== runId && otherState.pending && !otherState.running && !this.#queue.includes(other)) this.#queue.push(other);
    }
  }

  private failed(runId: RunId, state: RunState, message: string): void {
    state.failures += 1;
    const retryInMs = this.#stopped ? null : Math.min(this.failureBackoffMaxMs, 1_000 * 2 ** Math.min(state.failures - 1, 16));
    this.onDiagnostic({ kind: "pass_failed", runId, message, retryInMs });
    if (retryInMs === null) return;
    this.arm(runId, state, new Date(Date.parse(this.deps.clock()) + retryInMs).toISOString() as Timestamp);
  }

  private async advancePublication(publicationId: PublicationId): Promise<void> {
    // At most eight durable boundaries exist; the bound keeps a misbehaving provider from looping.
    for (let step = 0; step < 8 && !this.#stopped; step += 1) {
      let outcome: PublicationAdvanceOutcome;
      try {
        outcome = await this.deps.publication.advance(publicationId);
      } catch (error) {
        this.onDiagnostic({ kind: "publication_advance", publicationId, outcome: "infrastructure_failure", message: error instanceof Error ? error.message : String(error) });
        return;
      }
      this.onDiagnostic({ kind: "publication_advance", publicationId, outcome: outcome.kind, message: outcome.kind === "infrastructure_failure" ? outcome.message : null });
      if (outcome.kind === "quiescent" || outcome.kind === "released" || outcome.kind === "infrastructure_failure" || outcome.kind === "stale") return;
    }
  }
}
