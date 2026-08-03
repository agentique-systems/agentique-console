import { AgentSessionHost } from "./agent-sessions/host.ts";
import { loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { openDb } from "./db/client.ts";
import { Repo } from "./db/repo.ts";
import { EventBus } from "./events/bus.ts";
import { InteractionService } from "./orchestrator/interactions.ts";
import { OrchestratorRunner } from "./orchestrator/runner.ts";
import { buildConsoleMcpServer } from "./orchestrator/tools.ts";
import { recoverInterruptedTurns } from "./recovery.ts";
import { resolveSdk } from "./sdk/client.ts";
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
const tasks = new TaskService(db, bus);
const getWorkspaceRoot = (workspaceId: string): string =>
  workspaces.get(workspaceId).rootPath;

// B5: the host is a pure observer/registry — no execution deps.
const host = new AgentSessionHost({ repo, bus });
const runner = new OrchestratorRunner({
  repo,
  bus,
  config,
  sdk: () => resolveSdk(),
  interactions,
  getWorkspaceRoot,
  buildHooks: ({ workspaceId, userSessionId }) => ({
    ...buildTaskHooks(tasks, {
      workspaceId,
      userSessionId,
      agentSessionId: null,
      participant: null,
    }),
    // B3: a finished agent unbinds its seat (turn.settled + status derive).
    SubagentStop: [
      {
        hooks: [
          async (input: unknown) => {
            const agentId = (input as { agent_id?: unknown }).agent_id;
            if (typeof agentId === "string") host.releaseAgent(agentId);
            return {};
          },
        ],
      },
    ],
  }),
  seats: {
    spawn: (callId, spawnName, agentSessionId, subagentType) =>
      host.observeAgentSpawn(callId, spawnName, agentSessionId, subagentType),
    launch: (callId, agentId) => host.confirmAgentLaunch(callId, agentId),
    seatOf: (callId) => host.seatOf(callId),
    seatOfAddress: (to) => host.seatOfSpawnAddress(to),
    recordMessage: (input) => host.recordDerivedMessage(input),
  },
  buildMcpServer: (userSessionId, sdk) =>
    buildConsoleMcpServer({ sdk, host, repo, bus, userSessionId, tasks }),
});
const userSessions = new UserSessionService({
  repo,
  bus,
  runner,
  interactions,
  workspaces,
});

// In-flight promises died with the previous process; their rows go stale so
// the UI renders greyed cards whose answers become revival turns (M8). Turns
// that died mid-flight are closed and their sessions put back in motion, and
// open agent sessions re-evaluate their drain from persisted rows.
interactions.expirePendingOnBoot();
const recovered = recoverInterruptedTurns({ repo, bus });
if (recovered > 0) {
  console.log(`recovered ${recovered} turn(s) interrupted by the last shutdown`);
}

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
