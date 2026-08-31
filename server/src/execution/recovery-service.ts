/**
 * Restart recovery (execution-model §14 "Server restart"): every Attempt the
 * previous process left `pending` or `running` is marked `interrupted` with
 * its consumed Attempt preserved, its stale lease is released, its
 * Invocation is failed with `allocation_exhausted` when no Attempt remains
 * or left with durable retry eligibility otherwise (resumed only if the
 * continuation checks pass, fresh when the payload is absent or invalid),
 * and the governor is rebuilt from canonical lease state. An Invocation
 * whose Attempt had durably requested a blocking Decision (execution-model
 * §8.2) converges to `blocked` on that Decision — no retry, no further
 * provider call — from the accepted request row alone. Nothing here reads
 * a transcript or a provider message, and nothing executes: recoverable
 * work is returned for an explicit execution call.
 *
 * Recovery is idempotent: a second run finds no non-terminal Attempt and no
 * active lease, and writes nothing.
 */
import { invocationDeadlineAt, type AttemptId, type CapacityLeaseId, type InvocationId, type Timestamp } from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import type { ProviderAdapter } from "../provider/adapter.ts";
import type { ContinuationService } from "../provider/continuation.ts";
import { continuationCandidate, type ContinuationPolicyConfig } from "./continuation-policy.ts";
import { blockingRequestOf } from "./decision-requests.ts";
import type { ResourceGovernor } from "./governor.ts";
import { settleInvocation } from "./invocation-lifecycle.ts";
import { decideRetry, type RetryPolicyConfig } from "./retry-policy.ts";
import type { WorkspaceCleanup } from "./workspace-cleanup.ts";

export interface RecoveryConfig {
  retry: RetryPolicyConfig;
  continuation: ContinuationPolicyConfig;
}

export interface RecoveryReport {
  interruptedAttemptIds: AttemptId[];
  releasedLeaseIds: CapacityLeaseId[];
  failedInvocationIds: InvocationId[];
  /** Invocations that may create another Attempt, with the earliest time and the Attempt a resumed start may continue from. */
  retryEligible: { invocationId: InvocationId; notBefore: Timestamp | null; resumeCandidateAttemptId: AttemptId | null }[];
  /** Outstanding worktree cleanup obligations of terminal Invocations that this recovery released, and those whose release failed again. */
  workspaceReleasedInvocationIds: InvocationId[];
  workspaceReleaseFailedInvocationIds: InvocationId[];
}

export class RecoveryService {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
    private readonly governor: ResourceGovernor,
    private readonly continuations: ContinuationService,
    private readonly provider: Pick<ProviderAdapter, "provider" | "supportsContinuation">,
    private readonly cleanup: WorkspaceCleanup,
    private readonly config: RecoveryConfig,
  ) {}

  /**
   * The canonical reconciliation runs in one transaction; the external
   * worktree releases follow outside it, so a crash between the two leaves
   * only pending obligations that the next recovery retries.
   */
  recover(options: WriteOptions = {}): RecoveryReport {
    const report = this.reconcile(options);
    const releases = this.cleanup.releaseOutstanding(options);
    return { ...report, workspaceReleasedInvocationIds: releases.releasedInvocationIds, workspaceReleaseFailedInvocationIds: releases.failedInvocationIds };
  }

  private reconcile(options: WriteOptions): Omit<RecoveryReport, "workspaceReleasedInvocationIds" | "workspaceReleaseFailedInvocationIds"> {
    return this.ctx.tx.write(() => {
      const now = this.ctx.clock();
      const report: Omit<RecoveryReport, "workspaceReleasedInvocationIds" | "workspaceReleaseFailedInvocationIds"> = { interruptedAttemptIds: [], releasedLeaseIds: [], failedInvocationIds: [], retryEligible: [] };
      for (const attempt of this.stores.invocations.activeAttempts()) {
        const invocation = this.stores.invocations.get(attempt.invocationId);
        const manifest = this.stores.invocations.getManifest(invocation.id);
        const previous = attempt.number > 1 ? this.stores.invocations.listAttempts(invocation.id)[attempt.number - 2] : undefined;
        // A blocking Decision the Attempt durably requested ends the logical turn: the Invocation converges to `blocked`, never retried.
        const blocking = blockingRequestOf(this.stores, invocation);
        const blocked = blocking !== null && blocking.result.tool === "request_decision" ? { decisionId: blocking.result.decisionId } : null;
        const detail = { message: blocked === null ? "interrupted by a runtime restart" : `interrupted by a runtime restart after requesting Decision ${blocked.decisionId}`, violations: [], tool: null, cancelled: false };
        // The same Invocation-wide deadline the previous process enforced, derived from persisted facts alone.
        const decision = decideRetry({
          classified: { status: "interrupted", failureClass: "interrupted", detail, result: null },
          attemptNumber: attempt.number,
          maxAttempts: invocation.allocation.attempts,
          previousFailureClass: previous?.failureClass ?? null,
          approvalRequired: false,
          decisionRequested: blocked !== null,
          deadlineAt: invocationDeadlineAt(invocation.startedAt, manifest.content.maxWallClockMs),
          now,
          config: this.config.retry,
        });
        const interrupted = this.stores.invocations.transitionAttempt(attempt.id, { to: "interrupted", transcriptArtifactId: null, failureDetail: detail, retryDecision: decision }, options);
        report.interruptedAttemptIds.push(interrupted.id);
        if (interrupted.capacityLeaseId !== null) {
          const lease = this.stores.leases.get(interrupted.capacityLeaseId);
          if (lease.status === "active") report.releasedLeaseIds.push(this.governor.release(lease.id, options).id);
        }
        const settlement = settleInvocation(this.stores, { invocation, attempt: interrupted, decision, result: null, blocked, meta: options });
        if (settlement.kind === "settled") {
          if (settlement.invocation.status === "failed") report.failedInvocationIds.push(settlement.invocation.id);
          continue;
        }
        const candidate = continuationCandidate(this.stores, this.continuations, this.provider, this.config.continuation, invocation, manifest, now);
        report.retryEligible.push({ invocationId: invocation.id, notBefore: settlement.decision.notBefore, resumeCandidateAttemptId: candidate?.attemptId ?? null });
      }
      // Every lease still active belonged to the previous process; the governor forgets provider availability too.
      report.releasedLeaseIds.push(...this.governor.restoreAfterRestart(options).releasedLeaseIds);
      return report;
    });
  }
}
