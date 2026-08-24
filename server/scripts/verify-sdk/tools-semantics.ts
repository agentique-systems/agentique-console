/**
 * Executable verification of native `AgentDefinition.tools` semantics on the
 * pinned SDK — the evidence behind the capability policy's intersection rule.
 *
 * Verifies, with live probe subagents:
 *   1. `tools` omitted   → the subagent inherits the full tool surface.
 *   2. `tools: [Read]`   → the subagent holds ONLY Read — no Skill, no
 *      ToolSearch, no Monitor: meta tools sit INSIDE `tools` semantics.
 *   3. `disallowedTools` → removes a tool the list would otherwise grant.
 *
 * Priced and credential-gated like the live eval suites — run deliberately:
 *   AGENTIQUE_VERIFY_SDK=1 npx tsx scripts/verify-sdk/tools-semantics.ts
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

if (process.env.AGENTIQUE_VERIFY_SDK !== "1") {
  console.log("Set AGENTIQUE_VERIFY_SDK=1 to run (spawns live probe subagents; costs tokens).");
  process.exit(0);
}

const PROBE_PROMPT =
  "List the names of every tool you can currently call, one per line, nothing else.";

async function probe(name: string, definition: Record<string, unknown>): Promise<string> {
  let text = "";
  const q = query({
    prompt: `Use the Agent tool to run the "${name}" subagent with the prompt: ${PROBE_PROMPT} Then repeat its answer verbatim.`,
    options: {
      maxTurns: 6,
      allowedTools: ["Agent"],
      agents: { [name]: { description: "tool-surface probe", prompt: "You are a probe. Answer exactly what is asked.", ...definition } },
    },
  });
  for await (const message of q) {
    if (message.type === "result" && message.subtype === "success") text = message.result;
  }
  return text;
}

const inherited = await probe("inherit-probe", {});
console.log("--- tools omitted (expect a broad surface incl. Read, Bash, Skill/ToolSearch) ---\n", inherited);

const narrow = await probe("narrow-probe", { tools: ["Read"] });
console.log("--- tools:[Read] (expect ONLY Read — no Skill, ToolSearch, Monitor, Bash) ---\n", narrow);

const restricted = await probe("restricted-probe", { disallowedTools: ["Grep"] });
console.log("--- disallowedTools:[Grep] (expect Grep absent, rest inherited) ---\n", restricted);

const failures: string[] = [];
if (!/Bash/i.test(inherited)) failures.push("inherit-probe did not report Bash — inheritance may not mean the full surface");
if (/Bash|Skill|ToolSearch|Monitor/i.test(narrow)) failures.push("narrow-probe reported a tool outside tools:[Read] — an explicit list is NOT the full ceiling");
if (/\bGrep\b/.test(restricted)) failures.push("restricted-probe still reported Grep — disallowedTools did not bind");
if (failures.length > 0) {
  console.error("\nVERIFICATION FAILED:\n" + failures.map((line) => `  - ${line}`).join("\n"));
  process.exit(1);
}
console.log("\nVERIFIED: native tools semantics match the capability policy's intersection rule.");
