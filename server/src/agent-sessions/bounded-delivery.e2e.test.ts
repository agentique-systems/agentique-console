/**
 * Bounded seat deliveries, end to end: a session may accumulate a large task
 * ledger, decision history, roster, and requirement scope without every
 * delivery growing with it. The seat automatically receives its active
 * frontier, relevant changes, and pinned currency issues; everything omitted
 * is counted and stays one deterministic read away — and the delta cursors
 * advance on ACKNOWLEDGEMENT, so a failed turn or a restart re-renders
 * context instead of losing it.
 */
import { describe, expect, it } from "vitest";
import { errorMessage, initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { consoleTaskListId } from "../tasks/service.ts";
import { PromptComposer } from "./composer.ts";

const handoff = (action: string) => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

type Harness = ReturnType<typeof makeDelegationHarness>;

function deliveredTo(h: Harness, recipient: string): Promise<unknown> {
  return collectUntil(h.bus, (event) => event.type === "agent_session.delivery.updated"
    && (event.payload as { recipient?: string }).recipient === recipient
    && (event.payload as { status?: string }).status === "delivered", 15_000);
}

function settledCount(h: Harness, agent: string, count: number): Promise<unknown> {
  let seen = 0;
  return collectUntil(h.bus, (event) => {
    if (event.type !== "agent_session.turn.settled") return false;
    if ((event.payload as { agent?: string }).agent !== agent) return false;
    seen += 1;
    return seen >= count;
  }, 20_000);
}

/** A composer as a freshly restarted process would build it: durable state only. */
function freshComposer(h: Harness): PromptComposer {
  return new PromptComposer({
    repo: h.repo, bus: h.bus, config: h.config, handoffs: h.handoffs,
    decisions: h.decisions, requirements: h.app.requirements, assumptions: h.app.assumptions,
    tasks: h.tasks, interactions: h.interactions, worktrees: null, laneState: () => null,
    openImpacts: (userSessionId) => h.app.changeImpacts.listOpen(userSessionId),
  });
}

describe("bounded task ledger view", () => {
  it("hundreds of unrelated tasks stay out of the delivery while the seat's unit, its blocker, and a count stay in", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "big ledger",
      agents: [
        { name: "renderer", profileId: "implementer", owns: ["src/game.js"] },
        { name: "page", profileId: "implementer", owns: ["index.html"] },
      ],
      briefing: handoff("build the game"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    const listId = consoleTaskListId(created.agentSessionId);
    const attribution = {
      workspaceId: h.repo.getUserSession(userSessionId)!.workspaceId,
      userSessionId, agentSessionId: created.agentSessionId, agent: "page",
    };
    for (let i = 0; i < 300; i += 1) {
      h.tasks.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: `f${i}`, subject: `filler-${i}-unit`, owner: "page", attribution });
    }
    h.tasks.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: "blocker", subject: "land the asset pipeline", owner: "page", attribution });
    h.tasks.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: "mine", subject: "wire the renderer loop", owner: "renderer", blockedBy: ["blocker"], attribution });

    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "coordinator" },
      to: "renderer", handoff: handoff("start on the renderer loop"), category: "assignment",
    });
    await deliveredTo(h, "renderer");

    const prompt = h.fake.captured.prompts.find((text) => text.includes("You are renderer."))!;
    expect(prompt).toBeDefined();
    // The seat's own unit and its direct blocker survive 300 unrelated tasks.
    // (The assignment's ledger sync may have already started the unit.)
    expect(prompt).toMatch(/- mine \[(pending|in_progress)\] wire the renderer loop \(renderer\)/);
    expect(prompt).toContain("- blocker [pending] land the asset pipeline (page)");
    expect(prompt).toMatch(/\d+ more task\(s\) not shown/);
    expect(prompt).toContain("task_list returns the full ledger");
    // The ledger did not ride along wholesale.
    expect(prompt).not.toContain("filler-299-unit");
    const section = prompt.slice(prompt.indexOf("## Task ledger"), prompt.indexOf("Keep your unit's status honest"));
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(4_096 + 256);

    // Recovery inherits the same bounded view: a reconstruction checkpoint
    // over this ledger stays readable and still names the seat's own unit.
    const checkpoint = freshComposer(h).reconstructCheckpoint(
      h.repo.getAgentSession(created.agentSessionId)!, h.repo.getAgent(created.agentSessionId, "renderer")!);
    expect(checkpoint.core.state.summary).toMatch(/- mine \[(pending|in_progress)\] wire the renderer loop \(renderer\)/);
    expect(checkpoint.core.state.summary).toMatch(/more task\(s\) not shown/);
    expect(checkpoint.core.state.summary).not.toContain("filler-299-unit");
  });
});

