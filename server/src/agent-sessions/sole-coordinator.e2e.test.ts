/**
 * The sole-coordination-authority invariant at the service level: every door
 * that seats a caller-chosen profile — commission, child creation, late
 * add_agent — refuses to duplicate an auto-coordinated session's
 * console-seated coordinator, the refusal happens before any row or runtime
 * resource exists, and the invariant survives minting, restart, and
 * pre-contract topology snapshots. This encodes the live-run failure where
 * the reserved NAME "coordinator" was refused but the same coordinator
 * profile was accepted as "movelead" (and again as "perflead"), giving each
 * hub two management layers.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { makeHarness, restartHarness, type Harness } from "../test-helpers.ts";

/** Every seat idles on delivery — these tests assert roster state, not turns. */
function makeQuietHarness(): Harness {
  return makeHarness(async function* () {
    yield initMessage();
    yield successMessage();
  });
}

describe("sole coordination authority (fake SDK)", () => {
  it("commissioning the coordinator profile as a hub specialist fails before any resource exists", () => {
    const h = makeQuietHarness();
    const userSessionId = h.addUserSession();
    expect(() => h.host.createSession({
      userSessionId, title: "movement",
      agents: [{ name: "movelead", profileId: "coordinator" }, { name: "impl", profileId: "implementer", owns: ["crates/sim"] }],
    })).toThrow(/hub_and_spoke seats its coordinator automatically.*second coordination authority/s);
    // Rejected cheaply and atomically: no session row, no seats, no events.
    expect(h.repo.listAgentSessions(userSessionId)).toHaveLength(0);
    const created = h.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type = 'agent_session.created'").get() as { n: number };
    expect(created.n).toBe(0);
    // The live run's FIRST attempt — the literal name "coordinator" — now
    // gets the semantic error too, not the naming-collision one that taught
    // "rename and retry".
    expect(() => h.host.createSession({
      userSessionId, title: "movement",
      agents: [{ name: "coordinator", profileId: "coordinator" }],
    })).toThrow(/second coordination authority/);
  });

  it("minting a coordinator variant does not launder the archetype", () => {
    const h = makeQuietHarness();
    const userSessionId = h.addUserSession();
    // The rename-with-extra-steps bypass: a narrow mint of the coordinator
    // base keeps role "orchestrator", so the commission still refuses it.
    h.app.profiles.mint({ id: "perflead", userSessionId, baseProfileId: "coordinator" });
    expect(() => h.host.createSession({
      userSessionId, title: "responsiveness",
      agents: [{ name: "perflead", profileId: "perflead" }],
    })).toThrow(/second coordination authority/);
  });

  it("a child hub refuses a duplicate coordinator through the same door", () => {
    const h = makeQuietHarness();
    const userSessionId = h.addUserSession();
    const parent = h.host.createSession({
      userSessionId, title: "parent", agents: [{ name: "scout", profileId: "explorer" }],
    });
    expect(() => h.host.createSession({
      userSessionId, title: "child",
      parent: { agentSessionId: parent.agentSessionId, controllerAgent: "coordinator" },
      agents: [{ name: "sublead", profileId: "coordinator" }],
    })).toThrow(/second coordination authority/);
  });

  it("add_agent refuses a late second coordinator; a broad-scope reviewer stays welcome", () => {
    const h = makeQuietHarness();
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "movement", agents: [{ name: "impl", profileId: "implementer", owns: ["crates/sim"] }],
    });
    expect(() => h.host.addAgent(created.agentSessionId, { name: "movelead", profileId: "coordinator" }))
      .toThrow(/second coordination authority/);
    // The legitimate repurposing from the same live run: an independent
    // reviewer covering the whole domain is scope, not dispatch authority.
    expect(h.host.addAgent(created.agentSessionId, { name: "movelead", profileId: "reviewer" }))
      .toEqual({ agent: "movelead", role: "specialist" });
  });

  it("restart preserves the invariant, including for pre-contract topology rows", async () => {
    const h = makeQuietHarness();
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "movement", agents: [{ name: "impl", profileId: "implementer", owns: ["crates/sim"] }],
    });
    // A row from before contracts were snapshotted reads as the hub default —
    // which now carries autoCoordinatorRole, so old sessions are protected
    // with zero data rewrite.
    h.sqlite.prepare("UPDATE agent_sessions SET topology = '{}' WHERE id = ?").run(created.agentSessionId);
    const restarted = await restartHarness(h);
    expect(() => restarted.host.addAgent(created.agentSessionId, { name: "perflead", profileId: "coordinator" }))
      .toThrow(/second coordination authority/);
    expect(restarted.repo.listAgents(created.agentSessionId).map((seat) => seat.name)).toEqual(["coordinator", "impl"]);
  });

  it("plan_execute keeps its explicit-controller semantics: an orchestrator-archetype planner is the intended use", () => {
    const h = makeQuietHarness();
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "planned", pattern: "plan_execute",
      agents: [{ name: "boss", profileId: "coordinator" }, { name: "impl", profileId: "implementer", owns: ["crates/sim"] }],
    });
    expect(h.repo.getAgent(created.agentSessionId, "boss")?.role).toBe("planner");
  });
});
