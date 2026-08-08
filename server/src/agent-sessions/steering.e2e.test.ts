/**
 * Peer-lane delivery semantics: mid-turn steering into a live seat, idle
 * park + wake-on-delivery with the resume handle, and the deny-with-receipt →
 * background-retry path when resident capacity is exhausted.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage, toolResultMessage, toolUseMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const handoff = (action: string, status: "pending" | "completed") => ({ core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
  action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
  uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });
const envelope = (action: string, status: "pending" | "completed", category: string) =>
  JSON.stringify({ handoff: handoff(action, status), category, checkpointReadiness: "stable" });

describe("peer-lane delivery semantics (fake SDK)", () => {
  it("steers a busy seat mid-turn instead of minting a second turn", async () => {
    let releaseScout: () => void = () => undefined;
    const scoutGate = new Promise<void>((resolve) => { releaseScout = resolve; });
    let scoutTurns = 0;
    let coordinatorTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
      if (append.includes("sole coordinator")) {
        coordinatorTurns += 1;
        yield initMessage(`coord-${coordinatorTurns}`);
        if (coordinatorTurns === 1) yield sendHandoffUse("send-1", "scout", { action: "dig in", status: "pending", category: "assignment" });
        yield successMessage();
        return;
      }
      scoutTurns += 1;
      yield initMessage("scout-1");
      if (scoutTurns === 1) {
        yield toolUseMessage("t-1", "Read", { file_path: "a.ts" });
        yield toolResultMessage("t-1", "…");
        await scoutGate; // held mid-turn until the steer lands
        yield sendHandoffUse("scout-close", "orchestrator", { action: "dug", status: "completed", category: "milestone" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const midTurn = collectUntil(h.bus, (event) => event.type === "agent_session.tool.result" && event.payload.participant === "scout", 10_000);
    const created = h.host.createSession({ userSessionId, title: "steer", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("go", "pending") });
    await midTurn;
    const steered = collectUntil(h.bus, (event) => event.type === "agent_session.runtime" && String(event.payload.detail).includes("steered mid-turn"), 10_000);
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "orchestrator" }, to: "scout",
      handoff: handoff("also check b.ts", "pending"), category: "update" });
    await steered;
    releaseScout();
    const events = await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled" && event.payload.participant === "scout", 10_000);
    const scoutStarts = events.filter((event) => event.type === "agent_session.turn.started" && event.payload.participant === "scout");
    expect(scoutStarts).toHaveLength(1);
    expect(h.fake.captured.prompts.some((prompt) => prompt.includes("arrived while you were working"))).toBe(true);
    // The steered delivery was consumed by the same settled turn.
    expect(h.repo.listUnackedDeliveries(created.agentSessionId, "scout")).toHaveLength(0);
  });

  it("parks an idle seat, then wakes it with its resume handle on the next delivery", async () => {
    let scoutSpawns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
      if (append.includes("sole coordinator")) {
        yield initMessage("coord-1");
        yield successMessage();
        return;
      }
      yield initMessage("scout-session");
      yield successMessage();
    });
    (h.config as { seatIdleReapMs: number }).seatIdleReapMs = 60;
    const userSessionId = h.addUserSession();
    const parked = collectUntil(h.bus, (event) => event.type === "agent_session.runtime"
      && (event.payload as { participant?: string }).participant === "scout"
      && String(event.payload.detail).includes("seat parked (idle)"), 10_000);
    const created = h.host.createSession({ userSessionId, title: "reap", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }] });
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "main" }, to: "orchestrator",
      handoff: handoff("brief", "pending"), category: "assignment" });
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "orchestrator" }, to: "scout",
      handoff: handoff("look", "pending"), category: "assignment" });
    await parked;
    scoutSpawns = h.fake.captured.options.filter((options) => (options.env as Record<string, string> | undefined)?.CLAUDE_CODE_SESSION_NAME?.startsWith("console-scout")).length;
    let scoutSettles = 0;
    const woken = collectUntil(h.bus, (event) => {
      if (event.type === "agent_session.turn.settled" && event.payload.participant === "scout") scoutSettles += 1;
      return scoutSettles === 2; // history replays the pre-park settle
    }, 10_000);
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "orchestrator" }, to: "scout",
      handoff: handoff("look again", "pending"), category: "assignment" });
    await woken;
    const scoutOptions = h.fake.captured.options.filter((options) => (options.env as Record<string, string> | undefined)?.CLAUDE_CODE_SESSION_NAME?.startsWith("console-scout"));
    expect(scoutOptions.length).toBe(scoutSpawns + 1);
    expect(scoutOptions.at(-1)?.resume).toBe("scout-session");
  });

  it("holds a delivery at capacity and carries it when a lane frees, with no sender-visible failure", async () => {
    let scoutRan = false;
    const h = makeDelegationHarness(async function* (options) {
      const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
      if (append.includes("sole coordinator")) {
        yield initMessage("coord-1");
        yield sendHandoffUse("send-1", "scout", { action: "squeeze in", status: "pending", category: "assignment" });
        yield successMessage();
        return;
      }
      scoutRan = true;
      yield initMessage("scout-1");
      yield sendHandoffUse("scout-close", "orchestrator", { action: "made it", status: "completed", category: "milestone" });
      yield successMessage();
    });
    (h.config as { seatMaxResidentPerSession: number }).seatMaxResidentPerSession = 1;
    (h.config as { sendWakeTimeoutMs: number }).sendWakeTimeoutMs = 150;
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "capacity", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("go", "pending") });

    // One console-carried path means capacity is not a delivery outcome. The
    // row is journaled and waits; the sender is never handed a receipt to
    // reason about, and there is no "do not resend" contract to get wrong.
    // The native path made this a DENIAL the model had to interpret — and it
    // then counted toward the tool-error watchdog.
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled" && event.payload.participant === "scout", 15_000);
    expect(scoutRan).toBe(true);
    expect(h.repo.listUnackedDeliveries(created.agentSessionId, "scout")).toHaveLength(0);
  });
});
