/**
 * Rubric judging over an exported live run or a whole series. Priced and
 * opt-in:
 *
 *   AGENTIQUE_LIVE_ORCH_EVAL=1 npx tsx server/evals/orchestration/live/judge.ts <runDir|seriesDir> [--reps M]
 *
 * For every rubric in rubrics/ that names one of the run scenario's stressed
 * dimensions: M repetitions (default 3) over the SAME frozen trace — judge
 * variance, deliberately distinct from run-live's --runs (behavioral
 * variance). The judge receives the rubric, the task card, the transcript,
 * and the MECHANICAL metrics (so it never re-derives counts). A failed
 * judgment is recorded as {error}, never silently absent; the process exits
 * non-zero when any dimension ends with zero successful repetitions. Scores
 * inform; they never gate (see README's Goodhart policy).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSdk } from "../../../src/sdk/client.ts";
import { mapSdkMessage } from "../../../src/sdk/mapping.ts";
import { sdkEnv } from "../../../src/sdk/env.ts";
import { SCENARIOS } from "../scenarios/index.ts";

if (process.env.AGENTIQUE_LIVE_ORCH_EVAL !== "1") {
  throw new Error("Judging is priced and opt-in. Set AGENTIQUE_LIVE_ORCH_EVAL=1 explicitly.");
}

const JUDGMENT_SCHEMA = {
  type: "object",
  required: ["score", "confidence", "evidence", "notes"],
  additionalProperties: false,
  properties: {
    score: { type: "integer", minimum: 1, maximum: 5 },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    evidence: {
      type: "array",
      items: {
        type: "object",
        required: ["quote"],
        additionalProperties: false,
        properties: { seq: { type: "integer" }, quote: { type: "string" } },
      },
    },
    notes: { type: "string" },
  },
} as const;

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("--"));
if (!target) throw new Error("usage: judge.ts <runDir|seriesDir> [--reps M]");
const repsIndex = args.indexOf("--reps");
const reps = repsIndex === -1 ? 3 : Math.max(1, Number(args[repsIndex + 1]));

const sdk = await resolveSdk();

async function judgeRun(runDir: string): Promise<{ dimensionsWithNoValidScore: string[] }> {
  const checks = JSON.parse(fs.readFileSync(path.join(runDir, "checks.json"), "utf8")) as { scenario: string };
  const scenario = SCENARIOS.find((entry) => entry.id === checks.scenario);
  if (!scenario) throw new Error(`unknown scenario ${checks.scenario}`);
  const transcript = fs.readFileSync(path.join(runDir, "transcript.md"), "utf8");
  const metrics = fs.readFileSync(path.join(runDir, "run.json"), "utf8");
  // Decision-time evidence: for the dimensions that judge WHAT WAS KNOWABLE
  // at each act, hand the judge the per-act packets and the full questions —
  // the decision-quality rubric demands contemporaneous context, and the
  // transcript alone under-serves it.
  const wantsDecisionEvidence = scenario.stressedDimensions.some((dimension) =>
    ["decision-quality", "question-quality", "question-economy", "intent-development"].includes(dimension));
  const readIfPresent = (file: string, cap: number): string => {
    const full = path.join(runDir, file);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8").slice(0, cap) : "";
  };
  const decisionEvidence = wantsDecisionEvidence
    ? `\n\n## Decision-time evidence packets (what was knowable AT each major act)\n${readIfPresent("evidence/packets.json", 30_000)}` +
      `\n\n## Questions asked and answered\n${readIfPresent("questions.json", 15_000)}`
    : "";

  const rubricsDir = path.join(here, "../rubrics");
  const rubricFiles = fs.readdirSync(rubricsDir).filter((name) => name.endsWith(".md") && !name.startsWith("_"));
  const relevant = rubricFiles.filter((name) => scenario.stressedDimensions.includes(name.replace(/\.md$/, "") as never));

  const judgments: unknown[] = [];
  const valid = new Map<string, number>();

  for (const rubricFile of relevant) {
    const dimension = rubricFile.replace(/\.md$/, "");
    const rubric = fs.readFileSync(path.join(rubricsDir, rubricFile), "utf8");
    valid.set(dimension, 0);
    for (let repetition = 1; repetition <= reps; repetition += 1) {
      let output: unknown;
      let failure: string | null = null;
      try {
        const query = sdk.query({
          prompt:
            `Judge ONE dimension of an orchestration run against the rubric below. ` +
            `Cite transcript evidence; distinguish decision quality (reasonable given what was known at the time) from outcome luck.\n\n` +
            `## Rubric: ${dimension}\n${rubric}\n\n## The operator's task\n${scenario.taskCard}\n\n` +
            `## Mechanical metrics (authoritative — do not re-derive counts)\n${metrics.slice(0, 20_000)}${decisionEvidence}\n\n` +
            `## Transcript\n${transcript.slice(0, 150_000)}`,
          options: {
            cwd: process.cwd(), systemPrompt: "You are a rigorous orchestration-trace judge. Score only the named dimension. Anchor every claim in quoted evidence.",
            settingSources: [], includePartialMessages: false, permissionMode: "plan", allowedTools: [],
            disallowedTools: ["Agent", "Bash", "Edit", "Write", "WebSearch", "WebFetch"],
            outputFormat: { type: "json_schema", schema: JUDGMENT_SCHEMA }, maxTurns: 2, env: sdkEnv(),
          },
        });
        try {
          for await (const raw of query) {
            for (const event of mapSdkMessage(raw)) {
              if (event.kind === "result") output = event.output;
            }
          }
        } finally {
          query.close?.();
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (output === undefined && failure === null) failure = "judge produced no structured output";
      if (failure !== null) {
        // Visible, never silently absent: a failed judgment is data.
        judgments.push({ dimension, repetition, error: failure });
        console.log(`${dimension} rep ${repetition}: FAILED — ${failure.slice(0, 120)}`);
      } else {
        judgments.push({ dimension, repetition, judgment: output });
        valid.set(dimension, (valid.get(dimension) ?? 0) + 1);
        console.log(`${dimension} rep ${repetition}: ${JSON.stringify(output).slice(0, 120)}`);
      }
    }
  }

  const outFile = path.join(runDir, "judgment.json");
  fs.writeFileSync(outFile, `${JSON.stringify({ version: 2, scenario: scenario.id, reps, judgments }, null, 2)}\n`);
  console.log(`wrote ${outFile}`);
  return { dimensionsWithNoValidScore: [...valid.entries()].filter(([, count]) => count === 0).map(([dimension]) => dimension) };
}

const isSeries = fs.existsSync(path.join(target, "series.json"));
const runDirs = isSeries
  ? fs.readdirSync(target).filter((name) => /^run-\d+$/.test(name)).sort().map((name) => path.join(target, name))
  : [target];

const dead: string[] = [];
for (const runDir of runDirs) {
  if (runDirs.length > 1) console.log(`\n== judging ${path.basename(runDir)}`);
  const { dimensionsWithNoValidScore } = await judgeRun(runDir);
  dead.push(...dimensionsWithNoValidScore.map((dimension) => `${path.basename(runDir)}:${dimension}`));
}
if (dead.length > 0) {
  console.error(`\nNO VALID JUDGMENTS for: ${dead.join(", ")} — the report would silently omit them; failing loudly instead.`);
  process.exit(1);
}
