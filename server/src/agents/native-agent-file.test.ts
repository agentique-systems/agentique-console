/**
 * The native agent file parser and evaluator: every native field is read
 * with its native meaning, accepted as informational, or rejected by name;
 * nothing is dropped silently and the retired overlay is refused.
 */
import { describe, expect, it } from "vitest";
import { evaluateNativeAgent, parseNativeAgentFile, splitFrontmatter, type NativeAgentDefaults } from "./native-agent-file.ts";

const DEFAULTS: NativeAgentDefaults = { model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8, allocation: { costUsd: 2, tokens: 20_000, attempts: 2 }, maxWallClockMs: 600_000 };

function evaluate(frontmatter: string, body = "Do the work.\n") {
  const parsed = parseNativeAgentFile(`---\n${frontmatter}\n---\n${body}`);
  if (!parsed.formatValid) throw new Error(parsed.error);
  return evaluateNativeAgent(parsed.fields, parsed.body, DEFAULTS);
}

describe("native agent file", () => {
  it("splits and parses frontmatter with a real YAML parser and reports format problems", () => {
    expect(splitFrontmatter("---\nname: a\n---\nbody")).toEqual({ frontmatter: "name: a", body: "body" });
    expect(splitFrontmatter("---\r\nname: a\r\n---\r\nbody")).toEqual({ frontmatter: "name: a", body: "body" });
    expect(splitFrontmatter("no fence")).toBeNull();
    expect(parseNativeAgentFile("plain text")).toEqual({ formatValid: false, error: expect.stringMatching(/no YAML frontmatter/) });
    expect(parseNativeAgentFile("---\n- a\n- b\n---\nx")).toEqual({ formatValid: false, error: "frontmatter must be a YAML map" });
    expect(parseNativeAgentFile("---\nname: [unclosed\n---\nx")).toMatchObject({ formatValid: false, error: expect.stringMatching(/not valid YAML/) });
    expect(parseNativeAgentFile("---\nname: reviewer\ntools: Read, Grep\n---\n# Body\n")).toEqual({ formatValid: true, fields: { name: "reviewer", tools: "Read, Grep" }, body: "# Body\n" });
  });

  it("reads native fields faithfully: tools map to capabilities (omitted means all), disallowedTools remove capabilities, model and effort fill the model policy, mcp servers are names, and the body is the instructions", () => {
    const full = evaluate("name: builder\ndescription: Builds things\ntools: Read, Grep, Glob, Edit, Write, Bash\nmodel: claude-opus-5\neffort: high\ncolor: blue", "# Builder\nBuild it.\n");
    expect(full).toEqual({
      ok: true,
      agent: {
        nativeName: "builder",
        informational: ["color", "description"],
        content: {
          modelPolicy: { model: "claude-opus-5", effort: "high", maxContextOccupancy: 0.8 },
          instructions: "# Builder\nBuild it.\n",
          capabilities: { tools: ["read", "search", "write", "shell"], mcpServers: [] },
          toolPolicy: { read: "allowed", search: "allowed", write: "allowed", shell: "allowed" },
          defaultLimits: { allocation: { costUsd: 2, tokens: 20_000, attempts: 2 }, maxWallClockMs: 600_000 },
        },
      },
    });
    const inherits = evaluate("description: everything");
    expect(inherits.ok && inherits.agent.content.capabilities.tools).toEqual(["read", "search", "write", "shell", "web"]);
    expect(inherits.ok && inherits.agent.nativeName).toBeNull();
    expect(inherits.ok && inherits.agent.content.modelPolicy).toEqual({ model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8 });
    const narrowed = evaluate("disallowedTools:\n  - Bash\n  - WebFetch\nmodel: inherit");
    expect(narrowed.ok && narrowed.agent.content.capabilities.tools).toEqual(["read", "search", "write"]);
    expect(narrowed.ok && narrowed.agent.content.modelPolicy.model).toBe("claude-fable-5");
    const neutral = evaluate("tools: [read, shell]\nmcpServers: [docs]");
    expect(neutral.ok && neutral.agent.content.capabilities).toEqual({ tools: ["read", "shell"], mcpServers: ["docs"] });
    const mcpTool = evaluate("tools: [Read, mcp__docs__search]\nmcpServers: [docs]\npermissionMode: default");
    expect(mcpTool.ok && mcpTool.agent.content.capabilities).toEqual({ tools: ["read", "mcp__docs__search"], mcpServers: ["docs"] });
    expect(mcpTool.ok && mcpTool.agent.content.toolPolicy).toEqual({ read: "allowed", mcp__docs__search: "allowed" });
    // Denying a tool the console never exposes changes nothing and is not an error.
    const harmless = evaluate("tools: [Read]\ndisallowedTools: [Agent, TodoWrite]");
    expect(harmless.ok && harmless.agent.content.capabilities.tools).toEqual(["read"]);
  });

  it("rejects explicitly, by field: unsupported native fields, the retired overlay, unexecutable native tools, unknown tools, bad efforts, non-default permission modes, inline MCP configs, split capabilities, undeclared MCP servers, and an empty body", () => {
    const reasons = (frontmatter: string, body?: string) => {
      const result = evaluate(frontmatter, body);
      if (result.ok) throw new Error("expected a rejection");
      return result.reasons.map((r) => r.field).sort();
    };
    expect(reasons("skills: [git]\nhooks: {}\nmemory: project\nmaxTurns: 5\nbackground: true\nisolation: worktree\ninitialPrompt: hi")).toEqual(["background", "hooks", "initialPrompt", "isolation", "maxTurns", "memory", "skills"]);
    expect(reasons("agentique:\n  role: implementer")).toEqual(["agentique"]);
    expect(reasons("tools: [Read, Agent, Task, ScheduleWakeup]")).toEqual(["tools", "tools", "tools"]);
    expect(reasons("tools: [Frobnicate]")).toEqual(["tools"]);
    expect(reasons("effort: extreme")).toEqual(["effort"]);
    expect(reasons("permissionMode: bypassPermissions")).toEqual(["permissionMode"]);
    expect(reasons("permissionMode: acceptEdits")).toEqual(["permissionMode"]);
    expect(reasons("mcpServers:\n  docs:\n    command: docs-server")).toEqual(["mcpServers"]);
    expect(reasons("tools: [Write]\ndisallowedTools: [Edit]")).toEqual(["disallowedTools"]);
    expect(reasons("tools: [mcp__docs__search]")).toEqual(["tools"]);
    expect(reasons("unknownField: 1")).toEqual(["unknownField"]);
    expect(reasons("name: 'bad name!'")).toEqual(["name"]);
    expect(reasons("name: ok", "   \n")).toEqual(["body"]);
    const detailed = evaluate("permissionMode: plan");
    expect(!detailed.ok && detailed.reasons[0]!.reason).toMatch(/only `default` can be honored/);
  });
});
