/**
 * Restart recovery (execution-model §14 "Server restart"; invariants 6 no
 * transcript decides anything, 17 resumption optional, 18 leases
 * recomputed from canonical state).
 */
import { TRANSCRIPT_MEDIA_TYPE, type AttemptId, type CapacityLeaseId, type InvocationId, type RunId } from "@agentique-console/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openHarness, type TestClock } from "../persistence/test-support.ts";
import { MemoryContinuationPayloadStore } from "../provider/continuation-store.ts";
import { sha256Hex } from "../persistence/blob-store.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

interface Crashed {
  file: string;
  runId: RunId;
  invocationId: InvocationId;
  attemptId: AttemptId;
  leaseId: CapacityLeaseId;
  clock: TestClock;
  payloads: MemoryContinuationPayloadStore;
}

/** A process that prepared and started an Attempt, obtained a continuation payload for an earlier Attempt, and then died without finalizing. */
async function crashMidAttempt(dir: string, options: { status: "pending" | "running"; attempts?: number; withContinuation?: boolean } = { status: "running" }): Promise<Crashed> {
  const file = path.join(dir, `console-${Math.random().toString(16).slice(2)}.db`);
  const payloads = new MemoryContinuationPayloadStore(sha256Hex);
  const h = openRuntimeHarness({ base: openHarness(file), payloads });
  try {
    const s = seedRuntime(h);
    const { invocation } = startRun(h, s).prepared;
    if (options.withContinuation) {
      // An earlier Attempt ended result_invalid with a payload: the interrupted Attempt's retry may resume from it.
      h.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: ["art_000000000000000000000000"] }, continuation: "state" }, { kind: "hang" });
      await h.executor.advanceInvocation(invocation.id);
    } else {
      h.provider.script({ kind: "hang" });
    }
    const prepared = await h.executor.prepareNextAttempt(invocation.id);
    if (prepared.kind !== "prepared") throw new Error(prepared.kind);
    if (options.status === "pending") h.database.sqlite.prepare("UPDATE attempts SET status = 'pending', started_at = NULL, capacity_lease_id = NULL WHERE id = ?").run(prepared.attempt.id);
    return { file, runId: s.created.run.id, invocationId: invocation.id, attemptId: prepared.attempt.id, leaseId: prepared.lease.id, clock: h.clock, payloads };
  } finally {
    h.close();
  }
}

function reopen(crashed: Crashed, options: { supportsContinuation?: boolean } = {}): RuntimeHarness {
  return openRuntimeHarness({ base: openHarness(crashed.file, { clock: crashed.clock }), payloads: crashed.payloads, supportsContinuation: options.supportsContinuation ?? true });
}

