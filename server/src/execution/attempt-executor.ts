/**
 * Durable Attempt execution (execution-model §6.5, §6.6, §7.2, §7.8, §12,
 * §14). Three short canonical transaction boundaries surround one provider
 * call that never runs inside a transaction:
 *
 *   prepare   verify the Invocation and its immutable manifest, the
 *             remaining Attempt, cost, and token allocation, the one
 *             Invocation-wide wall-clock deadline (`startedAt +
 *             maxWallClockMs`, shared by every Attempt), and the durable
 *             retry decision of the previous Attempt; select a fresh or
 *             resumed start; obtain a capacity lease; create the Attempt
 *             (`initial` or `retry`) and start it — or refuse without
 *             creating anything.
 *   execute   render the persisted manifest (plus the bounded retry
 *             appendix), call the provider with cancellation, deadline, and
 *             the runtime-owned tool-call authorization port bound to this
 *             Attempt (each approval claim commits in its own short
 *             transaction before the call may run) and the runtime-tool
 *             call port bound to it (each accepted mutating call commits in
 *             its own short transaction and is replayable), stream transient
 *             output, collect the writing Invocation's Changeset through
 *             the execution-workspace port, store the continuation payload.
 *   finalize  transcript Artifact; every Usage row; Changeset; result
 *             validation; the Attempt's terminal transition with its bounded
 *             failure detail and durable retry decision; lease release;
 *             Invocation settlement (terminal only when no retry remains,
 *             which releases its reservation) and Task transitions.
 *
 * An accepted `request_decision` committed during execution is a hard
 * logical-turn boundary (execution-model §8.2): whatever the provider then
 * reports — a result, a failure, a throw, an interruption, further calls —
 * finalization records the Usage once, ends the Attempt `failed` with the
 * closed `decision_requested` class and a refused retry, ends the
 * Invocation `blocked` on the requested Decision with its Tasks blocked on
 * it, and releases its reservation and worktree. A running Invocation found
 * with a committed request and no active Attempt (a process that died
 * between the commit and finalization) converges to the same state on its
 * next preparation without another provider call.
 *
 * Operator control (execution-model §14) is revalidated from the Run row at
 * every boundary: preparation refuses under a pause or an ended Run
 * (`run_paused`, `run_terminal`); a prepared Attempt is dispatched to the
 * provider only if the Run still admits work — otherwise it ends
 * interrupted without a provider call — and finalization reads the Run row
 * again, so a cancellation (`cancelled`, no retry) or a hard pause
 * (`operator_pause`, retried after resume) committed while the provider
 * ran ends the Attempt from rows even when the abort signal reached
 * nothing; a late provider result is then not a result. A soft pause lets
 * the admitted Attempt finish with its Usage and legitimate result.
 *
 * Every operation is safe to call repeatedly: a finalized Attempt is never
 * finalized twice, a refusal creates nothing, and an in-flight Attempt is
 * reported rather than duplicated. Nothing here reads a transcript.
 */
