import { AgentSessionHost } from "./agent-sessions/host.ts";
import { AgentProfileRegistry } from "./agent-profiles/registry.ts";
import { loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { openDb } from "./db/client.ts";
import { Repo } from "./db/repo.ts";
import { EventBus } from "./events/bus.ts";
import { InteractionService } from "./orchestrator/interactions.ts";
import { OrchestratorRunner } from "./orchestrator/runner.ts";
import { buildConsoleMcpServer } from "./orchestrator/tools.ts";
import { reconcileDurableCommunication, recoverInterruptedTurns } from "./recovery.ts";
import { resolveSdk } from "./sdk/client.ts";
import { SqliteSessionStore } from "./sdk/session-store.ts";
import { ProcessManager } from "./runtime/process-manager.ts";
import { BrowserManager } from "./runtime/browser-manager.ts";
import { UserSessionService } from "./sessions/service.ts";
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
const tasks = new TaskService(db, bus);
const getWorkspaceRoot = (workspaceId: string): string =>
  workspaces.get(workspaceId).rootPath;

const profiles = new AgentProfileRegistry(config.profilesFile);
const sessionStore = new SqliteSessionStore(db);
const processes = new ProcessManager(bus);
const browsers = new BrowserManager(bus);
let runner!: OrchestratorRunner;
const host = new AgentSessionHost({
  repo, bus, config, profiles, sdk: () => resolveSdk(), sessionStore, getWorkspaceRoot, processes, browsers, interactions, tasks,
  wake: (userSessionId, agentSessionId, category, text) =>
    runner.enqueueAgentMilestone(userSessionId, agentSessionId, category, text),
});
runner = new OrchestratorRunner({
  repo,
  bus,
  config,
  sdk: () => resolveSdk(),
  interactions,
  sessionStore,
  getWorkspaceRoot,
  buildMcpServer: (userSessionId, sdk) =>
    buildConsoleMcpServer({ sdk, host, repo, bus, userSessionId, tasks }),
});
const userSessions = new UserSessionService({
  repo,
  bus,
  runner,
  interactions,
  workspaces,
  archiveAgentSessions: (userSessionId) => host.archiveForUserSession(userSessionId),
});

// In-flight promises died with the previous process; their rows go stale so
// the UI renders greyed cards whose answers become revival turns (M8). Turns
// that died mid-flight are closed and their sessions put back in motion, and
// open agent sessions re-evaluate their drain from persisted rows.
interactions.expirePendingOnBoot();
const recovered = recoverInterruptedTurns({ repo, bus });
const requeued = repo.requeueUnacknowledgedDeliveries();
const reconciled = await reconcileDurableCommunication({ repo, bus });
if (recovered > 0) {
  console.log(`recovered ${recovered} turn(s) interrupted by the last shutdown`);
}
if (requeued > 0) console.log(`requeued ${requeued} unacknowledged mailbox delivery(s)`);
if (reconciled > 0) console.log(`reconciled ${reconciled} durable communication event(s)`);
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
  sdk: () => resolveSdk(),
};

const app = buildServer(ctx);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  bus.closeSubscriptions();
  // Persistent lanes are CLI subprocesses — none may outlive the server.
  await runner.closeAll().catch(() => undefined);
  await host.closeAll().catch(() => undefined);
  processes.closeAll();
  await browsers.closeAll().catch(() => undefined);
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
