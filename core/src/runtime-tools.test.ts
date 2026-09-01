import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import { RUNTIME_TOOLS_BY_ROLE } from "./invocations.ts";
import {
  canonicalRuntimeToolCall,
  effectiveRuntimeTools,
  REQUEST_DECISION_BOUNDS,
  requestDecisionInputSchema,
  EXECUTABLE_RUNTIME_TOOLS,
  RUNTIME_TOOL_CALL_TOOLS,
  RUNTIME_TOOL_HANDLER_BINDINGS,
  RUNTIME_TOOL_READ_TOOLS,
  RUNTIME_TOOL_REJECTION_CODES,
  runtimeToolCallRequestSchema,
  runtimeToolCallSchema,
  runtimeToolResultBlocksInvocation,
  runtimeToolResultSchema,
  runtimeToolsFor,
  taskProposalBatchSchema,
  type RuntimeToolCallRequest,
  type TaskProposal,
} from "./runtime-tools.ts";
import { coordinatorBlockerKey } from "./tasks.ts";

const requirementId = newId("requirement");
const taskId = newId("task");

function proposal(overrides: Partial<TaskProposal> = {}): TaskProposal {
  return { key: "a", subject: "do it", requirementIds: [requirementId], inputArtifactIds: [], requiredOutputs: ["report"], dependsOnKeys: [], dependsOnTaskIds: [], replacesTaskId: null, ...overrides };
}