import {
  CHANGESET_DIFF_MEDIA_TYPE,
  ATTEMPT_MACHINE,
  boundedFailureMessage,
  ConflictError,
  grantsWriteCapability,
  INVOCATION_MACHINE,
  invocationDeadlineAt,
  RUN_MACHINE,
  runAdmitsNewWork,
  runExecutionInterruptionOf,
  TOOL_CALL_MEDIA_TYPE,
  TRANSCRIPT_MEDIA_TYPE,
  type Attempt,
  type AttemptId,
  type CapacityLease,
  type CapacityRefusal,
  type ContextManifest,
  type Decision,
  type Invocation,
  type InvocationId,
  type RetryDecision,
  type Run,
  type RunId,
  type Timestamp,
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import type { AttemptExecutionOutcome, AttemptExecutionRequest, ProviderAdapter, ProviderCompletion, TransientOutputSink } from "../provider/adapter.ts";
import type { ContinuationService } from "../provider/continuation.ts";
import { continuationCandidate, type ContinuationPolicyConfig } from "./continuation-policy.ts";
import { blockingRequestOf } from "./decision-requests.ts";
import type { ResourceGovernor } from "./governor.ts";
import { settleInvocation, type Settlement } from "./invocation-lifecycle.ts";
import { renderManifest, type RetryAppendix } from "./manifest/renderer.ts";
import type { CollectedChangeset, ExecutionWorkspacePort } from "./ports/execution-workspace.ts";
import { InvocationResultValidator, type ResultValidation } from "./result-validator.ts";
import { classifyAttempt, decideRetry, DEFAULT_RETRY_POLICY, type RetryPolicyConfig, type RuntimeInterruption } from "./retry-policy.ts";
import { settleCancelledRunWork } from "./run-cancellation.ts";
import { RuntimeToolExecutor } from "./runtime-tools.ts";
import { canonicalizeToolCall, ToolCallAuthorizer } from "./tool-call-authorization.ts";
import { WorkspaceCleanup, type ExecutionDiagnosticSink, type WorkspaceReleaseOutcome } from "./workspace-cleanup.ts";

export interface AttemptExecutorConfig {
  retry: RetryPolicyConfig;
  continuation: ContinuationPolicyConfig;
}

export const DEFAULT_EXECUTOR_CONFIG: Readonly<AttemptExecutorConfig> = Object.freeze({
  retry: DEFAULT_RETRY_POLICY,
  continuation: { contextWindowTokens: 200_000 },
});

export type NotPermittedReason = "invocation_terminal" | "invocation_waiting" | "attempt_active" | "run_terminal" | "run_paused" | "retry_refused" | "retry_not_yet" | "allocation_exhausted" | "decision_requested";

export type PrepareOutcome =
  | { kind: "prepared"; attempt: Attempt; lease: CapacityLease; invocation: Invocation }
  | { kind: "capacity_refused"; refusal: CapacityRefusal; invocation: Invocation }
  | { kind: "not_permitted"; reason: NotPermittedReason; invocation: Invocation; notBefore: Timestamp | null };

export type ExecutionOutcome =
  | { kind: "finalized"; attempt: Attempt; settlement: Settlement }
  /** The Invocation ended `blocked` on the open `side_effect_approval` Decision; the call itself is only in the Decision's call Artifact. */
  | { kind: "approval_required"; attempt: Attempt; settlement: Settlement; decision: Decision }
  /** The Invocation ended `blocked` on the Decision it requested through `request_decision`; the provider's later output changed nothing. */
  | { kind: "decision_requested"; attempt: Attempt; settlement: Settlement; decision: Decision };

export type AdvanceOutcome = PrepareOutcome | ExecutionOutcome | { kind: "in_flight"; attemptId: AttemptId; invocation: Invocation };

/** Everything the runtime can say about an Invocation's next Attempt from canonical state alone. */
export interface InvocationInspection {
  invocation: Invocation;
  attempts: Attempt[];
  latestAttempt: Attempt | null;
  attemptsRemaining: number;
  /** The one Invocation-wide wall-clock deadline (`startedAt + maxWallClockMs`), `null` when unbounded or not yet started. */
  deadlineAt: Timestamp | null;
  /** Whether another Attempt may be created now, or why not; `retry_not_yet` carries the earliest time. */
  next: { permitted: true } | { permitted: false; reason: NotPermittedReason; notBefore: Timestamp | null };
  /** The Attempt whose provider execution the next Attempt may continue from, when every canonical check passes. */
  resumeCandidateAttemptId: AttemptId | null;
  previousFailure: { attemptId: AttemptId; failureClass: Attempt["failureClass"]; detail: Attempt["failureDetail"]; decision: RetryDecision | null } | null;
}

/** What the prepare transaction commits; a flight is built from these only after the commit. */
interface PreparedFacts {
  attempt: Attempt;
  lease: CapacityLease;
  invocation: Invocation;
  deadlineAt: Timestamp | null;
  continuation: Uint8Array | null;
}

interface InFlight {
  attemptId: AttemptId;
  invocationId: InvocationId;
  runId: RunId;
  controller: AbortController;
  deadlineAt: Timestamp | null;
  runtimeInterruption: RuntimeInterruption;
  continuation: Uint8Array | null;
  outcome: AttemptExecutionOutcome | null;
  changeset: CollectedChangeset | null;
  continuationStored: boolean;
  executing: Promise<ExecutionOutcome> | null;
}

export class AttemptExecutor {
  readonly #inFlight = new Map<AttemptId, InFlight>();
  private readonly validator: InvocationResultValidator;
  private readonly cleanup: WorkspaceCleanup;
  private readonly diagnostics: ExecutionDiagnosticSink;

  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
    private readonly provider: ProviderAdapter,
    private readonly continuations: ContinuationService,
    private readonly governor: ResourceGovernor,
    private readonly workspace: ExecutionWorkspacePort,
    private readonly config: AttemptExecutorConfig = DEFAULT_EXECUTOR_CONFIG,
    private readonly output: TransientOutputSink = () => {},
    diagnostics: ExecutionDiagnosticSink = () => {},
  ) {
    this.validator = new InvocationResultValidator(stores);
    this.cleanup = new WorkspaceCleanup(ctx, stores, workspace, diagnostics);
    this.diagnostics = diagnostics;
  }

  // ---------------------------------------------------------------------------
  // Inspection
  // ---------------------------------------------------------------------------

  inspectInvocation(invocationId: InvocationId, now: Timestamp = this.ctx.clock()): InvocationInspection {
    const invocation = this.stores.invocations.get(invocationId);
    const attempts = this.stores.invocations.listAttempts(invocationId);
    const latest = attempts.at(-1) ?? null;
    const previousFailure =
      latest && latest.status !== "succeeded" && ATTEMPT_MACHINE.isTerminal(latest.status)
        ? { attemptId: latest.id, failureClass: latest.failureClass, detail: latest.failureDetail, decision: latest.retryDecision }
        : null;
    const manifest = this.manifestOf(invocation);
    const deadlineAt = manifest === null ? null : invocationDeadlineAt(invocation.startedAt, manifest.content.maxWallClockMs);
    const next = this.nextPermission(invocation, manifest, attempts, deadlineAt, now);
    const resumeCandidateAttemptId =
      next.permitted && manifest !== null ? (continuationCandidate(this.stores, this.continuations, this.provider, this.config.continuation, invocation, manifest, now)?.attemptId ?? null) : null;
    return { invocation, attempts, latestAttempt: latest, attemptsRemaining: Math.max(0, invocation.allocation.attempts - attempts.length), deadlineAt, next, resumeCandidateAttemptId, previousFailure };
  }

  /** The Attempts this process is executing, in Attempt id order. */
  inFlight(): AttemptId[] {
    return [...this.#inFlight.keys()].sort();
  }

  /** The Attempts of one Run this process is executing, in Attempt id order. */
  inFlightOf(runId: RunId): AttemptId[] {
    return [...this.#inFlight.values()].filter((f) => f.runId === runId).map((f) => f.attemptId).sort();
  }

  private manifestOf(invocation: Invocation): ContextManifest | null {
    try {
      return this.stores.invocations.getManifest(invocation.id);
    } catch {
      return null;
    }
  }

  private nextPermission(invocation: Invocation, manifest: ContextManifest | null, attempts: Attempt[], deadlineAt: Timestamp | null, now: Timestamp): InvocationInspection["next"] {
    if (INVOCATION_MACHINE.isTerminal(invocation.status)) return { permitted: false, reason: "invocation_terminal", notBefore: null };
    if (invocation.status === "waiting") return { permitted: false, reason: "invocation_waiting", notBefore: null };
    if (manifest === null) return { permitted: false, reason: "invocation_terminal", notBefore: null };
    if (attempts.some((a) => !ATTEMPT_MACHINE.isTerminal(a.status))) return { permitted: false, reason: "attempt_active", notBefore: null };
    // The Run row is the admission barrier (execution-model §14): an ended Run acquires no work, a paused Run admits none until resumed.
    const run = this.stores.runs.get(invocation.runId);
    if (RUN_MACHINE.isTerminal(run.status)) return { permitted: false, reason: "run_terminal", notBefore: null };
    if (run.operatorPause !== null) return { permitted: false, reason: "run_paused", notBefore: null };
    // A durably requested blocking Decision ended the logical turn: the Invocation settles blocked, never re-executes (execution-model §8.2).
    if (blockingRequestOf(this.stores, invocation) !== null) return { permitted: false, reason: "decision_requested", notBefore: null };
    // No Attempt may be created once the Invocation-wide deadline has been reached.
    if (deadlineAt !== null && now >= deadlineAt) return { permitted: false, reason: "allocation_exhausted", notBefore: null };
    const latest = attempts.at(-1);
    if (latest) {
      const decision = latest.retryDecision;
      if (!decision || !decision.permitted) return { permitted: false, reason: "retry_refused", notBefore: null };
      if (decision.notBefore !== null && decision.notBefore > now) return { permitted: false, reason: "retry_not_yet", notBefore: decision.notBefore };
    }
    if (attempts.length >= invocation.allocation.attempts) return { permitted: false, reason: "allocation_exhausted", notBefore: null };
    const consumed = this.stores.usage.consumedByInvocation(invocation.id);
    if (invocation.allocation.costUsd > 0 && consumed.costUsd >= invocation.allocation.costUsd) return { permitted: false, reason: "allocation_exhausted", notBefore: null };
    if (invocation.allocation.tokens > 0 && consumed.tokens >= invocation.allocation.tokens) return { permitted: false, reason: "allocation_exhausted", notBefore: null };
    return { permitted: true };
  }

  // ---------------------------------------------------------------------------
  // Prepare
  // ---------------------------------------------------------------------------

  /**
   * Creates and starts the next Attempt, or reports why none was created. A
   * capacity refusal creates no Attempt and consumes no allocation. An
   * exhausted cost, token, Attempt, or wall-clock allocation fails the
   * Invocation with `allocation_exhausted` and creates nothing.
   */
  async prepareNextAttempt(invocationId: InvocationId, options: WriteOptions = {}): Promise<PrepareOutcome> {
    const inspection = this.inspectInvocation(invocationId);
    if (!inspection.next.permitted) return this.refuse(inspection, options);
    // The payload is resolved outside any transaction; a missing or corrupt payload yields a fresh start with no error.
    const candidate = inspection.resumeCandidateAttemptId;
    const continuation = candidate === null ? null : await this.continuations.resolve(candidate, this.provider.provider);
    // The transaction returns the facts a flight is built from; the flight is published only once `write` has
    // returned, i.e. after COMMIT succeeded. A callback failure, a rollback-only root, or a failed COMMIT throws
    // out of `write` before any in-memory entry exists, so the provider can never be called for an Attempt that
    // did not commit.
    const committed = this.ctx.tx.write((): PrepareOutcome | { kind: "committed"; facts: PreparedFacts } => {
      const again = this.inspectInvocation(invocationId);
      if (!again.next.permitted) return this.refuse(again, options);
      const invocation = again.invocation;
      const manifest = this.stores.invocations.getManifest(invocation.id);
      const worktrees = grantsWriteCapability(manifest.content) ? 1 : 0;
      const refusal = this.governor.check({ runId: invocation.runId, provider: this.provider.provider, worktrees });
      if (refusal) return { kind: "capacity_refused", refusal, invocation };
      const resumedFrom = continuation !== null && again.resumeCandidateAttemptId === candidate ? candidate : null;
      const attempt = this.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: resumedFrom ? "resumed" : "fresh", resumedFromAttemptId: resumedFrom }, options);
      const caused: WriteOptions = { ...options, causationSeq: this.ctx.journal.lastSeq() };
      const grant = this.governor.tryAcquire({ runId: invocation.runId, attemptId: attempt.id, provider: this.provider.provider, worktrees }, caused);
      if (!grant.granted) throw new ConflictError(`the governor refused a lease it had just offered (${grant.refusal.reason})`);
      const started = this.stores.invocations.transitionAttempt(attempt.id, { to: "running", capacityLeaseId: grant.lease.id }, caused);
      const running = invocation.status === "pending" ? this.stores.invocations.transition(invocation.id, { to: "running" }, caused) : invocation;
      // One Invocation-wide deadline from the persisted start and the immutable manifest limit; every Attempt shares it (execution-model §7.6).
      const deadlineAt = invocationDeadlineAt(running.startedAt, manifest.content.maxWallClockMs);
      return { kind: "committed", facts: { attempt: started, lease: grant.lease, invocation: running, deadlineAt, continuation: resumedFrom ? continuation : null } };
    });
    if (committed.kind !== "committed") return committed;
    const { facts } = committed;
    this.#inFlight.set(facts.attempt.id, {
      attemptId: facts.attempt.id,
      invocationId: facts.invocation.id,
      runId: facts.invocation.runId,
      controller: new AbortController(),
      deadlineAt: facts.deadlineAt,
      runtimeInterruption: null,
      continuation: facts.continuation,
      outcome: null,
      changeset: null,
      continuationStored: false,
      executing: null,
    });
    return { kind: "prepared", attempt: facts.attempt, lease: facts.lease, invocation: facts.invocation };
  }

  private refuse(inspection: InvocationInspection, options: WriteOptions): PrepareOutcome {
    if (!inspection.next.permitted && inspection.next.reason === "decision_requested") {
      // The committed request is canonical: the Invocation converges to `blocked` on its Decision, its Tasks with it, without a provider call.
      const blocked = this.ctx.tx.write(() => {
        const current = this.stores.invocations.get(inspection.invocation.id);
        if (INVOCATION_MACHINE.isTerminal(current.status)) return current;
        const request = blockingRequestOf(this.stores, current);
        if (request === null || request.result.tool !== "request_decision") throw new ConflictError(`Invocation ${current.id} holds no accepted request_decision`);
        const invocation = this.stores.invocations.transition(current.id, { to: "blocked", decisionId: request.result.decisionId }, options);
        for (const taskId of invocation.taskIds) {
          if (this.stores.tasks.get(taskId).status === "running") this.stores.tasks.transition(taskId, { to: "blocked", blockReason: { kind: "decision", decisionId: request.result.decisionId } }, options);
        }
        return invocation;
      });
      this.cleanup.release(blocked.id, options);
      return { kind: "not_permitted", reason: "decision_requested", invocation: blocked, notBefore: null };
    }
    if (!inspection.next.permitted && inspection.next.reason === "allocation_exhausted") {
      const failed = this.ctx.tx.write(() => {
        const current = this.stores.invocations.get(inspection.invocation.id);
        if (INVOCATION_MACHINE.isTerminal(current.status)) return current;
        const invocation = this.stores.invocations.transition(current.id, { to: "failed", failureReason: "allocation_exhausted", result: null }, options);
        for (const taskId of invocation.taskIds) {
          if (this.stores.tasks.get(taskId).status === "running") this.stores.tasks.transition(taskId, { to: "failed", failureReason: "allocation_exhausted" }, options);
        }
        return invocation;
      });
      // Settlement has committed; the worktree release is the external step that follows and recovery retries.
      this.cleanup.release(failed.id, options);
      return { kind: "not_permitted", reason: "allocation_exhausted", invocation: failed, notBefore: null };
    }
    if (inspection.next.permitted) throw new Error("unreachable: refuse called for a permitted Attempt");
    return { kind: "not_permitted", reason: inspection.next.reason, invocation: inspection.invocation, notBefore: inspection.next.notBefore };
  }

  // ---------------------------------------------------------------------------
  // Execute
  // ---------------------------------------------------------------------------

  /**
   * Runs a prepared Attempt to its terminal state: the provider call outside
   * any transaction, then finalization. Calling it again for an Attempt that
   * is already executing returns the same outcome; calling it for one whose
   * finalization failed retries finalization without repeating the provider
   * call.
   */
  executePreparedAttempt(attemptId: AttemptId, options: WriteOptions = {}): Promise<ExecutionOutcome> {
    const flight = this.#inFlight.get(attemptId);
    if (!flight) {
      const attempt = this.stores.invocations.getAttempt(attemptId);
      if (ATTEMPT_MACHINE.isTerminal(attempt.status)) {
        // Already finalized: report the persisted outcome without repeating anything.
        const invocation = this.stores.invocations.get(attempt.invocationId);
        const settlement: Settlement = attempt.retryDecision?.permitted && !INVOCATION_MACHINE.isTerminal(invocation.status) ? { kind: "retry_pending", invocation, decision: attempt.retryDecision } : { kind: "settled", invocation };
        return Promise.resolve({ kind: "finalized", attempt, settlement });
      }
      throw new ConflictError(`Attempt ${attemptId} (${attempt.status}) was not prepared by this process; a restarted process recovers it instead`);
    }
    if (flight.executing === null) {
      flight.executing = this.run(flight, options).finally(() => {
        flight.executing = null;
      });
    }
    return flight.executing;
  }

  private async run(flight: InFlight, options: WriteOptions): Promise<ExecutionOutcome> {
    if (flight.outcome === null) flight.outcome = await this.dispatch(flight, options);
    const invocation = this.stores.invocations.get(flight.invocationId);
    const workspace = this.cleanup.workspaceOf(invocation);
    // An interrupted Attempt's worktree state is never collected: a late success creates no Changeset (execution-model §14).
    const interrupted = flight.runtimeInterruption !== null || runExecutionInterruptionOf(this.stores.runs.get(invocation.runId)) !== null;
    if (!interrupted && workspace.request.writes && flight.outcome.completion.kind === "completed" && flight.changeset === null) {
      flight.changeset = await this.workspace.collectChangeset(workspace.request, workspace.prepared);
    }
    if (flight.outcome.continuation !== null && this.provider.supportsContinuation && !flight.continuationStored) {
      await this.continuations.store(flight.attemptId, this.provider.provider, flight.outcome.continuation);
      flight.continuationStored = true;
    }
    return this.finalize(flight, options);
  }

  /**
   * The dispatch boundary: a prepared Attempt reaches the provider only while
   * the Run still admits work and nothing interrupted it meanwhile; otherwise
   * it ends interrupted here — no provider call, no Usage — with the cause the
   * Run row implies (`cancelled` for an ended Run, `operator_pause` for a
   * paused one), and finalization records it like any other interruption.
   */
  private async dispatch(flight: InFlight, options: WriteOptions): Promise<AttemptExecutionOutcome> {
    const run = this.stores.runs.get(flight.runId);
    if (flight.runtimeInterruption === null && runAdmitsNewWork(run)) return this.callProvider(flight, options);
    const cause = flight.runtimeInterruption ?? (RUN_MACHINE.isTerminal(run.status) ? "cancelled" : "operator_pause");
    flight.runtimeInterruption = cause;
    if (!flight.controller.signal.aborted) flight.controller.abort(cause);
    const now = this.ctx.clock();
    return { completion: { kind: "interrupted", cause, message: `not dispatched: ${cause}` }, result: null, usage: [], transcript: null, continuation: null, timing: { startedAt: now, endedAt: now, providerMs: null }, diagnostics: { dispatched: "false" } };
  }

  private async callProvider(flight: InFlight, options: WriteOptions): Promise<AttemptExecutionOutcome> {
    const invocation = this.stores.invocations.get(flight.invocationId);
    const manifest = this.stores.invocations.getManifest(invocation.id);
    const attempt = this.stores.invocations.getAttempt(flight.attemptId);
    const attempts = this.stores.invocations.listAttempts(invocation.id);
    const prior = attempt.number > 1 ? (attempts[attempt.number - 2] ?? null) : null;
    const appendix: RetryAppendix | null =
      prior && prior.failureClass !== null && prior.failureDetail !== null
        ? { priorAttemptId: prior.id, attemptNumber: attempt.number, maxAttempts: invocation.allocation.attempts, failureClass: prior.failureClass, detail: prior.failureDetail }
        : null;
    const request: AttemptExecutionRequest = {
      attemptId: attempt.id,
      invocationId: invocation.id,
      runId: invocation.runId,
      model: manifest.content.modelPolicy.model,
      effort: manifest.content.modelPolicy.effort,
      input: renderManifest(manifest, appendix),
      capabilities: manifest.content.capabilities,
      toolPolicy: manifest.content.toolPolicy,
      // The authorization port is bound here, from canonical rows, to exactly this Attempt; the adapter chooses no id.
      authorization: new ToolCallAuthorizer(
        this.ctx,
        this.stores,
        { runId: invocation.runId, planNodeId: invocation.planNodeId, invocationId: invocation.id, attemptId: attempt.id, toolPolicy: manifest.content.toolPolicy, approvedCalls: manifest.content.approvedCalls },
        options,
        this.diagnostics,
      ),
      // The runtime-tool port is bound here too: the effective callable set and nothing of persistence reaches the adapter.
      runtimeTools: new RuntimeToolExecutor(
        this.ctx,
        this.stores,
        { runId: invocation.runId, planNodeId: invocation.planNodeId, invocationId: invocation.id, attemptId: attempt.id, role: invocation.role, purpose: invocation.purpose, manifestTools: manifest.content.runtimeTools },
        options,
        this.diagnostics,
      ),
      workingDirectory: manifest.content.worktreePath,
      deadlineAt: flight.deadlineAt,
      signal: flight.controller.signal,
      continuation: flight.continuation,
      output: this.output,
    };
    const startedAt = this.ctx.clock();
    try {
      return await this.provider.execute(request);
    } catch (error) {
      // An adapter that throws is an infrastructure fault: a transient provider error with a bounded, sanitized message.
      const message = boundedFailureMessage(error instanceof Error ? error.message : String(error));
      return { completion: { kind: "provider_error", transient: true, message }, result: null, usage: [], transcript: null, continuation: null, timing: { startedAt, endedAt: this.ctx.clock(), providerMs: null }, diagnostics: { adapterThrew: "true" } };
    }
  }

  // ---------------------------------------------------------------------------
  // Finalize
  // ---------------------------------------------------------------------------

  private finalize(flight: InFlight, options: WriteOptions): ExecutionOutcome {
    const outcome = flight.outcome;
    if (!outcome) throw new Error("finalize before the provider returned");
    const result = this.ctx.tx.write((): ExecutionOutcome => {
      const attempt = this.stores.invocations.getAttempt(flight.attemptId);
      if (ATTEMPT_MACHINE.isTerminal(attempt.status)) {
        // Already finalized (a repeated call after success); report the persisted outcome.
        const invocation = this.stores.invocations.get(flight.invocationId);
        return { kind: "finalized", attempt, settlement: { kind: "settled", invocation } };
      }
      const invocation = this.stores.invocations.get(flight.invocationId);
      const manifest = this.stores.invocations.getManifest(invocation.id);
      const run = this.stores.runs.get(invocation.runId);
      const writes = grantsWriteCapability(manifest.content);
      const meta: WriteOptions = { ...options };
      // The Run row decides late (execution-model §14): a cancellation or hard pause committed while the provider ran interrupts the
      // Attempt from rows — whatever the provider reported, and even when the abort signal reached nothing. A soft pause changes nothing.
      const interruption: RuntimeInterruption = flight.runtimeInterruption ?? runExecutionInterruptionOf(run);

      // 1. The diagnostic transcript Artifact; nothing below reads it.
      const transcriptArtifactId =
        outcome.transcript === null
          ? null
          : this.stores.artifacts.create({ runId: run.id, mediaType: TRANSCRIPT_MEDIA_TYPE, producer: { kind: "runtime", component: "transcript" }, taskId: null, title: `transcript ${attempt.id}` }, outcome.transcript, meta).id;
      // 2. The continuation index row was written before this transaction (it is not canonical); nothing to do here.
      // 3. Every Usage row, before the Invocation can become terminal.
      for (const chunk of outcome.usage) this.stores.usage.record({ attemptId: attempt.id, ...chunk }, meta);
      // 4. Result validation (only a completed provider execution has a candidate).
      const validation: ResultValidation =
        outcome.completion.kind === "completed" ? this.validator.validate(outcome.result, { run, invocation, manifest, writes, changeset: flight.changeset }) : { ok: false, violations: [] };
      // An intercepted call is canonicalized once, by the same contract the authorization port applied; a malformed or
      // over-bound call is a tool failure, never a truncated approval subject.
      const proposed = outcome.completion.kind === "approval_required" ? canonicalizeToolCall(outcome.completion.call) : null;
      const completion: ProviderCompletion =
        outcome.completion.kind === "approval_required" && proposed !== null && proposed.kind === "invalid"
          ? { kind: "tool_failure", tool: proposed.tool ?? outcome.completion.call.tool, message: proposed.message }
          : outcome.completion;
      const consumed = this.stores.usage.consumedByInvocation(invocation.id);
      // A blocking request the Invocation durably committed decides the Attempt's end, whatever the provider reported afterwards.
      const blocking = blockingRequestOf(this.stores, invocation);
      const requestedDecisionId = blocking !== null && blocking.result.tool === "request_decision" ? blocking.result.decisionId : null;
      const classified =
        requestedDecisionId !== null
          ? { status: "failed" as const, failureClass: "decision_requested" as const, detail: { message: boundedFailureMessage(`Decision ${requestedDecisionId} requested; the logical turn ended`), violations: [], tool: null, cancelled: false }, result: null }
          : classifyAttempt({ completion, validation, runtimeInterruption: interruption, consumed, allocation: invocation.allocation });
      const previous = attempt.number > 1 ? this.stores.invocations.listAttempts(invocation.id)[attempt.number - 2] : undefined;
      const approvalRequired = requestedDecisionId === null && completion.kind === "approval_required" && interruption === null;
      const decision = decideRetry({
        classified,
        attemptNumber: attempt.number,
        maxAttempts: invocation.allocation.attempts,
        previousFailureClass: previous?.failureClass ?? null,
        approvalRequired,
        decisionRequested: requestedDecisionId !== null,
        deadlineAt: invocationDeadlineAt(invocation.startedAt, manifest.content.maxWallClockMs),
        now: this.ctx.clock(),
        config: this.config.retry,
      });
      // The writing Invocation's Changeset, recorded with its after Snapshot and diff Artifact once the result is known valid.
      if (classified.status === "succeeded" && writes && flight.changeset !== null) this.recordChangeset(run, invocation, manifest, flight.changeset, meta);
      // 5. The Attempt's terminal transition with its bounded detail and durable retry decision.
      const terminal = this.stores.invocations.transitionAttempt(
        attempt.id,
        classified.status === "succeeded"
          ? { to: "succeeded", result: classified.result!, transcriptArtifactId }
          : classified.status === "failed"
            ? { to: "failed", failureClass: classified.failureClass as Exclude<NonNullable<Attempt["failureClass"]>, "interrupted">, transcriptArtifactId, failureDetail: classified.detail, retryDecision: decision }
            : { to: classified.status, transcriptArtifactId, failureDetail: classified.detail, retryDecision: decision },
        meta,
      );
      // 6. The capacity lease is released exactly once on every terminal path.
      if (terminal.capacityLeaseId !== null) this.governor.release(terminal.capacityLeaseId, meta);
      // 7. An intercepted call becomes canonical in the same transaction: the call Artifact (its bytes live only there,
      //    compensated on rollback like every blob) and the open side_effect_approval Decision whose subject names the
      //    tool, the canonical digest, the Artifact, and the originating Run, Plan Node, Invocation, and Attempt.
      const approvalDecision = approvalRequired && proposed !== null && proposed.kind === "ok" && completion.kind === "approval_required" ? this.recordApproval(run, invocation, terminal, proposed.call.tool, proposed.bytes, meta) : null;
      // 8–10. Retry eligibility is the decision above; the Invocation ends only when no retry remains (releasing its reservation), and its Tasks follow.
      const blockedOn = requestedDecisionId !== null ? { decisionId: requestedDecisionId } : approvalDecision ? { decisionId: approvalDecision.id } : null;
      const settlement = settleInvocation(this.stores, { invocation, attempt: terminal, decision, result: classified.result, blocked: blockedOn, meta });
      // The last executing Attempt of a cancelled Run has ended: the nodes, Tasks, and Handoffs it held back converge in the same transaction.
      if (run.status === "cancelled") settleCancelledRunWork(this.stores, run.id, meta);
      if (requestedDecisionId !== null) return { kind: "decision_requested", attempt: terminal, settlement, decision: this.stores.decisions.get(requestedDecisionId) };
      if (approvalDecision) return { kind: "approval_required", attempt: terminal, settlement, decision: approvalDecision };
      return { kind: "finalized", attempt: terminal, settlement };
    });
    this.#inFlight.delete(flight.attemptId);
    // Canonical settlement has committed. The destructive worktree release follows outside any transaction and is
    // recorded only once it succeeded; a failure or crash here leaves a pending obligation that recovery retries.
    if (INVOCATION_MACHINE.isTerminal(result.settlement.invocation.status)) this.cleanup.release(result.settlement.invocation.id, options);
    return result;
  }

  /** Retries the Invocation's outstanding worktree release (external, idempotent); `not_due` for a non-terminal or read-only Invocation. */
  releaseWorkspace(invocationId: InvocationId, options: WriteOptions = {}): WorkspaceReleaseOutcome {
    return this.cleanup.release(invocationId, options);
  }

  /** The call Artifact and the open `side_effect_approval` Decision, both in the finalization transaction. */
  private recordApproval(run: Run, invocation: Invocation, attempt: Attempt, tool: string, bytes: Uint8Array, meta: WriteOptions): Decision {
    const artifact = this.stores.artifacts.create(
      { runId: run.id, mediaType: TOOL_CALL_MEDIA_TYPE, producer: { kind: "runtime", component: "tool_call" }, taskId: null, title: `proposed ${tool} call of ${attempt.id}` },
      bytes,
      meta,
    );
    return this.stores.decisions.request(
      {
        conversationId: run.conversationId,
        runId: run.id,
        kind: "side_effect_approval",
        resolutionPolicy: "operator_required",
        requestedBy: { kind: "invocation", invocationId: invocation.id },
        question: `Approve this ${tool} call once?`,
        options: [
          { id: "approve_once", label: "Approve once", description: "Permit exactly this call, once; the Tool Policy is unchanged." },
          { id: "deny", label: "Deny", description: "Refuse the call; the successor Invocation continues without it." },
        ],
        recommendedOptionId: null,
        rationale: null,
        affects: { requirementIds: [], taskIds: invocation.taskIds, planNodeIds: [invocation.planNodeId] },
        deadlineAt: null,
        activationCondition: null,
        subject: { kind: "side_effect_approval", tool, callDigest: artifact.digest, callArtifactId: artifact.id, runId: run.id, planNodeId: invocation.planNodeId, invocationId: invocation.id, attemptId: attempt.id },
        supersedesDecisionId: null,
      },
      meta,
    );
  }

  private recordChangeset(run: { id: Invocation["runId"]; workspaceId: string }, invocation: Invocation, manifest: ContextManifest, changeset: CollectedChangeset, meta: WriteOptions): void {
    const before = manifest.content.startingSnapshotId;
    if (before === null) throw new Error(`writing Invocation ${invocation.id} has no starting Snapshot`);
    const after = this.stores.snapshots.record({ workspaceId: run.workspaceId as never, runId: run.id, identity: changeset.afterSnapshot, reason: "after_invocation" }, meta);
    const diff = this.stores.artifacts.create(
      { runId: run.id, mediaType: CHANGESET_DIFF_MEDIA_TYPE, producer: { kind: "runtime", component: "changeset" }, taskId: null, title: changeset.empty ? `empty changeset of ${invocation.id}` : `changeset of ${invocation.id}` },
      changeset.diff,
      meta,
    );
    this.stores.changesets.record({ runId: run.id, invocationId: invocation.id, beforeSnapshotId: before, afterSnapshotId: after.id, diffArtifactId: diff.id }, meta);
  }

  // ---------------------------------------------------------------------------
  // Advance, interrupt, deadlines
  // ---------------------------------------------------------------------------

  /** Prepares and executes the next Attempt when permitted; reports an in-flight Attempt, a refusal, or a terminal Invocation otherwise. Idempotent. */
  async advanceInvocation(invocationId: InvocationId, options: WriteOptions = {}): Promise<AdvanceOutcome> {
    const flight = [...this.#inFlight.values()].find((f) => f.invocationId === invocationId);
    if (flight) {
      if (flight.outcome !== null && flight.executing === null) return this.executePreparedAttempt(flight.attemptId, options);
      return { kind: "in_flight", attemptId: flight.attemptId, invocation: this.stores.invocations.get(invocationId) };
    }
    const prepared = await this.prepareNextAttempt(invocationId, options);
    if (prepared.kind !== "prepared") return prepared;
    return this.executePreparedAttempt(prepared.attempt.id, options);
  }

  /**
   * Aborts an in-flight Attempt: `cancelled` forbids a retry; `operator_pause`
   * (a hard pause) is retried once the Run resumes; `deadline` is the
   * wall-clock interruption. Returns false when nothing is in flight or the
   * Attempt was already aborted or has already returned — an interruption is
   * delivered at most once and never rewritten.
   */
  interrupt(attemptId: AttemptId, cause: Exclude<RuntimeInterruption, null>): boolean {
    const flight = this.#inFlight.get(attemptId);
    if (!flight || flight.outcome !== null || flight.controller.signal.aborted) return false;
    flight.runtimeInterruption = cause;
    flight.controller.abort(cause);
    return true;
  }

  /**
   * Delivers one interruption to every Attempt of the Run executing in this
   * process (execution-model §14); returns the Attempts it aborted now.
   * Delivery only: the accepted intent is the committed Run row, which
   * finalization revalidates whether or not the signal reached the provider.
   */
  interruptRun(runId: RunId, cause: "cancelled" | "operator_pause"): AttemptId[] {
    return this.inFlightOf(runId).filter((attemptId) => this.interrupt(attemptId, cause));
  }

  /** Interrupts every in-flight Attempt whose deadline has passed at `now`; driven by the caller's clock, never by a timer. */
  enforceDeadlines(now: Timestamp = this.ctx.clock()): AttemptId[] {
    const expired: AttemptId[] = [];
    for (const flight of this.#inFlight.values()) {
      if (flight.deadlineAt !== null && flight.deadlineAt <= now && this.interrupt(flight.attemptId, "deadline")) expired.push(flight.attemptId);
    }
    return expired.sort();
  }
}
