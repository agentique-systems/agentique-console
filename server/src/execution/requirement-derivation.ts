/**
 * Requirement-status derivation from a `run_completion` Gate's Evaluations
 * (execution-model §8.1, §10; invariant 13): a pure function over the pinned
 * Requirement revision, the current statuses, each leaf's completion
 * criteria, and the Gate's recorded criterion Evaluations. It returns the
 * exact status changes the runtime records — leaves first, then internal
 * Requirements bottom-up from the pinned tree — and nothing for a
 * Requirement whose derived status equals its current one, so repeating the
 * derivation over the same rows writes nothing.
 *
 * Leaf rules: `waived` and `retired` are retained; every criterion `pass` →
 * `satisfied`; any `fail` or `inconclusive` → `violated`; no criterion or
 * criteria not all judged → the leaf stays open (a stale `satisfied` without
 * criteria returns to `open`); `infeasible` is retained, never derived from
 * a failed check. Parent rules follow the composition (`all`, `any`) over
 * the derived child statuses, `waived` counting as satisfied and `retired`
 * children ignored; a parent that is `waived` or `retired`, or whose derived
 * status the transition table refuses, is retained. Every change carries the
 * Evaluation Evidence that established it (a parent inherits its children's).
 */
import {
  deriveComposedStatus,
  REQUIREMENT_MACHINE,
  type AcceptanceCriterionId,
  type Evaluation,
  type Evidence,
  type RequirementId,
  type RequirementRevision,
  type RequirementStatus,
  type RequirementTreeEntry,
} from "@agentique-console/core";

export interface DerivedStatusChange {
  requirementId: RequirementId;
  from: RequirementStatus;
  to: RequirementStatus;
  evidence: Evidence[];
  rationale: string;
}

export interface RequirementDerivationInput {
  revision: RequirementRevision;
  /** The current status of every Requirement in the revision's tree. */
  statuses: ReadonlyMap<RequirementId, RequirementStatus>;
  /** The completion criteria of each leaf at the pinned revision, in id order. */
  criteriaByLeaf: ReadonlyMap<RequirementId, readonly AcceptanceCriterionId[]>;
  /** The Gate's recorded criterion Evaluations, by Acceptance Criterion id. */
  evaluations: ReadonlyMap<AcceptanceCriterionId, Evaluation>;
  /** The Evidence a Requirement's current status rests on (its latest history entry), for a parent whose child is retained. */
  currentEvidence: (requirementId: RequirementId) => Evidence[];
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function dedupe(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return evidence.filter((e) => {
    const key = JSON.stringify(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function deriveRequirementStatuses(input: RequirementDerivationInput): DerivedStatusChange[] {
  const { revision } = input;
  const children = new Map<RequirementId, RequirementTreeEntry[]>();
  for (const entry of revision.tree) {
    if (entry.parentId === null) continue;
    const list = children.get(entry.parentId) ?? [];
    list.push(entry);
    children.set(entry.parentId, list);
  }
  const next = new Map<RequirementId, RequirementStatus>();
  const evidenceOf = new Map<RequirementId, Evidence[]>();
  const changes: DerivedStatusChange[] = [];
  const statusOf = (id: RequirementId): RequirementStatus => {
    const status = input.statuses.get(id);
    if (status === undefined) throw new Error(`Requirement ${id} of revision ${revision.id} has no current status`);
    return status;
  };

  // Leaves, in id order.
  const leaves = revision.tree.filter((e) => !children.has(e.id)).sort(byId);
  for (const leaf of leaves) {
    const current = statusOf(leaf.id);
    next.set(leaf.id, current);
    evidenceOf.set(leaf.id, input.currentEvidence(leaf.id));
    if (current === "waived" || current === "retired" || current === "infeasible") continue;
    const criteria = input.criteriaByLeaf.get(leaf.id) ?? [];
    const judged = criteria.map((id) => input.evaluations.get(id) ?? null);
    const evidence: Evidence[] = judged.flatMap((e) => (e === null ? [] : [{ kind: "evaluation" as const, evaluationId: e.id }]));
    let derived: RequirementStatus;
    let rationale: string;
    if (criteria.length === 0) {
      derived = "open";
      rationale = "no Acceptance Criteria at the pinned Requirement revision";
    } else if (judged.some((e) => e !== null && e.verdict !== "pass")) {
      derived = "violated";
      rationale = "a completion criterion failed or was inconclusive";
    } else if (judged.every((e) => e !== null)) {
      derived = "satisfied";
      rationale = "every completion criterion passed at the run_completion Gate";
    } else {
      // Incomplete criteria: the leaf keeps its status.
      continue;
    }
    if (derived === current) continue;
    if (!REQUIREMENT_MACHINE.canTransition(current, derived)) continue;
    next.set(leaf.id, derived);
    evidenceOf.set(leaf.id, evidence);
    changes.push({ requirementId: leaf.id, from: current, to: derived, evidence, rationale });
  }

  // Internal Requirements bottom-up: deepest first, then by id, so every child is derived before its parent.
  const depthOf = (entry: RequirementTreeEntry): number => {
    let depth = 0;
    let cursor = entry.parentId;
    while (cursor !== null) {
      depth += 1;
      cursor = revision.tree.find((e) => e.id === cursor)?.parentId ?? null;
    }
    return depth;
  };
  const parents = revision.tree.filter((e) => children.has(e.id)).map((e) => ({ entry: e, depth: depthOf(e) })).sort((a, b) => b.depth - a.depth || (a.entry.id < b.entry.id ? -1 : 1));
  for (const { entry } of parents) {
    const current = statusOf(entry.id);
    next.set(entry.id, current);
    evidenceOf.set(entry.id, input.currentEvidence(entry.id));
    if (current === "waived" || current === "retired") continue;
    const kids = children.get(entry.id)!;
    const derived = deriveComposedStatus(entry.composition ?? "all", kids.map((k) => next.get(k.id)!));
    if (derived === current || derived === "retired") continue;
    if (!REQUIREMENT_MACHINE.canTransition(current, derived)) continue;
    const evidence = dedupe(kids.flatMap((k) => evidenceOf.get(k.id) ?? []));
    // Nothing to establish the derived status with: a status never rests on fabricated Evidence.
    if ((derived === "violated" || derived === "infeasible" || derived === "satisfied") && !evidence.some((e) => e.kind === "evaluation")) continue;
    next.set(entry.id, derived);
    evidenceOf.set(entry.id, evidence);
    changes.push({ requirementId: entry.id, from: current, to: derived, evidence, rationale: `derived from its ${entry.composition ?? "all"} children at the run_completion Gate` });
  }
  return changes;
}
