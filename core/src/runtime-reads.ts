import { z } from "zod";
import {
  agentCapabilitiesSchema,
  agentDefaultLimitsSchema,
  agentDefinitionProvenanceSchema,
  modelPolicySchema,
  toolPolicySchema,
  type AgentCapabilities,
  type AgentDefaultLimits,
  type AgentDefinitionProvenance,
  type ModelPolicy,
  type ToolPolicy,
} from "./agents.ts";
import { allocationSchema, ON_ALLOCATION_EXHAUSTED_POLICIES, type Allocation, type OnAllocationExhausted } from "./budgets.ts";
import {
  activationConditionSchema,
  decisionAffectsSchema,
  decisionSubjectSchema,
  DECISION_KINDS,
  DECISION_RESOLVERS,
  DECISION_STATUSES,
  DECISION_SUPERSESSION_REASONS,
  RESOLUTION_POLICIES,
  type ActivationCondition,
  type DecisionAffects,
  type DecisionKind,
  type DecisionResolver,
  type DecisionStatus,
  type DecisionSubject,
  type DecisionSupersessionReason,
  type ResolutionPolicy,
} from "./decisions.ts";
import type {
  AcceptanceCriterionId,
  AgentDefinitionId,
  AgentDefinitionRevisionId,
  ArtifactId,
  DecisionId,
  GateId,
  PlanEdgeId,
  PlanNodeId,
  RequirementId,
  RequirementRevisionId,
  TaskId,
} from "./ids.ts";
import { INVOCATION_ROLES, type InvocationRole } from "./invocations.ts";
import { coordinatorWorkerBoundsSchema, FAN_IN_POLICIES, PATTERNS, PLAN_NODE_STATUSES, PLAN_NODE_WAIT_REASONS, type CoordinatorWorkerBounds, type FanInPolicy, type Pattern, type PlanNodeStatus, type PlanNodeWaitReason } from "./plans.ts";
import { evidenceSchema, REQUIREMENT_COMPOSITIONS, REQUIREMENT_STATUSES, type Evidence, type RequirementComposition, type RequirementStatus } from "./requirements.ts";
import { TASK_FAILURE_REASONS, TASK_STATUSES, taskBlockReasonSchema, type TaskBlockReason, type TaskFailureReason, type TaskStatus } from "./tasks.ts";
import { count, idSchema, nonEmptyString, sha256Hex, timestampSchema, uniqueIds, type Timestamp } from "./validation.ts";

/**
 * The bounded read contracts of the runtime read tools (execution-model
 * §6.4 "Runtime read tools"): `read_requirements`, `read_decisions`,
 * `read_tasks`, `read_execution_plan`, `read_agent_definitions`, and
 * `read_artifact`. A read is scope-aware, on-demand access to canonical
 * state: it is parsed through a strict closed schema, authorized against
 * the caller's immutable manifest and role, executed outside every
 * persistence transaction, and returns a typed, size-bounded projection.
 * A successful read writes no `runtime_tool_calls` row, no Event, no
 * Usage, and no receipt of any kind; repeated reads are harmless and
 * return the same canonical result for the same database state.
 *
 * Every list is paged with a stateless keyset cursor (`after` names the
 * last record of the previous page in the caller's canonical order), the
 * order is deterministic, and the total serialized result is bounded.
 * No read result embeds a transcript, Event history, provider message,
 * continuation payload, storage key, worktree path, credential, raw
 * tool-call input, or unrelated Artifact content; only `read_artifact`
 * returns Artifact content, under its own explicit byte bounds.
 */

// ---------------------------------------------------------------------------
// Common paging and response bounds
// ---------------------------------------------------------------------------

export const RUNTIME_READ_BOUNDS = Object.freeze({
  /** Records per page when the caller names no limit. */
  defaultLimit: 25,
  /** The largest page a caller may request. */
  maxLimit: 100,
  /** The maximum serialized size of one structured read result. */
  maxResponseBytes: 65_536,
  /** Bytes reserved for the result envelope around the paged records. */
  responseEnvelopeReserveBytes: 2_048,
});