describe("bounded decision delta", () => {
  it("a long-idle seat gets a capped delta with scope-pinned decisions first, a continuation count, and list_decisions for the rest", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const doc = "## Requirements\n- Dungeons are deterministic\n- Seed input is stable\n";
    const draft = h.app.requirements.propose(userSessionId, doc, "initial");
    h.app.requirements.approve(draft.id, { document: doc, edited: false });
    const created = h.host.createSession({
      userSessionId, title: "parked a while",
      agents: [{ name: "renderer", profileId: "implementer", owns: ["src/game.js"] }],
      briefing: handoff("build"), requirements: ["r1"],
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    // 60 operator decisions land while the seat is idle. The OLDEST one is
    // pinned to the seat's delegated requirement; recency alone would drop it.
    for (let i = 0; i < 60; i += 1) {
      const label = i === 0 ? "use-sqlite-for-r1" : `pick-${String(i).padStart(2, "0")}`;
      const question = `Q${String(i).padStart(2, "0")}?`;
      const { id } = h.interactions.createOperatorQuestion({
        userSessionId, questions: [{ question, options: [{ label }] }],
        urgency: "deferred", ...(i === 0 ? { requirementIds: ["r1"] } : {}),
      });
      h.interactions.resolveFromApi(userSessionId, id, { answers: { [question]: [label] } });
    }

    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "coordinator" },
      to: "renderer", handoff: handoff("resume work"), category: "assignment",
    });
    await deliveredTo(h, "renderer");

    const prompt = h.fake.captured.prompts.find((text) => text.includes("You are renderer.") && text.includes("New operator decisions"))!;
    expect(prompt).toBeDefined();
    // Pinned relevance beats recency: the oldest, requirement-linked decision renders…
    expect(prompt).toContain("use-sqlite-for-r1");
    // …an old unrelated decision does not, the newest does, and the rest are counted.
    expect(prompt).not.toContain("pick-05");
    expect(prompt).toContain("pick-59");
    expect(prompt).toMatch(/\(\d+ more decision\(s\) since your last delivery — they still stand; list_decisions returns the full ledger\)/);

    // Everything omitted is one deterministic read away.
    const tool = h.fake.captured.tools.find((candidate) => candidate.name === "list_decisions")!;
    expect(tool).toBeDefined();
    const result = JSON.stringify(await tool.handler({ maxBytes: 200_000 }, {}));
    expect(result).toContain("pick-05");
    expect(result).toContain("use-sqlite-for-r1");
  });

  it("a failed turn re-renders the decision delta on redelivery; a completed turn acknowledges it", async () => {
    let rendererFailed = false;
    const h = makeDelegationHarness(async function* (options) {
      const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
      yield initMessage();
      if (append.includes("own the assigned files or component") && !rendererFailed) {
        rendererFailed = true;
        yield errorMessage("error_during_execution");
        return;
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "retry keeps context",
      agents: [{ name: "renderer", profileId: "implementer", owns: ["src/game.js"] }],
      briefing: handoff("build"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    const { id } = h.interactions.createOperatorQuestion({
      userSessionId, questions: [{ question: "Which store?", options: [{ label: "dodge-obstacles" }] }], urgency: "deferred",
    });
    h.interactions.resolveFromApi(userSessionId, id, { answers: { "Which store?": ["dodge-obstacles"] } });

    // Turn 1 dies on the provider; the delivery requeues and turn 2 succeeds.
    const twoTurns = settledCount(h, "renderer", 2);
    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "coordinator" },
      to: "renderer", handoff: handoff("first attempt"), category: "assignment",
    });
    await twoTurns;
    const withDelta = () => h.fake.captured.prompts.filter((text) =>
      text.includes("You are renderer.") && text.includes("dodge-obstacles"));
    // BOTH attempts carried the decision: the cursor did not advance on the
    // failed composition. At-least-once, never lost.
    expect(withDelta().length).toBe(2);

    // The completed turn acknowledged its delivery, so the next one is clean.
    const thirdTurn = settledCount(h, "renderer", 1);
    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "coordinator" },
      to: "renderer", handoff: handoff("second assignment"), category: "assignment",
    });
    await thirdTurn;
    expect(h.fake.captured.prompts.filter((text) => text.includes("You are renderer.")).length).toBe(3);
    expect(withDelta().length).toBe(2);
  });

  it("restart keeps an unacknowledged delta due and an acknowledged one seen", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "restart currency",
      agents: [{ name: "renderer", profileId: "implementer", owns: ["src/game.js"] }],
      briefing: handoff("build"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    const ask = (question: string, label: string) => {
      const { id } = h.interactions.createOperatorQuestion({
        userSessionId, questions: [{ question, options: [{ label }] }], urgency: "deferred",
      });
      h.interactions.resolveFromApi(userSessionId, id, { answers: { [question]: [label] } });
    };

    // Decision #1 rides a REAL delivery whose turn completes — acknowledged.
    ask("First?", "first-answer");
    const settle = settledCount(h, "renderer", 1);
    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "coordinator" },
      to: "renderer", handoff: handoff("work"), category: "assignment",
    });
    await settle;
    const session = h.repo.getAgentSession(created.agentSessionId)!;
    const seat = () => h.repo.getAgent(created.agentSessionId, "renderer")!;
    // A restarted process (fresh composer, durable state only) does not
    // re-render what was acknowledged…
    expect(freshComposer(h).deliveryPrompt(session, seat(), [])).not.toContain("first-answer");

    // …but a decision composed and NEVER acknowledged re-renders after a
    // restart: composition stages nothing durable.
    ask("Second?", "second-answer");
    const beforeRestart = freshComposer(h);
    expect(beforeRestart.deliveryPrompt(session, seat(), [])).toContain("second-answer");
    expect(freshComposer(h).deliveryPrompt(session, seat(), [])).toContain("second-answer");
  });
});

