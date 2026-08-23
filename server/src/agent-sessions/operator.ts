/**
 * The operator surface: everything the human sees or is owed from an agent
 * session — the derived session status, the operator-debt discharge, the
 * `ask_operator` wait and its governance sweep, and the answer/release notices
 * the Console posts on the operator's behalf. Lane facts arrive through the
 * LaneActivity seam; every post goes through Transfer.
 */
import type { AgentSessionStatus, Interaction, InteractionQuestion, InteractionUrgency } from "@agentique-console/shared";
import type { Config } from "../config.ts";
import type { Repo, AgentRow, AgentSessionRow } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { decisionOf, renderDecision } from "../orchestrator/decisions.ts";
import { dedupeKeyFor, type InteractionService } from "../orchestrator/interactions.ts";
import { ok } from "../sdk/tool-result.ts";
import type { SdkToolResult } from "../sdk/types.ts";
import type { AskOperatorArgs } from "./agent-tools.ts";
import { questionTextOf } from "./composer.ts";
import { TERMINAL_REPORT_TRIGGERS } from "./final-gate.ts";
import { CONSOLE_SENDER, MAIN_RECIPIENT } from "./names.ts";
import type { SessionRouting } from "./routing.ts";
import type { Deliver, LaneActivity, OperatorWaitRef, RecordFailure, SimpleHandoff, Transfer } from "./seams.ts";
import { speakerKindOf } from "./topology.ts";

export interface OperatorSurfaceDeps {
  repo: Repo;
  bus: EventBus;
  config: Config;
  interactions: InteractionService;
  routing: SessionRouting;
  /** Read-only lane facts (busy turns, operator waits) — never the lanes themselves. */
  lanes: LaneActivity;
  transfer: Transfer;
  simpleHandoff: SimpleHandoff;
  /** Console-path delivery, for nudging a released final seat. */
  deliver: Deliver;
  /** `NestingBroker.maybeReleaseParentFinal` — the child-hold release check. */
  maybeReleaseParentFinal: (parent: AgentSessionRow) => void;
  recordFailure: RecordFailure;
  /** Extra per-tick sweep jobs (the pattern-engine sweep), run after ask-detach. */
  sweepTasks: readonly (() => void)[];
  /** The whole-system pause: a paused tick does nothing (cutoffs are wall-clock; the first tick after resume catches up). */
  paused: () => boolean;
  /** Subtree validation for requirement-linked questions; absent in narrow tests. */
  requirements?: { assertWithinDelegation(userSessionId: string, agentSessionId: string, requirementId: string): void };
}

export class OperatorSurface {
  readonly #deps: OperatorSurfaceDeps;
  /** Timer releasing `ask_operator` waits the operator has not returned to. */
  #askSweep: ReturnType<typeof setInterval> | null = null;
  /** Notified when a session's derived status changes; completion re-evaluates. */
  #onStatusChanged: ((userSessionId: string) => void) | undefined;
  #sessionStatus = new Map<string, AgentSessionStatus | null>();
  /** Sessions whose operator obligation is closed — reported, or discharged. */
  readonly #operatorDebtSettled = new Set<string>();