const readLimitSchema = z.number().int().min(1).max(RUNTIME_READ_BOUNDS.maxLimit);

/**
 * The reference a page returns in place of a single record that alone
 * exceeds the response bound: its id and serialized size, never a
 * truncated JSON object or a silently dropped record. `next` then skips
 * exactly that record.
 */
export interface OversizedRecordRef {
  id: string;
  byteSize: number;
}

export const oversizedRecordRefSchema: z.ZodType<OversizedRecordRef> = z.strictObject({ id: nonEmptyString, byteSize: count });

// ---------------------------------------------------------------------------
// read_requirements
// ---------------------------------------------------------------------------

/**
 * A bounded projection of the Requirement revision the caller works
 * against: the current revision for the root Orchestrator's ordinary
 * turns, the pinned revision of the caller's manifest otherwise — a
 * scoped node is never silently moved to a newer revision. The caller is
 * already bound to a Run; there is no Conversation or Run selector.
 */
export interface ReadRequirementsInput {
  /** Exactly one Requirement of the caller's visible set, instead of a page. */
  requirementId?: RequirementId;
  /** Include bounded Acceptance Criterion metadata per Requirement. */
  includeAcceptanceCriteria?: boolean;
  after?: RequirementId;
  limit?: number;
}

export const readRequirementsInputSchema: z.ZodType<ReadRequirementsInput> = z.strictObject({
  requirementId: idSchema("requirement").optional(),
  includeAcceptanceCriteria: z.boolean().optional(),
  after: idSchema("requirement").optional(),
  limit: readLimitSchema.optional(),
});

export interface RequirementCriterionRecord {
  acceptanceCriterionId: AcceptanceCriterionId;
  kind: "deterministic" | "evaluated";
}

export interface RequirementRecord {
  requirementId: RequirementId;
  parentId: RequirementId | null;
  /** Non-null exactly for internal nodes, which compose their children. */
  composition: RequirementComposition | null;
  statement: string;
  /** The Requirement's current semantic status. */
  status: RequirementStatus;
  leaf: boolean;
  /** The ordered children within the caller's visible set (empty for a leaf or a scoped caller). */
  childIds: RequirementId[];
  /** Bounded Acceptance Criterion metadata; `null` unless requested. */
  acceptanceCriteria: RequirementCriterionRecord[] | null;
  /** The operator-resolved waiver Decision that established `waived`, where one exists. */
  waiverDecisionId: DecisionId | null;
}

export const requirementRecordSchema: z.ZodType<RequirementRecord> = z.strictObject({
  requirementId: idSchema("requirement"),
  parentId: idSchema("requirement").nullable(),
  composition: z.enum(REQUIREMENT_COMPOSITIONS).nullable(),
  statement: nonEmptyString,
  status: z.enum(REQUIREMENT_STATUSES),
  leaf: z.boolean(),
  childIds: uniqueIds(idSchema("requirement")),
  acceptanceCriteria: z.array(z.strictObject({ acceptanceCriterionId: idSchema("acceptanceCriterion"), kind: z.enum(["deterministic", "evaluated"]) })).nullable(),
  waiverDecisionId: idSchema("decision").nullable(),
});

export interface ReadRequirementsResult {
  tool: "read_requirements";
  /** The revision the projection is at: pinned for a scoped caller, current for the root Orchestrator; `null` when none exists. */
  requirementRevisionId: RequirementRevisionId | null;
  /** Visible Requirements in canonical tree order. */
  items: RequirementRecord[];
  oversizedRecord: OversizedRecordRef | null;
  next: RequirementId | null;
}

export const readRequirementsResultSchema: z.ZodType<ReadRequirementsResult> = z.strictObject({
  tool: z.literal("read_requirements"),
  requirementRevisionId: idSchema("requirementRevision").nullable(),
  items: z.array(requirementRecordSchema),
  oversizedRecord: oversizedRecordRefSchema.nullable(),
  next: idSchema("requirement").nullable(),
});

