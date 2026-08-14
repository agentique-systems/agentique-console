/**
 * Rubric judging over an exported live run or a whole series. Priced and
 * opt-in:
 *
 *   AGENTIQUE_LIVE_ORCH_EVAL=1 npx tsx server/evals/orchestration/live/judge.ts <runDir|seriesDir> \
 *     [--reps M] [--axis trace|outcome|both]
 *
 * TRACE axis: for every rubric naming one of the scenario's stressed
 * dimensions, M repetitions (default 3) over the SAME frozen trace — judge
 * variance, deliberately distinct from run-live's --runs (behavioral
 * variance). The judge receives the rubric, the task card, the transcript,
 * the MECHANICAL metrics, and (for decision/question dimensions) the per-act
 * evidence packets.
 *
 * OUTCOME axis: the artifact bundle is the SOLE input — no transcript, so a
 * beautiful orchestration story can never halo the artifact score. Validator
 * results are authoritative for "does it work". Reported beside the trace
 * axis, never averaged with it.
 *
 * A failed judgment is recorded as {error}, never silently absent; the
 * process exits non-zero when any dimension ends with zero successful
 * repetitions. Scores inform; they never gate (README's Goodhart policy).
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
if (!target) throw new Error("usage: judge.ts <runDir|seriesDir> [--reps M] [--axis trace|outcome|both]");
const repsIndex = args.indexOf("--reps");
const reps = repsIndex === -1 ? 3 : Math.max(1, Number(args[repsIndex + 1]));
const axisIndex = args.indexOf("--axis");
const axis = (axisIndex === -1 ? "both" : args[axisIndex + 1]) as "trace" | "outcome" | "both";
if (!["trace", "outcome", "both"].includes(axis)) throw new Error(`--axis must be trace|outcome|both, got ${axis}`);

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
  const outcomeJudgments: unknown[] = [];
  const valid = new Map<string, number>();

  async function judgeOnce(prompt: string, systemPrompt: string): Promise<{ output: unknown; failure: string | null }> {
    let output: unknown;
    let failure: string | null = null;
    try {
      const query = sdk.query({
        prompt,
        options: {
          cwd: process.cwd(), systemPrompt,
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
    return { output, failure };
  }

  if (axis !== "outcome") {
    for (const rubricFile of relevant) {
      const dimension = rubricFile.replace(/\.md$/, "");
      const rubric = fs.readFileSync(path.join(rubricsDir, rubricFile), "utf8");
      valid.set(dimension, 0);
      for (let repetition = 1; repetition <= reps; repetition += 1) {
        const { output, failure } = await judgeOnce(
          `Judge ONE dimension of an orchestration run against the rubric below. ` +
          `Cite transcript evidence; distinguish decision quality (reasonable given what was known at the time) from outcome luck.\n\n` +
          `## Rubric: ${dimension}\n${rubric}\n\n## The operator's task\n${scenario.taskCard}\n\n` +
          `## Mechanical metrics (authoritative — do not re-derive counts)\n${metrics.slice(0, 20_000)}${decisionEvidence}\n\n` +
          `## Transcript\n${transcript.slice(0, 150_000)}`,
          "You are a rigorous orchestration-trace judge. Score only the named dimension. Anchor every claim in quoted evidence.",
        );
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
  }

  // The OUTCOME axis: the artifact bundle is the sole input — no transcript,
  // so a beautiful orchestration story cannot halo the artifact score (nor a
  // messy one taint it). Validator results are authoritative for "does it
  // work"; the judge scores only quality above that floor.
  const evidenceDir = path.join(runDir, "evidence");
  const hasArtifact = fs.existsSync(path.join(evidenceDir, "tree.txt"));
  if (axis !== "trace" && hasArtifact) {
    const readCapped = (file: string, cap: number): string => {
      const full = path.join(evidenceDir, file);
      return fs.existsSync(full) ? fs.readFileSync(full, "utf8").slice(0, cap) : "(absent)";
    };
    const filesDir = path.join(evidenceDir, "files");
    const fileSections = fs.existsSync(filesDir)
      ? fs.readdirSync(filesDir).map((name) => `### ${name.replaceAll("__", "/")}\n${fs.readFileSync(path.join(filesDir, name), "utf8").slice(0, 24_000)}`).join("\n\n")
      : "(none selected)";
    const screenshots = fs.existsSync(path.join(evidenceDir, "screenshots"))
      ? fs.readdirSync(path.join(evidenceDir, "screenshots")).join(", ")
      : "none";
    const approvedSpec = (() => {
      const file = path.join(runDir, "spec-revisions.json");
      if (!fs.existsSync(file)) return "(no spec recorded)";
      const revisions = JSON.parse(fs.readFileSync(file, "utf8")) as { status: string; document: string; revision: number }[];
      const approved = [...revisions].reverse().find((row) => row.status === "approved");
      return approved === undefined ? "(no approved revision)" : `rev ${approved.revision}:\n${approved.document.slice(0, 12_000)}`;
    })();
    const rubric = fs.readFileSync(path.join(rubricsDir, "outcome-quality.md"), "utf8");
    valid.set("outcome-quality", 0);
    for (let repetition = 1; repetition <= reps; repetition += 1) {
      const { output, failure } = await judgeOnce(
        `Judge the ARTIFACT a run produced — the work itself, not the process that produced it. ` +
        `You are given no transcript, deliberately.\n\n` +
        `## Rubric: outcome-quality\n${rubric}\n\n## The operator's task\n${scenario.taskCard}\n\n` +
        `## The approved specification\n${approvedSpec}\n\n` +
        `## Validator verdict (authoritative for "does it work")\n${readCapped("validator.json", 8_000)}\n\n` +
        `## Workspace tree\n${readCapped("tree.txt", 8_000)}\n\n` +
        `## Diff vs the fixture baseline\n${readCapped("workspace.diff", 60_000)}\n\n` +
        `## Selected files\n${fileSections}\n\n` +
        `## Screenshots captured\n${screenshots}`,
        "You are a rigorous artifact judge. Score only what the evidence shows the artifact to BE; never infer quality from process.",
      );
      if (failure !== null) {
        outcomeJudgments.push({ dimension: "outcome-quality", repetition, error: failure });
        console.log(`outcome-quality rep ${repetition}: FAILED — ${failure.slice(0, 120)}`);
      } else {
        outcomeJudgments.push({ dimension: "outcome-quality", repetition, judgment: output });
        valid.set("outcome-quality", (valid.get("outcome-quality") ?? 0) + 1);
        console.log(`outcome-quality rep ${repetition}: ${JSON.stringify(output).slice(0, 120)}`);
      }
    }
  } else if (axis !== "trace") {
    console.log("outcome axis skipped: no evidence bundle in this run dir");
  }

  const outFile = path.join(runDir, "judgment.json");
  fs.writeFileSync(outFile, `${JSON.stringify({ version: 2, scenario: scenario.id, reps, axis, judgments, outcomeJudgments }, null, 2)}\n`);
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
