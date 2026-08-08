/**
 * The full native-messaging flow over the fake peer mesh: briefing delivered
 * console-path, coordinator assigns and specialist reports via native
 * SendMessage (middleware journaling every hop), main woken once for final,
 * and the star topology enforced on both transports.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendMessageUse, successMessage, toolResultMessage, toolUseMessage } from "../sdk/fake.ts";
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
          ? sendMessageUse("send-1", "scout", envelope("Inspect README and report the answer.", "pending", "assignment"))
          : sendMessageUse(`send-${coordinatorTurns}`, "main", envelope("Session done: pelican", "completed", "final"));
        yield successMessage();
      } else {
        yield toolUseMessage("read-1", "Read", { file_path: "README.md" });
        yield toolResultMessage("read-1", "the answer is pelican");
        yield sendMessageUse("scout-close", "orchestrator", envelope("answer: pelican", "completed", "milestone"));
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
        yield sendMessageUse("send-1", "scout", envelope("go", "pending", "assignment"));
      } else {
        // scout tries to reach its sibling directly — the middleware denies
        yield sendMessageUse("bad-send", "impl", envelope("psst", "pending", "update"));
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

  it("denies a schema-invalid envelope with the contract", async () => {
    const h = makeDelegationHarness(async function* (options) {
      const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
      yield initMessage();
      if (append.includes("sole coordinator")) {
        yield sendMessageUse("send-1", "scout", "just some prose, no JSON");
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) =>
      event.type === "agent_session.tool.result" && JSON.stringify(event.payload).includes("must be JSON"), 10_000);
    h.host.createSession({ userSessionId, title: "envelope", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("go", "pending") });
    const events = await done;
    expect(JSON.stringify(events.at(-1)?.payload)).toContain("handoff");
  });
});
