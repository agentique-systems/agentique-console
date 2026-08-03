import { loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { openDb } from "./db/client.ts";
import { EventBus } from "./events/bus.ts";
import { buildServer } from "./api/server.ts";

const config = loadConfig();
const { db, sqlite } = openDb(config.dbFile);
const bus = new EventBus(db);

const ctx: AppContext = {
  config,
  db,
  bus,
  log: console,
  extraRoutes: [],
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
