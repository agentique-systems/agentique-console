/**
 * The session-level TerminationPolicy: bounds trip as facts (event + tripped
 * flag) and the console ASKS the reporting seat to close out — never an error,
 * never an interrupt. MAST puts termination failures at a third of all
 * multi-agent failures; these tests are the bound-by-bound proof.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const briefing = {
  core: { schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action: "do the thing", state: { summary: "do the thing", evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: "do the thing", requestExpandedContext: false },
  extension: { kind: "generic" as const, data: {} },
};

describe("termination policy e2e (fake SDK)", () => {
  it("handoff budget trips, and the reporting seat is asked to close out", async () => {
    let coordinatorTurns = 0;
    let scoutTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
      yield initMessage();
      // Send exactly once per seat: later wakes (the close-out ask itself)
      // settle quietly instead of looping assignment → report forever.
      if (append.includes("sole coordinator")) {
        coordinatorTurns += 1;
        if (coordinatorTurns === 1) yield sendHandoffUse("send-1", "scout", { action: "look", status: "pending", category: "assignment" });
      } else {
        scoutTurns += 1;
        if (scoutTurns === 1) yield sendHandoffUse("scout-1", "orchestrator", { action: "found it", status: "completed", category: "milestone" });
      }
      yield successMessage();
    });
    h.config.patternHandoffCap = 3;
    const userSessionId = h.addUserSession();
    const tripped = collectUntil(h.bus, (event) => event.type === "agent_session.termination.tripped", 10_000);
    const created = h.host.createSession({ userSessionId, title: "budget", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }], briefing });
    const events = await tripped;
    const trip = events.at(-1);
    expect(trip?.payload).toMatchObject({ agentSessionId: created.agentSessionId, pattern: "hub_and_spoke", rule: "max_handoffs" });
    // The close-out ask lands as a journaled decision handoff to the
    // reporting seat, spoken by a route-legal console voice (main).
    await collectUntil(h.bus, (event) => event.type === "agent_session.message"
      && JSON.stringify(event.payload).includes("Termination policy tripped"), 10_000);
    const rows = h.repo.listMessages("agent", created.agentSessionId).filter((row) => row.kind === "message");
    const ask = rows.find((row) => ((row.payload?.handoff as { action?: string } | undefined)?.action ?? "").includes("Termination policy tripped"));
    expect(ask?.toName).toBe("orchestrator");
    expect(h.repo.getPatternState(created.agentSessionId)?.tripped).toBe("max_handoffs");
  });

  it("stalled turns trip after the configured count", async () => {
    const h = makeDelegationHarness(async function* () {
      // Every turn settles without sending anything — the definition of stall.
      yield initMessage();
      yield successMessage();
    });
    h.config.patternStallTurns = 1;
    const userSessionId = h.addUserSession();
    const tripped = collectUntil(h.bus, (event) => event.type === "agent_session.termination.tripped", 10_000);
    const created = h.host.createSession({ userSessionId, title: "stall", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }], briefing });
    const events = await tripped;
    expect(events.at(-1)?.payload).toMatchObject({ agentSessionId: created.agentSessionId, rule: "stall" });
  });
});
