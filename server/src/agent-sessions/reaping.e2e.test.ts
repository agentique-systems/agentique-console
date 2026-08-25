/**
 * Runtime an agent holds must die with its lane.
 *
 * The Console owns no process table: a seat's CLI subprocess is the boundary,
 * and everything the agent started — a background `Bash` server, an MCP
 * server's browser — is a child of it. So the assertion is about the LANE, and
 * that the park is announced rather than silent.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const handoff = (action: string) => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

const parkNotice = (event: { type: string; payload: unknown }) =>
  event.type === "agent_session.runtime.noted"
  && String((event.payload as { detail?: string }).detail ?? "").includes("agent parked");

describe("agent park releases the agent's runtime", () => {
  it("closes the parking agent's lane and says so, without touching its siblings", async () => {
    const h = makeDelegationHarness(
      async function* () {
        yield initMessage();
        yield successMessage();
      },
      // A 20ms idle window so the park happens inside the test rather than
      // five minutes later.
      { config: { policy: { agentIdleReapMs: 20 } } },
    );
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "reaping", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe"),
    });

    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    // Wait for the TYPED park state, which lands right after the prose notice:
    // the UI's seat dot renders from this, so "parked seat, resume handle
    // kept" must be a wire fact, not only a sentence.
    const events = await collectUntil(h.bus, (event) => event.type === "agent_session.activity.changed"
      && (event.payload as { state?: string }).state === "parked", 10_000);
    const typedPark = events.filter((event) => event.type === "agent_session.activity.changed"
      && (event.payload as { state?: string }).state === "parked");
    expect(typedPark.length).toBeGreaterThan(0);
    expect((typedPark[0]?.payload as { agent?: string }).agent).toBe("coordinator");

    // The notice must name what happened. A silent close turns "my server
    // vanished" into a forensic exercise.
    const parked = events.filter(parkNotice);
    expect(parked.length).toBeGreaterThan(0);
    const detail = String((parked[0]?.payload as { detail?: string }).detail ?? "");
    expect(detail).toContain("provider session retained");

    // Scoped to the parking seat, never the session: a sibling's work survives
    // its neighbour going idle.
    for (const event of parked) {
      expect((event.payload as { agent: string }).agent).toBe("coordinator");
    }
    expect(h.host.statusOf(h.repo.getAgentSession(created.agentSessionId)!)).not.toBe("archived");
  });
});
