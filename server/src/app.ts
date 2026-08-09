/**
 * The composition root, shared by production (`main.ts`) and the test harness
 * (`test-helpers.ts`).
 *
 * It exists because the wiring used to be hand-duplicated in both places, and
 * the copies drifted: the runner's `decisions` dep was passed in tests and
 * forgotten in `main.ts`, so the decision ledger was silently off in the only
 * place it mattered — every test green, the feature dark in production. One
 * factory means a service wired here is wired everywhere, and the cross-service
 * callbacks below are registered exactly once (their setters throw on a second
 * registration).
 *
 * Boot side effects (recovery, orphan reaping, sweeps, the HTTP server) stay in
 * `main.ts` — this module only builds and connects the object graph.
 */
import { AgentSessionHost, type AgentSessionHostDeps } from "./agent-sessions/host.ts";
import type { AgentProfileRegistry } from "./agent-profiles/registry.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/client.ts";
import type { Repo } from "./db/repo.ts";
import type { EventBus } from "./events/bus.ts";
import { RunCompletionService } from "./completion/service.ts";
import { ContractService } from "./contracts/service.ts";
import { DecisionLedger } from "./orchestrator/decisions.ts";
import { InteractionService } from "./orchestrator/interactions.ts";
import { OrchestratorRunner } from "./orchestrator/runner.ts";
import { buildConsoleMcpServer } from "./orchestrator/tools.ts";
import type { ConsoleSdk } from "./sdk/types.ts";
import { SqliteSessionStore } from "./sdk/session-store.ts";
import type { ProcessManager } from "./runtime/process-manager.ts";
import type { BrowserManager } from "./runtime/browser-manager.ts";
import type { WorktreeManager } from "./runtime/worktree-manager.ts";
import { TaskService } from "./tasks/service.ts";
import { HandoffService } from "./handoffs/service.ts";

export interface CreateAppOptions {
  config: Config;
  db: Db;
  bus: EventBus;
  repo: Repo;
  sdk: () => Promise<ConsoleSdk>;
  getWorkspaceRoot: (workspaceId: string) => string;
  profiles: AgentProfileRegistry;
  processes?: ProcessManager;
  browsers?: BrowserManager;
  worktrees?: WorktreeManager;
  /**
   * A caller-supplied MCP server for special-purpose sessions (the profile
   * manager); return `undefined` to fall through to the console server, so the
   * default path is written once, here.
   */
  buildAlternateMcpServer?: (userSessionId: string, sdk: ConsoleSdk) => unknown;
  /** Overridable so tests do not pay the real completion quiet window. */
  quietWindowMs?: number;
  /** Test seam: swap individual host deps (config knobs, fake managers). */
  hostOverrides?: Partial<AgentSessionHostDeps>;
}

export interface App {
  decisions: DecisionLedger;
  contracts: ContractService;
  interactions: InteractionService;
  tasks: TaskService;
  handoffs: HandoffService;
  sessionStore: SqliteSessionStore;
  host: AgentSessionHost;
  runner: OrchestratorRunner;
  completion: RunCompletionService;
}

export function createApp(options: CreateAppOptions): App {
  const { config, db, bus, repo, sdk, getWorkspaceRoot, profiles } = options;
  const decisions = new DecisionLedger(db, bus);
  const contracts = new ContractService(db, bus);
  const interactions = new InteractionService(db, bus, decisions);
  const tasks = new TaskService(db, bus);
  const handoffs = new HandoffService({ repo, bus, getWorkspaceRoot });
  const sessionStore = new SqliteSessionStore(db);

  let runner!: OrchestratorRunner;
  const host = new AgentSessionHost({
    repo, bus, config, profiles, sdk, sessionStore, getWorkspaceRoot,
    processes: options.processes, browsers: options.browsers, worktrees: options.worktrees,
    interactions, decisions, contracts, tasks, handoffs,
    wake: (userSessionId, agentSessionId, category, text) =>
      runner.enqueueAgentMilestone(userSessionId, agentSessionId, category, text),
    ...options.hostOverrides,
  });
  runner = new OrchestratorRunner({
    repo, bus, config, sdk, interactions, decisions, handoffs, sessionStore, getWorkspaceRoot,
    host: () => host,
    tasks,
    buildMcpServer: (userSessionId, sdkInstance) =>
      options.buildAlternateMcpServer?.(userSessionId, sdkInstance) ??
      buildConsoleMcpServer({ sdk: sdkInstance, host, repo, bus, userSessionId, tasks, handoffs }),
  });
  const completion = new RunCompletionService({
    db, repo, bus, interactions, getWorkspaceRoot,
    host: () => host,
    runner: () => runner,
    ...(options.quietWindowMs !== undefined ? { quietWindowMs: options.quietWindowMs } : {}),
  });

  // Every cross-service callback, registered once. Held assignments release on
  // task changes; the completion predicate re-evaluates on every settle, status
  // change and answered card; a withheld final must not become a silence.
  tasks.onChange(() => host.releaseBlockedAssignments());
  runner.onSettled((userSessionId) => completion.schedule(userSessionId));
  runner.onOperatorMessage((userSessionId) => completion.noteOperatorMessage(userSessionId));
  host.onStatusChanged((userSessionId) => completion.schedule(userSessionId));
  interactions.onResolved((userSessionId) => completion.schedule(userSessionId));
  interactions.onBlockingCleared((userSessionId, agentSessionId) =>
    host.onBlockingQuestionsCleared(userSessionId, agentSessionId));

  return { decisions, contracts, interactions, tasks, handoffs, sessionStore, host, runner, completion };
}
