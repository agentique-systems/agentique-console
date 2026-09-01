import { z } from "zod";
import { mediaTypeSchema } from "./artifacts.ts";
import { COMPLETION_PREFLIGHT_CODES, COMPLETION_REQUEST_STATUSES, type CompletionRequestStatus } from "./completion.ts";
import { activationConditionSchema, type ActivationCondition } from "./decisions.ts";
import type { ArtifactId, AttemptId, CompletionRequestId, DecisionId, InvocationId, PlanNodeId, RequirementId, RunId, RuntimeToolCallId, TaskId } from "./ids.ts";
import { COORDINATOR_PURPOSES, EVALUATOR_PURPOSES, ORCHESTRATOR_PURPOSES, RUNTIME_TOOLS_BY_ROLE, WORKER_PURPOSES, type InvocationPurpose, type InvocationRole, type RuntimeTool } from "./invocations.ts";
import {
  ARTIFACT_CONTENT_ENCODINGS,
  readAgentDefinitionsInputSchema,
  readArtifactInputSchema,
  readDecisionsInputSchema,
  readExecutionPlanInputSchema,
  readRequirementsInputSchema,
  readTasksInputSchema,
  type ArtifactContentEncoding,
  type ReadAgentDefinitionsInput,
  type ReadArtifactInput,
  type ReadDecisionsInput,
  type ReadExecutionPlanInput,
  type ReadRequirementsInput,
  type ReadTasksInput,
  type RuntimeToolReadResult,
} from "./runtime-reads.ts";
import { TASK_STATUSES, type TaskStatus } from "./tasks.ts";
import { boundedString, canonicalJson, count, idSchema, nonEmptyString, sha256Hex, timestampSchema, uniqueIds, utf8ByteLength, type Timestamp } from "./validation.ts";

/**
 * The runtime-tool call boundary (execution-model §6.4 "Runtime tools").
 *
 * Four sets are distinct and documented separately:
 * - **role permission** — `RUNTIME_TOOLS_BY_ROLE`: what a role may ever hold;
 * - **manifest permission** — `runtimeToolsFor(role, purpose)`: the role's tools
 *   narrowed by the Invocation's purpose and persisted in its immutable
 *   Context Manifest;
 * - **runtime handler availability** — `RUNTIME_TOOL_CALL_TOOLS`: the tools
 *   the execution runtime implements as executable handlers;
 * - **effective callable tools** — the intersection of the three, which is
 *   the only set a provider request exposes.
 *
 * A mutating call travels through this boundary as a closed discriminated
 * union, never as an arbitrary tool name with an unvalidated object, and
 * commits in its own short root transaction while the provider executes
 * outside every transaction. An accepted call is recorded once
 * (`RuntimeToolCall`), keyed by Invocation, tool, and canonical digest, so a
 * retry of the same call after a lost response replays the committed result
 * without repeating its effects.
 */

/**
 * The mutating runtime tools the execution runtime implements as executable
 * handlers: exactly the tools an accepted call of which is recorded as one
 * append-only `runtime_tool_calls` row with a canonical digest and replay
 * semantics.
 */
export const RUNTIME_TOOL_CALL_TOOLS = ["propose_tasks", "update_task", "request_completion", "request_decision", "write_artifact"] as const;
export type RuntimeToolCallTool = (typeof RUNTIME_TOOL_CALL_TOOLS)[number];

/**
 * The read runtime tools the execution runtime implements as executable
 * handlers. A successful read returns a typed, bounded projection and is
 * not a durable mutation: no `runtime_tool_calls` row, no Event, no Usage
 * row, no digest or call id presented as a durable record.
 */
export const RUNTIME_TOOL_READ_TOOLS = ["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions"] as const;
export type RuntimeToolReadTool = (typeof RUNTIME_TOOL_READ_TOOLS)[number];

/** Every runtime tool the execution runtime can execute: the read tools plus the recorded mutating tools. */
export const EXECUTABLE_RUNTIME_TOOLS = [...RUNTIME_TOOL_READ_TOOLS, ...RUNTIME_TOOL_CALL_TOOLS] as const;
export type ExecutableRuntimeTool = (typeof EXECUTABLE_RUNTIME_TOOLS)[number];

export function isRuntimeToolReadTool(tool: ExecutableRuntimeTool): tool is RuntimeToolReadTool {
  return (RUNTIME_TOOL_READ_TOOLS as readonly string[]).includes(tool);
}

/** The Orchestrator purposes from which completion may be requested: every turn but the read-only `final_synthesis` report. */
export const COMPLETION_REQUESTING_PURPOSES = ORCHESTRATOR_PURPOSES.filter((purpose) => purpose !== "final_synthesis");

