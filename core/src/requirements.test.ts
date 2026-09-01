import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.ts";
import { newId } from "./ids.ts";
import {
  acceptanceCriterionSchema,
  assertRequirementStatusChangeRules,
  deriveComposedStatus,
  expandRequirementRoots,
  REQUIREMENT_STATUSES,
  REQUIREMENT_TREE_MAX_ENTRIES,
  requirementTreeSchema,
  validateRequirementTree,
  type RequirementStatusChangeInput,
  type RequirementTreeEntry,
} from "./requirements.ts";

const r = () => newId("requirement");

describe("requirement tree", () => {
  it("validates composition on internal nodes and leaves", () => {
    const root = r();
    const a = r();
    const b = r();
    const tree: RequirementTreeEntry[] = [
      { id: root, parentId: null, composition: "all", statement: "root", position: 0, acceptanceCriterionIds: [] },
      { id: a, parentId: root, composition: null, statement: "a", position: 0, acceptanceCriterionIds: [] },
      { id: b, parentId: root, composition: null, statement: "b", position: 1, acceptanceCriterionIds: [] },
    ];
    expect(validateRequirementTree(tree)).toBe(tree);
    expect(expandRequirementRoots(tree, [root])).toEqual([a, b]);
    expect(expandRequirementRoots(tree, [a])).toEqual([a]);
    expect(() => expandRequirementRoots(tree, [r()])).toThrow(ValidationError);
  });

  it("bounds a revision's tree at REQUIREMENT_TREE_MAX_ENTRIES entries, so a whole-tree read is a bounded read", () => {
    const rootId = newId("requirement");
    const leaves = (count: number) => Array.from({ length: count }, (_, i) => ({ id: newId("requirement"), parentId: rootId, composition: null, statement: `Leaf ${i}`, position: i + 1, acceptanceCriterionIds: [] }));
    const root = { id: rootId, parentId: null, composition: "all" as const, statement: "Everything", position: 0, acceptanceCriterionIds: [] };
    expect(requirementTreeSchema.safeParse([root, ...leaves(REQUIREMENT_TREE_MAX_ENTRIES - 1)]).success).toBe(true);
    expect(requirementTreeSchema.safeParse([root, ...leaves(REQUIREMENT_TREE_MAX_ENTRIES)]).success).toBe(false);
  });

  it("rejects duplicates, dangling parents, cycles, and mis-declared composition", () => {
    const x = r();
    const y = r();
    expect(() => validateRequirementTree([{ id: x, parentId: null, composition: null, statement: "x", position: 0, acceptanceCriterionIds: [] }, { id: x, parentId: null, composition: null, statement: "x", position: 1, acceptanceCriterionIds: [] }])).toThrow(/twice/);
    expect(() => validateRequirementTree([{ id: x, parentId: y, composition: null, statement: "x", position: 0, acceptanceCriterionIds: [] }])).toThrow(/outside the tree/);
    expect(() =>
      validateRequirementTree([
        { id: x, parentId: y, composition: "all", statement: "x", position: 0, acceptanceCriterionIds: [] },
        { id: y, parentId: x, composition: "all", statement: "y", position: 0, acceptanceCriterionIds: [] },
      ]),
    ).toThrow(/cycle/);
    expect(() =>
      validateRequirementTree([
        { id: x, parentId: null, composition: null, statement: "x", position: 0, acceptanceCriterionIds: [] },
        { id: y, parentId: x, composition: null, statement: "y", position: 0, acceptanceCriterionIds: [] },
      ]),
    ).toThrow(/must declare a composition/);
    expect(() => validateRequirementTree([{ id: x, parentId: null, composition: "any", statement: "x", position: 0, acceptanceCriterionIds: [] }])).toThrow(/leaf/);
  });
});

