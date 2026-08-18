/**
 * The mailroom: the ONE transfer path for agent sessions. `post` journals and
 * routes every hop — briefings, agent reports, failure notices, redelivery —
 * which is what makes the governance gates inescapable; `deliver` carries
 * queued journal rows into a lane through the DeliverySelector and Injector
 * seams. Runtime, operator, and nesting reach back only through typed
 * callbacks wired where the service constructs the modules.
 */
import type { AgentSessionStatus, HandoffDraft, HandoffTrigger, Speaker } from "@agentique-console/shared";
import type { AgentProfile } from "../agent-profiles/registry.ts";
import type { Config } from "../config.ts";
import type {
  Repo,
  AgentRow,
  AgentSessionRow,
  MailboxDeliveryRow,
  MessageRow,
} from "../db/repo.ts";
import { toWireMessage } from "../api/wire.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import type { EventBus } from "../events/bus.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { nowIso } from "../ids.ts";
import type { DecisionLedger } from "../orchestrator/decisions.ts";
import type { InteractionService } from "../orchestrator/interactions.ts";
import type { AssignmentScheduler } from "../tasks/scheduler.ts";
import type { TaskService } from "../tasks/service.ts";
import { PromptComposer, questionTextOf, summarizeAnswer } from "./composer.ts";
import {
  finalReportBlockers,
  finalReportCaveats,
  isFinalToMain,
  promotedCategory,
  TERMINAL_REPORT_TRIGGERS,
  WithheldFinalError,
  type Category,
} from "./final-gate.ts";
import { syncLedgerFromHandoff } from "./ledger-sync.ts";
import { MAIN_RECIPIENT } from "./names.ts";
import type { PatternHop } from "./patterns/engine.ts";
import type { SessionRouting } from "./routing.ts";
import type {
  BoundaryBroker,
  DeliverySelector,
  Injector,
  LaneActivity,
  RecordFailure,
  TransferInput,
} from "./seams.ts";
import type { WorktreeBinding } from "./worktree-binding.ts";

/** Categories that wake main (or cross a child boundary) on arrival. */
export const MATERIAL_CATEGORIES = new Set(["milestone", "failure", "final", "decision"]);

/** The default DeliverySelector: every queued row goes. */
export const identitySelector: DeliverySelector = { select: (_session, _agent, queuedRows) => queuedRows };

/**
 * A Console-authored notice draft. Every draft minted here is marked
 * `consoleSynthesized`: models never write through this path, and the status
 * derivation must tell a report the COORDINATOR sent from a notice the
 * Console posted in its name.
 */
export function simpleHandoff(action: string, status: HandoffDraft["core"]["status"], summary: string, nextAction: string | null): HandoffDraft {
  return { core: { schemaVersion: 1, taskId: null, status, risk: status === "failed" || status === "blocked" ? "high" : "medium",
    action, state: { summary, evidence: [] }, result: { summary: null, artifacts: [] }, uncertainty: [], nextAction,
    requestExpandedContext: status === "failed" }, extension: { kind: "generic", data: { consoleSynthesized: true } } };
}

export interface MailroomDeps {
  repo: Repo;
  bus: EventBus;
  config: Config;
  interactions: InteractionService;
  decisions: DecisionLedger;
  tasks: TaskService;
  handoffs: HandoffService;
  /** Lazy — the scheduler posts through the transfer path, so it composes later. */
  scheduler: () => AssignmentScheduler;
  wake: (userSessionId: string, agentSessionId: string, category: Category, text: string) => void;
  routing: SessionRouting;
  worktree: WorktreeBinding;
  composer: PromptComposer;
  /** Read-only lane facts, for the final-report caveat scan. */
  lanes: LaneActivity;
  selector: DeliverySelector;
  /** True while a capacity/budget pause holds — deliver() then leaves work queued. */
  capacityPaused: () => boolean;
  /** Spawn or unpark the recipient so its lane accepts input (`ensureSeatLive`). */
  ensureLive: (agentSessionId: string, seat: string) => Promise<void>;
  injector: Injector;
  /** The status derivation, for the unsettled-children hold (operator surface). */
  sessionStatus: (row: AgentSessionRow) => AgentSessionStatus;
  boundary: BoundaryBroker;
  /** The pattern engine's post hook, context-bound by the service. */
  onPatternPost: (session: AgentSessionRow, hop: PatternHop) => void;
  recordFailure: RecordFailure;
}