/** The Orchestrator purposes from which a Decision may be requested: every turn but the read-only `final_synthesis` report. */
export const DECISION_REQUESTING_ORCHESTRATOR_PURPOSES = COMPLETION_REQUESTING_PURPOSES;

/** Purposes for which a role-permitted tool is withheld from the manifest; a tool absent here is permitted for every purpose of its role. */
const PURPOSE_EXCLUSIONS: Readonly<Partial<Record<RuntimeTool, readonly InvocationPurpose[]>>> = {
  // A `synthesize` turn produces the node's output; it never proposes or mutates Tasks.
  propose_tasks: ["synthesize"],
  // A `final_synthesis` turn reports on the verified state and changes nothing (execution-model §10).
  update_task: ["synthesize", "final_synthesis"],
  create_tasks: ["final_synthesis"],
  request_decision: ["final_synthesis"],
  record_decision: ["final_synthesis"],
  propose_requirements: ["final_synthesis"],
  revise_execution_plan: ["final_synthesis"],
  request_completion: ["final_synthesis"],
  // The read-only final synthesis may read but holds no mutating runtime tool at all (execution-model §10).
  write_artifact: ["final_synthesis"],
};

/** Manifest permission: the role's runtime tools narrowed by the Invocation's purpose. */
export function runtimeToolsFor(role: InvocationRole, purpose: InvocationPurpose): RuntimeTool[] {
  return RUNTIME_TOOLS_BY_ROLE[role].filter((tool) => !(PURPOSE_EXCLUSIONS[tool] ?? []).includes(purpose));
}

/** One role and the purposes of that role a handler is valid for. */
export interface RuntimeToolHandlerBinding {
  role: InvocationRole;
  purposes: readonly InvocationPurpose[];
}

/** Every role with every purpose of that role: the binding of a tool every running Invocation may hold. */
const EVERY_ROLE_AND_PURPOSE: readonly RuntimeToolHandlerBinding[] = [
  { role: "orchestrator", purposes: ORCHESTRATOR_PURPOSES },
  { role: "coordinator", purposes: COORDINATOR_PURPOSES },
  { role: "worker", purposes: WORKER_PURPOSES },
  { role: "evaluator", purposes: EVALUATOR_PURPOSES },
];

/** The roles and purposes each executable handler is valid for; a call outside this table is never callable. */
export const RUNTIME_TOOL_HANDLER_BINDINGS: Readonly<Record<ExecutableRuntimeTool, readonly RuntimeToolHandlerBinding[]>> = {
  // Every role reads within its own scope (execution-model §6.4): the handler authorizes each record, never the binding alone.
  read_requirements: EVERY_ROLE_AND_PURPOSE,
  read_decisions: EVERY_ROLE_AND_PURPOSE,
  read_tasks: EVERY_ROLE_AND_PURPOSE,
  read_artifact: EVERY_ROLE_AND_PURPOSE,
  read_execution_plan: EVERY_ROLE_AND_PURPOSE,
  read_agent_definitions: EVERY_ROLE_AND_PURPOSE,
  propose_tasks: [{ role: "coordinator", purposes: ["decompose", "replan"] }],
  // The Coordinator-permitted subset of `update_task`: cancelling the node's own unstarted or blocked current Tasks.
  update_task: [{ role: "coordinator", purposes: ["decompose", "replan"] }],
  // Only the root Orchestrator requests completion (execution-model §10), never from its read-only final-synthesis turn.
  request_completion: [{ role: "orchestrator", purposes: COMPLETION_REQUESTING_PURPOSES }],
  // An Orchestrator turn (never the final synthesis), a Coordinator's executable turns, and a Worker's current work may request a
  // Decision (execution-model §8.2); an Evaluator, a Gate evaluation, and a Run completion evaluation never do.
  request_decision: [
    { role: "orchestrator", purposes: DECISION_REQUESTING_ORCHESTRATOR_PURPOSES },
    { role: "coordinator", purposes: COORDINATOR_PURPOSES },
    { role: "worker", purposes: WORKER_PURPOSES },
  ],
  // Every role may create a bounded Artifact — an Evaluator's Evidence sometimes requires a report — except the read-only
  // final synthesis, which holds no mutating runtime tool (execution-model §10). Artifact creation mutates no Task, no
  // orchestration state, and no Workspace.
  write_artifact: [
    { role: "orchestrator", purposes: COMPLETION_REQUESTING_PURPOSES },
    { role: "coordinator", purposes: COORDINATOR_PURPOSES },
    { role: "worker", purposes: WORKER_PURPOSES },
    { role: "evaluator", purposes: EVALUATOR_PURPOSES },
  ],
};

