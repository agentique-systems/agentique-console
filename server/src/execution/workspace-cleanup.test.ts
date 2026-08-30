/**
 * Crash-safe Execution Workspace cleanup (execution-model §9.1, §14): a
 * durable obligation recorded at preparation, released only after the
 * external cleanup succeeded, retried by recovery, never between retry
 * Attempts, never for a read-only Invocation.
 */
import { type Invocation } from "@agentique-console/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openHarness } from "../persistence/test-support.ts";
import { accepted, COMPLETED_RESULT, openRuntimeHarness, propose, seedPlanningRuntime, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

async function advance(h: RuntimeHarness, invocation: Invocation) {
  return h.executor.advanceInvocation(invocation.id);
}

describe("Execution Workspace cleanup", () => {
  it("records the obligation at preparation, releases after the terminal commit, marks it released only after the external cleanup, and never releases between retry Attempts", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const { invocation, manifest } = startRun(h, s).prepared;
      expect(invocation.workspaceCleanup).toBe("pending");
      expect(h.ctx.journal.read({ runId: s.created.run.id, type: "invocation.workspace_prepared" })[0]!.payload).toEqual({ invocationId: invocation.id, worktreePath: manifest.content.worktreePath });
      // A retryable failure leaves the obligation pending and releases nothing: the retry reattaches the worktree.
      h.provider.script({ kind: "transient_error" }, { kind: "succeed", result: COMPLETED_RESULT });
      const first = await advance(h, invocation);
      expect(first).toMatchObject({ kind: "finalized", settlement: { kind: "retry_pending" } });
      expect(h.executionWorkspace.released).toEqual([]);
      expect(h.stores.invocations.get(invocation.id).workspaceCleanup).toBe("pending");
      h.clock.advance(2_000);
      const second = await advance(h, invocation);
      expect(second).toMatchObject({ kind: "finalized", settlement: { invocation: { status: "succeeded" } } });
      // Terminal settlement committed first; the release followed; the record came last.
      const events = h.ctx.journal.read({ runId: s.created.run.id }).map((e) => e.type);
      expect(events.indexOf("invocation.succeeded")).toBeLessThan(events.indexOf("invocation.workspace_released"));
      expect(events.at(-1)).toBe("invocation.workspace_released");
      expect(h.executionWorkspace.released.map((r) => r.invocationId)).toEqual([invocation.id]);
      const released = h.stores.invocations.get(invocation.id);
      expect(released).toMatchObject({ status: "succeeded", workspaceCleanup: "released" });
      expect(released.workspaceReleasedAt).not.toBeNull();
      expect(h.stores.invocations.listPendingWorkspaceCleanup()).toEqual([]);
      // Already released: nothing is executed again.
      expect(h.executor.releaseWorkspace(invocation.id)).toBe("already_released");
      expect(h.executionWorkspace.released).toHaveLength(1);
      expect(h.recovery.recover().workspaceReleasedInvocationIds).toEqual([]);
      expect(h.executionWorkspace.released).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("keeps the terminal canonical outcome when the external release fails, reports it, and lets a restart retry the outstanding release", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-cleanup-"));
    const file = path.join(dir, "console.db");
    const first = openRuntimeHarness({ base: openHarness(file) });
    let invocationId!: Invocation["id"];
    let seq!: number;
    try {
      const s = seedRuntime(first);
      const { invocation } = startRun(first, s).prepared;
      invocationId = invocation.id;
      first.executionWorkspace.failReleaseWith = new Error("git worktree remove failed: EBUSY");
      first.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      const outcome = await advance(first, invocation);
      // The Attempt and Invocation succeeded regardless; the failure is a bounded diagnostic; the obligation stays pending.
      expect(outcome).toMatchObject({ kind: "finalized", attempt: { status: "succeeded" }, settlement: { invocation: { status: "succeeded" } } });
      expect(first.executionDiagnostics).toEqual([{ kind: "workspace_release_failed", invocationId: invocation.id, message: "git worktree remove failed: EBUSY" }]);
      expect(first.stores.invocations.get(invocation.id)).toMatchObject({ status: "succeeded", workspaceCleanup: "pending", workspaceReleasedAt: null });
      expect(first.stores.invocations.listPendingWorkspaceCleanup().map((i) => i.id)).toEqual([invocation.id]);
      expect(first.ctx.journal.read({ runId: s.created.run.id, type: "invocation.workspace_released" })).toEqual([]);
      seq = first.ctx.journal.lastSeq();
      // A retry in the same process that fails again changes nothing canonical either.
      expect(first.executor.releaseWorkspace(invocation.id)).toBe("failed");
      expect(first.executionDiagnostics).toHaveLength(2);
      expect(first.ctx.journal.lastSeq()).toBe(seq);
    } finally {
      first.close();
    }
    // The process died before the release ever succeeded; recovery finds and retries the obligation.
    const reopened = openRuntimeHarness({ base: openHarness(file) });
    try {
      expect(reopened.stores.invocations.listPendingWorkspaceCleanup().map((i) => i.id)).toEqual([invocationId]);
      const report = reopened.recovery.recover();
      expect(report).toMatchObject({ interruptedAttemptIds: [], workspaceReleasedInvocationIds: [invocationId], workspaceReleaseFailedInvocationIds: [] });
      expect(reopened.executionWorkspace.released.map((r) => r.invocationId)).toEqual([invocationId]);
      expect(reopened.stores.invocations.get(invocationId)).toMatchObject({ status: "succeeded", workspaceCleanup: "released" });
      expect(reopened.ctx.journal.lastSeq()).toBe(seq + 1);
      // Repeated recovery and repeated release are harmless.
      expect(reopened.recovery.recover().workspaceReleasedInvocationIds).toEqual([]);
      expect(reopened.executor.releaseWorkspace(invocationId)).toBe("already_released");
      expect(reopened.executionWorkspace.released).toHaveLength(1);
      expect(reopened.ctx.journal.lastSeq()).toBe(seq + 1);
    } finally {
      reopened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries a release that keeps failing across restarts without touching canonical state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-cleanup-"));
    const file = path.join(dir, "console.db");
    const first = openRuntimeHarness({ base: openHarness(file) });
    let invocationId!: Invocation["id"];
    try {
      const s = seedRuntime(first);
      const { invocation } = startRun(first, s).prepared;
      invocationId = invocation.id;
      first.executionWorkspace.failReleaseWith = new Error("locked");
      first.provider.script({ kind: "permanent_error" });
      expect(await advance(first, invocation)).toMatchObject({ kind: "finalized", settlement: { invocation: { status: "failed", failureReason: "provider_permanent" } } });
    } finally {
      first.close();
    }
    const reopened = openRuntimeHarness({ base: openHarness(file) });
    try {
      reopened.executionWorkspace.failReleaseWith = new Error("still locked");
      const before = reopened.ctx.journal.lastSeq();
      expect(reopened.recovery.recover()).toMatchObject({ workspaceReleasedInvocationIds: [], workspaceReleaseFailedInvocationIds: [invocationId] });
      expect(reopened.executionDiagnostics).toEqual([{ kind: "workspace_release_failed", invocationId, message: "still locked" }]);
      expect(reopened.stores.invocations.get(invocationId)).toMatchObject({ status: "failed", failureReason: "provider_permanent", workspaceCleanup: "pending" });
      expect(reopened.ctx.journal.lastSeq()).toBe(before);
      reopened.executionWorkspace.failReleaseWith = null;
      expect(reopened.recovery.recover()).toMatchObject({ workspaceReleasedInvocationIds: [invocationId], workspaceReleaseFailedInvocationIds: [] });
      expect(reopened.stores.invocations.get(invocationId).workspaceCleanup).toBe("released");
    } finally {
      reopened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("releases the worktree of a blocked, cancelled, or allocation-exhausted Invocation, and never creates an obligation for a read-only one", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      // Approval-blocked: terminal, released.
      h.provider.script({ kind: "tool_calls", calls: [{ tool: "shell", input: { command: "rm -rf build" } }], then: { kind: "succeed", result: COMPLETED_RESULT } });
      const blocked = await advance(h, s.invocation);
      expect(blocked).toMatchObject({ kind: "approval_required", settlement: { invocation: { status: "blocked" } } });
      expect(h.stores.invocations.get(s.invocation.id)).toMatchObject({ status: "blocked", workspaceCleanup: "released" });
      expect(h.executionWorkspace.released.map((r) => r.invocationId)).toEqual([s.invocation.id]);
      // A read-only Evaluator on a worker node: no worktree, no obligation, no release.
      const plan = accepted(propose(h, s, [{ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id }, allocation: { costUsd: 6, tokens: 60_000, attempts: 6 } }]));
      const node = plan.graph.nodes[1]!;
      h.stores.plans.transitionNode(node.id, { to: "ready" });
      h.stores.plans.transitionNode(node.id, { to: "running" });
      const evaluator = h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "evaluator", purpose: "evaluate", agentDefinitionRevisionId: s.worker.id, continuedFromInvocationId: null, taskIds: [], patternPosition: null });
      expect(evaluator.invocation.workspaceCleanup).toBe("none");
      expect(h.ctx.journal.read({ runId: s.created.run.id, type: "invocation.workspace_prepared" }).map((e) => (e.payload as { invocationId: string }).invocationId)).toEqual([s.invocation.id]);
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      expect(await advance(h, evaluator.invocation)).toMatchObject({ kind: "finalized", settlement: { invocation: { status: "succeeded", workspaceCleanup: "none" } } });
      expect(h.executor.releaseWorkspace(evaluator.invocation.id)).toBe("not_due");
      expect(h.executionWorkspace.released).toHaveLength(1);
      // Cancelled: released.
      const worker = h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", agentDefinitionRevisionId: s.worker.id, continuedFromInvocationId: null, taskIds: [], patternPosition: null });
      expect(worker.invocation.workspaceCleanup).toBe("pending");
      h.provider.script({ kind: "hang" });
      const prepared = await h.executor.prepareNextAttempt(worker.invocation.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const running = h.executor.executePreparedAttempt(prepared.attempt.id);
      h.executor.interrupt(prepared.attempt.id, "cancelled");
      expect(await running).toMatchObject({ settlement: { invocation: { status: "cancelled" } } });
      expect(h.stores.invocations.get(worker.invocation.id).workspaceCleanup).toBe("released");
      expect(h.executionWorkspace.released.map((r) => r.invocationId)).toEqual([s.invocation.id, worker.invocation.id]);
      // A non-terminal Invocation is never released, however it is asked.
      const pending = h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", agentDefinitionRevisionId: s.worker.id, continuedFromInvocationId: null, taskIds: [], patternPosition: null });
      expect(h.executor.releaseWorkspace(pending.invocation.id)).toBe("not_due");
      expect(h.recovery.recover().workspaceReleasedInvocationIds).toEqual([]);
      expect(() => h.stores.invocations.recordWorkspaceReleased(pending.invocation.id)).toThrow(/released only once it is terminal/);
    } finally {
      h.close();
    }
  });

  it("discards the worktree and leaves no obligation when preparation rolls back after the port prepared it", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const other = seedRuntime(h);
      const foreign = h.stores.artifacts.create({ runId: other.created.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: null }, new TextEncoder().encode("x"));
      const plan = accepted(propose(h, s, [{ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id }, allocation: { costUsd: 6, tokens: 60_000, attempts: 6 } }]));
      const node = plan.graph.nodes[1]!;
      h.stores.plans.transitionNode(node.id, { to: "ready" });
      h.stores.plans.transitionNode(node.id, { to: "running" });
      const seq = h.ctx.journal.lastSeq();
      expect(() => h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", agentDefinitionRevisionId: s.worker.id, continuedFromInvocationId: null, taskIds: [], patternPosition: null, artifactIds: [foreign.id] })).toThrow(/belongs to Run/);
      expect(h.executionWorkspace.discarded).toHaveLength(1);
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.stores.invocations.listPendingWorkspaceCleanup()).toEqual([]);
      expect(h.stores.invocations.listByPlanNode(node.id)).toEqual([]);
      expect((h.database.sqlite.prepare("SELECT count(*) AS n FROM invocations WHERE workspace_cleanup <> 'none'").get() as { n: number }).n).toBe(1);
    } finally {
      h.close();
    }
  });
});
