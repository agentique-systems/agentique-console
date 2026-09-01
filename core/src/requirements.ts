import { z } from "zod";
import { ValidationError } from "./errors.ts";
import type {
  AcceptanceCriterionId,
  ArtifactId,
  ConversationId,
  DecisionId,
  EvaluationId,
  GateId,
  RequirementId,
  RequirementRevisionId,
  RunId,
  SnapshotId,
  TaskId,
} from "./ids.ts";
import { defineStateMachine } from "./transitions.ts";
import { idSchema, nonEmptyString, positiveCount, timestampSchema, uniqueIds, type Timestamp } from "./validation.ts";

export const REQUIREMENT_STATUSES = ["open", "satisfied", "violated", "infeasible", "waived", "retired"] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const REQUIREMENT_COMPOSITIONS = ["all", "any"] as const;
export type RequirementComposition = (typeof REQUIREMENT_COMPOSITIONS)[number];

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** A reference to a verifiable fact; never free text. */
export type Evidence =
  | { kind: "artifact"; artifactId: ArtifactId }
  /**
   * A command the runtime ran and its captured output Artifact. `outputTruncated` records canonically that the stored
   * output is a bounded prefix of what the command produced; it is never left implicit.
   */
  | { kind: "command"; command: string; exitCode: number; outputArtifactId: ArtifactId; outputTruncated?: boolean }
  | { kind: "evaluation"; evaluationId: EvaluationId }
  | { kind: "file"; path: string; snapshotId: SnapshotId }
  | { kind: "snapshot"; snapshotId: SnapshotId }
  | { kind: "url"; url: string };

export const evidenceSchema: z.ZodType<Evidence> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("artifact"), artifactId: idSchema("artifact") }),
  z.strictObject({
    kind: z.literal("command"),
    command: nonEmptyString,
    exitCode: z.number().int(),
    outputArtifactId: idSchema("artifact"),
    outputTruncated: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal("evaluation"), evaluationId: idSchema("evaluation") }),
  z.strictObject({ kind: z.literal("file"), path: nonEmptyString, snapshotId: idSchema("snapshot") }),
  z.strictObject({ kind: z.literal("snapshot"), snapshotId: idSchema("snapshot") }),
  z.strictObject({ kind: z.literal("url"), url: z.url() }),
]);

// ---------------------------------------------------------------------------
// Revisions (the tree at a point in time)
// ---------------------------------------------------------------------------

/** One Requirement's position and statement inside a revision's tree. */
export interface RequirementTreeEntry {
  id: RequirementId;
  parentId: RequirementId | null;
  /** Non-null exactly for internal nodes, which compose their children. */
  composition: RequirementComposition | null;
  statement: string;
  position: number;
  acceptanceCriterionIds: AcceptanceCriterionId[];
}

export const requirementTreeEntrySchema: z.ZodType<RequirementTreeEntry> = z.strictObject({
  id: idSchema("requirement"),
  parentId: idSchema("requirement").nullable(),
  composition: z.enum(REQUIREMENT_COMPOSITIONS).nullable(),
  statement: nonEmptyString,
  position: z.number().int().min(0),
  acceptanceCriterionIds: uniqueIds(idSchema("acceptanceCriterion")),
});

/**
 * Validates a tree: unique ids, parents that exist, no cycles, composition
 * present exactly on nodes that have children.
 */
export function validateRequirementTree(entries: RequirementTreeEntry[]): RequirementTreeEntry[] {
  const byId = new Map<RequirementId, RequirementTreeEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new ValidationError(`requirement ${entry.id} appears twice in the tree`);
    byId.set(entry.id, entry);
  }
  const childCount = new Map<RequirementId, number>();
  for (const entry of entries) {
    if (entry.parentId !== null) {
      if (!byId.has(entry.parentId)) {
        throw new ValidationError(`requirement ${entry.id} names a parent ${entry.parentId} outside the tree`);
      }
      childCount.set(entry.parentId, (childCount.get(entry.parentId) ?? 0) + 1);
    }
  }
  for (const entry of entries) {
    const children = childCount.get(entry.id) ?? 0;
    if (children > 0 && entry.composition === null) {
      throw new ValidationError(`requirement ${entry.id} has children and must declare a composition`);
    }
    if (children === 0 && entry.composition !== null) {
      throw new ValidationError(`requirement ${entry.id} is a leaf and cannot declare a composition`);
    }
    // Cycle check by walking to the root.
    const seen = new Set<RequirementId>([entry.id]);
    let cursor = entry.parentId;
    while (cursor !== null) {
      if (seen.has(cursor)) throw new ValidationError(`requirement ${entry.id} is part of a parent cycle`);
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
    }
  }
  return entries;
}

