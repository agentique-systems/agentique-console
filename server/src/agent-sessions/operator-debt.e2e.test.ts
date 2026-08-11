/**
 * The operator obligation is the Console's, not the coordinator's: a
 * coordinator that forgets, dies, or is jammed must not be able to produce
 * silence.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const handoff = (action: string, status: "pending" | "completed") => ({ core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
  action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
  uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });

describe("operator debt (fake SDK)", () => {
  it("closes the loop from the journal when the coordinator never reports", async () => {
    // Both agents work and go quiet; nobody ever addresses main.
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "silent", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("investigate", "pending") });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    // A specialist's finding exists in the journal but was never relayed up —
    // exactly `check`'s situation.
    const tool = h.fake.captured.tools.filter((t) => t.name === "send_handoff").at(-1);
    expect(tool).toBeDefined();

    const unreported = collectUntil(h.bus, (event) => event.type === "agent_session.closeout.forced", 10_000);
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "coordinator",
      handoff: { core: { schemaVersion: 1, taskId: null, status: "completed", risk: "medium",
        action: "Verify the build",
        state: { summary: "Collision tunneling at src/game.js:191 — fix before shipping.", evidence: [] },
        result: { summary: "One medium defect.", artifacts: [] }, uncertainty: [], nextAction: null, requestExpandedContext: false },
        extension: { kind: "investigation", data: {} } }, category: "final" });
    const events = await unreported;

    expect(events.at(-1)?.payload).toMatchObject({ agentSessionId: created.agentSessionId, hadCoordinatorReport: false });
    // The operator is told, and the specialist's finding travels with it.
    const toMain = h.repo.latestHandoff({ userSessionId, agentSessionId: created.agentSessionId, recipient: "main" });
    expect(toMain).toBeDefined();
    expect(toMain?.core.state.summary).toContain("Collision tunneling at src/game.js:191");
    // ...and is honestly labelled as console-assembled, not a coordinator result.
    expect(toMain?.core.state.summary).toContain("Nothing below was assembled or endorsed by the coordinator");
    expect(toMain?.core.status).toBe("needs_verification");
  });

  it("reports final with caveats rather than suppressing it when work is open", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "caveats", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("investigate", "pending") });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    // An assignment nobody has acknowledged rides as a caveat, never a throw.
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "coordinator" }, to: "scout",
      handoff: handoff("go dig", "pending"), category: "assignment" });

    const message = h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "coordinator" }, to: "main",
      handoff: handoff("all done", "completed"), category: "final" });
    expect(message).toBeDefined();

    const toMain = h.repo.latestHandoff({ userSessionId, agentSessionId: created.agentSessionId, recipient: "main" });
    expect(toMain?.core.uncertainty.join(" ")).toContain("reported final with work outstanding");
  });
});
