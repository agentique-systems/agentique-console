/**
 * The coverage evaluator: obligation classification, the typed exception
 * vocabulary, and the boundaries that keep sign-off exception-oriented
 * without punishing harmless bookkeeping. Pure-deps tests — every fact is a
 * literal, so each rule is provable in isolation.
 */
import { describe, expect, it } from "vitest";
import type {
  ChangeImpactWire,
  CoverageObligation,
  DecisionIssueWire,
  Task,
  WorkstreamLinkWire,
} from "@agentique-console/shared";
import { computeCoverageReport, type CoverageDeps } from "./coverage.ts";

const obligation = (partial: Partial<CoverageObligation> & { requirementId: string }): CoverageObligation => ({
  statement: `statement for ${partial.requirementId}`,
  state: "satisfied",
  stale: false,
  claim: { verifiedBy: "self", actor: "main", at: "2026-08-25T00:00:00Z", evidence: [{ kind: "command", ref: "npm test" }] },
  verification: null,
  ...partial,
});

const task = (partial: Partial<Task> & { id: string }): Task => ({
  sdkSessionId: "sdk1", sdkTaskId: partial.id, workspaceId: "ws1", userSessionId: "us1",
  agentSessionId: "as1", agent: "dev", subject: `subject of ${partial.id}`, description: "",
  activeForm: null, status: "pending", owner: null, requirementId: null,
  blocks: [], blockedBy: [], dependencyIds: [], dependentIds: [], ready: true,
  scheduledAssignment: null, metadata: {}, createdAt: "2026-08-25T00:00:00Z", updatedAt: "2026-08-25T00:00:00Z",
  ...partial,
});

const issue = (partial: Partial<DecisionIssueWire> & { id: string }): DecisionIssueWire => ({
  issueKey: null, subject: `subject of ${partial.id}`, status: "open", provisional: false,
  requirementIds: [], asks: [], blockingAsksActive: 0, pendingAsksActive: 0,
  resolutions: [], resolution: null, supersededById: null, createdBy: "main",
  createdAt: "2026-08-25T00:00:00Z", resolvedAt: null,
  ...partial,
});

function makeDeps(overrides: Partial<CoverageDeps> = {}): CoverageDeps {
  return {
    governingRevision: () => 3,
    obligations: () => [],
    liveRequirementIds: () => new Set(["r1", "r2", "r3"]),
    listTasks: () => [],
    listOpenDecisionIssues: () => [],
    listOpenChangeImpacts: () => [],
    brokenWorkstreamLinks: () => [],
    invalidatedLandings: () => [],
    isAgentSessionOpen: () => true,
    policy: "waiver_required",
    ...overrides,
  };
}

