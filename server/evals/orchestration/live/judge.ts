/**
 * Rubric judging over an exported live run. Priced and opt-in:
 *
 *   AGENTIQUE_LIVE_ORCH_EVAL=1 npx tsx server/evals/orchestration/live/judge.ts <runDir>
 *
 * For every rubric in rubrics/ that names one of the run scenario's stressed
 * dimensions: 3 repetitions, medians + spread reported, qualitative notes
 * preserved verbatim. The judge receives the rubric, the task card, the
 * transcript, and the MECHANICAL metrics (so it never re-derives counts).
 * Scores inform; they never gate (see README's Goodhart policy).
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
const runDir = process.argv[2];
if (!runDir) throw new Error("usage: judge.ts <runDir>");

const checks = JSON.parse(fs.readFileSync(path.join(runDir, "checks.json"), "utf8")) as { scenario: string };
const scenario = SCENARIOS.find((entry) => entry.id === checks.scenario);
if (!scenario) throw new Error(`unknown scenario ${checks.scenario}`);
const transcript = fs.readFileSync(path.join(runDir, "transcript.md"), "utf8");
const metrics = fs.readFileSync(path.join(runDir, "run.json"), "utf8");

const rubricsDir = path.join(here, "../rubrics");
const rubricFiles = fs.readdirSync(rubricsDir).filter((name) => name.endsWith(".md") && !name.startsWith("_"));
const relevant = rubricFiles.filter((name) => scenario.stressedDimensions.includes(name.replace(/\.md$/, "") as never));

const sdk = await resolveSdk();
const judgments: unknown[] = [];

for (const rubricFile of relevant) {
  const dimension = rubricFile.replace(/\.md$/, "");
  const rubric = fs.readFileSync(path.join(rubricsDir, rubricFile), "utf8");
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const query = sdk.query({
      prompt:
        `Judge ONE dimension of an orchestration run against the rubric below. ` +
        `Cite transcript evidence; distinguish decision quality (reasonable given what was known at the time) from outcome luck.\n\n` +
        `## Rubric: ${dimension}\n${rubric}\n\n## The operator's task\n${scenario.taskCard}\n\n` +
        `## Mechanical metrics (authoritative — do not re-derive counts)\n${metrics.slice(0, 20_000)}\n\n` +
        `## Transcript\n${transcript.slice(0, 150_000)}`,
      options: {
        cwd: process.cwd(), systemPrompt: "You are a rigorous orchestration-trace judge. Score only the named dimension. Anchor every claim in quoted evidence.",
        settingSources: [], includePartialMessages: false, permissionMode: "plan", allowedTools: [],
        disallowedTools: ["Agent", "Bash", "Edit", "Write", "WebSearch", "WebFetch"],
        outputFormat: { type: "json_schema", schema: JUDGMENT_SCHEMA }, maxTurns: 2, env: sdkEnv(),
      },
    });
    let output: unknown;
    try {
      for await (const raw of query) {
        for (const event of mapSdkMessage(raw)) {
          if (event.kind === "result") output = event.output;
        }
      }
    } finally {
      query.close?.();
    }
    judgments.push({ dimension, repetition, judgment: output });
    console.log(`${dimension} rep ${repetition}: ${JSON.stringify(output).slice(0, 120)}`);
  }
}

const outFile = path.join(runDir, "judgment.json");
fs.writeFileSync(outFile, `${JSON.stringify({ version: 1, scenario: scenario.id, judgments }, null, 2)}\n`);
console.log(`wrote ${outFile}`);
