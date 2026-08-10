/**
 * Main steering its own coordinator.
 *
 * After the initial briefing there was no journaled way to do this at all.
 * `prompt.ts` told main to use native `SendMessage` with a JSON handoff
 * envelope that "the Console validates, journals and rewrites" — but that
 * middleware was deleted, and db-live-2 recorded the consequence twice:
 *
 *   23:40:14  SendMessage → "console-orchestrator-a8b946"
 *             → "No agent named 'console-orchestrator-a8b946' is reachable."
 *   23:40:31  SendMessage → "orchestrator"
 *             → "No agent named 'orchestrator' is reachable."
 *
 * `ListAgents` showed the renderer's peer name and not the coordinator's,
 * because a peer name exists only while that seat's CLI process does. Main then
 * rationalised the failure rather than reporting the broken channel.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const briefing = (action: string) => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

const STEER = {
  category: "assignment" as const,
  status: "pending" as const,
  risk: "medium" as const,
  action: "Change the import to the vendored path",
  stateSummary: "The operator decided to hold for r160; game.js line 1 still points at the CDN.",
  evidence: [], resultSummary: null, artifacts: [],
  uncertainty: [], nextAction: "Edit src/game.js line 1", taskId: null, requestExpandedContext: false,
};

async function session() {
  const h = makeDelegationHarness(async function* () {
    yield initMessage();
    yield successMessage();
  });
  const userSessionId = h.addUserSession();
  const created = h.host.createSession({
    userSessionId, title: "lane runner", agents: [{ name: "renderer", profileId: "implementer", owns: ["src/game.js"] }],
    briefing: briefing("build the game"),
  });
  await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
  // The console MCP server is built when MAIN's lane spawns, so main has to
  // take a turn before its tools exist to call.
  h.runner.postOperatorMessage(userSessionId, "steer it");
  await collectUntil(h.bus, (event) => event.type === "user_session.turn.settled", 10_000);
  const tool = h.fake.captured.tools.find((t) => t.name === "send_to_coordinator");
  return { h, userSessionId, agentSessionId: created.agentSessionId, tool };
}

describe("send_to_coordinator", () => {
  it("is registered on main's console surface", async () => {
    const { h, tool } = await session();
    expect(tool).toBeDefined();
    // And the dead path is gone: nothing hands main a peer address to aim at.
    const create = h.fake.captured.tools.find((t) => t.name === "create_agent_session");
    expect(create).toBeDefined();
  });

  it("journals a route-checked handoff and wakes the coordinator", async () => {
    const { h, userSessionId, agentSessionId, tool } = await session();

    const result = await tool!.handler({ agentSessionId, ...STEER }, {});
    const payload = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(payload).toMatchObject({ delivered: true, to: "orchestrator", category: "assignment" });

    // Journaled — the thing native SendMessage never did.
    const record = h.repo.latestHandoff({ userSessionId, agentSessionId, sender: "main", participant: "orchestrator" });
    expect(record?.core.action).toBe(STEER.action);
    expect(record?.core.state.summary).toContain("hold for r160");

    // And carried, not merely recorded.
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.mailbox"
        && (event.payload as { recipient?: string }).recipient === "orchestrator"
        && (event.payload as { sender?: string }).sender === "main",
      10_000,
    );
  });

  it("refuses an agent session belonging to another conversation", async () => {
    const { h, tool } = await session();
    const other = h.addUserSession();
    const foreign = h.host.createSession({
      userSessionId: other, title: "elsewhere", agents: [{ name: "scout", profileId: "explorer" }], briefing: briefing("look"),
    });

    const result = await tool!.handler({ agentSessionId: foreign.agentSessionId, ...STEER }, {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/no agent session .* in this conversation/);
  });
});