/** Whether a handler is valid for one role and purpose. */
export function runtimeToolHandlerBound(tool: ExecutableRuntimeTool, role: InvocationRole, purpose: InvocationPurpose): boolean {
  return RUNTIME_TOOL_HANDLER_BINDINGS[tool].some((binding) => binding.role === role && binding.purposes.includes(purpose));
}

/** The effective callable set of one Invocation: manifest permission ∩ runtime handlers ∩ role/purpose validity. */
export function effectiveRuntimeTools(manifestTools: readonly RuntimeTool[], role: InvocationRole, purpose: InvocationPurpose): ExecutableRuntimeTool[] {
  return EXECUTABLE_RUNTIME_TOOLS.filter((tool) => manifestTools.includes(tool) && runtimeToolHandlerBound(tool, role, purpose));
}

// ---------------------------------------------------------------------------
// propose_tasks
// ---------------------------------------------------------------------------

/** A proposal-local key: unique within one batch, used only to resolve that batch's dependencies, never a persistent identifier. */
export const TASK_PROPOSAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const TASK_PROPOSAL_MAX_TASKS = 64;
export const TASK_PROPOSAL_MAX_SUBJECT_LENGTH = 500;
export const TASK_PROPOSAL_MAX_OUTPUTS = 20;
export const TASK_PROPOSAL_MAX_OUTPUT_LENGTH = 200;
export const TASK_PROPOSAL_MAX_INPUTS = 50;
export const TASK_PROPOSAL_MAX_DEPENDENCIES = 50;

/**
 * One proposed Task (execution-model §5.5.1): only the facts the runtime
 * cannot know. The runtime supplies the Run, the Plan Node, the origin, the
 * pinned Requirement revision, the Worker Agent Definition revision, role,
 * purpose, and Pattern position, the reservation parent, ids, and timestamps.
 */
export interface TaskProposal {
  key: string;
  subject: string;
  /** A non-empty subset of the node's exact pinned leaf Requirement scope. */
  requirementIds: RequirementId[];
  inputArtifactIds: ArtifactId[];
  /** What the Worker must produce; non-empty, bounded, unique. */
  requiredOutputs: string[];
  /** Dependencies on Tasks of this batch, by proposal-local key. */
  dependsOnKeys: string[];
  /** Dependencies on existing current Tasks of the node, by id. */
  dependsOnTaskIds: TaskId[];
  /** A blocked or failed current Task of the node this Task replaces. */
  replacesTaskId: TaskId | null;
}

export const taskProposalSchema: z.ZodType<TaskProposal> = z.strictObject({
  key: z.string().regex(TASK_PROPOSAL_KEY_PATTERN, "expected a proposal key of at most 64 letters, digits, underscores, or hyphens"),
  subject: nonEmptyString.max(TASK_PROPOSAL_MAX_SUBJECT_LENGTH),
  requirementIds: uniqueIds(idSchema("requirement")).min(1),
  inputArtifactIds: uniqueIds(idSchema("artifact")).max(TASK_PROPOSAL_MAX_INPUTS),
  requiredOutputs: z
    .array(nonEmptyString.max(TASK_PROPOSAL_MAX_OUTPUT_LENGTH))
    .min(1)
    .max(TASK_PROPOSAL_MAX_OUTPUTS)
    .refine((outputs) => new Set(outputs).size === outputs.length, { message: "required outputs are unique" }),
  dependsOnKeys: z.array(z.string().regex(TASK_PROPOSAL_KEY_PATTERN)).max(TASK_PROPOSAL_MAX_DEPENDENCIES).refine((keys) => new Set(keys).size === keys.length, { message: "dependency keys are unique" }),
  dependsOnTaskIds: uniqueIds(idSchema("task")).max(TASK_PROPOSAL_MAX_DEPENDENCIES),
  replacesTaskId: idSchema("task").nullable(),
});

export interface TaskProposalBatch {
  tasks: TaskProposal[];
}

export const taskProposalBatchSchema: z.ZodType<TaskProposalBatch> = z.strictObject({
  tasks: z.array(taskProposalSchema).min(1).max(TASK_PROPOSAL_MAX_TASKS),
});

// ---------------------------------------------------------------------------
// update_task (Coordinator-permitted subset)
// ---------------------------------------------------------------------------

export const TASK_UPDATE_MAX_REASON_LENGTH = 500;

/** The Coordinator-permitted `update_task` operation: cancelling one of the node's `pending`, `ready`, or `blocked` current Tasks. */
export interface TaskUpdateRequest {
  taskId: TaskId;
  update: { kind: "cancel"; reason: string };
}

export const taskUpdateRequestSchema: z.ZodType<TaskUpdateRequest> = z.strictObject({
  taskId: idSchema("task"),
  update: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("cancel"), reason: nonEmptyString.max(TASK_UPDATE_MAX_REASON_LENGTH) })]),
});

