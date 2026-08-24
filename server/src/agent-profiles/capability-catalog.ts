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
import { BACKGROUND_WAIT_TOOLS, WORKSPACE_TOOLS } from "../sdk/native-capability-policy.ts";
import { parseFrontmatterDocument } from "./native-agent-file.ts";

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

/** Real-YAML frontmatter read (native-agent-file.ts) narrowed to the fields this catalog serves. */
function parseFrontmatter(raw: string): { fields: Record<string, string>; requiresTools: string[] } {
  const document = parseFrontmatterDocument(raw);
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(document)) {
    if (typeof value === "string") fields[key] = value.trim();
  }
  const requires = document.requires;
  const tools = requires !== null && typeof requires === "object" && !Array.isArray(requires) ? (requires as { tools?: unknown }).tools : undefined;
  const requiresTools = Array.isArray(tools) ? tools.filter((entry): entry is string => typeof entry === "string") : [];
  return { fields, requiresTools };
}

/** The names a skill's `requires.tools` may reference. */
const KNOWN_REQUIRABLE_TOOLS: ReadonlySet<string> = new Set([...WORKSPACE_TOOLS, ...BACKGROUND_WAIT_TOOLS]);

export class CapabilityCatalog {
  readonly #skills: SkillCatalogEntry[];

  /**
   * Load-time findings — a `requires.tools` entry naming a tool the policy
   * has never heard of would otherwise block the skill's assignment forever
   * without anyone noticing the typo.
   */
  readonly issues: readonly string[];

  /** `skillsDir` = the console plugin's `skills/` directory; missing = empty catalog. */
  constructor(skillsDir: string) {
    this.#skills = this.#read(skillsDir);
    this.issues = this.#skills.flatMap((skill) =>
      skill.requiresTools
        .filter((tool) => !KNOWN_REQUIRABLE_TOOLS.has(tool) && !tool.startsWith("mcp__"))
        .map((tool) => `skill "${skill.name}" requires unknown tool "${tool}" — fix the frontmatter or classify the tool`));
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
   * tools failure in a new coat. Validates against the EFFECTIVE native set
   * the seat will actually hold (`effectiveNativeTools`), never a broader or
   * narrower roster. Returns the problems, empty = assignable.
   */
  validateAssignment(skillNames: readonly string[], effectiveTools: ReadonlySet<string> | readonly string[]): string[] {
    const tools = effectiveTools instanceof Set ? effectiveTools : new Set(effectiveTools);
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
      const missing = skill.requiresTools.filter((tool) => !tools.has(tool));
      if (missing.length > 0) {
        problems.push(`skill "${name}" requires tools the seat will not hold: ${missing.join(", ")}`);
      }
    }
    return problems;
  }
}