// ---------------------------------------------------------------------------
// read_decisions
// ---------------------------------------------------------------------------

export interface ReadDecisionsInput {
  /** Exactly one Decision of the caller's visible set, instead of a page. */
  decisionId?: DecisionId;
  status?: DecisionStatus;
  after?: DecisionId;
  limit?: number;
}

export const readDecisionsInputSchema: z.ZodType<ReadDecisionsInput> = z.strictObject({
  decisionId: idSchema("decision").optional(),
  status: z.enum(DECISION_STATUSES).optional(),
  after: idSchema("decision").optional(),
  limit: readLimitSchema.optional(),
});

/**
 * One canonical Decision as a caller may see it: the bounded question, the
 * ordered options, the recommendation, the resolution facts, the affected
 * ids, and the typed subject (which carries ids, digests, and closed
 * values only — a `side_effect_approval` subject names the tool, digest,
 * and call Artifact id, never the proposed call's bytes). No Decision
 * Event history and no operator message content travels here.
 */
export interface DecisionRecord {
  decisionId: DecisionId;
  kind: DecisionKind;
  status: DecisionStatus;
  resolutionPolicy: ResolutionPolicy;
  question: string;
  options: { id: string; label: string; description: string | null }[];
  recommendedOptionId: string | null;
  rationale: string | null;
  deadlineAt: Timestamp | null;
  activationCondition: ActivationCondition | null;
  chosenOptionId: string | null;
  resolvedBy: DecisionResolver | null;
  resolvedAt: Timestamp | null;
  affects: DecisionAffects;
  subject: DecisionSubject | null;
  supersessionReason: DecisionSupersessionReason | null;
  supersededByDecisionId: DecisionId | null;
}

export const decisionRecordSchema: z.ZodType<DecisionRecord> = z.strictObject({
  decisionId: idSchema("decision"),
  kind: z.enum(DECISION_KINDS),
  status: z.enum(DECISION_STATUSES),
  resolutionPolicy: z.enum(RESOLUTION_POLICIES),
  question: nonEmptyString,
  options: z.array(z.strictObject({ id: nonEmptyString, label: nonEmptyString, description: nonEmptyString.nullable() })),
  recommendedOptionId: nonEmptyString.nullable(),
  rationale: nonEmptyString.nullable(),
  deadlineAt: timestampSchema.nullable(),
  activationCondition: activationConditionSchema.nullable(),
  chosenOptionId: nonEmptyString.nullable(),
  resolvedBy: z.enum(DECISION_RESOLVERS).nullable(),
  resolvedAt: timestampSchema.nullable(),
  affects: decisionAffectsSchema,
  subject: decisionSubjectSchema.nullable(),
  supersessionReason: z.enum(DECISION_SUPERSESSION_REASONS).nullable(),
  supersededByDecisionId: idSchema("decision").nullable(),
});

export interface ReadDecisionsResult {
  tool: "read_decisions";
  /** Visible Decisions ordered by id. */
  items: DecisionRecord[];
  oversizedRecord: OversizedRecordRef | null;
  next: DecisionId | null;
}

export const readDecisionsResultSchema: z.ZodType<ReadDecisionsResult> = z.strictObject({
  tool: z.literal("read_decisions"),
  items: z.array(decisionRecordSchema),
  oversizedRecord: oversizedRecordRefSchema.nullable(),
  next: idSchema("decision").nullable(),
});

// ---------------------------------------------------------------------------
// read_tasks
// ---------------------------------------------------------------------------

export interface ReadTasksInput {
  /** Exactly one Task of the caller's visible set, instead of a page. */
  taskId?: TaskId;
  after?: TaskId;
  limit?: number;
}

export const readTasksInputSchema: z.ZodType<ReadTasksInput> = z.strictObject({
  taskId: idSchema("task").optional(),
  after: idSchema("task").optional(),
  limit: readLimitSchema.optional(),
});

