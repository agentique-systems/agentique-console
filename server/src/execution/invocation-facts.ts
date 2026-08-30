/**
 * Canonical Invocation facts every Pattern runner and the Gate engine read
 * from rows: the Decision an Invocation is blocked on, its outstanding
 * Changeset, and the executor's advice for an active Invocation. Nothing
 * here reads a transcript, an Event, or process memory.
 */
import { INVOCATION_MACHINE, isIdOfKind, type Changeset, type Decision, type Invocation, type InvocationId, type Timestamp } from "@agentique-console/core";
import type { Stores } from "../persistence/stores/index.ts";
import type { AttemptExecutor } from "./attempt-executor.ts";

/** The Decision a `blocked` result names, when its blocker is a Decision id of the Run; otherwise `null`. */
export function blockingDecisionOf(stores: Stores, invocation: Invocation): Decision | null {
  if (invocation.status === "blocked" && invocation.blockedByDecisionId !== null) return stores.decisions.get(invocation.blockedByDecisionId);
  const result = invocation.result;
  if (invocation.status !== "succeeded" || result === null || result.status !== "blocked" || !isIdOfKind("decision", result.blocker)) return null;
  try {
    const decision = stores.decisions.get(result.blocker);
    return decision.runId === invocation.runId ? decision : null;
  } catch {
    return null;
  }
}

/** The Changeset of an Invocation that is not yet integrated, if any. */
export function outstandingChangesetOf(stores: Stores, invocation: Invocation): Changeset | null {
  return stores.changesets.listByRun(invocation.runId).find((c) => c.kind === "invocation" && c.invocationId === invocation.id && c.integrationStatus !== "integrated") ?? null;
}

/** Whether a terminal Invocation is blocked (by status or by a `blocked` result) on a Decision, and that Decision. */
export function blockedOn(stores: Stores, invocation: Invocation): Decision | null {
  if (invocation.status === "blocked") return blockingDecisionOf(stores, invocation);
  if (invocation.status === "succeeded" && invocation.result?.status === "blocked") return blockingDecisionOf(stores, invocation);
  return null;
}

/** What the executor says about an active Invocation: it may execute now, an Attempt is in flight, or a retry waits for `notBefore`. */
export type ActiveInvocationAdvice = { kind: "execute"; invocationId: InvocationId } | { kind: "attempt_in_flight"; invocationId: InvocationId } | { kind: "retry_not_before"; invocationId: InvocationId; notBefore: Timestamp };

export function activeInvocationAdvice(executor: AttemptExecutor, invocation: Invocation, now: Timestamp): ActiveInvocationAdvice {
  const inspection = executor.inspectInvocation(invocation.id, now);
  if (inspection.next.permitted) return { kind: "execute", invocationId: invocation.id };
  switch (inspection.next.reason) {
    case "attempt_active":
      return { kind: "attempt_in_flight", invocationId: invocation.id };
    case "retry_not_yet":
      return { kind: "retry_not_before", invocationId: invocation.id, notBefore: inspection.next.notBefore! };
    default:
      // Allocation exhaustion or a refused retry: the executor settles the Invocation on the next execute call.
      return { kind: "execute", invocationId: invocation.id };
  }
}

/** True for a terminal Invocation. */
export function isTerminalInvocation(invocation: Pick<Invocation, "status">): boolean {
  return INVOCATION_MACHINE.isTerminal(invocation.status);
}