// ---------------------------------------------------------------------------
// request_completion
// ---------------------------------------------------------------------------

/**
 * The `request_completion` call carries no facts the runtime cannot know:
 * the runtime pins the Snapshot, the Requirement revision, the criteria, and
 * the candidate itself when verification begins, so the input is empty and
 * every call of one logical turn has one canonical digest — a retry or an
 * approval successor replays the same Completion Request.
 */
export type CompletionCallInput = Record<string, never>;

export const completionCallInputSchema: z.ZodType<CompletionCallInput> = z.strictObject({}) as unknown as z.ZodType<CompletionCallInput>;

// ---------------------------------------------------------------------------
// request_decision
// ---------------------------------------------------------------------------

/**
 * The bounds of a `request_decision` call (execution-model §8.2), in UTF-8
 * bytes where a length is named. A call beyond a bound is rejected, never
 * truncated.
 */
export const REQUEST_DECISION_BOUNDS = Object.freeze({
  questionMaxBytes: 2_000,
  minOptions: 2,
  maxOptions: 16,
  optionKeyMaxBytes: 64,
  optionLabelMaxBytes: 200,
  optionDescriptionMaxBytes: 500,
  rationaleMaxBytes: 2_000,
  /** The Requirement, Task, and Plan Node ids one request may affect, each. */
  maxAffectedIds: 64,
  /** The Evidence Artifacts a waiver request may name. */
  maxEvidenceArtifacts: 20,
});

const boundedText = boundedString;
/** A bounded key: printable, no whitespace, at most `optionKeyMaxBytes` bytes. */
const optionKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "expected an option key of letters, digits, underscores, dots, colons, or hyphens")
  .refine((key) => utf8ByteLength(key) <= REQUEST_DECISION_BOUNDS.optionKeyMaxBytes, { message: `at most ${REQUEST_DECISION_BOUNDS.optionKeyMaxBytes} UTF-8 bytes` });

/** One option a requester offers the operator; order is operator-facing semantic data and is preserved. */
export interface RequestedDecisionOption {
  key: string;
  label: string;
  description?: string;
}

export const requestedDecisionOptionSchema: z.ZodType<RequestedDecisionOption> = z.strictObject({
  key: optionKeySchema,
  label: boundedText(REQUEST_DECISION_BOUNDS.optionLabelMaxBytes),
  description: boundedText(REQUEST_DECISION_BOUNDS.optionDescriptionMaxBytes).optional(),
});

/** The resolution policy a requester chooses: the operator must answer, or the persisted recommendation applies once due. */
export type RequestedResolutionPolicy = { kind: "operator_required" } | { kind: "use_default_after_deadline"; deadlineAt?: Timestamp; activationCondition?: ActivationCondition };

export const requestedResolutionPolicySchema: z.ZodType<RequestedResolutionPolicy> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("operator_required") }),
  z.strictObject({ kind: z.literal("use_default_after_deadline"), deadlineAt: timestampSchema.optional(), activationCondition: activationConditionSchema.optional() }),
]);

/** The Requirement, Task, and Plan Node ids a requested `operator_choice` affects; each list bounded, unique, and within the caller's scope. */
export interface RequestedDecisionAffects {
  requirementIds: readonly RequirementId[];
  taskIds: readonly TaskId[];
  planNodeIds: readonly PlanNodeId[];
}

const boundedIds = <T extends string>(schema: z.ZodType<T>) => uniqueIds(schema).max(REQUEST_DECISION_BOUNDS.maxAffectedIds);

export const requestedDecisionAffectsSchema: z.ZodType<RequestedDecisionAffects> = z.strictObject({
  requirementIds: boundedIds(idSchema("requirement")),
  taskIds: boundedIds(idSchema("task")),
  planNodeIds: boundedIds(idSchema("planNode")),
}) as unknown as z.ZodType<RequestedDecisionAffects>;

/**
 * The closed input of a `request_decision` call (execution-model §8.2):
 * exactly one of the two requestable Decision kinds.
 *
 * - `operator_choice`: a bounded question, 2–16 ordered options with unique
 *   keys, an optional recommendation naming one of them, an optional
 *   rationale, the resolution policy, and the exact Requirement, Task, and
 *   Plan Node ids the answer affects (validated against the caller's scope
 *   by the runtime). `use_default_after_deadline` requires the
 *   recommendation, the rationale, at least one affected id, and a deadline
 *   or an activation condition.
 * - `requirement_waiver`: the one leaf Requirement to waive, the rationale,
 *   and optional Evidence Artifacts of the Run. The options (`waive`,
 *   `deny`), the policy (`operator_required`), and the subject are fixed by
 *   the runtime; only the root Orchestrator may request one.
 */
