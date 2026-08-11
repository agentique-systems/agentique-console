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
