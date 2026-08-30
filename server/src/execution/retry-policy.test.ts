/**
 * Failure classification and deterministic retry decisions
 * (execution-model §7.2, §14).
 */
import type { Allocation } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { classifyAttempt, decideRetry, type ClassifiedAttempt, type RetryPolicyConfig } from "./retry-policy.ts";

const allocation: Allocation = { costUsd: 1, tokens: 1000, attempts: 3 };
const within: Allocation = { costUsd: 0.1, tokens: 100, attempts: 1 };
const over: Allocation = { costUsd: 1.5, tokens: 100, attempts: 1 };
const config: RetryPolicyConfig = { backoffBaseMs: 1000, backoffMaxMs: 3000 };
const now = "2026-01-01T00:00:00.000Z";
const invalid = { ok: false as const, violations: [{ code: "unknown_artifact" as const, message: "no such artifact", path: "artifactIds.0" }] };
const valid = { ok: true as const, result: { status: "completed" as const, artifactIds: [], tasks: [], evidence: [], summary: "ok", openItems: [], blocker: null, runOutcome: null } };

describe("classifyAttempt", () => {
  it("maps every completion and runtime interruption to the closed status and failure class with bounded detail", () => {
    expect(classifyAttempt({ completion: { kind: "completed" }, validation: valid, runtimeInterruption: null, consumed: within, allocation })).toMatchObject({ status: "succeeded", failureClass: null, detail: null, result: valid.result });
    const bad = classifyAttempt({ completion: { kind: "completed" }, validation: invalid, runtimeInterruption: null, consumed: within, allocation });
    expect(bad).toMatchObject({ status: "failed", failureClass: "result_invalid", detail: { message: "result invalid: unknown_artifact", violations: invalid.violations, tool: null, cancelled: false } });
    expect(classifyAttempt({ completion: { kind: "provider_error", transient: true, message: "overloaded\nstack" }, validation: invalid, runtimeInterruption: null, consumed: within, allocation })).toMatchObject({ status: "failed", failureClass: "provider_transient", detail: { message: "overloaded" } });
    expect(classifyAttempt({ completion: { kind: "provider_error", transient: false, message: "x".repeat(700) }, validation: invalid, runtimeInterruption: null, consumed: within, allocation }).detail?.message.length).toBe(500);
    expect(classifyAttempt({ completion: { kind: "provider_error", transient: false, message: "gone" }, validation: invalid, runtimeInterruption: null, consumed: within, allocation })).toMatchObject({ status: "failed", failureClass: "provider_permanent" });
    expect(classifyAttempt({ completion: { kind: "tool_failure", tool: "shell", message: "exit 137" }, validation: invalid, runtimeInterruption: null, consumed: within, allocation })).toMatchObject({ status: "failed", failureClass: "tool_failure", detail: { tool: "shell" } });
    const approval = classifyAttempt({ completion: { kind: "approval_required", call: { tool: "shell", input: { command: "rm -rf build" } } }, validation: invalid, runtimeInterruption: null, consumed: within, allocation });
    expect(approval).toMatchObject({ status: "failed", failureClass: "tool_failure", detail: { tool: "shell", message: "tool shell requires operator approval" } });
    expect(JSON.stringify(approval)).not.toContain("rm -rf");
    expect(classifyAttempt({ completion: { kind: "interrupted", cause: "provider", message: "stream ended" }, validation: invalid, runtimeInterruption: null, consumed: within, allocation })).toMatchObject({ status: "interrupted", failureClass: "interrupted" });
    expect(classifyAttempt({ completion: { kind: "interrupted", cause: "cancelled", message: "aborted" }, validation: invalid, runtimeInterruption: null, consumed: within, allocation })).toMatchObject({ status: "cancelled", failureClass: null, detail: { cancelled: true } });
    expect(classifyAttempt({ completion: { kind: "interrupted", cause: "deadline", message: "aborted" }, validation: invalid, runtimeInterruption: null, consumed: within, allocation })).toMatchObject({ status: "timed_out", failureClass: "interrupted" });
    // What the runtime did wins over what the provider reported.
    expect(classifyAttempt({ completion: { kind: "completed" }, validation: valid, runtimeInterruption: "cancelled", consumed: within, allocation })).toMatchObject({ status: "cancelled", detail: { cancelled: true } });
    expect(classifyAttempt({ completion: { kind: "provider_error", transient: true, message: "m" }, validation: invalid, runtimeInterruption: "deadline", consumed: within, allocation })).toMatchObject({ status: "timed_out", failureClass: "interrupted" });
    // A failure while the cost or token allocation is exhausted is allocation exhaustion; a success is still a success.
    expect(classifyAttempt({ completion: { kind: "provider_error", transient: true, message: "m" }, validation: invalid, runtimeInterruption: null, consumed: over, allocation })).toMatchObject({ status: "failed", failureClass: "allocation_exhausted" });
    expect(classifyAttempt({ completion: { kind: "completed" }, validation: invalid, runtimeInterruption: null, consumed: over, allocation })).toMatchObject({ status: "failed", failureClass: "allocation_exhausted", detail: { violations: invalid.violations } });
    expect(classifyAttempt({ completion: { kind: "completed" }, validation: valid, runtimeInterruption: null, consumed: over, allocation }).status).toBe("succeeded");
  });
});

