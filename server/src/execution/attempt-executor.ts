/**
 * Durable Attempt execution (execution-model §6.5, §6.6, §7.2, §7.8, §12,
 * §14). Three short canonical transaction boundaries surround one provider
 * call that never runs inside a transaction:
 *
 *   prepare   verify the Invocation and its immutable manifest, the
 *             remaining Attempt, cost, token, and wall-clock allocation, and
 *             the durable retry decision of the previous Attempt; select a
 *             fresh or resumed start; obtain a capacity lease; create the
 *             Attempt (`initial` or `retry`) and start it — or refuse
 *             without creating anything.
 *   execute   render the persisted manifest (plus the bounded retry
 *             appendix), call the provider with cancellation and deadline,
 *             stream transient output, collect the writing Invocation's
 *             Changeset through the execution-workspace port, store the
 *             continuation payload.
 *   finalize  transcript Artifact; every Usage row; Changeset; result
 *             validation; the Attempt's terminal transition with its bounded
 *             failure detail and durable retry decision; lease release;
 *             Invocation settlement (terminal only when no retry remains,
 *             which releases its reservation) and Task transitions.
 *
 * Every operation is safe to call repeatedly: a finalized Attempt is never
 * finalized twice, a refusal creates nothing, and an in-flight Attempt is
 * reported rather than duplicated. Nothing here reads a transcript.
 */
