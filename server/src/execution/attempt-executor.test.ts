/**
 * Durable Attempt execution (execution-model §6.5, §7.2, §7.6, §7.8, §12,
 * §13, §14; invariants 5 runtime-owned retries, 6 diagnostic transcripts,
 * 10 complete Usage, 18 deterministic backpressure, 20 Attempts are only
 * initial or retry).
 */
import { ConflictError, TRANSCRIPT_MEDIA_TYPE, type Invocation } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_USAGE } from "../provider/fake.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedRuntime, startRun, TEST_GOVERNOR, type RuntimeHarness } from "./test-support.ts";

function eventsSince(h: RuntimeHarness, runId: string, seq: number): string[] {
  return h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => e.type);
}

async function finalized(h: RuntimeHarness, invocation: Invocation) {
  const outcome = await h.executor.advanceInvocation(invocation.id);
  if (outcome.kind !== "finalized" && outcome.kind !== "approval_required") throw new Error(`expected an execution outcome, got ${outcome.kind}`);
  return outcome;
}

describe("AttemptExecutor", () => {
  it("executes a fresh initial Attempt to success: lease, provider outside any transaction, Usage before the terminal Invocation, transcript, Changeset, Events in order", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const { prepared } = startRun(h, s);
      const invocation = prepared.invocation;
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT, usage: [DEFAULT_USAGE, { ...DEFAULT_USAGE, outputTokens: 20, costUsd: 0.02 }], transcript: "the model said things", output: ["thinking…"] });
      const seq = h.ctx.journal.lastSeq();
      const outcome = await finalized(h, invocation);
      expect(outcome.kind).toBe("finalized");
      const attempt = outcome.attempt;
      expect(attempt).toMatchObject({ number: 1, kind: "initial", startMode: "fresh", resumedFromAttemptId: null, status: "succeeded", failureClass: null, failureDetail: null, retryDecision: null, result: COMPLETED_RESULT });
      expect(outcome.settlement).toMatchObject({ kind: "settled", invocation: { id: invocation.id, status: "succeeded", result: COMPLETED_RESULT } });
      // The provider was called once, outside any transaction, with the rendered manifest and the effective policies.
      expect(h.provider.requests).toHaveLength(1);
      const request = h.provider.requests[0]!;
      expect(request.inTransaction).toBe(false);
      expect(request.continuation).toBeNull();
      expect(request.request).toMatchObject({ attemptId: attempt.id, invocationId: invocation.id, runId: s.created.run.id, model: "claude-fable-5", effort: "medium", workingDirectory: prepared.manifest.content.worktreePath, capabilities: prepared.manifest.content.capabilities, toolPolicy: prepared.manifest.content.toolPolicy });
      expect(request.request.deadlineAt).toBe(new Date(Date.parse(attempt.startedAt!) + 600_000).toISOString());
      expect(request.request.input.text).toContain(`manifest: ${prepared.manifest.id}`);
      expect(request.request.input.text).not.toContain("## Retry");
      expect(h.transient).toEqual([{ attemptId: attempt.id, kind: "text", text: "thinking…" }]);
      // Usage: one row per chunk, attributed to Attempt, Invocation, node, Run, recorded before the Invocation ended.
      const usage = h.stores.usage.listByAttempt(attempt.id);
      expect(usage).toHaveLength(2);
      expect(usage[0]).toMatchObject({ invocationId: invocation.id, planNodeId: s.created.root.id, runId: s.created.run.id, model: "fake-model", effort: "medium" });
      expect(h.stores.usage.totalsForRun(s.created.run.id)).toMatchObject({ rows: 2, costUsd: 0.03, outputTokens: 70 });
      const reservation = h.stores.reservations.listByChild({ type: "invocation", id: invocation.id })[0]!;
      expect(reservation).toMatchObject({ status: "released", consumed: { costUsd: 0.03, tokens: 270, attempts: 1 } });
      // The transcript is a diagnostic Artifact of the Run; the lease is released; the Changeset is recorded.
      const transcript = h.stores.artifacts.get(attempt.transcriptArtifactId!);
      expect(transcript).toMatchObject({ mediaType: TRANSCRIPT_MEDIA_TYPE, producer: { kind: "runtime", component: "transcript" }, runId: s.created.run.id });
      expect(h.stores.leases.get(attempt.capacityLeaseId!).status).toBe("released");
      expect(h.governor.status().activeLeases).toEqual([]);
      const changeset = h.stores.changesets.listByRun(s.created.run.id)[0]!;
      expect(changeset).toMatchObject({ invocationId: invocation.id, beforeSnapshotId: prepared.manifest.content.startingSnapshotId, integrationStatus: "pending" });
      expect(h.stores.artifacts.get(changeset.diffArtifactId).title).toBe(`empty changeset of ${invocation.id}`);
      expect(h.executionWorkspace.collected).toHaveLength(1);
      expect(h.executionWorkspace.released.map((r) => r.invocationId)).toEqual([invocation.id]);
      // Exactly one Event per canonical change, in the finalization order; no Event carries the prompt, transcript, or payload.
      expect(eventsSince(h, s.created.run.id, seq)).toEqual([
        "attempt.created",
        "capacity_lease.granted",
        "attempt.started",
        "invocation.started",
        "artifact.created",
        "usage.recorded",
        "usage.recorded",
        "snapshot.taken",
        "artifact.created",
        "changeset.recorded",
        "attempt.succeeded",
        "capacity_lease.released",
        "invocation.succeeded",
        "budget_reservation.released",
      ]);
      const journal = JSON.stringify(h.ctx.journal.read({ runId: s.created.run.id }));
      expect(journal).not.toContain("the model said things");
      expect(journal).not.toContain("# Context Manifest");
      // Root and Run stay running; repeated advancement creates nothing.
      expect(h.stores.plans.getNode(s.created.root.id).status).toBe("running");
      expect(h.stores.runs.get(s.created.run.id).status).toBe("running");
      const again = await h.executor.advanceInvocation(invocation.id);
      expect(again).toMatchObject({ kind: "not_permitted", reason: "invocation_terminal" });
      expect(h.stores.invocations.listAttempts(invocation.id)).toHaveLength(1);
      expect(h.ctx.journal.lastSeq()).toBe(seq + 14);
      expect((await h.executor.executePreparedAttempt(attempt.id)).kind).toBe("finalized");
      expect(h.ctx.journal.lastSeq()).toBe(seq + 14);
    } finally {
      h.close();
    }
  });

  it("retries a transient failure after deterministic backoff and an invalid result at once with the exact violations, without ever re-running the manifest", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const { invocation, manifest } = startRun(h, s).prepared;
      expect(invocation.allocation.attempts).toBe(2);
      h.provider.script({ kind: "transient_error", message: "overloaded" }, { kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: ["art_000000000000000000000000"] } });
      const first = await finalized(h, invocation);
      expect(first.attempt).toMatchObject({ status: "failed", failureClass: "provider_transient", failureDetail: { message: "overloaded", violations: [], tool: null, cancelled: false }, retryDecision: { permitted: true, reason: "provider_transient" } });
      const notBefore = first.attempt.retryDecision!.notBefore!;
      // Backoff is the configured base (1 s) from the decision, with no randomness (the decision precedes the terminal transition by a clock tick).
      expect(Date.parse(notBefore) - Date.parse(first.attempt.endedAt!)).toBeGreaterThanOrEqual(990);
      expect(Date.parse(notBefore) - Date.parse(first.attempt.endedAt!)).toBeLessThanOrEqual(1_000);
      expect(first.settlement.kind).toBe("retry_pending");
      expect(h.stores.invocations.get(invocation.id).status).toBe("running");
      expect(h.stores.reservations.activeForChild({ type: "invocation", id: invocation.id })).not.toBeNull();
      // Durable eligibility: not yet, until the persisted notBefore passes; nothing is recomputed from configuration.
      const inspection = h.executor.inspectInvocation(invocation.id);
      expect(inspection.next).toEqual({ permitted: false, reason: "retry_not_yet", notBefore });
      expect(inspection.previousFailure).toMatchObject({ attemptId: first.attempt.id, failureClass: "provider_transient" });
      expect(await h.executor.advanceInvocation(invocation.id)).toMatchObject({ kind: "not_permitted", reason: "retry_not_yet" });
      expect(h.stores.invocations.listAttempts(invocation.id)).toHaveLength(1);
      expect((h.database.sqlite.prepare("SELECT retry_not_before FROM attempts WHERE id = ?").get(first.attempt.id) as { retry_not_before: string }).retry_not_before).toBe(notBefore);
      h.clock.set(notBefore);
      const second = await finalized(h, invocation);
      expect(second.attempt).toMatchObject({ number: 2, kind: "retry", startMode: "fresh", status: "failed", failureClass: "result_invalid" });
      expect(second.attempt.failureDetail?.violations).toEqual([{ code: "unknown_artifact", message: "Artifact art_000000000000000000000000 does not exist", path: "artifactIds.0" }]);
      // No Attempt remains: the Invocation fails as an invalid result, its reservation released with two Attempts consumed.
      expect(second.attempt.retryDecision).toEqual({ permitted: false, reason: "attempts_exhausted", notBefore: null });
      expect(second.settlement).toMatchObject({ kind: "settled", invocation: { status: "failed", failureReason: "result_invalid" } });
      expect(h.stores.reservations.listByChild({ type: "invocation", id: invocation.id })[0]).toMatchObject({ status: "released", consumed: { attempts: 2 } });
      // Both Attempts rendered the same immutable manifest; the retry added only the bounded appendix.
      const [a, b] = h.provider.requests.map((r) => r.request.input.text);
      expect(b!.startsWith(a!)).toBe(true);
      expect(b!.slice(a!.length)).toContain("failure_class: provider_transient");
      expect(b!.slice(a!.length)).toContain("detail: overloaded");
      expect(b!.slice(a!.length)).not.toContain("transcript");
      expect(h.stores.invocations.getManifest(invocation.id)).toEqual(manifest);
      expect(await h.executor.advanceInvocation(invocation.id)).toMatchObject({ kind: "not_permitted", reason: "invocation_terminal" });
    } finally {
      h.close();
    }
  });

  it("does not retry a permanent failure, retries a tool failure exactly once, and marks cancellation as final", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const invocation = startRun(h, s).prepared.invocation;
      h.provider.script({ kind: "permanent_error", message: "model retired" });
      const outcome = await finalized(h, invocation);
      expect(outcome.attempt).toMatchObject({ status: "failed", failureClass: "provider_permanent", retryDecision: { permitted: false, reason: "provider_permanent", notBefore: null } });
      expect(outcome.settlement).toMatchObject({ kind: "settled", invocation: { status: "failed", failureReason: "provider_permanent" } });
      expect(h.stores.invocations.listAttempts(invocation.id)).toHaveLength(1);
      expect(h.governor.status().activeLeases).toEqual([]);
    } finally {
      h.close();
    }
    const t = openRuntimeHarness();
    try {
      const s = seedRuntime(t);
      const invocation = t.runStart.start({ runId: s.created.run.id, conversationMessageId: s.message.id }).prepared.invocation;
      t.provider.script({ kind: "tool_failure", tool: "shell", message: "exit 137" }, { kind: "tool_failure", tool: "shell", message: "exit 137 again" });
      const first = await finalized(t, invocation);
      expect(first.attempt).toMatchObject({ failureClass: "tool_failure", failureDetail: { tool: "shell", message: "exit 137" }, retryDecision: { permitted: true, reason: "tool_failure", notBefore: null } });
      const second = await finalized(t, invocation);
      expect(second.attempt).toMatchObject({ number: 2, failureClass: "tool_failure", retryDecision: { permitted: false, reason: "tool_failure_retried", notBefore: null } });
      expect(second.settlement).toMatchObject({ kind: "settled", invocation: { status: "failed", failureReason: "attempts_exhausted" } });
    } finally {
      t.close();
    }
    const c = openRuntimeHarness();
    try {
      const s = seedRuntime(c);
      const invocation = c.runStart.start({ runId: s.created.run.id, conversationMessageId: s.message.id }).prepared.invocation;
      c.provider.script({ kind: "hang" });
      const prepared = await c.executor.prepareNextAttempt(invocation.id);
      expect(prepared.kind).toBe("prepared");
      if (prepared.kind !== "prepared") throw new Error("unreachable");
      const executing = c.executor.executePreparedAttempt(prepared.attempt.id);
      expect(await c.executor.advanceInvocation(invocation.id)).toMatchObject({ kind: "in_flight", attemptId: prepared.attempt.id });
      expect(c.executor.interrupt(prepared.attempt.id, "cancelled")).toBe(true);
      expect(c.executor.interrupt(prepared.attempt.id, "cancelled")).toBe(false);
      const outcome = await executing;
      expect(outcome.attempt).toMatchObject({ status: "cancelled", failureClass: null, failureDetail: { cancelled: true }, retryDecision: { permitted: false, reason: "cancelled", notBefore: null } });
      expect(outcome.settlement).toMatchObject({ kind: "settled", invocation: { status: "cancelled" } });
      expect(c.provider.requests[0]).toMatchObject({ aborted: true, abortCause: "cancelled" });
      expect(c.stores.leases.get(prepared.attempt.capacityLeaseId!).status).toBe("released");
      expect(c.stores.reservations.listByChild({ type: "invocation", id: invocation.id })[0]!.status).toBe("released");
      expect(c.executor.inFlight()).toEqual([]);
    } finally {
      c.close();
    }
  });

  it("interrupts at the wall-clock deadline and retries, and fails with allocation_exhausted when cost or tokens run out", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const invocation = startRun(h, s).prepared.invocation;
      h.provider.script({ kind: "hang" }, { kind: "succeed", result: COMPLETED_RESULT });
      const prepared = await h.executor.prepareNextAttempt(invocation.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const executing = h.executor.executePreparedAttempt(prepared.attempt.id);
      const deadline = new Date(Date.parse(prepared.attempt.startedAt!) + 600_000).toISOString();
      expect(h.provider.requests[0]!.request.deadlineAt).toBe(deadline);
      expect(h.executor.enforceDeadlines(new Date(Date.parse(deadline) - 1).toISOString())).toEqual([]);
      h.clock.set(deadline);
      expect(h.executor.enforceDeadlines()).toEqual([prepared.attempt.id]);
      const outcome = await executing;
      expect(outcome.attempt).toMatchObject({ status: "timed_out", failureClass: "interrupted", retryDecision: { permitted: true, reason: "interrupted", notBefore: null } });
      expect(outcome.settlement.kind).toBe("retry_pending");
      expect(h.provider.requests[0]).toMatchObject({ aborted: true, abortCause: "deadline" });
      // The timed-out Attempt consumed its Attempt; the retry is bounded by the same wall-clock limit from its own start.
      const retry = await finalized(h, invocation);
      expect(retry.attempt).toMatchObject({ number: 2, kind: "retry", status: "succeeded" });
      expect(h.provider.requests[1]!.request.deadlineAt).toBe(new Date(Date.parse(retry.attempt.startedAt!) + 600_000).toISOString());
    } finally {
      h.close();
    }
    const e = openRuntimeHarness();
    try {
      const s = seedRuntime(e);
      const invocation = e.runStart.start({ runId: s.created.run.id, conversationMessageId: s.message.id }).prepared.invocation;
      expect(invocation.allocation).toEqual({ costUsd: 2, tokens: 20_000, attempts: 2 });
      // A transient failure whose Usage overran the cost allocation is allocation exhaustion: no retry, Invocation failed, Usage kept in full.
      e.provider.script({ kind: "transient_error", usage: [{ ...DEFAULT_USAGE, costUsd: 2.5 }] });
      const outcome = await finalized(e, invocation);
      expect(outcome.attempt).toMatchObject({ failureClass: "allocation_exhausted", retryDecision: { permitted: false, reason: "allocation_exhausted", notBefore: null } });
      expect(outcome.settlement).toMatchObject({ kind: "settled", invocation: { status: "failed", failureReason: "allocation_exhausted" } });
      expect(e.stores.reservations.listByChild({ type: "invocation", id: invocation.id })[0]).toMatchObject({ status: "released", consumed: { costUsd: 2.5, attempts: 1 } });
      expect(e.stores.reservations.capacity({ type: "plan_node", id: s.created.root.id }).consumed.costUsd).toBe(2.5);
    } finally {
      e.close();
    }
  });

  it("returns a typed approval_required outcome, leaving the Invocation waiting for the Decision phase without inventing an approval", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const invocation = startRun(h, s).prepared.invocation;
      h.provider.script({ kind: "approval_required", tool: "shell", call: "rm -rf dist" });
      const outcome = await finalized(h, invocation);
      expect(outcome).toMatchObject({ kind: "approval_required", tool: "shell", call: "rm -rf dist" });
      expect(outcome.attempt).toMatchObject({ status: "failed", failureClass: "tool_failure", failureDetail: { tool: "shell" }, retryDecision: { permitted: false, reason: "approval_required", notBefore: null } });
      expect(outcome.settlement.invocation).toMatchObject({ status: "waiting", waitReason: "decision" });
      expect(h.stores.reservations.activeForChild({ type: "invocation", id: invocation.id })).not.toBeNull();
      expect(h.governor.status().activeLeases).toEqual([]);
      expect(h.executor.inspectInvocation(invocation.id).next).toEqual({ permitted: false, reason: "invocation_waiting", notBefore: null });
      expect(await h.executor.advanceInvocation(invocation.id)).toMatchObject({ kind: "not_permitted", reason: "invocation_waiting" });
      expect(h.provider.requests).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("refuses to create an Attempt when the governor has no capacity, consuming nothing; and classifies an adapter that throws as transient", async () => {
    const h = openRuntimeHarness({ governor: { ...TEST_GOVERNOR, providers: { fake: { maxConcurrency: 1 } } } });
    try {
      const s = seedRuntime(h);
      const invocation = startRun(h, s).prepared.invocation;
      const other = seedRuntime(h);
      const second = h.runStart.start({ runId: other.created.run.id, conversationMessageId: other.message.id }).prepared.invocation;
      h.provider.script({ kind: "hang" }, { kind: "throw", error: new Error("ECONNRESET\n    at TLSSocket") });
      const first = await h.executor.prepareNextAttempt(invocation.id);
      expect(first.kind).toBe("prepared");
      const seq = h.ctx.journal.lastSeq();
      const refused = await h.executor.prepareNextAttempt(second.id);
      expect(refused).toMatchObject({ kind: "capacity_refused", refusal: { reason: "provider_concurrency", retryAfter: null } });
      expect(h.stores.invocations.listAttempts(second.id)).toEqual([]);
      expect(h.stores.invocations.get(second.id).status).toBe("pending");
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      if (first.kind !== "prepared") throw new Error("unreachable");
      const running = h.executor.executePreparedAttempt(first.attempt.id);
      h.executor.interrupt(first.attempt.id, "cancelled");
      await running;
      // Capacity is free again; the adapter throwing is a transient provider error with a bounded, single-line message.
      const outcome = await finalized(h, second);
      expect(outcome.attempt).toMatchObject({ status: "failed", failureClass: "provider_transient", failureDetail: { message: "ECONNRESET" } });
      expect(outcome.attempt.failureDetail?.message).not.toContain("at TLSSocket");
      expect(outcome.settlement.kind).toBe("retry_pending");
      expect(h.stores.usage.listByAttempt(outcome.attempt.id)).toEqual([]);
      expect(h.stores.leases.get(outcome.attempt.capacityLeaseId!).status).toBe("released");
    } finally {
      h.close();
    }
  });

  it("recovers a failed finalization on the next call without repeating the provider call, Usage, or Events", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const invocation = startRun(h, s).prepared.invocation;
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT, transcript: "t" });
      const prepared = await h.executor.prepareNextAttempt(invocation.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const seq = h.ctx.journal.lastSeq();
      // The first finalization fails while storing the transcript Artifact; the transaction rolls back completely.
      const put = h.blobs.put.bind(h.blobs);
      let failures = 0;
      h.blobs.put = (bytes) => {
        failures += 1;
        h.blobs.put = put;
        throw new Error("disk full");
      };
      await expect(h.executor.executePreparedAttempt(prepared.attempt.id)).rejects.toThrow("disk full");
      expect(failures).toBe(1);
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.stores.invocations.getAttempt(prepared.attempt.id).status).toBe("running");
      expect(h.stores.leases.get(prepared.attempt.capacityLeaseId!).status).toBe("active");
      expect(h.executor.inFlight()).toEqual([prepared.attempt.id]);
      // The retried finalization uses the outcome already obtained: one provider call, one set of rows.
      const outcome = await h.executor.advanceInvocation(invocation.id);
      expect(outcome).toMatchObject({ kind: "finalized", attempt: { status: "succeeded" } });
      expect(h.provider.requests).toHaveLength(1);
      expect(h.stores.usage.listByAttempt(prepared.attempt.id)).toHaveLength(1);
      expect(h.stores.artifacts.listByRun(s.created.run.id).filter((a) => a.mediaType === TRANSCRIPT_MEDIA_TYPE)).toHaveLength(1);
      expect(h.stores.leases.get(prepared.attempt.capacityLeaseId!).status).toBe("released");
      expect(h.executor.inFlight()).toEqual([]);
      expect(() => h.executor.executePreparedAttempt("att_000000000000000000000000")).toThrow(/not found/);
    } finally {
      h.close();
    }
    // An Attempt left running by a previous process cannot be executed by this one; recovery handles it.
    const p = openRuntimeHarness();
    try {
      const s = seedRuntime(p);
      const invocation = startRun(p, s).prepared.invocation;
      const attempt = p.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
      p.stores.invocations.transitionAttempt(attempt.id, { to: "running", capacityLeaseId: null });
      expect(() => p.executor.executePreparedAttempt(attempt.id)).toThrow(ConflictError);
    } finally {
      p.close();
    }
  });
});
