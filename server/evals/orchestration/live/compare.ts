/**
 * Compare a judged run against the committed baseline, per dimension, with the
 * judge's qualitative notes shown beside every delta. Never a single scalar.
 *
 *   npx tsx server/evals/orchestration/live/compare.ts <runDir> [baselineFile]
 *
 * Baseline bumps are explicit human-reviewed commits: read the notes, cite
 * trace evidence seqs, then update results/baseline.json deliberately.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Judgment { dimension: string; repetition: number; judgment: { score?: number; notes?: string } | null }

const here = path.dirname(fileURLToPath(import.meta.url));
const runDir = process.argv[2];
if (!runDir) throw new Error("usage: compare.ts <runDir> [baselineFile]");
const baselineFile = process.argv[3] ?? path.join(here, "../results/baseline.json");

const run = JSON.parse(fs.readFileSync(path.join(runDir, "judgment.json"), "utf8")) as { scenario: string; judgments: Judgment[] };
const checks = JSON.parse(fs.readFileSync(path.join(runDir, "checks.json"), "utf8")) as { scenario: string; outcome: string; checks: { id: string; pass: boolean; detail: string }[] };
const baseline = fs.existsSync(baselineFile)
  ? (JSON.parse(fs.readFileSync(baselineFile, "utf8")) as { scenarios?: Record<string, { dimensions?: Record<string, { median: number }> }> })
  : {};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

console.log(`# ${run.scenario} vs baseline\n`);
console.log(`outcome: ${checks.outcome}`);
for (const check of checks.checks) console.log(`  ${check.pass ? "PASS" : "FLAG"} ${check.id} — ${check.detail}`);

const byDimension = new Map<string, Judgment[]>();
for (const entry of run.judgments) {
  byDimension.set(entry.dimension, [...(byDimension.get(entry.dimension) ?? []), entry]);
}
console.log("\n## Judged dimensions (median of 3; spread in brackets)\n");
for (const [dimension, entries] of byDimension) {
  const scores = entries.map((entry) => entry.judgment?.score).filter((value): value is number => typeof value === "number");
  const med = median(scores);
  const spread = scores.length > 0 ? `${Math.min(...scores)}–${Math.max(...scores)}` : "–";
  const base = baseline.scenarios?.[run.scenario]?.dimensions?.[dimension]?.median;
  const delta = med !== null && base !== undefined ? ` (baseline ${base}, Δ${(med - base) >= 0 ? "+" : ""}${med - base})` : base === undefined ? " (no baseline)" : "";
  console.log(`- **${dimension}**: ${med ?? "–"} [${spread}]${delta}`);
  const notes = entries.map((entry) => entry.judgment?.notes).filter((value): value is string => typeof value === "string" && value !== "");
  for (const note of notes.slice(0, 1)) console.log(`  > ${note.slice(0, 400)}`);
}
console.log("\nQualitative notes above are part of the verdict — a delta without its note is not evidence.");
