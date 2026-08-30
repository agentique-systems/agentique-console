import { AllocationExhaustedError, ConflictError, IllegalTransitionError, InvariantViolationError, MANIFEST_RENDERER_VERSION, ValidationError, type InvocationResult } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../blob-store.ts";
import { MemoryContinuationPayloadStore } from "../../provider/continuation-store.ts";
import { ContinuationService } from "../../provider/continuation.ts";
import { INVOCATION_ALLOCATION, extendPlan, joinDefinition, nodeInput, openHarness, seedArtifact, seedInvocation, seedManifest, seedRun, seedWorkerNode } from "../test-support.ts";

const result: InvocationResult = { status: "completed", artifactIds: [], tasks: [], evidence: [], summary: "done", openItems: [], blocker: null, runOutcome: null };

describe("invocations", () => {
  it("creates an Invocation with a closed purpose, reserving its allocation from the node", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const invocation = seedInvocation(h, s);
      expect(invocation.status).toBe("pending");
      const reservation = h.stores.reservations.activeForChild({ type: "invocation", id: invocation.id });
      expect(reservation?.parent).toEqual({ type: "plan_node", id: s.root.id });
      expect(reservation?.reserved).toEqual(INVOCATION_ALLOCATION);
      expect(() => seedInvocation(h, s, { purpose: "turn" as never })).toThrow(ValidationError);
      expect(() => seedInvocation(h, s, { role: "worker", purpose: "decompose" })).toThrow(ValidationError);
      expect(() => h.database.sqlite.prepare("UPDATE invocations SET purpose = 'turn' WHERE id = ?").run(invocation.id)).toThrow(/immutable/);
    } finally {
      h.close();
    }
  });

  it("a join node cannot create an Invocation and a node of another Run is refused", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const j = nodeInput(h, joinDefinition());
      extendPlan(h, s, [j]);
      expect(() => seedInvocation(h, s, { planNodeId: j.id, role: "worker", purpose: "step" })).toThrow(/join node .* creates no Invocation/);
      const other = seedRun(h);
      expect(() => seedInvocation(h, s, { planNodeId: other.root.id })).toThrow(InvariantViolationError);
      expect(h.stores.invocations.listByPlanNode(j.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("records continuedFromInvocationId within the Run and keeps one active Orchestrator Invocation per Run", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const first = seedInvocation(h, s);
      // Invariant 20: a second Orchestrator Invocation cannot be created while the first is active (pending, running, or waiting).
      expect(() => seedInvocation(h, s, { purpose: "node_result", continuedFromInvocationId: first.id })).toThrow(ConflictError);
      seedManifest(h, s, first);
      h.stores.invocations.transition(first.id, { to: "running" });
      h.stores.invocations.transition(first.id, { to: "waiting", waitReason: "decision" });
      expect(() => seedInvocation(h, s, { purpose: "node_result", continuedFromInvocationId: first.id })).toThrow(ConflictError);
      expect(() => h.database.sqlite.prepare("UPDATE invocations SET status = 'pending', wait_reason = NULL WHERE id = ?").run(first.id)).not.toThrow();
      h.stores.invocations.transition(first.id, { to: "cancelled" });
      const second = seedInvocation(h, s, { purpose: "node_result", continuedFromInvocationId: first.id });
      expect(second.continuedFromInvocationId).toBe(first.id);
      expect(h.stores.invocations.listActive(s.run.id, "orchestrator").map((i) => i.id)).toEqual([second.id]);
      expect(h.stores.invocations.latestByRole(s.root.id, "orchestrator")?.id).toBe(second.id);
      // The database refuses the duplicate even when the store check is bypassed.
      expect(() => h.database.sqlite.prepare("UPDATE invocations SET status = 'pending', wait_reason = NULL, failure_reason = NULL, ended_at = NULL WHERE id = ?").run(first.id)).toThrow(/UNIQUE constraint failed: invocations.run_id/);
      const other = seedRun(h);
      expect(() => seedInvocation(h, s, { continuedFromInvocationId: other.root.id })).toThrow(ValidationError);
      expect(() => seedInvocation(h, s, { continuedFromInvocationId: "inv_000000000000000000000000" })).toThrow(/not found/);
      const foreign = seedInvocation(h, other);
      expect(() => seedInvocation(h, s, { continuedFromInvocationId: foreign.id })).toThrow(InvariantViolationError);
    } finally {
      h.close();
    }
  });

  it("transitions and releases the reservation with consumed amounts when terminal", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const invocation = seedInvocation(h, s);
      seedManifest(h, s, invocation);
      h.stores.invocations.transition(invocation.id, { to: "running" });
      const attempt = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
      h.stores.invocations.transitionAttempt(attempt.id, { to: "running", capacityLeaseId: null });
      h.stores.usage.record({ attemptId: attempt.id, model: "m", effort: null, inputTokensUncached: 100, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 50, costUsd: 0.5, wallClockMs: 10, providerMs: null });
      h.stores.invocations.transitionAttempt(attempt.id, { to: "succeeded", result, transcriptArtifactId: null });
      h.stores.invocations.transition(invocation.id, { to: "waiting", waitReason: "decision" });
      h.stores.invocations.transition(invocation.id, { to: "running" });
      const done = h.stores.invocations.transition(invocation.id, { to: "succeeded", result });
      expect(done.endedAt).not.toBeNull();
      const reservation = h.stores.reservations.listByChild({ type: "invocation", id: invocation.id })[0]!;
      expect(reservation.status).toBe("released");
      expect(reservation.consumed).toEqual({ costUsd: 0.5, tokens: 150, attempts: 1 });
      expect(() => h.stores.invocations.transition(invocation.id, { to: "running" })).toThrow(IllegalTransitionError);
      expect(() => h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null })).toThrow(ConflictError);
    } finally {
      h.close();
    }
  });
});

