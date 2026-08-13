/**
 * B1 mechanical floor: every DECLARED capability MCP server carries a per-call
 * wall-clock timeout, so a wedged browser_evaluate returns an error instead of
 * holding a turn open forever. The console's own in-process server carries
 * none — ask_operator parks there legally for up to operatorAskDetachMs.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeDelegationHarness, type Harness } from "../test-helpers.ts";

const briefing = {
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action: "verify UI", state: { summary: "verify UI", evidence: [] },
    result: { summary: null, artifacts: [] }, uncertainty: [], nextAction: "verify UI",
    requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
};

function makeBrowserHarness(policy?: { mcpToolTimeoutMs?: number }): Harness {
  let coordinatorTurns = 0;
  return makeDelegationHarness(async function* (options) {
    const identity = agentRoleOf(options);
    yield initMessage();
    if (identity.agent === "coordinator") {
      coordinatorTurns += 1;
      // Turn 1 assigns; the milestone wake closes out — an ever-reassigning
      // coordinator would ping-pong forever and wedge the test file.
      yield coordinatorTurns === 1
        ? sendHandoffUse("send-1", "painter", { action: "check the page", status: "pending", category: "assignment" })
        : sendHandoffUse(`final-${coordinatorTurns}`, "main", { action: "page verified", status: "completed", category: "final" });
    } else if (identity.agent === "painter") {
      yield sendHandoffUse("done-1", "coordinator", { action: "page verified", status: "completed", category: "milestone" });
    }
    yield successMessage();
  }, policy === undefined ? {} : { config: { policy: policy as never } });
}

async function paintersOptions(h: Harness): Promise<Record<string, { timeout?: number } | undefined>> {
  const userSessionId = h.addUserSession();
  const done = collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled" && (event.payload as { agent?: string }).agent === "painter", 10_000);
  h.host.createSession({
    userSessionId,
    title: "browser seat",
    agents: [{ name: "painter", profileId: "frontend-implementer", owns: ["src/"] }],
    briefing,
  });
  await done;
  const options = h.fake.captured.options.find((entry) => agentRoleOf(entry as { env?: Record<string, string> }).agent === "painter");
  expect(options).toBeDefined();
  return (options as { mcpServers?: Record<string, { timeout?: number }> }).mcpServers ?? {};
}

describe("per-server MCP tool timeout (fake SDK)", () => {
  it("stamps the declared browser server, never the console server", async () => {
    const h = makeBrowserHarness();
    const servers = await paintersOptions(h);
    expect(servers.browser?.timeout).toBe(300_000);
    expect((servers.console_agent as { timeout?: number } | undefined)?.timeout).toBeUndefined();
  });

  it("CONSOLE_MCP_TOOL_TIMEOUT_MS=0 turns the floor off", async () => {
    const h = makeBrowserHarness({ mcpToolTimeoutMs: 0 });
    const servers = await paintersOptions(h);
    expect(servers.browser).toBeDefined();
    expect(servers.browser?.timeout).toBeUndefined();
  });
});
