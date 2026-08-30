/**
 * Failure classification and retry policy (execution-model §7.2, §14).
 * Classification is a pure function of the provider completion, the result
 * validation, what the runtime itself did (cancel, enforce a deadline), and
 * the Invocation's allocation. The retry decision is deterministic — an
 * injected clock, exponential backoff without randomness — and is persisted
 * on the terminal Attempt so a restart reads it back verbatim.
 */
import {
  allocationFits,
  boundedFailureMessage,
  boundResultViolations,
  retryBackoffMs,
  type Allocation,
  type AttemptFailureClass,
  type AttemptFailureDetail,
  type AttemptStatus,
  type InvocationResult,
  type ResultViolation,
  type RetryDecision,
  type Timestamp,
} from "@agentique-console/core";
import type { InterruptionCause, ProviderCompletion } from "../provider/adapter.ts";

export interface RetryPolicyConfig {
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicyConfig> = Object.freeze({ backoffBaseMs: 5_000, backoffMaxMs: 300_000 });

/** How the runtime ended the Attempt itself, if it did. */
export type RuntimeInterruption = Exclude<InterruptionCause, "provider"> | null;

export interface ClassificationInput {
  completion: ProviderCompletion;
  /** The validated result, or the violations that made the candidate invalid; ignored unless the provider completed. */
  validation: { ok: true; result: InvocationResult } | { ok: false; violations: ResultViolation[] };
  runtimeInterruption: RuntimeInterruption;
  /** The Invocation's complete consumption after this Attempt's Usage was recorded, against its allocation. */
  consumed: Allocation;
  allocation: Allocation;
}

export interface ClassifiedAttempt {
  status: Exclude<AttemptStatus, "pending" | "running">;
  failureClass: AttemptFailureClass | null;
  detail: AttemptFailureDetail | null;
  result: InvocationResult | null;
}

const detail = (message: string, extra: Partial<AttemptFailureDetail> = {}): AttemptFailureDetail => ({
  message: boundedFailureMessage(message),
  violations: [],
  tool: null,
  cancelled: false,
  ...extra,
});

/** Classifies one finished provider execution into the Attempt's terminal status, failure class, and bounded detail. */
export function classifyAttempt(input: ClassificationInput): ClassifiedAttempt {
  const { completion } = input;
  if (input.runtimeInterruption === "cancelled") {
    return { status: "cancelled", failureClass: null, detail: detail("cancelled by the runtime", { cancelled: true }), result: null };
  }
  if (input.runtimeInterruption === "deadline") {
    return { status: "timed_out", failureClass: "interrupted", detail: detail("wall-clock limit reached"), result: null };
  }
  const exhausted = !allocationFits(input.consumed, { ...input.allocation, attempts: Number.MAX_SAFE_INTEGER });
  switch (completion.kind) {
    case "completed":
      if (input.validation.ok) return { status: "succeeded", failureClass: null, detail: null, result: input.validation.result };
      if (exhausted) return { status: "failed", failureClass: "allocation_exhausted", detail: detail("result invalid and the cost or token allocation is exhausted", { violations: boundResultViolations(input.validation.violations) }), result: null };
      return {
        status: "failed",
        failureClass: "result_invalid",
        detail: detail(`result invalid: ${input.validation.violations.map((v) => v.code).join(", ")}`, { violations: boundResultViolations(input.validation.violations) }),
        result: null,
      };
    case "provider_error":
      if (!completion.transient) return { status: "failed", failureClass: "provider_permanent", detail: detail(completion.message), result: null };
      if (exhausted) return { status: "failed", failureClass: "allocation_exhausted", detail: detail(`${completion.message} (allocation exhausted)`), result: null };
      return { status: "failed", failureClass: "provider_transient", detail: detail(completion.message), result: null };
    case "tool_failure":
      if (exhausted) return { status: "failed", failureClass: "allocation_exhausted", detail: detail(completion.message, { tool: completion.tool }), result: null };
      return { status: "failed", failureClass: "tool_failure", detail: detail(completion.message, { tool: completion.tool }), result: null };
    case "approval_required":
      return { status: "failed", failureClass: "tool_failure", detail: detail(`tool ${completion.tool} requires operator approval: ${completion.call}`, { tool: completion.tool }), result: null };
    case "interrupted":
      if (completion.cause === "cancelled") return { status: "cancelled", failureClass: null, detail: detail(completion.message, { cancelled: true }), result: null };
      if (completion.cause === "deadline") return { status: "timed_out", failureClass: "interrupted", detail: detail(completion.message), result: null };
      if (exhausted) return { status: "failed", failureClass: "allocation_exhausted", detail: detail(`${completion.message} (allocation exhausted)`), result: null };
      return { status: "interrupted", failureClass: "interrupted", detail: detail(completion.message), result: null };
  }
}

export interface RetryDecisionInput {
  classified: ClassifiedAttempt;
  /** The number of this Attempt (from 1) and the Invocation's Attempt allocation. */
  attemptNumber: number;
  maxAttempts: number;
  /** The failure class of the previous Attempt, for the tool-failure-once rule. */
  previousFailureClass: AttemptFailureClass | null;
  /** True when the provider ended on an `approval_required` call, which no retry can resolve. */
  approvalRequired: boolean;
  now: Timestamp;
  config: RetryPolicyConfig;
}

/**
 * The durable retry decision for a terminal Attempt (`null` for a succeeded
 * one): transient → retry after deterministic backoff; result invalid →
 * retry at once with the validation appendix; interruption → retry unless
 * cancelled; tool failure → retry once; permanent, allocation exhaustion,
 * cancellation, and approval-required → no retry; and never beyond the
 * Attempt allocation.
 */
export function decideRetry(input: RetryDecisionInput): RetryDecision | null {
  const { classified } = input;
  if (classified.status === "succeeded") return null;
  const refuse = (reason: RetryDecision["reason"]): RetryDecision => ({ permitted: false, reason, notBefore: null });
  if (classified.status === "cancelled" || classified.detail?.cancelled) return refuse("cancelled");
  if (input.approvalRequired) return refuse("approval_required");
  switch (classified.failureClass) {
    case "provider_permanent":
      return refuse("provider_permanent");
    case "allocation_exhausted":
      return refuse("allocation_exhausted");
    case "tool_failure":
      if (input.previousFailureClass === "tool_failure") return refuse("tool_failure_retried");
      break;
    case "provider_transient":
    case "result_invalid":
    case "interrupted":
      break;
    case null:
      return refuse("provider_permanent");
  }
  if (input.attemptNumber >= input.maxAttempts) return refuse("attempts_exhausted");
  const reason = classified.failureClass;
  if (reason === "provider_transient") {
    const notBefore = new Date(Date.parse(input.now) + retryBackoffMs(input.attemptNumber, input.config.backoffBaseMs, input.config.backoffMaxMs)).toISOString();
    return { permitted: true, reason, notBefore };
  }
  return { permitted: true, reason, notBefore: null };
}
