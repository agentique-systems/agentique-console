/**
 * The nesting broker: every hop across a child-session boundary. Boundary
 * posts are dedupe-keyed (`child:<handoffId>`, `child-abandoned:<childId>`,
 * `children-clear:<parentId>`) so a crash between a child's journal write and
 * its boundary ack replays idempotently — `redriveChildBoundary` is that
 * replay. Archival is not owned here: the broker decides, the lifecycle's
 * `archiveOne` archives.
 */
import type { AgentSessionStatus, HandoffDraft } from "@agentique-console/shared";
import type { AgentSessionRow, MailboxDeliveryRow, MessageRow, Repo } from "../db/repo.ts";
import { InvalidInputError } from "../errors.ts";
import type { EventBus } from "../events/bus.ts";
import type { HandoffService } from "../handoffs/service.ts";
import type { Category } from "./final-gate.ts";
import { MATERIAL_CATEGORIES } from "./mailroom.ts";
import { CHILD_SENDER_PREFIX, CONSOLE_SENDER } from "./names.ts";
import type { SessionRouting } from "./routing.ts";
import type { BoundaryBroker, RecordFailure, SimpleHandoff, Transfer } from "./seams.ts";
import { sessionSubtree } from "./session-tree.ts";

export interface NestingBrokerDeps {
  repo: Repo;
  bus: EventBus;
  handoffs: HandoffService;
  routing: SessionRouting;
  transfer: Transfer;
  simpleHandoff: SimpleHandoff;
  /** `Mailroom.patchDelivery` — acking the redriven boundary delivery. */
  patchDelivery: (session: AgentSessionRow, delivery: MailboxDeliveryRow, status: "queued" | "acknowledged" | "cancelled") => void;
  /** `OperatorSurface.finalWithheld` — the parent's blocked-final fact. */
  finalWithheld: (session: AgentSessionRow) => boolean;
  /** The status derivation, for the unsettled-children scan. */
  sessionStatus: (row: AgentSessionRow) => AgentSessionStatus;
  /** `SessionLifecycle.archiveOne` — the ONE teardown path. */
  archiveSession: (session: AgentSessionRow) => void;
  recordFailure: RecordFailure;
}

export class NestingBroker implements BoundaryBroker {
  readonly #deps: NestingBrokerDeps;

