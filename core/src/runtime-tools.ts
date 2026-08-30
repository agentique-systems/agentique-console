import { z } from "zod";
import { COMPLETION_PREFLIGHT_CODES, COMPLETION_REQUEST_STATUSES, type CompletionRequestStatus } from "./completion.ts";
import type { ArtifactId, AttemptId, CompletionRequestId, InvocationId, PlanNodeId, RequirementId, RunId, RuntimeToolCallId, TaskId } from "./ids.ts";
import { ORCHESTRATOR_PURPOSES, RUNTIME_TOOLS_BY_ROLE, type InvocationPurpose, type InvocationRole, type RuntimeTool } from "./invocations.ts";
import { TASK_STATUSES, type TaskStatus } from "./tasks.ts";
import { canonicalJson, idSchema, nonEmptyString, sha256Hex, timestampSchema, uniqueIds, type Timestamp } from "./validation.ts";

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

/** The runtime tools the execution runtime implements as executable handlers in this phase. */
export const RUNTIME_TOOL_CALL_TOOLS = ["propose_tasks", "update_task", "request_completion"] as const;
export type RuntimeToolCallTool = (typeof RUNTIME_TOOL_CALL_TOOLS)[number];

/** The Orchestrator purposes from which completion may be requested: every turn but the read-only `final_synthesis` report. */
export const COMPLETION_REQUESTING_PURPOSES = ORCHESTRATOR_PURPOSES.filter((purpose) => purpose !== "final_synthesis");

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
};

/** Manifest permission: the role's runtime tools narrowed by the Invocation's purpose. */
export function runtimeToolsFor(role: InvocationRole, purpose: InvocationPurpose): RuntimeTool[] {
  return RUNTIME_TOOLS_BY_ROLE[role].filter((tool) => !(PURPOSE_EXCLUSIONS[tool] ?? []).includes(purpose));
}

/** The role and purposes each executable handler is valid for; a call outside this table is never callable. */
export const RUNTIME_TOOL_HANDLER_BINDINGS: Readonly<Record<RuntimeToolCallTool, { role: InvocationRole; purposes: readonly InvocationPurpose[] }>> = {
  propose_tasks: { role: "coordinator", purposes: ["decompose", "replan"] },
  // The Coordinator-permitted subset of `update_task`: cancelling the node's own unstarted or blocked current Tasks.
  update_task: { role: "coordinator", purposes: ["decompose", "replan"] },
  // Only the root Orchestrator requests completion (execution-model §10), never from its read-only final-synthesis turn.
  request_completion: { role: "orchestrator", purposes: COMPLETION_REQUESTING_PURPOSES },
};

/** The effective callable set of one Invocation: manifest permission ∩ runtime handlers ∩ role/purpose validity. */
export function effectiveRuntimeTools(manifestTools: readonly RuntimeTool[], role: InvocationRole, purpose: InvocationPurpose): RuntimeToolCallTool[] {
  return RUNTIME_TOOL_CALL_TOOLS.filter((tool) => manifestTools.includes(tool) && RUNTIME_TOOL_HANDLER_BINDINGS[tool].role === role && RUNTIME_TOOL_HANDLER_BINDINGS[tool].purposes.includes(purpose));
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
// Calls, results, outcomes
// ---------------------------------------------------------------------------

/** A runtime-tool call as the adapter submits it: a closed union, never a free tool name with unvalidated input. */
export type RuntimeToolCallRequest = { tool: "propose_tasks"; input: TaskProposalBatch } | { tool: "update_task"; input: TaskUpdateRequest } | { tool: "request_completion"; input: CompletionCallInput };

export const runtimeToolCallRequestSchema: z.ZodType<RuntimeToolCallRequest> = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("propose_tasks"), input: taskProposalBatchSchema }),
  z.strictObject({ tool: z.literal("update_task"), input: taskUpdateRequestSchema }),
  z.strictObject({ tool: z.literal("request_completion"), input: completionCallInputSchema }),
]);

/** The bound on a call's canonical bytes; a larger call is rejected, never truncated. */
export const RUNTIME_TOOL_CALL_MAX_BYTES = 65_536;

/** The canonical bytes of a validated call: canonical JSON of exactly `{ input, tool }`; two calls are the same call iff these are equal. */
export function canonicalRuntimeToolCall(request: RuntimeToolCallRequest): string {
  return canonicalJson({ tool: request.tool, input: request.input });
}

/** The bounded, typed result of an accepted call: ids and stable facts only, never copied domain history. */
export type RuntimeToolResult =
  | { tool: "propose_tasks"; taskIds: TaskId[]; taskIdsByKey: Record<string, TaskId> }
  | { tool: "update_task"; taskId: TaskId; status: TaskStatus }
  /** The Completion Request the call created (or, on replay, found); its status at commit time. */
  | { tool: "request_completion"; completionRequestId: CompletionRequestId; status: CompletionRequestStatus };

export const runtimeToolResultSchema: z.ZodType<RuntimeToolResult> = z.discriminatedUnion("tool", [
  z
    .strictObject({ tool: z.literal("propose_tasks"), taskIds: uniqueIds(idSchema("task")).min(1), taskIdsByKey: z.record(z.string().regex(TASK_PROPOSAL_KEY_PATTERN), idSchema("task")) })
    .refine((r) => Object.keys(r.taskIdsByKey).length === r.taskIds.length && Object.values(r.taskIdsByKey).every((id) => r.taskIds.includes(id)), { message: "every key maps to one of the created Tasks", path: ["taskIdsByKey"] }),
  z.strictObject({ tool: z.literal("update_task"), taskId: idSchema("task"), status: z.enum(TASK_STATUSES) }),
  z.strictObject({ tool: z.literal("request_completion"), completionRequestId: idSchema("completionRequest"), status: z.enum(COMPLETION_REQUEST_STATUSES) }),
]);

/** The closed reasons a call is rejected; a rejected call writes no row, no domain mutation, and no Event. */
export const RUNTIME_TOOL_REJECTION_CODES = [
  "invalid_input",
  "caller_not_running",
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
  /** Committed now (`replayed: false`) or found committed under the same Invocation, tool, and digest (`replayed: true`). */
  | { kind: "accepted"; tool: RuntimeToolCallTool; callId: RuntimeToolCallId; callDigest: string; replayed: boolean; result: RuntimeToolResult }
  /** Validation refused the call; nothing was written; the adapter may correct and call again. */
  | { kind: "rejected"; tool: RuntimeToolCallTool; reasons: RuntimeToolRejection[] }
  /** The tool is not in the port's effective callable set; nothing was written. */
  | { kind: "not_callable"; tool: string }
  /** The commit failed (a persistence failure); nothing persisted; the adapter may call again. */
  | { kind: "failed"; tool: RuntimeToolCallTool; message: string };

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