describe("RecoveryService", () => {
  it("interrupts pending and running Attempts of the previous process, releases stale leases, keeps the consumed Attempt, and leaves durable retry eligibility", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-recovery-"));
    try {
      for (const status of ["running", "pending"] as const) {
        const crashed = await crashMidAttempt(dir, { status });
        const h = reopen(crashed);
        try {
          expect(h.stores.invocations.getAttempt(crashed.attemptId).status).toBe(status);
          expect(h.stores.leases.get(crashed.leaseId).status).toBe("active");
          const seq = h.ctx.journal.lastSeq();
          const report = h.recovery.recover();
          expect(report).toEqual({ interruptedAttemptIds: [crashed.attemptId], releasedLeaseIds: [crashed.leaseId], failedInvocationIds: [], retryEligible: [{ invocationId: crashed.invocationId, notBefore: null, resumeCandidateAttemptId: null }], workspaceReleasedInvocationIds: [], workspaceReleaseFailedInvocationIds: [] });
          // A retry-eligible Invocation keeps its worktree: nothing is released.
          expect(h.executionWorkspace.released).toEqual([]);
          const attempt = h.stores.invocations.getAttempt(crashed.attemptId);
          expect(attempt).toMatchObject({ status: "interrupted", failureClass: "interrupted", failureDetail: { message: "interrupted by a runtime restart", cancelled: false }, retryDecision: { permitted: true, reason: "interrupted", notBefore: null }, transcriptArtifactId: null });
          expect(h.stores.invocations.attemptsConsumed(crashed.invocationId)).toBe(1);
          expect(h.stores.invocations.get(crashed.invocationId).status).toBe("running");
          expect(h.stores.reservations.activeForChild({ type: "invocation", id: crashed.invocationId })).not.toBeNull();
          expect(h.governor.status().activeLeases).toEqual([]);
          expect(h.executor.inspectInvocation(crashed.invocationId).next).toEqual({ permitted: true });
          // Recovery executed nothing and read no transcript: the provider was never called and no transcript Artifact exists.
          expect(h.provider.requests).toHaveLength(0);
          expect(h.stores.artifacts.listByRun(crashed.runId).filter((a) => a.mediaType === TRANSCRIPT_MEDIA_TYPE)).toEqual([]);
          const events = h.ctx.journal.read({ runId: crashed.runId, afterSeq: seq }).map((e) => e.type);
          expect(events).toEqual(["attempt.interrupted", "capacity_lease.released"]);
          // Idempotent: a second recovery changes nothing.
          expect(h.recovery.recover()).toEqual({ interruptedAttemptIds: [], releasedLeaseIds: [], failedInvocationIds: [], retryEligible: [], workspaceReleasedInvocationIds: [], workspaceReleaseFailedInvocationIds: [] });
          expect(h.ctx.journal.lastSeq()).toBe(seq + 2);
          // The recovered work runs on an explicit call, as a fresh retry that consumes the second Attempt.
          h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
          const outcome = await h.executor.advanceInvocation(crashed.invocationId);
          expect(outcome).toMatchObject({ kind: "finalized", attempt: { number: 2, kind: "retry", startMode: "fresh", status: "succeeded" } });
        } finally {
          h.close();
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the Invocation with allocation_exhausted when the interrupted Attempt was its last, and selects a resumed retry only when the continuation checks pass", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-recovery-"));
    try {
      // The interrupted Attempt is the second and last; its Invocation fails and its reservation is released.
      const exhausted = await crashMidAttempt(dir, { status: "running", withContinuation: true });
      const e = reopen(exhausted);
      try {
        const report = e.recovery.recover();
        // The failed Invocation's worktree is released by the same recovery, after its settlement committed.
        expect(report).toEqual({ interruptedAttemptIds: [exhausted.attemptId], releasedLeaseIds: [exhausted.leaseId], failedInvocationIds: [exhausted.invocationId], retryEligible: [], workspaceReleasedInvocationIds: [exhausted.invocationId], workspaceReleaseFailedInvocationIds: [] });
        expect(e.stores.invocations.getAttempt(exhausted.attemptId).retryDecision).toEqual({ permitted: false, reason: "attempts_exhausted", notBefore: null });
        expect(e.stores.invocations.get(exhausted.invocationId)).toMatchObject({ status: "failed", failureReason: "allocation_exhausted", workspaceCleanup: "released" });
        expect(e.stores.reservations.listByChild({ type: "invocation", id: exhausted.invocationId })[0]).toMatchObject({ status: "released", consumed: { attempts: 2 } });
        expect(e.recovery.recover()).toEqual({ interruptedAttemptIds: [], releasedLeaseIds: [], failedInvocationIds: [], retryEligible: [], workspaceReleasedInvocationIds: [], workspaceReleaseFailedInvocationIds: [] });
      } finally {
        e.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-recovery-"));
    try {
      // With Attempts to spare, a payload from a safe prior Attempt of the same Invocation is a resume candidate; a missing payload falls back to fresh.
      const crashed = await (async () => {
        const file = path.join(dir2, "console.db");
        const payloads = new MemoryContinuationPayloadStore(sha256Hex);
        const h = openRuntimeHarness({ base: openHarness(file), payloads });
        try {
          const s = seedRuntime(h);
          const { invocation } = h.runStart.start({ runId: s.created.run.id, conversationMessageId: s.message.id }).prepared;
          expect(invocation.allocation.attempts).toBe(2);
          h.provider.script({ kind: "hang", continuation: "state" });
          const prepared = await h.executor.prepareNextAttempt(invocation.id);
          if (prepared.kind !== "prepared") throw new Error(prepared.kind);
          // The provider stored a payload for this very Attempt before the process died (a partial continuation), which is unsafe: the Attempt never ended.
          await h.continuations.store(prepared.attempt.id, "fake", new TextEncoder().encode("partial"));
          return { file, runId: s.created.run.id, invocationId: invocation.id, attemptId: prepared.attempt.id, leaseId: prepared.lease.id, clock: h.clock, payloads } satisfies Crashed;
        } finally {
          h.close();
        }
      })();
      const h = reopen(crashed);
      try {
        // After recovery the interrupted Attempt is a safe termination with an indexed payload: the retry may resume from it.
        const report = h.recovery.recover();
        expect(report.retryEligible).toEqual([{ invocationId: crashed.invocationId, notBefore: null, resumeCandidateAttemptId: crashed.attemptId }]);
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        const outcome = await h.executor.advanceInvocation(crashed.invocationId);
        expect(outcome).toMatchObject({ kind: "finalized", attempt: { number: 2, kind: "retry", startMode: "resumed", resumedFromAttemptId: crashed.attemptId, status: "succeeded" } });
        expect(new TextDecoder().decode(h.provider.requests[0]!.continuation!)).toBe("partial");
      } finally {
        h.close();
      }
      // The same database, recovered by a process whose payload store was truncated: identical decision, fresh start, same outcome.
      const truncated = await crashMidAttempt(dir2, { status: "running" });
      await truncated.payloads.truncate();
      const t = reopen(truncated, { supportsContinuation: false });
      try {
        expect(t.recovery.recover().retryEligible).toEqual([{ invocationId: truncated.invocationId, notBefore: null, resumeCandidateAttemptId: null }]);
        t.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        expect(await t.executor.advanceInvocation(truncated.invocationId)).toMatchObject({ kind: "finalized", attempt: { startMode: "fresh", status: "succeeded" }, settlement: { invocation: { status: "succeeded" } } });
      } finally {
        t.close();
      }
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("produces the identical retry decision after close and reopen, from canonical rows alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-recovery-"));
    try {
      const crashed = await crashMidAttempt(dir, { status: "running" });
      const first = reopen(crashed);
      let decision: unknown;
      try {
        first.recovery.recover();
        decision = { attempt: first.stores.invocations.getAttempt(crashed.attemptId), inspection: first.executor.inspectInvocation(crashed.invocationId) };
      } finally {
        first.close();
      }
      const second = reopen(crashed);
      try {
        expect(second.recovery.recover()).toEqual({ interruptedAttemptIds: [], releasedLeaseIds: [], failedInvocationIds: [], retryEligible: [], workspaceReleasedInvocationIds: [], workspaceReleaseFailedInvocationIds: [] });
        expect({ attempt: second.stores.invocations.getAttempt(crashed.attemptId), inspection: second.executor.inspectInvocation(crashed.invocationId) }).toEqual(decision);
      } finally {
        second.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
