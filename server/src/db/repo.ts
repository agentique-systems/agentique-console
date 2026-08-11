/**
 * TEMPORARY façade over the per-aggregate stores in ./stores/ (see the
 * ownership rule there), kept so host.ts/runner.ts and their tests hold one
 * dependency until the host carve retires it. Every method is a one-line
 * delegation — new SQL goes in a store, never here.
 */
import type { Db } from "./client.ts";
import { createStores, type SqliteTransactor, type Stores } from "./stores/index.ts";
import type { AppendMessageInput, MailboxDeliveryRow, MessageRow } from "./stores/message-store.ts";
import type { AgentRow, AgentSessionRow, UserSessionRow } from "./stores/session-store.ts";
import type { HandoffRecordRow } from "./stores/handoff-store.ts";
import type { CronRow } from "./stores/cron-store.ts";
import type { PatternStateRow } from "./stores/pattern-state-store.ts";
import type { UsageSampleRow } from "./stores/usage-store.ts";
import { hasEvent, listProcessEvents } from "../events/projections.ts";

export type { AppendMessageInput, MailboxDeliveryRow, MessageRow } from "./stores/message-store.ts";
export type { AgentRow, AgentSessionRow, UserSessionRow } from "./stores/session-store.ts";
export type { HandoffRecordRow } from "./stores/handoff-store.ts";
export type { CronRow } from "./stores/cron-store.ts";
export type { PatternStateRow } from "./stores/pattern-state-store.ts";
export type { UsageSampleRow } from "./stores/usage-store.ts";

export class Repo {
  readonly #db: Db;
  readonly #s: Stores;

  constructor(db: Db, sqlite: SqliteTransactor, stores: Stores = createStores(db, sqlite)) {
    this.#db = db;
    this.#s = stores;
  }

  // --- Messages + deliveries (MessageStore) ---------------------------------