export type RequestDecisionInput =
  | {
      kind: "operator_choice";
      question: string;
      options: readonly RequestedDecisionOption[];
      recommendedOptionKey?: string;
      rationale?: string;
      resolutionPolicy: RequestedResolutionPolicy;
      affects: RequestedDecisionAffects;
    }
  | {
      kind: "requirement_waiver";
      requirementId: RequirementId;
      rationale: string;
      evidenceArtifactIds?: readonly ArtifactId[];
    };

export const requestDecisionInputSchema: z.ZodType<RequestDecisionInput> = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("operator_choice"),
      question: boundedText(REQUEST_DECISION_BOUNDS.questionMaxBytes),
      options: z
        .array(requestedDecisionOptionSchema)
        .min(REQUEST_DECISION_BOUNDS.minOptions)
        .max(REQUEST_DECISION_BOUNDS.maxOptions)
        .refine((options) => new Set(options.map((o) => o.key)).size === options.length, { message: "option keys are unique" }),
      recommendedOptionKey: optionKeySchema.optional(),
      rationale: boundedText(REQUEST_DECISION_BOUNDS.rationaleMaxBytes).optional(),
      resolutionPolicy: requestedResolutionPolicySchema,
      affects: requestedDecisionAffectsSchema,
    })
    .superRefine((input, ctx) => {
      if (input.recommendedOptionKey !== undefined && !input.options.some((o) => o.key === input.recommendedOptionKey)) {
        ctx.addIssue({ code: "custom", path: ["recommendedOptionKey"], message: "the recommended option must be one of the options" });
      }
      if (input.resolutionPolicy.kind === "use_default_after_deadline") {
        if (input.recommendedOptionKey === undefined) ctx.addIssue({ code: "custom", path: ["recommendedOptionKey"], message: "use_default_after_deadline requires a recommended option" });
        if (input.rationale === undefined) ctx.addIssue({ code: "custom", path: ["rationale"], message: "use_default_after_deadline requires a rationale" });
        if (input.resolutionPolicy.deadlineAt === undefined && input.resolutionPolicy.activationCondition === undefined) {
          ctx.addIssue({ code: "custom", path: ["resolutionPolicy"], message: "use_default_after_deadline requires a deadline or an activation condition" });
        }
        if (input.affects.requirementIds.length + input.affects.taskIds.length + input.affects.planNodeIds.length === 0) {
          ctx.addIssue({ code: "custom", path: ["affects"], message: "use_default_after_deadline requires at least one affected id" });
        }
      }
    }),
  z.strictObject({
    kind: z.literal("requirement_waiver"),
    requirementId: idSchema("requirement"),
    rationale: boundedText(REQUEST_DECISION_BOUNDS.rationaleMaxBytes),
    evidenceArtifactIds: uniqueIds(idSchema("artifact")).max(REQUEST_DECISION_BOUNDS.maxEvidenceArtifacts).optional(),
  }),
]) as unknown as z.ZodType<RequestDecisionInput>;

// ---------------------------------------------------------------------------
// write_artifact
// ---------------------------------------------------------------------------

/**
 * The bounds of a `write_artifact` call. Content is measured in decoded
 * bytes; a call beyond a bound is rejected, never truncated. The per-turn
 * bounds are enforced over the caller's logical turn (the Invocation plus
 * its approval predecessors) from the accepted `runtime_tool_calls` rows,
 * so a replayed identical call consumes nothing twice.
 */
export const WRITE_ARTIFACT_BOUNDS = Object.freeze({
  /** UTF-8 bytes of the title. */
  titleMaxBytes: 200,
  /** UTF-8 bytes of the media type. */
  mediaTypeMaxBytes: 200,
  /** Decoded content bytes per call (48 KiB). */
  maxContentBytes: 49_152,
  /** Accepted `write_artifact` calls per logical turn. */
  maxCallsPerTurn: 32,
  /** Cumulative decoded bytes created by one logical turn (1 MiB). */
  maxTotalContentBytes: 1_048_576,
});

/** The encoded-content bound a schema can check before decoding: base64 of `maxContentBytes` bytes. */
export const WRITE_ARTIFACT_MAX_ENCODED_LENGTH = Math.ceil(WRITE_ARTIFACT_BOUNDS.maxContentBytes / 3) * 4;

/**
 * What the model supplies for one created Artifact — and nothing else: the
 * runtime derives the Artifact id, digest, byte size, producer, Run, Plan
 * Node, Invocation, and Attempt, and owns the storage key. The media type
 * is the normalized lower-case form.
 */
export interface WriteArtifactInput {
  title: string;
  mediaType: string;
  encoding: ArtifactContentEncoding;
  content: string;
}

