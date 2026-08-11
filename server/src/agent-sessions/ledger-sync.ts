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
 */
export function syncLedgerFromHandoff(deps: FinalGateDeps, session: AgentSessionRow, to: string, handoff: HandoffDraft, category: Category): void {
  const tasks = deps.tasks;
  const taskId = handoff.core.taskId;
  if (!tasks || taskId === null) return;
  const listId = consoleTaskListId(session.id);
  try {
    if (category === "assignment") {
      tasks.applyUpdate({ sdkSessionId: listId, sdkTaskId: taskId, patch: { status: "in_progress", owner: to } });
      return;
    }
    if (handoff.core.status === "completed") {
      tasks.applyUpdate({ sdkSessionId: listId, sdkTaskId: taskId, patch: { status: "completed" } });
    } else if (handoff.core.status === "failed" || handoff.core.status === "blocked") {
      tasks.applyUpdate({ sdkSessionId: listId, sdkTaskId: taskId, patch: { status: "pending" } });
    }
  } catch { /* a ledger write must never fail a transfer */ }
}