  constructor(deps: OperatorSurfaceDeps) { this.#deps = deps; }

  onStatusChanged(handler: (userSessionId: string) => void): void {
    if (this.#onStatusChanged) throw new Error("onStatusChanged is already registered — wire callbacks once, in createApp");
    this.#onStatusChanged = handler;
  }

  /**
   * The governance clock: any `ask_operator` wait older than
   * `operatorAskDetachMs` is detached — the agent's process frees up while the
   * card stays open on the operator's screen.
   */
  startGovernanceSweep(intervalMs = this.#deps.config.policy.governanceSweepIntervalMs): void {
    if (this.#askSweep) return;
    this.#askSweep = setInterval(() => {
      if (this.#deps.paused()) return;
      const limit = this.#deps.config.policy.operatorAskDetachMs;
      const cutoff = Date.now() - limit;
      for (const wait of this.#deps.lanes.operatorWaits()) {
        if (wait.since < cutoff) {
          this.#detachOperatorAsk(wait, `no answer within ${Math.round(limit / 60_000)} minutes; the question stays open`);
        }
      }
      for (const task of this.#deps.sweepTasks) task();
    }, intervalMs);
    this.#askSweep.unref?.();
  }

  stopGovernanceSweep(): void {
    if (this.#askSweep) clearInterval(this.#askSweep);
    this.#askSweep = null;
  }

  /**
   * Hand an agent an answer its own tool call can no longer return.
   *
   * An agent is not revived by a lane the way main is — it is woken by a
   * delivery. So when its parked promise died (park, rotation, watchdog, or a
   * server restart) the answer arrives as a journaled `decision` handoff from
   * the coordinator's address, which is a legal `assertRoute` edge where a
   * `system` speaker would not be. The dedupe key makes a double answer a
   * no-op.
   */
  deliverOperatorAnswer(interaction: Interaction): void {
    if (!interaction.agentSessionId || !interaction.agent) return;
    const asked = questionTextOf(interaction);
    // The route resolved the row before calling this — render from the durable
    // record, through the one canonical renderer, so the agent reads exactly
    // what every later prompt will say.
    const decision = decisionOf(this.#deps.interactions.get(interaction.id));
    const answer = decision === null ? `${asked} → (no answer recorded)` : renderDecision(decision);
    const session = this.#deps.repo.getAgentSession(interaction.agentSessionId);
    if (!session) return;
    this.#deps.transfer({
      agentSessionId: interaction.agentSessionId,
      speaker: { kind: "system", name: CONSOLE_SENDER },
      to: interaction.agent,
      handoff: this.#deps.simpleHandoff(
        `Operator answered: ${asked}`,
        "pending",
        `${answer}\n\nThis answer was recorded by the Console, not relayed by your coordinator. It is authoritative — do not re-litigate it, and do not ask again.`,
        "Continue from the operator's decision.",
      ),
      category: "decision",
      dedupeKey: `answer:${interaction.id}`,
    });
  }

  /**
   * The other half of the final gate: when a session's LAST blocking question
   * clears, the Console tells both ends — the coordinator learns it may
   * report, and main learns why the report it was expecting was late.
   * Registered by `main.ts` on the interaction service.
   */
  onBlockingQuestionsCleared(userSessionId: string, agentSessionId: string): void {
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (!session || session.lifecycle !== "open") return;
    const finalSeat = this.#deps.routing.completionAgent(session, "finalFrom");
    const voiceSeat = this.#deps.routing.completionAgent(session, "voice");
    const hadLane = this.#deps.lanes.hasLane(agentSessionId, finalSeat);
    // Only meaningful if a final was actually withheld from this session —
    // derived from the durable handoff.final.blocked event, not an in-memory
    // set a restart wipes.
    if (!this.finalWithheld(session)) return;
    try {
      this.#deps.transfer({
        agentSessionId,
        speaker: { kind: speakerKindOf(this.#deps.repo.getAgent(agentSessionId, voiceSeat)), name: voiceSeat },
        to: MAIN_RECIPIENT,
        handoff: this.#deps.simpleHandoff(
          "Operator answered; the withheld final can now be sent",
          "in_progress",
          "A final report from this session was withheld while the operator had unanswered questions. They have now answered, and the coordinator has been told it may report.",
          "Expect the coordinator's final shortly.",
        ),
        category: "milestone",
      });
    } catch { /* the notice is best effort; the reporting agent still gets its delivery */ }
    if (hadLane) void this.#deps.deliver(agentSessionId, finalSeat).catch(() => undefined);
    void userSessionId;
  }

  /**
   * A final from this session was withheld and its real final has not landed
   * since — derived from the durable `handoff.final.blocked` event plus the
   * session's own status, so it survives restarts.
   */
  finalWithheld(session: AgentSessionRow): boolean {
    return this.statusOf(session) !== "reported" && this.#deps.repo.hasEvent("handoff.final.blocked", session.id);
  }

  /**
   * Cut a blocking `ask_operator` loose. The tool call returns, the turn ends,
   * and the question stays open — the answer will arrive as a delivery.
   */
  #detachOperatorAsk(wait: OperatorWaitRef, reason: string): void {
    this.#deps.interactions.detach(wait.interactionId, reason);
    wait.release();
  }

