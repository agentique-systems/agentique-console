import { describe, expect, it } from "vitest";
import {
  assertDecisionResolutionRules,
  budgetIncreaseSubjectOf,
  DECISION_KINDS,
  decisionRequestSchema,
  isOperatorOnlyDecisionKind,
  RESOLUTION_POLICIES,
  type DecisionRequest,
} from "./decisions.ts";
import { ValidationError } from "./errors.ts";
import { newId } from "./ids.ts";

const request = (overrides: Partial<DecisionRequest> = {}): DecisionRequest => ({
  conversationId: newId("conversation"),
  runId: null,
  kind: "operator_choice",
  resolutionPolicy: "operator_required",
  requestedBy: { kind: "runtime" },
  question: "Which?",
  options: [
    { id: "a", label: "A", description: null },
    { id: "b", label: "B", description: null },
  ],
  recommendedOptionId: "a",
  rationale: "because",
  subject: null,
  affects: { requirementIds: [], taskIds: [], planNodeIds: [] },
  deadlineAt: null,
  activationCondition: null,
  supersedesDecisionId: null,
  ...overrides,
});

describe("decision kinds and policies", () => {
  it("are the exact closed sets", () => {
    expect(DECISION_KINDS).toEqual(["operator_choice", "orchestrator_choice", "requirement_waiver", "side_effect_approval", "signoff", "publish", "budget_increase"]);
    expect(RESOLUTION_POLICIES).toEqual(["operator_required", "use_default_after_deadline"]);
    expect(decisionRequestSchema.safeParse(request({ kind: "auto_approve" as never })).success).toBe(false);
  });

  it("a requirement_waiver is always operator_required and names one Requirement", () => {
    const waiver = request({ kind: "requirement_waiver", affects: { requirementIds: [newId("requirement")], taskIds: [], planNodeIds: [] } });
    expect(decisionRequestSchema.safeParse(waiver).success).toBe(true);
    expect(decisionRequestSchema.safeParse({ ...waiver, resolutionPolicy: "use_default_after_deadline", deadlineAt: "2026-01-02T00:00:00.000Z" }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...waiver, affects: { requirementIds: [], taskIds: [], planNodeIds: [] } }).success).toBe(false);
    expect(isOperatorOnlyDecisionKind("requirement_waiver")).toBe(true);
    expect(isOperatorOnlyDecisionKind("operator_choice")).toBe(false);
  });

  it("a budget_increase is operator_required, carries exactly its typed subject and the approve/deny options, belongs to its subject's Run, and never a default deadline", () => {
    const runId = newId("run");
    const subject = { kind: "budget_increase" as const, runId, partition: "ordinary" as const, added: { costUsd: 1, tokens: 0, attempts: 2 } };
    const increase = request({ kind: "budget_increase", runId, requestedBy: { kind: "operator" }, recommendedOptionId: null, rationale: null, subject, options: [{ id: "approve", label: "Approve", description: null }, { id: "deny", label: "Deny", description: null }] });
    expect(decisionRequestSchema.safeParse(increase).success).toBe(true);
    expect(budgetIncreaseSubjectOf({ id: newId("decision"), kind: "budget_increase", subject }).added).toEqual({ costUsd: 1, tokens: 0, attempts: 2 });
    expect(isOperatorOnlyDecisionKind("budget_increase")).toBe(true);
    expect(decisionRequestSchema.safeParse({ ...increase, subject: null }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...increase, subject: { ...subject, added: { costUsd: 0, tokens: 0, attempts: 0 } } }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...increase, subject: { ...subject, added: { costUsd: -1, tokens: 0, attempts: 2 } } }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...increase, subject: { ...subject, partition: "everything" } }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...increase, subject: { ...subject, runId: newId("run") } }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...increase, runId: null }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...increase, options: [{ id: "approve", label: "Approve", description: null }] }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...increase, options: [...increase.options, { id: "later", label: "Later", description: null }] }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...increase, resolutionPolicy: "use_default_after_deadline", recommendedOptionId: "approve", rationale: "x", deadlineAt: "2026-01-02T00:00:00.000Z" }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...increase, deadlineAt: "2026-01-02T00:00:00.000Z" }).success).toBe(false);
    expect(decisionRequestSchema.safeParse(request({ subject })).success).toBe(false);
    expect(() => budgetIncreaseSubjectOf({ id: newId("decision"), kind: "publish", subject })).toThrow(ValidationError);
  });

  it("use_default_after_deadline is operator_choice only and needs recommendation, deadline or condition, rationale, affected ids", () => {
    const complete = request({ resolutionPolicy: "use_default_after_deadline", deadlineAt: "2026-01-02T00:00:00.000Z", affects: { requirementIds: [], taskIds: [], planNodeIds: [newId("planNode")] } });
    expect(decisionRequestSchema.safeParse(complete).success).toBe(true);
    expect(decisionRequestSchema.safeParse({ ...complete, deadlineAt: null, activationCondition: { kind: "plan_node_ready", planNodeId: newId("planNode") } }).success).toBe(true);
    expect(decisionRequestSchema.safeParse({ ...complete, kind: "signoff" }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...complete, recommendedOptionId: null }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...complete, deadlineAt: null }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...complete, rationale: null }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...complete, affects: { requirementIds: [], taskIds: [], planNodeIds: [] } }).success).toBe(false);
    expect(decisionRequestSchema.safeParse(request({ deadlineAt: "2026-01-02T00:00:00.000Z" })).success).toBe(false);
  });

  it("the recommended option must be one of the options", () => {
    expect(decisionRequestSchema.safeParse(request({ recommendedOptionId: "zzz" })).success).toBe(false);
    expect(decisionRequestSchema.safeParse(request({ options: [{ id: "a", label: "A", description: null }, { id: "a", label: "A2", description: null }] })).success).toBe(false);
  });
});

