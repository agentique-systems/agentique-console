/**
 * Real-SDK smoke (M9): drives one workspace, one question, one delegation
 * against a scratch directory using the REAL Claude Agent SDK. Priced — run
 * deliberately. Requires the server NOT to be running (it opens its own DB).
 *
 *   CONSOLE_DATA_DIR=/tmp/console-smoke npx tsx server/scripts/smoke.ts
 *
 * What to check afterwards (sqlite3 $CONSOLE_DATA_DIR/console.db):
 *   select type, count(*) from events group by 1;      -- spine coherent
 *   select status, count(*) from tasks group by 1;     -- mirror filled
 *   select count(*) from sdk_session_entries;          -- transcripts mirrored
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentSessionHost } from "../src/agent-sessions/host.ts";
import { buildSeatPlanCapture } from "../src/agent-sessions/plan-capture.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/client.ts";
import { Repo } from "../src/db/repo.ts";
import { EventBus } from "../src/events/bus.ts";
import { InteractionService } from "../src/orchestrator/interactions.ts";
import { OrchestratorRunner } from "../src/orchestrator/runner.ts";
import { buildConsoleMcpServer } from "../src/orchestrator/tools.ts";
import { resolveSdk } from "../src/sdk/client.ts";
import { SqliteSessionStore } from "../src/sdk/session-store.ts";
import { UserSessionService } from "../src/sessions/service.ts";
import { buildTaskHooks } from "../src/tasks/hooks.ts";
import { TaskService } from "../src/tasks/service.ts";
import { WorkspaceService } from "../src/workspaces/service.ts";

const config = loadConfig();
if (config.fakeSdk) {
  console.error("Unset CONSOLE_FAKE_SDK — this smoke uses the real SDK.");
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "console-smoke-"));
fs.writeFileSync(
  path.join(scratch, "README.md"),
  "# Smoke scratch\n\nA tiny workspace. The answer to the riddle is: pelican.\n",
);
console.log(`scratch workspace: ${scratch}`);
console.log(`data dir: ${config.dataDir}`);

const { db, sqlite } = openDb(config.dbFile);
const bus = new EventBus(db);
const repo = new Repo(db, sqlite);
const workspaces = new WorkspaceService(db, bus, [os.tmpdir()]);
const interactions = new InteractionService(db, bus);
const sessionStore = new SqliteSessionStore(db);
const tasks = new TaskService(db, bus);
const getWorkspaceRoot = (id: string) => workspaces.get(id).rootPath;

let runnerRef: OrchestratorRunner | null = null;
let hostRef: AgentSessionHost | null = null;
const host = new AgentSessionHost({
  repo,
  bus,
  config,
  sdk: () => resolveSdk(config),
  sessionStore,
  getWorkspaceRoot,
  wake: (us, as) => runnerRef?.enqueueWake(us, as),
  buildHooks: (attr) => buildTaskHooks(tasks, attr),
  taskLines: (id) => tasks.linesForAgentSession(id),
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
  sdk: () => resolveSdk(config),
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
  buildWakeDigests: (us, ids) => host.buildWakeDigests(us, ids),
});
runnerRef = runner;
const userSessions = new UserSessionService({
  repo,
  bus,
  runner,
  interactions,
  workspaces,
});

// Console every spine event as it happens.
void (async () => {
  for await (const event of bus.readWithSeq({
    fromSeq: bus.headSeq() + 1,
    follow: true,
  })) {
    if (event.transient) continue;
    const preview = JSON.stringify(event.payload).slice(0, 140);
    console.log(`  [${event.seq}] ${event.type} ${preview}`);
  }
})();

const workspace = await workspaces.create({
  name: "smoke",
  rootPath: scratch,
});
const session = userSessions.create({
  workspaceId: workspace.id,
  mode: "execute",
  message:
    "Create one agent session with a single explorer seat named scout, and have it " +
    "find the answer to the riddle hidden in this workspace's README. Report the " +
    "answer back to me, and track the work with a task.",
});
console.log(`user session: ${session.id}`);

// Auto-answer any question the orchestrator raises (first option).
const answerLoop = setInterval(() => {
  for (const pending of interactions.listPending(session.id)) {
    if (pending.status !== "pending") continue;
    if (pending.kind === "question") {
      const questions = (pending.payload as {
        questions: { question: string; options: { label: string }[] }[];
      }).questions;
      const answers = Object.fromEntries(
        questions.map((q) => [q.question, [q.options[0]?.label ?? "ok"]]),
      );
      console.log(`  answering question ${pending.id}:`, answers);
      interactions.resolveFromApi(session.id, pending.id, { answers });
    } else {
      console.log(`  approving plan ${pending.id}`);
      interactions.resolveFromApi(session.id, pending.id, {
        decision: "approve",
      });
    }
  }
}, 1000);

// Wait until the session has been quiet for a while, then report.
let quietFor = 0;
const start = Date.now();
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const busy =
    runner.busy(session.id) ||
    host.listForUserSession(session.id).some((s) => s.status === "working");
  quietFor = busy ? 0 : quietFor + 2000;
  if (quietFor >= 10_000) break;
  if (Date.now() - start > 10 * 60_000) {
    console.error("smoke timed out after 10 minutes");
    break;
  }
}
clearInterval(answerLoop);

console.log("\n--- transcript (user session) ---");
for (const row of repo.listMessages("user", session.id)) {
  console.log(`[${row.speakerName}] ${row.text}`);
}
console.log("\n--- agent sessions ---");
for (const s of host.listForUserSession(session.id)) {
  console.log(`${s.id} "${s.title}" [${s.status}] seats: ${s.participants.join(", ")}`);
  for (const row of repo.listMessages("agent", s.id)) {
    console.log(`  [${row.speakerName}${row.toName ? ` → ${row.toName}` : ""}] ${row.text.slice(0, 200)}`);
  }
}
console.log("\n--- tasks ---");
for (const task of tasks.listForUserSession(session.id)) {
  console.log(
    `[${task.status}] ${task.subject} (owner: ${task.owner ?? "-"}, blockedBy: ${task.blockedBy.join(",") || "-"})`,
  );
}
console.log(`\nevents total: ${bus.headSeq()}`);
bus.closeSubscriptions();
sqlite.close();
process.exit(0);
