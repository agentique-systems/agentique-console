/**
 * `core.uncertainty[]` reaching the operator without anyone deciding to relay it.
 *
 * db-live-2 carried 22 distinct uncertainty items. Every one of them was
 * written honestly by the seat that found it, and every one of them was read by
 * nothing. The two that mattered most:
 *
 *   page  → "game.js WILL NOT LOAD IF THE BROWSER HAS NO NETWORK."
 *   check → "I could not view the PNG screenshots myself."
 *
 * The first was the defect class that made db-live-1's deliverable
 * non-functional. The second means the operator's stated acceptance bar
 * ("report final only when check has confirmed it with a screenshot") was
 * satisfied procedurally and defeated semantically. Neither produced a card.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { interactions as interactionRows } from "../db/schema.ts";

const draft = (uncertainty: string[], overrides: Record<string, unknown> = {}) => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status: "in_progress" as const, risk: "low" as const,
    action: "implement src/game.js", state: { summary: "wrote the module", evidence: [] },
    result: { summary: null, artifacts: [] },
    uncertainty, nextAction: null, requestExpandedContext: false,
    ...overrides,
  },
  extension: { kind: "generic" as const, data: {} },
});

async function session() {
  const h = makeDelegationHarness(async function* () {
    yield initMessage();
    yield successMessage();
  });
  const userSessionId = h.addUserSession();
  const created = h.host.createSession({
    userSessionId, title: "lane runner", mode: "execute",
    agents: [{ name: "renderer", profileId: "implementer", owns: ["src/game.js"] }],
    briefing: draft([]),
  });
  await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
  return { h, userSessionId, agentSessionId: created.agentSessionId };
}

const cards = (h: Awaited<ReturnType<typeof session>>["h"]) =>
  h.db.select().from(interactionRows).all().filter((row) => row.source === "uncertainty");

describe("uncertainty promotion", () => {
  it("turns a confirmed capability gap into an operator card, unprompted", async () => {
    const { h, agentSessionId } = await session();
    // The `implementer` profile has no outbound network, so this claimed limit
    // is a CONFIRMED one — the seat is right, and the operator should know.
    h.host.post({
      agentSessionId,
      speaker: { kind: "agent", name: "renderer" }, to: "orchestrator",
      handoff: draft(["game.js WILL NOT LOAD IF THE BROWSER HAS NO NETWORK. Line 1 imports three from a CDN."]),
      category: "milestone",
    });

    const open = cards(h);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ participant: "renderer", urgency: "blocking", source: "uncertainty" });
    const questions = (open[0]!.payload as { questions: { question: string; context?: string; options: unknown[] }[] }).questions;
    // The seat's own words are carried verbatim — the console does not
    // paraphrase a finding it does not understand.
    expect(questions[0]?.context).toContain("WILL NOT LOAD IF THE BROWSER HAS NO NETWORK");
    // And it poses only the meta-decision it can pose correctly.
    expect(questions[0]?.options).toHaveLength(3);
  });

  it("offers REAL options when it genuinely knows both versions", async () => {
    const { h, userSessionId, agentSessionId } = await session();
    // Operator pinned r160 earlier in the run.
    const card = h.interactions.createOperatorQuestion({
      userSessionId, questions: [{ question: "Which three.js?", options: [{ label: "three r160" }] }],
    });
    h.interactions.resolveFromApi(userSessionId, card.id, { answers: { "Which three.js?": ["three r160"] } });

    h.host.post({
      agentSessionId,
      speaker: { kind: "agent", name: "renderer" }, to: "orchestrator",
      handoff: draft(["CDN access is now failing, so the vendored copy of three stays at r169."]),
      category: "milestone",
    });

    const open = cards(h);
    expect(open).toHaveLength(1);
    const questions = (open[0]!.payload as { questions: { question: string; options: { label: string }[] }[] }).questions;
    expect(questions[0]?.question).toMatch(/ship r169, or hold for r160/i);
    expect(questions[0]?.options.map((option) => option.label)).toEqual(["Ship r169", "Hold for r160"]);
  });

  it("does not promote a benign uncertainty", async () => {
    const { h, agentSessionId } = await session();
    h.host.post({
      agentSessionId,
      speaker: { kind: "agent", name: "renderer" }, to: "orchestrator",
      handoff: draft(["Formatting may differ from prettier defaults."]),
      category: "milestone",
    });
    expect(cards(h)).toHaveLength(0);
  });

  it("merges a re-reported uncertainty instead of minting a second card", async () => {
    // The promote → answer → re-report → promote loop. Silent when it
    // regresses, so it is asserted explicitly.
    const { h, agentSessionId } = await session();
    for (let i = 0; i < 3; i += 1) {
      h.host.post({
        agentSessionId,
        speaker: { kind: "agent", name: "renderer" }, to: "orchestrator",
        handoff: draft(["game.js WILL NOT LOAD IF THE BROWSER HAS NO NETWORK."]),
        category: "update",
      });
    }
    expect(cards(h)).toHaveLength(1);
    const questions = (cards(h)[0]!.payload as { questions: unknown[] }).questions;
    expect(questions).toHaveLength(1);
  });

  it("folds a NEW uncertainty into the seat's open card", async () => {
    const { h, agentSessionId } = await session();
    h.host.post({
      agentSessionId, speaker: { kind: "agent", name: "renderer" }, to: "orchestrator",
      handoff: draft(["game.js WILL NOT LOAD IF THE BROWSER HAS NO NETWORK."]), category: "update",
    });
    h.host.post({
      agentSessionId, speaker: { kind: "agent", name: "renderer" }, to: "orchestrator",
      handoff: draft(["It is unclear whether the HUD should persist across restarts."]), category: "update",
    });

    const open = cards(h);
    expect(open).toHaveLength(1);
    const questions = (open[0]!.payload as { questions: { question: string }[] }).questions;
    expect(questions).toHaveLength(2);
    expect(questions.map((q) => q.question).join(" ")).toContain("HUD");
  });

  it("caps one card at four questions and spills the rest into context", async () => {
    const { h, agentSessionId } = await session();
    h.host.post({
      agentSessionId, speaker: { kind: "agent", name: "renderer" }, to: "orchestrator",
      handoff: draft([
        "I could not verify the collision path.",
        "It is unclear whether restart should reset best score.",
        "I did not run the score tests.",
        "Not sure which lane spacing you wanted.",
        "I could not confirm the fog colour.",
        "I have not tested the resize path.",
      ]), category: "update",
    });

    const open = cards(h);
    expect(open).toHaveLength(1);
    const questions = (open[0]!.payload as { questions: { context?: string }[] }).questions;
    expect(questions.length).toBeLessThanOrEqual(4);
    // The surplus is visible, not silently dropped.
    expect(questions.map((q) => q.context ?? "").join(" ")).toContain("Also open from this seat");
  });

  it("blocks the final when a seat claims done while admitting it never verified", async () => {
    // db-live-2's `check` reported completed alongside "I could not view the
    // PNG screenshots myself". The classifier makes that blocking on a final,
    // and Slice 1's gate then withholds the report.
    const { h, agentSessionId } = await session();
    const send = h.fake.captured.tools.find((t) => t.name === "send_handoff")!;
    const result = await send.handler({
      to: "main", category: "final", status: "completed", risk: "low",
      action: "Build and verify Lane Runner",
      stateSummary: "All units landed.", evidence: [],
      resultSummary: "Done.", artifacts: [],
      uncertainty: ["I could not view the PNG screenshots myself, so no visual claim is confirmed."],
      nextAction: null, taskId: null, requestExpandedContext: false,
    }, {});

    // A structured NON-error hold — the gate must not feed the watchdogs.
    expect(result.isError).not.toBe(true);
    const hold = JSON.parse((result.content[0] as { text: string }).text) as { withheld: boolean; guidance: string };
    expect(hold.withheld).toBe(true);
    expect(hold.guidance).toMatch(/final report withheld/);
    expect(cards(h)).toHaveLength(1);
    expect(cards(h)[0]?.urgency).toBe("blocking");
  });
});