export const writeArtifactInputSchema: z.ZodType<WriteArtifactInput> = z.strictObject({
  title: boundedString(WRITE_ARTIFACT_BOUNDS.titleMaxBytes),
  mediaType: mediaTypeSchema
    .refine((type) => type === type.toLowerCase(), { message: "the media type is the normalized lower-case form" })
    .refine((type) => utf8ByteLength(type) <= WRITE_ARTIFACT_BOUNDS.mediaTypeMaxBytes, { message: `at most ${WRITE_ARTIFACT_BOUNDS.mediaTypeMaxBytes} UTF-8 bytes` }),
  encoding: z.enum(ARTIFACT_CONTENT_ENCODINGS),
  // The exact decoded-byte bound is enforced by the handler after decoding; this refuses grossly oversized text early.
  content: z.string().max(WRITE_ARTIFACT_MAX_ENCODED_LENGTH),
});

// ---------------------------------------------------------------------------
// Calls, results, outcomes
// ---------------------------------------------------------------------------

/** A runtime-tool call as the adapter submits it: a closed union, never a free tool name with unvalidated input. */
export type RuntimeToolCallRequest =
  | { tool: "propose_tasks"; input: TaskProposalBatch }
  | { tool: "update_task"; input: TaskUpdateRequest }
  | { tool: "request_completion"; input: CompletionCallInput }
  | { tool: "request_decision"; input: RequestDecisionInput }
  | { tool: "write_artifact"; input: WriteArtifactInput }
  | { tool: "read_requirements"; input: ReadRequirementsInput }
  | { tool: "read_decisions"; input: ReadDecisionsInput }
  | { tool: "read_tasks"; input: ReadTasksInput }
  | { tool: "read_artifact"; input: ReadArtifactInput }
  | { tool: "read_execution_plan"; input: ReadExecutionPlanInput }
  | { tool: "read_agent_definitions"; input: ReadAgentDefinitionsInput };

export const runtimeToolCallRequestSchema: z.ZodType<RuntimeToolCallRequest> = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("propose_tasks"), input: taskProposalBatchSchema }),
  z.strictObject({ tool: z.literal("update_task"), input: taskUpdateRequestSchema }),
  z.strictObject({ tool: z.literal("request_completion"), input: completionCallInputSchema }),
  z.strictObject({ tool: z.literal("request_decision"), input: requestDecisionInputSchema }),
  z.strictObject({ tool: z.literal("write_artifact"), input: writeArtifactInputSchema }),
  z.strictObject({ tool: z.literal("read_requirements"), input: readRequirementsInputSchema }),
  z.strictObject({ tool: z.literal("read_decisions"), input: readDecisionsInputSchema }),
  z.strictObject({ tool: z.literal("read_tasks"), input: readTasksInputSchema }),
  z.strictObject({ tool: z.literal("read_artifact"), input: readArtifactInputSchema }),
  z.strictObject({ tool: z.literal("read_execution_plan"), input: readExecutionPlanInputSchema }),
  z.strictObject({ tool: z.literal("read_agent_definitions"), input: readAgentDefinitionsInputSchema }),
]);

/** The read requests of the closed union. */
export type RuntimeToolReadRequest = Extract<RuntimeToolCallRequest, { tool: RuntimeToolReadTool }>;

/** The bound on a call's canonical bytes; a larger call is rejected, never truncated. */
export const RUNTIME_TOOL_CALL_MAX_BYTES = 65_536;

/**
 * The canonical-byte bound of a `write_artifact` call: sized so that a
 * maximal valid payload — 48 KiB of decoded content as base64 (65,536
 * characters) plus the bounded title, media type, and envelope — always
 * fits. Text whose JSON escaping inflates beyond this bound is submitted
 * as base64 instead; nothing is ever truncated.
 */
export const WRITE_ARTIFACT_CALL_MAX_BYTES = 98_304;

/** The canonical-byte bound of one call of `tool`. */
export function runtimeToolCallMaxBytes(tool: ExecutableRuntimeTool): number {
  return tool === "write_artifact" ? WRITE_ARTIFACT_CALL_MAX_BYTES : RUNTIME_TOOL_CALL_MAX_BYTES;
}

/** The canonical bytes of a validated call: canonical JSON of exactly `{ input, tool }`; two calls are the same call iff these are equal. */
export function canonicalRuntimeToolCall(request: RuntimeToolCallRequest): string {
  return canonicalJson({ tool: request.tool, input: request.input });
}