  /**
   * An agent putting a question to the human.
   *  - a duplicate returns the OPEN card rather than minting a second one;
   *  - a blocking wait is bounded by ONE mechanism, the operatorAskDetachMs
   *    timer: the agent's process frees up, the card stays open and blocking;
   *  - nothing here EVER returns `isError` — a dismissal, a detach or an
   *    expiry is not the agent's mistake, and error results feed the
   *    error-streak watchdog.
   */
  async askOperator(session: AgentSessionRow, seat: AgentRow, args: AskOperatorArgs): Promise<SdkToolResult> {
    const interactions = this.#deps.interactions;
    if (!interactions) return ok({ resolved: false, reason: "the console cannot reach the operator right now" });
    const dedupeKey = dedupeKeyFor(seat.name, args.question);
    const open = interactions.findUnresolvedByDedupe(session.id, dedupeKey);
    if (open) {
      return ok({ queued: true, interactionId: open.id, deduped: true,
        note: "You already asked this and the card is still open on the operator's screen. Do not ask again; keep working or stop." });
    }
    const urgency: InteractionUrgency = args.urgency;

    // A requirement-linked question must link only inside the seat's
    // delegation — the same subtree law as report_requirement. Out-of-scope
    // ids are the seat's mistake, reported as one (not an isError, which
    // would feed the error-streak watchdog... except this IS actionable:
    // the seat retries with in-scope ids or drops the link).
    const requirementIds = [...new Set(args.requirementIds ?? [])];
    if (requirementIds.length > 0 && this.#deps.requirements) {
      try {
        for (const id of requirementIds) {
          this.#deps.requirements.assertWithinDelegation(session.userSessionId, session.id, id);
        }
      } catch (error) {
        return ok({ resolved: false, invalidRequirementIds: true,
          reason: error instanceof Error ? error.message : String(error),
          note: "Ask again with requirement ids inside your delegated sub-scope, or omit requirementIds." });
      }
    }

    const question: InteractionQuestion = {
      question: args.question,
      ...(args.header ? { header: args.header } : {}),
      ...(args.context ? { context: args.context } : {}),
      options: args.options,
      ...(args.recommendation ? { recommendation: args.recommendation } : {}),
    };
    // Its OWN controller, chained to the lane's, so park/rotation/watchdog can
    // release this one wait without taking the lane down with it.
    const abort = new AbortController();
    const pending = interactions.createOperatorQuestion({
      userSessionId: session.userSessionId,
      agentSessionId: session.id,
      agent: seat.name,
      questions: [question],
      urgency,
      source: "agent",
      ...(args.recommendation ? { recommendation: args.recommendation } : {}),
      allowFreeText: args.allowFreeText,
      dedupeKey,
      signal: abort.signal,
      ...(requirementIds.length === 0 ? {} : { requirementIds }),
    });

    if (urgency === "deferred") {
      return ok({ queued: true, interactionId: pending.id, urgency: "deferred",
        note: "The operator can see this now. Their answer will be handed to you at your next delivery — keep working; do not poll." });
    }

    const clearWait = this.#deps.lanes.bindOperatorWait(session.id, seat.name, { interactionId: pending.id, since: Date.now(), abort });
    this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, agent: seat.name, detail: `waiting on the operator (${pending.id})` } });
    try {
      const resolved = await pending.resolution;
      if (resolved.kind === "answers") {
        return ok({ resolved: true, interactionId: pending.id, answers: resolved.answers,
          ...(resolved.freeText === undefined ? {} : { freeText: resolved.freeText }),
          ...(resolved.note === undefined ? {} : { note: resolved.note }),
          ledger: "Recorded as an operator decision; every seat in this session now sees it, so do not relay it." });
      }
      return ok({ resolved: false, interactionId: pending.id,
        reason: resolved.kind === "dismissed" ? resolved.reason : "the operator declined" });
    } finally {
      clearWait();
    }
  }

  /** Memo cleanup on archive — the lifecycle's `#forget` calls this. */
  forget(agentSessionId: string): void {
    this.#sessionStatus.delete(agentSessionId);
    this.#operatorDebtSettled.delete(agentSessionId);
  }

  refreshStatus(agentSessionId: string): void {
    const row = this.#deps.repo.getAgentSession(agentSessionId);
    if (!row || row.lifecycle !== "open") return;
    const computed = this.statusOf(row);
    const status = computed === "working" ? "working" : "idle";
    this.setStatus(agentSessionId, status);
    // A child settling into `reported` may be the LAST hold on its parent's
    // withheld final — the delivery acks that gate the flip land after the
    // boundary hop itself, so this recompute is the reliable release point.
    if (computed === "reported" && row.parentAgentSessionId !== null) {
      const parent = this.#deps.repo.getAgentSession(row.parentAgentSessionId);
      if (parent && parent.lifecycle === "open") this.#deps.maybeReleaseParentFinal(parent);
    }
    if (status === "idle") this.#dischargeOperatorDebt(row);
  }

  /**
   * The backstop, called by run completion when it decides a run is NOT done.
   * `refreshStatus` discharges on the idle transition, but that moment can be
   * one where the session's own delivery is still in flight — and nothing
   * re-triggers afterwards. Run completion re-evaluates on a quiet timer, so it
   * is the right place to ask again. Idempotent: `#operatorDebtSettled` and the
   * dedupe on the posted notice make repeats no-ops.
   */
  dischargeQuietDebts(userSessionId: string): void {
    for (const session of this.#deps.repo.listAgentSessions(userSessionId)) {
      if (session.lifecycle !== "open") continue;
      if (this.statusOf(session) === "working") continue;
      this.#dischargeOperatorDebt(session);
    }
  }

  /**
   * An AgentSession that accepted an assignment owes the operator a reply. The
   * coordinator is asked to send it, but the obligation is the CONSOLE's.
   * Discharged from whatever evidence exists: the coordinator's last report,
   * or failing that every agent's last word. An incomplete report beats
   * silence.
   */
  #dischargeOperatorDebt(session: AgentSessionRow): void {
    if (this.#operatorDebtSettled.has(session.id)) return;
    const { repo } = this.#deps;
    if (repo.listActiveDeliveries(session.id).length > 0) return;
    // The SAME predicate the status derivation uses. Reading "any handoff to
    // main" here is what let a non-final update settle the obligation while
    // run completion still considered the run unfinished.
    if (this.reportedFinal(session)) { this.#operatorDebtSettled.add(session.id); return; }

    const voiceSeat = this.#deps.routing.completionAgent(session, "voice");
    let coordinator = repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, sender: voiceSeat, excludeCheckpoints: true, excludeSynthetic: true });
    let seatReports = repo.listAgents(session.id)
      .filter((seat) => seat.name !== voiceSeat)
      .map((seat) => repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, sender: seat.name, excludeCheckpoints: true, excludeSynthetic: true }))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
    let allSynthetic = false;
    if (!coordinator && seatReports.length === 0) {
      // Every record may be console-synthesized (each seat's only handoff was
      // a turn-failure the console wrote FOR it — the exact shape a killed
      // process leaves). Bailing here was the silence this closeout exists to
      // prevent: fall back to the synthetic evidence, labelled as such, and
      // stay silent only for a session that never produced ANYTHING.
      coordinator = repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, sender: voiceSeat, excludeCheckpoints: true });
      seatReports = repo.listAgents(session.id)
        .filter((seat) => seat.name !== voiceSeat)
        .map((seat) => repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, sender: seat.name, excludeCheckpoints: true }))
        .filter((row): row is NonNullable<typeof row> => row !== undefined);
      if (!coordinator && seatReports.length === 0) return;
      allSynthetic = true;
    }

    // Exactly once per BODY OF EVIDENCE, journaled rather than remembered.
    // The in-memory latch alone is not enough: this closeout wakes main, that
    // wake flips the session to `working`, and `setStatus` re-arms the debt —
    // so an unreported session posted the same notice on every flap. Keying
    // the delivery to the reports it summarizes means new work (new report
    // ids) earns a new closeout and unchanged work earns silence, across
    // restarts too.
    const dedupeKey = `closeout:${[coordinator?.id, ...seatReports.map((row) => row.id)].filter(Boolean).sort().join(",")}`;
    if (repo.findDeliveryByDedupe(session.id, voiceSeat, MAIN_RECIPIENT, dedupeKey)) {
      this.#operatorDebtSettled.add(session.id);
      return;
    }

    this.#operatorDebtSettled.add(session.id);
    const lines = seatReports.map((row) => `- ${row.sender} (${row.core.status}): ${row.core.state.summary.slice(0, 1_500)}`);
    const summary = `This AgentSession went idle without its coordinator reporting a result, so the Console is closing the loop from the journal. Nothing below was assembled or endorsed by the coordinator.\n\n` +
      `${allSynthetic ? "EVERY record below is Console-synthesized — no agent authored a report; these are failure reconstructions the Console wrote for dead turns.\n\n" : ""}` +
      `${coordinator ? `Coordinator's last word (${coordinator.core.status}): ${coordinator.core.state.summary.slice(0, 2_000)}\n\n` : ""}` +
      `${lines.length > 0 ? `Specialist reports:\n${lines.join("\n")}` : "No specialist reported."}`;
    this.#deps.bus.append({ type: "agent_session.closeout.forced", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, agentReports: seatReports.length, hadCoordinatorReport: coordinator !== undefined } });
    try {
      this.#deps.transfer({ agentSessionId: session.id, speaker: { kind: speakerKindOf(repo.getAgent(session.id, voiceSeat)), name: voiceSeat }, to: MAIN_RECIPIENT,
        handoff: this.#deps.simpleHandoff("AgentSession went idle without a final report", "needs_verification", summary,
          "Review the seat reports above and decide whether the work is complete."), category: "milestone", dedupeKey });
    } catch (error) { this.#deps.recordFailure(session.id, error); }
  }

  /**
   * THE "has this session reported?" predicate. `statusOf`, the operator-debt
   * discharge, the pattern stall sweep and run completion all read this one
   * function — they used to each ask their own version, and a run died silent
   * when three of them said "reported" while the fourth said "not final".
   *
   * A report is the reporting agent's OWN terminal verdict to main: `final` or
   * `failure`. Anything else it sends main — progress, a milestone — leaves the
   * obligation open.
   */
  reportedFinal(row: AgentSessionRow): boolean {
    const reported = this.#deps.repo.latestHandoff({
      userSessionId: row.userSessionId, agentSessionId: row.id,
      recipient: MAIN_RECIPIENT, sender: this.#deps.routing.completionAgent(row, "finalFrom"), excludeCheckpoints: true,
      // Only what the reporting agent ITSELF sent counts as having reported.
      excludeSynthetic: true,
    });
    return reported !== undefined && TERMINAL_REPORT_TRIGGERS.has(reported.trigger);
  }

  /**
   * `reported` distinguishes a completed run from a dead one. A turn parked in
   * `ask_operator` does NOT count as working: the agent is waiting on a human.
   */
  statusOf(row: AgentSessionRow): AgentSessionStatus {
    if (row.lifecycle === "archived") return "archived";
    if (this.#deps.lanes.hasBusyTurnExcludingOperatorWaits(row.id)) return "working";
    if (this.#deps.repo.listQueuedDeliveries(row.id).some((d) => d.recipient !== MAIN_RECIPIENT)) return "working";
    if (this.reportedFinal(row) && this.#deps.repo.listActiveDeliveries(row.id).length === 0) {
      // Bottom-up settling: a parent has not truly reported while an open
      // child still owes its final — the parent's report could not have
      // reflected work that has not concluded.
      const unsettledChild = this.#deps.repo.listChildSessions(row.id)
        .some((child) => child.lifecycle === "open" && this.statusOf(child) !== "reported");
      return unsettledChild ? "idle" : "reported";
    }
    return "idle";
  }

  setStatus(id: string, status: AgentSessionStatus): void {
    const session = this.#deps.repo.getAgentSession(id);
    // Every status transition may be the one that completes the run, so the
    // predicate gets a chance to look. It is debounced; this is cheap.
    if (session) this.#onStatusChanged?.(session.userSessionId);
    const last = this.#sessionStatus.get(id) ?? null;
    // New work re-opens the obligation: a session that was discharged once and
    // then given more to do owes the operator another word.
    if (status === "working") this.#operatorDebtSettled.delete(id);
    if (last === status) return;
    if (last === null && status === "idle") { this.#sessionStatus.set(id, status); return; }
    this.#sessionStatus.set(id, status);
    if (!session) return;
    this.#deps.bus.append({ type: "agent_session.status.changed", userSessionId: session.userSessionId, agentSessionId: id, payload: { agentSessionId: id, status } });
  }
}
