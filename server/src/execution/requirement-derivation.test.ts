/**
 * Requirement-status derivation from a run_completion Gate's Evaluations
 * (execution-model §8.1, §10; invariant 13): a pure function over rows —
 * leaves from their criteria's verdicts, parents bottom-up from their
 * children, `waived`/`retired`/`infeasible` retained, every change carrying
 * the Evaluation Evidence that established it, and no change at all for a
 * status that already holds.
 */
import type { AcceptanceCriterionId, Evaluation, Evidence, RequirementId, RequirementRevision, RequirementStatus, RequirementTreeEntry } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { deriveRequirementStatuses } from "./requirement-derivation.ts";

const id = (n: number) => `req_${n.toString(16).padStart(24, "0")}` as RequirementId;
const ac = (n: number) => `ac_${n.toString(16).padStart(24, "0")}` as AcceptanceCriterionId;
const ev = (n: number) => `eval_${n.toString(16).padStart(24, "0")}`;
const proof = (n: number): Evidence => ({ kind: "evaluation", evaluationId: ev(n) as never });

function entry(requirementId: RequirementId, parentId: RequirementId | null, composition: "all" | "any" | null = null): RequirementTreeEntry {
  return { id: requirementId, parentId, composition, statement: `requirement ${requirementId}`, position: 0, acceptanceCriterionIds: [] };
}

function revision(tree: RequirementTreeEntry[]): RequirementRevision {
  return { id: "rrev_000000000000000000000000", tree } as unknown as RequirementRevision;
}

function evaluation(n: number, verdict: Evaluation["verdict"]): Evaluation {
  return { id: ev(n), verdict } as unknown as Evaluation;
}

function derive(options: { tree: RequirementTreeEntry[]; statuses: Record<string, RequirementStatus>; criteria?: Record<string, AcceptanceCriterionId[]>; evaluations?: [AcceptanceCriterionId, Evaluation][]; currentEvidence?: Record<string, Evidence[]> }) {
  return deriveRequirementStatuses({
    revision: revision(options.tree),
    statuses: new Map(Object.entries(options.statuses) as [RequirementId, RequirementStatus][]),
    criteriaByLeaf: new Map(Object.entries(options.criteria ?? {}) as [RequirementId, AcceptanceCriterionId[]][]),
    evaluations: new Map(options.evaluations ?? []),
    currentEvidence: (requirementId) => options.currentEvidence?.[requirementId] ?? [],
  });
}

