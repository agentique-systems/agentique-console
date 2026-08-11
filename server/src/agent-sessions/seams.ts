/**
 * Narrow seams between agent-sessions modules. Modules never import host.ts —
 * where one needs a host capability it takes a typed callback shaped here.
 */
import type { HandoffDraft, Speaker } from "@agentique-console/shared";
import type { MessageRow } from "../db/repo.ts";
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
}

/** Console-path delivery (`#deliverConsole`): carry queued rows into the lane. */
export type Deliver = (agentSessionId: string, recipient: string) => Promise<void>;

/** Journal a host-side failure as a runtime notice on the session. */
export type RecordFailure = (agentSessionId: string, error: unknown) => void;
