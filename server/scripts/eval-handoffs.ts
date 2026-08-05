/** Opt-in, priced live evaluation: 12 handoff scenarios x 3 repetitions. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSdk } from "../src/sdk/client.ts";
import { mapSdkMessage } from "../src/sdk/mapping.ts";
import { HANDOFF_DRAFT_JSON_SCHEMA, HandoffDraftSchema } from "../src/handoffs/schema.ts";
import { sdkEnv } from "../src/sdk/env.ts";

if (process.env.AGENTIQUE_LIVE_HANDOFF_EVAL !== "1") {
  throw new Error("Live handoff eval is priced and opt-in. Set AGENTIQUE_LIVE_HANDOFF_EVAL=1 explicitly.");
}

interface EvalCase { id: string; prompt: string; mustInclude: string[]; forbidden?: string[]; evidenceRefs?: string[]; }
const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(path.join(here, "../evals/handoffs/cases.json"), "utf8")) as EvalCase[];
const sdk = await resolveSdk();
const results: unknown[] = [];

for (const testCase of cases) {
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const abort = new AbortController();
    const query = sdk.query({ prompt: `Convert this transfer into the canonical handoff without adding facts:\n\n${testCase.prompt}`,
      options: { cwd: process.cwd(), systemPrompt: "Return a faithful, pointer-first handoff. Preserve uncertainty and conflicting evidence; never repair the source narrative.",
        settingSources: [], includePartialMessages: false, permissionMode: "plan", allowedTools: [], disallowedTools: ["Agent", "Bash", "Edit", "Write", "WebSearch", "WebFetch"],
        outputFormat: { type: "json_schema", schema: HANDOFF_DRAFT_JSON_SCHEMA }, maxTurns: 2,
        sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
          filesystem: { allowManagedReadPathsOnly: true, allowRead: [process.cwd()], allowWrite: [] } }, env: sdkEnv(), abortController: abort } });
    let output: unknown;
    let usage: Record<string, number | undefined> = {};
    try {
      for await (const raw of query) for (const event of mapSdkMessage(raw)) {
        if (event.kind === "result") { output = event.output; usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, cacheReadInputTokens: event.cacheReadInputTokens }; }
      }
    } finally { query.close?.(); }
    const parsed = HandoffDraftSchema.safeParse(output);
    const serialized = parsed.success ? JSON.stringify(parsed.data) : "";
    const refs = parsed.success ? [...parsed.data.core.state.evidence, ...parsed.data.core.result.artifacts].map((item) => item.ref) : [];
    results.push({ caseId: testCase.id, repetition, schemaValid: parsed.success,
      factRecall: testCase.mustInclude.filter((fact) => serialized.toLowerCase().includes(fact.toLowerCase())).length / testCase.mustInclude.length,
      forbiddenClaims: (testCase.forbidden ?? []).filter((fact) => serialized.toLowerCase().includes(fact.toLowerCase())),
      evidenceRecall: (testCase.evidenceRefs?.length ?? 0) === 0 ? 1 : testCase.evidenceRefs?.filter((ref) => refs.some((value) => value.includes(ref))).length! / testCase.evidenceRefs!.length,
      bytes: Buffer.byteLength(serialized), usage });
  }
}

process.stdout.write(`${JSON.stringify({ version: 1, protocol: "typed-handoff-v1", repetitions: 3, results }, null, 2)}\n`);