/**
 * The most entries one Requirement revision's tree may hold. The tree is one
 * immutable JSON value read whole; this bound is what makes a whole-tree
 * read a bounded read (execution-model §6.4 `read_requirements`).
 */
export const REQUIREMENT_TREE_MAX_ENTRIES = 1_000;

export const requirementTreeSchema = z
  .array(requirementTreeEntrySchema)
  .max(REQUIREMENT_TREE_MAX_ENTRIES, { message: `a Requirement revision holds at most ${REQUIREMENT_TREE_MAX_ENTRIES} entries` })
  .transform((entries) => validateRequirementTree(entries));

/** The leaf Requirement ids under `rootIds` (inclusive when a root is a leaf). */
export function expandRequirementRoots(tree: RequirementTreeEntry[], rootIds: RequirementId[]): RequirementId[] {
  const children = new Map<RequirementId, RequirementTreeEntry[]>();
  const byId = new Map<RequirementId, RequirementTreeEntry>();
  for (const entry of tree) {
    byId.set(entry.id, entry);
    if (entry.parentId !== null) {
      const list = children.get(entry.parentId) ?? [];
      list.push(entry);
      children.set(entry.parentId, list);
    }
  }
  const leaves = new Set<RequirementId>();
  const visit = (id: RequirementId): void => {
    const entry = byId.get(id);
    if (!entry) throw new ValidationError(`requirement root ${id} does not exist in the revision`);
    const kids = children.get(id) ?? [];
    if (kids.length === 0) {
      leaves.add(id);
      return;
    }
    for (const kid of [...kids].sort((a, b) => a.position - b.position)) visit(kid.id);
  };
  for (const root of rootIds) visit(root);
  return [...leaves];
}

export interface RequirementRevision {
  id: RequirementRevisionId;
  conversationId: ConversationId;
  number: number;
  /** The operator Decision that approved this revision, when one was recorded. */
  approvedByDecisionId: DecisionId | null;
  tree: RequirementTreeEntry[];
  createdAt: Timestamp;
}

export const requirementRevisionSchema: z.ZodType<RequirementRevision> = z.strictObject({
  id: idSchema("requirementRevision"),
  conversationId: idSchema("conversation"),
  number: positiveCount,
  approvedByDecisionId: idSchema("decision").nullable(),
  tree: requirementTreeSchema,
  createdAt: timestampSchema,
}) as unknown as z.ZodType<RequirementRevision>;

// ---------------------------------------------------------------------------
// Requirement (stable id, current status)
// ---------------------------------------------------------------------------

