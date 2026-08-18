/**
 * Wave-1 pattern flows over the contract runtime: pipeline (choreographed
 * stages, strict route table, last stage reports final) and
 * evaluator_optimizer (generate → judge cycles with a round cap). Programs
 * discriminate by CONSOLE_PATTERN_ROLE — the env discriminator — never by
 * prompt text.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage, textMessage, toolUseMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness, agentRoleOf } from "../test-helpers.ts";

const briefing = (action: string) => ({
  core: { schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false },
  extension: { kind: "generic" as const, data: {} },
});

describe("pipeline e2e (fake SDK)", () => {
  it("stages hand forward in order and the last stage's final reports the session", async () => {
    const h = makeDelegationHarness(async function* (options) {
      const role = agentRoleOf(options).role;
      yield initMessage();
      if (role === "stage.1") yield sendHandoffUse("s1", "edit", { action: "drafted", stateSummary: "the draft", status: "completed", category: "milestone" });
      if (role === "stage.2") yield sendHandoffUse("s2", "polish", { action: "edited", stateSummary: "the edited draft", status: "completed", category: "milestone" });
      if (role === "stage.3") yield sendHandoffUse("s3", "main", { action: "polished", stateSummary: "the finished piece", status: "completed", category: "final" });
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 15_000);
    const created = h.host.createSession({ userSessionId, title: "essay", pattern: "pipeline",
      agents: [{ name: "draft", profileId: "explorer" }, { name: "edit", profileId: "explorer" }, { name: "polish", profileId: "explorer" }],
      briefing: briefing("write the essay") });
    expect(created.entryAgent).toBe("draft");
    const events = await done;
    const rows = h.repo.listMessages("agent", created.agentSessionId).filter((row) => row.kind === "message");
    expect(rows.map((row) => `${row.speakerName}→${row.toName}`)).toEqual([
      "main→draft", "draft→edit", "edit→polish", "polish→main",
    ]);
    expect(events.filter((event) => event.type === "agent_session.result.returned")).toHaveLength(1);
    expect(h.repo.listAgents(created.agentSessionId).map((p) => ({ seat: p.name, role: p.role }))).toEqual([
      { seat: "draft", role: "stage.1" }, { seat: "edit", role: "stage.2" }, { seat: "polish", role: "stage.3" }]);
    const row = h.repo.getAgentSession(created.agentSessionId);
    expect(row && h.host.statusOf(row)).toBe("reported");
  });

  it("denies a stage skipping ahead, with the pipeline's own route summary", async () => {
    const h = makeDelegationHarness(async function* (options) {
      const role = agentRoleOf(options).role;
      yield initMessage();
      // Stage 1 tries to bypass stage 2 entirely.
      if (role === "stage.1") yield sendHandoffUse("bad", "polish", { action: "skip ahead", status: "completed", category: "milestone" });
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const denied = collectUntil(h.bus, (event) =>
      event.type === "agent_session.tool.completed" && JSON.stringify(event.payload).includes("not allowed"), 15_000);
    h.host.createSession({ userSessionId, title: "skip", pattern: "pipeline",
      agents: [{ name: "draft", profileId: "explorer" }, { name: "edit", profileId: "explorer" }, { name: "polish", profileId: "explorer" }],
      briefing: briefing("go") });
    const events = await denied;
    expect(JSON.stringify(events.at(-1)?.payload)).toContain("main → draft → edit → polish → main");
  });
});

describe("evaluator_optimizer e2e (fake SDK)", () => {
  it("cycles critique→revision, counts rounds, and the evaluator's final reports the session", async () => {
    let generatorTurns = 0;
    let evaluatorTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const role = agentRoleOf(options).role;
      yield initMessage();
      if (role === "generator") {
        generatorTurns += 1;
        yield sendHandoffUse(`gen-${generatorTurns}`, "critic", { action: generatorTurns === 1 ? "first draft" : "revised draft",
          stateSummary: generatorTurns === 1 ? "draft v1" : "draft v2 addressing the critique", status: "in_progress", category: "update" });
      } else if (role === "evaluator") {
        evaluatorTurns += 1;
        yield evaluatorTurns === 1
          ? sendHandoffUse("crit-1", "writer", { action: "critique", stateSummary: "the intro buries the finding", status: "blocked", category: "decision" })
          : sendHandoffUse("accept", "main", { action: "accepted", stateSummary: "draft v2 meets the rubric", status: "completed", category: "final" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 15_000);
    const created = h.host.createSession({ userSessionId, title: "loop", pattern: "evaluator_optimizer",
      agents: [{ name: "writer", profileId: "explorer", model: "model-a" }, { name: "critic", profileId: "explorer", model: "model-b" }],
      patternConfig: { rubric: "lead with the finding" },
      briefing: briefing("write it") });
    await done;
    const rows = h.repo.listMessages("agent", created.agentSessionId).filter((row) => row.kind === "message");
    expect(rows.map((row) => `${row.speakerName}→${row.toName}`)).toEqual([
      "main→writer", "writer→critic", "critic→writer", "writer→critic", "critic→main",
    ]);
    expect(h.repo.getPatternState(created.agentSessionId)?.rounds).toBe(1);
    const row = h.repo.getAgentSession(created.agentSessionId);
    expect(row && h.host.statusOf(row)).toBe("reported");
  });

  it("trips max_rounds when the critique cycle hits the cap", async () => {
    let generatorTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const role = agentRoleOf(options).role;
      yield initMessage();
      if (role === "generator") {
        generatorTurns += 1;
        if (generatorTurns === 1) yield sendHandoffUse("gen-1", "critic", { action: "draft", status: "in_progress", category: "update" });
      } else if (role === "evaluator") {
        // An evaluator that only ever rejects: the round cap is the bound.
        yield sendHandoffUse(`crit-${Date.now() % 100000}`, "writer", { action: "not good enough", status: "blocked", category: "decision" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const tripped = collectUntil(h.bus, (event) => event.type === "agent_session.termination.tripped", 15_000);
    const created = h.host.createSession({ userSessionId, title: "cap", pattern: "evaluator_optimizer",
      agents: [{ name: "writer", profileId: "explorer", model: "model-a" }, { name: "critic", profileId: "explorer", model: "model-b" }],
      patternConfig: { maxRounds: 1 },
      briefing: briefing("write it") });
    const events = await tripped;
    expect(events.at(-1)?.payload).toMatchObject({ agentSessionId: created.agentSessionId, pattern: "evaluator_optimizer", rule: "max_rounds" });
  });

  it("refuses a same-model loop unless explicitly allowed", () => {
    const h = makeDelegationHarness(async function* () { yield initMessage(); yield successMessage(); });
    const userSessionId = h.addUserSession();
    const agents = [{ name: "writer", profileId: "explorer", model: "same" }, { name: "critic", profileId: "explorer", model: "same" }];
    expect(() => h.host.createSession({ userSessionId, title: "collusion", pattern: "evaluator_optimizer", agents, briefing: briefing("go") })).toThrow(/collude/);
    const created = h.host.createSession({ userSessionId, title: "allowed", pattern: "evaluator_optimizer", agents, patternConfig: { requireDistinctModels: false }, briefing: briefing("go") });
    expect(created.entryAgent).toBe("writer");
  });
});

describe("map_reduce e2e (fake SDK)", () => {
  it("holds every mapper report until the join is met, then flushes them in one turn", async () => {
    let reducerTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const identity = agentRoleOf(options);
      yield initMessage();
      if (identity.role === "reducer") {
        reducerTurns += 1;
        if (reducerTurns === 1) {
          yield toolUseMessage("fan", "mcp__console_agent__dispatch_work_items", {
            items: [{ assignment: "count the pelicans" }, { assignment: "count the herons" }] });
        } else {
          yield sendHandoffUse("reduce", "main", { action: "census done", stateSummary: "3 pelicans, 2 herons", status: "completed", category: "final" });
        }
      } else if (identity.role === "mapper") {
        yield sendHandoffUse(`item-${identity.agent}`, "collect", { action: "item done",
          stateSummary: identity.agent === "map.1.1" ? "3 pelicans" : "2 herons", status: "completed", category: "milestone" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 15_000);
    const created = h.host.createSession({ userSessionId, title: "census", pattern: "map_reduce",
      agents: [{ name: "collect", profileId: "explorer" }], briefing: briefing("count the birds") });
    const events = await done;
    const join = events.find((event) => event.type === "agent_session.join.completed");
    expect(join?.payload).toMatchObject({ agentSessionId: created.agentSessionId, of: 2, failed: 0 });
    const rows = h.repo.listMessages("agent", created.agentSessionId).filter((row) => row.kind === "message");
    expect(rows.map((row) => `${row.speakerName}→${row.toName}`)).toEqual([
      "main→collect", "collect→map.1.1", "collect→map.1.2", "map.1.1→collect", "map.1.2→collect", "collect→main",
    ]);
    // Exactly two reducer turns: the dispatch, then ONE flush carrying both reports.
    expect(reducerTurns).toBe(2);
    const row = h.repo.getAgentSession(created.agentSessionId);
    expect(row && h.host.statusOf(row)).toBe("reported");
  });
});

describe("debate e2e (fake SDK)", () => {
  it("broadcasts the briefing, joins all positions, and the judge's final reports", async () => {
    const h = makeDelegationHarness(async function* (options) {
      const identity = agentRoleOf(options);
      yield initMessage();
      if (identity.role === "debater") {
        yield sendHandoffUse(`pos-${identity.agent}`, "judge", { action: "position",
          stateSummary: identity.agent === "optimist" ? "ship it" : "hold it", status: "completed", category: "milestone" });
      } else if (identity.role === "judge") {
        yield sendHandoffUse("verdict", "main", { action: "verdict", stateSummary: "hold it — the risk case is concrete", status: "completed", category: "final" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 15_000);
    const created = h.host.createSession({ userSessionId, title: "ship or hold", pattern: "debate",
      agents: [{ name: "optimist", profileId: "explorer" }, { name: "pessimist", profileId: "explorer" }],
      briefing: briefing("should we ship?") });
    const events = await done;
    const join = events.find((event) => event.type === "agent_session.join.completed");
    expect(join?.payload).toMatchObject({ of: 2, failed: 0 });
    const rows = h.repo.listMessages("agent", created.agentSessionId).filter((row) => row.kind === "message");
    // The briefing broadcast to BOTH debaters; the judge speaks last.
    expect(rows.slice(0, 2).map((row) => `${row.speakerName}→${row.toName}`)).toEqual(["main→optimist", "main→pessimist"]);
    expect(rows.at(-1)?.speakerName).toBe("judge");
    expect(rows.at(-1)?.toName).toBe("main");
    const row = h.repo.getAgentSession(created.agentSessionId);
    expect(row && h.host.statusOf(row)).toBe("reported");
  });

  it("carries a debater's plain-text position to the judge when it never sends", async () => {
    // Live run 3's failure shape: both debaters argued in plain final text —
    // expecting a rebuttal round the topology does not have — and ended their
    // turns without send_handoff. The positions join never armed and the judge
    // never ran. The Console now carries the settled turn's text as the report.
    const h = makeDelegationHarness(async function* (options) {
      const identity = agentRoleOf(options);
      yield initMessage();
      if (identity.role === "debater") {
        yield textMessage(identity.agent === "optimist"
          ? "Opening case: ship it. I'll rebut once I see the other proposal."
          : "Opening case: hold it. Awaiting rebuttal.");
      } else if (identity.role === "judge") {
        yield sendHandoffUse("verdict", "main", { action: "verdict",
          stateSummary: "ship it — the hold case is thinner", status: "completed", category: "final" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 15_000);
    const created = h.host.createSession({ userSessionId, title: "ship or hold", pattern: "debate",
      agents: [{ name: "optimist", profileId: "explorer" }, { name: "pessimist", profileId: "explorer" }],
      briefing: briefing("should we ship?") });
    const events = await done;
    const join = events.find((event) => event.type === "agent_session.join.completed");
    expect(join?.payload).toMatchObject({ of: 2, failed: 0 });
    const rows = h.repo.listMessages("agent", created.agentSessionId).filter((row) => row.kind === "message");
    const carried = rows.filter((row) => row.toName === "judge");
    expect(carried.map((row) => row.speakerName).sort()).toEqual(["optimist", "pessimist"]);
    expect(carried.map((row) => row.text).join("\n")).toContain("Opening case: ship it.");
    expect(rows.at(-1)?.speakerName).toBe("judge");
    expect(rows.at(-1)?.toName).toBe("main");
    const row = h.repo.getAgentSession(created.agentSessionId);
    expect(row && h.host.statusOf(row)).toBe("reported");
  });
});

describe("silent-agent carry e2e (fake SDK)", () => {
  it("carries a hub specialist's plain-text findings to its coordinator", async () => {
    // The specialist does the work, types the findings as plain text, never
    // calls send_handoff, and goes idle. The Console carries that text to the
    // coordinator as its report.
    let coordinatorTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const identity = agentRoleOf(options);
      yield initMessage();
      if (identity.role === "coordinator") {
        coordinatorTurns += 1;
        yield coordinatorTurns === 1
          ? sendHandoffUse("assign", "scout", { action: "map the codebase", status: "pending", category: "assignment" })
          : sendHandoffUse("wrap", "main", { action: "done", stateSummary: "scout's findings relayed", status: "completed", category: "final" });
      } else if (identity.role === "specialist") {
        yield textMessage("Findings: the entry point is src/main.ts; three load-bearing seams.");
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 15_000);
    const created = h.host.createSession({ userSessionId, title: "silent scout",
      agents: [{ name: "scout", profileId: "explorer" }], briefing: briefing("map it") });
    await done;
    const rows = h.repo.listMessages("agent", created.agentSessionId).filter((row) => row.kind === "message");
    const carried = rows.find((row) => row.speakerName === "scout" && row.toName === "coordinator");
    expect(carried?.text).toContain("Findings: the entry point is src/main.ts");
    const row = h.repo.getAgentSession(created.agentSessionId);
    expect(row && h.host.statusOf(row)).toBe("reported");
  });
});

describe("peer_to_peer e2e (fake SDK)", () => {
  it("trips oscillation on sustained ping-pong between two peers", async () => {
    const sends = new Map<string, number>();
    const h = makeDelegationHarness(async function* (options) {
      const identity = agentRoleOf(options);
      const seat = identity.agent ?? "?";
      yield initMessage();
      const sent = sends.get(seat) ?? 0;
      if (identity.role === "closer" && sent === 0) {
        sends.set(seat, 1);
        yield sendHandoffUse("kick", "alice", { action: "start", status: "pending", category: "assignment" });
      } else if (identity.role === "peer" && sent < 4) {
        sends.set(seat, sent + 1);
        const other = seat === "alice" ? "bob" : "alice";
        yield sendHandoffUse(`${seat}-${sent + 1}`, other, { action: "your turn", status: "in_progress", category: "update" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const tripped = collectUntil(h.bus, (event) => event.type === "agent_session.termination.tripped", 15_000);
    const created = h.host.createSession({ userSessionId, title: "mesh", pattern: "peer_to_peer",
      agents: [{ name: "lead", profileId: "explorer" }, { name: "alice", profileId: "explorer" }, { name: "bob", profileId: "explorer" }],
      briefing: briefing("figure it out together") });
    const events = await tripped;
    expect(events.at(-1)?.payload).toMatchObject({ agentSessionId: created.agentSessionId, pattern: "peer_to_peer", rule: "oscillation" });
  });
});

describe("plan_execute e2e (fake SDK)", () => {
  it("planner assigns, executor reports, planner finals", async () => {
    let plannerTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const identity = agentRoleOf(options);
      yield initMessage();
      if (identity.role === "planner") {
        plannerTurns += 1;
        yield plannerTurns === 1
          ? sendHandoffUse("assign", "builder", { action: "build the widget", status: "pending", category: "assignment" })
          : sendHandoffUse("wrap", "main", { action: "plan complete", stateSummary: "widget built and verified", status: "completed", category: "final" });
      } else if (identity.role === "executor") {
        yield sendHandoffUse("built", "architect", { action: "widget built", status: "completed", category: "milestone" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 15_000);
    const created = h.host.createSession({ userSessionId, title: "widget", pattern: "plan_execute",
      agents: [{ name: "architect", profileId: "explorer" }, { name: "builder", profileId: "explorer" }],
      briefing: briefing("build the widget") });
    await done;
    const rows = h.repo.listMessages("agent", created.agentSessionId).filter((row) => row.kind === "message");
    expect(rows.map((row) => `${row.speakerName}→${row.toName}`)).toEqual([
      "main→architect", "architect→builder", "builder→architect", "architect→main",
    ]);
    const row = h.repo.getAgentSession(created.agentSessionId);
    expect(row && h.host.statusOf(row)).toBe("reported");
  });
});
