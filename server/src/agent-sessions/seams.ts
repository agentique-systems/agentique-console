/**
 * Narrow seams between agent-sessions modules. Modules never import host.ts —
 * where one needs a host capability it takes a typed callback shaped here.
 */
import type { HandoffDraft, Speaker } from "@agentique-console/shared";
import type { AgentRow, AgentSessionRow, MailboxDeliveryRow, MessageRow } from "../db/repo.ts";
import type { Category } from "./final-gate.ts";

/** The ONE transfer path (`AgentSessionService.post`), as a capability. */
export interface TransferInput {
  agentSessionId: string;
  speaker: Speaker;
  to: string;
  handoff: HandoffDraft;
  category?: Category;
  dedupeKey?: string;
  turnId?: string;
}
export type Transfer = (input: TransferInput) => MessageRow;

/** Console-authored notice draft factory (`#simpleHandoff`). */
export type SimpleHandoff = (action: string, status: HandoffDraft["core"]["status"], summary: string, nextAction: string | null) => HandoffDraft;

/** The awaitingOperator slot's contents while a blocking ask is parked. */
export interface OperatorWait {
  interactionId: string;
  since: number;
  abort: AbortController;
}

/** A live turn parked inside `ask_operator`, as the governance sweep sees it. */
export interface OperatorWaitRef {
  interactionId: string;
  since: number;
  /** Cut the wait loose: aborts the ask's OWN controller, never the lane's. */
  release(): void;
}

/**
 * Read-only lane facts for modules that must not own lanes. Implemented over
 * the live seat map (the host today, the lane pool after the C6 carve).
 */
export interface LaneActivity {
  /**
   * A turn is in flight that is NOT parked in `ask_operator`. The exclusion is
   * load-bearing for the status derivation: an agent waiting on the human does
   * not count as working.
   */
  hasBusyTurnExcludingOperatorWaits(agentSessionId: string): boolean;
  /** Every turn currently parked inside `ask_operator`, across all sessions. */
  operatorWaits(): OperatorWaitRef[];
  /**
   * Park the CURRENT active turn (if any) in an operator wait. The returned
   * release clears that SAME turn's slot — a turn that settled meanwhile (and
   * any successor turn) stays untouched.
   */
  bindOperatorWait(agentSessionId: string, agent: string, wait: OperatorWait): () => void;
  /** A lane exists for this seat (spawned at least once and not forgotten). */
  hasLane(agentSessionId: string, agent: string): boolean;
  /**
   * Names of every seat with a turn in flight — operator waits INCLUDED,
   * unlike the busy-turn scan: the final-report caveat names everyone whose
   * work is still open, however it is parked.
   */
  namesWithActiveTurn(agentSessionId: string): string[];
}

/** Console-path delivery (`Mailroom.deliver`): carry queued rows into the lane. */
export type Deliver = (agentSessionId: string, recipient: string) => Promise<void>;

/** Journal a host-side failure as a runtime notice on the session. */
export type RecordFailure = (agentSessionId: string, error: unknown) => void;

/**
 * Chooses which queued journal rows a console delivery carries. The default is
 * identity — every queued row goes, which is the bit-identical behavior. Two
 * invariants the mailroom guarantees around any selector:
 *  - the assignment-turn reset and the queued→delivered transition run over
 *    SELECTED rows only;
 *  - unselected rows stay queued, still count toward the session's status
 *    derivation, and are re-offered on the next delivery.
 */
export interface DeliverySelector {
  select(session: AgentSessionRow, agent: AgentRow, queuedRows: MailboxDeliveryRow[]): MailboxDeliveryRow[];
}

/**
 * The runtime half of console delivery: whether the recipient's lane can take
 * input, and the mint-or-steer push itself. Stays with the lane owner.
 */
export interface Injector {
  /** The recipient's lane is accepting input (spawned, not parked). */
  ready(agentSessionId: string, recipient: string): boolean;
  /** Push the composed prompt: steer the open turn, or mint a fresh one. */
  inject(session: AgentSessionRow, recipient: string, rows: MailboxDeliveryRow[], prompt: string): void;
  /** A new assignment was delivered: reset the lane's per-assignment budget. */
  resetAssignmentTurns(agentSessionId: string, recipient: string): void;
}

/** Nesting's side of the mailroom's main sink (host-owned until that carve). */
export interface BoundaryBroker {
  /** Re-post a child's material report into its parent (`#crossBoundary`). */
  crossBoundary(child: AgentSessionRow, message: MessageRow, draft: HandoffDraft, category: Category): void;
  /** The child-hold release check on the parent's withheld final. */
  maybeReleaseParentFinal(parent: AgentSessionRow): void;
}