describe("deriveRequirementStatuses", () => {
  it("satisfies a leaf whose criteria all passed, violates one with any failed or inconclusive verdict, and references exactly the establishing Evaluations", () => {
    const changes = derive({
      tree: [entry(id(1), null), entry(id(2), null), entry(id(3), null)],
      statuses: { [id(1)]: "open", [id(2)]: "open", [id(3)]: "open" },
      criteria: { [id(1)]: [ac(1), ac(2)], [id(2)]: [ac(3), ac(4)], [id(3)]: [ac(5)] },
      evaluations: [
        [ac(1), evaluation(1, "pass")],
        [ac(2), evaluation(2, "pass")],
        [ac(3), evaluation(3, "pass")],
        [ac(4), evaluation(4, "fail")],
        [ac(5), evaluation(5, "inconclusive")],
      ],
    });
    expect(changes).toEqual([
      { requirementId: id(1), from: "open", to: "satisfied", evidence: [{ kind: "evaluation", evaluationId: ev(1) }, { kind: "evaluation", evaluationId: ev(2) }], rationale: expect.stringContaining("passed") },
      { requirementId: id(2), from: "open", to: "violated", evidence: [{ kind: "evaluation", evaluationId: ev(3) }, { kind: "evaluation", evaluationId: ev(4) }], rationale: expect.stringContaining("failed") },
      { requirementId: id(3), from: "open", to: "violated", evidence: [{ kind: "evaluation", evaluationId: ev(5) }], rationale: expect.stringContaining("failed") },
    ]);
  });

  it("keeps a leaf without criteria open (a stale satisfied returns to open), retains waived, retired, and infeasible leaves, and leaves incomplete criteria alone", () => {
    const changes = derive({
      tree: [entry(id(1), null), entry(id(2), null), entry(id(3), null), entry(id(4), null), entry(id(5), null), entry(id(6), null)],
      statuses: { [id(1)]: "open", [id(2)]: "satisfied", [id(3)]: "waived", [id(4)]: "retired", [id(5)]: "infeasible", [id(6)]: "open" },
      criteria: { [id(3)]: [ac(1)], [id(4)]: [ac(2)], [id(5)]: [ac(3)], [id(6)]: [ac(4), ac(5)] },
      evaluations: [
        [ac(1), evaluation(1, "fail")],
        [ac(2), evaluation(2, "pass")],
        [ac(3), evaluation(3, "pass")],
        [ac(4), evaluation(4, "pass")],
      ],
    });
    expect(changes).toEqual([{ requirementId: id(2), from: "satisfied", to: "open", evidence: [], rationale: expect.stringContaining("no Acceptance Criteria") }]);
  });

  it("derives parents bottom-up under all and any, inheriting the children's Evaluation Evidence, and writes nothing for a parent whose status already holds", () => {
    // root(all) → a(any) → [a1, a2]; root → b(all) → [b1, b2 retired].
    const tree = [entry(id(1), null, "all"), entry(id(2), id(1), "any"), entry(id(3), id(2)), entry(id(4), id(2)), entry(id(5), id(1), "all"), entry(id(6), id(5)), entry(id(7), id(5))];
    const changes = derive({
      tree,
      statuses: { [id(1)]: "open", [id(2)]: "open", [id(3)]: "open", [id(4)]: "open", [id(5)]: "satisfied", [id(6)]: "satisfied", [id(7)]: "retired" },
      criteria: { [id(3)]: [ac(1)], [id(4)]: [ac(2)], [id(6)]: [ac(3)] },
      evaluations: [
        [ac(1), evaluation(1, "fail")],
        [ac(2), evaluation(2, "pass")],
        [ac(3), evaluation(3, "pass")],
      ],
      currentEvidence: { [id(6)]: [proof(30)], [id(5)]: [proof(30)] },
    });
    expect(changes.map((c) => [c.requirementId, c.from, c.to])).toEqual([
      [id(3), "open", "violated"],
      [id(4), "open", "satisfied"],
      [id(2), "open", "satisfied"],
      [id(1), "open", "satisfied"],
    ]);
    // `a` (any) is satisfied by a2 alone but carries both children's Evidence; the root inherits a's and b's (b retained with its current Evidence).
    expect(changes[2]!.evidence).toEqual([{ kind: "evaluation", evaluationId: ev(1) }, { kind: "evaluation", evaluationId: ev(2) }]);
    expect(changes[3]!.evidence).toEqual([{ kind: "evaluation", evaluationId: ev(1) }, { kind: "evaluation", evaluationId: ev(2) }, { kind: "evaluation", evaluationId: ev(30) }]);
    // Repeating the derivation over the recorded statuses changes nothing.
    const again = derive({
      tree,
      statuses: { [id(1)]: "satisfied", [id(2)]: "satisfied", [id(3)]: "violated", [id(4)]: "satisfied", [id(5)]: "satisfied", [id(6)]: "satisfied", [id(7)]: "retired" },
      criteria: { [id(3)]: [ac(1)], [id(4)]: [ac(2)], [id(6)]: [ac(3)] },
      evaluations: [
        [ac(1), evaluation(1, "fail")],
        [ac(2), evaluation(2, "pass")],
        [ac(3), evaluation(3, "pass")],
      ],
    });
    expect(again).toEqual([]);
  });

  it("violates an all-parent when any child is violated, retains a waived parent, and never rests a derived status on fabricated Evidence", () => {
    const tree = [entry(id(1), null, "all"), entry(id(2), id(1)), entry(id(3), id(1)), entry(id(4), null, "all"), entry(id(5), id(4)), entry(id(6), null, "all"), entry(id(7), id(6))];
    const changes = derive({
      tree,
      statuses: { [id(1)]: "satisfied", [id(2)]: "open", [id(3)]: "satisfied", [id(4)]: "waived", [id(5)]: "open", [id(6)]: "open", [id(7)]: "infeasible" },
      criteria: { [id(2)]: [ac(1)], [id(3)]: [ac(2)], [id(5)]: [ac(3)] },
      evaluations: [
        [ac(1), evaluation(1, "fail")],
        [ac(2), evaluation(2, "pass")],
        [ac(3), evaluation(3, "pass")],
      ],
      currentEvidence: { [id(3)]: [proof(2)] },
    });
    // id(6)'s only child is infeasible (retained) on no Evidence at all: the parent's infeasible status is not derived from nothing.
    expect(changes.map((c) => [c.requirementId, c.from, c.to])).toEqual([
      [id(2), "open", "violated"],
      [id(5), "open", "satisfied"],
      [id(1), "satisfied", "violated"],
    ]);
    expect(changes[2]!.evidence).toEqual([{ kind: "evaluation", evaluationId: ev(1) }, { kind: "evaluation", evaluationId: ev(2) }]);
  });

  it("throws on a Requirement of the revision without a current status rather than guessing one", () => {
    expect(() => derive({ tree: [entry(id(1), null)], statuses: {} })).toThrow(/no current status/);
  });
});
