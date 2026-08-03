/**
 * B6: the native-flow e2e (fake SDK). One scripted lane turn plays the whole
 * delegation the way the real model does it — create_agent_session → execute
 * the spawn plan → coordinator briefs the seat → seat works and reports →
 * coordinator reports to main → both agents stop — and the test asserts the
 * console derived everything: seat bindings, transcript rows from SendMessage,
 * tool attribution, flow pulses, turn/status lifecycle, and the operator-lane
 * peer row.
 */
import { describe, expect, it } from "vitest";
import type { ConsoleEvent } from "@agentique-console/shared";
import {
  agentLaunchReceipt,
  agentSpawnMessage,
  fireHook,
  initMessage,
  peerMessage,
  sendMessageUse,
  successMessage,
  tagged,
  textMessage,
  toolResultMessage,
  toolUseMessage,
} from "../sdk/fake.ts";
import type { SdkToolResult } from "../sdk/types.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

interface SpawnEntry {
  name: string;
  subagent_type: string;
  prompt: string;
}

describe("native delegation e2e (fake SDK)", () => {
  it("derives the full session from observed native traffic", async () => {
    const h = makeDelegationHarness(async function* (options, tools) {
      yield initMessage("orch");

      // 1. Register the session and get the spawn plan (as the model would).
      const create = tools.find((t) => t.name === "create_agent_session");
      if (!create) throw new Error("create_agent_session not registered");
      const result = (await create.handler(
        {
          title: "riddle hunt",
          mode: "execute",
          agents: [{ name: "scout", preset: "explorer" }],
          briefing: "find the riddle answer",
        } as never,
        {},
      )) as SdkToolResult;
      const plan = JSON.parse(result.content[0]?.text ?? "{}") as {
        agentSessionId: string;
        spawns: SpawnEntry[];
      };
      const [scoutSpawn, coordSpawn] = plan.spawns as [SpawnEntry, SpawnEntry];

      // 2. Execute the spawn plan verbatim (specialist first, coordinator last).
      yield agentSpawnMessage("tu_scout", scoutSpawn);
      yield agentLaunchReceipt("tu_scout", "agent-scout");
      yield agentSpawnMessage("tu_coord", coordSpawn);
      yield agentLaunchReceipt("tu_coord", "agent-coord");

      // 3. The coordinator briefs the seat (its own tagged traffic).
      yield tagged(
        sendMessageUse("tu_c1", scoutSpawn.name, "go find the riddle"),
        "tu_coord",
      );

      // 4. The seat works, then reports to the coordinator.
      yield tagged(
        toolUseMessage("tu_s1", "Bash", { command: "cat README.md" }),
        "tu_scout",
      );
      yield tagged(toolResultMessage("tu_s1", "the answer is pelican"), "tu_scout");
      yield tagged(
        sendMessageUse("tu_s2", coordSpawn.name, "answer: pelican"),
        "tu_scout",
      );

      // 5. The coordinator reports to main — the observed call, then the
      //    peer-origin user frame that delivery becomes in the lane.
      yield tagged(
        sendMessageUse("tu_c2", "main", "Session done: pelican"),
        "tu_coord",
      );
      yield peerMessage(coordSpawn.name, "Session done: pelican", "agent-coord");

      // 6. Both agents finish (SubagentStop releases the bindings).
      await fireHook(options, "SubagentStop", { agent_id: "agent-scout" });
      await fireHook(options, "SubagentStop", { agent_id: "agent-coord" });

      yield textMessage("Delegated and done: pelican.");
      yield successMessage(undefined, { session_id: "orch" });
    });

    const userSessionId = h.addUserSession();
    const collected = collectUntil(
      h.bus,
      (e) => e.type === "user_session.turn.settled",
      10_000,
    );
    h.runner.postOperatorMessage(userSessionId, "find the riddle");
    const events = await collected;

    // Golden first-occurrence order across the derivation pipeline.
    const firstIndex = (type: ConsoleEvent["type"]) =>
      events.findIndex((e) => e.type === type);
    const order = [
      "user_session.message",
      "user_session.turn.started",
      "agent_session.created",
      "flow.delegation",
      "agent_session.turn.started",
      "agent_session.status",
      "agent_session.message",
      "agent_session.tool.call",
      "agent_session.tool.result",
      "flow.result",
      "agent_session.turn.settled",
      "user_session.turn.settled",
    ] as const;
    const indexes = order.map(firstIndex);
    expect(indexes.every((i) => i >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);

    const agentSessionId = (
      events.find((e) => e.type === "agent_session.created")?.payload as {
        session: { id: string };
      }
    ).session.id;

    // The derived transcript: brief, report, and the upward relay.
    const rows = h.repo.listMessages("agent", agentSessionId);
    expect(
      rows.map((r) => `${r.speakerName}→${r.toName ?? "-"}: ${r.text}`),
    ).toEqual([
      "orchestrator→scout: go find the riddle",
      "scout→orchestrator: answer: pelican",
      "orchestrator→main: Session done: pelican",
    ]);

    // Tool traffic attributed to the seat, under its spawn's turn id.
    const toolCall = events.find((e) => e.type === "agent_session.tool.call");
    expect(toolCall?.payload).toMatchObject({
      participant: "scout",
      turnId: "tu_scout",
      name: "Bash",
    });

    // The report pulsed the flow indicator with its preview.
    expect(
      events.find((e) => e.type === "flow.result")?.payload,
    ).toMatchObject({ agentSessionId, digestPreview: "Session done: pelican" });

    // The peer delivery landed in the operator lane, attributed to the seat.
    const userRows = h.repo.listMessages("user", userSessionId);
    const peerRow = userRows.find((r) => r.speakerKind === "agent");
    expect(peerRow).toMatchObject({
      speakerName: "orchestrator",
      text: "Session done: pelican",
    });

    // Lifecycle: both seats settled, the session ended idle, bindings gone.
    const settles = events.filter((e) => e.type === "agent_session.turn.settled");
    expect(settles.map((e) => (e.payload as { turnId: string }).turnId)).toEqual([
      "tu_scout",
      "tu_coord",
    ]);
    const lastStatus = events
      .filter((e) => e.type === "agent_session.status")
      .at(-1);
    expect(lastStatus?.payload).toMatchObject({ status: "idle" });
    expect(h.host.seatOf("tu_scout")).toBeNull();
    expect(h.host.hasCoordinator(agentSessionId)).toBe(false);
  });
});
