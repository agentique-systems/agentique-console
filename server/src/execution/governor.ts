/**
 * The resource governor (execution-model §7.8): deterministic backpressure
 * over provider quota, provider concurrency, and process concurrency,
 * granting persisted capacity leases to Attempts. Its inputs are resource
 * facts only — configured limits, active lease rows, provider availability
 * reports — and its accounting is derived from the canonical `capacity_leases`
 * table on every call, so a rolled-back grant, a crashed process, or a
 * restart never leaves it trusting stale in-memory counts. It never reads a
 * prompt, manifest, result, Requirement, Task, or Plan; it never invokes a
 * model; it never polls.
 */
import {
  type AttemptId,
  type CapacityLease,
  type CapacityLeaseId,
  type CapacityRefusal,
  type CapacityRefusalReason,
  type RunId,
  type Timestamp,
} from "@agentique-console/core";
import type { CapacityLeaseStore } from "../persistence/stores/capacity.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";

export interface GovernorConfig {
  /** Concurrent Attempts permitted per provider; a provider absent here is refused with `configured_limit`. */
  providers: Record<string, { maxConcurrency: number }>;
  /** Concurrent Attempts permitted in this process across every provider. */
  maxProcessConcurrency: number;
  /** Concurrent worktrees permitted, or `null` for no limit. */
  maxWorktrees: number | null;
}

export interface LeaseRequest {
  runId: RunId;
  attemptId: AttemptId;
  provider: string;
  /** Worktrees the Attempt holds: 1 for a writing Invocation, 0 otherwise. */
  worktrees: number;
}

export type LeaseOutcome = { granted: true; lease: CapacityLease } | { granted: false; refusal: CapacityRefusal };

/** A provider's reported availability: quota or overload refusals with an optional retry-after time. */
export type ProviderAvailability = { available: true } | { available: false; retryAfter: Timestamp | null };

export interface GovernorStatus {
  providers: { provider: string; maxConcurrency: number; active: number; availability: ProviderAvailability }[];
  process: { maxConcurrency: number; active: number };
  worktrees: { max: number | null; active: number };
  activeLeases: CapacityLease[];
}

export class ResourceGovernor {
  readonly #availability = new Map<string, ProviderAvailability>();

  constructor(
    private readonly leases: CapacityLeaseStore,
    private readonly config: GovernorConfig,
    private readonly clock: () => Timestamp,
  ) {}

  /**
   * Grants a lease, persisting it atomically in the caller's transaction, or
   * refuses with one structured reason, evaluated in a fixed order:
   * `configured_limit` (unknown provider or zero limit), `provider_quota`
   * (the provider reported itself unavailable and the retry-after time has
   * not passed), `provider_concurrency`, `process_concurrency`. A refusal
   * writes nothing.
   */
  tryAcquire(request: LeaseRequest, options?: WriteOptions): LeaseOutcome {
    const refusal = this.check(request);
    if (refusal) return { granted: false, refusal };
    const lease = this.leases.grant(
      { runId: request.runId, attemptId: request.attemptId, resources: { provider: request.provider, providerSlots: 1, processSlots: 1, worktrees: request.worktrees } },
      options,
    );
    return { granted: true, lease };
  }

  /**
   * The refusal `tryAcquire` would return for `request` right now, or
   * `null` when a lease would be granted; writes nothing. A caller that must
   * not create an Attempt on refusal checks first, creates the Attempt, and
   * then acquires in the same transaction, where the answer cannot change.
   */
  check(request: Omit<LeaseRequest, "attemptId"> & { attemptId?: AttemptId }): CapacityRefusal | null {
    return this.#refusal({ ...request, attemptId: request.attemptId ?? null });
  }

  /** Releases an active lease exactly once; a lease already released is left as it is. */
  release(leaseId: CapacityLeaseId, options?: WriteOptions): CapacityLease {
    const lease = this.leases.get(leaseId);
    if (lease.status === "released") return lease;
    return this.leases.release(leaseId, options);
  }

