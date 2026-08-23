/**
 * The shipped skills library, read exactly as the boot path reads it. A skill
 * that parses as `draft`/`0.0.0` with no `requires.tools` is invisible in the
 * orchestrator's catalog guidance and assignable to seats that cannot act on
 * it — so every shipped skill must carry the console frontmatter, and the
 * builtin profiles may only recommend skills their tool set can honour.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CapabilityCatalog } from "./capability-catalog.ts";
import { AgentProfileRegistry } from "./registry.ts";
import { effectiveNativeTools } from "../sdk/native-capability-policy.ts";

const SKILLS_DIR = fileURLToPath(new URL("../../skills/skills", import.meta.url));
const GIT_GUD = ["git-gud-commits", "git-gud-conflicts", "git-gud-coordinate", "git-gud-recover", "git-gud-sync", "git-gud-worktrees"];

describe("the shipped skills library", () => {
  const catalog = new CapabilityCatalog(SKILLS_DIR);

  it("ships the six git-gud skills, validated, with their scripts and references", () => {
    for (const name of GIT_GUD) {
      const skill = catalog.get(name);
      expect(skill, name).toBeDefined();
      expect(skill!.status, name).toBe("validated");
      expect(skill!.version, name).not.toBe("0.0.0");
      expect(skill!.whenToUse, name).not.toBe("");
    }
    // Planning knowledge a Bash-less coordinator can hold; the rest run git.
    expect(catalog.get("git-gud-coordinate")!.requiresTools).toEqual([]);
    for (const name of GIT_GUD.filter((entry) => entry !== "git-gud-coordinate")) {
      expect(catalog.get(name)!.requiresTools, name).toEqual(["Bash"]);
    }
  });

  it("every skill in the library carries the console frontmatter (name, status, whenToUse)", () => {
    for (const skill of catalog.all()) {
      expect(skill.name).toMatch(/^[a-z0-9-]+$/);
      expect(skill.description).not.toBe("");
      expect(skill.whenToUse, skill.name).not.toBe("");
      expect(skill.version, skill.name).not.toBe("0.0.0");
    }
  });

  it("ships the three orchestration-doctrine skills, selectable and tool-free", () => {
    // Stage 7b: procedure moved out of the standing prompts lives here — the
    // catalog (served through list_agent_profiles) is how it stays findable.
    for (const name of ["orchestration-patterns", "requirements-mechanics", "wrap-up-and-landing"]) {
      const skill = catalog.selectable().find((entry) => entry.name === name);
      expect(skill, name).toBeDefined();
      expect(skill!.status, name).toBe("validated");
      expect(skill!.requiresTools, name).toEqual([]);
      expect(skill!.whenToUse, name).not.toBe("");
    }
  });

  it("builtin profiles recommend only skills their tools can honour", () => {
    const registry = new AgentProfileRegistry();
    for (const profile of registry.list()) {
      expect(catalog.validateAssignment(profile.skills ?? [], effectiveNativeTools(profile, "seat")), profile.id).toEqual([]);
    }
  });
});