/** The bounded, typed result of an accepted call: ids and stable facts only, never copied domain history. */
export type RuntimeToolResult =
  | { tool: "propose_tasks"; taskIds: TaskId[]; taskIdsByKey: Record<string, TaskId> }
  | { tool: "update_task"; taskId: TaskId; status: TaskStatus }
  /** The Completion Request the call created (or, on replay, found); its status at commit time. */
  | { tool: "request_completion"; completionRequestId: CompletionRequestId; status: CompletionRequestStatus }
  /** The open Decision the call created (or, on replay, found); an accepted request ends the logical turn, so the provider must stop. */
  | { tool: "request_decision"; decisionId: DecisionId; status: "open"; blocksInvocation: true }
  /** The Artifact the call created (or, on replay, found): bounded metadata only, never the content, a storage key, or a path. */
  | { tool: "write_artifact"; artifactId: ArtifactId; mediaType: string; digest: string; byteSize: number; title: string };

export const runtimeToolResultSchema: z.ZodType<RuntimeToolResult> = z.discriminatedUnion("tool", [
  z
    .strictObject({ tool: z.literal("propose_tasks"), taskIds: uniqueIds(idSchema("task")).min(1), taskIdsByKey: z.record(z.string().regex(TASK_PROPOSAL_KEY_PATTERN), idSchema("task")) })
    .refine((r) => Object.keys(r.taskIdsByKey).length === r.taskIds.length && Object.values(r.taskIdsByKey).every((id) => r.taskIds.includes(id)), { message: "every key maps to one of the created Tasks", path: ["taskIdsByKey"] }),
  z.strictObject({ tool: z.literal("update_task"), taskId: idSchema("task"), status: z.enum(TASK_STATUSES) }),
  z.strictObject({ tool: z.literal("request_completion"), completionRequestId: idSchema("completionRequest"), status: z.enum(COMPLETION_REQUEST_STATUSES) }),
  z.strictObject({ tool: z.literal("request_decision"), decisionId: idSchema("decision"), status: z.literal("open"), blocksInvocation: z.literal(true) }),
  z.strictObject({ tool: z.literal("write_artifact"), artifactId: idSchema("artifact"), mediaType: mediaTypeSchema, digest: sha256Hex, byteSize: count.max(WRITE_ARTIFACT_BOUNDS.maxContentBytes), title: boundedString(WRITE_ARTIFACT_BOUNDS.titleMaxBytes) }),
]);

/** Whether an accepted result ends the caller's logical turn: the adapter must stop after it, and the runtime enforces the boundary anyway. */
export function runtimeToolResultBlocksInvocation(result: RuntimeToolResult): boolean {
  return result.tool === "request_decision" && result.blocksInvocation;
}

/** The closed reasons a call is rejected; a rejected call writes no row, no domain mutation, and no Event. */
export const RUNTIME_TOOL_REJECTION_CODES = [
  "invalid_input",
  "caller_not_running",
  /** The Run no longer admits execution: it was cancelled or hard-paused by the operator; nothing is read or written for the call (execution-model §14). */
  "run_not_executing",
  "caller_not_permitted",
  "purpose_not_permitted",
  "proposal_already_accepted",
  "duplicate_key",
  "unknown_dependency_key",
  "dependency_cycle",
  "requirement_out_of_scope",
  "requirement_retired",
  "unknown_artifact",
  "foreign_artifact",
  "foreign_dependency",
  "invalid_replacement",
  "max_tasks_exceeded",
  "invalid_bounds",
  "allocation_insufficient",
  "task_not_cancellable",
  // The completion preflight refusals (execution-model §10 `run_completion`), one code per canonical fact.
  ...COMPLETION_PREFLIGHT_CODES,
  // The `request_decision` refusals (execution-model §8.2).
  /** The requested kind is not one an agent may request. */
  "decision_kind_not_permitted",
  /** A referenced Requirement, Task, Plan Node, or activation condition lies outside the caller's scope, Run, or Conversation. */
  "decision_scope_invalid",
  /** This logical turn already committed a blocking request; a different request is refused. */
  "decision_already_requested",
  /** The resolution policy is incomplete or not permitted for the kind. */
  "invalid_resolution_policy",
  /** The Requirement is not a current leaf in a state the transition table lets become `waived`, or a waiver is already open for it. */
  "requirement_not_waivable",
  /** An Evidence Artifact does not exist, belongs to another Run, or is not readable by the caller. */
  "evidence_invalid",
  /** The logical turn ended on an accepted `request_decision`; no further call of this turn is executed. */
  "turn_ended",
  // The read refusals (execution-model §6.4 "Runtime read tools").
  /** The `after` cursor is malformed for the caller's order, or names a record outside the caller's visible set. */
  "cursor_invalid",
  /** The exactly named record does not exist or is not readable in the caller's scope; naming an id authorizes nothing. */
  "record_out_of_scope",
  /** The Artifact is not readable by this caller: not in its manifest, not produced by its own logical turn, and not routed to it. */
  "artifact_not_readable",
  /** The Artifact's content is missing from the Artifact Store; the metadata exists and the failure is not "not found". */
  "artifact_content_missing",
  /** The Artifact's stored content does not verify against its digest or byte size; never reinterpreted as "not found". */
  "artifact_content_corrupt",
  /** The requested `utf8` page is not valid UTF-8 (or the offset splits a sequence); request the range as `base64` instead. */
  "artifact_content_not_utf8",
  // The `write_artifact` refusals.
  /** The logical turn has reached its accepted `write_artifact` call bound. */
  "artifact_count_exceeded",
  /** The logical turn has reached its cumulative decoded Artifact byte bound. */
  "artifact_bytes_exceeded",
] as const;
export type RuntimeToolRejectionCode = (typeof RUNTIME_TOOL_REJECTION_CODES)[number];

