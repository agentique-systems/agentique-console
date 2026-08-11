/**
 * The single composition root, shared by production (`main.ts`) and the test
 * harness (`test-helpers.ts`).
 *
 * It exists because wiring used to be split and hand-duplicated, and the copies
 * drifted: the runner's `decisions` dep was passed in tests and forgotten in
 * `main.ts`, so the decision ledger was silently off in the only place it
 * mattered — every test green, the feature dark in production. Every service is
 * built here, every dependency is required, and every cross-service callback is
 * registered exactly once (their setters throw on a second registration).
 *
 * Boot side effects live in `boot.ts`; the HTTP server and process signals in
 * `main.ts`. This module only builds and connects the object graph.
 */
import Database from "better-sqlite3";
import { AgentSessionHost } from "./agent-sessions/host.ts";
import { AgentProfileRegistry } from "./agent-profiles/registry.ts";
import { ManagerService } from "./agent-profiles/manager.ts";
import { buildManagerMcpServer } from "./agent-profiles/tools.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/client.ts";
import { Repo } from "./db/repo.ts";
import { EventBus } from "./events/bus.ts";
import { late } from "./late.ts";
import { RunCompletionService } from "./completion/service.ts";
import { DecisionLedger } from "./orchestrator/decisions.ts";
import { InteractionService } from "./orchestrator/interactions.ts";
import { OrchestratorRunner } from "./orchestrator/runner.ts";
import { buildConsoleMcpServer } from "./orchestrator/tools.ts";
import type { ConsoleSdk } from "./sdk/types.ts";
import { SqliteSessionStore } from "./sdk/session-store.ts";
import { ProcessManager } from "./runtime/process-manager.ts";
import { BrowserManager } from "./runtime/browser-manager.ts";
import { WorktreeManager } from "./runtime/worktree-manager.ts";
import { UserSessionService } from "./sessions/service.ts";
import { TaskService } from "./tasks/service.ts";
import { TimelineService } from "./timeline/service.ts";
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
   * (tests that never spawn processes or worktrees say so here instead of
   * relying on a forgotten optional).
   */
  runtime?: {
    processes?: ProcessManager | null;
    browsers?: BrowserManager | null;
    worktrees?: WorktreeManager | null;
  };
}

export interface App {
  config: Config;
  db: Db;
  sqlite: Database.Database;
  bus: EventBus;
  repo: Repo;
  sdk: () => Promise<ConsoleSdk>;
  getWorkspaceRoot: (workspaceId: string) => string;
  workspaces: WorkspaceService;
  timeline: TimelineService;
  profiles: AgentProfileRegistry;
  processes: ProcessManager | null;
  browsers: BrowserManager | null;
  worktrees: WorktreeManager | null;
  decisions: DecisionLedger;
  interactions: InteractionService;
  tasks: TaskService;
  handoffs: HandoffService;
  sessionStore: SqliteSessionStore;
  host: AgentSessionHost;
  runner: OrchestratorRunner;
  completion: RunCompletionService;
  userSessions: UserSessionService;
  manager: ManagerService;
}

export function createApp(options: CreateAppOptions): App {
  const { config, db, sqlite, sdk } = options;
  const bus = new EventBus(db);
  const repo = new Repo(db, sqlite);
  const workspaces = new WorkspaceService(db, bus, config.fsRoots.map((root) => root.path));
  const getWorkspaceRoot = (workspaceId: string): string => workspaces.get(workspaceId).rootPath;
  const timeline = new TimelineService(repo, bus);
  const profiles = new AgentProfileRegistry(undefined, { getWorkspaceRoot, db, bus });
  const processes = options.runtime?.processes === undefined ? new ProcessManager(bus) : options.runtime.processes;
  const browsers = options.runtime?.browsers === undefined ? new BrowserManager(bus) : options.runtime.browsers;
  const worktrees = options.runtime?.worktrees === undefined ? new WorktreeManager({ dataDir: config.dataDir }) : options.runtime.worktrees;

  const decisions = new DecisionLedger(db);
  const interactions = new InteractionService(db, bus);
  const tasks = new TaskService(db, bus);
  const handoffs = new HandoffService({ repo, bus, getWorkspaceRoot });
  const sessionStore = new SqliteSessionStore(db);

  const lateRunner = late<OrchestratorRunner>("runner");
  const lateManager = late<ManagerService>("manager");
  const host = new AgentSessionHost({
    repo, bus, config, profiles, sdk, sessionStore, getWorkspaceRoot,
    processes, browsers, worktrees,
    interactions, decisions, tasks, handoffs,
    wake: (userSessionId, agentSessionId, category, text) =>
      lateRunner.get().enqueueAgentMilestone(userSessionId, agentSessionId, category, text),
  });
  const runner = new OrchestratorRunner({
    repo, bus, config, sdk, interactions, decisions, handoffs, sessionStore, getWorkspaceRoot,
    host: () => host,
    tasks,
    buildMcpServer: (userSessionId, sdkInstance) =>
      repo.getUserSession(userSessionId)?.purpose === "profile_manager"
        ? buildManagerMcpServer(sdkInstance, lateManager.get(), userSessionId)
        : buildConsoleMcpServer({ sdk: sdkInstance, host, repo, bus, userSessionId, tasks, handoffs }),
  });
  lateRunner.set(runner);
  const manager = new ManagerService({ repo, workspaces, profiles, config, bus, runner: () => runner });
  lateManager.set(manager);
  const completion = new RunCompletionService({
    db, repo, bus, interactions, getWorkspaceRoot,
    host: () => host,
    runner: () => runner,
    quietWindowMs: config.completionQuietWindowMs,
  });
  const userSessions = new UserSessionService({
    repo, bus, runner, interactions, workspaces,
    archiveAgentSessions: (userSessionId) => host.archiveForUserSession(userSessionId),
    completion,
  });

  // Every cross-service callback, registered once. The completion predicate
  // re-evaluates on every settle, status change and answered card; a withheld
  // final must not become a silence.
  runner.onSettled((userSessionId) => completion.schedule(userSessionId));
  runner.onOperatorMessage((userSessionId) => completion.noteOperatorMessage(userSessionId));
  host.onStatusChanged((userSessionId) => completion.schedule(userSessionId));
  interactions.onResolved((userSessionId) => completion.schedule(userSessionId));
  interactions.onBlockingCleared((userSessionId, agentSessionId) =>
    host.onBlockingQuestionsCleared(userSessionId, agentSessionId));

  return {
    config, db, sqlite, bus, repo, sdk, getWorkspaceRoot,
    workspaces, timeline, profiles, processes, browsers, worktrees,
    decisions, interactions, tasks, handoffs, sessionStore,
    host, runner, completion, userSessions, manager,
  };
}
