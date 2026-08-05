import { describe, expect, it } from "vitest";
import { initMessage, successMessage, toolResultMessage, toolUseMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

describe("managed AgentSession e2e (fake SDK)", () => {
  it("persists before delivery, enforces coordinator routing, and wakes main once for final", async () => {
    const handoff = (action: string, status: "pending" | "in_progress" | "completed") => ({ core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
      action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
      uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });
    let coordinatorTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
      const coordinator = append.includes("sole coordinator");
      yield initMessage(coordinator ? `coord-${coordinatorTurns}` : "scout-1");
      if (coordinator) {
        coordinatorTurns += 1;
        yield successMessage(coordinatorTurns === 1
          ? { handoff: handoff("Inspect README and report the answer.", "pending"), to: "scout", category: "assignment", checkpointReadiness: "stable" }
          : { handoff: handoff("Session done: pelican", "completed"), to: "main", category: "final", checkpointReadiness: "stable" });
      } else {
        yield toolUseMessage("read-1", "Read", { file_path: "README.md" });
        yield toolResultMessage("read-1", "the answer is pelican");
        yield successMessage({ handoff: handoff("answer: pelican", "completed"), to: "orchestrator", category: "milestone", checkpointReadiness: "stable" });
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
    const deliveries = h.repo.listQueuedDeliveries(created.agentSessionId);
    expect(deliveries).toHaveLength(0);
    expect(() => h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "main", handoff: handoff("bypass", "completed"), category: "final" })).toThrow(/not allowed/);
  });
});
