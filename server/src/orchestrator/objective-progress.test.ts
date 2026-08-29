import { describe, expect, it } from "vitest";
import type { ObjectiveAssessment } from "@agentique-console/shared";
import { projects } from "../db/schema.ts";
import { initMessage, successMessage, toolUseMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeHarness } from "../test-helpers.ts";

const BROAD_OBJECTIVE = "Build Straf3 into a defining competitive movement game with maps, replays, creation, learning, and community systems.";
const MOVEMENT_MILESTONE = `# Straf3 movement freeze

## Context
Freeze canonical movement and collect evidence.

## Requirements
- Canonical movement is deterministic
- Browser movement evidence is captured
`;

function program() {
  return async function* () {
    yield initMessage();
    yield successMessage();
  };
}

function assessment(overrides: Partial<Omit<ObjectiveAssessment, "objectiveDigest" | "assessedAtSeq">> = {}): Omit<ObjectiveAssessment, "objectiveDigest" | "assessedAtSeq"> {
  return {
    currentState: "Canonical movement is frozen and browser execution is proven.",
    progress: ["A justified default physics profile now exists."],
    remainingGaps: [{ description: "The first-party map portfolio is not built.", executability: "executable", refs: ["r-map"] }],
    changedSincePrevious: "The movement milestone landed with deterministic evidence.",
    nextAction: "Define and approve the first-party map portfolio milestone.",
    decision: "continue",
    stopReason: null,
    rationale: "The broad product objective remains materially incomplete and valuable executable work exists.",
    stopEvidence: [],
    valueCostRationale: null,
    ...overrides,
  };
}

