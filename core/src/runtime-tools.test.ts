import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import { RUNTIME_TOOLS_BY_ROLE } from "./invocations.ts";
import {
  canonicalRuntimeToolCall,
  effectiveRuntimeTools,
  RUNTIME_TOOL_CALL_TOOLS,
  RUNTIME_TOOL_HANDLER_BINDINGS,
  runtimeToolCallRequestSchema,
  runtimeToolCallSchema,
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
    expect(RUNTIME_TOOL_CALL_TOOLS).toEqual(["propose_tasks", "update_task"]);
    expect(RUNTIME_TOOL_HANDLER_BINDINGS.propose_tasks).toEqual({ role: "coordinator", purposes: ["decompose", "replan"] });
    // Effective = manifest ∩ handlers ∩ role/purpose validity: a permitted tool without a handler is never callable.
    expect(effectiveRuntimeTools(runtimeToolsFor("coordinator", "decompose"), "coordinator", "decompose")).toEqual(["propose_tasks", "update_task"]);
    expect(effectiveRuntimeTools(runtimeToolsFor("coordinator", "synthesize"), "coordinator", "synthesize")).toEqual([]);
    expect(effectiveRuntimeTools(runtimeToolsFor("worker", "task"), "worker", "task")).toEqual([]);
    expect(effectiveRuntimeTools(runtimeToolsFor("orchestrator", "operator_input"), "orchestrator", "operator_input")).toEqual([]);
    expect(effectiveRuntimeTools(["update_task"], "coordinator", "decompose")).toEqual(["update_task"]);
    expect(effectiveRuntimeTools(["propose_tasks"], "worker", "task")).toEqual([]);
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
