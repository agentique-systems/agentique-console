/**
 * Executable verification that `disallowedTools` strips tools even under
 * `permissionMode: "bypassPermissions"` — the property that makes the
 * capability policy's deny-by-name lists the security boundary for
 * bypass-permission seats. (Fallback if this ever fails on an SDK upgrade:
 * route seats through permissionMode "default" + a canUseTool denial.)
 *
 * Priced and credential-gated — run deliberately:
 *   AGENTIQUE_VERIFY_SDK=1 npx tsx scripts/verify-sdk/bypass-disallowed.ts
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

if (process.env.AGENTIQUE_VERIFY_SDK !== "1") {
  console.log("Set AGENTIQUE_VERIFY_SDK=1 to run (spawns a live query; costs tokens).");
  process.exit(0);
}

let text = "";
const q = query({
  prompt: "List the names of every tool you can currently call, one per line, nothing else.",
  options: {
    maxTurns: 2,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: ["Bash", "WebSearch"],
  },
});
for await (const message of q) {
  if (message.type === "result" && message.subtype === "success") text = message.result;
}
console.log("--- bypassPermissions + disallowedTools:[Bash, WebSearch] ---\n", text);

if (/\bBash\b|\bWebSearch\b/.test(text)) {
  console.error("\nVERIFICATION FAILED: a disallowed tool survived bypassPermissions — switch seats to permissionMode 'default' + canUseTool denial.");
  process.exit(1);
}
console.log("\nVERIFIED: disallowedTools strips tools under bypassPermissions.");
