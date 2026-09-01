/**
 * Operator Run control (execution-model §3, §14 "Operator cancels a Run",
 * "Operator pauses a Run"): the one execution-layer boundary through which
 * an operator-facing layer cancels, pauses, and resumes a Run. Three
 * internal services with strict typed inputs and closed outcomes; none is
 * an agent tool, none drives the scheduler, none creates a message.
 *
 * Accepted intent is separated from completed interruption. Each
 * operation first commits the operator's intent on the Run row in one
 * short transaction — the durable admission barrier every preparation,
 * dispatch, settlement, and continuation revalidates — and only then
 * delivers the interruption to the Attempts executing in this process
 * through the executor's abort signals. The signal is delivery, not
 * truth: an Attempt whose provider ignores it, or that was prepared in the
 * window between the commit and the delivery, is still ended by its own
 * finalization from the Run row; an Attempt of a process that died is
 * ended by recovery. No transaction is held while the provider is
 * interrupted or a worktree is released.
 *
 * - `cancel`: every nonterminal Run ends `cancelled` now (its operator
 *   pause cleared, the Conversation's active-Run reference released by the
 *   Run store); in the same transaction every Invocation, Task, Plan Node,
 *   and Handoff without executing work converges to its cancellation state
 *   (`run-cancellation.ts`) with terminal history preserved; then the
 *   executing Attempts receive the `cancelled` signal and the worktree
 *   obligations of the Invocations that ended are released. A repeated
 *   cancel replays: it writes nothing and re-delivers the signal and the
 *   releases. A completed or failed Run is refused with `run_terminal`.
 * - `pause`: `soft` stops admission — nothing new is prepared, dispatched,
 *   continued, integrated, or verified — while every admitted Attempt
 *   finishes with its Usage and legitimate result; `hard` additionally
 *   interrupts the executing Attempts with `operator_pause`, which the
 *   resumed Run retries under the ordinary retry policy. A `running` Run
 *   becomes `waiting` with reason `operator`; `waiting`, `verifying`, and
 *   `awaiting_signoff` Runs keep their status and hold the pause. A soft
 *   pause of a hard-paused Run changes nothing; a hard pause of a
 *   soft-paused Run escalates it and interrupts; a repeated pause of the
 *   same mode is `unchanged` but re-delivers a hard interruption. A
 *   `created` Run is refused with `not_started`, an ended one with
 *   `run_terminal`.
 * - `resume`: clears the operator pause and nothing else; readiness is
 *   recomputed from rows by the next scheduler pass (a Decision still open
 *   keeps the Run waiting, an unfunded `wait` node stays unfunded, a
 *   verification or signoff cycle resumes where it stood, finished work is
 *   not repeated, and a Decision resolved while paused continues its one
 *   successor only now). A Run that is not paused is `not_paused`; an
 *   ended one is refused with `run_terminal`.
 */
