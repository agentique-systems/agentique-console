import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.ts";
import { newId } from "./ids.ts";
import { assertTaskCompletion, TASK_STATUSES, taskInputSchema, taskSchema, wouldCreateDependencyCycle } from "./tasks.ts";

describe("task states", () => {
  it("are exactly the seven runtime-owned states", () => {
    expect(TASK_STATUSES).toEqual(["pending", "ready", "running", "blocked", "completed", "failed", "cancelled"]);
  });

  it("ties block and failure fields to their statuses and endedAt to terminal", () => {
    const base = {
      id: newId("task"),
      runId: newId("run"),
      planNodeId: null,
      invocationId: null,
      origin: "orchestrator",
      gateId: null,
      subject: "do it",
      requirementIds: [],
      requirementRevisionId: null,
      inputArtifactIds: [],
      requiredOutputs: [],
      outputArtifactIds: [],
      evidence: [],
      status: "pending",
      blockReason: null,
      failureReason: null,
      replacesTaskId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
    };
    expect(taskSchema.safeParse(base).success).toBe(true);
    expect(taskSchema.safeParse({ ...base, status: "blocked" }).success).toBe(false);
    expect(taskSchema.safeParse({ ...base, status: "blocked", blockReason: { kind: "input", description: "missing" } }).success).toBe(true);
    expect(taskSchema.safeParse({ ...base, status: "failed", endedAt: base.createdAt }).success).toBe(false);
    expect(taskSchema.safeParse({ ...base, status: "failed", failureReason: "attempts_exhausted", endedAt: base.createdAt }).success).toBe(true);
    expect(taskSchema.safeParse({ ...base, status: "completed" }).success).toBe(false);
    expect(taskSchema.safeParse({ ...base, status: "in_progress" }).success).toBe(false);
    expect(taskSchema.safeParse({ ...base, status: "deleted" }).success).toBe(false);
    expect(taskSchema.safeParse({ ...base, invocationId: newId("invocation") }).success).toBe(false);
  });

  it("a Coordinator-proposed Task names its node, pinned revision, and Requirements", () => {
    const input = { runId: newId("run"), planNodeId: newId("planNode"), origin: "coordinator", subject: "s", requirementIds: [newId("requirement")], requirementRevisionId: newId("requirementRevision"), inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null };
    expect(taskInputSchema.safeParse(input).success).toBe(true);
    expect(taskInputSchema.safeParse({ ...input, requirementIds: [] }).success).toBe(false);
    expect(taskInputSchema.safeParse({ ...input, planNodeId: null }).success).toBe(false);
    expect(taskInputSchema.safeParse({ ...input, requirementRevisionId: null }).success).toBe(false);
    expect(taskInputSchema.safeParse({ ...input, origin: "orchestrator", requirementIds: [], planNodeId: null, requirementRevisionId: null }).success).toBe(true);
  });
});

describe("dependency cycles", () => {
  it("detects direct, transitive, and self cycles", () => {
    const a = newId("task");
    const b = newId("task");
    const c = newId("task");
    const edges = [
      { taskId: b, dependsOnTaskId: a },
      { taskId: c, dependsOnTaskId: b },
    ];
    expect(wouldCreateDependencyCycle(edges, a, c)).toBe(true);
    expect(wouldCreateDependencyCycle(edges, a, b)).toBe(true);
    expect(wouldCreateDependencyCycle(edges, a, a)).toBe(true);
    expect(wouldCreateDependencyCycle(edges, c, a)).toBe(false);
    expect(wouldCreateDependencyCycle([], a, b)).toBe(false);
  });
});

describe("completion", () => {
  it("requires Evidence and required outputs", () => {
    expect(() => assertTaskCompletion([], [], [])).toThrow(ValidationError);
    expect(() => assertTaskCompletion([{ kind: "artifact", artifactId: newId("artifact") }], ["report"], [])).toThrow(/required outputs/);
    expect(() => assertTaskCompletion([{ kind: "artifact", artifactId: newId("artifact") }], ["report"], [newId("artifact")])).not.toThrow();
  });
});
