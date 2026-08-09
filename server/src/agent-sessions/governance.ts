/**
 * The `post()` gate stack: uncertainty promotion, the final-report gate, the
 * assignment-dependency hold, and ledger sync. Free functions over a narrow
 * deps surface — `post()` in host.ts stays the ordered pipeline that calls
 * them, and the ordering comments live with the pipeline.
 */
import type { HandoffDraft, HandoffTrigger, Interaction, InteractionQuestion } from "@agentique-console/shared";
import type { AgentProfile } from "../agent-profiles/registry.ts";
import type { Config } from "../config.ts";
import type { AgentSessionRow, MailboxDeliveryRow, Repo } from "../db/repo.ts";
import type { DecisionLedger } from "../orchestrator/decisions.ts";
import type { InteractionService } from "../orchestrator/interactions.ts";
import type { TaskService } from "../tasks/service.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { classifyUncertainty, type EscalationCategory, type EscalationItem } from "../handoffs/escalation.ts";
import { consoleTaskListId } from "../orchestrator/tools.ts";
import { MAIN_RECIPIENT, ORCHESTRATOR_SEAT } from "./peer-names.ts";

export type Category = MailboxDeliveryRow["category"];

/** The slice of the host's deps the gate stack reads. */
export interface GovernanceDeps {
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
 * the identical-call watchdog. Punishing a seat for a hold the Console imposed
 * kills the very turn that must stay alive to react when the hold clears.
 */
export class WithheldFinalError extends Error {
  constructor(
    readonly blockers: { id: string; question: string; asker: string; ageMinutes: number }[],
    readonly promoted: number,
    guidance: string,
  ) {
    super(guidance);
    this.name = "WithheldFinalError";
  }
}

export function resolvedDomains(profile: AgentProfile, workspaceDomains: string[]): string[] {
  return profile.runtime.network === "default" ? workspaceDomains : profile.runtime.network;
}

/** Questions on one auto-promoted card before the rest spill into context. */
const MAX_QUESTIONS_PER_CARD = 4;

/** Capability shape for a sender the console has no profile for (main). */
const FALLBACK_PROFILE_RUNTIME = { runtime: { shell: false, browser: false, screenshots: false, network: [] as string[] } } as AgentProfile;

const ESCALATION_HEADER: Record<EscalationCategory, string> = {
  version_substitution: "Version",
  spec_deviation: "Deviation",
  capability_gap: "Blocked",
  unverifiable_claim: "Unverified",
  ambiguity: "Ambiguous",
  volume: "Open items",
};

/** Stable question text, so a re-reported uncertainty is recognisably the same. */
function uncertaintyQuestion(item: EscalationItem): string {
  if (item.category === "version_substitution" && item.versions) {
    return `${item.versions.dependency}: ship ${item.versions.shipped}, or hold for ${item.versions.expected}?`;
  }
  return item.text;
}

/**
 * The card block for one escalated uncertainty.
 *
 * For `version_substitution` the console genuinely knows both versions, so it
 * offers REAL choices. For every other category it does not know the domain,
 * so it poses the meta-decision it CAN pose correctly and puts the seat's own
 * words in `context` verbatim.
 *
 * Deliberately never fabricates domain-specific labels. It would be wrong often
 * enough that the operator would click through them, and a wrong answer
 * laundered through the decision ledger is worse than no card at all.
 */
function uncertaintyBlock(item: EscalationItem, spilled: readonly EscalationItem[] = []): InteractionQuestion {
  const extra = spilled.length === 0 ? "" : `\n\nAlso open from this seat:\n${spilled.map((other) => `- ${other.text}`).join("\n")}`;
  if (item.category === "version_substitution" && item.versions) {
    const { dependency, shipped, expected } = item.versions;
    return {
      question: uncertaintyQuestion(item),
      header: ESCALATION_HEADER[item.category],
      context: `${item.text}${extra}`,
      options: [
        { label: `Ship ${shipped}`, description: `Keep what is built. ${dependency} stays at ${shipped}.` },
        { label: `Hold for ${expected}`, description: `The version named earlier. May not be reachable right now.` },
      ],
    };
  }
  return {
    question: uncertaintyQuestion(item),
    header: ESCALATION_HEADER[item.category],
    context: `Raised as an uncertainty by the agent that reported it:\n${item.text}${extra}`,
    options: [
      { label: "Proceed anyway", description: "Accept this and keep going." },
      { label: "Stop and fix this first", description: "Treat it as blocking; the work is not done until it is resolved." },
      { label: "I'll answer in chat", description: "Neither option fits — say what you want in your own words." },
    ],
  };
}

/**
 * An assignment carrying a taskId starts that unit; a terminal-status report
 * finishes it. Both are facts the console already holds at this moment.
 */
export function syncLedgerFromHandoff(deps: GovernanceDeps, session: AgentSessionRow, to: string, handoff: HandoffDraft, category: Category): void {
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

/**
 * The task a journaled delivery's handoff was about. The message payload
 * carries only a HandoffSummary (no taskId); the full core lives in
 * handoff_records — read it from there, or the release path would derive
 * `null`, find no blockers, and free every hold on the first task change.
 */
export function deliveryTaskId(deps: GovernanceDeps, messageId: string): string | null {
  const message = deps.repo.getMessageById(messageId);
  const summary = message?.payload?.handoff as { id?: string } | undefined;
  if (!summary?.id || !deps.handoffs) return null;
  try { return deps.handoffs.get(summary.id).core.taskId; } catch { return null; }
}

/**
 * Incomplete blockers of the task this assignment carries. Advisory
 * `blocked_by` edges become a real gate here — before this, `task_dependencies`
 * had eight rows in db-live-2 and nothing ever consulted them.
 */
export function assignmentBlockers(deps: GovernanceDeps, session: AgentSessionRow, to: string, category: Category, taskId: string | null): string[] {
  if (category !== "assignment" || taskId === null || !deps.tasks) return [];
  void to;
  const all = deps.tasks.listForUserSession(session.userSessionId)
    .filter((task) => task.agentSessionId === session.id);
  const target = all.find((task) => task.sdkTaskId === taskId || task.id === taskId);
  if (!target) return [];
  const open: string[] = [];
  for (const blockerId of target.dependencyIds) {
    const blocker = all.find((task) => task.id === blockerId);
    if (blocker && blocker.status !== "completed" && blocker.status !== "deleted") {
      open.push(`"${target.subject}" is blocked_by "${blocker.subject}" (${blocker.status})`);
    }
  }
  return open;
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
export function finalReportBlockers(deps: GovernanceDeps, session: AgentSessionRow, sender: string, to: string, category: Category): Interaction[] {
  if (!isFinalToMain(sender, to, category)) return [];
  return deps.interactions.listUnresolvedForAgentSession(session.id)
    .filter((row) => row.urgency === "blocking");
}

export function isFinalToMain(sender: string, to: string, category: Category): boolean {
  return sender === ORCHESTRATOR_SEAT && to === MAIN_RECIPIENT && category === "final";
}

/**
 * Conditions a `final` report has not met. These used to THROW, which made
 * the operator's report conditional on model-maintained state: in db-live-1
 * the ledger orphaned on rotation, so a `final` was structurally impossible
 * and the operator heard nothing for 35 minutes. The console may enforce
 * only on facts it owns — so unmet conditions now travel WITH the report,
 * where the operator can weigh them, instead of suppressing it.
 */
export function finalReportCaveats(deps: GovernanceDeps, session: AgentSessionRow, sender: string, to: string, category: Category, activeSpecialists: () => string[]): string[] {
  if (sender !== ORCHESTRATOR_SEAT || to !== MAIN_RECIPIENT || category !== "final") return [];
  const caveats: string[] = [];
  if (deps.tasks) {
    const incomplete = deps.tasks.listForUserSession(session.userSessionId).filter((task) => task.agentSessionId === session.id && task.status !== "completed" && task.status !== "deleted");
    if (incomplete.length > 0) caveats.push(`${incomplete.length} task(s) still open in the ledger: ${incomplete.map((task) => task.subject).join(", ")}`);
  }
  const running = activeSpecialists();
  // Only deliveries addressed to SPECIALISTS count as outstanding work: a
  // native final goes out mid-turn, so the very report that woke the
  // coordinator is still unacknowledged in its own inbox.
  const pendingInternal = deps.repo.listActiveDeliveries(session.id).filter((delivery) => delivery.recipient !== MAIN_RECIPIENT && delivery.recipient !== ORCHESTRATOR_SEAT);
  if (running.length > 0) caveats.push(`still running: ${running.join(", ")}`);
  if (pendingInternal.length > 0) caveats.push(`${pendingInternal.length} delivery(ies) to specialists not yet acknowledged`);
  return caveats;
}

/**
 * Read `core.uncertainty[]` and put what belongs to the operator in front of
 * them.
 *
 * Hooked here in `post()` rather than in `HandoffService.prepare` for two
 * reasons. `prepare` is also the ROTATION CHECKPOINT path, and a checkpoint's
 * uncertainty is a seat's private note to its own successor — the wrong
 * audience entirely — and it runs inside `#maybeRotate`'s gate, which blocks
 * every sender to that seat and is the last place to do anything that can
 * wait. `post()` also has what the classifier needs: the interaction service,
 * the decision ledger, and the sender's real profile capabilities.
 *
 * CONSEQUENCE, stated plainly: `post()` is synchronous, so this is
 * fire-and-forget card creation. An auto-promoted BLOCKING item does not stop
 * the seat mid-turn — you cannot retroactively block a tool call that has
 * already returned. It stops the next `final`. The only thing that stops a
 * seat immediately is its own `ask_operator(urgency:'blocking')`. That is
 * precisely why both paths exist.
 */
export function promoteUncertainty(deps: GovernanceDeps, session: AgentSessionRow, sender: string, handoff: HandoffDraft, category: Category): void {
  const interactions = deps.interactions;
  if (!interactions || handoff.core.uncertainty.length === 0) return;
  const senderSeat = sender === MAIN_RECIPIENT ? undefined : deps.repo.getParticipant(session.id, sender);
  const profile = senderSeat?.profileSnapshot as AgentProfile | undefined;
  const items = classifyUncertainty(handoff.core, {
    trigger: category as HandoffTrigger,
    operatorPins: deps.decisions.pins(session.userSessionId),
    operatorConstraints: deps.decisions.constraints(session.userSessionId),
    capabilities: {
      shell: profile?.runtime.shell ?? false,
      browser: profile?.runtime.browser ?? false,
      screenshots: profile?.runtime.screenshots ?? false,
      network: resolvedDomains(profile ?? FALLBACK_PROFILE_RUNTIME, deps.config?.allowedDomains ?? []),
    },
  });
  if (items.length === 0) return;

  // One card per (session, sender). A wall of simultaneous cards is
  // unanswerable, and re-reporting the same uncertainty on every update
  // would otherwise mint one each time.
  const existing = interactions.listUnresolvedForAgentSession(session.id)
    .find((row) => row.source === "uncertainty" && row.participant === sender);
  const already = new Set(
    (existing ? ((existing.payload as { questions?: InteractionQuestion[] }).questions ?? []) : [])
      .map((question) => question.question),
  );
  const fresh = items.filter((item) => !already.has(uncertaintyQuestion(item)));
  if (fresh.length === 0) return;
  if (existing) {
    // Merging into an open card rather than opening a second one keeps the
    // operator's screen honest: one seat, one outstanding ask.
    interactions.mergeQuestions(
      existing.id,
      fresh.slice(0, MAX_QUESTIONS_PER_CARD).map((item) => uncertaintyBlock(item)),
      fresh.some((item) => item.urgency === "blocking") ? "blocking" : undefined,
    );
    return;
  }
  const shown = fresh.slice(0, MAX_QUESTIONS_PER_CARD);
  const spilled = fresh.slice(MAX_QUESTIONS_PER_CARD);
  const blocks = shown.map((item) => uncertaintyBlock(item, spilled));
  interactions.createOperatorQuestion({
    userSessionId: session.userSessionId,
    agentSessionId: session.id,
    participant: sender,
    questions: blocks,
    urgency: fresh.some((item) => item.urgency === "blocking") ? "blocking" : "deferred",
    source: "uncertainty",
    allowFreeText: true,
    dedupeKey: `uncertainty:${sender}`,
  });
}
