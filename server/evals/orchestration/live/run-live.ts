/**
 * Tier B: run scenarios against the REAL orchestrator. Priced and opt-in:
 *
 *   AGENTIQUE_LIVE_ORCH_EVAL=1 npx tsx server/evals/orchestration/live/run-live.ts \
 *     --scenario vague-greenfield|smoke|all [--runs N] [--budget-usd 10] [--label after-charter]
 *
 * --runs N executes the orchestrator N INDEPENDENT times (fresh data dir and
 * workspace each) — behavioral variance. That is a different quantity from
 * the judge's repetitions over one frozen trace (judge --reps), and the two
 * are never blended: a series with N=1 is a single behavioral sample and the
 * report says so.
 *
 * Per scenario: a fresh data dir + workspace (fixture-seeded and committed as
 * a git baseline for the artifact diff), the real app over the real SDK, the
 * scripted operator policy, a hard budget/timeout guard, then export:
 * run.json, transcript.md, checks.json, workspace snapshot, unmerged
 * worktrees. Results land in evals/orchestration/results/runs/<stamp>-<id>/.
 *
 * A scenario whose prerequisites are missing (absent fixture, no browser MCP)
 * SKIPs with a printed reason — `--scenario all` and `smoke` always complete.
 *
 * The "smoke" trio (vague-greenfield, wasteful-parallelism,
 * hidden-constraint) is the routine charter-iteration set; "all" is for
 * post-change reference series.
 */
import { execFileSync } from "node:child_process";
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
import { exportEvidenceBundle } from "./export-evidence.ts";
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

const SMOKE = ["vague-greenfield", "wasteful-parallelism", "hidden-constraint"];
const which = argOf("--scenario") ?? "smoke";
const budgetOverride = argOf("--budget-usd") !== undefined ? Number(argOf("--budget-usd")) : undefined;
const runsOverride = argOf("--runs") !== undefined ? Number(argOf("--runs")) : undefined;
const label = argOf("--label") ?? "run";

const selected: OrchestrationScenario[] =
  which === "all" ? SCENARIOS.filter((scenario) => scenario.live !== undefined)
  : which === "smoke" ? SCENARIOS.filter((scenario) => SMOKE.includes(scenario.id))
  : SCENARIOS.filter((scenario) => scenario.id === which);
if (selected.length === 0) throw new Error(`no scenario matches "${which}"`);

/** A missing prerequisite is a SKIP with a reason, never a throw — the suite always completes. */
function skipReasonOf(scenario: OrchestrationScenario): string | null {
  const fixture = scenario.live?.fixture;
  if (fixture !== undefined && fixture !== "empty-workspace" && !fs.existsSync(path.join(here, "../fixtures", fixture))) {
    return `fixture missing: evals/orchestration/fixtures/${fixture}`;
  }
  if (scenario.live?.needsBrowser === true && (process.env.CONSOLE_BROWSER_MCP ?? "") === "") {
    return "needs a browser MCP: set CONSOLE_BROWSER_MCP";
  }
  return null;
}

function seedWorkspace(fixture: string | undefined, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (fixture !== undefined && fixture !== "empty-workspace") {
    fs.cpSync(path.join(here, "../fixtures", fixture), dir, { recursive: true });
  }
  // The fixture baseline commit anchors the artifact diff: "what did the run
  // change" is only well-defined against a committed starting point.
  const git = (...argv: string[]) => execFileSync("git", ["-C", dir, ...argv], { stdio: "pipe" });
  git("init", "--quiet");
  git("-c", "user.name=orch-eval", "-c", "user.email=orch-eval@localhost", "add", "-A");
  git("-c", "user.name=orch-eval", "-c", "user.email=orch-eval@localhost", "commit", "--quiet", "--allow-empty", "-m", "fixture-baseline");
}

async function runOne(scenario: OrchestrationScenario, outDir: string): Promise<void> {
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
  // The artifact axis: snapshot the final workspace (with its git history —
  // the fixture-baseline commit anchors diffs) next to the trace, and the
  // seat worktrees: unmerged/in-flight work is exactly the interesting
  // failure evidence, and it lives outside the workspace until a seat lands.
  fs.cpSync(workspaceRoot, path.join(outDir, "workspace"), { recursive: true });
  const worktreesDir = path.join(dataDir, "worktrees");
  if (fs.existsSync(worktreesDir)) fs.cpSync(worktreesDir, path.join(outDir, "worktrees"), { recursive: true });
  exportRunToDir(path.join(outDir, "console.db"), outDir);
  exportEvidenceBundle(scenario, outDir);

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
  const skip = skipReasonOf(scenario);
  if (scenario.live === undefined) {
    console.log(`\n== ${scenario.id} SKIP — structural-only (no live block)`);
    continue;
  }
  if (skip !== null) {
    console.log(`\n== ${scenario.id} SKIP — ${skip}`);
    continue;
  }
  const runs = Math.max(1, runsOverride ?? scenario.live.defaultRuns ?? 1);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const seriesDir = path.join(here, "../results/runs", `${stamp}-${label}-${scenario.id}`);
  fs.mkdirSync(seriesDir, { recursive: true });
  fs.writeFileSync(path.join(seriesDir, "series.json"),
    `${JSON.stringify({ version: 1, scenario: scenario.id, label, runs, budgetPerRunUsd: budgetOverride ?? scenario.live.maxBudgetUsd, startedAt: nowIso() }, null, 2)}\n`);
  for (let run = 1; run <= runs; run += 1) {
    if (runs > 1) console.log(`\n=== ${scenario.id} run ${run}/${runs} (independent execution)`);
    await runOne(scenario, path.join(seriesDir, `run-${run}`));
  }
}
