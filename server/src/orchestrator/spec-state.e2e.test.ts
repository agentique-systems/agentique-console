/**
 * The governing requirements + orchestration state, end to end through the
 * real MCP handlers: propose_requirements parks on an approval card, the
 * operator's EDITED outline becomes the governing revision with ids minted;
 * update_orchestration_state / record_completion persist and surface;
 * why/expecting ride a commission's briefing into the recipient's delivered
 * prompt.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage, textMessage, toolUseMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeHarness } from "../test-helpers.ts";

const settled = (event: { type: string }): boolean => event.type === "user_session.turn.settled";

describe("governing requirements (fake SDK)", () => {
  it("propose_requirements parks on the card; the operator's edited outline governs with ids minted", async () => {
    const h = makeHarness(async function* () {
      yield initMessage();
      yield toolUseMessage("req-1", "mcp__console__propose_requirements", {
        document: "# Reading tracker\n\n## Context\nTrack books.\n\n## Requirements\n- Books can be added\n- Books can be listed",
        changeNote: "initial requirements",
      });
      yield textMessage("Requirements settled.");
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    const done = collectUntil(h.bus, settled);

    h.runner.postOperatorMessage(sessionId, "build me a reading tracker");
    await collectUntil(h.bus, (event) => event.type === "user_session.plan.proposed");
    const pending = h.interactions.listPending(sessionId);
    expect(pending).toHaveLength(1);
    // The card is a plan_approval with the requirements marker.
    expect((pending[0] as { payload?: { requirements?: { revision: number; nodeCount: number } } }).payload?.requirements)
      .toMatchObject({ revision: 1, nodeCount: 2 });
    h.interactions.resolveFromApi(sessionId, pending[0]!.id, {
      decision: "approve",
      editedDocument: "# Reading tracker\n\n## Requirements\n- Books can be added\n- Books AND articles can be listed",
    });
    await done;

    const approved = h.app.requirements.latestApproved(sessionId);
    expect(approved?.status).toBe("approved");
    expect(approved?.origin).toBe("operator_edited");
    // The canonical document stores the operator's words WITH minted ids.
    expect(approved?.document).toContain("- r1: Books can be added");
    expect(approved?.document).toContain("- r2: Books AND articles can be listed");
    // The revision names the interaction that approved it.
    expect(approved?.interactionId).toBe(pending[0]!.id);
    // The digest that reaches every prompt carries the operator's words.
    expect(h.app.requirements.digest(sessionId)).toContain("articles");
    // The tool result told main the text was edited and returned the canonical form.
    const toolResult = h.sqlite.prepare(
      "SELECT payload FROM events WHERE type = 'user_session.tool.completed'").all()
      .map((row) => JSON.stringify(row));
    expect(toolResult.join(" ")).toContain("operator EDITED the requirements");
    const updated = h.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type = 'user_session.requirements.updated'").get() as { n: number };
    expect(updated.n).toBe(1);
  });

  it("an amendment's tool result lists sessions still running against the old revision", async () => {
    let mainTurns = 0;
    const h = makeHarness(async function* (options) {
      const identity = agentRoleOf(options);
      yield initMessage();
      if (identity.agent === undefined && (mainTurns += 1) === 1) {
        yield toolUseMessage("create-1", "mcp__console__create_agent_session", {
          title: "long build", pattern: "hub_and_spoke",
          agents: [{ name: "scout", profileId: "explorer", owns: [] }],
          briefing: {
            core: { schemaVersion: 1, taskId: null, status: "pending", risk: "low", action: "Build it",
              state: { summary: "start", evidence: [] }, result: { summary: null, artifacts: [] },
              uncertainty: [], nextAction: "build", requestExpandedContext: false },
            extension: { kind: "coordination", data: {} },
          },
        });
        yield toolUseMessage("req-1", "mcp__console__propose_requirements", {
          document: "## Requirements\n- It builds", changeNote: "initial" });
        yield toolUseMessage("req-2", "mcp__console__propose_requirements", {
          document: "## Requirements\n- r1: It builds\n- It renders without three.js", changeNote: "drop three.js" });
        yield successMessage();
      } else {
        yield successMessage();
      }
    });
    const sessionId = h.addUserSession();
    const done = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "build");
    for (let card = 1; card <= 2; card += 1) {
      await collectUntil(h.bus, (event) => event.type === "user_session.plan.proposed"
        && (event.payload as { requirements?: { revision?: number } }).requirements?.revision === card);
      const pending = h.interactions.listPending(sessionId);
      h.interactions.resolveFromApi(sessionId, pending[0]!.id, { decision: "approve" });
    }
    await done;

    const results = h.sqlite.prepare(
      "SELECT payload FROM events WHERE type = 'user_session.tool.completed'").all()
      .map((row) => String((row as { payload: string }).payload));
    const amendment = results.find((payload) => payload.includes("runningSessions"));
    expect(amendment).toBeDefined();
    expect(amendment).toContain("long build");
    expect(amendment).toContain("briefed under an earlier revision");
    // The initial approval carries no such list — there was nothing running
    // against an older revision.
    const initial = results.find((payload) => payload.includes("Approved as proposed") && !payload.includes("runningSessions"));
    expect(initial).toBeDefined();
    // The amendment kept r1 and minted r2 for the new line.
    expect(h.app.requirements.derive(sessionId).map((node) => node.id)).toEqual(["r1", "r2"]);
  });

  it("a rejected proposal stays non-governing and a malformed outline fails with line errors", async () => {
    const h = makeHarness(async function* () {
      yield initMessage();
      yield toolUseMessage("bad-1", "mcp__console__propose_requirements", {
        document: "just prose, no outline", changeNote: "oops" });
      yield toolUseMessage("req-1", "mcp__console__propose_requirements", {
        document: "## Requirements\n- It works", changeNote: "initial" });
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    const done = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "go");
    await collectUntil(h.bus, (event) => event.type === "user_session.plan.proposed");
    const pending = h.interactions.listPending(sessionId);
    h.interactions.resolveFromApi(sessionId, pending[0]!.id, { decision: "reject", note: "too thin — name acceptance criteria" });
    await done;
    expect(h.app.requirements.latestApproved(sessionId)).toBeUndefined();
    expect(h.app.requirements.digest(sessionId)).toBe("");
    // The malformed proposal never reached a card — its tool result carries
    // the parse errors for main to fix.
    const results = h.sqlite.prepare(
      "SELECT payload FROM events WHERE type = 'user_session.tool.completed'").all()
      .map((row) => String((row as { payload: string }).payload));
    expect(results.find((payload) => payload.includes("not a valid requirement outline"))).toBeDefined();
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
        incorporating: ["ho_survey_final"],
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
    const events = h.sqlite.prepare(
      "SELECT payload FROM events WHERE type = 'user_session.state.updated' ORDER BY seq").all() as { payload: string }[];
    expect(events).toHaveLength(2);
    // Evidence attribution rides the journal, exactly when passed.
    expect(JSON.parse(events[0]!.payload).incorporating).toBeUndefined();
    expect(JSON.parse(events[1]!.payload).incorporating).toEqual(["ho_survey_final"]);
    // The rev-2 tool RESULT returns the MERGED document — the writer sees
    // what its next generation will read, including rev-1's strategy.
    const results = h.sqlite.prepare(
      "SELECT payload FROM events WHERE type = 'user_session.tool.completed'").all()
      .map((row) => String((row as { payload: string }).payload));
    const merged = results.filter((payload) => payload.includes("full merged state")).at(-1);
    expect(merged).toBeDefined();
    // The second call passed no strategy, yet its result carries rev-1's.
    expect(merged).toContain("parallel survey");
    expect(merged).toContain("uncertainty resolved");
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

describe("main's requirement-linked ask_operator (fake SDK)", () => {
  it("records the answer as a decision pinned to the named requirements; unknown ids are refused", async () => {
    const h = makeHarness(async function* () {
      yield initMessage();
      yield toolUseMessage("req-1", "mcp__console__propose_requirements", {
        document: "## Requirements\n- Combat feels responsive\n- The world persists between sessions",
        changeNote: "initial",
      });
      // Unknown id: refused before any card renders.
      yield toolUseMessage("ask-bad", "mcp__console__ask_operator", {
        question: "Persist to SQLite or Postgres?", options: [{ label: "SQLite" }, { label: "Postgres" }],
        requirementIds: ["r99"], urgency: "deferred",
      });
      // Live id: the card carries it; deferred returns immediately.
      yield toolUseMessage("ask-1", "mcp__console__ask_operator", {
        question: "Real-time or turn-based combat?", options: [{ label: "Real-time" }, { label: "Turn-based" }],
        recommendation: "Real-time — the statement implies responsiveness.",
        requirementIds: ["r1"], urgency: "deferred",
      });
      yield textMessage("Asked.");
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    const done = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "build me a small MMO");
    await collectUntil(h.bus, (event) => event.type === "user_session.plan.proposed");
    const card = h.interactions.listPending(sessionId)[0]!;
    h.interactions.resolveFromApi(sessionId, card.id, { decision: "approve" });
    await done;

    const toolEvents = h.sqlite.prepare("SELECT payload FROM events WHERE type = 'user_session.tool.completed'").all()
      .map((row) => JSON.stringify(row)).join(" ");
    expect(toolEvents).toContain("unknown requirement id");

    const ask = h.interactions.listPending(sessionId).find((row) => row.kind === "question")!;
    expect((ask.payload as { requirementIds?: string[] }).requirementIds).toEqual(["r1"]);
    h.interactions.resolveFromApi(sessionId, ask.id, { answers: { "Real-time or turn-based combat?": ["Real-time"] } });

    const decision = h.decisions.list(sessionId).find((d) => d.question.includes("combat"))!;
    expect(decision.requirementIds).toEqual(["r1"]);
    // Pinned into main's digest while r1 is open: the ledger renders it first
    // even though the requirements approval resolved LATER than nothing else.
    expect(h.decisions.digest(sessionId, { pinned: (ids) => ids.includes("r1") })).toMatch(/^- Real-time or turn-based combat\?/);
  });
});

describe("scoped proposals through the card (fake SDK)", () => {
  it("a subtree amendment card carries scope + change summary; approval leaves the outside untouched", async () => {
    const h = makeHarness(async function* () {
      yield initMessage();
      yield toolUseMessage("req-1", "mcp__console__propose_requirements", {
        document: "## Requirements\n- Combat works\n  - Hits register\n- The world persists",
        changeNote: "initial epics",
      });
      yield toolUseMessage("rep-1", "mcp__console__report_requirement", {
        requirementId: "r3", status: "satisfied",
        evidence: [{ kind: "command", ref: "npm test" }], verifiedBy: "independent",
      });
      yield toolUseMessage("req-2", "mcp__console__propose_requirements", {
        document: "## Requirements\n- r2: Hits register within one frame\n- Misses are telegraphed",
        changeNote: "combat elaborated at commissioning",
        scopeId: "r1",
      });
      yield textMessage("Elaborated.");
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    const done = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "build me a small game");
    // First card: the coarse full proposal.
    await collectUntil(h.bus, (event) => event.type === "user_session.plan.proposed");
    const first = h.interactions.listPending(sessionId)[0]!;
    h.interactions.resolveFromApi(sessionId, first.id, { decision: "approve" });
    // Second card: the SCOPED amendment, with scope context and a summary.
    await collectUntil(h.bus, (event) => event.type === "user_session.plan.proposed"
      && (event.payload as { requirements?: { kind?: string } }).requirements?.kind === "subtree");
    const card = h.interactions.listPending(sessionId).find((row) => row.kind === "plan_approval")!;
    const marker = (card.payload as { requirements: { kind: string; scope: { scopeId: string; statement: string }; summary: { added: string[]; changed: { id: string }[]; retired: { id: string }[] } } }).requirements;
    expect(marker.kind).toBe("subtree");
    expect(marker.scope).toMatchObject({ scopeId: "r1", statement: "Combat works" });
    expect(marker.summary.added).toEqual(["Misses are telegraphed"]);
    expect(marker.summary.changed.map((entry) => entry.id)).toEqual(["r2"]);
    h.interactions.resolveFromApi(sessionId, card.id, { decision: "approve" });
    await done;

    const nodes = h.app.requirements.derive(sessionId);
    expect(nodes.find((node) => node.id === "r2")?.statement).toBe("Hits register within one frame");
    expect(nodes.find((node) => node.id === "r4")).toMatchObject({ parentId: "r1", statement: "Misses are telegraphed" });
    // Outside the scope: r3's satisfied claim survives the amendment.
    expect(nodes.find((node) => node.id === "r3")?.status).toBe("satisfied");
    expect(h.app.requirements.governingRevision(sessionId)).toBe(2);
  });
});
