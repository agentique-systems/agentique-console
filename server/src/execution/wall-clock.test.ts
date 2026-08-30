/**
 * The one Invocation-wide wall-clock deadline (execution-model §7.6):
 * `Invocation.startedAt + maxWallClockMs`, shared by every Attempt, consumed
 * by retry backoff, derived identically after a restart, and settled once.
 */
import { invocationDeadlineAt, type Invocation } from "@agentique-console/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openHarness } from "../persistence/test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

/** A Run whose Orchestrator definition carries a short wall-clock limit. */
function seedShortLimit(h: RuntimeHarness, maxWallClockMs: number) {
  const definition = h.stores.agents.ensureDefinition("orchestrator");
  const revision = h.stores.agents.appendRevision(definition.id, {
    provenance: { kind: "builtin" },
    modelPolicy: { model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8 },
    instructions: "You are the orchestrator.",
    capabilities: { tools: ["read", "write", "shell"], mcpServers: [] },
    toolPolicy: { read: "allowed", write: "allowed", shell: "approval_required" },
    defaultLimits: { allocation: { costUsd: 2, tokens: 20_000, attempts: 3 }, maxWallClockMs },
  });
  const s = seedRuntime(h, { orchestratorAgentDefinitionRevisionId: revision.id });
  return { ...s, orchestrator: revision };
}

async function advanced(h: RuntimeHarness, invocation: Invocation) {
  const outcome = await h.executor.advanceInvocation(invocation.id);
  if (outcome.kind !== "finalized") throw new Error(`expected finalized, got ${outcome.kind}`);
  return outcome;
}

