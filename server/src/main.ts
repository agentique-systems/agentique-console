import { createApp } from "./app.ts";
import { bootApp, shutdownApp, type BootReport } from "./boot.ts";
import { loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { openDb } from "./db/client.ts";
import { resolveSdk } from "./sdk/client.ts";
import { buildServer } from "./api/server.ts";

const config = loadConfig();
const { db, sqlite } = openDb(config.dbFile);
const app = createApp({ config, db, sqlite, sdk: () => resolveSdk() });

const report = await bootApp(app);
for (const [step, count] of Object.entries(report) as [keyof BootReport, number][]) {
  if (count > 0) console.log(`boot: ${step} = ${count}`);
}

const ctx: AppContext = { app, config, log: console };
const httpServer = buildServer(ctx);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await shutdownApp(app);
  await httpServer.close().catch(() => undefined);
  sqlite.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

httpServer
  .listen({ port: config.port, host: config.host })
  .then(() => {
    console.log(`agentique-console on http://${config.host}:${config.port} (db: ${config.dbFile})`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
