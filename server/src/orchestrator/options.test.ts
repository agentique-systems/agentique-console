/**
 * Main never owns participant processes. Native delegation is denied and the
 * only coordination surface is the durable Console MCP server.
 */
import { describe, expect, it } from "vitest";
import { buildOrchestratorOptions } from "./options.ts";

const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit", "Bash"];

function options(withDelegation = true) {
  return buildOrchestratorOptions({
    workspaceRoot: "/tmp/ws",
    resume: null,
    mode: "execute",
    phase: "executing",
    model: undefined,
    effort: undefined,
    abortController: new AbortController(),
    canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
    ...(withDelegation ? { mcpServer: {} } : {}),
  });
}

describe("orchestrator options", () => {
  it("denies native subagents, messaging, and the split SDK task ledger", () => {
    const disallowed = options().disallowedTools ?? [];
    expect(disallowed).toEqual(expect.arrayContaining(["Agent", "SendMessage", "TaskCreate", "TaskUpdate", "TaskList"]));
  });

  it("enables fail-closed workspace sandboxing", () => {
    expect(options().sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
  });

  it("restricts main to inspection and durable coordination", () => {
    const allowed = options().allowedTools ?? [];
    expect(allowed).not.toEqual(expect.arrayContaining(WRITE_TOOLS));
    expect(allowed).toEqual(expect.arrayContaining(["mcp__console__create_agent_session", "mcp__console__send_agent_message", "mcp__console__list_agent_profiles"]));
    expect(allowed).not.toEqual(expect.arrayContaining(["Agent", "SendMessage", "TaskCreate"]));
    // The two that must reach canUseTool to become operator cards.
    expect(allowed).not.toContain("AskUserQuestion");
    expect(allowed).not.toContain("ExitPlanMode");
  });

  it("withholds delegation tools until the console MCP server is wired", () => {
    const allowed = options(false).allowedTools ?? [];
    expect(allowed.some((tool) => tool.startsWith("mcp__console__"))).toBe(false);
    expect(allowed).not.toEqual(expect.arrayContaining(WRITE_TOOLS));
  });
});