export class Mailroom {
  readonly #deps: MailroomDeps;

  constructor(deps: MailroomDeps) { this.#deps = deps; }

  /**
   * The ONE transfer path: journal, then deliver by pushing into the
   * recipient's lane input. Every hop — briefings, agent reports via the
   * `send_handoff` tool, failure notices, redelivery — comes through here,
   * which is what makes the governance gates below inescapable.
   */
  post(input: TransferInput): MessageRow {
    const { repo } = this.#deps;
    const session = repo.getAgentSession(input.agentSessionId);
    if (!session) throw new NotFoundError(`no agent session ${input.agentSessionId}`);
    if (session.lifecycle !== "open") throw new ConflictError(`agent session ${input.agentSessionId} is archived`);
    const finalSeat = this.#deps.routing.completionAgent(session, "finalFrom");
    // Promote BEFORE the route check and the gates: a report the Console
    // recognises as final must be route-checked, gated and journaled as one.
    const requested = input.category ?? "update";
    const category = promotedCategory(finalSeat, input.speaker.name, input.to, requested, input.handoff.core.status);
    if (category !== requested) {
      this.#deps.bus.append({ type: "handoff.category.promoted", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, sender: input.speaker.name, from: requested, to: category, status: input.handoff.core.status } });
    }
    const edge = this.#deps.routing.assertRoute(session, input.speaker.name, input.to, category);
    if (input.dedupeKey) {
      const prior = repo.findDeliveryByDedupe(session.id, input.speaker.name, input.to, input.dedupeKey);
      const priorMessage = prior ? repo.getMessageById(prior.messageId) : undefined;
      if (priorMessage) return priorMessage;
    }
    // Withheld BEFORE journalling, so a blocked final leaves no half-record.
    const blockers = finalReportBlockers(this.#deps, session, finalSeat, input.speaker.name, input.to, category);
    if (blockers.length > 0) {
      this.#deps.bus.append({ type: "handoff.final.blocked", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, sender: input.speaker.name, interactionIds: blockers.map((row) => row.id) } });
      const now = Date.now();
      const structured = blockers.map((row) => ({
        id: row.id,
        question: questionTextOf(row),
        asker: row.agent ?? "main",
        ageMinutes: Math.max(0, Math.round((now - Date.parse(row.createdAt)) / 60_000)),
      }));
      const listed = structured
        .map((b) => `[${b.id}] "${b.question}" (asked ${b.ageMinutes}m ago by ${b.asker})`)
        .join("; ");
      throw new WithheldFinalError(structured,
        `final report withheld: ${blockers.length} question(s) this session put to the operator ${blockers.length === 1 ? "is" : "are"} still unanswered — ${listed}. ` +
        `Those cards are on the operator's screen now; you cannot answer them and neither can main. ` +
        `This is a hold, not a failure — do not re-send the same final. ` +
        `Either continue other work, or send category:"milestone" with what you have. ` +
        `When the operator answers, the Console delivers their answer to you and you may report final then.`,
      );
    }
    // A parent's final waits for its children: their finals are the boundary
    // milestones the report must reflect, and abandon_child_session is the
    // deliberate escape hatch for one that no longer matters. A hold, never an
    // error — the release notice fires when the last child reports.
    if (isFinalToMain(finalSeat, input.speaker.name, input.to, category)) {
      const unsettled = repo.listChildSessions(session.id).filter((child) => child.lifecycle === "open" && this.#deps.sessionStatus(child) !== "reported");
      if (unsettled.length > 0) {
        this.#deps.bus.append({ type: "handoff.final.blocked", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { agentSessionId: session.id, sender: input.speaker.name, interactionIds: [] } });
        throw new WithheldFinalError([],
          `final report withheld: ${unsettled.length} child session(s) of this session have not reported — ${unsettled.map((child) => `"${child.title}" (${child.id})`).join("; ")}. ` +
          `Their finals arrive to you as milestones; wait for them, or abandon_child_session the ones that no longer matter. ` +
          `This is a hold, not a failure — do not re-send the same final.`);
      }
    }
    const caveats = finalReportCaveats(this.#deps, session, finalSeat, input.speaker.name, input.to, category, () =>
      this.#deps.lanes.namesWithActiveTurn(session.id).filter((name) => name !== input.speaker.name));
    if (caveats.length > 0) {
      input = { ...input, handoff: { ...input.handoff, core: { ...input.handoff.core,
        uncertainty: [...input.handoff.core.uncertainty, `Console: reported final with work outstanding — ${caveats.join("; ")}.`] } } };
      this.#deps.bus.append({ type: "handoff.final.caveats", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, sender: input.speaker.name, caveats } });
    }
    // The ledger follows the journal, not a coordinator's memory.
    syncLedgerFromHandoff(this.#deps, session, input.speaker.name, input.to, input.handoff, category);
    const { message, delivery, text } = this.#journal(session, input.speaker, input.to, input.handoff, category, {
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}), ...(input.turnId ? { turnId: input.turnId } : {}),
    });
    if (input.to === MAIN_RECIPIENT) {
      // The report that concludes the session lands the session's work, before
      // anyone is told about it — so the files exist by the time the report is
      // read. A seat that never declares itself "completed" (the evaluator
      // loop's generator is instructed to do exactly that) lands here or never:
      // one live run shipped a finished deliverable and left the operator's
      // workspace empty. Child sessions land the same way; their controller is
      // reading the same workspace.
      if (TERMINAL_REPORT_TRIGGERS.has(category) && input.speaker.name === finalSeat) {
        try { this.#deps.worktree.landForSession(session); }
        catch (error) { this.#deps.recordFailure(session.id, error); }
      }
      if (session.parentAgentSessionId !== null) {
        // A child session's "main" is its parent's controller. The literal
        // stays "main" in the child's journal and every governance predicate;
        // only the SINK differs: re-post the handoff verbatim into the parent
        // (its own record, mailbox row, and lane wake), then ack child-side.
        // The dedupe key makes a crash between re-post and ack replay-safe.
        // The parent's release check runs AFTER the ack — before it, this very
        // delivery still counts the child as unsettled.
        if (MATERIAL_CATEGORIES.has(category)) this.#deps.boundary.crossBoundary(session, message, input.handoff, category);
        this.patchDelivery(session, delivery, "acknowledged");
        if (category === "final" || category === "failure") {
          const parent = session.parentAgentSessionId === null ? undefined : this.#deps.repo.getAgentSession(session.parentAgentSessionId);
          if (parent && parent.lifecycle === "open") this.#deps.boundary.maybeReleaseParentFinal(parent);
        }
      } else {
      this.patchDelivery(session, delivery, "acknowledged");
      if (MATERIAL_CATEGORIES.has(category)) {
        // Answered operator questions ride along with the next material wake.
        // Not marked flushed here: `flushed_at` means the ASKING AGENT has
        // been told, and main is not the asker.
        const answered = this.#deps.interactions.listAnsweredUnflushed(session.id);
        const decisions = answered.map((row) => summarizeAnswer(row)).filter((line) => line !== "");
        const wakeText = decisions.length === 0 ? text
          : `${text}\n\nOperator decisions answered since your last update:\n${decisions.map((line, index) => `${index + 1}. ${line}`).join("\n")}`;
        const openAsks = this.#deps.interactions.listUnresolvedForAgentSession(session.id)
          .filter((row) => row.agent !== null);
        const withAsks = openAsks.length === 0 ? wakeText
          : `${wakeText}\n\nStill waiting on the operator (you cannot answer these; only they can):\n${openAsks.map((row) => `- ${row.agent}: ${questionTextOf(row)}`).join("\n")}`;
        this.#deps.bus.append({ type: "agent_session.result.returned", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { userSessionId: session.userSessionId, agentSessionId: session.id, digestPreview: text.slice(0, 140) } });
        this.#deps.wake?.(session.userSessionId, session.id, category, withAsks);
      }
      }
    } else {
      // A router edge delivers now; a console-advanced edge stays journaled
      // and queued for the pattern progression to carry (joins, stages).
      if (edge.advance === "immediate") {
        void this.deliver(session.id, input.to).catch((error) => this.#deps.recordFailure(session.id, error));
      }
    }
    // Counters and termination bounds see every hop, AFTER it is journaled and
    // routed — a trip defers its own action, so this cannot fail the transfer.
    try {
      this.#deps.onPatternPost(session, { sender: input.speaker.name, recipient: input.to, category,
        status: input.handoff.core.status,
        synthetic: (input.handoff.extension?.data as { consoleSynthesized?: boolean } | undefined)?.consoleSynthesized === true,
        countsRound: edge.countsRound === true, advance: edge.advance });
    } catch (error) { this.#deps.recordFailure(session.id, error); }
    return message;
  }

  /**
   * `operatorDecisions` for a coordination-extension handoff, and nothing for
   * any other kind — the field only exists on `CoordinationHandoffData`.
   */
  #coordinationDefaults(session: AgentSessionRow, speaker: Speaker, senderSeat: AgentRow | undefined): { extensionDefaults?: Record<string, unknown> } {
    const kind = speaker.name === MAIN_RECIPIENT
      ? "coordination"
      : (senderSeat?.profileSnapshot as AgentProfile | undefined)?.handoffExtension;
    if (kind !== "coordination") return {};
    const lines = this.#deps.decisions.lines(session.userSessionId, { max: 12 });
    if (lines.length === 0) return {};
    return { extensionDefaults: { operatorDecisions: lines } };
  }

  /** Journal core: persist the handoff and mint its mailbox delivery. */
  #journal(session: AgentSessionRow, speaker: Speaker, to: string, handoff: HandoffDraft, category: Category, opts: {
    dedupeKey?: string; turnId?: string;
  }): { message: MessageRow; delivery: MailboxDeliveryRow; text: string; handoffId: string } {
    const { repo, bus } = this.#deps;
    if (!this.#deps.handoffs) throw new Error("handoff service unavailable");
    const senderSeat = speaker.name === MAIN_RECIPIENT ? undefined : repo.getAgent(session.id, speaker.name);
    const prepared = this.#deps.handoffs.prepare({
      draft: handoff, userSessionId: session.userSessionId, agentSessionId: session.id,
      sender: speaker.name, recipient: to,
      profileId: speaker.name === MAIN_RECIPIENT ? "main" : senderSeat?.profileId ?? null,
      extensionKind: speaker.name === MAIN_RECIPIENT ? "coordination" : (senderSeat?.profileSnapshot as AgentProfile | undefined)?.handoffExtension,
      generation: speaker.name === MAIN_RECIPIENT ? (repo.getUserSession(session.userSessionId)?.sdkGeneration ?? 0) : senderSeat?.generation ?? 0,
      turnId: opts.turnId, trigger: category as HandoffTrigger,
      parentHandoffId: category === "assignment" ? null : (senderSeat?.latestHandoffId ?? (speaker.name === MAIN_RECIPIENT ? repo.getUserSession(session.userSessionId)?.latestHandoffId : null)),
      // A coordination handoff carries the operator's decisions with it, so a
      // recipient reading only the envelope still knows what was decided.
      ...(this.#coordinationDefaults(session, speaker, senderSeat)),
      ...(senderSeat?.worktreePath ? { resolveRoot: senderSeat.worktreePath } : {}),
    });
    const text = prepared.text;
    const { message, delivery } = repo.appendHandoffMailbox({
      sessionKind: "agent", sessionId: session.id, userSessionId: session.userSessionId,
      agentSessionId: session.id, speaker, to, recipient: to,
      kind: "message" as const,
      text, category, handoff: prepared.row, summary: prepared.summary,
      ...(opts.turnId ? { turnId: opts.turnId } : {}), ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}),
    });
    // Latest-handoff pointers, chosen HERE where the recipient is known — the
    // store offers the two targets and never branches on a domain sentinel.
    for (const agent of new Set([to, speaker.name])) {
      if (agent === MAIN_RECIPIENT) repo.setMainLatestHandoff(session.userSessionId, prepared.row.id);
      else repo.setAgentLatestHandoff(session.id, agent, prepared.row.id);
    }
    this.#deps.handoffs.committed(prepared.record);
    if (senderSeat?.worktreePath) {
      const status = prepared.record.core.status;
      // `synthetic` distinguishes "the agent judged its work failed" from "the
      // console reported failure FOR a dead agent" — the landing disposition
      // differs (delete vs archive). Derived exactly as the row's synthetic
      // column is (line ~237).
      const synthetic = (prepared.record.extension?.data as { consoleSynthesized?: boolean } | undefined)?.consoleSynthesized === true;
      if (status === "completed" || status === "failed") this.#deps.worktree.landOnReport(session, senderSeat, status, { synthetic });
      // Not terminal, but the work still moved: commit it so the branch tells
      // the truth the moment the handoff does. A recipient seated on this
      // branch is spawned from inside this very call.
      else this.#deps.worktree.snapshot(session.id, senderSeat.name, `seat ${senderSeat.name}: handoff ${prepared.row.id}`);
    }
    bus.append({ type: "agent_session.message.appended", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, message: toWireMessage(message) } });
    bus.append({ type: "agent_session.delivery.updated", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, deliveryId: delivery.id, messageSeq: message.seq, sender: speaker.name, recipient: to, category, status: "queued" } });
    return { message, delivery, text, handoffId: prepared.row.id };
  }

  /**
   * Console-path delivery: render queued journal rows into the lane input.
   * Selection, marking, and composition live here; the mint-or-steer push is
   * the Injector's.
   */
  async deliver(agentSessionId: string, recipient: string): Promise<void> {
    // Capacity pause: deliveries stay queued (never cancelled) and redeliver
    // on resume; not even the recipient's process is spawned.
    if (this.#deps.capacityPaused()) return;
    await this.#deps.ensureLive(agentSessionId, recipient);
    // Re-check after the spawn wait: a pause pressed while the seat was
    // waking must not slip a delivery through (rows flip to `delivered`
    // only below, so nothing is lost by returning here).
    if (this.#deps.capacityPaused()) return;
    const { repo } = this.#deps;
    const session = repo.getAgentSession(agentSessionId);
    const seatRow = repo.getAgent(agentSessionId, recipient);
    if (!session || !this.#deps.injector.ready(agentSessionId, recipient) || !seatRow) return;
    const queued = repo.listUnackedDeliveries(agentSessionId, recipient).filter((row) => row.status === "queued");
    if (queued.length === 0) return;
    const rows = this.#deps.selector.select(session, seatRow, queued);
    if (rows.length === 0) return;
    const messages = rows.map((row) => repo.getMessageById(row.messageId)).filter((row): row is MessageRow => row !== undefined);
    for (const row of rows) this.patchDelivery(session, row, "delivered");
    if (rows.some((row) => row.category === "assignment")) this.#deps.injector.resetAssignmentTurns(agentSessionId, recipient);
    const prompt = this.#deps.composer.deliveryPrompt(session, seatRow, messages);
    this.#deps.injector.inject(session, recipient, rows, prompt);
  }

  patchDelivery(session: AgentSessionRow, delivery: MailboxDeliveryRow, status: "queued" | "delivered" | "acknowledged" | "cancelled"): void {
    const now = nowIso();
    // `deliveredAt: now` on the acknowledged path is a FLOOR, not an
    // overwrite: repo.patchDelivery coalesces it against whatever is already
    // stored, so an ack only fills the field in when delivery never stamped it.
    this.#deps.repo.patchDelivery(delivery.id, { status, ...(status === "delivered" ? { deliveredAt: now } : {}), ...(status === "acknowledged" ? { acknowledgedAt: now, deliveredAt: now } : {}) });
    const message = this.#deps.repo.getMessageById(delivery.messageId);
    this.#deps.bus.append({ type: "agent_session.delivery.updated", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, deliveryId: delivery.id, messageSeq: message?.seq ?? 0, sender: delivery.sender, recipient: delivery.recipient, category: delivery.category, status } });
  }
}
