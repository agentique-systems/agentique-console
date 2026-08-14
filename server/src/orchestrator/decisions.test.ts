/**
 * decisionOf is the ONE mapper for the decision read-model, and
 * planDecisionStrings the ONE renderer for plan_approval rows. Spec-marked
 * rows must say WHICH revision changed — the per-delivery decision delta is
 * how a running seat learns the governing spec moved — while plain plan rows
 * keep their historical strings byte-for-byte.
 */
import { describe, expect, it } from "vitest";
import { decisionOf, planDecisionQuestion, planDecisionStrings, specMarkerOf, type DecisionSourceRow } from "./decisions.ts";

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
    expect(specMarkerOf({ plan: "x", spec: { revision: 3, changeNote: "tighter" } })).toEqual({ revision: 3, changeNote: "tighter" });
    expect(specMarkerOf({ plan: "x", spec: { revision: 3, changeNote: "" } })).toEqual({ revision: 3 });
    expect(specMarkerOf({ plan: "x" })).toBeNull();
    expect(specMarkerOf(null)).toBeNull();
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
