/**
 * Session-as-primitive composition levers: main steering any seat directly
 * (update-only), mid-run roster growth, main-side session termination, and
 * the re-brief that resets a tripped pattern's budgets.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeDelegationHarness, type Harness } from "../test-helpers.ts";

const draft = (action: string, status: "pending" | "in_progress" = "pending") => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
    action, state: { summary: action, evidence: [] },
    result: { summary: null, artifacts: [] }, uncertainty: [], nextAction: action,
    requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

/** Coordinator assigns scout once; everyone else idles on delivery. */
function makeHubHarness(): Harness {
  let coordinatorTurns = 0;
  return makeDelegationHarness(async function* (options) {
    const identity = agentRoleOf(options);
    yield initMessage();
    if (identity.agent === "coordinator") {
      coordinatorTurns += 1;
      if (coordinatorTurns === 1) {
        yield sendHandoffUse("send-1", "scout", { action: "survey", status: "pending", category: "assignment" });
      }
    }
    yield successMessage();
  });
}

async function seatHub(h: Harness, agents: { name: string; profileId: string; owns?: string[] }[] = [{ name: "scout", profileId: "explorer" }]) {
  const userSessionId = h.addUserSession();
  const settled = collectUntil(h.bus, (event) =>
    event.type === "agent_session.turn.settled" && (event.payload as { agent?: string }).agent === "scout", 10_000);
  const created = h.host.createSession({ userSessionId, title: "levers", agents, briefing: draft("survey") });
  await settled;
  return { userSessionId, created };
}

describe("composition levers (fake SDK)", () => {
  it("main can steer any seat directly with an update; assignments keep one front door", async () => {
    const h = makeHubHarness();
    const { created } = await seatHub(h);

    // update to a NON-entry seat: legal on the new main→specialist edge.
    const posted = h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "main" },
      to: "scout", handoff: draft("Correction: the pin is authoritative, target Node 18", "in_progress"), category: "update" });
    expect(posted.seq).toBeGreaterThan(0);

    // assignment to the same seat: the edge carries update only.
    expect(() => h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "main" },
      to: "scout", handoff: draft("new work"), category: "assignment" })).toThrow(/does not carry "assignment"/);
  });

  it("add_agent seats a specialist mid-run and tells the entry agent; fixed rosters refuse", async () => {
    const h = makeHubHarness();
    const { created } = await seatHub(h);

    const added = h.host.addAgent(created.agentSessionId, { name: "auditor", profileId: "reviewer" });
    expect(added).toEqual({ agent: "auditor", role: "specialist" });
    expect(h.repo.getAgent(created.agentSessionId, "auditor")?.role).toBe("specialist");
    const events = h.sqlite.prepare("SELECT payload FROM events WHERE type = 'agent_session.agent.added'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    // The coordinator was told about its new teammate through the mailroom.
    const notice = h.repo.listMessages("agent", created.agentSessionId)
      .find((row) => row.toName === "coordinator" && String((row.payload?.handoff as { action?: string } | undefined)?.action ?? "").startsWith("New agent \"auditor\""));
    expect(notice).toBeDefined();

    // A pipeline's stages ARE its shape: no late seats.
    const userSessionId = h.addUserSession();
    const pipeline = h.host.createSession({ userSessionId, title: "fixed", pattern: "pipeline",
      agents: [{ name: "draft", profileId: "explorer" }, { name: "polish", profileId: "explorer" }], briefing: draft("go") });
    expect(() => h.host.addAgent(pipeline.agentSessionId, { name: "extra", profileId: "explorer" }))
      .toThrow(/roster is fixed/);
  });

  it("close_agent_session archives a top-level session and returns its open units", async () => {
    const h = makeHubHarness();
    const { userSessionId, created } = await seatHub(h);
    h.tasks.upsertFromCreate({
      sdkSessionId: `console:${created.agentSessionId}:orchestrator`, sdkTaskId: "survey",
      subject: "Survey the repo", owner: "scout",
      attribution: { workspaceId: h.workspaceId, userSessionId, agentSessionId: created.agentSessionId, agent: null },
    });

    const closed = h.host.closeSession(created.agentSessionId, "superseded by a better strategy");
    expect(closed.archived).toBe(true);
    expect(closed.openTasks.join(" ")).toContain("Survey the repo");
    expect(h.repo.getAgentSession(created.agentSessionId)?.lifecycle).toBe("archived");
    // Closing is journaled with its reason.
    const note = h.sqlite.prepare(
      "SELECT count(*) AS n FROM events WHERE type = 'agent_session.runtime.noted' AND json_extract(payload, '$.detail') LIKE 'session closed by main:%'").get() as { n: number };
    expect(note.n).toBe(1);
    // And closing again is a truthful error, not a silent no-op.
    expect(() => h.host.closeSession(created.agentSessionId, "again")).toThrow(/already archived/);
  });

  it("a fresh briefing from main resets a tripped pattern's budgets", async () => {
    const h = makeHubHarness();
    const { created } = await seatHub(h);
    h.repo.upsertPatternState(created.agentSessionId, { tripped: "max_handoffs", handoffCount: 40 });

    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "main" },
      to: "coordinator", handoff: draft("Re-brief: new round of work"), category: "assignment" });

    const state = h.repo.getPatternState(created.agentSessionId);
    expect(state?.tripped).toBeNull();
    // The re-brief hop itself is hop #1 of the fresh budget.
    expect(state?.handoffCount).toBe(1);
  });
});
