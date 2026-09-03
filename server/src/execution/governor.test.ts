/**
 * The resource governor (execution-model §7.8; invariant 18 deterministic
 * backpressure): deterministic grants and refusals with every structured
 * reason, retry-after, one active lease per Attempt, release once, restart
 * restoration from canonical leases, and no dependency on any model or
 * semantic state.
 */
import { IllegalTransitionError } from "@agentique-console/core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openHarness, seedInvocation, seedManifest, seedRun, seedWorkerNode, type Harness, type Seeded } from "../persistence/test-support.ts";
import { ResourceGovernor, type LeaseOutcome } from "./governor.ts";

function attempt(h: Harness, s: Seeded, role: "worker" | "evaluator" = "worker") {
  const invocation = role === "worker" ? seedInvocation(h, s, { role, purpose: "step", planNodeId: seedWorkerNode(h, s).id }) : seedInvocation(h, s, { role, purpose: "evaluate" });
  seedManifest(h, s, invocation);
  return h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
}

function granted(outcome: LeaseOutcome) {
  if (!outcome.granted) throw new Error(`refused: ${outcome.refusal.reason}`);
  return outcome.lease;
}

describe("ResourceGovernor", () => {
  it("grants deterministically within provider and process concurrency and refuses with each structured reason", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { rootAllocation: { costUsd: 20, tokens: 200_000, attempts: 20 } });
      const governor = new ResourceGovernor(h.stores.leases, { providers: { fake: { maxConcurrency: 2 }, idle: { maxConcurrency: 0 } }, maxProcessConcurrency: 3, maxWorktrees: 1 }, h.ctx.clock);
      const a1 = attempt(h, s);
      const a2 = attempt(h, s);
      const a3 = attempt(h, s);
      const lease1 = granted(governor.tryAcquire({ runId: s.run.id, attemptId: a1.id, provider: "fake", worktrees: 1 }));
      expect(lease1).toMatchObject({ runId: s.run.id, attemptId: a1.id, status: "active", resources: { provider: "fake", providerSlots: 1, processSlots: 1, worktrees: 1 } });
      // One active lease per Attempt: a second request for the same Attempt is answered with no second lease.
      expect(governor.check({ runId: s.run.id, attemptId: a1.id, provider: "fake", worktrees: 1 })).toBeNull();
      expect(() => h.stores.leases.grant({ runId: s.run.id, attemptId: a1.id, resources: lease1.resources })).toThrow(/already holds a lease/);
      // Unknown or zero-limit provider: configured_limit; a worktree above the configured maximum: configured_limit.
      expect(governor.tryAcquire({ runId: s.run.id, attemptId: a2.id, provider: "other", worktrees: 0 })).toEqual({ granted: false, refusal: { reason: "configured_limit", retryAfter: null } });
      expect(governor.tryAcquire({ runId: s.run.id, attemptId: a2.id, provider: "idle", worktrees: 0 })).toEqual({ granted: false, refusal: { reason: "configured_limit", retryAfter: null } });
      expect(governor.tryAcquire({ runId: s.run.id, attemptId: a2.id, provider: "fake", worktrees: 2 })).toEqual({ granted: false, refusal: { reason: "configured_limit", retryAfter: null } });
      // A second worktree exceeds the worktree ceiling while the first is held: process_concurrency.
      expect(governor.tryAcquire({ runId: s.run.id, attemptId: a2.id, provider: "fake", worktrees: 1 })).toEqual({ granted: false, refusal: { reason: "process_concurrency", retryAfter: null } });
      granted(governor.tryAcquire({ runId: s.run.id, attemptId: a2.id, provider: "fake", worktrees: 0 }));
      // Provider concurrency is exhausted at two; the refusal writes nothing.
      const leases = h.stores.leases.listByRun(s.run.id).length;
      expect(governor.tryAcquire({ runId: s.run.id, attemptId: a3.id, provider: "fake", worktrees: 0 })).toEqual({ granted: false, refusal: { reason: "provider_concurrency", retryAfter: null } });
      expect(h.stores.leases.listByRun(s.run.id)).toHaveLength(leases);
      expect(governor.status()).toMatchObject({ providers: [{ provider: "fake", maxConcurrency: 2, active: 2, availability: { available: true } }, { provider: "idle", active: 0 }], process: { maxConcurrency: 3, active: 2 }, worktrees: { max: 1, active: 1 } });
      expect(governor.status().activeLeases.map((l) => l.attemptId)).toEqual([a1.id, a2.id]);
      // Release exactly once; a released lease stays released and is never reactivated.
      const released = governor.release(lease1.id);
      expect(released.status).toBe("released");
      expect(governor.release(lease1.id).status).toBe("released");
      expect(() => h.stores.leases.release(lease1.id)).toThrow(IllegalTransitionError);
      expect(governor.status().process.active).toBe(1);
      granted(governor.tryAcquire({ runId: s.run.id, attemptId: a3.id, provider: "fake", worktrees: 0 }));
    } finally {
      h.close();
    }
  });

  it("refuses with provider_quota and a retry-after time until the time passes, then clears automatically", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { rootAllocation: { costUsd: 20, tokens: 200_000, attempts: 20 } });
      const governor = new ResourceGovernor(h.stores.leases, { providers: { fake: { maxConcurrency: 4 } }, maxProcessConcurrency: 4, maxWorktrees: null }, h.ctx.clock);
      const a1 = attempt(h, s);
      governor.updateProviderAvailability("fake", { available: false, retryAfter: "2026-01-01T00:10:00.000Z" });
      expect(governor.tryAcquire({ runId: s.run.id, attemptId: a1.id, provider: "fake", worktrees: 0 })).toEqual({ granted: false, refusal: { reason: "provider_quota", retryAfter: "2026-01-01T00:10:00.000Z" } });
      expect(governor.status().providers[0]!.availability).toEqual({ available: false, retryAfter: "2026-01-01T00:10:00.000Z" });
      h.clock.set("2026-01-01T00:10:00.000Z");
      expect(governor.tryAcquire({ runId: s.run.id, attemptId: a1.id, provider: "fake", worktrees: 0 }).granted).toBe(true);
      // Without a retry-after time the refusal holds until the provider reports availability again.
      const a2 = attempt(h, s);
      governor.updateProviderAvailability("fake", { available: false, retryAfter: null });
      expect(governor.tryAcquire({ runId: s.run.id, attemptId: a2.id, provider: "fake", worktrees: 0 })).toEqual({ granted: false, refusal: { reason: "provider_quota", retryAfter: null } });
      governor.updateProviderAvailability("fake", { available: true });
      expect(governor.tryAcquire({ runId: s.run.id, attemptId: a2.id, provider: "fake", worktrees: 0 }).granted).toBe(true);
    } finally {
      h.close();
    }
  });

  it("restores after a restart from canonical leases only: stale active leases are released and in-memory state is never relied on", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { rootAllocation: { costUsd: 20, tokens: 200_000, attempts: 20 } });
      const config = { providers: { fake: { maxConcurrency: 1 } }, maxProcessConcurrency: 1, maxWorktrees: null };
      const first = new ResourceGovernor(h.stores.leases, config, h.ctx.clock);
      const a1 = attempt(h, s);
      const stale = granted(first.tryAcquire({ runId: s.run.id, attemptId: a1.id, provider: "fake", worktrees: 0 }));
      first.updateProviderAvailability("fake", { available: false, retryAfter: null });
      // A new process over the same database sees the stale lease as active until it restores.
      const second = new ResourceGovernor(h.stores.leases, config, h.ctx.clock);
      const a2 = attempt(h, s);
      expect(second.tryAcquire({ runId: s.run.id, attemptId: a2.id, provider: "fake", worktrees: 0 })).toEqual({ granted: false, refusal: { reason: "provider_concurrency", retryAfter: null } });
      expect(second.restoreAfterRestart()).toEqual({ releasedLeaseIds: [stale.id] });
      expect(second.restoreAfterRestart()).toEqual({ releasedLeaseIds: [] });
      expect(h.stores.leases.get(stale.id).status).toBe("released");
      expect(second.status().providers[0]!.availability).toEqual({ available: true });
      expect(second.tryAcquire({ runId: s.run.id, attemptId: a2.id, provider: "fake", worktrees: 0 }).granted).toBe(true);
    } finally {
      h.close();
    }
  });

  it("depends on resource facts only: no prompt, manifest, result, Requirement, Task, or Plan module and no model", () => {
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "governor.ts"), "utf8");
    for (const specifier of source.matchAll(/from\s+"([^"]+)"/g)) {
      expect(specifier[1]).toMatch(/^(@agentique-console\/core|\.\.\/persistence\/stores\/(capacity|support)\.ts)$/);
    }
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/manifest|render|prompt|requirement|task|decision|pattern|model\b|execute\(/i);
  });
});