describe("computeCoverageReport", () => {
  it("is null when no requirement revision governs — nothing to account against", () => {
    expect(computeCoverageReport(makeDeps({ governingRevision: () => null }), "us1")).toBeNull();
  });

  it("is ready with zero exceptions when every obligation is satisfied, current, and evidenced", () => {
    const report = computeCoverageReport(makeDeps({
      obligations: () => [obligation({ requirementId: "r1" }), obligation({ requirementId: "r2" })],
    }), "us1")!;
    expect(report).toMatchObject({ revision: 3, policy: "waiver_required", readiness: "ready", exceptions: [] });
    expect(report.counts).toEqual({ satisfied: 2, open: 0, violated: 0, infeasible: 0, moot: 0, stale: 0 });
    expect(report.obligations).toHaveLength(2);
  });

  it("types an open or violated required leaf as requirement_unsatisfied", () => {
    const report = computeCoverageReport(makeDeps({
      obligations: () => [
        obligation({ requirementId: "r1", state: "open", claim: null }),
        obligation({ requirementId: "r2", state: "violated" }),
      ],
    }), "us1")!;
    expect(report.exceptions).toMatchObject([
      { kind: "requirement_unsatisfied", ref: "r1" },
      { kind: "requirement_unsatisfied", ref: "r2" },
    ]);
    expect(report.readiness).toBe("ready_with_exceptions");
  });

  it("never treats a stale terminal claim as current — satisfied AND infeasible alike", () => {
    const report = computeCoverageReport(makeDeps({
      obligations: () => [
        obligation({ requirementId: "r1", stale: true }),
        obligation({ requirementId: "r2", state: "infeasible", stale: true }),
      ],
    }), "us1")!;
    expect(report.exceptions).toMatchObject([
      { kind: "requirement_stale", ref: "r1" },
      { kind: "requirement_stale", ref: "r2" },
    ]);
    expect(report.counts.stale).toBe(2);
  });

  it("keeps a current infeasible obligation distinct from satisfied and never an exception", () => {
    const report = computeCoverageReport(makeDeps({
      obligations: () => [obligation({ requirementId: "r1", state: "infeasible" })],
    }), "us1")!;
    expect(report.counts).toMatchObject({ infeasible: 1, satisfied: 0 });
    expect(report.exceptions).toEqual([]);
  });

  it("surfaces a satisfied leaf below its declared verification tier — never indistinguishable from a met one", () => {
    const report = computeCoverageReport(makeDeps({
      obligations: () => [
        obligation({ requirementId: "r1", verification: { expected: "independent", met: false } }),
        obligation({ requirementId: "r2", verification: { expected: "independent", met: true } }),
      ],
    }), "us1")!;
    expect(report.exceptions).toMatchObject([{ kind: "verification_below_declared", ref: "r1" }]);
  });

  it("flags an evidence-less non-operator terminal claim; the operator's own word is exempt", () => {
    const report = computeCoverageReport(makeDeps({
      obligations: () => [
        obligation({ requirementId: "r1", claim: { verifiedBy: "self", actor: "main", at: "2026-08-25T00:00:00Z", evidence: [] } }),
        obligation({ requirementId: "r2", claim: { verifiedBy: "operator", actor: "operator", at: "2026-08-25T00:00:00Z", evidence: [] } }),
      ],
    }), "us1")!;
    expect(report.exceptions).toMatchObject([{ kind: "evidence_missing", ref: "r1" }]);
  });

  it("accounts a moot leaf without ever raising an exception for it", () => {
    const report = computeCoverageReport(makeDeps({
      obligations: () => [
        obligation({ requirementId: "r1" }),
        obligation({ requirementId: "r2", state: "moot", stale: true, claim: null }),
      ],
    }), "us1")!;
    expect(report.counts.moot).toBe(1);
    expect(report.exceptions).toEqual([]);
  });

  it("types open tasks discharging a LIVE requirement as task_debt; stale bookkeeping never blocks", () => {
    const report = computeCoverageReport(makeDeps({
      listTasks: () => [
        // Required debt: open, linked live, session open.
        task({ id: "t1", requirementId: "r1", status: "in_progress" }),
        // Main's own ledger counts too.
        task({ id: "t2", requirementId: "r2", agentSessionId: null, agent: null }),
        // Linked to a requirement that is no longer live (retired): not debt.
        task({ id: "t3", requirementId: "r99" }),
        // Unlinked open task: existing advisory surfaces carry it, not coverage.
        task({ id: "t4" }),
        // Completed and deleted: nothing owed.
        task({ id: "t5", requirementId: "r1", status: "completed" }),
        task({ id: "t6", requirementId: "r1", status: "deleted" }),
        // Archived session: nobody claims the work any more.
        task({ id: "t7", requirementId: "r1", agentSessionId: "as-archived" }),
      ],
      isAgentSessionOpen: (agentSessionId) => agentSessionId !== "as-archived",
    }), "us1")!;
    expect(report.exceptions).toMatchObject([
      { kind: "task_debt", ref: "t1" },
      { kind: "task_debt", ref: "t2" },
    ]);
  });

  it("types a provisionally-proceeded open decision as an exception; an inactive open one stays advisory", () => {
    const report = computeCoverageReport(makeDeps({
      listOpenDecisionIssues: () => [
        issue({ id: "di1", provisional: true, requirementIds: ["r1"] }),
        issue({ id: "di2" }),
      ],
    }), "us1")!;
    expect(report.exceptions).toMatchObject([{ kind: "decision_provisional", ref: "di1" }]);
    expect(report.advisories).toHaveLength(1);
    expect(report.advisories[0]).toContain("di2");
  });

  it("types an unreachable landed result as landing_invalidated — 'landed' must not outlive the reset", () => {
    const report = computeCoverageReport(makeDeps({
      invalidatedLandings: () => [{
        id: "land_1", agentSessionId: "as1", agent: "canon", mergeCommit: "abcdef1234567890",
        invalidatedReason: "merge commit abcdef123456 is no longer reachable from workspace HEAD 987654321000",
        salvageRef: "agentique/archive/landing/as1/canon",
      }],
    }), "us1")!;
    expect(report.exceptions).toMatchObject([{ kind: "landing_invalidated", ref: "land_1" }]);
    expect(report.exceptions[0]!.detail).toContain("no longer in the canonical workspace");
    expect(report.exceptions[0]!.detail).toContain("agentique/archive/landing/as1/canon");
  });

  it("records reconciliation state for audit and tail reads", () => {
    const report = computeCoverageReport(makeDeps({
      listOpenChangeImpacts: () => [{} as ChangeImpactWire],
      brokenWorkstreamLinks: () => [{} as WorkstreamLinkWire, {} as WorkstreamLinkWire],
    }), "us1")!;
    expect(report.reconciliation).toEqual({ openChangeImpacts: 1, brokenWorkstreamLinks: 2 });
  });

  it("snapshots the policy in force", () => {
    const report = computeCoverageReport(makeDeps({ policy: "advisory" }), "us1")!;
    expect(report.policy).toBe("advisory");
  });
});
