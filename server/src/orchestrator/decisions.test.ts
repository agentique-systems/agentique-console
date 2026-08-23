/**
 * decisionOf is the ONE mapper for the decision read-model, and
 * planDecisionStrings the ONE renderer for plan_approval rows. Spec-marked
 * rows must say WHICH revision changed — the per-delivery decision delta is
 * how a running seat learns the governing spec moved — while plain plan rows
 * keep their historical strings byte-for-byte.
 */
import { describe, expect, it } from "vitest";
import { DecisionLedger, decisionOf, decisionPin, planDecisionQuestion, planDecisionStrings, renderDecision, specMarkerOf, type DecisionSourceRow } from "./decisions.ts";

const base = {
  id: "int_1",
  userSessionId: "us1",
  agentSessionId: null,
  agent: null,
  createdAt: "2026-08-14T00:00:00.000Z",
  resolvedAt: "2026-08-14T00:01:00.000Z",
} as const;

const planRow = (payload: Record<string, unknown>, status: string, response: Record<string, unknown>): DecisionSourceRow =>
  ({ ...base, kind: "plan_approval", status, payload, response }) as unknown as DecisionSourceRow;

describe("specMarkerOf", () => {
  it("reads the marker, dropping an empty changeNote", () => {
    expect(specMarkerOf({ plan: "x", spec: { revision: 3, changeNote: "tighter" } })).toEqual({ revision: 3, changeNote: "tighter", kind: "spec" });
    expect(specMarkerOf({ plan: "x", spec: { revision: 3, changeNote: "" } })).toEqual({ revision: 3, kind: "spec" });
    expect(specMarkerOf({ plan: "x" })).toBeNull();
    expect(specMarkerOf(null)).toBeNull();
  });

  it("reads the requirements marker and labels its strings", () => {
    expect(specMarkerOf({ plan: "x", requirements: { revision: 2, changeNote: "amended", nodeCount: 4 } }))
      .toEqual({ revision: 2, changeNote: "amended", kind: "requirements" });
    expect(planDecisionQuestion({ plan: "x", requirements: { revision: 2, nodeCount: 4 } })).toBe("Requirements approval (rev 2)");
    expect(planDecisionStrings({ plan: "x", requirements: { revision: 2, nodeCount: 4 } }, true)).toEqual({
      question: "Requirements approval (rev 2)",
      answer: "Approved requirements revision 2",
    });
  });
});

describe("planDecisionStrings", () => {
  it("keeps the historical strings for plain plans, byte-for-byte", () => {
    expect(planDecisionStrings({ plan: "x" }, true)).toEqual({ question: "Plan approval", answer: "Approved the plan" });
    expect(planDecisionStrings({ plan: "x" }, false, "too big")).toEqual({ question: "Plan approval", answer: "Requested changes to the plan: too big" });
  });

  it("names the revision and change for spec-marked rows", () => {
    expect(planDecisionStrings({ plan: "x", spec: { revision: 2, changeNote: "drop three.js" } }, true)).toEqual({
      question: "Specification approval (rev 2)",
      answer: "Approved specification revision 2 — drop three.js",
    });
    expect(planDecisionStrings({ plan: "x", spec: { revision: 2 } }, false, "not yet")).toEqual({
      question: "Specification approval (rev 2)",
      answer: "Requested changes to specification revision 2: not yet",
    });
  });

  it("planDecisionQuestion matches", () => {
    expect(planDecisionQuestion({ plan: "x" })).toBe("Plan approval");
    expect(planDecisionQuestion({ plan: "x", spec: { revision: 4 } })).toBe("Specification approval (rev 4)");
  });
});

describe("decisionOf over plan_approval rows", () => {
  it("renders an approved SPEC row with revision and changeNote", () => {
    const decision = decisionOf(planRow(
      { plan: "doc", spec: { revision: 2, changeNote: "vendor three.js" } },
      "answered",
      { decision: "approve", note: "ship it" },
    ));
    expect(decision).toMatchObject({
      question: "Specification approval (rev 2)",
      answer: "Approved specification revision 2 — vendor three.js: ship it",
      source: "plan_approval",
      note: null,
    });
  });

  it("renders a rejected spec row and a chat-dismissed plain plan unchanged", () => {
    expect(decisionOf(planRow({ plan: "doc", spec: { revision: 3 } }, "rejected", { decision: "reject" }))?.answer)
      .toBe("Requested changes to specification revision 3");
    expect(decisionOf(planRow({ plan: "doc" }, "answered", { decision: "approve" }))).toMatchObject({
      question: "Plan approval",
      answer: "Approved the plan",
    });
  });
});

describe("requirement-linked decisions", () => {
  const questionRow = (id: string, payload: Record<string, unknown>, resolvedAt: string): DecisionSourceRow =>
    ({ ...base, id, kind: "question", status: "answered", payload, resolvedAt,
      response: { answers: { q: ["Yes"] } } }) as unknown as DecisionSourceRow;

  it("decisionOf reads payload requirementIds and renderDecision appends them", () => {
    const decision = decisionOf(questionRow("int_r", {
      questions: [{ question: "Real-time or turn-based combat?", options: [] }],
      requirementIds: ["r3", "r7"],
    }, "2026-08-14T00:02:00.000Z"))!;
    expect(decision.requirementIds).toEqual(["r3", "r7"]);
    expect(renderDecision(decision)).toBe("Real-time or turn-based combat? → Yes [r3, r7]");
    // Unlinked rows keep their historical rendering byte-for-byte.
    const plain = decisionOf(questionRow("int_p", { questions: [{ question: "Q", options: [] }] }, "2026-08-14T00:03:00.000Z"))!;
    expect(plain.requirementIds).toEqual([]);
    expect(renderDecision(plain)).toBe("Q → Yes");
  });

  it("digest pins decisions whose requirements are still live and unsatisfied, ahead of recency", () => {
    const rows = [
      questionRow("int_old_linked", { questions: [{ question: "Combat model?", options: [] }], requirementIds: ["r1"] }, "2026-08-14T01:00:00.000Z"),
      questionRow("int_settled", { questions: [{ question: "Palette?", options: [] }], requirementIds: ["r2"] }, "2026-08-14T02:00:00.000Z"),
      questionRow("int_new_plain", { questions: [{ question: "Anything else?", options: [] }] }, "2026-08-14T03:00:00.000Z"),
    ];
    const store = { listDecisionSourceRowsForProject: () => rows.map((row) => ({ ...row, participant: null })) };
    const ledger = new DecisionLedger(store as never, () => "proj1");
    // r1 open (pins int_old_linked); r2 satisfied (int_settled ages normally).
    const pinned = decisionPin([
      { id: "r1", derivedStatus: "open" },
      { id: "r2", derivedStatus: "satisfied" },
    ]);
    const digest = ledger.digest("us1", { pinned });
    const lines = digest.split("\n");
    expect(lines[0]).toContain("Combat model?");
    expect(lines[0]).toContain("[r1]");
    // The rest follow newest-first, exactly as before.
    expect(lines[1]).toContain("Anything else?");
    expect(lines[2]).toContain("Palette?");
    // A seat whose scope excludes r1 does not pin it.
    const scoped = decisionPin([{ id: "r1", derivedStatus: "open" }], new Set(["r9"]));
    const unpinned = ledger.digest("us1", { pinned: scoped });
    expect(unpinned.split("\n")[0]).toContain("Anything else?");
  });
});