export interface Requirement {
  id: RequirementId;
  conversationId: ConversationId;
  status: RequirementStatus;
  createdInRevisionId: RequirementRevisionId;
  retiredInRevisionId: RequirementRevisionId | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export const requirementSchema: z.ZodType<Requirement> = z
  .strictObject({
    id: idSchema("requirement"),
    conversationId: idSchema("conversation"),
    status: z.enum(REQUIREMENT_STATUSES),
    createdInRevisionId: idSchema("requirementRevision"),
    retiredInRevisionId: idSchema("requirementRevision").nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .refine((r) => (r.status === "retired") === (r.retiredInRevisionId !== null), {
    message: "retiredInRevisionId is set exactly when the Requirement is retired",
    path: ["retiredInRevisionId"],
  });

export const REQUIREMENT_MACHINE = defineStateMachine<RequirementStatus>("Requirement", REQUIREMENT_STATUSES, {
  open: ["satisfied", "violated", "infeasible", "waived", "retired"],
  satisfied: ["open", "violated", "retired"],
  violated: ["open", "satisfied", "infeasible", "waived", "retired"],
  infeasible: ["open", "waived", "retired"],
  waived: ["open", "retired"],
  retired: [],
});

/** Derives a parent status from its children under `all` or `any`; `waived` counts as satisfied. */
export function deriveComposedStatus(
  composition: RequirementComposition,
  children: readonly RequirementStatus[],
): RequirementStatus {
  const live = children.filter((s) => s !== "retired");
  if (live.length === 0) return children.length === 0 ? "open" : "retired";
  const ok = (s: RequirementStatus) => s === "satisfied" || s === "waived";
  if (composition === "all") {
    if (live.some((s) => s === "violated")) return "violated";
    if (live.some((s) => s === "infeasible")) return "infeasible";
    return live.every(ok) ? "satisfied" : "open";
  }
  if (live.some(ok)) return "satisfied";
  if (live.every((s) => s === "violated" || s === "infeasible")) {
    return live.some((s) => s === "violated") ? "violated" : "infeasible";
  }
  return "open";
}

export const REQUIREMENT_STATUS_ACTORS = ["runtime", "operator", "orchestrator"] as const;
export type RequirementStatusActor = (typeof REQUIREMENT_STATUS_ACTORS)[number];

/** One append-only entry of a Requirement's status history. */
export interface RequirementStatusChange {
  seq: number;
  requirementId: RequirementId;
  conversationId: ConversationId;
  runId: RunId | null;
  from: RequirementStatus;
  to: RequirementStatus;
  actor: RequirementStatusActor;
  evidence: Evidence[];
  /** The Gate whose Evaluations established `satisfied` or `violated`. */
  gateId: GateId | null;
  /** The operator-resolved `requirement_waiver` Decision that established `waived`. */
  decisionId: DecisionId | null;
  rationale: string | null;
  createdAt: Timestamp;
}

export interface RequirementStatusChangeInput {
  requirementId: RequirementId;
  runId: RunId | null;
  to: RequirementStatus;
  actor: RequirementStatusActor;
  evidence: Evidence[];
  gateId: GateId | null;
  decisionId: DecisionId | null;
  rationale: string | null;
}

export const requirementStatusChangeInputSchema: z.ZodType<RequirementStatusChangeInput> = z.strictObject({
  requirementId: idSchema("requirement"),
  runId: idSchema("run").nullable(),
  to: z.enum(REQUIREMENT_STATUSES),
  actor: z.enum(REQUIREMENT_STATUS_ACTORS),
  evidence: z.array(evidenceSchema),
  gateId: idSchema("gate").nullable(),
  decisionId: idSchema("decision").nullable(),
  rationale: nonEmptyString.nullable(),
});

/**
 * The rules that bound how each status may be reached, independent of any
 * store: `satisfied` only by the runtime from a Gate with Evaluation Evidence;
 * `waived` only by the operator through a `requirement_waiver` Decision;
 * `violated` and `infeasible` always with Evidence.
 */
export function assertRequirementStatusChangeRules(input: RequirementStatusChangeInput): void {
  switch (input.to) {
    case "satisfied":
      if (input.actor !== "runtime" || input.gateId === null) {
        throw new ValidationError("a Requirement becomes satisfied only when the runtime records a Gate result", {
          to: input.to,
          actor: input.actor,
        });
      }
      if (!input.evidence.some((e) => e.kind === "evaluation")) {
        throw new ValidationError("satisfied requires Evaluation Evidence", { to: input.to });
      }
      return;
    case "waived":
      if (input.actor !== "operator" || input.decisionId === null) {
        throw new ValidationError(
          "a Requirement becomes waived only when the operator resolves a requirement_waiver Decision",
          { to: input.to, actor: input.actor },
        );
      }
      return;
    case "violated":
    case "infeasible":
      if (input.evidence.length === 0) {
        throw new ValidationError(`${input.to} requires Evidence`, { to: input.to });
      }
      return;
    case "retired":
    case "open":
      return;
  }
}

// ---------------------------------------------------------------------------
// Acceptance Criteria
// ---------------------------------------------------------------------------

export const ACCEPTANCE_CRITERION_KINDS = ["deterministic", "evaluated"] as const;
export type AcceptanceCriterionKind = (typeof ACCEPTANCE_CRITERION_KINDS)[number];

export type AcceptanceCheck =
  | { kind: "deterministic"; command: string; expectedExitCode: number }
  | { kind: "evaluated"; question: string; rubric: string | null };

export const acceptanceCheckSchema: z.ZodType<AcceptanceCheck> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("deterministic"), command: nonEmptyString, expectedExitCode: z.number().int() }),
  z.strictObject({ kind: z.literal("evaluated"), question: nonEmptyString, rubric: nonEmptyString.nullable() }),
]);

/** Attached to exactly one Requirement (at a revision) or one Task. */
export interface AcceptanceCriterion {
  id: AcceptanceCriterionId;
  conversationId: ConversationId;
  requirementId: RequirementId | null;
  requirementRevisionId: RequirementRevisionId | null;
  taskId: TaskId | null;
  check: AcceptanceCheck;
  createdAt: Timestamp;
}

export const acceptanceCriterionSchema: z.ZodType<AcceptanceCriterion> = z
  .strictObject({
    id: idSchema("acceptanceCriterion"),
    conversationId: idSchema("conversation"),
    requirementId: idSchema("requirement").nullable(),
    requirementRevisionId: idSchema("requirementRevision").nullable(),
    taskId: idSchema("task").nullable(),
    check: acceptanceCheckSchema,
    createdAt: timestampSchema,
  })
  .refine((c) => (c.requirementId !== null) !== (c.taskId !== null), {
    message: "an Acceptance Criterion is attached to exactly one Requirement or one Task",
    path: ["requirementId"],
  })
  .refine((c) => (c.requirementId !== null) === (c.requirementRevisionId !== null), {
    message: "a Requirement criterion is pinned to the revision it was authored in",
    path: ["requirementRevisionId"],
  });
