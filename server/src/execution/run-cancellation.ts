/**
 * Convergence of a cancelled Run's work (execution-model §3 `cancelled`,
 * §14 "Operator cancels a Run"), shared by the Run-control service (in the
 * cancelling transaction), the Attempt executor (when an executing Attempt
 * of a cancelled Run finalizes), and restart recovery (when a dead
 * process's Attempt of a cancelled Run is settled), so every path settles
 * canonical state identically. From rows alone, inside the caller's
 * transaction:
 *
 * - every non-terminal Invocation with no active Attempt is `cancelled`
 *   (releasing its reservation), its running Tasks blocked and cancelled;
 *   an Invocation whose Attempt is still executing — in this process or in
 *   one that died — is left to that Attempt's finalization or to recovery,
 *   after which this converges the rest;
 * - every pending, ready, or blocked Task is `cancelled` (its Task
 *   reservation released with `run_cancelled`); a running Task whose
 *   Invocation has ended is blocked then cancelled;
 * - every non-terminal Plan Node — root, current member, or a node that
 *   left the membership — whose Invocations have all ended is `cancelled`
 *   with reason `run_cancelled` (releasing its reservation);
 * - every pending Handoff is `cancelled`.
 *
 * Terminal history is preserved: a succeeded, failed, skipped, or cancelled
 * node, a completed or failed Task, and a blocked or ended Invocation keep
 * their state; Gates, Completion Requests, and Decisions keep theirs (the
 * cancelled Run is what prevents any continuation from them); Usage rows
 * stay as recorded and no consumed allocation is refunded. Idempotent: a
 * converged Run yields nothing.
 */
import { INVOCATION_MACHINE, InvariantViolationError, PLAN_NODE_MACHINE, ZERO_ALLOCATION, type HandoffId, type InvocationId, type PlanNodeId, type RunId, type Task, type TaskId } from "@agentique-console/core";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";

export interface CancelledRunConvergence {
  cancelledInvocationIds: InvocationId[];
  cancelledTaskIds: TaskId[];
  cancelledNodeIds: PlanNodeId[];
  cancelledHandoffIds: HandoffId[];
  /** Invocations left `running` because an Attempt of theirs is still active: their finalization (or recovery) settles them. */
  executingInvocationIds: InvocationId[];
}

export function settleCancelledRunWork(stores: Stores, runId: RunId, meta: WriteOptions): CancelledRunConvergence {
  const run = stores.runs.get(runId);
  if (run.status !== "cancelled") throw new InvariantViolationError(`Run ${runId} is ${run.status}; only a cancelled Run's work converges to cancellation`, { runId, status: run.status });
  const report: CancelledRunConvergence = { cancelledInvocationIds: [], cancelledTaskIds: [], cancelledNodeIds: [], cancelledHandoffIds: [], executingInvocationIds: [] };
  const cancelTask = (task: Task): void => {
    stores.tasks.transition(task.id, { to: "cancelled" }, meta);
    const reservation = stores.reservations.activeForChild({ type: "task", id: task.id });
    if (reservation) stores.reservations.release(reservation.id, "run_cancelled", { ...ZERO_ALLOCATION }, meta);
    report.cancelledTaskIds.push(task.id);
  };
  const blockReason = { kind: "replan" as const, description: `Run ${runId} was cancelled by the operator` };

  // 1. Invocations: prepared, running, or waiting ones with no active Attempt end cancelled; an executing one settles through its Attempt.
  for (const invocation of stores.invocations.listByRun(runId)) {
    if (INVOCATION_MACHINE.isTerminal(invocation.status)) continue;
    if (stores.invocations.activeAttempt(invocation.id) !== null) {
      report.executingInvocationIds.push(invocation.id);
      continue;
    }
    stores.invocations.transition(invocation.id, { to: "cancelled" }, meta);
    report.cancelledInvocationIds.push(invocation.id);
    for (const taskId of invocation.taskIds) {
      const task = stores.tasks.get(taskId);
      if (task.status === "running" && task.invocationId === invocation.id) stores.tasks.transition(task.id, { to: "blocked", blockReason }, meta);
    }
  }

  // 2. Tasks: every unfinished Task reaches its legal cancellation state; completed and failed Tasks are history.
  for (const task of stores.tasks.listByRun(runId)) {
    switch (task.status) {
      case "pending":
      case "ready":
      case "blocked":
        cancelTask(task);
        break;
      case "running": {
        const holder = task.invocationId === null ? null : stores.invocations.get(task.invocationId);
        if (holder !== null && !INVOCATION_MACHINE.isTerminal(holder.status)) break;
        stores.tasks.transition(task.id, { to: "blocked", blockReason }, meta);
        cancelTask(stores.tasks.get(task.id));
        break;
      }
      default:
        break;
    }
  }

  // 3. Plan Nodes: every node of the Run whose own Invocations have ended — current, removed, and the root alike — ends cancelled.
  for (const node of stores.plans.listNodes(runId)) {
    if (PLAN_NODE_MACHINE.isTerminal(node.status)) continue;
    if (node.kind === "pattern" && stores.invocations.listByPlanNode(node.id).some((i) => !INVOCATION_MACHINE.isTerminal(i.status))) continue;
    stores.plans.transitionNode(node.id, { to: "cancelled", reason: "run_cancelled" }, meta);
    report.cancelledNodeIds.push(node.id);
  }

  // 4. Handoffs: nothing undelivered is delivered later.
  for (const handoff of stores.handoffs.listByRun(runId)) {
    if (handoff.status !== "pending") continue;
    stores.handoffs.transition(handoff.id, "cancelled", meta);
    report.cancelledHandoffIds.push(handoff.id);
  }
  return report;
}