export interface RuntimeToolRejection {
  code: RuntimeToolRejectionCode;
  message: string;
  /** The call path the rejection concerns (`tasks.2.requirementIds`), when one applies. */
  path: string | null;
}

export const RUNTIME_TOOL_REJECTION_MAX_MESSAGE_LENGTH = 300;

export const runtimeToolRejectionSchema: z.ZodType<RuntimeToolRejection> = z.strictObject({
  code: z.enum(RUNTIME_TOOL_REJECTION_CODES),
  message: nonEmptyString.max(RUNTIME_TOOL_REJECTION_MAX_MESSAGE_LENGTH),
  path: nonEmptyString.nullable(),
});

/** The closed outcome of one runtime-tool call. */
export type RuntimeToolCallOutcome =
  /** A successful read: a typed bounded projection, no `runtime_tool_calls` row, no Event, no digest or call id presented as durable. */
  | { kind: "read"; tool: RuntimeToolReadTool; result: RuntimeToolReadResult }
  /** An accepted mutation: committed now (`replayed: false`) or found committed under the same Invocation, tool, and digest (`replayed: true`). */
  | { kind: "accepted"; tool: RuntimeToolCallTool; callId: RuntimeToolCallId; callDigest: string; replayed: boolean; result: RuntimeToolResult }
  /** Validation refused the call; nothing was written; the adapter may correct and call again. */
  | { kind: "rejected"; tool: ExecutableRuntimeTool; reasons: RuntimeToolRejection[] }
  /** The tool is not in the port's effective callable set; nothing was written. */
  | { kind: "not_callable"; tool: string }
  /** The execution failed (a persistence or store failure); nothing persisted; the adapter may call again. */
  | { kind: "failed"; tool: ExecutableRuntimeTool; message: string };

// ---------------------------------------------------------------------------
// The canonical execution record
// ---------------------------------------------------------------------------

/**
 * The append-only record of one accepted mutating runtime-tool call: what
 * makes a retry after a lost response replayable. It carries ids, the tool,
 * the canonical digest, and the bounded result — never the call input, a
 * prompt, a transcript, or a provider message.
 */
export interface RuntimeToolCall {
  id: RuntimeToolCallId;
  runId: RunId;
  planNodeId: PlanNodeId;
  invocationId: InvocationId;
  /** The Attempt that first committed the call; a later Attempt replaying it records nothing new. */
  attemptId: AttemptId;
  tool: RuntimeToolCallTool;
  callDigest: string;
  result: RuntimeToolResult;
  committedAt: Timestamp;
}

export const runtimeToolCallSchema: z.ZodType<RuntimeToolCall> = z
  .strictObject({
    id: idSchema("runtimeToolCall"),
    runId: idSchema("run"),
    planNodeId: idSchema("planNode"),
    invocationId: idSchema("invocation"),
    attemptId: idSchema("attempt"),
    tool: z.enum(RUNTIME_TOOL_CALL_TOOLS),
    callDigest: sha256Hex,
    result: runtimeToolResultSchema,
    committedAt: timestampSchema,
  })
  .refine((c) => c.result.tool === c.tool, { message: "the result belongs to the call's tool", path: ["result"] });

export interface RuntimeToolCallInput {
  invocationId: InvocationId;
  attemptId: AttemptId;
  tool: RuntimeToolCallTool;
  callDigest: string;
  result: RuntimeToolResult;
}

export const runtimeToolCallInputSchema: z.ZodType<RuntimeToolCallInput> = z
  .strictObject({
    invocationId: idSchema("invocation"),
    attemptId: idSchema("attempt"),
    tool: z.enum(RUNTIME_TOOL_CALL_TOOLS),
    callDigest: sha256Hex,
    result: runtimeToolResultSchema,
  })
  .refine((c) => c.result.tool === c.tool, { message: "the result belongs to the call's tool", path: ["result"] });
