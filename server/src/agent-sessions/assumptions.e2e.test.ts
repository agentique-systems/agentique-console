/**
 * The premise surface end to end through the seat tools: a delegated seat
 * records an assumption linked inside its sub-scope, teammates see it in
 * their deliveries, a falsification flags dependent terminal claims and
 * wakes main with a console note — and the Console rewrites nothing.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage, toolUseMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const briefing = (action: string) => ({
  core: { schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false },
  extension: { kind: "generic" as const, data: {} },
});

const DOC = `## Requirements
- Combat feels responsive
  - Input latency stays under 100ms
- \`npm run verify\` passes
`;

describe("assumptions through the seat tools (fake SDK)", () => {
  it("record → visible in deliveries → falsify → flag + console wake, statuses untouched", async () => {
    let coordinatorTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const id = agentRoleOf(options);
      yield initMessage();
      if (id.role === "main") {
        yield successMessage();
        return;
      }
      if (id.role === "coordinator") {
        coordinatorTurns += 1;
        if (coordinatorTurns === 1) {
          yield toolUseMessage("asm-1", "mcp__console_agent__record_assumption", {
            text: "Responsive means real-time input handling, not turn-based",
            requirementIds: ["r2"],
          });
          yield toolUseMessage("rep-1", "mcp__console_agent__report_requirement", {
            requirementId: "r2", status: "satisfied",
            evidence: [{ kind: "command", ref: "npm run bench" }], verifiedBy: "self" });
          yield sendHandoffUse("assign-1", "scout", { action: "double-check latency", status: "pending", category: "assignment" });
        } else {
          yield toolUseMessage("asm-2", "mcp__console_agent__resolve_assumption", {
            assumptionId: "a1", outcome: "falsified",
            evidence: [{ kind: "journal", ref: "handoff_scout" }],
            note: "the operator's reference game is turn-based",
          });
          yield sendHandoffUse("final-1", "main", { action: "latency judged", status: "completed", category: "final" });
        }
      } else {
        yield sendHandoffUse("s-1", "coordinator", { action: "reference game is turn-based", status: "completed", category: "milestone" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const draft = h.app.requirements.propose(userSessionId, DOC, "initial");
    h.app.requirements.approve(draft.id, { document: DOC, edited: false });
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 15_000);
    h.host.createSession({
      userSessionId, title: "latency", agents: [{ name: "scout", profileId: "explorer" }],
      briefing: briefing("check latency"), requirements: ["r1"],
    });
    await done;
    await collectUntil(h.bus, (event) => event.type === "assumption.resolved", 15_000);

    // The recorded premise reached the journal and the scout's delivery.
    const scoutDelivery = h.fake.captured.prompts.find((text) => text.includes("Standing assumptions"));
    expect(scoutDelivery).toBeDefined();
    expect(scoutDelivery).toContain("a1: Responsive means real-time input handling");
    expect(scoutDelivery).toContain("[r2]");

    // Falsification: the dependent terminal claim is FLAGGED, never rewritten.
    const r2 = h.app.requirements.derive(userSessionId).find((node) => node.id === "r2")!;
    expect(r2.status).toBe("satisfied");
    expect(r2.flags).toContain("rests_on_falsified");
    expect(r2.restsOn).toEqual([{ id: "a1", status: "falsified" }]);

    // Main was woken with the console note naming the suspect claim.
    await collectUntil(h.bus, (event) =>
      event.type === "user_session.turn.settled"
      && h.fake.captured.prompts.some((text) => text.includes("[Console: assumption a1")), 15_000);
    const wake = h.fake.captured.prompts.find((text) => text.includes("[Console: assumption a1"))!;
    expect(wake).toContain("FALSIFIED");
    expect(wake).toContain("r2 (satisfied)");
  });
});