describe("context manifests", () => {
  it("exactly one immutable manifest per Invocation, consistent with the Invocation", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const invocation = seedInvocation(h, s);
      expect(() => h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null })).toThrow(/no Context Manifest/);
      const manifest = seedManifest(h, s, invocation);
      expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(h.stores.invocations.getManifest(invocation.id)).toEqual(manifest);
      expect(() => seedManifest(h, s, invocation)).toThrow(ConflictError);
      expect(() => h.database.sqlite.prepare("UPDATE context_manifests SET digest = 'x' WHERE id = ?").run(manifest.id)).toThrow(/immutable/);
      expect(manifest.rendererVersion).toBe(MANIFEST_RENDERER_VERSION);
      h.stores.invocations.transition(invocation.id, { to: "cancelled" });
      const second = seedInvocation(h, s, { purpose: "node_result", continuedFromInvocationId: invocation.id });
      expect(() => h.stores.invocations.putManifest(second.id, { ...manifest.content, continuedFromInvocationId: null })).toThrow(InvariantViolationError);
      expect(() => h.stores.invocations.putManifest(second.id, { ...manifest.content, purpose: "node_result", continuedFromInvocationId: invocation.id, providerContinuation: "x" } as never)).toThrow(ValidationError);
      expect(() => h.stores.invocations.putManifest(second.id, { ...manifest.content, purpose: "node_result", continuedFromInvocationId: invocation.id, allocation: { ...manifest.content.allocation, attempts: 9 } })).toThrow(/allocation or funding/);
      expect(() => h.stores.invocations.putManifest(second.id, { ...manifest.content, purpose: "node_result", continuedFromInvocationId: invocation.id, tasks: [{ taskId: "task_000000000000000000000000", subject: "x" }] })).toThrow(/exactly the Invocation's Tasks/);
      expect(() => h.stores.invocations.putManifest(second.id, { ...manifest.content, purpose: "node_result", continuedFromInvocationId: invocation.id }, 0)).toThrow(ValidationError);
      expect(() =>
        h.database.sqlite
          .prepare("INSERT INTO context_manifests (id, invocation_id, run_id, content, digest, renderer_version, created_at) VALUES (?, ?, ?, '{}', ?, 0, ?)")
          .run(`cm_${"0".repeat(24)}`, second.id, s.run.id, "a".repeat(64), "2026-01-01T00:00:00.000Z"),
      ).toThrow(/CHECK constraint failed: context_manifests_renderer_version/);
      expect(h.stores.invocations.putManifest(second.id, { ...manifest.content, purpose: "node_result", continuedFromInvocationId: invocation.id }, 1).rendererVersion).toBe(1);
    } finally {
      h.close();
    }
  });
});

