/**
 * The single composition root, shared by production (`main.ts`) and the test
 * harness (`test-helpers.ts`). Every service is built here, every dependency
 * is required, and every cross-service callback is registered exactly once
 * (their setters throw on a second registration).
 *
 * Boot side effects live in `boot.ts`; the HTTP server and process signals in
 * `main.ts`. This module only builds and connects the object graph.
 */
import Database from "better-sqlite3";
import { AgentSessionService } from "./agent-sessions/service.ts";
import { AgentProfileRegistry } from "./agent-profiles/registry.ts";
import { ProfileManagerService } from "./agent-profiles/manager.ts";
import { buildManagerMcpServer } from "./agent-profiles/tools.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/client.ts";
import { Repo } from "./db/repo.ts";
import { createStores } from "./db/stores/index.ts";
import type { ArtifactStore } from "./events/artifact-store.ts";
import { EventBus } from "./events/bus.ts";
import { late } from "./late.ts";
import { RunCompletionService } from "./completion/service.ts";
import { DecisionLedger } from "./orchestrator/decisions.ts";
import { InteractionService } from "./orchestrator/interactions.ts";
import { OrchestratorRunner } from "./orchestrator/runner.ts";
import { buildConsoleMcpServer } from "./orchestrator/tools.ts";
import { SpecService } from "./orchestrator/spec.ts";
import { OrchestrationStateService } from "./orchestrator/state.ts";
import type { ConsoleSdk } from "./sdk/types.ts";
import type { SqliteSessionStore } from "./sdk/session-store.ts";
import { WorktreeManager } from "./runtime/worktree-manager.ts";
import { UserSessionService } from "./sessions/service.ts";
import { AssignmentScheduler } from "./tasks/scheduler.ts";
import { TaskService } from "./tasks/service.ts";
import { TimelineService } from "./timeline/service.ts";
import { CapacityService } from "./capacity/service.ts";
import { HandoffService } from "./handoffs/service.ts";
import { WorkspaceService } from "./workspaces/service.ts";

export interface CreateAppOptions {
  config: Config;
  db: Db;
  sqlite: Database.Database;
  sdk: () => Promise<ConsoleSdk>;
  /**
   * OS-resource managers. Omitted members are constructed for real; `null`
   * states — at the construction site, visibly — that a capability is absent
   * (tests that never touch git say so here instead of relying on a forgotten
   * optional).
   */
  runtime?: {
    worktrees?: WorktreeManager | null;
  };
}

export interface App {
  config: Config;
  db: Db;
  sqlite: Database.Database;
  bus: EventBus;
  artifacts: ArtifactStore;
  repo: Repo;
  sdk: () => Promise<ConsoleSdk>;
  getWorkspaceRoot: (workspaceId: string) => string;
  workspaces: WorkspaceService;
  timeline: TimelineService;
  profiles: AgentProfileRegistry;
  worktrees: WorktreeManager | null;
  decisions: DecisionLedger;
  interactions: InteractionService;
  tasks: TaskService;
  scheduler: AssignmentScheduler;
  handoffs: HandoffService;
  sessionStore: SqliteSessionStore;
  host: AgentSessionService;
  runner: OrchestratorRunner;
  specs: SpecService;
  orchestrationState: OrchestrationStateService;
  completion: RunCompletionService;
  userSessions: UserSessionService;
  manager: ProfileManagerService;
  capacity: CapacityService;
}

