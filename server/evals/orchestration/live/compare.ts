/**
 * Compare a judged run or series against the committed baseline, per
 * dimension, with the judge's qualitative notes shown beside every delta.
 * Never a single scalar, and never a blended axis:
 *
 * - JUDGE variance: per run, M repetitions over the same frozen trace —
 *   shown as that run's median [min–max].
 * - BEHAVIORAL variance: across N independent runs — shown as the across-run
 *   median and range, and check pass-rates as k/N. Reported ONLY when N ≥ 2;
 *   an N=1 series is labeled a single behavioral sample and no
 *   behavioral-variance language appears.
 *
 *   npx tsx server/evals/orchestration/live/compare.ts <runDir|seriesDir> [baselineFile]
 *
 * Baseline bumps are explicit human-reviewed commits: read the notes, cite
 * trace evidence seqs, then update results/baseline.json deliberately.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Judgment { dimension: string; repetition: number; judgment?: { score?: number; notes?: string } | null; error?: string }
interface RunReport {
  name: string;
  scenario: string;
  outcome: string;
  checks: { id: string; pass: boolean; detail: string }[];
  judgments: Judgment[];
  outcomeJudgments: Judgment[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
if (!target) throw new Error("usage: compare.ts <runDir|seriesDir> [baselineFile]");
const baselineFile = process.argv[3] ?? path.join(here, "../results/baseline.json");

function readRun(runDir: string): RunReport {
  const checks = JSON.parse(fs.readFileSync(path.join(runDir, "checks.json"), "utf8")) as { scenario: string; outcome: string; checks: RunReport["checks"] };
  const judgmentFile = path.join(runDir, "judgment.json");
  const parsed = fs.existsSync(judgmentFile)
    ? (JSON.parse(fs.readFileSync(judgmentFile, "utf8")) as { judgments: Judgment[]; outcomeJudgments?: Judgment[] })
    : { judgments: [], outcomeJudgments: [] };
  return { name: path.basename(runDir), scenario: checks.scenario, outcome: checks.outcome, checks: checks.checks,
    judgments: parsed.judgments, outcomeJudgments: parsed.outcomeJudgments ?? [] };
}

const isSeries = fs.existsSync(path.join(target, "series.json"));
const runs: RunReport[] = isSeries
  ? fs.readdirSync(target).filter((name) => /^run-\d+$/.test(name)).sort().map((name) => readRun(path.join(target, name)))
  : [readRun(target)];
if (runs.length === 0) throw new Error(`no runs found under ${target}`);
const scenario = runs[0]!.scenario;

const baseline = fs.existsSync(baselineFile)
  ? (JSON.parse(fs.readFileSync(baselineFile, "utf8")) as { scenarios?: Record<string, { dimensions?: Record<string, { median: number }> }> })
  : {};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

const single = runs.length === 1;
console.log(`# ${scenario} — ${single ? "single behavioral sample (N=1)" : `${runs.length} independent runs`} vs baseline\n`);
if (single) {
  console.log("One orchestrator execution: judge spread below measures JUDGE variance only —");
  console.log("no behavioral-variance or stability claim can be made from one sample.\n");
}

// Checks: pass-rates across runs (k/N) when N ≥ 2; plain verdicts when N=1.
console.log("## Mechanical checks\n");
const checkIds = [...new Set(runs.flatMap((run) => run.checks.map((check) => check.id)))];
for (const id of checkIds) {
  const verdicts = runs.map((run) => run.checks.find((check) => check.id === id)).filter((check) => check !== undefined);
  const passed = verdicts.filter((check) => check!.pass).length;
  if (single) {
    const check = verdicts[0]!;
    console.log(`  ${check.pass ? "PASS" : "FLAG"} ${id} — ${check.detail}`);
  } else {
    console.log(`  ${passed}/${runs.length} runs PASS ${id}${passed < runs.length ? ` — e.g. ${verdicts.find((check) => !check!.pass)!.detail}` : ""}`);
  }
}
for (const run of runs) console.log(`  (${run.name} outcome: ${run.outcome})`);

function renderDimensions(entriesOf: (run: RunReport) => Judgment[]): void {
  const dimensions = [...new Set(runs.flatMap((run) => entriesOf(run).map((entry) => entry.dimension)))];
  if (dimensions.length === 0) {
    console.log("(no judgments recorded)");
    return;
  }
  for (const dimension of dimensions) {
    const perRun = runs.map((run) => {
      const entries = entriesOf(run).filter((entry) => entry.dimension === dimension);
      const scores = entries.map((entry) => entry.judgment?.score).filter((value): value is number => typeof value === "number");
      const failed = entries.filter((entry) => entry.error !== undefined).length;
      return { run: run.name, scores, failed, total: entries.length, median: median(scores), notes: entries.map((entry) => entry.judgment?.notes).filter((value): value is string => typeof value === "string" && value !== "") };
    });
    const parts = perRun.map((entry) => {
      if (entry.scores.length < 2) return `${entry.run}: insufficient valid judgments (${entry.scores.length}/${entry.total})`;
      const spread = `${Math.min(...entry.scores)}–${Math.max(...entry.scores)}`;
      const failures = entry.failed > 0 ? `, ${entry.total - entry.failed}/${entry.total} judgments succeeded` : "";
      return `${entry.run}: ${entry.median} [${spread}]${failures}`;
    });
    const runMedians = perRun.map((entry) => entry.median).filter((value): value is number => value !== null);
    const across = !single && runMedians.length >= 2
      ? ` | across runs: ${median(runMedians)} (range ${Math.min(...runMedians)}–${Math.max(...runMedians)})`
      : "";
    const base = baseline.scenarios?.[scenario]?.dimensions?.[dimension]?.median;
    const anchor = single ? perRun[0]!.median : median(runMedians);
    const delta = anchor !== null && base !== undefined ? ` (baseline ${base}, Δ${(anchor - base) >= 0 ? "+" : ""}${anchor - base})` : base === undefined ? " (no baseline)" : "";
    console.log(`- **${dimension}**: ${parts.join("; ")}${across}${delta}`);
    const note = perRun.flatMap((entry) => entry.notes)[0];
    if (note !== undefined) console.log(`  > ${note.slice(0, 400)}`);
  }
}

// Judged dimensions: per-run judge medians, then (N ≥ 2 only) across-run stats.
console.log(`\n## Trace axis — judged dimensions (judge median of reps per run${single ? "" : "; across-run median and range"})\n`);
renderDimensions((run) => run.judgments);

// The artifact, on its own axis — never averaged with trace dimensions: a
// beautiful trace with an inferior artifact is a failure, and a good artifact
// from a poor process is luck. Both facts must survive the report.
console.log("\n## Outcome axis — artifact quality (separate axis, never blended with the trace)\n");
renderDimensions((run) => run.outcomeJudgments);
console.log("\nQualitative notes above are part of the verdict — a delta without its note is not evidence.");
