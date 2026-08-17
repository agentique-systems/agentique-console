/**
 * Main never owns participant processes: in-process subagents stay denied,
 * the workshop's tools (Read/Bash/Write/Edit) are allowed and bounded by the
 * charter, and every messaging/task/scheduling path is console-owned. The
 * lane registers under its peer name and accepts cross-session inbound.
 *
 * `SendMessage` is denied unconditionally: coordinator traffic goes through
 * the console-owned `send_to_coordinator`, which is route-checked and
 * journaled like every other transfer.
 */
import { describe, expect, it } from "vitest";
import { buildOrchestratorOptions } from "./options.ts";
import { ORCHESTRATOR_BRIEF, ORCHESTRATOR_DELEGATION_BRIEF } from "./prompt.ts";

const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"];

function options(withDelegation = true, effort: "low" | "max" | undefined = undefined) {
  return buildOrchestratorOptions({
    workspaceRoot: "/tmp/ws",
    resume: null,
    mode: "execute",
    phase: "executing",
    model: undefined,
    effort,
    abortController: new AbortController(),
    canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
    peerName: "console-main-abc123",
    ...(withDelegation ? { mcpServer: {} } : {}),
  });
}

describe("orchestrator options", () => {
  it("denies in-process subagents; allows the workshop's tools", () => {
    const disallowed = options().disallowedTools ?? [];
    expect(disallowed).toEqual(expect.arrayContaining(["Agent", "Task"]));
    expect(disallowed).not.toContain("Bash");
    expect(disallowed).not.toEqual(expect.arrayContaining(WRITE_TOOLS));
    // Denied in every configuration: it bypasses the journal entirely.
    expect(disallowed).toContain("SendMessage");
    // As do the lane-waking natives, which fire a turn with no mailbox row,
    // no handoff and no attribution.
    expect(disallowed).toEqual(expect.arrayContaining(["ScheduleWakeup", "Monitor", "TaskStop"]));
    // The native ledger is denied too: it is keyed on the provider session id,
    // which changes at every rotation — the orphan failure agents were already
    // spared. Main uses the console-owned task tools.
    expect(disallowed).toContain("TaskCreate");
    const allowed = options().allowedTools ?? [];
    expect(disallowed).toEqual(expect.arrayContaining(["CronCreate", "CronList", "CronDelete"]));
    expect(allowed).toEqual(expect.arrayContaining([
      "mcp__console__task_create", "mcp__console__task_update", "mcp__console__task_list",
    ]));
    expect(allowed).toContain("mcp__console__send_to_coordinator");
    expect(allowed).not.toContain("SendMessage");
  });

  // The console runs no sandbox of its own. A dev server an agent starts must
  // outlive the Bash call that started it and be reachable by the browser
  // driving it — the SDK sandbox gave each call its own network and PID
  // namespace, which made both impossible.
  it("declares no sandbox", () => {
    expect(options().sandbox).toBeUndefined();
  });

  // The brief shapes attention; the mechanics live in tool descriptions. It
  // was 17 KB once, and every line competes with the native system prompt.
  it("keeps the standing brief within its byte budget", () => {
    expect(Buffer.byteLength(ORCHESTRATOR_BRIEF + ORCHESTRATOR_DELEGATION_BRIEF, "utf8")).toBeLessThanOrEqual(10_000);
  });

  it("loads settings, CLAUDE.md and skills like the CLI", () => {
    expect(options().settingSources).toEqual(["user", "project", "local"]);
    expect(options().skills).toBe("all");
  });

  it("holds the console skills plugin when the runner names it, like every seat", () => {
    const built = buildOrchestratorOptions({
      workspaceRoot: "/tmp/ws", resume: null, mode: "execute", phase: "executing", model: undefined, effort: undefined,
      abortController: new AbortController(), canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
      mcpServer: {}, skillsPluginDir: "/opt/console/skills",
    });
    expect(built.plugins).toEqual([{ type: "local", path: "/opt/console/skills" }]);
    // Hermetic callers omit the dir and get no plugin, not a broken path.
    expect("plugins" in options()).toBe(false);
  });

  it("passes the resolved effort through unchanged, and omits the key when unset", () => {
    expect(options(true, "max").effort).toBe("max");
    expect("effort" in options()).toBe(false);
  });

  it("registers under its peer name and accepts cross-session inbound", () => {
    const built = options();
    expect((built.env as Record<string, string>).CLAUDE_CODE_SESSION_NAME).toBe("console-main-abc123");
    expect(built.settings).toMatchObject({ crossSessionInbound: "accept" });
  });

  it("main holds the workshop's tools and durable coordination", () => {
    const allowed = options().allowedTools ?? [];
    expect(allowed).toEqual(expect.arrayContaining([...WRITE_TOOLS, "Bash", "Read", "Glob", "Grep"]));
    expect(allowed).toEqual(expect.arrayContaining(["mcp__console__create_agent_session", "mcp__console__read_agent_session", "mcp__console__list_agent_profiles"]));
    expect(allowed).not.toContain("Agent");
    // The two that must reach canUseTool to become operator cards.
    expect(allowed).not.toContain("AskUserQuestion");
    expect(allowed).not.toContain("ExitPlanMode");
  });

  it("withholds delegation and native messaging until the console MCP server is wired", () => {
    const allowed = options(false).allowedTools ?? [];
    expect(allowed.some((tool) => tool.startsWith("mcp__console__"))).toBe(false);
    expect(allowed).not.toContain("SendMessage");
    expect(options(false).disallowedTools).toEqual(expect.arrayContaining(["SendMessage", "TaskCreate"]));
    // The workshop's tools do not depend on delegation being wired.
    expect(allowed).toEqual(expect.arrayContaining(WRITE_TOOLS));
  });
});
