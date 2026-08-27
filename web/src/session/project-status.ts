/**
 * Continuation-picker status words, derived from ProjectContinuationItem
 * facts. The server deliberately ships facts (open session, pause reason,
 * last runState) rather than a second status vocabulary — this is the one
 * place those facts become operator words, so labels cannot drift from state.
 */
import type { ProjectContinuationItem } from "@agentique-console/shared";

/** One short status phrase for a project row in the continue-project picker. */
export function projectStatusLabel(item: ProjectContinuationItem): string {
  const open = item.openSession;
  if (open !== null) {
    if (open.pauseReason === "capacity") return "paused — provider capacity";
    if (open.pauseReason === "budget") return "paused — budget ceiling";
    if (open.pauseReason === "operator") return "paused by operator";
    return "session open";
  }
  const last = item.lastSession;
  if (last === null) return "no sessions yet";
  if (last.runState === "completed") return "completed";
  if (last.runState === "awaiting_signoff") return "ended awaiting sign-off";
  if (last.pauseReason === "capacity") return "stopped by provider quota";
  if (last.pauseReason === "budget") return "stopped at budget ceiling";
  return "stopped before completion";
}

/**
 * Whether continuing this project must hand off a still-open session first.
 * The picker only offers handoff for a PAUSED open session — an actively
 * running one is deliberately not a continuation candidate (archive it
 * deliberately, or pause first), mirroring the archive button's busy guard.
 */
export function continuationRequiresHandoff(item: ProjectContinuationItem): boolean {
  return item.openSession !== null;
}

/** Projects the picker offers: no open session, or an open session held by a pause. */
export function isContinuationCandidate(item: ProjectContinuationItem): boolean {
  return item.openSession === null || item.openSession.pauseReason !== null;
}
