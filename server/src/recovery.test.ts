/**
 * A turn that dies with the process must not leave a session silent. These
 * pin the exact failure the operator hit: a specialist turn killed mid-flight
 * by a dev-server restart, after which nothing ever spoke again.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage, textMessage } from "./sdk/fake.ts";
import {
  collectUntil,
  makeDelegationHarness,
  restartHarness,
} from "./test-helpers.ts";
import { recoverInterruptedTurns } from "./recovery.ts";
import { ORCHESTRATOR_SEAT } from "./agent-sessions/routing.ts";

describe("recoverInterruptedTurns", () => {
  it("closes an interrupted seat turn, re-arms the seat, and says so", { timeout: 15000 }, async () => {
    // A seat whose first turn never returns — the process "dies" under it.
    let started = 0;
    const h = makeDelegationHarness(async function* (options) {
      if (options.outputFormat === undefined) {
        yield initMessage("orch");
        yield textMessage("delegated");
        yield successMessage(undefined, { session_id: "orch" });
        return;
      }
      started += 1;
      yield initMessage("seat-sdk");
      if (started === 1) {
        // Hang: stands in for a process that goes away mid-turn.
        await new Promise(() => {});
      }
      yield successMessage(
        { message: "picked up where I left off", to: null },
        { session_id: "seat-sdk" },
      );
    });

    const userSessionId = h.addUserSession();
    const { agentSessionId } = h.host.createSession({
      userSessionId,
      title: "Interrupted work",
      mode: "execute",
      agents: [{ name: "web", preset: "implementer" }],
      briefing: "build the thing",
    });
    await collectUntil(
      h.bus,
      (e) => e.type === "agent_session.turn.started",
      5000,
    );

    // The seat is mid-turn: dispatched, wake marker cleared, nothing settled.
    expect(h.repo.getParticipant(agentSessionId, "web")?.pendingTurnSeq).toBe(0);
    expect(h.repo.findUnsettledTurns()).toHaveLength(1);

    // Reboot: a fresh host/runner over the same database, as after a crash.
    const rebooted = restartHarness(h);
    const recovering = collectUntil(
      h.bus,
      (e) =>
        e.type === "agent_session.message" &&
        (e.payload as { message: { text: string } }).message.text.includes(
          "picked up where I left off",
        ),
      5000,
    );
    const count = recoverInterruptedTurns({
      repo: rebooted.repo,
      bus: rebooted.bus,
      host: rebooted.host,
    });
    expect(count).toBe(1);
    const events = await recovering;

    // The dead turn is closed, so the UI stops spinning.
    const settled = events.find(
      (e) => e.type === "agent_session.turn.settled",
    );
    expect(settled?.payload).toMatchObject({
      participant: "web",
      status: "aborted",
      errorMessage: "interrupted by a server restart",
    });

    // The transcript explains the gap rather than just skipping it.
    const notice = events.find(
      (e) =>
        e.type === "agent_session.message" &&
        (e.payload as { message: { kind: string } }).message.kind === "notice",
    );
    expect(
      (notice?.payload as { message: { text: string } }).message.text,
    ).toContain("interrupted by a server restart");

    // And the seat actually ran again, using its resume handle — so it
    // continues its own work rather than starting from nothing. (Specialist
    // turns are the ones with structured output; the last query overall is the
    // orchestrator's wake turn.)
    expect(started).toBe(2);
    const seatTurns = h.fake.captured.options.filter(
      (options) => options.outputFormat !== undefined,
    );
    expect(seatTurns.at(-1)?.resume).toBe("seat-sdk");

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
      recoverInterruptedTurns({
        repo: rebooted.repo,
        bus: rebooted.bus,
        host: rebooted.host,
      }),
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
    expect(recoverInterruptedTurns({ repo: h.repo, bus: h.bus, host: h.host })).toBe(0);
    expect(h.repo.getParticipant("nope", ORCHESTRATOR_SEAT)).toBeUndefined();
  });
});
