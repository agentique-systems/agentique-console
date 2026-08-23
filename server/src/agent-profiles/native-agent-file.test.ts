/** The parser-of-record contracts: real YAML, three verdicts, no silent drops. */
import { describe, expect, it } from "vitest";
import { evaluateNativeAgent, parseNativeAgentFile, splitFrontmatter } from "./native-agent-file.ts";

const DEFINITION = `---
name: db-reviewer
description: Reviews SQLite schema and migrations
tools: Read, Grep, Bash
mcpServers:
  - browser:
      command: npx
      args:
        - -y
        - "@playwright/mcp@latest"
      env:
        HEADLESS: "1"
agentique:
  role: reviewer
  exemptFromOwnership: true
  assignmentTurnBudget: 25
  recommendedSkills: [git-gud-recover]
---
Review only. Run focused tests and report concrete defects.
`;

function evaluated(text: string) {
  const parsed = parseNativeAgentFile(text);
  if (!parsed.formatValid) throw new Error(parsed.error);
  return evaluateNativeAgent(parsed.fields, parsed.body, "fallback");
}

describe("parseNativeAgentFile", () => {
  it("parses nested multiline YAML — maps, arrays, quoted scalars", () => {
    const parsed = parseNativeAgentFile(DEFINITION);
    expect(parsed.formatValid).toBe(true);
    if (!parsed.formatValid) return;
    expect(parsed.fields.name).toBe("db-reviewer");
    expect(parsed.fields.mcpServers).toEqual([
      { browser: { command: "npx", args: ["-y", "@playwright/mcp@latest"], env: { HEADLESS: "1" } } },
    ]);
    expect(parsed.body).toContain("Review only.");
  });

  it("tolerates CRLF fences", () => {
    const parsed = parseNativeAgentFile("---\r\nname: a\r\ndescription: b\r\n---\r\nbody");
    expect(parsed.formatValid).toBe(true);
  });

  it("malformed YAML is not native-format-valid", () => {
    const parsed = parseNativeAgentFile("---\nname: [unclosed\n---\nbody");
    expect(parsed.formatValid).toBe(false);
    if (parsed.formatValid) return;
    expect(parsed.error).toContain("not valid YAML");
  });

  it("a missing fence or non-map document is not native-format-valid", () => {
    expect(parseNativeAgentFile("just a markdown file").formatValid).toBe(false);
    expect(parseNativeAgentFile("---\n- a\n- b\n---\nbody").formatValid).toBe(false);
  });

  it("splitFrontmatter is a boundary split, never YAML interpretation", () => {
    expect(splitFrontmatter("no fences")).toBeNull();
    expect(splitFrontmatter("---\nx: 1\n---\nrest")?.body).toBe("rest");
  });
});

describe("evaluateNativeAgent", () => {
  it("a fully supported definition resolves with the overlay applied", () => {
    const result = evaluated(DEFINITION);
    expect(result.compatible).toBe(true);
    if (!result.compatible) return;
    expect(result.agent.name).toBe("db-reviewer");
    expect(result.agent.tools).toEqual(["Read", "Grep", "Bash"]);
    expect(result.agent.overlay).toEqual({ role: "reviewer", exemptFromOwnership: true, assignmentTurnBudget: 25, recommendedSkills: ["git-gud-recover"] });
    expect(result.agent.mcpServers.browser).toMatchObject({ command: "npx" });
  });

  it("tools accepts the comma-string convention and the list form identically", () => {
    const commaForm = evaluated("---\nname: a\ndescription: d\ntools: Read, Grep\n---\nbody");
    const listForm = evaluated("---\nname: a\ndescription: d\ntools:\n  - Read\n  - Grep\n---\nbody");
    expect(commaForm.compatible && listForm.compatible).toBe(true);
    if (!commaForm.compatible || !listForm.compatible) return;
    expect(commaForm.agent.tools).toEqual(listForm.agent.tools);
  });

  it("omitted tools stays omitted — never normalized into a list", () => {
    const result = evaluated("---\nname: a\ndescription: d\n---\nbody");
    expect(result.compatible).toBe(true);
    if (!result.compatible) return;
    expect(result.agent.tools).toBeUndefined();
  });

  it("native skills and maxTurns are named incompatibilities pointing at the agentique.* alternative", () => {
    const result = evaluated("---\nname: a\ndescription: d\nskills: [pdf]\nmaxTurns: 5\n---\nbody");
    expect(result.compatible).toBe(false);
    if (result.compatible) return;
    const fields = result.reasons.map((reason) => reason.field);
    expect(fields).toContain("skills");
    expect(fields).toContain("maxTurns");
    expect(result.reasons.find((r) => r.field === "skills")?.reason).toContain("agentique.recommendedSkills");
    expect(result.reasons.find((r) => r.field === "maxTurns")?.reason).toContain("agentique.assignmentTurnBudget");
  });

  it("an unknown native field is an incompatibility, never silently dropped", () => {
    const result = evaluated("---\nname: a\ndescription: d\nfutureNativeThing: 1\n---\nbody");
    expect(result.compatible).toBe(false);
    if (result.compatible) return;
    expect(result.reasons[0]).toMatchObject({ field: "futureNativeThing" });
  });

  it("background is preserved-but-ignored: provably non-semantic without the native Agent tool", () => {
    const result = evaluated("---\nname: a\ndescription: d\nbackground: true\n---\nbody");
    expect(result.compatible).toBe(true);
    if (!result.compatible) return;
    expect(result.agent.ignored).toEqual(["background"]);
  });

  it("MCP name references and URL transports are incompatibilities until the consolidation stage", () => {
    const byName = evaluated("---\nname: a\ndescription: d\nmcpServers: [github]\n---\nbody");
    expect(byName.compatible).toBe(false);
    const byUrl = evaluated('---\nname: a\ndescription: d\nmcpServers:\n  - remote:\n      url: "https://mcp.example"\n---\nbody');
    expect(byUrl.compatible).toBe(false);
  });

  it("missing description or empty body fails — a native definition requires both", () => {
    expect(evaluated("---\nname: a\n---\nbody").compatible).toBe(false);
    expect(evaluated("---\nname: a\ndescription: d\n---\n \n").compatible).toBe(false);
  });
});
