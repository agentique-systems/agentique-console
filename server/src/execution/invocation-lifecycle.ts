/**
 * What happens to an Invocation and its Tasks once an Attempt is terminal
 * (execution-model §6.3, §7.2, §7.9): shared by the Attempt executor and
 * restart recovery so both settle canonical state identically. A retry that
 * is permitted changes nothing here; the Invocation stays `running` and its
 * reservation stays active until it is terminal.
 */
import {
  type Attempt,
  type DecisionId,
  type Invocation,
  type InvocationFailureReason,
  type InvocationResult,
  type RetryDecision,
  type TaskBlockReason,
  type TaskFailureReason,
  type TaskId,
} from "@agentique-console/core";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";

export interface SettleInvocationInput {
  invocation: Invocation;
  /** The terminal Attempt just recorded. */
  attempt: Attempt;
  decision: RetryDecision | null;
  /** The validated result of a succeeded Attempt. */
  result: InvocationResult | null;
  /** The open `side_effect_approval` Decision recorded for an intercepted call; the Invocation ends `blocked` on it. */
  approval: { decisionId: DecisionId } | null;
  meta: WriteOptions;
}

export type Settlement = { kind: "retry_pending"; invocation: Invocation; decision: RetryDecision } | { kind: "settled"; invocation: Invocation };

/** The Invocation failure reason a refused retry implies. */
export function invocationFailureReasonFor(decision: RetryDecision, attempt: Pick<Attempt, "failureClass">): InvocationFailureReason {
  switch (decision.reason) {
    case "provider_permanent":
      return "provider_permanent";
    case "allocation_exhausted":
    case "wall_clock_exhausted":
      return "allocation_exhausted";
    case "cancelled":
      return "cancelled";
    case "attempts_exhausted":
      // Attempts are a reserved quantity (execution-model §6.5): running out of them exhausts the allocation,
      // except that a last invalid result is reported as what it was.
      return attempt.failureClass === "result_invalid" ? "result_invalid" : "allocation_exhausted";
    case "tool_failure_retried":
      return "attempts_exhausted";
    case "approval_required":
      throw new Error("an approval-required refusal ends the Invocation blocked, never failed");
    default:
      throw new Error(`retry decision ${decision.reason} permits a retry; the Invocation does not fail`);
  }
}

function taskFailureReasonFor(reason: InvocationFailureReason): TaskFailureReason {
  switch (reason) {
    case "allocation_exhausted":
      return "allocation_exhausted";
    case "provider_permanent":
      return "permanent_failure";
    default:
      return "attempts_exhausted";
  }
}

export function settleInvocation(stores: Stores, input: SettleInvocationInput): Settlement {
  const { invocation, attempt, decision, meta } = input;
  if (attempt.status === "succeeded") {
    const result = input.result;
    if (!result) throw new Error(`succeeded Attempt ${attempt.id} carries no validated result`);
    const settled = stores.invocations.transition(invocation.id, { to: "succeeded", result }, meta);
    applyTaskReports(stores, invocation, result, meta);
    return { kind: "settled", invocation: settled };
  }
  if (attempt.status === "cancelled" || decision?.reason === "cancelled") {
    const settled = stores.invocations.transition(invocation.id, { to: "cancelled" }, meta);
    blockRunningTasks(stores, invocation, { kind: "replan", description: `Invocation ${invocation.id} was cancelled` }, meta);
    return { kind: "settled", invocation: settled };
  }
  if (!decision) throw new Error(`terminal Attempt ${attempt.id} carries no retry decision`);
  if (input.approval !== null) {
    // Terminal: the provider execution is over; the successor Invocation continues from here once the Decision is resolved.
    const blocked = stores.invocations.transition(invocation.id, { to: "blocked", decisionId: input.approval.decisionId }, meta);
    blockRunningTasks(stores, invocation, { kind: "decision", decisionId: input.approval.decisionId }, meta);
    return { kind: "settled", invocation: blocked };
  }
  if (decision.permitted) return { kind: "retry_pending", invocation, decision };
  const failureReason = invocationFailureReasonFor(decision, attempt);
  const failed = stores.invocations.transition(invocation.id, { to: "failed", failureReason, result: null }, meta);
  for (const taskId of invocation.taskIds) {
    if (stores.tasks.get(taskId).status === "running") stores.tasks.transition(taskId, { to: "failed", failureReason: taskFailureReasonFor(failureReason) }, meta);
  }
  return { kind: "settled", invocation: failed };
}

/** Applies the Task reports of a valid result: completed with Evidence and outputs, blocked with its blocker, failed. */
function applyTaskReports(stores: Stores, invocation: Invocation, result: InvocationResult, meta: WriteOptions): void {
  for (const report of result.tasks) {
    const task = stores.tasks.get(report.taskId);
    if (task.status !== "running") continue;
    switch (report.status) {
      case "completed": {
        const outputs = new Set<TaskId | string>(task.outputArtifactIds);
        for (const id of result.artifactIds) if (stores.artifacts.get(id).taskId === task.id) outputs.add(id);
        stores.tasks.transition(task.id, { to: "completed", evidence: report.evidence, outputArtifactIds: [...outputs].sort() as never }, meta);
        break;
      }
      case "blocked":
        stores.tasks.transition(task.id, { to: "blocked", blockReason: { kind: "input", description: report.blocker ?? result.blocker ?? "blocked" } }, meta);
        break;
      case "failed":
        stores.tasks.transition(task.id, { to: "failed", failureReason: "permanent_failure" }, meta);
        break;
    }
  }
}

function blockRunningTasks(stores: Stores, invocation: Invocation, blockReason: TaskBlockReason, meta: WriteOptions): void {
  for (const taskId of invocation.taskIds) {
    if (stores.tasks.get(taskId).status === "running") stores.tasks.transition(taskId, { to: "blocked", blockReason }, meta);
  }
}