describe("governing objective persistence", () => {
  it("captures the first operator request and requirement revisions never replace it", async () => {
    const h = makeHarness(program());
    const settled = collectUntil(h.bus, (event) => event.type === "user_session.turn.settled");
    const session = h.app.userSessions.create({ workspaceId: h.workspaceId, mode: "execute", message: BROAD_OBJECTIVE });
    await settled;

    expect(h.app.objective.document(session.id)).toBe(BROAD_OBJECTIVE);
    const first = h.app.requirements.propose(session.id, MOVEMENT_MILESTONE, "movement first");
    h.app.requirements.approve(first.id, { document: MOVEMENT_MILESTONE, edited: false });
    expect(h.app.requirements.intentDocument(session.id)).toContain("movement freeze");
    expect(h.app.objective.document(session.id)).toBe(BROAD_OBJECTIVE);

    const replacement = `# Movement aftermath\n\n## Requirements\n- Client selection is exposed\n- Documentation is truthful\n`;
    const second = h.app.requirements.propose(session.id, replacement, "replace current milestone");
    h.app.requirements.approve(second.id, { document: replacement, edited: false });
    const subtree = `## Requirements\n- Client selection includes a named option\n`;
    const third = h.app.requirements.propose(session.id, subtree, "scope detail", { scopeId: "r3" });
    h.app.requirements.approve(third.id, { document: subtree, edited: false });
    expect(h.app.objective.document(session.id)).toBe(BROAD_OBJECTIVE);
  });

  it("survives sequential continuation and fresh main cognition without provider transcript history", async () => {
    const h = makeHarness(program());
    let settled = collectUntil(h.bus, (event) => event.type === "user_session.turn.settled");
    const first = h.app.userSessions.create({ workspaceId: h.workspaceId, mode: "execute", message: BROAD_OBJECTIVE });
    await settled;
    h.app.userSessions.patch(first.id, { lifecycle: "archived" });
    settled = collectUntil(h.bus, (event) => event.type === "user_session.turn.settled" && event.userSessionId !== first.id);
    const next = h.app.userSessions.create({ workspaceId: h.workspaceId, projectId: first.projectId, mode: "execute", message: "Continue with the next valuable milestone." });
    await settled;

    expect(h.app.objective.document(next.id)).toBe(BROAD_OBJECTIVE);
    const prompt = h.fake.captured.options.at(-1)?.systemPrompt;
    const append = typeof prompt === "object" && !Array.isArray(prompt) ? prompt.append ?? "" : "";
    expect(append).toContain(BROAD_OBJECTIVE);
    expect(append).toContain("Governing objective");
  });

  it("gives delegated seats bounded orientation without widening their authority", async () => {
    const h = makeHarness(async function* (options) {
      const identity = agentRoleOf(options);
      yield initMessage();
      if (identity.agent === undefined) {
        yield toolUseMessage("create-1", "mcp__console__create_agent_session", {
          title: "movement evidence", pattern: "hub_and_spoke",
          agents: [{ name: "scout", profileId: "explorer", owns: [] }],
          briefing: {
            core: { schemaVersion: 1, taskId: null, status: "pending", risk: "low", action: "Inspect movement evidence",
              state: { summary: "bounded movement task", evidence: [] }, result: { summary: null, artifacts: [] },
              uncertainty: [], nextAction: "inspect", requestExpandedContext: false },
            extension: { kind: "coordination", data: {} },
          },
        });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    h.db.update(projects).set({ objectiveDocument: BROAD_OBJECTIVE }).run();
    const created = collectUntil(h.bus, (event) => event.type === "agent_session.turn.started"
      && event.payload.agent === "coordinator");
    h.runner.postOperatorMessage(userSessionId, "Commission the movement evidence task.");
    await created;

    const seatOptions = h.fake.captured.options.find((options) => agentRoleOf(options).agent === "coordinator");
    const prompt = seatOptions?.systemPrompt;
    const append = typeof prompt === "object" && !Array.isArray(prompt) ? prompt.append ?? "" : "";
    expect(append).toContain("Project objective (orientation only");
    expect(append).toContain("does not widen your authorization");
    expect(Buffer.byteLength(append, "utf8")).toBeLessThan(20_000);
  });
});

describe("objective assessment semantics", () => {
  function harness() {
    const h = makeHarness(program());
    const userSessionId = h.addUserSession();
    const projectId = h.repo.getUserSession(userSessionId)!.projectId;
    h.db.update(projects).set({ objectiveDocument: BROAD_OBJECTIVE }).run();
    return { h, userSessionId, projectId };
  }

  it("requires a real continue frontier and a concrete next action", () => {
    const { h, userSessionId } = harness();
    expect(() => h.app.orchestrationState.assessObjective(userSessionId,
      assessment({ remainingGaps: [] }))).toThrow(/remaining gap/);
    expect(() => h.app.orchestrationState.assessObjective(userSessionId,
      assessment({ nextAction: null }))).toThrow(/concrete next action/);
  });

  it("persists a valid Straf3-shaped continue assessment with objective digest and material watermark", () => {
    const { h, userSessionId } = harness();
    h.bus.append({ type: "operator.decision.recorded", userSessionId, payload: {
      userSessionId, decisionId: "dec_movement", askedBy: "main", source: "plan_approval",
      question: "Approve movement milestone?", answer: "Approved",
    } });
    const result = h.app.orchestrationState.assessObjective(userSessionId, assessment());
    expect(result.assessment).toMatchObject({ decision: "continue", assessedAtSeq: expect.any(Number) });
    expect(result.assessment.objectiveDigest).toHaveLength(64);
    expect(result.assessment.assessedAtSeq).toBeGreaterThan(0);
    expect(h.app.objective.document(userSessionId)).toBe(BROAD_OBJECTIVE);
    expect(h.app.orchestrationState.latestObjectiveAssessment(userSessionId)?.assessment.nextAction).toContain("map portfolio");
  });

  it("deduplicates retry-identical assessments at one watermark", () => {
    const { h, userSessionId } = harness();
    const first = h.app.orchestrationState.assessObjective(userSessionId, assessment());
    const retry = h.app.orchestrationState.assessObjective(userSessionId, assessment());

    expect(first.inserted).toBe(true);
    expect(retry).toMatchObject({ inserted: false, row: { id: first.row.id } });
    expect(h.app.orchestrationState.history(userSessionId).filter((row) => row.trigger === "objective_assessment")).toHaveLength(1);
  });

  it("exposes the dedicated main tool and returns Console-derived frontier facts", async () => {
    const h = makeHarness(async function* () {
      yield initMessage();
      yield toolUseMessage("assess-1", "mcp__console__assess_objective_progress", {
        currentState: "Movement is frozen.",
        progress: ["Canonical physics landed."],
        remainingGaps: [{ description: "Maps remain.", executability: "executable", refs: [] }],
        changedSincePrevious: "Movement evidence landed.",
        nextAction: "Specify the map milestone.",
        decision: "continue",
        rationale: "The broad game objective remains incomplete.",
        stopEvidence: [],
      });
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    h.db.update(projects).set({ objectiveDocument: BROAD_OBJECTIVE }).run();
    const settled = collectUntil(h.bus, (event) => event.type === "user_session.turn.settled");
    h.runner.postOperatorMessage(userSessionId, "Assess after the movement result.");
    await settled;

    expect(h.app.orchestrationState.latestObjectiveAssessment(userSessionId)?.assessment.decision).toBe("continue");
    const resultRows = h.sqlite.prepare("SELECT payload FROM events WHERE type='user_session.tool.completed'").all() as { payload: string }[];
    expect(resultRows.map((row) => row.payload).join("\n")).toContain("requirements");
    expect(resultRows.map((row) => row.payload).join("\n")).toContain("completionExceptions");
  });

  it("ignores noise for staleness and detects later material progress", () => {
    const { h, userSessionId } = harness();
    const first = h.app.orchestrationState.assessObjective(userSessionId, assessment());
    h.bus.append({ type: "user_session.runtime.noted", userSessionId,
      payload: { userSessionId, detail: "provider retry telemetry" } });
    expect(h.app.orchestrationState.latestObjectiveAssessment(userSessionId)?.stale).toBe(false);
    h.bus.append({ type: "operator.decision.recorded", userSessionId, payload: {
      userSessionId, decisionId: "dec_next", askedBy: "main", source: "interaction",
      question: "Which map style?", answer: "Competitive arenas",
    } });
    expect(h.app.orchestrationState.latestObjectiveAssessment(userSessionId)?.stale).toBe(true);
    const next = h.app.orchestrationState.assessObjective(userSessionId, assessment({
      changedSincePrevious: "The operator selected competitive arenas as the next map direction.",
      nextAction: "Specify competitive arena requirements and evidence.",
    }));
    expect(next.assessment.assessedAtSeq).toBeGreaterThan(first.assessment.assessedAtSeq);
    expect(h.app.orchestrationState.latestObjectiveAssessment(userSessionId)?.stale).toBe(false);
  });

  it("references the latest objective assessment in continuation and exposes it to a successor session", () => {
    const { h, userSessionId, projectId } = harness();
    const recorded = h.app.orchestrationState.assessObjective(userSessionId, assessment());
    h.app.userSessions.patch(userSessionId, { lifecycle: "archived" });
    expect(h.app.continuation.latestForProject(projectId)?.facts.objectiveAssessment).toMatchObject({
      stateRevision: recorded.row.revision, decision: "continue", nextAction: expect.stringContaining("map portfolio"),
    });
    const successor = h.addUserSession("execute", { projectId });
    expect(h.app.orchestrationState.latestObjectiveAssessment(successor)?.assessment.decision).toBe("continue");
    expect(h.app.orchestrationState.objectiveAssessmentDigest(successor)).toContain("Latest objective-progress assessment");
  });

  it("constrains semantic stops and rejects worker quietness as objective evidence", () => {
    const { h, userSessionId } = harness();
    expect(() => h.app.orchestrationState.assessObjective(userSessionId, assessment({
      decision: "stop", nextAction: null, stopReason: null,
    }))).toThrow(/normalized stopReason/);
    expect(() => h.app.orchestrationState.assessObjective(userSessionId, assessment({
      decision: "stop", nextAction: null, remainingGaps: [], stopReason: "substantially_achieved", rationale: "No active workers.",
    }))).toThrow(/worker quietness/);
    expect(() => h.app.orchestrationState.assessObjective(userSessionId, assessment({
      decision: "stop", nextAction: null, remainingGaps: [{ description: "Capability missing", executability: "blocked", refs: [] }],
      stopReason: "genuinely_blocked", stopEvidence: [],
    }))).toThrow(/blocker evidence/);
    expect(() => h.app.orchestrationState.assessObjective(userSessionId, assessment({
      decision: "stop", nextAction: null, remainingGaps: [], stopReason: "diminishing_returns", valueCostRationale: null,
    }))).toThrow(/value\/cost rationale/);
  });

  it("requires an operator-judgment stop to link the canonical open decision issue", () => {
    const { h, userSessionId } = harness();
    const { issue } = h.app.decisionIssues.openForAsk({
      userSessionId, issueKey: "portfolio-direction", subject: "Which product frontier should govern next?",
      requirementIds: [], createdBy: "main",
    });
    const stopped = h.app.orchestrationState.assessObjective(userSessionId, assessment({
      decision: "stop", nextAction: null, stopReason: "needs_operator_judgment",
      remainingGaps: [{ description: "The next product frontier is an operator choice.", executability: "operator_owned", refs: [issue.id] }],
      rationale: "Several valuable directions exist and operator product judgment is required before choosing one.",
    }));
    expect(stopped.assessment.remainingGaps[0]?.refs).toEqual([issue.id]);
  });
});
