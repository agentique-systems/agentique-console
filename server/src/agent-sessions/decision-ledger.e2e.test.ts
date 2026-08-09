/**
 * An operator decision reaches every seat, and outlives the session that asked.
 *
 * The failure this exists to prevent, from db-live-1: the operator reserved one
 * decision ("does the player DODGE obstacles or COLLECT targets? Ask me before
 * anyone builds the core loop"), the orchestrator asked it 7 seconds in, and
 * the operator answered in 11.8 seconds. The word "dodge" then appeared in the
 * transcripts of:
 *
 *     6c927799 (user session)  dodge=5
 *     680cd679 (orchestrator)  dodge=1
 *     9f55b5c4 (renderer)      dodge=0   <-
 *     e65cacbd (page)          dodge=0   <-
 *     9b3b5885 (check)         dodge=0   <-
 *
 * Zero of three specialists. They built the right game only because the
 * operator's own prompt text ("obstacle cubes… a collision ends the run")
 * independently implied it. Had the answer been "COLLECT", that run builds the
 * wrong thing and nobody finds out until the end.
 *
 * The answer was dropped at the orchestrator boundary because it existed only
 * as a tool result inside one provider transcript. It is now a durable row that
 * every seat's prompt reads.
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
    userSessionId, title: "lane runner", mode: "execute",
    agents: [
      { name: "renderer", profileId: "implementer", owns: ["src/game.js"] },
      { name: "page", profileId: "implementer", owns: ["index.html"] },
    ],
    briefing: handoff("build the game"),
  });
  await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
  return { h, userSessionId, agentSessionId: created.agentSessionId };
}

describe("decision ledger", () => {
  it("records one decision per answer, attributed to the seat that asked", async () => {
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
      askedBy: "orchestrator",
      source: "interaction",
      agentSessionId,
      autoTaken: false,
    });
  });

  it("delivers the decision to a seat that never asked it — the db-live-1 failure", async () => {
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
      speaker: { kind: "orchestrator", name: "orchestrator" },
      to: "renderer", handoff: handoff("implement src/game.js"), category: "assignment",
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.mailbox"
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
      speaker: { kind: "orchestrator", name: "orchestrator" },
      to: "renderer", handoff: handoff("implement src/game.js"), category: "assignment",
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.mailbox"
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

  it("does not re-send a decision the seat has already been shown", async () => {
    const { h, userSessionId, agentSessionId } = await twoSeats();
    const ask = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
    await ask.handler(MECHANIC, {});
    const row = h.db.select().from(interactionRows).all()[0]!;
    h.interactions.resolveFromApi(userSessionId, row.id, { answers: { [MECHANIC.question]: ["Dodge obstacles"] } });

    for (const action of ["first delivery", "second delivery"]) {
      h.host.post({
        agentSessionId,
        speaker: { kind: "orchestrator", name: "orchestrator" },
        to: "renderer", handoff: handoff(action), category: "assignment",
      });
      await collectUntil(
        h.bus,
        (event) => event.type === "agent_session.message"
          && String((event.payload as { message?: { text?: string } }).message?.text ?? "").includes(action),
        10_000,
      );
    }

    const shown = h.fake.captured.prompts.filter((text) =>
      text.includes("You are renderer.") && text.includes("New operator decisions"));
    // Once. The watermark advances, so the delta stays a delta.
    expect(shown).toHaveLength(1);
  });

  it("carries operatorDecisions on a coordination handoff", async () => {
    const { h, userSessionId, agentSessionId } = await twoSeats();
    const ask = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
    await ask.handler(MECHANIC, {});
    const row = h.db.select().from(interactionRows).all()[0]!;
    h.interactions.resolveFromApi(userSessionId, row.id, { answers: { [MECHANIC.question]: ["Dodge obstacles"] } });

    h.host.post({
      agentSessionId,
      speaker: { kind: "orchestrator", name: "orchestrator" },
      to: "main", handoff: handoff("progress"), category: "milestone",
    });

    const record = h.repo.latestHandoff({ userSessionId, agentSessionId, participant: "main", sender: "orchestrator" });
    // Declared in shared/src/handoffs.ts since the beginning and written by
    // absolutely nothing until now.
    const data = record?.extension.data as { operatorDecisions?: string[] };
    expect(record?.extension.kind).toBe("coordination");
    expect(data.operatorDecisions?.join(" ")).toContain("Dodge obstacles");
  });

  it("is in the system prompt of every seat spawned after it — how it survives rotation", async () => {
    const { h, userSessionId, agentSessionId } = await twoSeats();
    const ask = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
    await ask.handler(MECHANIC, {});
    const row = h.db.select().from(interactionRows).all()[0]!;
    h.interactions.resolveFromApi(userSessionId, row.id, { answers: { [MECHANIC.question]: ["Dodge obstacles"] } });

    // A rotation retires the provider session and RESPAWNS the seat, so the
    // system prompt is rebuilt — which is exactly when the digest is read.
    // Spawning `page` for the first time after the answer is the same code
    // path a rotated seat takes.
    h.host.post({
      agentSessionId,
      speaker: { kind: "orchestrator", name: "orchestrator" },
      to: "page", handoff: handoff("implement index.html"), category: "assignment",
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.mailbox"
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

  it("flags an auto-taken decision as not the operator's choice", async () => {
    const { h, userSessionId } = await twoSeats();
    h.interactions.createOperatorQuestion({
      userSessionId, questions: [{ question: "Ship now?", options: [{ label: "Ship" }, { label: "Hold" }] }],
      ttlMs: -1, defaultOption: "Ship",
    });
    h.interactions.sweepExpired();

    const decision = h.decisions.list(userSessionId)[0]!;
    expect(decision.autoTaken).toBe(true);
    expect(decision.source).toBe("ttl_default");
    // The rendering must SAY so — a timeout is much weaker evidence of intent
    // than a click, and the Run Summary has to be able to tell them apart.
    expect(h.decisions.lines(userSessionId).join(" ")).toMatch(/auto-taken on timeout, NOT chosen by the operator/);
  });

  it("parses version pins the operator named, for the deviation classifier", async () => {
    const { h, userSessionId } = await twoSeats();
    const card = h.interactions.createOperatorQuestion({
      userSessionId,
      questions: [{ question: "Which three.js?", options: [{ label: "three r160" }, { label: "three r169" }] }],
    });
    h.interactions.resolveFromApi(userSessionId, card.id, { answers: { "Which three.js?": ["three r160"] } });

    // Slice 3's classifier needs this to recognise "shipped r169, they said
    // r160" as a spec deviation rather than a note nobody reads. r160 is not
    // semver, which is exactly the case a naive rule misses.
    expect(h.decisions.pins(userSessionId).get("three")).toBe("r160");
    expect(h.decisions.constraints(userSessionId).join(" ")).toContain("r160");
  });
});