export function createApp(options: CreateAppOptions): App {
  const { config, db, sqlite, sdk } = options;
  // One store per table (see db/stores/index.ts for the ownership rule);
  // services get their store, and the Repo façade composes the same instances.
  const stores = createStores(db, sqlite);
  const artifacts = stores.artifacts;
  const bus = new EventBus(db, artifacts);
  const repo = new Repo(db, sqlite, stores);
  const workspaces = new WorkspaceService(stores.workspaces, bus, config.infra.fsRoots.map((root) => root.path));
  const getWorkspaceRoot = (workspaceId: string): string => workspaces.get(workspaceId).rootPath;
  const timeline = new TimelineService(repo, bus);
  const profiles = new AgentProfileRegistry({ getWorkspaceRoot, db, bus });
  const worktrees = options.runtime?.worktrees === undefined ? new WorktreeManager({ dataDir: config.infra.dataDir }) : options.runtime.worktrees;

  const decisions = new DecisionLedger(stores.interactions);
  const interactions = new InteractionService(stores.interactions, bus);
  const tasks = new TaskService(stores.tasks, stores.assignments, bus, (workspaceId) => void workspaces.get(workspaceId));
  const handoffs = new HandoffService({ repo, bus, getWorkspaceRoot });
  const specs = new SpecService(stores.specs, bus);
  const orchestrationState = new OrchestrationStateService(stores.orchestrationState, bus);
  const sessionStore = stores.providerEntries;

  const capacity = new CapacityService({ repo, bus });
  const lateRunner = late<OrchestratorRunner>("runner");
  const lateManager = late<ProfileManagerService>("manager");
  const lateScheduler = late<AssignmentScheduler>("scheduler");
  const host = new AgentSessionService({
    repo, bus, artifacts, config, profiles, sdk, sessionStore, getWorkspaceRoot, specs,
    worktrees, capacity,
    interactions, decisions, tasks, handoffs,
    scheduler: () => lateScheduler.get(),
    wake: (userSessionId, agentSessionId, category, text) =>
      lateRunner.get().enqueueAgentMilestone(userSessionId, agentSessionId, category, text),
  });
  const scheduler = new AssignmentScheduler({
    store: stores.assignments, tasks, sessions: stores.sessions, messages: stores.messages, bus,
    post: (input) => host.post(input),
  });
  lateScheduler.set(scheduler);
  const runner = new OrchestratorRunner({
    repo, bus, config, sdk, interactions, decisions, handoffs, sessionStore, getWorkspaceRoot,
    specs, orchestrationState,
    host: () => host,
    tasks, capacity,
    buildMcpServer: (userSessionId, sdkInstance) =>
      repo.getUserSession(userSessionId)?.purpose === "profile_manager"
        ? buildManagerMcpServer(sdkInstance, lateManager.get(), userSessionId)
        : buildConsoleMcpServer({ sdk: sdkInstance, host, repo, bus, userSessionId, tasks, scheduler, handoffs, artifacts, interactions, specs, state: orchestrationState }),
  });
  lateRunner.set(runner);
  const manager = new ProfileManagerService({ repo, workspaces, profiles, config, bus, runner: () => runner });
  lateManager.set(manager);
  const completion = new RunCompletionService({
    db, repo, bus, interactions, scheduler, getWorkspaceRoot, orchestrationState, specs,
    host: () => host,
    runner: () => runner,
    quietWindowMs: config.policy.completionQuietWindowMs,
  });
  const userSessions = new UserSessionService({
    repo, bus, runner, interactions, workspaces,
    archiveAgentSessions: (userSessionId) => host.archiveForUserSession(userSessionId),
    completion,
    wireAgentSessions: (userSessionId) => host.wireSessionsForUserSession(userSessionId),
    postManagerMessage: (userSessionId, text) => manager.postMessage(userSessionId, text),
  });

  // Every cross-service callback, registered once. The completion predicate
  // re-evaluates on every settle, status change and answered card; a withheld
  // final must not become a silence. The task hook is the scheduler's release
  // path: every ledger transition flows through it, and dispatch rides it.
  tasks.onChange(scheduler.onTaskChanged);
  // Capacity resume re-kicks both lane engines: queued orchestrator jobs
  // drain and queued seat deliveries redeliver — nothing was cancelled.
  capacity.onResume(() => { runner.resumeQueued(); host.resumeQueuedDeliveries(); });
  runner.onSettled((userSessionId) => completion.schedule(userSessionId));
  runner.onOperatorMessage((userSessionId) => completion.noteOperatorMessage(userSessionId));
  host.onStatusChanged((userSessionId) => completion.schedule(userSessionId));
  interactions.onResolved((userSessionId) => completion.schedule(userSessionId));
  interactions.onBlockingCleared((userSessionId, agentSessionId) =>
    host.onBlockingQuestionsCleared(userSessionId, agentSessionId));
  interactions.onStaleAnswerRouting({
    deliverToAgent: (interaction) => host.deliverOperatorAnswer(interaction),
    reviveMain: (userSessionId, prompt) => runner.enqueueRevival(userSessionId, prompt),
    beginExecuting: (userSessionId) => userSessions.beginExecuting(userSessionId),
  });

  return {
    config, db, sqlite, bus, artifacts, repo, sdk, getWorkspaceRoot, specs, orchestrationState,
    workspaces, timeline, profiles, worktrees, capacity,
    decisions, interactions, tasks, scheduler, handoffs, sessionStore,
    host, runner, completion, userSessions, manager,
  };
}
