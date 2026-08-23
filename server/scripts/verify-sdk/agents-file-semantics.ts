/**
 * Executable verification of native `.claude/agents/*.md` loading on the
 * pinned SDK — the evidence behind Stage 3's discovery mirroring:
 *   1. the CLI tolerates the unknown `agentique:` frontmatter key (a session
 *      over the fixture workspace boots and lists the agent);
 *   2. identity comes from frontmatter `name` (filename mismatch is legal);
 *   3. whether nested files under .claude/agents/ are discovered;
 *   4. NO DOUBLE LAUNCH: an agent-frontmatter mcpServers declaration is not
 *      launched by the native runtime at session start (it would only launch
 *      when running the agent via the denied Agent tool), so the console's
 *      Options.mcpServers remains the single launcher for executed forms.
 *
 * Priced and credential-gated — run deliberately:
 *   AGENTIQUE_VERIFY_SDK=1 npx tsx scripts/verify-sdk/agents-file-semantics.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

if (process.env.AGENTIQUE_VERIFY_SDK !== "1") {
  console.log("Set AGENTIQUE_VERIFY_SDK=1 to run (boots a live session; costs tokens).");
  process.exit(0);
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-verify-agents-"));
fs.mkdirSync(path.join(workspace, ".claude", "agents", "nested"), { recursive: true });
fs.writeFileSync(path.join(workspace, ".claude", "agents", "file-name.md"),
  "---\nname: real-name\ndescription: identity probe\nmcpServers:\n  - launch-probe:\n      command: /bin/cat\nagentique:\n  role: reviewer\n---\nProbe body.\n");
fs.writeFileSync(path.join(workspace, ".claude", "agents", "nested", "deep-agent.md"),
  "---\nname: deep-agent\ndescription: nesting probe\n---\nProbe body.\n");

const q = query({ prompt: "Say ok.", options: { cwd: workspace, settingSources: ["project"], maxTurns: 1 } });
let booted = false;
for await (const message of q) {
  if (message.type === "system" && message.subtype === "init") booted = true;
  if (message.type === "result") break;
}
const agents = await q.supportedAgents();
const names = agents.map((agent) => agent.name);
const mcpStatuses = await q.mcpServerStatus();
const launched = mcpStatuses.map((status) => status.name);
console.log("session booted:", booted, "\nagents:", names.join(", "), "\nmcp servers:", launched.join(", ") || "(none)");

const failures: string[] = [];
if (!booted) failures.push("the session did not boot over a workspace whose agent file carries an agentique: key");
if (!names.includes("real-name")) failures.push("frontmatter `name` did not establish identity (or the unknown key broke the load) — switch the overlay to the sidecar fallback");
if (names.includes("file-name")) failures.push("the loader used the FILENAME as identity despite a name field — mirror that instead");
if (launched.includes("launch-probe")) failures.push("the native runtime launched an agent-frontmatter MCP server at session start — the console would double-launch; exclude executed forms from Options.mcpServers or gate them");
console.log(names.includes("deep-agent")
  ? "nested discovery: SUPPORTED — registry mirroring is correct"
  : "nested discovery: NOT supported — restrict registry discovery to the top level to mirror it");
if (failures.length > 0) {
  console.error("\nVERIFICATION FAILED:\n" + failures.map((line) => `  - ${line}`).join("\n"));
  process.exit(1);
}
console.log("\nVERIFIED: native agent-file semantics match the registry's mirroring.");