describe("attempts", () => {
  it("numbers initial then retry, refuses a removed turn kind, and consumes one allocation per Attempt", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const invocation = seedInvocation(h, s, { allocation: { costUsd: 5, tokens: 1000, attempts: 2 } });
      seedManifest(h, s, invocation);
      const first = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
      expect([first.number, first.kind]).toEqual([1, "initial"]);
      expect(() => h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null })).toThrow(/active Attempt/);
      h.stores.invocations.transitionAttempt(first.id, { to: "running", capacityLeaseId: null });
      // A restart interrupts the running Attempt: terminal, classified, and its allocation stays consumed.
      const interrupted = h.stores.invocations.transitionAttempt(first.id, { to: "interrupted", transcriptArtifactId: null });
      expect(interrupted.failureClass).toBe("interrupted");
      expect(interrupted.endedAt).not.toBeNull();
      expect(h.stores.invocations.attemptsConsumed(invocation.id)).toBe(1);
      expect(() => h.stores.invocations.transitionAttempt(first.id, { to: "running", capacityLeaseId: null })).toThrow(IllegalTransitionError);
      const retry = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "resumed", resumedFromAttemptId: first.id });
      expect([retry.number, retry.kind, retry.startMode]).toEqual([2, "retry", "resumed"]);
      expect(h.stores.invocations.attemptsConsumed(invocation.id)).toBe(2);
      h.stores.invocations.transitionAttempt(retry.id, { to: "running", capacityLeaseId: null });
      h.stores.invocations.transitionAttempt(retry.id, { to: "failed", failureClass: "provider_transient", transcriptArtifactId: null });
      // No allocation remains: recovery does not grant a free third Attempt.
      expect(() => h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null })).toThrow(AllocationExhaustedError);
      expect(h.stores.invocations.listAttempts(invocation.id).map((a) => a.status)).toEqual(["interrupted", "failed"]);
      expect(() => h.database.sqlite.prepare("UPDATE attempts SET kind = 'turn' WHERE id = ?").run(first.id)).toThrow(/immutable/);
    } finally {
      h.close();
    }
  });

  it("resumes only from an Attempt of the same Invocation or of the continuedFrom Invocation", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const first = seedInvocation(h, s);
      seedManifest(h, s, first);
      const a1 = h.stores.invocations.createAttempt({ invocationId: first.id, startMode: "fresh", resumedFromAttemptId: null });
      h.stores.invocations.transitionAttempt(a1.id, { to: "running", capacityLeaseId: null });
      h.stores.invocations.transitionAttempt(a1.id, { to: "succeeded", result, transcriptArtifactId: null });
      h.stores.invocations.transition(first.id, { to: "running" });
      h.stores.invocations.transition(first.id, { to: "succeeded", result });
      const second = seedInvocation(h, s, { purpose: "node_result", continuedFromInvocationId: first.id });
      seedManifest(h, s, second);
      const resumed = h.stores.invocations.createAttempt({ invocationId: second.id, startMode: "resumed", resumedFromAttemptId: a1.id });
      expect(resumed.resumedFromAttemptId).toBe(a1.id);
      const unrelated = seedInvocation(h, s, { role: "worker", purpose: "step", planNodeId: seedWorkerNode(h, s).id });
      seedManifest(h, s, unrelated);
      expect(() => h.stores.invocations.createAttempt({ invocationId: unrelated.id, startMode: "resumed", resumedFromAttemptId: a1.id })).toThrow(InvariantViolationError);
      expect(() => h.stores.invocations.createAttempt({ invocationId: unrelated.id, startMode: "resumed", resumedFromAttemptId: null })).toThrow(ValidationError);
    } finally {
      h.close();
    }
  });

  it("records transcript Artifacts of the Run and classifies timeouts as interrupted", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const invocation = seedInvocation(h, s);
      seedManifest(h, s, invocation);
      const attempt = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
      h.stores.invocations.transitionAttempt(attempt.id, { to: "running", capacityLeaseId: null });
      const other = seedRun(h);
      const foreign = seedArtifact(h, other, "transcript");
      expect(() => h.stores.invocations.transitionAttempt(attempt.id, { to: "timed_out", transcriptArtifactId: foreign.id })).toThrow(InvariantViolationError);
      const transcript = h.stores.artifacts.create({ runId: s.run.id, mediaType: "application/x-agent-transcript", producer: { kind: "runtime", component: "transcript" }, taskId: null, title: null }, new TextEncoder().encode("..."));
      const timedOut = h.stores.invocations.transitionAttempt(attempt.id, { to: "timed_out", transcriptArtifactId: transcript.id });
      expect(timedOut.failureClass).toBe("interrupted");
      expect(timedOut.transcriptArtifactId).toBe(transcript.id);
    } finally {
      h.close();
    }
  });
});

