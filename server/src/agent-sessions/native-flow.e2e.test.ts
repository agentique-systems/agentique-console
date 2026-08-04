import { describe, expect, it } from "vitest";
import { initMessage, successMessage, toolResultMessage, toolUseMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

describe("managed AgentSession e2e (fake SDK)", () => {
  it("persists before delivery, enforces coordinator routing, and wakes main once for final", async () => {
    let coordinatorTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
      const coordinator = append.includes("sole coordinator");
      yield initMessage(coordinator ? `coord-${coordinatorTurns}` : "scout-1");
      if (coordinator) {
        coordinatorTurns += 1;
        yield successMessage(coordinatorTurns === 1
          ? { message: "Inspect README and report the answer.", to: "scout", category: "update" }
          : { message: "Session done: pelican", to: "main", category: "final" });
      } else {
        yield toolUseMessage("read-1", "Read", { file_path: "README.md" });
        yield toolResultMessage("read-1", "the answer is pelican");
        yield successMessage({ message: "answer: pelican", to: "orchestrator", category: "milestone" });
      }
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "flow.result", 10_000);
    const created = h.host.createSession({ userSessionId, title: "riddle", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }], briefing: "find the riddle answer" });
    const events = await done;
    const rows = h.repo.listMessages("agent", created.agentSessionId).filter((row) => row.kind === "message");
    expect(rows.map((row) => `${row.speakerName}→${row.toName}: ${row.text}`)).toEqual([
      "main→orchestrator: find the riddle answer",
      "orchestrator→scout: Inspect README and report the answer.",
      "scout→orchestrator: answer: pelican",
      "orchestrator→main: Session done: pelican",
    ]);
    expect(events.filter((event) => event.type === "flow.result")).toHaveLength(1);
    expect(events.some((event) => event.type === "agent_session.tool.call" && event.payload.participant === "scout")).toBe(true);
    const deliveries = h.repo.listQueuedDeliveries(created.agentSessionId);
    expect(deliveries).toHaveLength(0);
    expect(() => h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "main", text: "bypass", category: "final" })).toThrow(/not allowed/);
  });
});
