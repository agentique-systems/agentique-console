/**
 * Translate a legacy `.agentique/agents/<id>/` bundle into a native
 * `.claude/agents/<id>.md` definition — narrowly, and honestly.
 *
 * The tool translates what is semantics-preserving and REPORTS everything
 * else; it makes no architectural decisions:
 *  - manifest fields  → native frontmatter + `agentique:` overlay + body
 *    (legacy `skills`/`maxTurns` WERE the Agentique concepts, so they map to
 *    `agentique.recommendedSkills`/`agentique.assignmentTurnBudget`);
 *  - bundle mcpServers → native `mcpServers` frontmatter (seat-scoped and
 *    console-executed before and after — scope unchanged);
 *  - bundle `skills/`, `commands/` → OPERATOR CHOICE: moving them to
 *    `.claude/skills|commands` widens visibility from this profile's seats
 *    to the whole workspace and native sessions — reported, never moved;
 *  - bundle `hooks/` → NEVER automatic (profile-scoped → workspace-global is
 *    a semantic widening) — reported for manual placement;
 *  - non-profile `agents/` → cannot migrate (never runnable) — reported;
 *  - anything unrecognized → stop and report, never guess.
 *
 * The migrated definition is a NEW source (path changed), so it requires a
 * fresh trust click; trust never crosses a source move.
 *
 * Usage: npx tsx scripts/migrate-profile.ts <workspaceRoot> <profileId>
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const [workspaceRoot, profileId] = process.argv.slice(2);
if (!workspaceRoot || !profileId) {
  console.error("usage: npx tsx scripts/migrate-profile.ts <workspaceRoot> <profileId>");
  process.exit(2);
}

const bundleRoot = path.join(workspaceRoot, ".agentique", "agents", profileId);
const manifestPath = path.join(bundleRoot, "agentique.profile.json");
if (!fs.existsSync(manifestPath)) {
  console.error(`no legacy bundle at ${bundleRoot}`);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

const KNOWN = new Set(["id", "title", "purpose", "role", "instructions", "tools", "disallowedTools", "permissionMode", "model", "effort",
  "handoffExtension", "exemptFromOwnership", "maxTurns", "mcpServers", "skills", "entryAgent", "pluginPath", "revision", "source"]);
const unknownFields = Object.keys(manifest).filter((key) => !KNOWN.has(key));
if (unknownFields.length > 0) {
  console.error(`STOP: manifest carries fields this tool does not understand — migrate them by hand: ${unknownFields.join(", ")}`);
  process.exit(1);
}

const frontmatter: Record<string, unknown> = {
  name: manifest.id,
  description: manifest.purpose,
  ...(manifest.tools === undefined ? {} : { tools: manifest.tools }),
  ...(manifest.disallowedTools === undefined ? {} : { disallowedTools: manifest.disallowedTools }),
  ...(manifest.model === undefined ? {} : { model: manifest.model }),
  ...(manifest.effort === undefined ? {} : { effort: manifest.effort }),
  ...(manifest.permissionMode === undefined || manifest.permissionMode === "default" ? {} : { permissionMode: manifest.permissionMode }),
  ...(manifest.mcpServers !== undefined && Object.keys(manifest.mcpServers as object).length > 0
    ? { mcpServers: Object.entries(manifest.mcpServers as Record<string, unknown>).map(([name, config]) => ({ [name]: config })) }
    : {}),
};
const overlay: Record<string, unknown> = {
  ...(manifest.role === undefined ? {} : { role: manifest.role }),
  ...(manifest.handoffExtension === undefined ? {} : { handoffExtension: manifest.handoffExtension }),
  ...(manifest.exemptFromOwnership === true ? { exemptFromOwnership: true } : {}),
  ...(manifest.maxTurns === undefined ? {} : { assignmentTurnBudget: manifest.maxTurns }),
  ...(Array.isArray(manifest.skills) && manifest.skills.length > 0 ? { recommendedSkills: manifest.skills } : {}),
};
if (Object.keys(overlay).length > 0) frontmatter.agentique = overlay;

const target = path.join(workspaceRoot, ".claude", "agents", `${profileId}.md`);
if (fs.existsSync(target)) {
  console.error(`STOP: ${target} already exists — refusing to overwrite`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${String(manifest.instructions ?? "").trim()}\n`);

const report: string[] = [`migrated: ${path.relative(workspaceRoot, target)} (manifest fields + agentique overlay + body)`];
const componentDirs = ["skills", "commands", "hooks", "agents", "monitors"];
for (const dir of componentDirs) {
  const at = path.join(bundleRoot, dir);
  if (!fs.existsSync(at)) continue;
  if (dir === "skills" || dir === "commands") report.push(`OPERATOR CHOICE: ${dir}/ stays in the legacy bundle — moving it to .claude/${dir}/ widens visibility from this profile's seats to the whole workspace and native sessions; move it yourself if that is what you want`);
  else if (dir === "hooks") report.push("MANUAL: hooks/ is profile-scoped; a workspace-global home would widen it — place it by hand or keep it legacy");
  else report.push(`CANNOT MIGRATE: ${dir}/ (never runnable under console policy) — remove or keep for reference`);
}
const leftovers = fs.readdirSync(bundleRoot).filter((entry) => entry !== "agentique.profile.json" && entry !== ".claude-plugin" && entry !== ".mcp.json" && !componentDirs.includes(entry));
for (const entry of leftovers) report.push(`REPORTED, NOT TOUCHED: ${entry}`);
if (fs.existsSync(path.join(bundleRoot, ".mcp.json"))) report.push("NOTE: bundle .mcp.json declarations were NOT merged — declare seat-scoped servers in the new frontmatter mcpServers, or move workspace-wide ones to the workspace-root .mcp.json (SDK-owned, native permissions)");

report.push("RE-TRUST REQUIRED: the migrated definition is a new source (path changed); trust never crosses a source move. The legacy bundle keeps working (deprecated) until you delete it.");
console.log(report.map((line) => `- ${line}`).join("\n"));