describe("Invocation-wide wall clock", () => {
  it("gives every Attempt the same absolute deadline, derived from the Invocation start and the manifest limit", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedShortLimit(h, 60_000);
      const { invocation, manifest } = startRun(h, s).prepared;
      expect(manifest.content.maxWallClockMs).toBe(60_000);
      expect(h.executor.inspectInvocation(invocation.id).deadlineAt).toBeNull();
      h.provider.script({ kind: "interrupted" }, { kind: "succeed", result: COMPLETED_RESULT });
      const first = await advanced(h, invocation);
      const started = h.stores.invocations.get(invocation.id).startedAt!;
      const deadline = invocationDeadlineAt(started, 60_000)!;
      expect(deadline).toBe(new Date(Date.parse(started) + 60_000).toISOString());
      expect(first.attempt).toMatchObject({ status: "interrupted", retryDecision: { permitted: true, reason: "interrupted" } });
      h.clock.advance(20_000);
      const second = await advanced(h, invocation);
      expect(second.attempt).toMatchObject({ number: 2, status: "succeeded" });
      // Both Attempts started at different times; both carried the same deadline, and the second started well after the first.
      expect(h.provider.requests.map((r) => r.request.deadlineAt)).toEqual([deadline, deadline]);
      expect(Date.parse(second.attempt.startedAt!) - Date.parse(first.attempt.startedAt!)).toBeGreaterThanOrEqual(20_000);
      expect(h.executor.inspectInvocation(invocation.id).deadlineAt).toBe(deadline);
    } finally {
      h.close();
    }
  });

  it("refuses a transient retry whose backoff would end at or after the deadline, settling the Invocation once", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedShortLimit(h, 5_000);
      const { invocation } = startRun(h, s).prepared;
      h.provider.script({ kind: "delay", key: "k", then: { kind: "transient_error" } });
      const running = h.executor.advanceInvocation(invocation.id);
      await Promise.resolve();
      const deadline = h.executor.inspectInvocation(invocation.id).deadlineAt!;
      // The backoff base is 1 s; finalize 500 ms before the deadline and the retry could never run.
      h.clock.set(new Date(Date.parse(deadline) - 500).toISOString());
      h.provider.release("k");
      const outcome = await running;
      expect(outcome).toMatchObject({ kind: "finalized", attempt: { status: "failed", failureClass: "provider_transient", retryDecision: { permitted: false, reason: "wall_clock_exhausted", notBefore: null } } });
      if (outcome.kind !== "finalized") throw new Error("unreachable");
      expect(outcome.settlement).toMatchObject({ kind: "settled", invocation: { status: "failed", failureReason: "allocation_exhausted" } });
      expect(h.stores.invocations.listAttempts(invocation.id)).toHaveLength(1);
      expect(h.stores.reservations.listByChild({ type: "invocation", id: invocation.id })[0]!.status).toBe("released");
      expect(h.governor.status().activeLeases).toEqual([]);
      expect((h.database.sqlite.prepare("SELECT retry_not_before FROM attempts").all() as { retry_not_before: string | null }[]).map((r) => r.retry_not_before)).toEqual([null]);
    } finally {
      h.close();
    }
  });

  it("creates no Attempt or lease once the deadline has passed, and settles expiry idempotently", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedShortLimit(h, 5_000);
      const { invocation } = startRun(h, s).prepared;
      h.provider.script({ kind: "interrupted" });
      const first = await advanced(h, invocation);
      expect(first.settlement.kind).toBe("retry_pending");
      const deadline = h.executor.inspectInvocation(invocation.id).deadlineAt!;
      h.clock.set(deadline);
      expect(h.executor.inspectInvocation(invocation.id).next).toEqual({ permitted: false, reason: "allocation_exhausted", notBefore: null });
      const seq = h.ctx.journal.lastSeq();
      const expired = await h.executor.advanceInvocation(invocation.id);
      expect(expired).toMatchObject({ kind: "not_permitted", reason: "allocation_exhausted", invocation: { status: "failed", failureReason: "allocation_exhausted" } });
      expect(h.stores.invocations.listAttempts(invocation.id)).toHaveLength(1);
      expect(h.stores.leases.listByRun(s.created.run.id).every((l) => l.status === "released")).toBe(true);
      expect(h.provider.requests).toHaveLength(1);
      const events = h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type);
      expect(events).toEqual(["invocation.failed", "budget_reservation.released"]);
      // Settling expiry again changes nothing.
      expect(await h.executor.advanceInvocation(invocation.id)).toMatchObject({ kind: "not_permitted", reason: "invocation_terminal" });
      expect(h.ctx.journal.lastSeq()).toBe(seq + 2);
      expect(h.executionWorkspace.released.map((r) => r.invocationId)).toEqual([invocation.id]);
    } finally {
      h.close();
    }
  });

  it("lets an interruption before the deadline retry with only the remaining time, and preserves the deadline and eligibility across reopen", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-wall-clock-"));
    const file = path.join(dir, "console.db");
    const first = openRuntimeHarness({ base: openHarness(file) });
    let invocationId!: Invocation["id"];
    let deadline!: string;
    let inspection: unknown;
    try {
      const s = seedShortLimit(first, 30_000);
      const { invocation } = startRun(first, s).prepared;
      invocationId = invocation.id;
      first.provider.script({ kind: "interrupted" });
      await advanced(first, invocation);
      deadline = first.executor.inspectInvocation(invocation.id).deadlineAt!;
      first.clock.advance(10_000);
      inspection = first.executor.inspectInvocation(invocation.id);
      expect(inspection).toMatchObject({ deadlineAt: deadline, next: { permitted: true } });
    } finally {
      first.close();
    }
    const reopened = openRuntimeHarness({ base: openHarness(file) });
    try {
      // The same deadline and eligibility from canonical rows alone; the retry runs with the remaining time, under the same deadline.
      expect(reopened.recovery.recover().interruptedAttemptIds).toEqual([]);
      const again = reopened.executor.inspectInvocation(invocationId);
      expect(again.deadlineAt).toBe(deadline);
      expect(again.next).toEqual({ permitted: true });
      reopened.clock.set(new Date(Date.parse(deadline) - 5_000).toISOString());
      reopened.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      const retry = await advanced(reopened, reopened.stores.invocations.get(invocationId));
      expect(retry.attempt).toMatchObject({ number: 2, kind: "retry", status: "succeeded" });
      expect(reopened.provider.requests[0]!.request.deadlineAt).toBe(deadline);
      expect(Date.parse(deadline) - Date.parse(retry.attempt.startedAt!)).toBeLessThan(5_000);
    } finally {
      reopened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovery derives the same deadline: an interrupted Attempt past the deadline fails the Invocation instead of leaving a retry", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-wall-clock-"));
    const file = path.join(dir, "console.db");
    const crashed = openRuntimeHarness({ base: openHarness(file) });
    let invocationId!: Invocation["id"];
    try {
      const s = seedShortLimit(crashed, 5_000);
      const { invocation } = startRun(crashed, s).prepared;
      invocationId = invocation.id;
      crashed.provider.script({ kind: "hang" });
      const prepared = await crashed.executor.prepareNextAttempt(invocation.id);
      expect(prepared.kind).toBe("prepared");
      crashed.clock.advance(6_000);
    } finally {
      crashed.close();
    }
    const reopened = openRuntimeHarness({ base: openHarness(file, { clock: undefined }) });
    try {
      reopened.clock.set("2026-01-01T00:00:10.000Z");
      const report = reopened.recovery.recover();
      expect(report.failedInvocationIds).toEqual([invocationId]);
      expect(report.retryEligible).toEqual([]);
      const attempt = reopened.stores.invocations.listAttempts(invocationId)[0]!;
      expect(attempt).toMatchObject({ status: "interrupted", retryDecision: { permitted: false, reason: "wall_clock_exhausted", notBefore: null } });
      expect(reopened.stores.invocations.get(invocationId)).toMatchObject({ status: "failed", failureReason: "allocation_exhausted" });
    } finally {
      reopened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
