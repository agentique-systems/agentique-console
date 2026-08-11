/**
 * The final-report gate: what may block a `final`, and what merely travels
 * with it as caveats. Free functions over a narrow deps surface — `post()`
 * stays the ordered pipeline that calls them.
 */
import type { Interaction } from "@agentique-console/shared";
import type { AgentProfile } from "../agent-profiles/registry.ts";
import type { Config } from "../config.ts";
import type { AgentSessionRow, MailboxDeliveryRow, Repo } from "../db/repo.ts";
import type { DecisionLedger } from "../orchestrator/decisions.ts";
import type { InteractionService } from "../orchestrator/interactions.ts";
import type { TaskService } from "../tasks/service.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { MAIN_RECIPIENT } from "./names.ts";

export type Category = MailboxDeliveryRow["category"];

/** The slice of the service's deps the gate stack reads. */
export interface FinalGateDeps {
  repo: Repo;
  config?: Config;
  interactions: InteractionService;
  decisions: DecisionLedger;
  tasks?: TaskService;
  handoffs?: HandoffService;
}

/**
 * A `final` withheld by the gate. Deliberately NOT an ApiError: the
 * `send_handoff` handler catches this and answers with a structured non-error
 * hold — `ask_operator` never returns `isError` for the operator's silence, and
 * blocked assignments answer `{queued:true}`, for the same reason: an error
 * result feeds the error-streak watchdog, and a model retrying a refusal feeds
 * the identical-call watchdog. Punishing an agent for a hold the Console
 * imposed kills the very turn that must stay alive to react when the hold
 * clears.
 */
export class WithheldFinalError extends Error {
  constructor(
    readonly blockers: { id: string; question: string; asker: string; ageMinutes: number }[],
    guidance: string,
  ) {
    super(guidance);
    this.name = "WithheldFinalError";
  }
}

export function resolvedDomains(profile: AgentProfile, workspaceDomains: string[]): string[] {
  return profile.runtime.network === "default" ? workspaceDomains : profile.runtime.network;
}

/**
 * Conditions that make a `final` a lie the Console can PROVE.
 *
 * The distinction from `finalReportCaveats` below is the whole design.
 * Caveats are model-maintained facts — an open ledger task, a specialist
 * still running — and those must never block, because in db-live-1 the
 * ledger orphaned on rotation and a blocking rule made `final` structurally
 * impossible while the operator heard nothing for 35 minutes.
 *
 * An unanswered operator question is different in kind: the Console owns it
 * end to end. It knows the question was asked, that nobody but the operator
 * can answer it, and that it has not been answered. db-live-2 declared a run
 * done and THEN asked whether two open items mattered — a question that is
 * still `pending` in that database, and was the last row written. A report
 * that precedes its own outstanding questions is not a report.
 */
export function finalReportBlockers(deps: FinalGateDeps, session: AgentSessionRow, finalAgent: string, sender: string, to: string, category: Category): Interaction[] {
  if (!isFinalToMain(finalAgent, sender, to, category)) return [];
  return deps.interactions.listUnresolvedForAgentSession(session.id)
    .filter((row) => row.urgency === "blocking");
}

/**
 * `finalAgent` is the agent of the contract's `completion.finalFrom` role —
 * the one whose final→main is THE report the gate governs. Hub: the
 * coordinator.
 */
export function isFinalToMain(finalAgent: string, sender: string, to: string, category: Category): boolean {
  return sender === finalAgent && to === MAIN_RECIPIENT && category === "final";
}

/**
 * Conditions a `final` report has not met. These used to THROW, which made
 * the operator's report conditional on model-maintained state: in db-live-1
 * the ledger orphaned on rotation, so a `final` was structurally impossible
 * and the operator heard nothing for 35 minutes. The console may enforce
 * only on facts it owns — so unmet conditions now travel WITH the report,
 * where the operator can weigh them, instead of suppressing it.
 */
export function finalReportCaveats(deps: FinalGateDeps, session: AgentSessionRow, finalAgent: string, sender: string, to: string, category: Category, activeSpecialists: () => string[]): string[] {
  if (!isFinalToMain(finalAgent, sender, to, category)) return [];
  const caveats: string[] = [];
  if (deps.tasks) {
    const incomplete = deps.tasks.listForUserSession(session.userSessionId).filter((task) => task.agentSessionId === session.id && task.status !== "completed" && task.status !== "deleted");
    if (incomplete.length > 0) caveats.push(`${incomplete.length} task(s) still open in the ledger: ${incomplete.map((task) => task.subject).join(", ")}`);
  }
  const running = activeSpecialists();
  // Only deliveries addressed to OTHER agents count as outstanding work: a
  // native final goes out mid-turn, so the very report that woke the
  // reporting agent is still unacknowledged in its own inbox.
  const pendingInternal = deps.repo.listActiveDeliveries(session.id).filter((delivery) => delivery.recipient !== MAIN_RECIPIENT && delivery.recipient !== sender);
  if (running.length > 0) caveats.push(`still running: ${running.join(", ")}`);
  if (pendingInternal.length > 0) caveats.push(`${pendingInternal.length} delivery(ies) to specialists not yet acknowledged`);
  return caveats;
}