describe("provider continuations", () => {
  it("stores pointer metadata only and resolves missing, expired, or mismatched payloads to null", async () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const invocation = seedInvocation(h, s);
      seedManifest(h, s, invocation);
      const attempt = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
      const payloads = new MemoryContinuationPayloadStore(sha256Hex);
      const service = new ContinuationService(h.stores.continuations, payloads, { ttlMs: null, clock: h.ctx.clock });
      const bytes = new TextEncoder().encode("opaque provider state");
      const digest = await payloads.put(`fake/${attempt.id}`, bytes);
      expect(h.stores.continuations.get(attempt.id)).toBeNull();
      expect(await service.resolve(attempt.id, "fake")).toBeNull();
      h.stores.continuations.put({ attemptId: attempt.id, provider: "fake", storageKey: `fake/${attempt.id}`, digest, expiresAt: null });
      expect(await service.resolve(attempt.id, "fake")).toEqual(bytes);
      expect(await service.resolve(attempt.id, "other-provider")).toBeNull();
      // The row carries no payload column and the journal never mentions it.
      const columns = (h.database.sqlite.prepare("PRAGMA table_info(provider_continuations)").all() as { name: string }[]).map((c) => c.name);
      expect(columns).toEqual(["attempt_id", "provider", "storage_key", "digest", "created_at", "expires_at"]);
      expect(h.ctx.journal.read({ runId: s.run.id }).some((e) => JSON.stringify(e).includes("opaque provider state") || e.type.includes("continuation"))).toBe(false);
      // Digest mismatch: the pointer and payload are discarded.
      await payloads.put(`fake/${attempt.id}`, new TextEncoder().encode("tampered"));
      expect(await service.resolve(attempt.id, "fake")).toBeNull();
      expect(h.stores.continuations.get(attempt.id)).toBeNull();
      expect(await payloads.get(`fake/${attempt.id}`)).toBeNull();
      // The service stores and indexes in one step, with an expiry from its configured TTL.
      await service.store(attempt.id, "fake", bytes);
      expect(h.stores.continuations.get(attempt.id)?.expiresAt).toBeNull();
      expect(await service.resolve(attempt.id, "fake")).toEqual(bytes);
      await service.truncate();
      expect(h.stores.continuations.count()).toBe(0);
      // Expiry.
      h.stores.continuations.put({ attemptId: attempt.id, provider: "fake", storageKey: "k", digest, expiresAt: "2026-01-01T00:00:10.000Z" });
      expect(h.stores.continuations.get(attempt.id, "2026-01-01T00:00:09.000Z")).not.toBeNull();
      expect(h.stores.continuations.get(attempt.id, "2026-01-01T00:00:10.000Z")).toBeNull();
      expect(h.stores.continuations.deleteExpired("2026-01-01T00:00:10.000Z")).toBe(1);
      // Truncation.
      h.stores.continuations.put({ attemptId: attempt.id, provider: "fake", storageKey: "k", digest, expiresAt: null });
      h.stores.continuations.truncate();
      await payloads.truncate();
      expect(h.stores.continuations.count()).toBe(0);
      expect(payloads.size).toBe(0);
      expect(() => h.stores.continuations.put({ attemptId: "att_000000000000000000000000", provider: "fake", storageKey: "k", digest, expiresAt: null })).toThrow(/not found/);
    } finally {
      h.close();
    }
  });
});

describe("capacity leases", () => {
  it("grants one active lease per live Attempt and releases it once", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const invocation = seedInvocation(h, s);
      seedManifest(h, s, invocation);
      const attempt = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
      const resources = { provider: "fake", providerSlots: 1, processSlots: 1, worktrees: 1 };
      const lease = h.stores.leases.grant({ runId: s.run.id, attemptId: attempt.id, resources });
      expect(() => h.stores.leases.grant({ runId: s.run.id, attemptId: attempt.id, resources })).toThrow(ConflictError);
      h.stores.invocations.transitionAttempt(attempt.id, { to: "running", capacityLeaseId: lease.id });
      expect(h.stores.leases.listActive().map((l) => l.id)).toEqual([lease.id]);
      const released = h.stores.leases.release(lease.id);
      expect(released.releasedAt).not.toBeNull();
      expect(() => h.stores.leases.release(lease.id)).toThrow(IllegalTransitionError);
      expect(() => h.database.sqlite.prepare("UPDATE capacity_leases SET status = 'active' WHERE id = ?").run(lease.id)).toThrow(/never changes again/);
      h.stores.invocations.transitionAttempt(attempt.id, { to: "cancelled", transcriptArtifactId: null });
      expect(() => h.stores.leases.grant({ runId: s.run.id, attemptId: attempt.id, resources })).toThrow(ConflictError);
    } finally {
      h.close();
    }
  });
});
