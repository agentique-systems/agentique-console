import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConflictError, InvariantViolationError, type RuntimeToolCallInput } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness, seedInvocation, seedManifest, seedRun, seedWorkerNode, type Harness, type Seeded } from "../test-support.ts";

const DIGEST = "a".repeat(64);

/** A running decompose Attempt on a coordinator_worker node. */
function runningTurn(h: Harness, s: Seeded) {
  const node = seedWorkerNode(h, s, "coordinator_worker");
  const invocation = seedInvocation(h, s, { role: "coordinator", purpose: "decompose", planNodeId: node.id });
  seedManifest(h, s, invocation);
  const attempt = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
  h.stores.invocations.transition(invocation.id, { to: "running" });
  h.stores.invocations.transitionAttempt(attempt.id, { to: "running", capacityLeaseId: null });
  return { node, invocation, attempt };
}

function input(t: ReturnType<typeof runningTurn>, taskId: string, overrides: Partial<RuntimeToolCallInput> = {}): RuntimeToolCallInput {
  return { invocationId: t.invocation.id, attemptId: t.attempt.id, tool: "propose_tasks", callDigest: DIGEST, result: { tool: "propose_tasks", taskIds: [taskId as never], taskIdsByKey: { a: taskId as never } }, ...overrides };
}