describe("resolution rules", () => {
  const open = (overrides: Partial<Parameters<typeof assertDecisionResolutionRules>[0]> = {}) => ({
    kind: "operator_choice" as const,
    resolutionPolicy: "operator_required" as const,
    options: [
      { id: "a", label: "A", description: null },
      { id: "b", label: "B", description: null },
    ],
    recommendedOptionId: "a",
    status: "open" as const,
    ...overrides,
  });
  const by = (resolvedBy: "operator" | "orchestrator" | "policy:use_default_after_deadline", chosenOptionId = "a") => ({ resolvedBy, chosenOptionId, rationale: "ok", artifactIds: [] });

  it("only the operator resolves a requirement_waiver, side_effect_approval, signoff, publish, or budget_increase", () => {
    for (const kind of ["requirement_waiver", "side_effect_approval", "signoff", "publish", "budget_increase"] as const) {
      expect(() => assertDecisionResolutionRules(open({ kind }), by("operator"))).not.toThrow();
      expect(() => assertDecisionResolutionRules(open({ kind }), by("orchestrator"))).toThrow(ValidationError);
      expect(() => assertDecisionResolutionRules(open({ kind }), by("policy:use_default_after_deadline"))).toThrow(ValidationError);
    }
  });

  it("a waiver resolution records the operator's rationale", () => {
    expect(() => assertDecisionResolutionRules(open({ kind: "requirement_waiver" }), { ...by("operator"), rationale: null })).toThrow(/rationale/);
  });

  it("the Orchestrator resolves only orchestrator_choice; the operator does not resolve it", () => {
    expect(() => assertDecisionResolutionRules(open({ kind: "orchestrator_choice" }), by("orchestrator"))).not.toThrow();
    expect(() => assertDecisionResolutionRules(open({ kind: "operator_choice" }), by("orchestrator"))).toThrow(ValidationError);
    expect(() => assertDecisionResolutionRules(open({ kind: "orchestrator_choice" }), by("operator"))).toThrow(ValidationError);
  });

  it("policy resolution needs the policy and chooses the recommendation", () => {
    expect(() => assertDecisionResolutionRules(open(), by("policy:use_default_after_deadline"))).toThrow(/resolves by policy/);
    const policy = open({ resolutionPolicy: "use_default_after_deadline" });
    expect(() => assertDecisionResolutionRules(policy, by("policy:use_default_after_deadline", "b"))).toThrow(/recommended option/);
    expect(() => assertDecisionResolutionRules(policy, by("policy:use_default_after_deadline", "a"))).not.toThrow();
  });

  it("a resolved or superseded Decision cannot be resolved again; the option must exist", () => {
    expect(() => assertDecisionResolutionRules(open({ status: "resolved" }), by("operator"))).toThrow(/resolved Decision/);
    expect(() => assertDecisionResolutionRules(open({ status: "superseded" }), by("operator"))).toThrow(/superseded Decision/);
    expect(() => assertDecisionResolutionRules(open(), by("operator", "zzz"))).toThrow(/one of the Decision's options/);
  });
});