describe("pinned revision currency", () => {
  it("an open change impact naming the session renders in its deliveries until reconciled", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const doc = "## Requirements\n- Dungeons are deterministic\n- Seed input is stable\n";
    const draft = h.app.requirements.propose(userSessionId, doc, "initial");
    h.app.requirements.approve(draft.id, { document: doc, edited: false });
    const created = h.host.createSession({
      userSessionId, title: "impacted",
      agents: [{ name: "renderer", profileId: "implementer", owns: ["src/game.js"] }],
      briefing: handoff("build"), requirements: ["r1"],
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    h.app.requirements.reportStatus({
      userSessionId, requirementId: "r1", to: "satisfied",
      evidence: [{ kind: "command", ref: "ran the dungeon twice" }], claimant: { kind: "main" },
    });

    // The operator amends r1's meaning while the delegated session is open.
    const amended = "## Requirements\n- r1: Dungeons are deterministic across platforms\n- r2: Seed input is stable\n";
    const revised = h.app.requirements.propose(userSessionId, amended, "cross-platform determinism");
    h.app.requirements.approve(revised.id, { document: amended, edited: false });
    const open = h.app.changeImpacts.listOpen(userSessionId);
    expect(open.length).toBeGreaterThan(0);
    expect(open[0]!.outstanding.sessions).toContain(created.agentSessionId);

    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "coordinator" },
      to: "renderer", handoff: handoff("keep going"), category: "assignment",
    });
    await deliveredTo(h, "renderer");

    const prompt = h.fake.captured.prompts.find((text) => text.includes("You are renderer.") && text.includes("Requirement changes pending reconciliation"))!;
    expect(prompt).toBeDefined();
    expect(prompt).toContain(open[0]!.id);
    expect(prompt).toContain("r1");
    expect(prompt).toContain("re-check active work against the current revision (read_requirements)");
  });
});

describe("bounded roster", () => {
  it("a crew past the resident cap renders a bounded roster with a continuation count", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "big crew",
      agents: Array.from({ length: 14 }, (_, i) => ({ name: `a${i}`, profileId: "explorer" })),
      briefing: handoff("survey"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "coordinator" },
      to: "a0", handoff: handoff("look at sector 0"), category: "assignment",
    });
    await deliveredTo(h, "a0");

    const prompt = h.fake.captured.prompts.find((text) => text.includes("You are a0."))!;
    expect(prompt).toBeDefined();
    expect(prompt).toMatch(/…and \d+ more seat\(s\) — roster_status lists them all/);
    const participants = prompt.split("\n").find((line) => line.startsWith("You are a0."))!;
    expect((participants.match(/\(explorer;/g) ?? []).length).toBeLessThanOrEqual(12);
  });
});