/**
 * One current Task as its ledger records it: identity, state, ownership,
 * dependency and replacement references, the typed block reason, and the
 * Artifact and Evidence references — never another Invocation's provider
 * state, a transcript, or Artifact content.
 */
export interface TaskRecord {
  taskId: TaskId;
  subject: string;
  status: TaskStatus;
  planNodeId: PlanNodeId | null;
  /** The failed Gate a runtime-owned remediation Task addresses. */
  gateId: GateId | null;
  requirementIds: RequirementId[];
  dependsOnTaskIds: TaskId[];
  replacesTaskId: TaskId | null;
  /** The replacement Task that superseded this one, where one exists. */
  supersededByTaskId: TaskId | null;
  blockReason: TaskBlockReason | null;
  failureReason: TaskFailureReason | null;
  inputArtifactIds: ArtifactId[];
  requiredOutputs: string[];
  outputArtifactIds: ArtifactId[];
  evidence: Evidence[];
}

export const taskRecordSchema: z.ZodType<TaskRecord> = z.strictObject({
  taskId: idSchema("task"),
  subject: nonEmptyString,
  status: z.enum(TASK_STATUSES),
  planNodeId: idSchema("planNode").nullable(),
  gateId: idSchema("gate").nullable(),
  requirementIds: uniqueIds(idSchema("requirement")),
  dependsOnTaskIds: uniqueIds(idSchema("task")),
  replacesTaskId: idSchema("task").nullable(),
  supersededByTaskId: idSchema("task").nullable(),
  blockReason: taskBlockReasonSchema.nullable(),
  failureReason: z.enum(TASK_FAILURE_REASONS).nullable(),
  inputArtifactIds: uniqueIds(idSchema("artifact")),
  requiredOutputs: z.array(nonEmptyString),
  outputArtifactIds: uniqueIds(idSchema("artifact")),
  evidence: z.array(evidenceSchema),
});

export interface ReadTasksResult {
  tool: "read_tasks";
  /** Visible Tasks ordered by id. */
  items: TaskRecord[];
  oversizedRecord: OversizedRecordRef | null;
  next: TaskId | null;
}

export const readTasksResultSchema: z.ZodType<ReadTasksResult> = z.strictObject({
  tool: z.literal("read_tasks"),
  items: z.array(taskRecordSchema),
  oversizedRecord: oversizedRecordRefSchema.nullable(),
  next: idSchema("task").nullable(),
});

// ---------------------------------------------------------------------------
// read_execution_plan
// ---------------------------------------------------------------------------

/**
 * The current accepted executable graph of the caller's own Run, paged
 * separately as node membership and edges — never full nested plan JSON in
 * one response, never a historical revision, a source proposal, compiler
 * intermediate state, or a rejected proposal.
 */
export type ReadExecutionPlanInput = { view: "nodes"; after?: PlanNodeId; limit?: number } | { view: "edges"; after?: PlanEdgeId; limit?: number };

export const readExecutionPlanInputSchema: z.ZodType<ReadExecutionPlanInput> = z.discriminatedUnion("view", [
  z.strictObject({ view: z.literal("nodes"), after: idSchema("planNode").optional(), limit: readLimitSchema.optional() }),
  z.strictObject({ view: z.literal("edges"), after: idSchema("planEdge").optional(), limit: readLimitSchema.optional() }),
]);

/** The bounded orchestration summary of one `pattern` node's immutable shape; operation inputs and instructions never travel here. */
export type PlanNodeShapeSummary =
  | { pattern: "single"; operationTitle: string }
  | { pattern: "chain"; stepCount: number }
  | { pattern: "route"; selector: "decision_answer" | "evaluator"; branchLabels: string[] }
  | { pattern: "parallel"; itemCount: number; hasAggregation: boolean; requireAll: boolean }
  | { pattern: "coordinator_worker"; bounds: CoordinatorWorkerBounds }
  | { pattern: "evaluator_optimizer"; maxRounds: number; round: number | null };