describe("runtime tools", () => {
  it("distinguishes role permission, manifest permission, handler availability, and the effective callable set", () => {
    expect(RUNTIME_TOOLS_BY_ROLE.coordinator).toContain("propose_tasks");
    expect(runtimeToolsFor("coordinator", "decompose")).toEqual(RUNTIME_TOOLS_BY_ROLE.coordinator);
    expect(runtimeToolsFor("coordinator", "replan")).toEqual(RUNTIME_TOOLS_BY_ROLE.coordinator);
    expect(runtimeToolsFor("coordinator", "synthesize")).toEqual(RUNTIME_TOOLS_BY_ROLE.coordinator.filter((t) => t !== "propose_tasks" && t !== "update_task"));
    expect(runtimeToolsFor("worker", "task")).toEqual(RUNTIME_TOOLS_BY_ROLE.worker);
    expect(runtimeToolsFor("orchestrator", "operator_input")).toEqual(RUNTIME_TOOLS_BY_ROLE.orchestrator);
    expect(RUNTIME_TOOL_CALL_TOOLS).toEqual(["propose_tasks", "update_task", "request_completion", "request_decision", "write_artifact", "create_tasks", "record_decision", "propose_requirements", "revise_execution_plan"]);
    expect(RUNTIME_TOOL_READ_TOOLS).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions"]);
    expect(EXECUTABLE_RUNTIME_TOOLS).toEqual([...RUNTIME_TOOL_READ_TOOLS, ...RUNTIME_TOOL_CALL_TOOLS]);
    expect(RUNTIME_TOOL_HANDLER_BINDINGS.propose_tasks).toEqual([{ role: "coordinator", purposes: ["decompose", "replan"] }]);
    const READS = [...RUNTIME_TOOL_READ_TOOLS];
    // Effective = manifest ∩ handlers ∩ role/purpose validity: a permitted tool without a handler is never callable.
    expect(effectiveRuntimeTools(runtimeToolsFor("coordinator", "decompose"), "coordinator", "decompose")).toEqual([...READS, "propose_tasks", "update_task", "request_decision", "write_artifact"]);
    expect(effectiveRuntimeTools(runtimeToolsFor("coordinator", "synthesize"), "coordinator", "synthesize")).toEqual([...READS, "request_decision", "write_artifact"]);
    expect(effectiveRuntimeTools(runtimeToolsFor("worker", "task"), "worker", "task")).toEqual([...READS, "update_task", "request_decision", "write_artifact"]);
    expect(effectiveRuntimeTools(runtimeToolsFor("orchestrator", "operator_input"), "orchestrator", "operator_input")).toEqual([...READS, "update_task", "request_completion", "request_decision", "write_artifact", "create_tasks", "record_decision", "propose_requirements", "revise_execution_plan"]);
    // The read-only final synthesis may use every bounded read tool but no mutating runtime tool at all.
    expect(effectiveRuntimeTools(runtimeToolsFor("orchestrator", "final_synthesis"), "orchestrator", "final_synthesis")).toEqual(READS);
    expect(runtimeToolsFor("orchestrator", "final_synthesis")).not.toContain("request_completion");
    expect(runtimeToolsFor("orchestrator", "final_synthesis")).not.toContain("request_decision");
    expect(runtimeToolsFor("orchestrator", "final_synthesis")).not.toContain("write_artifact");
    expect(effectiveRuntimeTools(["update_task"], "coordinator", "decompose")).toEqual(["update_task"]);
    expect(effectiveRuntimeTools(["propose_tasks"], "worker", "task")).toEqual([]);
    // A tool omitted from the persisted manifest is not callable even though a handler exists.
    expect(effectiveRuntimeTools(["read_tasks"], "worker", "task")).toEqual(["read_tasks"]);
    // An Evaluator never holds request_decision, so no Gate, optimizer round, route selection, or Run completion evaluation can
    // request one; it reads within its scope and may create a bounded Evidence Artifact, mutating no Task and no orchestration state.
    for (const purpose of ["select", "evaluate"] as const) expect(effectiveRuntimeTools(runtimeToolsFor("evaluator", purpose), "evaluator", purpose)).toEqual([...READS, "write_artifact"]);
    expect(effectiveRuntimeTools(["request_decision"] as never, "evaluator", "evaluate")).toEqual([]);
  });

  it("bounds a request_decision strictly: closed kinds, ordered unique options within 2–16, byte-bounded text, a recommendation among the options, a complete default policy, and no unknown keys", () => {
    const option = (key: string, extra: Record<string, unknown> = {}) => ({ key, label: `Option ${key}`, ...extra });
    const choice = (overrides: Record<string, unknown> = {}) => ({ kind: "operator_choice", question: "Which?", options: [option("a"), option("b", { description: "the other" })], recommendedOptionKey: "a", rationale: "because", resolutionPolicy: { kind: "operator_required" }, affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, ...overrides });
    const ok = (input: unknown) => requestDecisionInputSchema.safeParse(input).success;
    expect(ok(choice())).toBe(true);
    expect(ok(choice({ recommendedOptionKey: undefined, rationale: undefined }))).toBe(true);
    expect(REQUEST_DECISION_BOUNDS).toEqual({ questionMaxBytes: 2_000, minOptions: 2, maxOptions: 16, optionKeyMaxBytes: 64, optionLabelMaxBytes: 200, optionDescriptionMaxBytes: 500, rationaleMaxBytes: 2_000, maxAffectedIds: 64, maxEvidenceArtifacts: 20 });
    // Kinds: exactly the two requestable ones; every other kind and every unknown key is refused.
    for (const kind of ["orchestrator_choice", "side_effect_approval", "signoff", "publish", "budget_increase", "anything"]) expect(ok(choice({ kind })), kind).toBe(false);
    expect(ok(choice({ extra: true }))).toBe(false);
    expect(ok(choice({ options: [option("a"), option("b", { extra: 1 })] }))).toBe(false);
    // Options: 2–16, unique keys, bounded key/label/description, order preserved by the parser.
    expect(ok(choice({ options: [option("a")] }))).toBe(false);
    expect(ok(choice({ options: Array.from({ length: 17 }, (_, i) => option(`k${i}`)) }))).toBe(false);
    expect(ok(choice({ options: Array.from({ length: 16 }, (_, i) => option(`k${i}`)), recommendedOptionKey: "k3" }))).toBe(true);
    expect(ok(choice({ options: [option("a"), option("a")] }))).toBe(false);
    expect(ok(choice({ options: [option("a"), option("x".repeat(65))] }))).toBe(false);
    expect(ok(choice({ options: [option("a"), option("b c")] }))).toBe(false);
    expect(ok(choice({ options: [option("a"), option("b", { label: "y".repeat(201) })] }))).toBe(false);
    expect(ok(choice({ options: [option("a"), option("b", { label: "" })] }))).toBe(false);
    expect(ok(choice({ options: [option("a"), option("b", { description: "z".repeat(501) })] }))).toBe(false);
    expect(ok(choice({ options: [option("a"), option("b", { description: "é".repeat(250) })] }))).toBe(true);
    expect(ok(choice({ options: [option("a"), option("b", { description: "é".repeat(251) })] }))).toBe(false);
    const parsed = requestDecisionInputSchema.safeParse(choice({ options: [option("z"), option("m"), option("a")], recommendedOptionKey: "m" }));
    expect(parsed.success && parsed.data.kind === "operator_choice" ? parsed.data.options.map((o) => o.key) : []).toEqual(["z", "m", "a"]);
    // Text bounds are UTF-8 bytes: 2 000 bytes of question fit, 2 001 do not, whatever the character count.
    expect(ok(choice({ question: "q".repeat(2_000) }))).toBe(true);
    expect(ok(choice({ question: "q".repeat(2_001) }))).toBe(false);
    expect(ok(choice({ question: "€".repeat(667) }))).toBe(false);
    expect(ok(choice({ question: "   " }))).toBe(false);
    expect(ok(choice({ rationale: "r".repeat(2_001) }))).toBe(false);
    // The recommendation names an option; the default policy needs the recommendation, the rationale, a deadline or condition, and affected ids.
    expect(ok(choice({ recommendedOptionKey: "zzz" }))).toBe(false);
    const deadline = { kind: "use_default_after_deadline", deadlineAt: "2026-06-01T00:00:00.000Z" };
    const affects = { requirementIds: [], taskIds: [], planNodeIds: [newId("planNode")] };
    expect(ok(choice({ resolutionPolicy: deadline, affects }))).toBe(true);
    expect(ok(choice({ resolutionPolicy: { kind: "use_default_after_deadline", activationCondition: { kind: "plan_node_ready", planNodeId: newId("planNode") } }, affects }))).toBe(true);
    expect(ok(choice({ resolutionPolicy: { kind: "use_default_after_deadline" }, affects }))).toBe(false);
    expect(ok(choice({ resolutionPolicy: deadline }))).toBe(false);
    expect(ok(choice({ resolutionPolicy: deadline, affects, recommendedOptionKey: undefined }))).toBe(false);
    expect(ok(choice({ resolutionPolicy: deadline, affects, rationale: undefined }))).toBe(false);
    expect(ok(choice({ resolutionPolicy: { kind: "use_default_after_deadline", deadlineAt: "2026-06-01" }, affects }))).toBe(false);
    expect(ok(choice({ resolutionPolicy: { kind: "use_default_after_deadline", deadlineAt: Number.NaN }, affects }))).toBe(false);
    expect(ok(choice({ resolutionPolicy: { kind: "use_default_after_deadline", activationCondition: { kind: "always" } }, affects }))).toBe(false);
    expect(ok(choice({ resolutionPolicy: { kind: "operator_required", deadlineAt: "2026-06-01T00:00:00.000Z" } }))).toBe(false);
    // Affected ids: typed, unique, bounded.
    const id = newId("task");
    expect(ok(choice({ affects: { requirementIds: [], taskIds: [id, id], planNodeIds: [] } }))).toBe(false);
    expect(ok(choice({ affects: { requirementIds: [], taskIds: ["task_x"], planNodeIds: [] } }))).toBe(false);
    expect(ok(choice({ affects: { requirementIds: [], taskIds: Array.from({ length: 65 }, () => newId("task")), planNodeIds: [] } }))).toBe(false);
    // A waiver names one Requirement and a rationale; evidence is optional, unique, bounded; a waiver defines no options or policy.
    const requirementId = newId("requirement");
    expect(ok({ kind: "requirement_waiver", requirementId, rationale: "cannot be met" })).toBe(true);
    expect(ok({ kind: "requirement_waiver", requirementId, rationale: "cannot be met", evidenceArtifactIds: [newId("artifact")] })).toBe(true);
    expect(ok({ kind: "requirement_waiver", requirementId, rationale: "" })).toBe(false);
    expect(ok({ kind: "requirement_waiver", requirementId })).toBe(false);
    expect(ok({ kind: "requirement_waiver", requirementId, rationale: "x", options: [option("waive"), option("deny")] })).toBe(false);
    expect(ok({ kind: "requirement_waiver", requirementId, rationale: "x", resolutionPolicy: { kind: "operator_required" } })).toBe(false);
    const artifact = newId("artifact");
    expect(ok({ kind: "requirement_waiver", requirementId, rationale: "x", evidenceArtifactIds: [artifact, artifact] })).toBe(false);
    expect(ok({ kind: "requirement_waiver", requirementId, rationale: "x", evidenceArtifactIds: Array.from({ length: 21 }, () => newId("artifact")) })).toBe(false);
    // The typed result and its blocking flag.
    expect(runtimeToolResultSchema.safeParse({ tool: "request_decision", decisionId: newId("decision"), status: "open", blocksInvocation: true }).success).toBe(true);
    expect(runtimeToolResultSchema.safeParse({ tool: "request_decision", decisionId: newId("decision"), status: "resolved", blocksInvocation: true }).success).toBe(false);
    expect(runtimeToolResultSchema.safeParse({ tool: "request_decision", decisionId: newId("decision"), status: "open", blocksInvocation: false }).success).toBe(false);
    expect(runtimeToolResultBlocksInvocation({ tool: "request_decision", decisionId: newId("decision"), status: "open", blocksInvocation: true })).toBe(true);
    expect(runtimeToolResultBlocksInvocation({ tool: "request_completion", completionRequestId: newId("completionRequest"), status: "requested" })).toBe(false);
    expect(RUNTIME_TOOL_REJECTION_CODES).toEqual(expect.arrayContaining(["decision_kind_not_permitted", "caller_not_permitted", "decision_scope_invalid", "decision_already_requested", "invalid_resolution_policy", "requirement_not_waivable", "evidence_invalid", "turn_ended"]));
    expect(canonicalRuntimeToolCall({ tool: "request_decision", input: choice() as never })).toBe(canonicalRuntimeToolCall({ tool: "request_decision", input: { ...choice(), question: "Which?" } as never }));
  });

  it("validates proposals strictly and bounds them", () => {
    expect(taskProposalBatchSchema.safeParse({ tasks: [proposal()] }).success).toBe(true);
    expect(taskProposalBatchSchema.safeParse({ tasks: [] }).success).toBe(false);
    expect(taskProposalBatchSchema.safeParse({ tasks: [proposal({ requirementIds: [] })] }).success).toBe(false);
    expect(taskProposalBatchSchema.safeParse({ tasks: [proposal({ requiredOutputs: [] })] }).success).toBe(false);
    expect(taskProposalBatchSchema.safeParse({ tasks: [proposal({ requiredOutputs: ["x", "x"] })] }).success).toBe(false);
    expect(taskProposalBatchSchema.safeParse({ tasks: [proposal({ key: "bad key" })] }).success).toBe(false);
    expect(taskProposalBatchSchema.safeParse({ tasks: [proposal({ key: "k".repeat(65) })] }).success).toBe(false);
    expect(taskProposalBatchSchema.safeParse({ tasks: [proposal({ subject: "s".repeat(501) })] }).success).toBe(false);
    expect(taskProposalBatchSchema.safeParse({ tasks: [{ ...proposal(), planNodeId: newId("planNode") }] }).success).toBe(false);
    expect(taskProposalBatchSchema.safeParse({ tasks: Array.from({ length: 65 }, (_, i) => proposal({ key: `k${i}` })) }).success).toBe(false);
    expect(runtimeToolCallRequestSchema.safeParse({ tool: "update_task", input: { taskId, update: { kind: "cancel", reason: "done elsewhere" } } }).success).toBe(true);
    expect(runtimeToolCallRequestSchema.safeParse({ tool: "update_task", input: { taskId, update: { kind: "complete" } } }).success).toBe(false);
    expect(runtimeToolCallRequestSchema.safeParse({ tool: "create_tasks", input: {} }).success).toBe(false);
  });

  it("canonicalizes a call independently of object key order and distinguishes different calls", () => {
    const a: RuntimeToolCallRequest = { tool: "propose_tasks", input: { tasks: [proposal()] } };
    const b: RuntimeToolCallRequest = { input: { tasks: [{ replacesTaskId: null, dependsOnTaskIds: [], dependsOnKeys: [], requiredOutputs: ["report"], inputArtifactIds: [], requirementIds: [requirementId], subject: "do it", key: "a" }] }, tool: "propose_tasks" };
    expect(canonicalRuntimeToolCall(a)).toBe(canonicalRuntimeToolCall(b));
    expect(canonicalRuntimeToolCall(a)).toBe(`{"input":{"tasks":[{"dependsOnKeys":[],"dependsOnTaskIds":[],"inputArtifactIds":[],"key":"a","replacesTaskId":null,"requiredOutputs":["report"],"requirementIds":["${requirementId}"],"subject":"do it"}]},"tool":"propose_tasks"}`);
    expect(canonicalRuntimeToolCall({ tool: "propose_tasks", input: { tasks: [proposal({ key: "b" })] } })).not.toBe(canonicalRuntimeToolCall(a));
  });

  it("validates the call record and keys blockers stably", () => {
    const record = { id: newId("runtimeToolCall"), runId: newId("run"), planNodeId: newId("planNode"), invocationId: newId("invocation"), attemptId: newId("attempt"), tool: "propose_tasks", callDigest: "a".repeat(64), result: { tool: "propose_tasks", taskIds: [taskId], taskIdsByKey: { a: taskId } }, committedAt: "2026-01-01T00:00:00.000Z" };
    expect(runtimeToolCallSchema.safeParse(record).success).toBe(true);
    expect(runtimeToolCallSchema.safeParse({ ...record, tool: "update_task" }).success).toBe(false);
    expect(runtimeToolCallSchema.safeParse({ ...record, result: { tool: "propose_tasks", taskIds: [taskId], taskIdsByKey: { a: newId("task") } } }).success).toBe(false);
    expect(runtimeToolCallSchema.safeParse({ ...record, input: {} }).success).toBe(false);
    expect(coordinatorBlockerKey({ kind: "task_failed", taskId, failureReason: "permanent_failure" })).toBe(`task_failed:${taskId}`);
    expect(coordinatorBlockerKey({ kind: "task_blocked", taskId, blockReason: { kind: "input", description: "x" } })).toBe(`task_blocked:${taskId}:input`);
    const changesetId = newId("changeset");
    expect(coordinatorBlockerKey({ kind: "integration_conflict", taskId, invocationId: newId("invocation"), changesetId, conflictTaskId: newId("task"), reportArtifactId: null })).toBe(`integration_conflict:${changesetId}`);
  });
});
