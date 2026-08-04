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
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentSessionHost } from "../src/agent-sessions/host.ts";
import { AgentProfileRegistry } from "../src/agent-profiles/registry.ts";
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
import { TaskService } from "../src/tasks/service.ts";
import { WorkspaceService } from "../src/workspaces/service.ts";

const config = loadConfig();

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
const tasks = new TaskService(db, bus);
const getWorkspaceRoot = (id: string) => workspaces.get(id).rootPath;

const sessionStore = new SqliteSessionStore(db);
let runner!: OrchestratorRunner;
const host = new AgentSessionHost({
  repo, bus, config, profiles: new AgentProfileRegistry(config.profilesFile),
  sdk: () => resolveSdk(), sessionStore, getWorkspaceRoot, interactions, tasks,
  wake: (userSessionId, agentSessionId, category, text) => runner.enqueueAgentMilestone(userSessionId, agentSessionId, category, text),
});
runner = new OrchestratorRunner({
  repo,
  bus,
  config,
  sdk: () => resolveSdk(),
  interactions,
  getWorkspaceRoot,
  sessionStore,
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
  // A parked coordinator is invisible between specialist settle and its
  // report — a longer quiet window keeps the smoke from cutting it off.
  if (quietFor >= 20_000) break;
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
// The persistent lane is a live CLI subprocess — close it or the script hangs.
await runner.closeAll();
sqlite.close();
process.exit(0);
