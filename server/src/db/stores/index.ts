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
 *   projects                              ProjectStore
 *   assumptions                           AssumptionStore
 *   interactions                          InteractionStore
 *   event_artifacts                       ArtifactStore (events/artifact-store.ts)
 *   provider_entries                      SqliteSessionStore (sdk/session-store.ts)
 *   events                                EventBus appends (events/bus.ts);
 *                                         read-model folds in events/projections.ts
 *   run_summaries                         RunCompletionService (completion/service.ts)
 *   agent_profile_trust                   AgentProfileRegistry (agent-profiles/registry.ts)
 *   requirement_revisions, requirement_nodes,
 *   requirement_status_changes,
 *   requirement_delegations,
 *   requirement_links                     RequirementStore
 *   change_impacts                        ChangeImpactStore
 *   decision_issues                       DecisionIssueStore
 *   workstream_links                      WorkstreamStore
 *   worktree_landings                     LandingStore
 *   continuation_checkpoints              ContinuationCheckpointStore
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
import { AssumptionStore } from "./assumption-store.ts";
import { ChangeImpactStore } from "./change-impact-store.ts";
import { ContinuationCheckpointStore } from "./continuation-store.ts";
import { CronStore } from "./cron-store.ts";
import { DecisionIssueStore } from "./decision-issue-store.ts";
import { HandoffStore } from "./handoff-store.ts";
import { InteractionStore } from "./interaction-store.ts";
import { LandingStore } from "./landing-store.ts";
import { MessageStore } from "./message-store.ts";
import { PatternStateStore } from "./pattern-state-store.ts";
import { ProjectStore } from "./project-store.ts";
import { RequirementStore } from "./requirement-store.ts";
import { OrchestrationStateStore } from "./state-store.ts";
import { SessionStore } from "./session-store.ts";
import { TaskStore } from "./task-store.ts";
import { UsageStore } from "./usage-store.ts";
import { WorkspaceStore } from "./workspace-store.ts";
import { WorkstreamStore } from "./workstream-store.ts";

export { AssignmentStore } from "./assignment-store.ts";
export { AssumptionStore, type AssumptionRow } from "./assumption-store.ts";
export { ChangeImpactStore, type ChangeImpactRow } from "./change-impact-store.ts";
export { ContinuationCheckpointStore, type ContinuationCheckpointRow } from "./continuation-store.ts";
export { CronStore } from "./cron-store.ts";
export { DecisionIssueStore, type DecisionIssueRow } from "./decision-issue-store.ts";
export { HandoffStore } from "./handoff-store.ts";
export { InteractionStore } from "./interaction-store.ts";
export { LandingStore, type WorktreeLandingRow } from "./landing-store.ts";
export { MessageStore } from "./message-store.ts";
export { PatternStateStore } from "./pattern-state-store.ts";
export { ProjectStore, type ProjectRow } from "./project-store.ts";
export {
  RequirementStore,
  type RequirementDelegationRow,
  type RequirementLinkRow,
  type RequirementNodeRow,
  type RequirementRevisionRow,
  type RequirementStatusChangeRow,
} from "./requirement-store.ts";
export { OrchestrationStateStore, type OrchestrationStateRow } from "./state-store.ts";
export { SessionStore } from "./session-store.ts";
export { TaskStore } from "./task-store.ts";
export { UsageStore } from "./usage-store.ts";
export { WorkspaceStore } from "./workspace-store.ts";
export { WorkstreamStore, type WorkstreamLinkRow } from "./workstream-store.ts";

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
  projects: ProjectStore;
  requirements: RequirementStore;
  assumptions: AssumptionStore;
  changeImpacts: ChangeImpactStore;
  continuation: ContinuationCheckpointStore;
  decisionIssues: DecisionIssueStore;
  workstreams: WorkstreamStore;
  landings: LandingStore;
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
    projects: new ProjectStore(db),
    requirements: new RequirementStore(db, sqlite),
    assumptions: new AssumptionStore(db),
    changeImpacts: new ChangeImpactStore(db),
    continuation: new ContinuationCheckpointStore(db),
    decisionIssues: new DecisionIssueStore(db),
    workstreams: new WorkstreamStore(db),
    landings: new LandingStore(db),
    orchestrationState: new OrchestrationStateStore(db),
    tasks: new TaskStore(db),
    assignments: new AssignmentStore(db),
    workspaces: new WorkspaceStore(db),
    interactions: new InteractionStore(db),
    artifacts: new ArtifactStore(db),
    providerEntries: new SqliteSessionStore(db),
  };
}
