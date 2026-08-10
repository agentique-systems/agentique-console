import { AgentProfileRegistry } from "./agent-profiles/registry.ts";
import { createApp, type App } from "./app.ts";
import { loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { openDb } from "./db/client.ts";
import { Repo } from "./db/repo.ts";
import { EventBus } from "./events/bus.ts";
import { reapOrphanedProcesses } from "./completion/orphans.ts";
import { reconcileDurableCommunication, recoverInterruptedTurns } from "./recovery.ts";
import { resolveSdk } from "./sdk/client.ts";
import { ProcessManager } from "./runtime/process-manager.ts";
import { BrowserManager } from "./runtime/browser-manager.ts";
import { WorktreeManager } from "./runtime/worktree-manager.ts";
import { UserSessionService } from "./sessions/service.ts";
import { WorkspaceService } from "./workspaces/service.ts";
import { buildServer } from "./api/server.ts";
import { TimelineService } from "./timeline/service.ts";
import { ManagerService } from "./agent-profiles/manager.ts";
import { buildManagerMcpServer } from "./agent-profiles/tools.ts";

const config = loadConfig();
const { db, sqlite } = openDb(config.dbFile);
const bus = new EventBus(db);
const repo = new Repo(db, sqlite);
const workspaces = new WorkspaceService(
  db,
  bus,
  config.fsRoots.map((r) => r.path),
);
const timeline = new TimelineService(repo, bus);
const getWorkspaceRoot = (workspaceId: string): string =>
  workspaces.get(workspaceId).rootPath;
const profiles = new AgentProfileRegistry(undefined, { getWorkspaceRoot, db, bus });
const processes = new ProcessManager(bus);
const browsers = new BrowserManager(bus);
const worktrees = new WorktreeManager({ dataDir: config.dataDir });

let app!: App;
const manager = new ManagerService({ repo, workspaces, profiles, config, bus, runner: () => app.runner });
app = createApp({
  config, db, bus, repo,
  sdk: () => resolveSdk(),
  getWorkspaceRoot,
  profiles,
  processes, browsers, worktrees,
  buildAlternateMcpServer: (userSessionId, sdk) =>
    repo.getUserSession(userSessionId)?.purpose === "profile_manager"
      ? buildManagerMcpServer(sdk, manager, userSessionId)
      : undefined,
});
const { interactions, host, runner, tasks, handoffs, completion } = app;

const userSessions = new UserSessionService({
  repo,
  bus,
  runner,
  interactions,
  workspaces,
  archiveAgentSessions: (userSessionId) => host.archiveForUserSession(userSessionId),
  completion,
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
// Worktrees intentionally survive restarts (their seats resume in place);
// only directories whose session is gone/archived are orphans.
const liveWorktrees = new Set([
  ...repo.listWorktreeSeats().map((seat) => seat.worktreePath),
]);
const orphaned = worktrees.recoverOrphans(
  (agentSessionId, dirName) => {
    const session = repo.getAgentSession(agentSessionId);
    if (!session || session.status !== "open") return false;
    for (const path of liveWorktrees) if (path.endsWith(dirName)) return true;
    return false;
  },
  (agentSessionId) => {
    const session = repo.getAgentSession(agentSessionId);
    const user = session ? repo.getUserSession(session.userSessionId) : undefined;
    try { return user ? getWorkspaceRoot(user.workspaceId) : null; } catch { return null; }
  },
);
if (orphaned > 0) console.log(`removed ${orphaned} orphaned worktree(s)`);
// Managed children of a PREVIOUS process are unreachable by id but still hold
// their ports. db-live-2 leaked `node serve.mjs` on :8173 and the next run
// inherited it as a foreign app squatting the port it wanted.
const orphanProcesses = reapOrphanedProcesses({ repo, bus });
if (orphanProcesses > 0) console.log(`reaped ${orphanProcesses} orphaned process(es) from a previous run`);
host.boot();
// Children whose parent archived or vanished across the restart can never
// report to anyone — the one genuinely new orphan class nesting introduces.
const orphanChildren = host.archiveOrphanChildren();
if (orphanChildren > 0) console.log(`archived ${orphanChildren} orphaned child session(s)`);
runner.startCronFallback();
// A run that finished while the process was down still deserves its card.
for (const session of repo.listOpenWorkSessions()) completion.schedule(session.id);
// Release `ask_operator` waits the operator has not come back to — the card
// stays answerable; the timer only stops a human's absence from pinning a
// seat process indefinitely.
host.startGovernanceSweep();

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
  handoffs,
  timeline,
  completion,
  profiles,
  manager,
  sdk: () => resolveSdk(),
};

const httpServer = buildServer(ctx);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  bus.closeSubscriptions();
  completion.stop();
  host.stopGovernanceSweep();
  // Persistent lanes are CLI subprocesses — none may outlive the server.
  await runner.closeAll().catch(() => undefined);
  await host.closeAll().catch(() => undefined);
  processes.closeAll();
  await browsers.closeAll().catch(() => undefined);
  await httpServer.close().catch(() => undefined);
  sqlite.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

httpServer
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
