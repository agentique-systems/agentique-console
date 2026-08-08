/**
 * The full native-messaging flow over the fake peer mesh: briefing delivered
 * console-path, coordinator assigns and specialist reports via native
 * SendMessage (middleware journaling every hop), main woken once for final,
 * and the star topology enforced on both transports.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage, toolResultMessage, toolUseMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

describe("managed AgentSession e2e (fake SDK)", () => {
  const handoff = (action: string, status: "pending" | "in_progress" | "completed") => ({ core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
    uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });
  const envelope = (action: string, status: "pending" | "in_progress" | "completed", category: string) =>
    JSON.stringify({ handoff: handoff(action, status), category, checkpointReadiness: "stable" });

  it("persists before delivery, enforces coordinator routing, and wakes main once for final", async () => {
    let coordinatorTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
      const coordinator = append.includes("sole coordinator");
      yield initMessage(coordinator ? `coord-${coordinatorTurns}` : "scout-1");
      if (coordinator) {
        coordinatorTurns += 1;
        yield coordinatorTurns === 1
          ? sendHandoffUse("send-1", "scout", { action: "Inspect README and report the answer.", status: "pending", category: "assignment" })
          : sendHandoffUse(`send-${coordinatorTurns}`, "main", { action: "Session done: pelican", status: "completed", category: "final" });
        yield successMessage();
      } else {
        yield toolUseMessage("read-1", "Read", { file_path: "README.md" });
        yield toolResultMessage("read-1", "the answer is pelican");
        yield sendHandoffUse("scout-close", "orchestrator", { action: "answer: pelican", status: "completed", category: "milestone" });
        yield successMessage();
      }
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "flow.result", 10_000);
    const created = h.host.createSession({ userSessionId, title: "riddle", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("find the riddle answer", "pending") });
    const events = await done;
    const rows = h.repo.listMessages("agent", created.agentSessionId).filter((row) => row.kind === "message");
    expect(rows.map((row) => `${row.speakerName}→${row.toName}: ${(row.payload?.handoff as { action?: string } | undefined)?.action}`)).toEqual([
      "main→orchestrator: find the riddle answer", "orchestrator→scout: Inspect README and report the answer.",
      "scout→orchestrator: answer: pelican", "orchestrator→main: Session done: pelican",
    ]);
    expect(events.filter((event) => event.type === "flow.result")).toHaveLength(1);
    expect(events.some((event) => event.type === "agent_session.tool.call" && event.payload.participant === "scout")).toBe(true);
    // Journal states settle: nothing queued, and the model→model hops rode the peer transport.
    const deliveries = h.repo.listQueuedDeliveries(created.agentSessionId);
    expect(deliveries).toHaveLength(0);
    const transports = h.repo.listUnackedDeliveries(created.agentSessionId, "scout");
    expect(transports).toHaveLength(0);
    expect(() => h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "main", handoff: handoff("bypass", "completed"), category: "final" })).toThrow(/not allowed/);
  });

  it("denies a specialist→specialist native send with the canonical route message", async () => {
    const h = makeDelegationHarness(async function* (options) {
      const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
      const coordinator = append.includes("sole coordinator");
      yield initMessage();
      if (coordinator) {
        yield sendHandoffUse("send-1", "scout", { action: "go", status: "pending", category: "assignment" });
      } else {
        // scout tries to reach its sibling directly — the middleware denies
        yield sendHandoffUse("bad-send", "impl", { action: "psst", status: "pending", category: "update" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) =>
      event.type === "agent_session.tool.result" && JSON.stringify(event.payload).includes("not allowed"), 10_000);
    h.host.createSession({ userSessionId, title: "topology", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }, { name: "impl", profileId: "explorer" }], briefing: handoff("go", "pending") });
    const events = await done;
    const denial = events.at(-1);
    expect(JSON.stringify(denial?.payload)).toContain("main ↔ coordinator ↔ specialist");
  });

  it("salvages a seat's unsent work when its turn dies", async () => {
    // The guarantee that survives the transport consolidation. A typed
    // send_handoff cannot be malformed, so "the seat could not serialize its
    // report" is gone — but "the seat finished and then its turn died" is not.
    // db-live-1 lost its best output exactly there: `check` completed a real
    // review, the watchdog killed the turn, and the coordinator was handed an
    // empty "Turn failed" with no evidence and no result.
    let coordinatorTurns = 0;
    let scoutTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
      yield initMessage();
      if (append.includes("sole coordinator")) {
        coordinatorTurns += 1;
        // Assign exactly once: the failure handoff wakes the coordinator again,
        // and re-assigning would loop the seat through the same failure.
        if (coordinatorTurns === 1) yield sendHandoffUse("send-1", "scout", { action: "verify the build", status: "pending", category: "assignment" });
        yield successMessage();
        return;
      }
      scoutTurns += 1;
      if (scoutTurns > 1) { yield successMessage(); return; }
      // The seat does the work and says so — then burns its turn on failures.
      yield { type: "assistant", message: { content: [{ type: "text", text: "Collision tunneling at src/game.js:191 — obstacles step 2.4 units through a 2.0-unit window." }] } };
      for (let i = 0; i < 11; i += 1) {
        yield toolUseMessage(`probe-${i}`, "Read", { file_path: `f${i}.ts` });
        yield toolResultMessage(`probe-${i}`, "boom", true);
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.watchdog", 10_000);
    const created = h.host.createSession({ userSessionId, title: "salvage", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("verify", "pending") });
    await done;
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled"
      && JSON.stringify(event.payload).includes("scout"), 10_000);

    const failure = h.repo.latestHandoff({ userSessionId, agentSessionId: created.agentSessionId, sender: "scout" });
    expect(failure?.core.status).toBe("failed");
    // The finding reaches the coordinator instead of dying with the turn...
    expect(failure?.core.state.summary).toContain("Collision tunneling at src/game.js:191");
    // ...clearly marked as never having passed through a handoff.
    expect(failure?.core.state.summary).toContain("never passed through a handoff");
  });
});