describe("decideRetry", () => {
  const failed = (failureClass: ClassifiedAttempt["failureClass"], extra: Partial<ClassifiedAttempt> = {}): ClassifiedAttempt => ({ status: "failed", failureClass, detail: { message: "m", violations: [], tool: null, cancelled: false }, result: null, ...extra });
  const decide = (classified: ClassifiedAttempt, attemptNumber = 1, previousFailureClass: ClassifiedAttempt["failureClass"] = null, approvalRequired = false, deadlineAt: string | null = null) =>
    decideRetry({ classified, attemptNumber, maxAttempts: allocation.attempts, previousFailureClass, approvalRequired, deadlineAt, now, config });

  it("retries transient failures after deterministic backoff, invalid results at once, interruptions unless cancelled, tool failures once", () => {
    expect(decide({ status: "succeeded", failureClass: null, detail: null, result: valid.result })).toBeNull();
    expect(decide(failed("provider_transient"))).toEqual({ permitted: true, reason: "provider_transient", notBefore: "2026-01-01T00:00:01.000Z" });
    expect(decide(failed("provider_transient"), 2)).toEqual({ permitted: true, reason: "provider_transient", notBefore: "2026-01-01T00:00:02.000Z" });
    expect(decideRetry({ classified: failed("provider_transient"), attemptNumber: 3, maxAttempts: 10, previousFailureClass: null, approvalRequired: false, deadlineAt: null, now, config })).toEqual({ permitted: true, reason: "provider_transient", notBefore: "2026-01-01T00:00:03.000Z" });
    expect(decide(failed("result_invalid"))).toEqual({ permitted: true, reason: "result_invalid", notBefore: null });
    expect(decide({ ...failed("interrupted"), status: "interrupted" })).toEqual({ permitted: true, reason: "interrupted", notBefore: null });
    expect(decide(failed("tool_failure"))).toEqual({ permitted: true, reason: "tool_failure", notBefore: null });
    expect(decide(failed("tool_failure"), 2, "tool_failure")).toEqual({ permitted: false, reason: "tool_failure_retried", notBefore: null });
    expect(decide(failed("tool_failure"), 2, "provider_transient")).toEqual({ permitted: true, reason: "tool_failure", notBefore: null });
  });

  it("never retries permanent failures, allocation exhaustion, cancellation, approval-required, or past the Attempt allocation", () => {
    expect(decide(failed("provider_permanent"))).toEqual({ permitted: false, reason: "provider_permanent", notBefore: null });
    expect(decide(failed("allocation_exhausted"))).toEqual({ permitted: false, reason: "allocation_exhausted", notBefore: null });
    expect(decide({ status: "cancelled", failureClass: null, detail: { message: "m", violations: [], tool: null, cancelled: true }, result: null })).toEqual({ permitted: false, reason: "cancelled", notBefore: null });
    expect(decide({ ...failed("interrupted"), status: "interrupted", detail: { message: "m", violations: [], tool: null, cancelled: true } })).toEqual({ permitted: false, reason: "cancelled", notBefore: null });
    expect(decide(failed("tool_failure"), 1, null, true)).toEqual({ permitted: false, reason: "approval_required", notBefore: null });
    expect(decide(failed("result_invalid"), 3)).toEqual({ permitted: false, reason: "attempts_exhausted", notBefore: null });
    expect(decide(failed("provider_transient"), 3)).toEqual({ permitted: false, reason: "attempts_exhausted", notBefore: null });
    // Decisions are pure: the same input always yields the same decision.
    expect(decide(failed("provider_transient"))).toEqual(decide(failed("provider_transient")));
  });

  it("never retries past the one Invocation-wide deadline: a deadline timeout is final, a passed deadline refuses, and a backoff ending at or after it is refused", () => {
    const deadline = "2026-01-01T00:00:00.500Z";
    // A deadline interruption is final even with Attempts to spare.
    expect(decide({ ...failed("interrupted"), status: "timed_out" }, 1, null, false, "2026-01-01T01:00:00.000Z")).toEqual({ permitted: false, reason: "wall_clock_exhausted", notBefore: null });
    // A non-deadline interruption before the deadline may retry with the remaining time.
    expect(decide({ ...failed("interrupted"), status: "interrupted" }, 1, null, false, "2026-01-01T01:00:00.000Z")).toEqual({ permitted: true, reason: "interrupted", notBefore: null });
    // Once the deadline has passed nothing retries.
    expect(decide({ ...failed("interrupted"), status: "interrupted" }, 1, null, false, now)).toEqual({ permitted: false, reason: "wall_clock_exhausted", notBefore: null });
    expect(decide(failed("result_invalid"), 1, null, false, "2025-12-31T23:59:59.999Z")).toEqual({ permitted: false, reason: "wall_clock_exhausted", notBefore: null });
    // A transient backoff of 1 s that would end at or after a deadline 500 ms away is refused rather than persisted.
    expect(decide(failed("provider_transient"), 1, null, false, deadline)).toEqual({ permitted: false, reason: "wall_clock_exhausted", notBefore: null });
    expect(decide(failed("provider_transient"), 1, null, false, "2026-01-01T00:00:01.000Z")).toEqual({ permitted: false, reason: "wall_clock_exhausted", notBefore: null });
    expect(decide(failed("provider_transient"), 1, null, false, "2026-01-01T00:00:01.001Z")).toEqual({ permitted: true, reason: "provider_transient", notBefore: "2026-01-01T00:00:01.000Z" });
    // An unbounded Invocation never refuses on wall clock.
    expect(decide({ ...failed("interrupted"), status: "interrupted" }, 1, null, false, null)).toEqual({ permitted: true, reason: "interrupted", notBefore: null });
  });
});