describe("runtime-tool calls", () => {
  it("records an accepted call once for a running Attempt with one bounded Event, finds it by digest, and refuses a second proposal or a duplicate", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const t = runningTurn(h, s);
      const task = h.stores.tasks.create({ runId: s.run.id, planNodeId: t.node.id, origin: "orchestrator", subject: "t", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const seq = h.ctx.journal.lastSeq();
      const call = h.stores.runtimeToolCalls.record(input(t, task.id));
      expect(call).toMatchObject({ runId: s.run.id, planNodeId: t.node.id, invocationId: t.invocation.id, attemptId: t.attempt.id, tool: "propose_tasks", callDigest: DIGEST });
      expect(call.id).toMatch(/^rtc_[0-9a-f]{24}$/);
      expect(h.stores.runtimeToolCalls.get(call.id)).toEqual(call);
      expect(h.stores.runtimeToolCalls.find(t.invocation.id, "propose_tasks", DIGEST)).toEqual(call);
      expect(h.stores.runtimeToolCalls.find(t.invocation.id, "propose_tasks", "b".repeat(64))).toBeNull();
      expect(h.stores.runtimeToolCalls.find(t.invocation.id, "update_task", DIGEST)).toBeNull();
      expect(h.stores.runtimeToolCalls.listByInvocation(t.invocation.id)).toEqual([call]);
      expect(h.stores.runtimeToolCalls.listByAttempt(t.attempt.id)).toEqual([call]);
      expect(h.stores.runtimeToolCalls.listByPlanNode(t.node.id)).toEqual([call]);
      const events = h.ctx.journal.read({ runId: s.run.id, afterSeq: seq });
      expect(events.map((e) => e.type)).toEqual(["runtime_tool_call.committed"]);
      expect(events[0]).toMatchObject({ subjectType: "runtime_tool_call", subjectId: call.id, payload: call, actor: { kind: "invocation", invocationId: t.invocation.id }, scope: { runId: s.run.id, planNodeId: t.node.id, invocationId: t.invocation.id, attemptId: t.attempt.id } });
      // The same digest again, and a second proposal with another digest, are conflicts; a mismatched result tool is invalid.
      expect(() => h.stores.runtimeToolCalls.record(input(t, task.id))).toThrow(ConflictError);
      expect(() => h.stores.runtimeToolCalls.record(input(t, task.id, { callDigest: "b".repeat(64) }))).toThrow(/already accepted a Task proposal/);
      expect(() => h.stores.runtimeToolCalls.record(input(t, task.id, { tool: "update_task" }))).toThrow(/result belongs to the call's tool/);
      // A cancellation is recorded beside the proposal.
      const cancel = h.stores.runtimeToolCalls.record(input(t, task.id, { tool: "update_task", callDigest: "c".repeat(64), result: { tool: "update_task", taskId: task.id, status: "cancelled" } }));
      expect(h.stores.runtimeToolCalls.listByInvocation(t.invocation.id).map((c) => c.id)).toEqual([call.id, cancel.id]);
      expect(h.ctx.journal.lastSeq()).toBe(seq + 2);
    } finally {
      h.close();
    }
  });

  it("refuses a non-running Invocation or Attempt and an Attempt of another Invocation", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const t = runningTurn(h, s);
      const task = h.stores.tasks.create({ runId: s.run.id, planNodeId: t.node.id, origin: "orchestrator", subject: "t", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const other = runningTurn(h, seedRun(h));
      expect(() => h.stores.runtimeToolCalls.record(input(t, task.id, { attemptId: other.attempt.id }))).toThrow(InvariantViolationError);
      h.stores.invocations.transitionAttempt(t.attempt.id, { to: "failed", failureClass: "provider_permanent", transcriptArtifactId: null, failureDetail: { message: "gone", violations: [], tool: null, cancelled: false }, retryDecision: { permitted: false, reason: "provider_permanent", notBefore: null } });
      expect(() => h.stores.runtimeToolCalls.record(input(t, task.id))).toThrow(/must both be running/);
      h.stores.invocations.transition(t.invocation.id, { to: "failed", failureReason: "provider_permanent", result: null });
      expect(() => h.stores.runtimeToolCalls.record(input(t, task.id))).toThrow(ConflictError);
      expect(h.stores.runtimeToolCalls.listByPlanNode(t.node.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("is append-only and unique at the database, and reads back identically after close and reopen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-rtc-"));
    const file = path.join(dir, "console.db");
    const h = openHarness(file);
    let recorded!: ReturnType<Harness["stores"]["runtimeToolCalls"]["record"]>;
    let invocationId!: string;
    try {
      const s = seedRun(h);
      const t = runningTurn(h, s);
      invocationId = t.invocation.id;
      const task = h.stores.tasks.create({ runId: s.run.id, planNodeId: t.node.id, origin: "orchestrator", subject: "t", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      recorded = h.stores.runtimeToolCalls.record(input(t, task.id));
      const sqlite = h.database.sqlite;
      const insert = (id: string, tool: string, digest: string) =>
        sqlite
          .prepare("INSERT INTO runtime_tool_calls (id, run_id, plan_node_id, invocation_id, attempt_id, tool, call_digest, result, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, s.run.id, t.node.id, t.invocation.id, t.attempt.id, tool, digest, JSON.stringify({ tool, taskId: task.id, status: "cancelled" }), h.clock.now());
      // One proposal per Invocation, and one row per (Invocation, tool, digest).
      expect(() => insert(`rtc_${"1".repeat(24)}`, "propose_tasks", "d".repeat(64))).toThrow(/UNIQUE constraint failed: runtime_tool_calls.invocation_id/);
      expect(() => insert(`rtc_${"1".repeat(24)}`, "update_task", "d".repeat(64))).not.toThrow();
      expect(() => insert(`rtc_${"2".repeat(24)}`, "update_task", "d".repeat(64))).toThrow(/UNIQUE constraint failed: runtime_tool_calls.invocation_id, runtime_tool_calls.tool, runtime_tool_calls.call_digest/);
      expect(() => insert(`rtc_${"1".repeat(24)}`, "read_tasks", "d".repeat(64))).toThrow(/CHECK constraint failed: runtime_tool_calls_tool/);
      expect(() => insert(`rtc_${"1".repeat(24)}`, "update_task", "short")).toThrow(/CHECK constraint failed: runtime_tool_calls_digest_shape/);
      expect(() => sqlite.prepare("UPDATE runtime_tool_calls SET call_digest = ? WHERE id = ?").run("e".repeat(64), recorded.id)).toThrow(/append-only/);
      expect(() => sqlite.prepare("DELETE FROM runtime_tool_calls").run()).toThrow(/append-only/);
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'runtime_tool_calls' ORDER BY name").all()).toEqual([{ name: "runtime_tool_calls_no_delete" }, { name: "runtime_tool_calls_no_update" }]);
    } finally {
      h.close();
    }
    const reopened = openHarness(file);
    try {
      expect(reopened.stores.runtimeToolCalls.get(recorded.id)).toEqual(recorded);
      expect(reopened.stores.runtimeToolCalls.find(invocationId as never, "propose_tasks", DIGEST)).toEqual(recorded);
    } finally {
      reopened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