describe("derived status", () => {
  it("uses the exact six statuses and treats waived as satisfied for derivation", () => {
    expect(REQUIREMENT_STATUSES).toEqual(["open", "satisfied", "violated", "infeasible", "waived", "retired"]);
    expect(deriveComposedStatus("all", ["satisfied", "waived"])).toBe("satisfied");
    expect(deriveComposedStatus("all", ["satisfied", "open"])).toBe("open");
    expect(deriveComposedStatus("all", ["satisfied", "violated"])).toBe("violated");
    expect(deriveComposedStatus("all", ["infeasible", "open"])).toBe("infeasible");
    expect(deriveComposedStatus("any", ["violated", "waived"])).toBe("satisfied");
    expect(deriveComposedStatus("any", ["violated", "open"])).toBe("open");
    expect(deriveComposedStatus("any", ["violated", "infeasible"])).toBe("violated");
    expect(deriveComposedStatus("any", ["infeasible"])).toBe("infeasible");
    expect(deriveComposedStatus("all", ["retired", "satisfied"])).toBe("satisfied");
    expect(deriveComposedStatus("all", ["retired"])).toBe("retired");
    expect(deriveComposedStatus("all", [])).toBe("open");
  });
});

describe("status change rules", () => {
  const base: Omit<RequirementStatusChangeInput, "to" | "actor"> = { requirementId: r(), runId: null, evidence: [], gateId: null, decisionId: null, rationale: null };

  it("satisfied requires the runtime, a Gate, and Evaluation Evidence", () => {
    expect(() => assertRequirementStatusChangeRules({ ...base, to: "satisfied", actor: "orchestrator" })).toThrow(/Gate result/);
    expect(() => assertRequirementStatusChangeRules({ ...base, to: "satisfied", actor: "runtime" })).toThrow(/Gate result/);
    expect(() => assertRequirementStatusChangeRules({ ...base, to: "satisfied", actor: "runtime", gateId: newId("gate") })).toThrow(/Evaluation Evidence/);
    expect(() =>
      assertRequirementStatusChangeRules({ ...base, to: "satisfied", actor: "runtime", gateId: newId("gate"), evidence: [{ kind: "evaluation", evaluationId: newId("evaluation") }] }),
    ).not.toThrow();
  });

  it("waived requires the operator and a Decision; no automatic waiver exists", () => {
    expect(() => assertRequirementStatusChangeRules({ ...base, to: "waived", actor: "runtime", decisionId: newId("decision") })).toThrow(/operator resolves/);
    expect(() => assertRequirementStatusChangeRules({ ...base, to: "waived", actor: "orchestrator", decisionId: newId("decision") })).toThrow(/operator resolves/);
    expect(() => assertRequirementStatusChangeRules({ ...base, to: "waived", actor: "operator" })).toThrow(/requirement_waiver Decision/);
    expect(() => assertRequirementStatusChangeRules({ ...base, to: "waived", actor: "operator", decisionId: newId("decision") })).not.toThrow();
  });

  it("violated and infeasible need Evidence", () => {
    expect(() => assertRequirementStatusChangeRules({ ...base, to: "violated", actor: "operator" })).toThrow(/Evidence/);
    expect(() => assertRequirementStatusChangeRules({ ...base, to: "infeasible", actor: "orchestrator", evidence: [{ kind: "artifact", artifactId: newId("artifact") }] })).not.toThrow();
  });
});

describe("acceptance criterion", () => {
  it("attaches to exactly one Requirement (pinned) or one Task", () => {
    const base = { id: newId("acceptanceCriterion"), conversationId: newId("conversation"), check: { kind: "deterministic", command: "npm test", expectedExitCode: 0 }, createdAt: "2026-01-01T00:00:00.000Z" };
    expect(acceptanceCriterionSchema.safeParse({ ...base, requirementId: r(), requirementRevisionId: newId("requirementRevision"), taskId: null }).success).toBe(true);
    expect(acceptanceCriterionSchema.safeParse({ ...base, requirementId: null, requirementRevisionId: null, taskId: newId("task") }).success).toBe(true);
    expect(acceptanceCriterionSchema.safeParse({ ...base, requirementId: r(), requirementRevisionId: null, taskId: null }).success).toBe(false);
    expect(acceptanceCriterionSchema.safeParse({ ...base, requirementId: r(), requirementRevisionId: newId("requirementRevision"), taskId: newId("task") }).success).toBe(false);
    expect(acceptanceCriterionSchema.safeParse({ ...base, requirementId: null, requirementRevisionId: null, taskId: null }).success).toBe(false);
    expect(acceptanceCriterionSchema.safeParse({ ...base, requirementId: null, requirementRevisionId: null, taskId: newId("task"), check: { kind: "manual" } }).success).toBe(false);
  });
});