import {
  ATTEMPT_MACHINE,
  boundedFailureMessage,
  ConflictError,
  grantsWriteCapability,
  INVOCATION_MACHINE,
  TRANSCRIPT_MEDIA_TYPE,
  type Attempt,
  type AttemptId,
  type CapacityLease,
  type CapacityRefusal,
  type ContextManifest,
  type Invocation,
  type InvocationId,
  type RetryDecision,
  type Timestamp,
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import type { AttemptExecutionOutcome, AttemptExecutionRequest, ProviderAdapter, TransientOutputSink } from "../provider/adapter.ts";
import type { ContinuationService } from "../provider/continuation.ts";
import { continuationCandidate, type ContinuationPolicyConfig } from "./continuation-policy.ts";
import type { ResourceGovernor } from "./governor.ts";
import { settleInvocation, type Settlement } from "./invocation-lifecycle.ts";
import { renderManifest, type RetryAppendix } from "./manifest/renderer.ts";
import type { CollectedChangeset, ExecutionWorkspacePort, ExecutionWorkspaceRequest, PreparedExecutionWorkspace } from "./ports/execution-workspace.ts";
import { InvocationResultValidator, type ResultValidation } from "./result-validator.ts";
import { classifyAttempt, decideRetry, DEFAULT_RETRY_POLICY, type RetryPolicyConfig, type RuntimeInterruption } from "./retry-policy.ts";

export interface AttemptExecutorConfig {
  retry: RetryPolicyConfig;
  continuation: ContinuationPolicyConfig;
}

export const DEFAULT_EXECUTOR_CONFIG: Readonly<AttemptExecutorConfig> = Object.freeze({
  retry: DEFAULT_RETRY_POLICY,
  continuation: { contextWindowTokens: 200_000 },
});

export type NotPermittedReason = "invocation_terminal" | "invocation_waiting" | "attempt_active" | "retry_refused" | "retry_not_yet" | "allocation_exhausted";

export type PrepareOutcome =
  | { kind: "prepared"; attempt: Attempt; lease: CapacityLease; invocation: Invocation }
  | { kind: "capacity_refused"; refusal: CapacityRefusal; invocation: Invocation }
  | { kind: "not_permitted"; reason: NotPermittedReason; invocation: Invocation; notBefore: Timestamp | null };

export type ExecutionOutcome =
  | { kind: "finalized"; attempt: Attempt; settlement: Settlement }
  | { kind: "approval_required"; attempt: Attempt; settlement: Settlement; tool: string; call: string };

export type AdvanceOutcome = PrepareOutcome | ExecutionOutcome | { kind: "in_flight"; attemptId: AttemptId; invocation: Invocation };

/** Everything the runtime can say about an Invocation's next Attempt from canonical state alone. */
export interface InvocationInspection {
  invocation: Invocation;
  attempts: Attempt[];
  latestAttempt: Attempt | null;
  attemptsRemaining: number;
  /** Whether another Attempt may be created now, or why not; `retry_not_yet` carries the earliest time. */
  next: { permitted: true } | { permitted: false; reason: NotPermittedReason; notBefore: Timestamp | null };
  /** The Attempt whose provider execution the next Attempt may continue from, when every canonical check passes. */
  resumeCandidateAttemptId: AttemptId | null;
  previousFailure: { attemptId: AttemptId; failureClass: Attempt["failureClass"]; detail: Attempt["failureDetail"]; decision: RetryDecision | null } | null;
}

interface InFlight {
  attemptId: AttemptId;
  invocationId: InvocationId;
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

  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
    private readonly provider: ProviderAdapter,
    private readonly continuations: ContinuationService,
    private readonly governor: ResourceGovernor,
    private readonly workspace: ExecutionWorkspacePort,
    private readonly config: AttemptExecutorConfig = DEFAULT_EXECUTOR_CONFIG,
    private readonly output: TransientOutputSink = () => {},
  ) {
    this.validator = new InvocationResultValidator(stores);
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
    const next = this.nextPermission(invocation, manifest, attempts, now);
    const resumeCandidateAttemptId =
      next.permitted && manifest !== null ? (continuationCandidate(this.stores, this.continuations, this.provider, this.config.continuation, invocation, manifest, now)?.attemptId ?? null) : null;
    return { invocation, attempts, latestAttempt: latest, attemptsRemaining: Math.max(0, invocation.allocation.attempts - attempts.length), next, resumeCandidateAttemptId, previousFailure };
  }

  /** The Attempts this process is executing, in Attempt id order. */
  inFlight(): AttemptId[] {
    return [...this.#inFlight.keys()].sort();
  }

  private manifestOf(invocation: Invocation): ContextManifest | null {
    try {
      return this.stores.invocations.getManifest(invocation.id);
    } catch {
      return null;
    }
  }

  private nextPermission(invocation: Invocation, manifest: ContextManifest | null, attempts: Attempt[], now: Timestamp): InvocationInspection["next"] {
    if (INVOCATION_MACHINE.isTerminal(invocation.status)) return { permitted: false, reason: "invocation_terminal", notBefore: null };
    if (invocation.status === "waiting") return { permitted: false, reason: "invocation_waiting", notBefore: null };
    if (manifest === null) return { permitted: false, reason: "invocation_terminal", notBefore: null };
    if (attempts.some((a) => !ATTEMPT_MACHINE.isTerminal(a.status))) return { permitted: false, reason: "attempt_active", notBefore: null };
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
    return this.ctx.tx.write((): PrepareOutcome => {
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
      // The wall-clock limit bounds each Attempt from its start; reaching it interrupts the Attempt (execution-model §7.6).
      const limit = manifest.content.maxWallClockMs;
      const now = started.startedAt ?? this.ctx.clock();
      this.#inFlight.set(attempt.id, {
        attemptId: attempt.id,
        invocationId: invocation.id,
        controller: new AbortController(),
        deadlineAt: limit === null ? null : new Date(Date.parse(now) + limit).toISOString(),
        runtimeInterruption: null,
        continuation: resumedFrom ? continuation : null,
        outcome: null,
        changeset: null,
        continuationStored: false,
        executing: null,
      });
      return { kind: "prepared", attempt: started, lease: grant.lease, invocation: running };
    });
  }

  private refuse(inspection: InvocationInspection, options: WriteOptions): PrepareOutcome {
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
      this.releaseWorkspace(failed);
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
    if (flight.outcome === null) flight.outcome = await this.callProvider(flight);
    const invocation = this.stores.invocations.get(flight.invocationId);
    const manifest = this.stores.invocations.getManifest(invocation.id);
    const workspace = this.workspaceOf(invocation, manifest);
    if (workspace.request.writes && flight.outcome.completion.kind === "completed" && flight.changeset === null) {
      flight.changeset = await this.workspace.collectChangeset(workspace.request, workspace.prepared);
    }
    if (flight.outcome.continuation !== null && this.provider.supportsContinuation && !flight.continuationStored) {
      await this.continuations.store(flight.attemptId, this.provider.provider, flight.outcome.continuation);
      flight.continuationStored = true;
    }
    return this.finalize(flight, options);
  }

  private async callProvider(flight: InFlight): Promise<AttemptExecutionOutcome> {
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

  /** Reconstructs the execution-workspace facts from the manifest, never from memory. */
  private workspaceOf(invocation: Invocation, manifest: ContextManifest): { request: ExecutionWorkspaceRequest; prepared: PreparedExecutionWorkspace } {
    const run = this.stores.runs.get(invocation.runId);
    const writes = grantsWriteCapability(manifest.content);
    const startingSnapshot = writes && manifest.content.startingSnapshotId !== null ? this.stores.snapshots.get(manifest.content.startingSnapshotId).identity : null;
    return {
      request: { runId: run.id, invocationId: invocation.id, role: invocation.role, writes, integrationWorkspacePath: run.integrationWorkspacePath },
      prepared: { worktreePath: manifest.content.worktreePath, startingSnapshot },
    };
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
      const consumed = this.stores.usage.consumedByInvocation(invocation.id);
      const classified = classifyAttempt({ completion: outcome.completion, validation, runtimeInterruption: flight.runtimeInterruption, consumed, allocation: invocation.allocation });
      const previous = attempt.number > 1 ? this.stores.invocations.listAttempts(invocation.id)[attempt.number - 2] : undefined;
      const approvalRequired = outcome.completion.kind === "approval_required" && flight.runtimeInterruption === null;
      const decision = decideRetry({
        classified,
        attemptNumber: attempt.number,
        maxAttempts: invocation.allocation.attempts,
        previousFailureClass: previous?.failureClass ?? null,
        approvalRequired,
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
      // 7–10. Retry eligibility is the decision above; the Invocation ends only when no retry remains (releasing its reservation), and its Tasks follow.
      const settlement = settleInvocation(this.stores, { invocation, attempt: terminal, decision, result: classified.result, approvalRequired, meta });
      if (outcome.completion.kind === "approval_required" && approvalRequired) {
        return { kind: "approval_required", attempt: terminal, settlement, tool: outcome.completion.tool, call: outcome.completion.call };
      }
      return { kind: "finalized", attempt: terminal, settlement };
    });
    this.#inFlight.delete(flight.attemptId);
    if (INVOCATION_MACHINE.isTerminal(result.settlement.invocation.status)) this.releaseWorkspace(result.settlement.invocation);
    return result;
  }

  private recordChangeset(run: { id: Invocation["runId"]; workspaceId: string }, invocation: Invocation, manifest: ContextManifest, changeset: CollectedChangeset, meta: WriteOptions): void {
    const before = manifest.content.startingSnapshotId;
    if (before === null) throw new Error(`writing Invocation ${invocation.id} has no starting Snapshot`);
    const after = this.stores.snapshots.record({ workspaceId: run.workspaceId as never, runId: run.id, identity: changeset.afterSnapshot, reason: "after_invocation" }, meta);
    const diff = this.stores.artifacts.create(
      { runId: run.id, mediaType: "text/x-diff", producer: { kind: "runtime", component: "changeset" }, taskId: null, title: changeset.empty ? `empty changeset of ${invocation.id}` : `changeset of ${invocation.id}` },
      changeset.diff,
      meta,
    );
    this.stores.changesets.record({ runId: run.id, invocationId: invocation.id, beforeSnapshotId: before, afterSnapshotId: after.id, diffArtifactId: diff.id }, meta);
  }

  private releaseWorkspace(invocation: Invocation): void {
    const manifest = this.manifestOf(invocation);
    if (!manifest) return;
    const workspace = this.workspaceOf(invocation, manifest);
    this.workspace.release(workspace.request, workspace.prepared);
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

  /** Aborts an in-flight Attempt: `cancelled` forbids a retry; `deadline` is the wall-clock interruption. Returns false when nothing is in flight. */
  interrupt(attemptId: AttemptId, cause: Exclude<RuntimeInterruption, null>): boolean {
    const flight = this.#inFlight.get(attemptId);
    if (!flight || flight.outcome !== null || flight.controller.signal.aborted) return false;
    flight.runtimeInterruption = cause;
    flight.controller.abort(cause);
    return true;
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