export const planNodeShapeSummarySchema: z.ZodType<PlanNodeShapeSummary> = z.discriminatedUnion("pattern", [
  z.strictObject({ pattern: z.literal("single"), operationTitle: nonEmptyString }),
  z.strictObject({ pattern: z.literal("chain"), stepCount: z.number().int().min(2) }),
  z.strictObject({ pattern: z.literal("route"), selector: z.enum(["decision_answer", "evaluator"]), branchLabels: z.array(nonEmptyString).min(1) }),
  z.strictObject({ pattern: z.literal("parallel"), itemCount: z.number().int().min(1), hasAggregation: z.boolean(), requireAll: z.boolean() }),
  z.strictObject({ pattern: z.literal("coordinator_worker"), bounds: coordinatorWorkerBoundsSchema }),
  z.strictObject({ pattern: z.literal("evaluator_optimizer"), maxRounds: z.number().int().min(1), round: z.number().int().min(1).nullable() }),
]);

export interface PlanNodeRecord {
  planNodeId: PlanNodeId;
  kind: "pattern" | "join";
  pattern: Pattern | null;
  status: PlanNodeStatus;
  waitReason: PlanNodeWaitReason | null;
  sourcePath: string;
  title: string;
  shape: PlanNodeShapeSummary | null;
  /** The fan-in policy of a `join` node; `null` for a `pattern` node. */
  fanInPolicy: FanInPolicy | null;
  requirementRevisionId: RequirementRevisionId | null;
  requirementIds: RequirementId[];
  allocation: Allocation;
  onAllocationExhausted: OnAllocationExhausted | null;
  maxConcurrency: number | null;
  maxWallClockMs: number | null;
}

export const planNodeRecordSchema: z.ZodType<PlanNodeRecord> = z
  .strictObject({
    planNodeId: idSchema("planNode"),
    kind: z.enum(["pattern", "join"]),
    pattern: z.enum(PATTERNS).nullable(),
    status: z.enum(PLAN_NODE_STATUSES),
    waitReason: z.enum(PLAN_NODE_WAIT_REASONS).nullable(),
    sourcePath: nonEmptyString,
    title: nonEmptyString,
    shape: planNodeShapeSummarySchema.nullable(),
    fanInPolicy: z.enum(FAN_IN_POLICIES).nullable(),
    requirementRevisionId: idSchema("requirementRevision").nullable(),
    requirementIds: uniqueIds(idSchema("requirement")),
    allocation: allocationSchema,
    onAllocationExhausted: z.enum(ON_ALLOCATION_EXHAUSTED_POLICIES).nullable(),
    maxConcurrency: z.number().int().min(1).nullable(),
    maxWallClockMs: z.number().int().min(1).nullable(),
  })
  .refine((n) => (n.kind === "pattern") === (n.pattern !== null && n.shape !== null && n.onAllocationExhausted !== null), { message: "a pattern node carries its Pattern, shape summary, and allocation policy", path: ["pattern"] })
  .refine((n) => (n.kind === "join") === (n.fanInPolicy !== null), { message: "a join node carries its fan-in policy", path: ["fanInPolicy"] });

export type PlanEdgeRecord = { planEdgeId: PlanEdgeId; sourceNodeId: PlanNodeId; targetNodeId: PlanNodeId; position: number } & ({ type: "sequence" } | { type: "branch"; label: string } | { type: "fan_in" } | { type: "retry"; round: number });

const planEdgeRecordBase = {
  planEdgeId: idSchema("planEdge"),
  sourceNodeId: idSchema("planNode"),
  targetNodeId: idSchema("planNode"),
  position: count,
};

export const planEdgeRecordSchema: z.ZodType<PlanEdgeRecord> = z.discriminatedUnion("type", [
  z.strictObject({ ...planEdgeRecordBase, type: z.literal("sequence") }),
  z.strictObject({ ...planEdgeRecordBase, type: z.literal("branch"), label: nonEmptyString }),
  z.strictObject({ ...planEdgeRecordBase, type: z.literal("fan_in") }),
  z.strictObject({ ...planEdgeRecordBase, type: z.literal("retry"), round: z.number().int().min(2) }),
]);

