/**
 * Attention-gated delivery: a durable coordination event earns a model turn
 * only when consuming it NOW can change the recipient's next action. These
 * encode the first live run's relay failure (routine specialist progress
 * repeatedly woke a coordinator, which repeatedly woke main — 90 update and
 * 56 decision handoffs, 91 mid-turn steers) as regression scenarios:
 * routine progress persists without a wake and rides the next composed
 * delivery; material events wake, coalescing whatever accumulated; a burst of
 * compatible material events becomes one boundary turn; restart preserves
 * deferred rows without promoting them into wakes.
 */
import { describe, expect, it } from "vitest";
import type { HandoffDraft } from "@agentique-console/shared";
import { agentRoleOf, collectUntil, makeDelegationHarness, restartHarness } from "../test-helpers.ts";
import { initMessage, successMessage, toolResultMessage, toolUseMessage } from "../sdk/fake.ts";

const draft = (action: string, status: HandoffDraft["core"]["status"], risk: HandoffDraft["core"]["risk"] = "low"): HandoffDraft => ({
  core: { schemaVersion: 1, taskId: null, status, risk, action,
    state: { summary: action, evidence: [] },
    result: { summary: status === "completed" ? action : null, artifacts: [] },
    uncertainty: [], nextAction: null, requestExpandedContext: false },
  extension: { kind: "generic", data: {} },
});

/** All lanes idle: every spawn/turn scripts init + success. */
const idleProgram = async function* () {
  yield initMessage();
  yield successMessage();
};

