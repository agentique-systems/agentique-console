/**
 * Ledger sync: the journal drives the task ledger, not a coordinator's
 * memory. Called from `post()` after route assertion, before delivery.
 */
import type { HandoffDraft } from "@agentique-console/shared";
import type { AgentSessionRow } from "../db/repo.ts";
import { consoleTaskListId } from "../tasks/service.ts";
import type { Category, FinalGateDeps } from "./final-gate.ts";

/**
 * An assignment carrying a taskId starts that unit; a terminal-status report
 * finishes it. Both are facts the console already holds at this moment.
 *
 * When the model supplies no taskId the console falls back to the OWNER — see
 * `unambiguousUnit`. A whole live run passed `taskId: null` on every single
 * handoff, so both of its ledger units sat `pending` from creation to the end
 * and the ledger described nothing that happened.
 */
export function syncLedgerFromHandoff(deps: FinalGateDeps, session: AgentSessionRow, sender: string, to: string, handoff: HandoffDraft, category: Category): void {
  const tasks = deps.tasks;
  if (!tasks) return;
  const listId = consoleTaskListId(session.id);
  try {
    if (category === "assignment") {
      const taskId = handoff.core.taskId ?? unambiguousUnit(deps, session, to);
      if (taskId !== null) tasks.applyUpdate({ sdkSessionId: listId, sdkTaskId: taskId, patch: { status: "in_progress", owner: to } });
      return;
    }
    const taskId = handoff.core.taskId ?? unambiguousUnit(deps, session, sender);
    if (taskId === null) return;
    if (handoff.core.status === "completed") {
      tasks.applyUpdate({ sdkSessionId: listId, sdkTaskId: taskId, patch: { status: "completed" } });
    } else if (handoff.core.status === "failed" || handoff.core.status === "blocked") {
      tasks.applyUpdate({ sdkSessionId: listId, sdkTaskId: taskId, patch: { status: "pending" } });
    }
  } catch { /* a ledger write must never fail a transfer */ }
}

/**
 * The one open ledger unit an agent owns, or null.
 *
 * Deliberately conservative: with two open units the console cannot tell which
 * one a report concerns, and closing both would be worse than closing neither —
 * the open ones ride out with the final report as caveats either way. This
 * infers only where there is nothing to infer between.
 */
function unambiguousUnit(deps: FinalGateDeps, session: AgentSessionRow, owner: string): string | null {
  const open = (deps.tasks?.listForUserSession(session.userSessionId) ?? []).filter((task) =>
    task.agentSessionId === session.id && task.owner === owner
    && task.status !== "completed" && task.status !== "deleted");
  return open.length === 1 ? open[0]!.sdkTaskId : null;
}
