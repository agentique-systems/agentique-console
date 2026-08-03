/**
 * A turn that dies with the process must not leave the UI spinning. Under B5,
 * agent-side "turns" are native-subagent lifetimes (spawn → SubagentStop);
 * a crash leaves turn.started with no settle, and recovery closes it — the
 * agents themselves are gone (no resume handle) and the Orchestrator respawns
 * them via the spawn plan.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage, textMessage } from "./sdk/fake.ts";
import {
  collectUntil,
  makeDelegationHarness,
  restartHarness,
} from "./test-helpers.ts";
import { recoverInterruptedTurns } from "./recovery.ts";
import {
  ORCHESTRATOR_SEAT,
  spawnNameOf,
} from "./agent-sessions/spawn-names.ts";

describe("recoverInterruptedTurns", () => {
  it("closes a seat turn orphaned by a crash", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage("orch");
      yield successMessage(undefined, { session_id: "orch" });
    });
    const userSessionId = h.addUserSession();
    const { agentSessionId } = h.host.createSession({
      userSessionId,
      title: "Interrupted work",
      mode: "execute",
      agents: [{ name: "web", preset: "implementer" }],
    });
    // A live seat (turn.started emitted), then the process dies before any
    // SubagentStop — the registry state vanishes with it.
    h.host.observeAgentSpawn(
      "tu_web",
      spawnNameOf(agentSessionId, "web"),
      agentSessionId,
      "implementer",
    );
    expect(h.repo.findUnsettledTurns()).toHaveLength(1);

    const rebooted = restartHarness(h);
    expect(
      recoverInterruptedTurns({ repo: rebooted.repo, bus: rebooted.bus }),
    ).toBe(1);

    const events = await collectUntil(
      h.bus,
      (e) => e.type === "agent_session.turn.settled",
    );
    expect(events.at(-1)?.payload).toMatchObject({
      participant: "web",
      turnId: "tu_web",
      status: "aborted",
      errorMessage: "interrupted by a server restart",
    });
    // Recovery is one-shot: the settle it wrote clears the backlog.
    expect(h.repo.findUnsettledTurns()).toHaveLength(0);
  });

  it("closes an interrupted operator turn with a notice instead of redoing it", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage("orch");
      await new Promise(() => {});
    });
    const userSessionId = h.addUserSession();
    const collected = collectUntil(
      h.bus,
      (e) => e.type === "user_session.turn.started",
      5000,
    );
    h.runner.postOperatorMessage(userSessionId, "do something");
    await collected;

    const promptsBefore = h.fake.captured.prompts.length;
    const rebooted = restartHarness(h);
    expect(
      recoverInterruptedTurns({ repo: rebooted.repo, bus: rebooted.bus }),
    ).toBe(1);

    const rows = h.repo.listMessages("user", userSessionId);
    expect(rows.at(-1)).toMatchObject({
      speakerKind: "system",
      kind: "notice",
    });
    expect(rows.at(-1)?.text).toContain("Send your message again to retry");
    // The operator decides whether to retry — we never silently re-run their turn.
    expect(h.fake.captured.prompts.length).toBe(promptsBefore);
    expect(h.repo.findUnsettledTurns()).toHaveLength(0);
  });

  it("does nothing when every turn settled cleanly", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage("orch");
      yield textMessage("done");
      yield successMessage(undefined, { session_id: "orch" });
    });
    const userSessionId = h.addUserSession();
    const collected = collectUntil(
      h.bus,
      (e) => e.type === "user_session.turn.settled",
      5000,
    );
    h.runner.postOperatorMessage(userSessionId, "hi");
    await collected;

    expect(h.repo.findUnsettledTurns()).toEqual([]);
    expect(recoverInterruptedTurns({ repo: h.repo, bus: h.bus })).toBe(0);
    expect(h.repo.getParticipant("nope", ORCHESTRATOR_SEAT)).toBeUndefined();
  });
});
