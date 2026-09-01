import { z } from "zod";
import { ValidationError } from "./errors.ts";
import type {
  AcceptanceCriterionId,
  ArtifactId,
  ConversationId,
  DecisionId,
  EvaluationId,
  GateId,
  InvocationId,
  RequirementId,
  RequirementProposalId,
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

// ---------------------------------------------------------------------------
// Requirement proposals (execution-model §8.1 `propose_requirements`)
// ---------------------------------------------------------------------------

/**
 * A proposal's life: `proposed` until the operator approves it (creating the
 * Requirement revision it describes, edited or not), rejects it, or the
 * Orchestrator proposes again (`superseded`). Approval is the operator's;
 * the proposal never changes a Requirement by itself.
 */
export const REQUIREMENT_PROPOSAL_STATUSES = ["proposed", "approved", "rejected", "superseded"] as const;
export type RequirementProposalStatus = (typeof REQUIREMENT_PROPOSAL_STATUSES)[number];

export const REQUIREMENT_PROPOSAL_BOUNDS = Object.freeze({
  maxEntries: 200,
  maxCriteriaPerEntry: 20,
  statementMaxBytes: 2_000,
  rationaleMaxBytes: 4_000,
  keyPattern: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/,
});

/** One entry of a proposed Requirement tree, addressed by a proposal-local key; `requirementId` keeps an existing Requirement's identity. */
export interface ProposedRequirement {
  key: string;
  parentKey: string | null;
  /** Non-null exactly for entries other entries name as their parent. */
  composition: RequirementComposition | null;
  statement: string;
  /** An existing Requirement of the Conversation this entry continues; `null` proposes a new one. */
  requirementId: RequirementId | null;
  /** The Acceptance Criteria authored for the entry in the revision the approval creates. */
  acceptanceCriteria: AcceptanceCheck[];
}

export const proposedRequirementSchema: z.ZodType<ProposedRequirement> = z.strictObject({
  key: z.string().regex(REQUIREMENT_PROPOSAL_BOUNDS.keyPattern),
  parentKey: z.string().regex(REQUIREMENT_PROPOSAL_BOUNDS.keyPattern).nullable(),
  composition: z.enum(REQUIREMENT_COMPOSITIONS).nullable(),
  statement: nonEmptyString.max(REQUIREMENT_PROPOSAL_BOUNDS.statementMaxBytes),
  requirementId: idSchema("requirement").nullable(),
  acceptanceCriteria: z.array(acceptanceCheckSchema).max(REQUIREMENT_PROPOSAL_BOUNDS.maxCriteriaPerEntry),
});

/** The structural defects of a proposed tree, by path: duplicate or unknown keys, self or cyclic parents, a composition on a leaf or missing on a parent, a Requirement kept twice. */
export function proposedRequirementTreeDefects(entries: readonly ProposedRequirement[]): { path: string; message: string }[] {
  const defects: { path: string; message: string }[] = [];
  const byKey = new Map<string, number>();
  entries.forEach((entry, i) => {
    if (byKey.has(entry.key)) defects.push({ path: `${i}.key`, message: `key ${entry.key} is used twice` });
    else byKey.set(entry.key, i);
  });
  const kept = new Map<string, number>();
  entries.forEach((entry, i) => {
    if (entry.requirementId === null) return;
    if (kept.has(entry.requirementId)) defects.push({ path: `${i}.requirementId`, message: `Requirement ${entry.requirementId} is kept by two entries` });
    else kept.set(entry.requirementId, i);
  });
  const parents = new Set(entries.flatMap((e) => (e.parentKey === null ? [] : [e.parentKey])));
  entries.forEach((entry, i) => {
    if (entry.parentKey !== null) {
      if (entry.parentKey === entry.key) defects.push({ path: `${i}.parentKey`, message: `entry ${entry.key} names itself as parent` });
      else if (!byKey.has(entry.parentKey)) defects.push({ path: `${i}.parentKey`, message: `parent key ${entry.parentKey} names no entry` });
    }
    const isParent = parents.has(entry.key);
    if (isParent && entry.composition === null) defects.push({ path: `${i}.composition`, message: `entry ${entry.key} has children and needs a composition` });
    if (!isParent && entry.composition !== null) defects.push({ path: `${i}.composition`, message: `entry ${entry.key} has no children and carries a composition` });
  });
  // A parent chain that never reaches a root is a cycle.
  entries.forEach((entry, i) => {
    const seen = new Set<string>();
    let cursor: string | null = entry.parentKey;
    while (cursor !== null && byKey.has(cursor)) {
      if (cursor === entry.key || seen.has(cursor)) {
        defects.push({ path: `${i}.parentKey`, message: `entry ${entry.key} is part of a parent cycle` });
        break;
      }
      seen.add(cursor);
      cursor = entries[byKey.get(cursor)!]!.parentKey;
    }
  });
  return defects;
}

export const proposedRequirementTreeSchema: z.ZodType<ProposedRequirement[]> = z
  .array(proposedRequirementSchema)
  .min(1)
  .max(REQUIREMENT_PROPOSAL_BOUNDS.maxEntries)
  .superRefine((entries, ctx) => {
    for (const defect of proposedRequirementTreeDefects(entries)) ctx.addIssue({ code: "custom", path: defect.path.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)), message: defect.message });
  });

