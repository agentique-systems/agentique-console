import { loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { openDb } from "./db/client.ts";
import { Repo } from "./db/repo.ts";
import { EventBus } from "./events/bus.ts";
import { InteractionService } from "./orchestrator/interactions.ts";
import { OrchestratorRunner } from "./orchestrator/runner.ts";
import { resolveSdk } from "./sdk/client.ts";
import { SqliteSessionStore } from "./sdk/session-store.ts";
import { UserSessionService } from "./sessions/service.ts";
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
const runner = new OrchestratorRunner({
  repo,
  bus,
  config,
  sdk: () => resolveSdk(config),
  sessionStore,
  interactions,
  getWorkspaceRoot: (workspaceId) => workspaces.get(workspaceId).rootPath,
});
const userSessions = new UserSessionService({
  repo,
  bus,
  runner,
  interactions,
  workspaces,
});

// In-flight promises died with the previous process; their rows go stale so
// the UI renders greyed cards whose answers become revival turns (M8).
interactions.expirePendingOnBoot();

const ctx: AppContext = {
  config,
  db,
  bus,
  log: console,
  workspaces,
  userSessions,
  runner,
  interactions,
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
      `agentique-console server on http://${config.host}:${config.port} (db: ${config.dbFile}${config.fakeSdk ? ", FAKE SDK" : ""})`,
    );
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