  constructor(deps: NestingBrokerDeps) { this.#deps = deps; }

  /**
   * A child's material report crosses into its parent as a journaled handoff
   * to the parent's controller — verbatim core and extension, a state-summary
   * preamble naming the child, and the child final downgraded to a parent
   * MILESTONE (a child finishing is a milestone of the parent's work; keeping
   * `isFinalToMain` false on the boundary keeps the parent's final gate
   * honest). Uncertainty was already classified child-side, so the boundary
   * hop never re-promotes it. Idempotent by dedupe key across restarts.
   */
  crossBoundary(child: AgentSessionRow, message: MessageRow, draft: HandoffDraft, category: Category): void {
    const parent = child.parentAgentSessionId === null ? undefined : this.#deps.repo.getAgentSession(child.parentAgentSessionId);
    if (!parent || parent.lifecycle !== "open" || child.parentControllerAgent === null) return;
    const mapped: Category = category === "final" ? "milestone" : category === "failure" ? "failure" : "update";
    const handoffId = (message.payload?.handoff as { id?: string } | undefined)?.id ?? message.id;
    const boundaryDraft: HandoffDraft = {
      // The child's ledger ids mean nothing in the parent's ledger — carried
      // across, a colliding id would move the WRONG task, so the boundary
      // strips it and the parent's own units stay the parent's to close.
      core: { ...draft.core, taskId: null, state: { ...draft.core.state,
        summary: `Child session "${child.title}" (${child.id}) reports:\n${draft.core.state.summary}` } },
      extension: draft.extension,
    };
    try {
      this.#deps.transfer({ agentSessionId: parent.id, speaker: { kind: "agent", name: `${CHILD_SENDER_PREFIX}${child.id}` },
        to: child.parentControllerAgent, handoff: boundaryDraft, category: mapped, dedupeKey: `child:${handoffId}` });
      if (category === "final" || category === "failure") {
        this.#deps.bus.append({ type: "agent_session.child.reported", userSessionId: parent.userSessionId, agentSessionId: parent.id,
          payload: { agentSessionId: parent.id, childAgentSessionId: child.id,
            status: category === "final" ? "completed" : "failed", handoffId } });
      }
    } catch (error) { this.#deps.recordFailure(child.id, error); }
  }

  /** The child-hold counterpart of onBlockingQuestionsCleared. */
  maybeReleaseParentFinal(parent: AgentSessionRow): void {
    if (!this.#deps.finalWithheld(parent)) return;
    const unsettled = this.#deps.repo.listChildSessions(parent.id)
      .filter((child) => child.lifecycle === "open" && this.#deps.sessionStatus(child) !== "reported");
    if (unsettled.length > 0) return;
    const finalSeat = this.#deps.routing.completionAgent(parent, "finalFrom");
    try {
      this.#deps.transfer({ agentSessionId: parent.id, speaker: { kind: "system", name: CONSOLE_SENDER }, to: finalSeat,
        handoff: this.#deps.simpleHandoff("All child sessions have reported", "in_progress",
          "Every child session's final has crossed into this session. The withheld final may be sent now.",
          "Compile and send your final report."),
        category: "decision", dedupeKey: `children-clear:${parent.id}` });
    } catch { /* best effort — the next final attempt re-evaluates the gate */ }
  }

  /** Boot replay of a crash between a child's journal write and its boundary ack. */
  redriveChildBoundary(session: AgentSessionRow, delivery: MailboxDeliveryRow): void {
    try {
      const message = this.#deps.repo.getMessageById(delivery.messageId);
      const summary = message?.payload?.handoff as { id?: string } | undefined;
      if (!message) return;
      if (summary?.id && this.#deps.handoffs && MATERIAL_CATEGORIES.has(delivery.category)) {
        const record = this.#deps.handoffs.get(summary.id);
        this.crossBoundary(session, message, { core: record.core, extension: record.extension }, delivery.category);
      }
      this.#deps.patchDelivery(session, delivery, "acknowledged");
      const parent = session.parentAgentSessionId === null ? undefined : this.#deps.repo.getAgentSession(session.parentAgentSessionId);
      if (parent && parent.lifecycle === "open") this.maybeReleaseParentFinal(parent);
    } catch (error) { this.#deps.recordFailure(session.id, error); }
  }

  /**
   * The escape hatch for a wedged child: archive it and hand the parent's
   * controller a console failure so the tree can still conclude. Archival
   * covers the child's WHOLE open subtree, deepest first — its descendants'
   * report sink is going away with it, and a stranded open grandchild blocks
   * run completion until the next boot's orphan sweep.
   */
  abandonChildSession(parentAgentSessionId: string, controllerAgent: string, childAgentSessionId: string, reason: string): void {
    const child = this.#deps.repo.getAgentSession(childAgentSessionId);
    if (!child || child.parentAgentSessionId !== parentAgentSessionId) {
      throw new InvalidInputError(`${childAgentSessionId} is not a child of this session`);
    }
    for (const row of sessionSubtree(this.#deps.repo, childAgentSessionId)
      .filter((row) => row.lifecycle === "open")
      .sort((a, b) => b.depth - a.depth)) {
      this.#deps.archiveSession(row);
    }
    const parent = this.#deps.repo.getAgentSession(parentAgentSessionId);
    if (!parent || parent.lifecycle !== "open") return;
    try {
      this.#deps.transfer({ agentSessionId: parent.id, speaker: { kind: "agent", name: `${CHILD_SENDER_PREFIX}${child.id}` },
        to: child.parentControllerAgent ?? controllerAgent, category: "failure", dedupeKey: `child-abandoned:${child.id}`,
        handoff: this.#deps.simpleHandoff(`Child session "${child.title}" abandoned`, "failed",
          `Abandoned by ${controllerAgent}: ${reason}. Whatever the child journaled is retrievable with read_handoff; nothing further will arrive from it.`,
          "Account for the abandoned work in your plan and your final report.") });
    } catch (error) { this.#deps.recordFailure(parent.id, error); }
    this.#deps.bus.append({ type: "agent_session.child.reported", userSessionId: child.userSessionId, agentSessionId: parentAgentSessionId,
      payload: { agentSessionId: parentAgentSessionId, childAgentSessionId: child.id, status: "failed", handoffId: "" } });
    if (parent) this.maybeReleaseParentFinal(parent);
  }

  /**
   * Boot sweep: children whose parent is archived or gone can never report to
   * anyone. Each orphan takes its whole open subtree with it, deepest first,
   * so the sweep converges in one pass whatever order the rows arrive in — a
   * grandchild visited before its stranded parent must not survive to the
   * next boot.
   */
  archiveOrphanChildren(): number {
    let archived = 0;
    for (const session of this.#deps.repo.listOpenAgentSessions()) {
      if (session.parentAgentSessionId === null) continue;
      // An earlier orphan's subtree sweep may already have archived this row.
      if (this.#deps.repo.getAgentSession(session.id)?.lifecycle !== "open") continue;
      const parent = this.#deps.repo.getAgentSession(session.parentAgentSessionId);
      if (parent && parent.lifecycle === "open") continue;
      for (const row of sessionSubtree(this.#deps.repo, session.id)
        .filter((row) => row.lifecycle === "open")
        .sort((a, b) => b.depth - a.depth)) {
        this.#deps.archiveSession(row);
        archived += 1;
        this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: row.userSessionId, agentSessionId: row.id,
          payload: { agentSessionId: row.id, agent: "system", detail: "archived: parent session is no longer open" } });
      }
    }
    return archived;
  }
}