export type ReadExecutionPlanResult =
  | { tool: "read_execution_plan"; revisionNumber: number; view: "nodes"; items: PlanNodeRecord[]; oversizedRecord: OversizedRecordRef | null; next: PlanNodeId | null }
  | { tool: "read_execution_plan"; revisionNumber: number; view: "edges"; items: PlanEdgeRecord[]; oversizedRecord: OversizedRecordRef | null; next: PlanEdgeId | null };

export const readExecutionPlanResultSchema: z.ZodType<ReadExecutionPlanResult> = z.union([
  z.strictObject({
    tool: z.literal("read_execution_plan"),
    revisionNumber: z.number().int().min(1),
    view: z.literal("nodes"),
    items: z.array(planNodeRecordSchema),
    oversizedRecord: oversizedRecordRefSchema.nullable(),
    next: idSchema("planNode").nullable(),
  }),
  z.strictObject({
    tool: z.literal("read_execution_plan"),
    revisionNumber: z.number().int().min(1),
    view: z.literal("edges"),
    items: z.array(planEdgeRecordSchema),
    oversizedRecord: oversizedRecordRefSchema.nullable(),
    next: idSchema("planEdge").nullable(),
  }),
]);

// ---------------------------------------------------------------------------
// read_agent_definitions
// ---------------------------------------------------------------------------

export interface ReadAgentDefinitionsInput {
  /** Only the revisions of one Agent Definition, instead of every relevant one. */
  agentDefinitionId?: AgentDefinitionId;
  after?: AgentDefinitionRevisionId;
  limit?: number;
}

export const readAgentDefinitionsInputSchema: z.ZodType<ReadAgentDefinitionsInput> = z.strictObject({
  agentDefinitionId: idSchema("agentDefinition").optional(),
  after: idSchema("agentDefinitionRevision").optional(),
  limit: readLimitSchema.optional(),
});

/**
 * Bounded metadata of one executable Agent Definition revision relevant to
 * the caller's Workspace and Run: identity, hash, safe provenance
 * references, derived role compatibility, capabilities, Tool Policy,
 * model-policy metadata, and default limits. Instruction text is never
 * returned; the caller's own instructions are already in its immutable
 * manifest.
 */
export interface AgentDefinitionRecord {
  agentDefinitionId: AgentDefinitionId;
  revisionId: AgentDefinitionRevisionId;
  name: string;
  contentHash: string;
  provenance: AgentDefinitionProvenance;
  /** The roles this revision may be bound to: the `orchestrator` definition serves the root alone; every other serves the non-root roles. */
  roles: InvocationRole[];
  capabilities: AgentCapabilities;
  toolPolicy: ToolPolicy;
  modelPolicy: ModelPolicy;
  defaultLimits: AgentDefaultLimits;
}

export const agentDefinitionRecordSchema: z.ZodType<AgentDefinitionRecord> = z.strictObject({
  agentDefinitionId: idSchema("agentDefinition"),
  revisionId: idSchema("agentDefinitionRevision"),
  name: nonEmptyString,
  contentHash: sha256Hex,
  provenance: agentDefinitionProvenanceSchema,
  roles: z.array(z.enum(INVOCATION_ROLES)).min(1),
  capabilities: agentCapabilitiesSchema,
  toolPolicy: toolPolicySchema,
  modelPolicy: modelPolicySchema,
  defaultLimits: agentDefaultLimitsSchema,
});

export interface ReadAgentDefinitionsResult {
  tool: "read_agent_definitions";
  /** Relevant revisions ordered by revision id. */
  items: AgentDefinitionRecord[];
  oversizedRecord: OversizedRecordRef | null;
  next: AgentDefinitionRevisionId | null;
}