  appendMessage(input: AppendMessageInput): MessageRow { return this.#s.messages.appendMessage(input); }
  appendHandoffMailbox(input: Parameters<Stores["messages"]["appendHandoffMailbox"]>[0]): ReturnType<Stores["messages"]["appendHandoffMailbox"]> { return this.#s.messages.appendHandoffMailbox(input); }
  setMainLatestHandoff(userSessionId: string, handoffId: string): void { this.#s.messages.setMainLatestHandoff(userSessionId, handoffId); }
  setAgentLatestHandoff(agentSessionId: string, agent: string, handoffId: string): void { this.#s.messages.setAgentLatestHandoff(agentSessionId, agent, handoffId); }
  listQueuedDeliveries(agentSessionId?: string): MailboxDeliveryRow[] { return this.#s.messages.listQueuedDeliveries(agentSessionId); }
  listActiveDeliveries(agentSessionId: string): MailboxDeliveryRow[] { return this.#s.messages.listActiveDeliveries(agentSessionId); }
  findDeliveryByDedupe(agentSessionId: string, sender: string, recipient: string, dedupeKey: string): MailboxDeliveryRow | undefined { return this.#s.messages.findDeliveryByDedupe(agentSessionId, sender, recipient, dedupeKey); }
  getMessageById(id: string): MessageRow | undefined { return this.#s.messages.getMessageById(id); }
  patchDelivery(id: string, patch: Partial<Pick<MailboxDeliveryRow, "status" | "deliveredAt" | "acknowledgedAt">>): void { this.#s.messages.patchDelivery(id, patch); }
  getDeliveryById(id: string): MailboxDeliveryRow | undefined { return this.#s.messages.getDeliveryById(id); }
  latestAssignmentDelivery(agentSessionId: string, recipient: string): MailboxDeliveryRow | undefined { return this.#s.messages.latestAssignmentDelivery(agentSessionId, recipient); }
  listUnackedDeliveries(agentSessionId: string, recipient: string): MailboxDeliveryRow[] { return this.#s.messages.listUnackedDeliveries(agentSessionId, recipient); }
  requeueUnacknowledgedDeliveries(): number { return this.#s.messages.requeueUnacknowledgedDeliveries(); }
  listMessages(sessionKind: "user" | "agent", sessionId: string, afterSeq = 0): MessageRow[] { return this.#s.messages.listMessages(sessionKind, sessionId, afterSeq); }
  listAllMessages(): MessageRow[] { return this.#s.messages.listAllMessages(); }
  listAllDeliveries(): MailboxDeliveryRow[] { return this.#s.messages.listAllDeliveries(); }
  messagesHeadSeq(sessionKind: "user" | "agent", sessionId: string): number { return this.#s.messages.messagesHeadSeq(sessionKind, sessionId); }

  // --- Session tree (SessionStore) ------------------------------------------

  getUserSession(id: string): UserSessionRow | undefined { return this.#s.sessions.getUserSession(id); }
  listOpenUserSessions(): UserSessionRow[] { return this.#s.sessions.listOpenUserSessions(); }
  listOpenWorkSessions(): UserSessionRow[] { return this.#s.sessions.listOpenWorkSessions(); }
  listUserSessions(workspaceId: string): UserSessionRow[] { return this.#s.sessions.listUserSessions(workspaceId); }
  listManagerSessions(workspaceId: string): UserSessionRow[] { return this.#s.sessions.listManagerSessions(workspaceId); }
  findManagerSession(workspaceId: string, subjectKey: string): UserSessionRow | undefined { return this.#s.sessions.findManagerSession(workspaceId, subjectKey); }
  insertUserSession(row: UserSessionRow): void { this.#s.sessions.insertUserSession(row); }
  patchUserSession(id: string, patch: Parameters<Stores["sessions"]["patchUserSession"]>[1]): void { this.#s.sessions.patchUserSession(id, patch); }
  touchUserSession(id: string): void { this.#s.sessions.touchUserSession(id); }
  getAgentSession(id: string): AgentSessionRow | undefined { return this.#s.sessions.getAgentSession(id); }
  listAgentSessions(userSessionId: string): AgentSessionRow[] { return this.#s.sessions.listAgentSessions(userSessionId); }
  insertAgentSession(row: AgentSessionRow): void { this.#s.sessions.insertAgentSession(row); }
  listOpenAgentSessions(): AgentSessionRow[] { return this.#s.sessions.listOpenAgentSessions(); }
  listChildSessions(parentAgentSessionId: string): AgentSessionRow[] { return this.#s.sessions.listChildSessions(parentAgentSessionId); }
  patchAgentSession(id: string, patch: Parameters<Stores["sessions"]["patchAgentSession"]>[1]): void { this.#s.sessions.patchAgentSession(id, patch); }
  listAgents(agentSessionId: string): AgentRow[] { return this.#s.sessions.listAgents(agentSessionId); }
  getAgent(agentSessionId: string, name: string): AgentRow | undefined { return this.#s.sessions.getAgent(agentSessionId, name); }
  insertAgent(row: AgentRow): void { this.#s.sessions.insertAgent(row); }
  patchAgent(agentSessionId: string, name: string, patch: Parameters<Stores["sessions"]["patchAgent"]>[2]): void { this.#s.sessions.patchAgent(agentSessionId, name, patch); }
  listWorktreeAgents(): { agentSessionId: string; name: string; worktreePath: string }[] { return this.#s.sessions.listWorktreeAgents(); }

  // --- Handoffs (HandoffStore) ----------------------------------------------

  insertCheckpointHandoff(row: HandoffRecordRow): void { this.#s.handoffs.insertCheckpointHandoff(row); }
  getHandoff(id: string): HandoffRecordRow | undefined { return this.#s.handoffs.getHandoff(id); }
  latestHandoff(input: Parameters<Stores["handoffs"]["latestHandoff"]>[0]): HandoffRecordRow | undefined { return this.#s.handoffs.latestHandoff(input); }

  // --- Usage, crons, pattern state ------------------------------------------

  insertUsage(row: UsageSampleRow): void { this.#s.usage.insertUsage(row); }
  listUsage(userSessionId: string): UsageSampleRow[] { return this.#s.usage.listUsage(userSessionId); }
  insertCron(row: CronRow): void { this.#s.crons.insertCron(row); }
  listDueDeadlines(userSessionId: string, nowIsoTime: string): CronRow[] { return this.#s.crons.listDueDeadlines(userSessionId, nowIsoTime); }
  patchCron(id: string, patch: Partial<Pick<CronRow, "schedule" | "prompt" | "status">>): void { this.#s.crons.patchCron(id, patch); }
  getPatternState(agentSessionId: string): PatternStateRow | undefined { return this.#s.patternState.getPatternState(agentSessionId); }
  upsertPatternState(agentSessionId: string, patch: Parameters<Stores["patternState"]["upsertPatternState"]>[1]): PatternStateRow { return this.#s.patternState.upsertPatternState(agentSessionId, patch); }

  // --- Cross-aggregate reads ------------------------------------------------

  countPendingInteractions(workspaceId: string): Map<string, number> { return this.#s.interactions.countPendingByUserSession(workspaceId); }

  /** One existence probe per owning store, dispatched on the reference kind. */
  hasDurableReference(kind: "journal" | "artifact" | "task", ref: string): boolean {
    if (kind === "artifact") return this.#s.artifacts.has(ref);
    if (kind === "task") return this.#s.tasks.hasSdkTaskId(ref);
    return this.#s.providerEntries.hasEntryRef(ref);
  }

  // --- Events read-models (SQL lives in events/projections.ts) --------------

  listProcessEvents(userSessionId: string): { type: string; processId: string }[] { return listProcessEvents(this.#db, userSessionId); }
  hasEvent(type: string, agentSessionId: string): boolean { return hasEvent(this.#db, type, agentSessionId); }
}