  /**
   * The governor's capacity signal (execution-model §7.8, §14 "Provider
   * capacity refused by the governor"): `listener` is called once after
   * every committed transaction that released a lease — the only moment
   * capacity a refused Run waited for can have become grantable without a
   * retry-after time passing. It carries no decision: the caller re-projects
   * the waiting Runs from rows and the scheduler asks the governor again.
   * Returns the unsubscribe.
   */
  onCapacityReleased(listener: () => void): () => void {
    return this.leases.onReleased(listener);
  }

  /** A provider's own report (rate limit, usage window, overload); `retryAfter` clears the refusal automatically once passed. */
  updateProviderAvailability(provider: string, availability: ProviderAvailability): void {
    if (availability.available) this.#availability.delete(provider);
    else this.#availability.set(provider, availability);
  }

  /**
   * Rebuilds the governor from canonical state after a restart: every lease
   * still `active` belonged to the previous process and is released, and
   * provider availability is forgotten (a provider that is still refusing
   * says so again on the next Attempt). Idempotent.
   */
  restoreAfterRestart(options?: WriteOptions): { releasedLeaseIds: CapacityLeaseId[] } {
    this.#availability.clear();
    const releasedLeaseIds = this.leases.listActive().map((lease) => this.leases.release(lease.id, options).id);
    return { releasedLeaseIds };
  }

  status(): GovernorStatus {
    const active = this.#active();
    const now = this.clock();
    return {
      providers: Object.keys(this.config.providers)
        .sort()
        .map((provider) => ({
          provider,
          maxConcurrency: this.config.providers[provider]!.maxConcurrency,
          active: active.filter((l) => l.resources.provider === provider).length,
          availability: this.#availabilityOf(provider, now),
        })),
      process: { maxConcurrency: this.config.maxProcessConcurrency, active: active.length },
      worktrees: { max: this.config.maxWorktrees, active: active.reduce((sum, l) => sum + l.resources.worktrees, 0) },
      activeLeases: active,
    };
  }

  #active(): CapacityLease[] {
    return [...this.leases.listActive()].sort((a, b) => (a.grantedAt < b.grantedAt ? -1 : a.grantedAt > b.grantedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  #availabilityOf(provider: string, now: Timestamp): ProviderAvailability {
    const reported = this.#availability.get(provider);
    if (!reported || reported.available) return { available: true };
    if (reported.retryAfter !== null && reported.retryAfter <= now) {
      this.#availability.delete(provider);
      return { available: true };
    }
    return reported;
  }

  #refusal(request: Omit<LeaseRequest, "attemptId"> & { attemptId: AttemptId | null }): CapacityRefusal | null {
    const refuse = (reason: CapacityRefusalReason, retryAfter: Timestamp | null = null): CapacityRefusal => ({ reason, retryAfter });
    const limit = this.config.providers[request.provider];
    if (!limit || limit.maxConcurrency <= 0 || this.config.maxProcessConcurrency <= 0) return refuse("configured_limit");
    if (this.config.maxWorktrees !== null && request.worktrees > this.config.maxWorktrees) return refuse("configured_limit");
    const availability = this.#availabilityOf(request.provider, this.clock());
    if (!availability.available) return refuse("provider_quota", availability.retryAfter);
    const active = this.#active();
    if (request.attemptId !== null && active.some((l) => l.attemptId === request.attemptId)) return null;
    if (active.filter((l) => l.resources.provider === request.provider).length >= limit.maxConcurrency) return refuse("provider_concurrency");
    if (active.length >= this.config.maxProcessConcurrency) return refuse("process_concurrency");
    if (this.config.maxWorktrees !== null && active.reduce((sum, l) => sum + l.resources.worktrees, 0) + request.worktrees > this.config.maxWorktrees) return refuse("process_concurrency");
    return null;
  }
}
