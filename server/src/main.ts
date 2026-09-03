/**
 * The production entrypoint: configuration → composition (the database open
 * with the reset-required check) → boot (recovery before admission) →
 * serving. A refused database prints the reset-required message and exits
 * non-zero without touching the file; a configuration error names its
 * variable.
 */
import { createApp, type App } from "./app.ts";
import { bootApp, shutdownApp } from "./boot.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { ResetRequiredError } from "./persistence/database.ts";
import { CLAUDE_AGENT_SDK } from "./provider/claude-sdk-binding.ts";

const log = { info: (...args: unknown[]) => console.log(...args), warn: (...args: unknown[]) => console.warn(...args), error: (...args: unknown[]) => console.error(...args) };

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof ConfigError ? `configuration: ${error.message}` : error);
  process.exit(1);
}

let app: App;
try {
  app = createApp({ config, sdk: CLAUDE_AGENT_SDK, log });
} catch (error) {
  if (error instanceof ResetRequiredError) {
    console.error(error.message);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
}

const report = await bootApp(app);
if (!report.recovery.blobs.complete) log.warn("the console is serving reads only (recovery_incomplete)");

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down");
  await shutdownApp(app);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

try {
  await app.server.listen({ port: config.port, host: config.host });
  const address = app.server.addresses()[0];
  log.info(`agentique-console on http://${config.host}:${address?.port ?? config.port} (data: ${config.dataDir}; admission: ${app.admission.state})`);
} catch (error) {
  console.error(error);
  await app.close();
  process.exit(1);
}
