/**
 * Ledger sync: the journal drives the task ledger, not a coordinator's
 * memory. Called from `post()` after route assertion, before delivery.
 */
import type { HandoffDraft, Task, TaskSyncFailedPayload } from "@agentique-console/shared";
import type { AgentSessionRow } from "../db/repo.ts";
import { consoleTaskListId } from "../tasks/service.ts";
import type { Category, FinalGateDeps } from "./final-gate.ts";

/**
 * The structural outcome of one handoff's ledger sync. `null` means the
 * handoff involved no ledger unit; `applied: false` means a transition was
 * intended and did NOT happen — the mailroom journals that on the handoff
 * and emits `task.sync.failed`, so a failed task-state transition can never
 * masquerade as a successful report. Duplicates are `applied: true` with
 * `from === to`: already there, structurally, not an error.
 */
export type TaskSyncOutcome =
  | { applied: true; taskId: string; from: Task["status"]; to: Task["status"] }
  | { applied: false; taskRef: string | null; reason: TaskSyncFailedPayload["reason"]; detail: string };

/**
 * An assignment carrying a taskId starts that unit; a terminal-status report
 * finishes it. Both are facts the console already holds at this moment.
 *
 * References resolve through the ONE resolver every boundary uses
 * (`resolveForList`: canonical ledger id first, then a row id scoped to this
 * session's list) — a live run left `b3` pending forever because its final
 * named the database row id and the sync path only understood ledger ids.
 * An unresolvable reference is a visible outcome, never a swallowed one.
 *
 * When the model supplies no taskId the console falls back to the OWNER — see
 * `unambiguousUnit`. A whole live run passed `taskId: null` on every single
 * handoff, so both of its ledger units sat `pending` from creation to the end
 * and the ledger described nothing that happened.
 */
export function syncLedgerFromHandoff(deps: FinalGateDeps, session: AgentSessionRow, sender: string, to: string, handoff: HandoffDraft, category: Category): TaskSyncOutcome | null {
  const tasks = deps.tasks;
  if (!tasks) return null;
  const listId = consoleTaskListId(session.id);
  const ref = handoff.core.taskId === "" ? null : handoff.core.taskId;
  const resolve = (owner: string): Task | { unknown: true } | null => {
    if (ref === null) return unambiguousUnit(deps, session, owner);
    return tasks.resolveForList(listId, ref) ?? { unknown: true };
  };
  const apply = (task: Task, status: "pending" | "in_progress" | "completed", owner?: string): TaskSyncOutcome => {
    const from = task.status;
    if (from !== status || owner !== undefined) {
      tasks.applyUpdate({ sdkSessionId: listId, sdkTaskId: task.sdkTaskId, patch: { status, ...(owner === undefined ? {} : { owner }) } });
    }
    return { applied: true, taskId: task.sdkTaskId, from, to: status };
  };
  if (category === "assignment") {
    const task = resolve(to);
    if (task === null) return null;
    if ("unknown" in task) return unknownRef(session, ref!);
    return apply(task, "in_progress", to);
  }
  const status = handoff.core.status;
  if (status !== "completed" && status !== "failed" && status !== "blocked") return null;
  const task = resolve(sender);
  if (task !== null && "unknown" in task) return unknownRef(session, ref!);
  if (status === "completed") {
    // The completion contract: an agent's own "completed" must state its
    // deliverable — `result.summary: null` is the schema's "the work produced
    // nothing to hand over", and a task must not turn terminal-success on a
    // report that structurally says its promised output is absent. Console-
    // synthesized notices are exempt: they carry relayed text, not a claim.
    if (!consoleSynthesized(handoff) && handoff.core.result.summary === null) {
      if (ref === null) return null; // nothing named, nothing inferred — open units ride out as final caveats
      return { applied: false, taskRef: ref, reason: "completed_without_result",
        detail: `the report marks task "${ref}" completed but states no deliverable (result.summary is null); the task was not completed` };
    }
    if (task === null) return null;
    return apply(task, "completed");
  }
  if (task === null) return null;
  return apply(task, "pending");
}

function unknownRef(session: AgentSessionRow, ref: string): TaskSyncOutcome {
  return { applied: false, taskRef: ref, reason: "unknown_task_ref",
    detail: `task reference "${ref}" is not a valid taskId in AgentSession ${session.id} (task_list shows the ledger); no task state changed` };
}

function consoleSynthesized(handoff: HandoffDraft): boolean {
  return (handoff.extension?.data as { consoleSynthesized?: boolean } | undefined)?.consoleSynthesized === true;
}

/**
 * The one open ledger unit an agent owns, or null.
 *
 * Deliberately conservative: with two open units the console cannot tell which
 * one a report concerns, and closing both would be worse than closing neither —
 * the open ones ride out with the final report as caveats either way. This
 * infers only where there is nothing to infer between.
 */
function unambiguousUnit(deps: FinalGateDeps, session: AgentSessionRow, owner: string): Task | null {
  const open = (deps.tasks?.listForUserSession(session.userSessionId) ?? []).filter((task) =>
    task.agentSessionId === session.id && task.owner === owner
    && task.status !== "completed" && task.status !== "deleted");
  return open.length === 1 ? open[0]! : null;
}