/** The operator's resolution of a proposal: approved (edited or verbatim) with the revision it created, or rejected. */
export interface RequirementProposalResolution {
  status: "approved" | "rejected";
  requirementRevisionId: RequirementRevisionId | null;
  /** Whether the operator approved an edited tree rather than the proposed one. */
  edited: boolean;
  rationale: string | null;
  resolvedAt: Timestamp;
}

/**
 * The canonical record of one `propose_requirements` call (execution-model
 * §8.1): the proposed tree and rationale exactly as accepted, who proposed
 * it, and how the operator resolved it. Its id is the proposal's identity
 * everywhere — the tool result, the operator boundary, the Orchestrator's
 * later `requirement_proposal_resolution` input.
 */
export interface RequirementProposal {
  id: RequirementProposalId;
  conversationId: ConversationId;
  runId: RunId;
  /** The Orchestrator Invocation whose accepted call created the proposal. */
  invocationId: InvocationId;
  status: RequirementProposalStatus;
  entries: ProposedRequirement[];
  rationale: string;
  resolution: RequirementProposalResolution | null;
  /** The later proposal of the same Run that superseded this one while it was still `proposed`. */
  supersededByProposalId: RequirementProposalId | null;
  createdAt: Timestamp;
}

export const requirementProposalResolutionSchema: z.ZodType<RequirementProposalResolution> = z
  .strictObject({
    status: z.enum(["approved", "rejected"]),
    requirementRevisionId: idSchema("requirementRevision").nullable(),
    edited: z.boolean(),
    rationale: nonEmptyString.max(REQUIREMENT_PROPOSAL_BOUNDS.rationaleMaxBytes).nullable(),
    resolvedAt: timestampSchema,
  })
  .refine((r) => (r.status === "approved") === (r.requirementRevisionId !== null), { message: "an approval names the revision it created; a rejection names none", path: ["requirementRevisionId"] })
  .refine((r) => r.status === "approved" || !r.edited, { message: "only an approval can be edited", path: ["edited"] });

export const requirementProposalSchema: z.ZodType<RequirementProposal> = z
  .strictObject({
    id: idSchema("requirementProposal"),
    conversationId: idSchema("conversation"),
    runId: idSchema("run"),
    invocationId: idSchema("invocation"),
    status: z.enum(REQUIREMENT_PROPOSAL_STATUSES),
    entries: proposedRequirementTreeSchema,
    rationale: nonEmptyString.max(REQUIREMENT_PROPOSAL_BOUNDS.rationaleMaxBytes),
    resolution: requirementProposalResolutionSchema.nullable(),
    supersededByProposalId: idSchema("requirementProposal").nullable(),
    createdAt: timestampSchema,
  })
  .refine((p) => (p.status === "approved" || p.status === "rejected") === (p.resolution !== null), { message: "exactly an approved or rejected proposal carries its resolution", path: ["resolution"] })
  .refine((p) => p.resolution === null || p.resolution.status === p.status, { message: "the resolution status is the proposal status", path: ["resolution"] })
  .refine((p) => (p.status === "superseded") === (p.supersededByProposalId !== null), { message: "exactly a superseded proposal names its superseder", path: ["supersededByProposalId"] })
  .refine((p) => p.supersededByProposalId !== p.id, { message: "a proposal never supersedes itself", path: ["supersededByProposalId"] });