export const readAgentDefinitionsResultSchema: z.ZodType<ReadAgentDefinitionsResult> = z.strictObject({
  tool: z.literal("read_agent_definitions"),
  items: z.array(agentDefinitionRecordSchema),
  oversizedRecord: oversizedRecordRefSchema.nullable(),
  next: idSchema("agentDefinitionRevision").nullable(),
});

// ---------------------------------------------------------------------------
// read_artifact
// ---------------------------------------------------------------------------

export const ARTIFACT_CONTENT_ENCODINGS = ["utf8", "base64"] as const;
export type ArtifactContentEncoding = (typeof ARTIFACT_CONTENT_ENCODINGS)[number];

export const READ_ARTIFACT_BOUNDS = Object.freeze({
  /** Bytes returned per page when the caller names no `maxBytes`. */
  defaultMaxBytes: 16_384,
  /** The largest content page a caller may request. */
  maxMaxBytes: 65_536,
});

/**
 * The one runtime tool that returns Artifact content. Paging is over the
 * Artifact's bytes: `offset` and `maxBytes` select a verified byte range,
 * `utf8` never splits a UTF-8 sequence (the page end is pulled back to a
 * boundary and an offset inside a sequence is refused), and `base64`
 * pages over the decoded bytes with the returned text representing
 * exactly the selected range. The digest and total size always describe
 * the complete Artifact, never the page.
 */
export interface ReadArtifactInput {
  artifactId: ArtifactId;
  offset?: number;
  maxBytes?: number;
  encoding?: ArtifactContentEncoding;
}

export const readArtifactInputSchema: z.ZodType<ReadArtifactInput> = z.strictObject({
  artifactId: idSchema("artifact"),
  offset: count.optional(),
  maxBytes: z.number().int().min(1).max(READ_ARTIFACT_BOUNDS.maxMaxBytes).optional(),
  encoding: z.enum(ARTIFACT_CONTENT_ENCODINGS).optional(),
});

export interface ReadArtifactResult {
  tool: "read_artifact";
  artifactId: ArtifactId;
  mediaType: string;
  /** The digest of the complete Artifact, not the page. */
  digest: string;
  /** The total byte size of the complete Artifact, not the page. */
  byteSize: number;
  offset: number;
  /** The number of Artifact bytes this page represents. */
  byteCount: number;
  encoding: ArtifactContentEncoding;
  content: string;
  nextOffset: number | null;
  eof: boolean;
}

export const readArtifactResultSchema: z.ZodType<ReadArtifactResult> = z
  .strictObject({
    tool: z.literal("read_artifact"),
    artifactId: idSchema("artifact"),
    mediaType: nonEmptyString,
    digest: sha256Hex,
    byteSize: count,
    offset: count,
    byteCount: count,
    encoding: z.enum(ARTIFACT_CONTENT_ENCODINGS),
    content: z.string(),
    nextOffset: count.nullable(),
    eof: z.boolean(),
  })
  .refine((r) => r.eof === (r.nextOffset === null), { message: "nextOffset is set exactly while bytes remain", path: ["nextOffset"] })
  .refine((r) => r.offset + r.byteCount <= r.byteSize, { message: "the page lies within the Artifact", path: ["byteCount"] });

// ---------------------------------------------------------------------------
// The closed read-result union
// ---------------------------------------------------------------------------

/** The typed result of one successful read: a projection, never a durable mutation, digest, or invented call id. */
export type RuntimeToolReadResult = ReadRequirementsResult | ReadDecisionsResult | ReadTasksResult | ReadExecutionPlanResult | ReadAgentDefinitionsResult | ReadArtifactResult;

export const runtimeToolReadResultSchema: z.ZodType<RuntimeToolReadResult> = z.union([
  readRequirementsResultSchema,
  readDecisionsResultSchema,
  readTasksResultSchema,
  readExecutionPlanResultSchema,
  readAgentDefinitionsResultSchema,
  readArtifactResultSchema,
]);
