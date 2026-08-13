/**
 * Per-aggregate data stores. THE OWNERSHIP RULE: a table has exactly one
 * owning store, and services own no SQL — statements live in stores, policy
 * lives in services.
 *
 * Owners:
 *   messages, mailbox_deliveries          MessageStore
 *   user_sessions, agent_sessions, agents SessionStore
 *   handoff_records                       HandoffStore
 *   usage_samples                         UsageStore
 *   crons                                 CronStore
 *   pattern_state                         PatternStateStore
 *   tasks, task_dependencies              TaskStore
 *   scheduled_assignments                 AssignmentStore
 *   workspaces                            WorkspaceStore
 *   interactions                          InteractionStore
 *   event_artifacts                       ArtifactStore (events/artifact-store.ts)
 *   provider_entries                      SqliteSessionStore (sdk/session-store.ts)
 *   events                                EventBus appends (events/bus.ts);
 *                                         read-model folds in events/projections.ts
 *   run_summaries                         RunCompletionService (completion/service.ts)
 *   agent_profile_trust                   AgentProfileRegistry (agent-profiles/registry.ts)
 *
 * The one sanctioned crossing: transactional appends anchored on a row the
 * store owns (MessageStore.appendHandoffMailbox writes the handoff row with
 * its message; HandoffStore.insertCheckpointHandoff and the explicit
 * setMainLatestHandoff/setAgentLatestHandoff bump the latest-handoff pointers
 * on session rows). Callers pick the pointer target where the recipient is
 * known — no store branches on a domain sentinel. Read-models may JOIN across
 * tables (InteractionStore.countPendingByUserSession; completion/summary.ts's
 * run-summary fold still reads rows directly and moves with the host carve).
 */
import type { Db } from "../client.ts";
import { ArtifactStore } from "../../events/artifact-store.ts";
import { SqliteSessionStore } from "../../sdk/session-store.ts";
import { AssignmentStore } from "./assignment-store.ts";
import { CronStore } from "./cron-store.ts";
import { HandoffStore } from "./handoff-store.ts";
import { InteractionStore } from "./interaction-store.ts";
import { MessageStore } from "./message-store.ts";
import { PatternStateStore } from "./pattern-state-store.ts";
import { SpecStore } from "./spec-store.ts";
import { OrchestrationStateStore } from "./state-store.ts";
import { SessionStore } from "./session-store.ts";
import { TaskStore } from "./task-store.ts";
import { UsageStore } from "./usage-store.ts";
import { WorkspaceStore } from "./workspace-store.ts";

export { AssignmentStore } from "./assignment-store.ts";
export { CronStore } from "./cron-store.ts";
export { HandoffStore } from "./handoff-store.ts";
export { InteractionStore } from "./interaction-store.ts";
export { MessageStore } from "./message-store.ts";
export { PatternStateStore } from "./pattern-state-store.ts";
export { SpecStore, type SpecRevisionRow } from "./spec-store.ts";
export { OrchestrationStateStore, type OrchestrationStateRow } from "./state-store.ts";
export { SessionStore } from "./session-store.ts";
export { TaskStore } from "./task-store.ts";
export { UsageStore } from "./usage-store.ts";
export { WorkspaceStore } from "./workspace-store.ts";

/** better-sqlite3's synchronous transaction wrapper — the only handle stores need. */
export interface SqliteTransactor {
  transaction<T>(fn: () => T): () => T;
}

export interface Stores {
  messages: MessageStore;
  sessions: SessionStore;
  handoffs: HandoffStore;
  usage: UsageStore;
  crons: CronStore;
  patternState: PatternStateStore;
  specs: SpecStore;
  orchestrationState: OrchestrationStateStore;
  tasks: TaskStore;
  assignments: AssignmentStore;
  workspaces: WorkspaceStore;
  interactions: InteractionStore;
  artifacts: ArtifactStore;
  providerEntries: SqliteSessionStore;
}

/** One store per aggregate over one database — built once, shared everywhere. */
export function createStores(db: Db, sqlite: SqliteTransactor): Stores {
  return {
    messages: new MessageStore(db, sqlite),
    sessions: new SessionStore(db),
    handoffs: new HandoffStore(db, sqlite),
    usage: new UsageStore(db),
    crons: new CronStore(db),
    patternState: new PatternStateStore(db),
    specs: new SpecStore(db),
    orchestrationState: new OrchestrationStateStore(db),
    tasks: new TaskStore(db),
    assignments: new AssignmentStore(db),
    workspaces: new WorkspaceStore(db),
    interactions: new InteractionStore(db),
    artifacts: new ArtifactStore(db),
    providerEntries: new SqliteSessionStore(db),
  };
}
