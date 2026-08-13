/**
 * The living spec + orchestration state, end to end through the real MCP
 * handlers: propose_spec parks on an approval card and returns the operator's
 * EDITED text; update_orchestration_state / record_completion persist and
 * surface; why/expecting ride a commission's briefing into the recipient's
 * delivered prompt.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage, textMessage, toolUseMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeHarness } from "../test-helpers.ts";

const settled = (event: { type: string }): boolean => event.type === "user_session.turn.settled";

describe("living spec (fake SDK)", () => {
  it("propose_spec parks on the card; the operator's edited text becomes the governing revision", async () => {
    const h = makeHarness(async function* () {
      yield initMessage();
      yield toolUseMessage("spec-1", "mcp__console__propose_spec", {
        document: "# Reading tracker\n\nGoals: track books.\n\n## Open uncertainties\n- storage",
        changeNote: "initial spec",
      });
      yield textMessage("Spec settled.");
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    const done = collectUntil(h.bus, settled);

    h.runner.postOperatorMessage(sessionId, "build me a reading tracker");
    await collectUntil(h.bus, (event) => event.type === "user_session.plan.proposed");
    const pending = h.interactions.listPending(sessionId);
    expect(pending).toHaveLength(1);
    // The card is a plan_approval with the spec marker.
    expect((pending[0] as { payload?: { spec?: { revision: number } } }).payload?.spec?.revision).toBe(1);
    h.interactions.resolveFromApi(sessionId, pending[0]!.id, {
      decision: "approve",
      editedDocument: "# Reading tracker (operator's cut)\n\nGoals: track books AND articles.",
    });
    await done;

    const approved = h.app.specs.latestApproved(sessionId);
    expect(approved?.status).toBe("approved");
    expect(approved?.origin).toBe("operator_edited");
    expect(approved?.document).toContain("operator's cut");
    // The digest that reaches every prompt carries the operator's words.
    expect(h.app.specs.digest(sessionId)).toContain("articles");
    // The tool result told main the text was edited and returned it verbatim.
    const toolResult = h.sqlite.prepare(
      "SELECT payload FROM events WHERE type = 'user_session.tool.completed'").all()
      .map((row) => JSON.stringify(row));
    expect(toolResult.join(" ")).toContain("operator's cut");
    const specEvents = h.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type = 'user_session.spec.updated'").get() as { n: number };
    expect(specEvents.n).toBe(1);
  });

  it("a rejected spec stays non-governing and the tool reports the operator's words", async () => {
    const h = makeHarness(async function* () {
      yield initMessage();
      yield toolUseMessage("spec-1", "mcp__console__propose_spec", { document: "# V1", changeNote: "initial" });
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    const done = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "go");
    await collectUntil(h.bus, (event) => event.type === "user_session.plan.proposed");
    const pending = h.interactions.listPending(sessionId);
    h.interactions.resolveFromApi(sessionId, pending[0]!.id, { decision: "reject", note: "too thin — name acceptance criteria" });
    await done;
    expect(h.app.specs.latestApproved(sessionId)).toBeUndefined();
    expect(h.app.specs.digest(sessionId)).toBe("");
  });
});

describe("orchestration state (fake SDK)", () => {
  it("update_orchestration_state persists section-replace revisions main reads back", async () => {
    const h = makeHarness(async function* () {
      yield initMessage();
      yield toolUseMessage("st-1", "mcp__console__update_orchestration_state", {
        trigger: "commission",
        strategy: "Three-session parallel survey, then a build",
        strategyWhy: "surveys are independent",
        uncertainties: ["whether the api layer is stateless"],
      });
      yield toolUseMessage("st-2", "mcp__console__update_orchestration_state", {
        trigger: "discovery",
        uncertainties: [],
        note: "api layer confirmed stateless — uncertainty resolved",
      });
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    const done = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "survey the repo");
    await done;

    const current = h.app.orchestrationState.current(sessionId);
    expect(current?.revision).toBe(2);
    // Section-replace: strategy persisted from rev 1; uncertainties replaced.
    expect(current?.strategy).toContain("parallel survey");
    expect(current?.uncertainties).toEqual([]);
    const digest = h.app.orchestrationState.digest(sessionId);
    expect(digest).toContain("parallel survey");
    const events = h.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type = 'user_session.state.updated'").get() as { n: number };
    expect(events.n).toBe(2);
  });

  it("record_completion lands in the run summary as the justification", async () => {
    const h = makeHarness(async function* () {
      yield initMessage();
      yield toolUseMessage("done-1", "mcp__console__record_completion", {
        criteria: [
          { criterion: "same seed reproduces the dungeon", met: true, evidence: [{ kind: "file", ref: "tools/verify.mjs" }] },
          { criterion: "playable in a browser", met: false, evidence: [] },
        ],
        knownGaps: ["browser validation never ran"],
        nonGoals: ["sound"],
      });
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    const done = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "wrap up");
    await done;

    const record = h.app.orchestrationState.latestCompletion(sessionId);
    expect(record?.completion.criteria).toHaveLength(2);
    expect(record?.completion.knownGaps).toEqual(["browser validation never ran"]);
  });
});

describe("commission rationale (fake SDK)", () => {
  it("why/expecting ride the briefing and reach the recipient's delivered prompt", async () => {
    let mainTurns = 0;
    const h = makeHarness(async function* (options) {
      const identity = agentRoleOf(options);
      yield initMessage();
      if (identity.agent === undefined && (mainTurns += 1) === 1) {
        yield toolUseMessage("create-1", "mcp__console__create_agent_session", {
          title: "survey",
          pattern: "hub_and_spoke",
          agents: [{ name: "scout", profileId: "explorer", owns: [] }],
          briefing: {
            core: { schemaVersion: 1, taskId: null, status: "pending", risk: "low", action: "Survey the repo",
              state: { summary: "greenfield", evidence: [] }, result: { summary: null, artifacts: [] },
              uncertainty: [], nextAction: "survey", requestExpandedContext: false },
            extension: { kind: "coordination", data: {} },
          },
          why: "The repo's shape is unknown and blocks planning",
          expecting: "A per-module inventory; anything surprising changes the plan",
        });
        yield successMessage();
      } else if (identity.agent === "coordinator") {
        yield sendHandoffUse("final-1", "main", { action: "surveyed", status: "completed", category: "final" });
        yield successMessage();
      } else {
        yield successMessage();
      }
    });
    const sessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 10_000);
    h.runner.postOperatorMessage(sessionId, "survey");
    await done;

    // Journaled with the act…
    const briefing = h.sqlite.prepare(
      "SELECT extension FROM handoff_records WHERE sender = 'main' AND trigger = 'assignment'").get() as { extension: string };
    expect(briefing.extension).toContain("blocks planning");
    expect(briefing.extension).toContain("per-module inventory");
    // …and read by the recipient as its success contract.
    const coordinatorPrompt = h.fake.captured.prompts.find((prompt) => prompt.includes("Survey the repo"));
    expect(coordinatorPrompt).toContain("Why: The repo's shape is unknown and blocks planning");
    expect(coordinatorPrompt).toContain("Expected evidence: A per-module inventory; anything surprising changes the plan");
  });
});
