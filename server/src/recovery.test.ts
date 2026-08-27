/**
 * A turn that dies with the process must not leave the UI spinning. A crash
 * leaves turn.started with no settle, and recovery closes it — the agent's
 * provider session survives (resume handle in participants) and the journal
 * redelivers anything unacknowledged when the agent next wakes.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage, textMessage } from "./sdk/fake.ts";
import {
  collectUntil,
  makeDelegationHarness,
  restartHarness,
} from "./test-helpers.ts";
import { reconcileDurableCommunication, recoverInterruptedTurns } from "./recovery.ts";
import { findUnsettledTurns } from "./events/projections.ts";
import { COORDINATOR_AGENT } from "./agent-sessions/names.ts";

describe("recoverInterruptedTurns", () => {
  it("reconciles an authoritative message whose event append was interrupted", async () => {
    const h = makeDelegationHarness(async function* () { yield successMessage(); });
    const userSessionId = h.addUserSession();
    h.repo.appendMessage({ sessionKind: "user", sessionId: userSessionId, speaker: { kind: "system", name: "system" }, kind: "notice", text: "committed before crash" });
    expect(await reconcileDurableCommunication({ repo: h.repo, bus: h.bus })).toBe(1);
    const events = await collectUntil(h.bus, (event) => event.type === "user_session.message.appended");
    expect(events.at(-1)?.payload).toMatchObject({ message: { text: "committed before crash" } });
    expect(await reconcileDurableCommunication({ repo: h.repo, bus: h.bus })).toBe(0);
  });
  it("closes an agent turn orphaned by a crash", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage("orch");
      yield successMessage(undefined, { session_id: "orch" });
    });
    const userSessionId = h.addUserSession();
    const { agentSessionId } = h.host.createSession({
      userSessionId,
      title: "Interrupted work",
      agents: [{ name: "web", profileId: "implementer", owns: ["src/web.ts"] }],
    });
    // A live agent (turn.started emitted), then the process dies before the
    // settle — the in-memory lane state vanishes with it.
    const session = h.repo.getAgentSession(agentSessionId)!;
    h.bus.append({ type: "agent_session.turn.started", userSessionId: session.userSessionId, agentSessionId,
      payload: { agentSessionId, agent: "web", turnId: "tu_web" } });
    expect(findUnsettledTurns(h.db)).toHaveLength(1);

    const rebooted = await restartHarness(h);
    expect(rebooted.bootReport.recoveredTurns).toBe(1);

    const events = await collectUntil(
      h.bus,
      (e) => e.type === "agent_session.turn.settled",
    );
    expect(events.at(-1)?.payload).toMatchObject({
      agent: "web",
      turnId: "tu_web",
      status: "aborted",
      errorMessage: "interrupted by a server restart",
    });
    // The restart is MATERIAL: boot posts a resume digest that wakes main so
    // it decides resume/steer/close — wait for that woken turn to settle.
    // (rebooted.bus: post-restart live events publish on the NEW app's bus.)
    await collectUntil(rebooted.bus, (e) => e.type === "user_session.turn.settled");
    const resume = h.repo.listMessages("agent", agentSessionId)
      .find((row) => String((row.payload?.handoff as { action?: string } | undefined)?.action ?? "").startsWith("Server restart interrupted"));
    expect(resume).toBeDefined();
    // Recovery is one-shot: the settle it wrote clears the backlog.
    expect(findUnsettledTurns(h.db)).toHaveLength(0);
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
    const rebooted = await restartHarness(h);
    expect(rebooted.bootReport.recoveredTurns).toBe(1);

    const rows = h.repo.listMessages("user", userSessionId);
    expect(rows.at(-1)).toMatchObject({
      speakerKind: "system",
      kind: "notice",
    });
    expect(rows.at(-1)?.text).toContain("Send your message again to retry");
    // The operator decides whether to retry — we never silently re-run their turn.
    expect(h.fake.captured.prompts.length).toBe(promptsBefore);
    expect(findUnsettledTurns(h.db)).toHaveLength(0);
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

    expect(findUnsettledTurns(h.db)).toEqual([]);
    expect(recoverInterruptedTurns({ db: h.db, repo: h.repo, bus: h.bus })).toEqual({ count: 0, agentTurns: [] });
    expect(h.repo.getAgent("nope", COORDINATOR_AGENT)).toBeUndefined();
  });
});
