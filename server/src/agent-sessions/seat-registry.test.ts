/**
 * B3/B4: the SeatRegistry — binding observed Agent spawns to seats, deriving
 * lifecycle events, transcript rows, the plan flow, and the coordinator-only
 * permission gate.
 */
import { describe, expect, it } from "vitest";
import { permissionContext } from "../sdk/fake.ts";
import { buildOrchestratorCanUseTool } from "../orchestrator/permissions.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import {
  COORDINATOR_SEAT,
  ORCHESTRATOR_SEAT,
  spawnNameOf,
} from "./spawn-names.ts";

/** The lane program is irrelevant here — the registry is driven directly. */
const idleProgram = async function* () {
  yield { type: "result", subtype: "success" };
};

function makeSession(h: ReturnType<typeof makeDelegationHarness>) {
  return h.host.createSession({
    userSessionId: h.addUserSession("plan_execute"),
    title: "registry",
    mode: "plan_execute",
    agents: [{ name: "scout", preset: "explorer" }],
  });
}

describe("SeatRegistry", () => {
  it("binds spawns to seats, derives turn/status events, releases on stop", async () => {
    const h = makeDelegationHarness(idleProgram);
    const { agentSessionId } = makeSession(h);
    const scoutSpawn = spawnNameOf(agentSessionId, "scout");
    const coordSpawn = spawnNameOf(agentSessionId, COORDINATOR_SEAT);

    h.host.observeAgentSpawn("tu_1", scoutSpawn, agentSessionId, "explorer-planning");
    h.host.observeAgentSpawn("tu_2", coordSpawn, agentSessionId, "session-orchestrator");
    h.host.confirmAgentLaunch("tu_1", "agent-scout");
    h.host.confirmAgentLaunch("tu_2", "agent-coord");

    expect(h.host.seatOf("tu_1")).toEqual({
      agentSessionId,
      participant: "scout",
    });
    // The coordinator binds to the orchestrator seat — it is that seat's voice.
    expect(h.host.seatOf("tu_2")).toEqual({
      agentSessionId,
      participant: ORCHESTRATOR_SEAT,
    });
    expect(h.host.hasCoordinator(agentSessionId)).toBe(true);
    expect(h.host.seatOfSpawnAddress(scoutSpawn)?.participant).toBe("scout");

    // A spawn with an unknown name binds nothing (fail-closed).
    h.host.observeAgentSpawn("tu_x", "impostor-abcdef", agentSessionId, "adhoc");
    expect(h.host.seatOf("tu_x")).toBeNull();

    const started = await collectUntil(
      h.bus,
      (e) => e.type === "agent_session.turn.started",
    );
    expect(started.at(-1)?.payload).toMatchObject({ turnId: "tu_1" });

    h.host.releaseAgent("agent-scout");
    const settled = await collectUntil(
      h.bus,
      (e) => e.type === "agent_session.turn.settled",
    );
    expect(settled.at(-1)?.payload).toMatchObject({
      participant: "scout",
      turnId: "tu_1",
    });

    h.host.releaseAgent("agent-coord");
    expect(h.host.hasCoordinator(agentSessionId)).toBe(false);
  });

  it("releases a seat whose background task died without a SubagentStop", async () => {
    const h = makeDelegationHarness(idleProgram);
    const { agentSessionId } = makeSession(h);
    h.host.observeAgentSpawn(
      "tu_1",
      spawnNameOf(agentSessionId, "scout"),
      agentSessionId,
      "explorer",
    );
    h.host.confirmAgentLaunch("tu_1", "agent-scout");

    // A killed task emits task_notification, never SubagentStop. Left bound,
    // the seat reports "working" until a server restart runs recovery.
    h.host.releaseSpawnCall("tu_1");

    const settled = await collectUntil(
      h.bus,
      (e) => e.type === "agent_session.turn.settled",
    );
    expect(settled.at(-1)?.payload).toMatchObject({
      participant: "scout",
      turnId: "tu_1",
      status: "aborted",
    });
    expect(h.host.seatOf("tu_1")).toBeNull();
    // Unknown call ids are inert — a stray notification settles nothing.
    expect(() => h.host.releaseSpawnCall("tu_missing")).not.toThrow();
  });

  it("planning phase: a specialist's message to the coordinator is its plan; an execute spawn flips the phase", async () => {
    const h = makeDelegationHarness(idleProgram);
    const { agentSessionId } = makeSession(h);

    h.host.recordDerivedMessage({
      agentSessionId,
      speaker: { kind: "agent", name: "scout" },
      to: ORCHESTRATOR_SEAT,
      text: "1. read the code 2. report",
    });
    const captured = await collectUntil(
      h.bus,
      (e) => e.type === "agent_session.plan.captured",
    );
    expect(captured.at(-1)?.payload).toMatchObject({
      participant: "scout",
      plan: "1. read the code 2. report",
    });
    const row = h.repo.listMessages("agent", agentSessionId).at(-1);
    expect(row?.kind).toBe("plan");

    // Approval = the execute-variant spawn (SDK consent pattern).
    h.host.observeAgentSpawn(
      "tu_exec",
      spawnNameOf(agentSessionId, "scout"),
      agentSessionId,
      "explorer",
    );
    expect(h.repo.getAgentSession(agentSessionId)?.phase).toBe("executing");
    const phase = await collectUntil(
      h.bus,
      (e) => e.type === "agent_session.phase",
    );
    expect(phase.at(-1)?.payload).toMatchObject({ phase: "executing" });
  });

  it("allows the main thread to use the single Console task ledger", async () => {
    const h = makeDelegationHarness(idleProgram);
    const canUseTool = buildOrchestratorCanUseTool({
      userSessionId: h.addUserSession(),
      repo: h.repo,
      bus: h.bus,
      interactions: h.interactions,
      laneState: { lastAssistantText: "" },
    });

    const fromParent = await canUseTool(
      "mcp__console__task_create",
      { agentSessionId: "as_x", subject: "s" },
      permissionContext(),
    );
    expect(fromParent).toMatchObject({ behavior: "allow" });

    const fromSubagent = await canUseTool(
      "mcp__console__task_create",
      { agentSessionId: "as_x", subject: "s" },
      { ...permissionContext(), agentID: "agent-123" },
    );
    // Legacy agentID provenance does not change permission behavior. Managed
    // participants receive their own bound MCP server and cannot call this one.
    expect(fromSubagent).toMatchObject({ behavior: "allow" });

    const createSession = await canUseTool(
      "mcp__console__create_agent_session",
      { title: "t" },
      permissionContext(),
    );
    expect(createSession).toMatchObject({ behavior: "allow" });
  });
});
