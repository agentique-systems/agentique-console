/**
 * An operator decision reaches every agent, and outlives the session that
 * asked: an answer that exists only as a tool result inside one provider
 * transcript is dropped at the orchestrator boundary — it must be a durable
 * row that every agent's prompt reads.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { interactions as interactionRows } from "../db/schema.ts";

const handoff = (action: string) => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

const MECHANIC = {
  question: "Does the player DODGE obstacles or COLLECT targets?",
  options: [{ label: "Dodge obstacles" }, { label: "Collect targets" }],
  urgency: "deferred" as const,
  allowFreeText: false,
};

async function twoSeats() {
  const h = makeDelegationHarness(async function* () {
    yield initMessage();
    yield successMessage();
  });
  const userSessionId = h.addUserSession();
  const created = h.host.createSession({
    userSessionId, title: "lane runner", agents: [
      { name: "renderer", profileId: "implementer", owns: ["src/game.js"] },
      { name: "page", profileId: "implementer", owns: ["index.html"] },
    ],
    briefing: handoff("build the game"),
  });
  await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
  return { h, userSessionId, agentSessionId: created.agentSessionId };
}

describe("decision ledger", () => {
  it("records one decision per answer, attributed to the agent that asked", async () => {
    const { h, userSessionId, agentSessionId } = await twoSeats();
    const ask = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
    await ask.handler(MECHANIC, {});
    const row = h.db.select().from(interactionRows).all()[0]!;
    h.interactions.resolveFromApi(userSessionId, row.id, {
      answers: { [MECHANIC.question]: ["Dodge obstacles"] },
    });

    const decisions = h.decisions.list(userSessionId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      question: MECHANIC.question,
      answer: "Dodge obstacles",
      askedBy: "coordinator",
      source: "interaction",
      agentSessionId,
    });
  });

  it("delivers the decision to an agent that never asked it", async () => {
    const { h, userSessionId, agentSessionId } = await twoSeats();
    const ask = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
    await ask.handler(MECHANIC, {});
    const row = h.db.select().from(interactionRows).all()[0]!;
    h.interactions.resolveFromApi(userSessionId, row.id, {
      answers: { [MECHANIC.question]: ["Dodge obstacles"] },
    });

    // `renderer` never asked, and never will. It must still be told.
    h.host.post({
      agentSessionId,
      speaker: { kind: "orchestrator", name: "coordinator" },
      to: "renderer", handoff: handoff("implement src/game.js"), category: "assignment",
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.delivery.updated"
        && (event.payload as { recipient?: string }).recipient === "renderer"
        && (event.payload as { status?: string }).status === "delivered",
      10_000,
    );

    const prompt = h.fake.captured.prompts.find((text) => text.includes("You are renderer."));
    expect(prompt).toBeDefined();
    expect(prompt).toContain("New operator decisions since your last delivery");
    expect(prompt).toContain("Dodge obstacles");
    expect(prompt).toMatch(/decided for this whole session, not just for the seat that asked/);
  });

  it("omits the decision block entirely when there is nothing new", async () => {
    // Load-bearing for prompt caching: a block that rendered empty would change
    // the shape of every delivery prompt in every session that never asks a
    // question, which is most of them.
    const { h, agentSessionId } = await twoSeats();
    h.host.post({
      agentSessionId,
      speaker: { kind: "orchestrator", name: "coordinator" },
      to: "renderer", handoff: handoff("implement src/game.js"), category: "assignment",
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.delivery.updated"
        && (event.payload as { recipient?: string }).recipient === "renderer"
        && (event.payload as { status?: string }).status === "delivered",
      10_000,
    );

    const prompt = h.fake.captured.prompts.find((text) => text.includes("You are renderer."))!;
    expect(prompt).not.toContain("operator decisions");
    expect(prompt).not.toContain("The operator answered");
    // Straight from the roster line to the handoffs, exactly as before.
    expect(prompt).toMatch(/Participants: [^\n]*\.\n\nOnly the following addressed handoffs are new:/);
  });

  it("does not re-send a decision the agent has already been shown", async () => {
    const { h, userSessionId, agentSessionId } = await twoSeats();
    const ask = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
    await ask.handler(MECHANIC, {});
    const row = h.db.select().from(interactionRows).all()[0]!;
    h.interactions.resolveFromApi(userSessionId, row.id, { answers: { [MECHANIC.question]: ["Dodge obstacles"] } });

    for (const action of ["first delivery", "second delivery"]) {
      h.host.post({
        agentSessionId,
        speaker: { kind: "orchestrator", name: "coordinator" },
        to: "renderer", handoff: handoff(action), category: "assignment",
      });
      await collectUntil(
        h.bus,
        (event) => event.type === "agent_session.message.appended"
          && String((event.payload as { message?: { text?: string } }).message?.text ?? "").includes(action),
        10_000,
      );
    }

    const shown = h.fake.captured.prompts.filter((text) =>
      text.includes("You are renderer.") && text.includes("New operator decisions"));
    // Once. The watermark advances, so the delta stays a delta.
    expect(shown).toHaveLength(1);
  });

  it("announces an approved requirements revision to a busy seat at its next delivery", async () => {
    // The decision delta is the designed propagation channel: a seat that
    // stays live through an amendment must hear WHICH revision now governs,
    // not a generic "Approved the plan".
    const { h, userSessionId, agentSessionId } = await twoSeats();
    const { id } = h.interactions.createRequirementsApproval(
      userSessionId, "## Requirements\n- Renders with three.js\n", 2, "vendor three.js", 1);
    h.interactions.resolveFromApi(userSessionId, id, { decision: "approve" });

    h.host.post({
      agentSessionId,
      speaker: { kind: "orchestrator", name: "coordinator" },
      to: "renderer", handoff: handoff("implement src/game.js"), category: "assignment",
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.delivery.updated"
        && (event.payload as { recipient?: string }).recipient === "renderer"
        && (event.payload as { status?: string }).status === "delivered",
      10_000,
    );

    const prompt = h.fake.captured.prompts.find((text) => text.includes("You are renderer."))!;
    expect(prompt).toContain("New operator decisions since your last delivery");
    expect(prompt).toContain("Requirements approval (rev 2)");
    expect(prompt).toContain("Approved requirements revision 2 — vendor three.js");
  });

  it("carries operatorDecisions on a coordination handoff", async () => {
    const { h, userSessionId, agentSessionId } = await twoSeats();
    const ask = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
    await ask.handler(MECHANIC, {});
    const row = h.db.select().from(interactionRows).all()[0]!;
    h.interactions.resolveFromApi(userSessionId, row.id, { answers: { [MECHANIC.question]: ["Dodge obstacles"] } });

    h.host.post({
      agentSessionId,
      speaker: { kind: "orchestrator", name: "coordinator" },
      to: "main", handoff: handoff("progress"), category: "milestone",
    });

    const record = h.repo.latestHandoff({ userSessionId, agentSessionId, recipient: "main", sender: "coordinator" });
    // Declared in shared/src/handoffs.ts since the beginning and written by
    // absolutely nothing until now.
    const data = record?.extension.data as { operatorDecisions?: string[] };
    expect(record?.extension.kind).toBe("coordination");
    expect(data.operatorDecisions?.join(" ")).toContain("Dodge obstacles");
  });

  it("is in the system prompt of every agent spawned after it — how it survives rotation", async () => {
    const { h, userSessionId, agentSessionId } = await twoSeats();
    const ask = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
    await ask.handler(MECHANIC, {});
    const row = h.db.select().from(interactionRows).all()[0]!;
    h.interactions.resolveFromApi(userSessionId, row.id, { answers: { [MECHANIC.question]: ["Dodge obstacles"] } });

    // A rotation retires the provider session and RESPAWNS the agent, so the
    // system prompt is rebuilt — which is exactly when the digest is read.
    // Spawning `page` for the first time after the answer is the same code
    // path a rotated agent takes.
    h.host.post({
      agentSessionId,
      speaker: { kind: "orchestrator", name: "coordinator" },
      to: "page", handoff: handoff("implement index.html"), category: "assignment",
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.delivery.updated"
        && (event.payload as { recipient?: string }).recipient === "page"
        && (event.payload as { status?: string }).status === "delivered",
      10_000,
    );

    const appends = h.fake.captured.options
      .map((options) => String((options.systemPrompt as { append?: string } | undefined)?.append ?? ""))
      .filter((append) => append.includes("Operator decisions (authoritative)"));
    expect(appends.length).toBeGreaterThanOrEqual(1);
    expect(appends.join("\n")).toContain("Dodge obstacles");
    // After SESSION_PROTOCOL (so the cached invariant head is untouched) and
    // before the rotation checkpoint (an operator decision outranks a
    // model-authored summary of state).
    const append = appends[appends.length - 1]!;
    expect(append.indexOf("## Session protocol")).toBeLessThan(append.indexOf("## Operator decisions"));
  });
});

describe("decision ledger project continuity", () => {
  it("a decision made in one session governs a later session on the same project", async () => {
    const { h, userSessionId } = await twoSeats();
    const ask = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
    await ask.handler(MECHANIC, {});
    const row = h.db.select().from(interactionRows).all()[0]!;
    h.interactions.resolveFromApi(userSessionId, row.id, {
      answers: { [MECHANIC.question]: ["Dodge obstacles"] },
    });

    // A continued session on the SAME project inherits the decision; a
    // session on a fresh project does not. Continuation is sequential (a DB
    // invariant), so the predecessor archives before the successor attaches.
    const projectId = h.repo.getUserSession(userSessionId)!.projectId;
    h.repo.patchUserSession(userSessionId, { lifecycle: "archived" });
    const continued = h.addUserSession("execute", { projectId });
    const fresh = h.addUserSession();
    expect(h.decisions.list(continued).map((d) => d.answer)).toContain("Dodge obstacles");
    expect(h.decisions.list(fresh)).toHaveLength(0);
  });
});
