/**
 * The capability catalog: what the orchestrator can reason about when it
 * staffs a seat — skills (with lifecycle metadata), attachable MCP servers,
 * and the governed builtins. One source, served both to the orchestrator
 * (list_agent_profiles' catalog section) and to seat-side validation, so the
 * two descriptions cannot drift — the drift class that cost a live run two
 * researchers' web access.
 *
 * Skills are parsed from the console plugin's SKILL.md frontmatter at boot;
 * the SDK itself loads the bodies on demand (progressive disclosure), so
 * this module never reads a body.
 */
import fs from "node:fs";
import path from "node:path";

export interface SkillCatalogEntry {
  name: string;
  description: string;
  version: string;
  status: "draft" | "validated" | "deprecated";
  provenance: string;
  whenToUse: string;
  costNote: string;
  /** Tools the skill's guidance assumes; a seat lacking them must not load it. */
  requiresTools: string[];
}

export interface McpCatalogEntry {
  name: string;
  purpose: string;
  whenToUse: string;
  costNote: string;
  /** May specialize_profile attach it by name (never by command). */
  attachable: boolean;
}

/** Console-declared MCP capabilities. Commands live in the registry, not here. */
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    name: "browser",
    purpose: "A real browser via Playwright MCP — navigation, interaction, screenshots inline.",
    whenToUse: "Visual verification of rendered UI and user flows; not for exploration a Read can do.",
    costNote: "One action per call and screenshots cost a round trip each — expensive per interaction.",
    attachable: true,
  },
];

/** Minimal YAML-frontmatter reader for the fields this catalog serves. */
function parseFrontmatter(raw: string): { fields: Record<string, string>; requiresTools: string[] } {
  const match = /^---\n([\s\S]*?)\n---/.exec(raw);
  const fields: Record<string, string> = {};
  let requiresTools: string[] = [];
  if (!match) return { fields, requiresTools };
  for (const line of match[1]!.split("\n")) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      fields[kv[1]!] = kv[2]!.trim();
      continue;
    }
    const tools = /^\s+tools:\s*\[(.*)\]\s*$/.exec(line);
    if (tools) requiresTools = tools[1]!.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  }
  return { fields, requiresTools };
}

export class CapabilityCatalog {
  readonly #skills: SkillCatalogEntry[];

  /** `skillsDir` = the console plugin's `skills/` directory; missing = empty catalog. */
  constructor(skillsDir: string) {
    this.#skills = this.#read(skillsDir);
  }

  #read(skillsDir: string): SkillCatalogEntry[] {
    let entries: string[] = [];
    try { entries = fs.readdirSync(skillsDir); } catch { return []; }
    const skills: SkillCatalogEntry[] = [];
    for (const dir of entries.sort()) {
      const file = path.join(skillsDir, dir, "SKILL.md");
      let raw: string;
      try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
      const { fields, requiresTools } = parseFrontmatter(raw);
      const status = fields.status === "validated" || fields.status === "deprecated" ? fields.status : "draft";
      skills.push({
        name: fields.name ?? dir,
        description: fields.description ?? "",
        version: fields.version ?? "0.0.0",
        status,
        provenance: fields.provenance ?? "",
        whenToUse: fields.whenToUse ?? "",
        costNote: fields.costNote ?? "",
        requiresTools,
      });
    }
    return skills;
  }

  /** Deprecated skills stay listed (forensics) but are excluded here. */
  selectable(): SkillCatalogEntry[] {
    return this.#skills.filter((skill) => skill.status !== "deprecated");
  }

  all(): SkillCatalogEntry[] {
    return [...this.#skills];
  }

  get(name: string): SkillCatalogEntry | undefined {
    return this.#skills.find((skill) => skill.name === name);
  }

  /**
   * The commission-time gate: a skill a seat cannot act on must not load —
   * guidance that says "use Bash" on a seat without Bash is the deferred-
   * tools failure in a new coat. Returns the problems, empty = assignable.
   */
  validateAssignment(skillNames: readonly string[], profileTools: readonly string[]): string[] {
    const problems: string[] = [];
    for (const name of skillNames) {
      const skill = this.get(name);
      if (skill === undefined) {
        problems.push(`unknown skill "${name}" (catalog: ${this.#skills.map((entry) => entry.name).join(", ") || "empty"})`);
        continue;
      }
      if (skill.status === "deprecated") {
        problems.push(`skill "${name}" is deprecated and cannot be assigned`);
        continue;
      }
      const missing = skill.requiresTools.filter((tool) => !profileTools.includes(tool));
      if (missing.length > 0) {
        problems.push(`skill "${name}" requires tools the profile does not grant: ${missing.join(", ")}`);
      }
    }
    return problems;
  }
}