import {
  INVOCATION_MACHINE,
  parseOrThrow,
  RUN_MACHINE,
  RunControlRefusedError,
  runCancelRequestSchema,
  runPauseRequestSchema,
  runResumeRequestSchema,
  type AttemptId,
  type OperatorPauseMode,
  type RunCancelRequest,
  type RunId,
  type RunPauseRequest,
  type RunResumeRequest,
  type RunStatus,
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import { OPERATOR_ACTOR, type WriteOptions } from "../persistence/stores/support.ts";
import type { AttemptExecutor } from "./attempt-executor.ts";
import { settleCancelledRunWork, type CancelledRunConvergence } from "./run-cancellation.ts";

export type RunCancelOutcome = {
  kind: "cancelled";
  runId: RunId;
  /** True when the Run was already cancelled: nothing was written; the interruption and the releases were delivered again. */
  replayed: boolean;
  /** What the cancelling transaction converged now; `null` on a replay. */
  converged: CancelledRunConvergence | null;
  /** The Attempts of the Run executing in this process that this call interrupted with `cancelled`. */
  interruptedAttemptIds: AttemptId[];
  /** Every Attempt of the Run still executing in this process after the call (the interrupted ones included, until they finalize). */
  executingAttemptIds: AttemptId[];
};

export type RunPauseOutcome = {
  /** `paused` (a pause took effect), `escalated` (soft became hard), or `unchanged` (the requested or a stronger pause was already in force). */
  kind: "paused" | "escalated" | "unchanged";
  runId: RunId;
  requested: OperatorPauseMode;
  /** The mode in force after the call: never weaker than before. */
  mode: OperatorPauseMode;
  status: RunStatus;
  /** The Attempts of the Run executing in this process that this call interrupted with `operator_pause` (a hard pause only). */
  interruptedAttemptIds: AttemptId[];
  /** Every Attempt of the Run still executing in this process after the call: draining under a soft pause, finalizing under a hard one. */
  executingAttemptIds: AttemptId[];
};

export type RunResumeOutcome = {
  kind: "resumed" | "not_paused";
  runId: RunId;
  status: RunStatus;
  /** The pause mode this call cleared; `null` when the Run was not paused. */
  cleared: OperatorPauseMode | null;
};

export interface RunControlDependencies {
  ctx: PersistenceContext;
  stores: Stores;
  executor: Pick<AttemptExecutor, "interruptRun" | "inFlightOf" | "releaseWorkspace">;
}

export class RunControlService {
  constructor(private readonly deps: RunControlDependencies) {}

  private meta(options: WriteOptions): WriteOptions {
    return { actor: options.actor ?? OPERATOR_ACTOR, correlationId: options.correlationId ?? null, causationSeq: options.causationSeq ?? null };
  }

  private outsideTransaction(operation: string): void {
    if (this.deps.ctx.tx.inTransaction) throw new Error(`Run ${operation} never runs inside a transaction; interruption delivery and worktree release are external`);
  }

  /** Cancels a nonterminal Run durably, converges its work, then delivers the interruption and the worktree releases. Idempotent. */
  cancel(request: RunCancelRequest, options: WriteOptions = {}): RunCancelOutcome {
    const { runId } = parseOrThrow(runCancelRequestSchema, request, "Run cancel request");
    this.outsideTransaction("cancellation");
    const { ctx, stores, executor } = this.deps;
    const meta = this.meta(options);
    const committed = ctx.tx.write((): { replayed: boolean; converged: CancelledRunConvergence | null } => {
      const run = stores.runs.get(runId);
      if (run.status === "cancelled") return { replayed: true, converged: null };
      if (RUN_MACHINE.isTerminal(run.status)) throw new RunControlRefusedError("run_terminal", `Run ${runId} is ${run.status}; an ended Run is never cancelled`, { runId, status: run.status });
      stores.runs.transition(runId, { to: "cancelled" }, meta);
      return { replayed: false, converged: settleCancelledRunWork(stores, runId, { ...meta, causationSeq: ctx.journal.lastSeq() }) };
    });
    // The intent is durable. Delivery follows, outside every transaction: the executing Attempts receive the signal (their finalization
    // ends them from the Run row even if the provider ignores it), and the worktrees of the Invocations that ended are released.
    const interruptedAttemptIds = executor.interruptRun(runId, "cancelled");
    this.releaseEndedWorkspaces(runId, meta);
    return { kind: "cancelled", runId, replayed: committed.replayed, converged: committed.converged, interruptedAttemptIds, executingAttemptIds: executor.inFlightOf(runId) };
  }

  /** Records the operator's pause durably, then (for a hard pause) delivers the interruption. Repeated and concurrent requests converge. */
  pause(request: RunPauseRequest, options: WriteOptions = {}): RunPauseOutcome {
    const { runId, mode } = parseOrThrow(runPauseRequestSchema, request, "Run pause request");
    this.outsideTransaction("pause");
    const { ctx, stores, executor } = this.deps;
    const result = ctx.tx.write(() => stores.runs.pause(runId, mode, this.meta(options)));
    // A hard pause in force interrupts whatever executes here, on every request (a lost response retried delivers again, never twice to
    // the same Attempt); a soft pause delivers nothing — admitted Attempts drain.
    const interruptedAttemptIds = result.run.operatorPause === "hard" ? executor.interruptRun(runId, "operator_pause") : [];
    return { kind: result.change, runId, requested: mode, mode: result.run.operatorPause!, status: result.run.status, interruptedAttemptIds, executingAttemptIds: executor.inFlightOf(runId) };
  }

  /** Clears the operator pause and nothing else; the next scheduler pass recomputes readiness from rows. */
  resume(request: RunResumeRequest, options: WriteOptions = {}): RunResumeOutcome {
    const { runId } = parseOrThrow(runResumeRequestSchema, request, "Run resume request");
    this.outsideTransaction("resume");
    const { ctx, stores } = this.deps;
    const result = ctx.tx.write(() => stores.runs.resume(runId, this.meta(options)));
    return { kind: result.change, runId, status: result.run.status, cleared: result.cleared };
  }

  /** Releases the worktree obligations of the Run's Invocations that have ended (external, idempotent); a failure stays a pending obligation recovery retries. */
  private releaseEndedWorkspaces(runId: RunId, meta: WriteOptions): void {
    for (const invocation of this.deps.stores.invocations.listPendingWorkspaceCleanup()) {
      if (invocation.runId !== runId || !INVOCATION_MACHINE.isTerminal(invocation.status)) continue;
      this.deps.executor.releaseWorkspace(invocation.id, meta);
    }
  }
}
