/**
 * Trace foundation: commissions() must return the CREATION briefing — later
 * steering, even assignment-shaped, never overwrites a commission's
 * why/expecting — and the spec/state accessors read every column the
 * decision-time evidence layer needs.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage, toolUseMessage } from "../../src/sdk/fake.ts";
import { agentRoleOf, collectUntil, makeHarness, type Harness } from "../../src/test-helpers.ts";
import { Trace } from "./trace.ts";

describe("Trace foundation", () => {
  it("commissions() returns the briefing handoff; steering never overwrites it", async () => {
    let mainTurns = 0;
    let hRef: Harness | null = null;
    const h = makeHarness(async function* (options) {
      const identity = agentRoleOf(options);
      yield initMessage();
      if (identity.agent === undefined) {
        mainTurns += 1;
        if (mainTurns === 1) {
          yield toolUseMessage("create-1", "mcp__console__create_agent_session", {
            title: "survey", pattern: "hub_and_spoke",
            agents: [{ name: "scout", profileId: "explorer", owns: [] }],
            briefing: {
              core: { schemaVersion: 1, taskId: null, status: "pending", risk: "low", action: "Survey the repo",
                state: { summary: "greenfield", evidence: [] }, result: { summary: null, artifacts: [] },
                uncertainty: [], nextAction: "survey", requestExpandedContext: false },
              extension: { kind: "coordination", data: {} },
            },
            why: "the original why",
            expecting: "the original expecting",
          });
        } else if (mainTurns === 2) {
          const sessionId = (hRef!.sqlite.prepare("SELECT id FROM agent_sessions LIMIT 1").get() as { id: string }).id;
          yield toolUseMessage("steer-1", "mcp__console__send_to_coordinator", {
            agentSessionId: sessionId, category: "assignment", status: "pending", risk: "low",
            action: "Also check the docs", stateSummary: "follow-up", evidence: [], resultSummary: null,
            artifacts: [], uncertainty: [], nextAction: null, taskId: null, requestExpandedContext: false,
            why: "a LATER why that must not win",
          });
        }
        yield successMessage();
      } else if (identity.agent === "coordinator") {
        yield sendHandoffUse("c-1", "main", { action: "first pass done", status: "completed", category: "final" });
        yield successMessage();
      } else {
        yield successMessage();
      }
    });
    hRef = h;
    const sessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) =>
      event.type === "handoff.created" &&
      String((event.payload as { handoff?: { action?: string } }).handoff?.action ?? "").includes("Also check the docs"), 10_000);
    h.runner.postOperatorMessage(sessionId, "survey");
    await done;

    const trace = Trace.fromSqlite(h.sqlite, sessionId);
    const commissions = trace.commissions();
    expect(commissions).toHaveLength(1);
    expect(commissions[0]).toMatchObject({
      action: "Survey the repo",
      why: "the original why",
      expecting: "the original expecting",
    });
    expect(commissions[0]!.seq).toBeGreaterThan(0);
    // The briefing handoff really is the FIRST main assignment.
    const assignments = trace.handoffs((row) => row.sender === "main" && row.trigger === "assignment");
    expect(assignments.length).toBe(2);
    expect(commissions[0]!.handoffId).toBe(assignments[0]!.id);
    // resultsOf scopes to the session.
    expect(trace.resultsOf(commissions[0]!.agentSessionId).length).toBeGreaterThanOrEqual(1);
    expect(trace.resultsOf("no-such-session")).toHaveLength(0);
    // Handoff rows carry seq + sender profile.
    const final = trace.handoffs((row) => row.trigger === "final")[0]!;
    expect(final.seq).toBeGreaterThan(commissions[0]!.seq!);
  });

  it("requirement/state accessors read every column", async () => {
    const h = makeHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    const doc = "## Requirements\n- The page renders\n";
    const draft = h.app.requirements.propose(sessionId, doc, "initial");
    h.app.requirements.approve(draft.id, { document: doc, edited: false, interactionId: "int_x" });
    h.app.orchestrationState.update(sessionId, {
      trigger: "commission", strategy: "steel thread first", strategyWhy: "riskiest slice",
      uncertainties: ["storage format"], assumptions: ["node 22"], risks: ["scope creep"],
    });

    const trace = Trace.fromSqlite(h.sqlite, sessionId);
    expect(trace.requirementRevisions()).toHaveLength(1);
    expect(trace.requirementRevisions()[0]).toMatchObject({
      revision: 1, status: "approved", changeNote: "initial", interactionId: "int_x",
    });
    const state = trace.stateRevisions();
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({
      revision: 1, trigger: "commission", strategy: "steel thread first", strategyWhy: "riskiest slice",
      uncertainties: ["storage format"], assumptions: ["node 22"], risks: ["scope creep"], completion: null,
    });
  });
});