/** Poll until `read` yields a value (the fake records prompts asynchronously). */
async function pollFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("pollFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("attention-gated delivery (fake SDK)", () => {
  it("persists routine specialist progress without waking the coordinator, then delivers it all with the next milestone", async () => {
    const h = makeDelegationHarness(idleProgram);
    const userSessionId = h.addUserSession();
    // No briefing: nothing wakes the coordinator until this test does.
    const created = h.host.createSession({ userSessionId, title: "relay", agents: [{ name: "scout", profileId: "explorer" }] });
    const session = h.repo.getAgentSession(created.agentSessionId)!;

    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "coordinator",
      handoff: draft("implemented part 1 of 3", "in_progress"), category: "update" });
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "coordinator",
      handoff: draft("tests still running", "in_progress"), category: "update" });

    // Journaled and visible — queued as "defer" — but no turn, no spawn, and
    // the session does not read as working off the back of them.
    const queued = h.repo.listUnackedDeliveries(created.agentSessionId, "coordinator");
    expect(queued.map((row) => [row.status, row.attention])).toEqual([["queued", "defer"], ["queued", "defer"]]);
    expect(h.host.statusOf(session)).toBe("idle");

    // The milestone is what earns the turn; the deferred rows ride along.
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "coordinator",
      handoff: draft("candidate table landed", "completed"), category: "milestone" });
    const events = await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled" && event.payload.agent === "coordinator", 10_000);

    const coordinatorTurns = events.filter((event) => event.type === "agent_session.turn.started" && event.payload.agent === "coordinator");
    expect(coordinatorTurns).toHaveLength(1);
    const delivered = h.fake.captured.prompts.find((prompt) => prompt.includes("candidate table landed"));
    expect(delivered).toBeDefined();
    expect(delivered).toContain("implemented part 1 of 3");
    expect(delivered).toContain("tests still running");
    // One settled turn acknowledged the whole batch.
    expect(h.repo.listUnackedDeliveries(created.agentSessionId, "coordinator")).toHaveLength(0);
    // Main was never woken by any of this workstream-local traffic.
    expect(events.some((event) => event.type === "agent_session.result.returned")).toBe(false);
  });

  it("wakes the coordinator for a blocker, and main exactly once for the promoted blocker", async () => {
    const h = makeDelegationHarness(idleProgram);
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "blocker", agents: [{ name: "scout", profileId: "explorer" }] });

    // A blocked report is urgent: the coordinator wakes for it.
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "coordinator",
      handoff: draft("cross-workstream conflict: canon freeze blocks measurement", "blocked"), category: "update" });
    const coordinatorEvents = await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled" && event.payload.agent === "coordinator", 10_000);
    expect(coordinatorEvents.filter((event) => event.type === "agent_session.turn.started" && event.payload.agent === "coordinator")).toHaveLength(1);

    // The coordinator promotes the material fact across the boundary: main
    // wakes exactly once.
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "coordinator" }, to: "main",
      handoff: draft("blocked on cross-workstream canon freeze; need a run-level call", "blocked"), category: "milestone" });
    const events = await collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 10_000);
    expect(events.filter((event) => event.type === "agent_session.result.returned")).toHaveLength(1);
  });

  it("records a decision RECORD to main without a wake; a decision REQUEST wakes, counting what accumulated", async () => {
    const h = makeDelegationHarness(idleProgram);
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "decisions", agents: [{ name: "scout", profileId: "explorer" }] });

    // "I decided X, continuing" — journaled, acknowledged, no main turn.
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "coordinator" }, to: "main",
      handoff: draft("renamed the local helper; continuing", "in_progress"), category: "decision" });
    expect(h.repo.hasEvent("agent_session.result.returned", created.agentSessionId)).toBe(false);

    // "Your call is required" — wakes main, and the wake text carries the
    // count of what was recorded without waking it.
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "coordinator" }, to: "main",
      handoff: draft("two implementation options conflict with the contract", "blocked"), category: "decision" });
    const events = await collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 10_000);
    expect(events.filter((event) => event.type === "agent_session.result.returned")).toHaveLength(1);
    // The wake is enqueued before the runner mints main's turn — wait for the
    // recorded prompt rather than racing it.
    const wakePrompt = await pollFor(() => h.fake.captured.prompts.find((prompt) => prompt.includes("two implementation options conflict")));
    expect(wakePrompt).toContain("1 earlier report(s) from this session were recorded without waking you");
  });

  it("coalesces a burst of material events arriving during a busy turn into one boundary turn, without steering", async () => {
    let releaseCoordinator: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseCoordinator = resolve; });
    let coordinatorTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      if (agentRoleOf(options).agent === "coordinator") {
        coordinatorTurns += 1;
        yield initMessage(`coord-${coordinatorTurns}`);
        if (coordinatorTurns === 1) {
          yield toolUseMessage("t-1", "Read", { file_path: "plan.md" });
          yield toolResultMessage("t-1", "…");
          await gate; // busy while both finals arrive
        }
        yield successMessage();
        return;
      }
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "burst", agents: [{ name: "a", profileId: "explorer" }, { name: "b", profileId: "explorer" }] });

    const midTurn = collectUntil(h.bus, (event) => event.type === "agent_session.tool.completed" && event.payload.agent === "coordinator", 10_000);
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "main" }, to: "coordinator",
      handoff: draft("integrate as results land", "pending"), category: "assignment" });
    await midTurn;

    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "a" }, to: "coordinator",
      handoff: draft("worker a done", "completed"), category: "update" });
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "b" }, to: "coordinator",
      handoff: draft("worker b done", "completed"), category: "update" });
    releaseCoordinator();

    let settles = 0;
    const events = await collectUntil(h.bus, (event) => {
      if (event.type === "agent_session.turn.settled" && event.payload.agent === "coordinator") settles += 1;
      return settles === 2;
    }, 10_000);
    expect(events.filter((event) => event.type === "agent_session.turn.started" && event.payload.agent === "coordinator")).toHaveLength(2);
    expect(events.some((event) => event.type === "agent_session.runtime.noted" && String(event.payload.detail).includes("steered mid-turn"))).toBe(false);
    const boundary = h.fake.captured.prompts.find((prompt) => prompt.includes("worker a done"));
    expect(boundary).toBeDefined();
    expect(boundary).toContain("worker b done");
  });

  it("preserves deferred rows across a restart without promoting them into wakes", async () => {
    const h = makeDelegationHarness(idleProgram);
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "restart", agents: [{ name: "scout", profileId: "explorer" }] });
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "coordinator",
      handoff: draft("halfway through the dataset", "in_progress"), category: "update" });
    expect(h.repo.listUnackedDeliveries(created.agentSessionId, "coordinator").map((row) => row.attention)).toEqual(["defer"]);

    const h2 = await restartHarness(h);
    // Boot redrove queued deliveries — the deferred row stayed durable and
    // queued instead of becoming an immediate wake.
    expect(h2.repo.listUnackedDeliveries(created.agentSessionId, "coordinator").map((row) => [row.status, row.attention])).toEqual([["queued", "defer"]]);

    // The first material event after the restart carries it in.
    h2.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "coordinator",
      handoff: draft("dataset findings ready", "completed"), category: "milestone" });
    const events = await collectUntil(h2.bus, (event) => event.type === "agent_session.turn.settled" && event.payload.agent === "coordinator", 10_000);
    expect(events.filter((event) => event.type === "agent_session.turn.started" && event.payload.agent === "coordinator")).toHaveLength(1);
    const delivered = h2.fake.captured.prompts.find((prompt) => prompt.includes("dataset findings ready"));
    expect(delivered).toBeDefined();
    expect(delivered).toContain("halfway through the dataset");
    expect(h2.repo.listUnackedDeliveries(created.agentSessionId, "coordinator")).toHaveLength(0);
  });

  it("does not let unread routine updates hold a reported session open", async () => {
    const h = makeDelegationHarness(idleProgram);
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "closure", agents: [{ name: "scout", profileId: "explorer" }] });
    // Routine progress the coordinator never got a reason to read...
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "coordinator",
      handoff: draft("still polishing", "in_progress"), category: "update" });
    // ...must not deadlock the session's closure once its final is in.
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "coordinator" }, to: "main",
      handoff: draft("workstream concluded; evidence in the journal", "completed"), category: "final" });
    const session = h.repo.getAgentSession(created.agentSessionId)!;
    expect(h.host.statusOf(session)).toBe("reported");
    // The unread update stays durable and auditable — closure ignored it, it
    // did not delete it.
    expect(h.repo.listUnackedDeliveries(created.agentSessionId, "coordinator").map((row) => row.attention)).toEqual(["defer"]);
  });

  it("still relays a silent specialist's completed work to the coordinator (terminal statuses wake)", async () => {
    const h = makeDelegationHarness(idleProgram);
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "terminal", agents: [{ name: "scout", profileId: "explorer" }] });
    // A terminal-status update is a specialist final: local controller
    // integration attention is warranted, whatever the category label.
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "coordinator",
      handoff: draft("assignment finished; results in report", "completed"), category: "update" });
    const events = await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled" && event.payload.agent === "coordinator", 10_000);
    expect(events.filter((event) => event.type === "agent_session.turn.started" && event.payload.agent === "coordinator")).toHaveLength(1);
    // ...and main stayed asleep: workstream-local integration ends locally.
    expect(events.some((event) => event.type === "agent_session.result.returned")).toBe(false);
  });
});
