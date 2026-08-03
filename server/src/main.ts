import { AgentSessionHost } from "./agent-sessions/host.ts";
import { buildSeatPlanCapture } from "./agent-sessions/plan-capture.ts";
import { loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { openDb } from "./db/client.ts";
import { Repo } from "./db/repo.ts";
import { EventBus } from "./events/bus.ts";
import { InteractionService } from "./orchestrator/interactions.ts";
import { OrchestratorRunner } from "./orchestrator/runner.ts";
import { buildConsoleMcpServer } from "./orchestrator/tools.ts";
import { resolveSdk } from "./sdk/client.ts";
import { SqliteSessionStore } from "./sdk/session-store.ts";
import { UserSessionService } from "./sessions/service.ts";
import { buildTaskHooks } from "./tasks/hooks.ts";
import { TaskService } from "./tasks/service.ts";
import { WorkspaceService } from "./workspaces/service.ts";
import { buildServer } from "./api/server.ts";

const config = loadConfig();
const { db, sqlite } = openDb(config.dbFile);
const bus = new EventBus(db);
const repo = new Repo(db, sqlite);
const workspaces = new WorkspaceService(
  db,
  bus,
  config.fsRoots.map((r) => r.path),
);
const interactions = new InteractionService(db, bus);
const sessionStore = new SqliteSessionStore(db);
const tasks = new TaskService(db, bus);
const getWorkspaceRoot = (workspaceId: string): string =>
  workspaces.get(workspaceId).rootPath;

// Host and runner reference each other (host wakes the runner; the runner's
// MCP tools drive the host) — late-bound closures break the cycles.
let runnerRef: OrchestratorRunner | null = null;
let hostRef: AgentSessionHost | null = null;
const host = new AgentSessionHost({
  repo,
  bus,
  config,
  sdk: () => resolveSdk(),
  sessionStore,
  getWorkspaceRoot,
  wake: (userSessionId, agentSessionId) =>
    runnerRef?.enqueueWake(userSessionId, agentSessionId),
  buildHooks: (attribution) => buildTaskHooks(tasks, attribution),
  taskLines: (agentSessionId) => tasks.linesForAgentSession(agentSessionId),
  buildSeatCanUseTool: buildSeatPlanCapture({
    host: () => hostRef as AgentSessionHost,
    repo,
    bus,
  }),
});
hostRef = host;
const runner = new OrchestratorRunner({
  repo,
  bus,
  config,
  sdk: () => resolveSdk(),
  sessionStore,
  interactions,
  getWorkspaceRoot,
  buildHooks: ({ workspaceId, userSessionId }) =>
    buildTaskHooks(tasks, {
      workspaceId,
      userSessionId,
      agentSessionId: null,
      participant: null,
    }),
  buildMcpServer: (userSessionId, sdk) =>
    buildConsoleMcpServer({ sdk, host, repo, bus, userSessionId }),
  buildWakeDigests: (userSessionId, ids) =>
    host.buildWakeDigests(userSessionId, ids),
});
runnerRef = runner;
const userSessions = new UserSessionService({
  repo,
  bus,
  runner,
  interactions,
  workspaces,
});

// In-flight promises died with the previous process; their rows go stale so
// the UI renders greyed cards whose answers become revival turns (M8), and
// open agent sessions re-evaluate their drain from persisted rows.
interactions.expirePendingOnBoot();
host.boot();

const ctx: AppContext = {
  config,
  db,
  repo,
  bus,
  log: console,
  workspaces,
  userSessions,
  runner,
  interactions,
  host,
  tasks,
};

const app = buildServer(ctx);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  bus.closeSubscriptions();
  await app.close().catch(() => undefined);
  sqlite.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

app
  .listen({ port: config.port, host: config.host })
  .then(() => {
    console.log(
      `agentique-console on http://${config.host}:${config.port} (db: ${config.dbFile})`,
    );
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
