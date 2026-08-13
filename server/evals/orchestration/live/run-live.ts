/**
 * Tier B: run scenarios against the REAL orchestrator. Priced and opt-in:
 *
 *   AGENTIQUE_LIVE_ORCH_EVAL=1 npx tsx server/evals/orchestration/live/run-live.ts \
 *     --scenario vague-greenfield|smoke|all [--budget-usd 10] [--label pre-charter]
 *
 * Per scenario: a fresh data dir + workspace (fixture-seeded), the real app
 * over the real SDK, the scripted operator policy, a hard budget/timeout
 * guard, then export: run.json, transcript.md, checks.json, workspace
 * snapshot. Results land in evals/orchestration/results/runs/<stamp>-<id>/.
 *
 * The "smoke" trio (vague-greenfield, agent-failure, wasteful-parallelism)
 * is the routine charter-iteration set; "all" is for before/after baselines.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../../src/app.ts";
import { bootApp, shutdownApp } from "../../../src/boot.ts";
import { loadConfig, type Config } from "../../../src/config.ts";
import { openDb } from "../../../src/db/client.ts";
import { workspaces } from "../../../src/db/schema.ts";
import { newId, nowIso } from "../../../src/ids.ts";
import { resolveSdk } from "../../../src/sdk/client.ts";
import type { UserSessionRow } from "../../../src/db/repo.ts";
import { SCENARIOS } from "../scenarios/index.ts";
import type { OrchestrationScenario } from "../scenario.ts";
import { Trace } from "../trace.ts";
import { exportRunToDir } from "./export-trace.ts";
import { runOperatorPolicy } from "./operator-policy.ts";

if (process.env.AGENTIQUE_LIVE_ORCH_EVAL !== "1") {
  throw new Error("Live orchestration eval is priced and opt-in. Set AGENTIQUE_LIVE_ORCH_EVAL=1 explicitly.");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function argOf(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const SMOKE = ["vague-greenfield", "agent-failure", "wasteful-parallelism"];
const which = argOf("--scenario") ?? "smoke";
const budgetOverride = argOf("--budget-usd") !== undefined ? Number(argOf("--budget-usd")) : undefined;
const label = argOf("--label") ?? "run";

const selected: OrchestrationScenario[] =
  which === "all" ? SCENARIOS.filter((scenario) => scenario.live !== undefined)
  : which === "smoke" ? SCENARIOS.filter((scenario) => SMOKE.includes(scenario.id))
  : SCENARIOS.filter((scenario) => scenario.id === which);
if (selected.length === 0) throw new Error(`no scenario matches "${which}"`);

function seedWorkspace(fixture: string | undefined, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (fixture === undefined || fixture === "empty-workspace") return;
  const source = path.join(here, "../fixtures", fixture);
  if (!fs.existsSync(source)) throw new Error(`fixture missing: ${source} — add it under evals/orchestration/fixtures/`);
  fs.cpSync(source, dir, { recursive: true });
}

async function runOne(scenario: OrchestrationScenario): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.join(here, "../results/runs", `${stamp}-${label}-${scenario.id}`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `orch-eval-${scenario.id}-`));
  const workspaceRoot = path.join(dataDir, "workspace");
  seedWorkspace(scenario.live?.fixture, workspaceRoot);

  const base = loadConfig({ ...process.env, CONSOLE_DATA_DIR: dataDir });
  const config: Config = base;
  const { db, sqlite } = openDb(config.infra.dbFile);
  const app = createApp({ config, db, sqlite, sdk: () => resolveSdk() });
  await bootApp(app);

  const workspaceId = newId("ws");
  db.insert(workspaces).values({ id: workspaceId, name: scenario.id, rootPath: workspaceRoot, metadata: {}, createdAt: nowIso(), updatedAt: nowIso() }).run();
  const session: UserSessionRow = {
    id: newId("us"), workspaceId, title: scenario.title, mode: "execute", phase: "executing",
    lifecycle: "open", purpose: "work", subjectKey: null, sdkSessionId: null, sdkGeneration: 0,
    sdkTurnCount: 0, contextTokens: 0, memory: "", latestHandoffId: null, cumulativeCostUsd: 0,
    cumulativeApiDurationMs: 0, runState: "active", runBaseCommit: null, model: null,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  app.repo.insertUserSession(session);

  const budgetUsd = budgetOverride ?? scenario.live?.maxBudgetUsd ?? 10;
  const timeoutMs = (scenario.live?.timeoutMin ?? 30) * 60_000;
  const startedAt = Date.now();
  console.log(`\n== ${scenario.id} → ${outDir}\n   budget $${budgetUsd}, timeout ${timeoutMs / 60_000}m`);

  const operator = runOperatorPolicy(app, session.id, scenario.operatorScript, { log: (line) => console.log(`   ${line}`) });
  app.runner.postOperatorMessage(session.id, scenario.taskCard);

  let outcome = "timeout";
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const spent = (sqlite.prepare("SELECT COALESCE(sum(cost_usd), 0) AS c FROM usage_samples").get() as { c: number }).c;
    const proposed = (sqlite.prepare("SELECT count(*) AS n FROM events WHERE type = 'run.completion.proposed'").get() as { n: number }).n;
    if (proposed > 0) { outcome = "completion-proposed"; break; }
    if (spent >= budgetUsd) { outcome = `budget-exceeded ($${spent.toFixed(2)})`; break; }
    if (Date.now() - startedAt >= timeoutMs) { outcome = "timeout"; break; }
  }

  operator.stop();
  await shutdownApp(app).catch(() => undefined);
  sqlite.close();

  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(config.infra.dbFile, path.join(outDir, "console.db"));
  // The artifact axis: snapshot the final workspace next to the trace.
  fs.cpSync(workspaceRoot, path.join(outDir, "workspace"), { recursive: true });
  exportRunToDir(path.join(outDir, "console.db"), outDir);

  const trace = Trace.fromFile(path.join(outDir, "console.db"), session.id);
  const checks = scenario.checks.map((check) => ({
    id: check.id, dimension: check.dimension, description: check.description, ...check.run(trace),
  }));
  trace.close();
  fs.writeFileSync(path.join(outDir, "checks.json"), `${JSON.stringify({ scenario: scenario.id, label, outcome, checks }, null, 2)}\n`);
  console.log(`   outcome: ${outcome}`);
  for (const check of checks) console.log(`   ${check.pass ? "PASS" : "FLAG"} ${check.id} — ${check.detail}`);
}

for (const scenario of selected) {
  await runOne(scenario);
}
