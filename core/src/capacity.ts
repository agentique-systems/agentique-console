import { z } from "zod";
import type { AttemptId, CapacityLeaseId, RunId } from "./ids.ts";
import { defineStateMachine } from "./transitions.ts";
import { count, idSchema, nonEmptyString, timestampSchema, type Timestamp } from "./validation.ts";

/** Structured reasons the Resource Governor refuses a lease. */
export const CAPACITY_REFUSAL_REASONS = [
  "provider_quota",
  "provider_concurrency",
  "process_concurrency",
  "configured_limit",
] as const;
export type CapacityRefusalReason = (typeof CAPACITY_REFUSAL_REASONS)[number];

export interface CapacityRefusal {
  reason: CapacityRefusalReason;
  retryAfter: Timestamp | null;
}

export const capacityRefusalSchema: z.ZodType<CapacityRefusal> = z.strictObject({
  reason: z.enum(CAPACITY_REFUSAL_REASONS),
  retryAfter: timestampSchema.nullable(),
});

/** The resources a lease holds while its Attempt runs. */
export interface LeasedResources {
  provider: string;
  providerSlots: number;
  processSlots: number;
  worktrees: number;
}

export const leasedResourcesSchema: z.ZodType<LeasedResources> = z.strictObject({
  provider: nonEmptyString,
  providerSlots: count,
  processSlots: count,
  worktrees: count,
});

export const LEASE_STATUSES = ["active", "released"] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];

export const LEASE_MACHINE = defineStateMachine<LeaseStatus>("CapacityLease", LEASE_STATUSES, {
  active: ["released"],
  released: [],
});

export interface CapacityLease {
  id: CapacityLeaseId;
  runId: RunId;
  attemptId: AttemptId;
  resources: LeasedResources;
  status: LeaseStatus;
  grantedAt: Timestamp;
  releasedAt: Timestamp | null;
}

export const capacityLeaseSchema: z.ZodType<CapacityLease> = z
  .strictObject({
    id: idSchema("capacityLease"),
    runId: idSchema("run"),
    attemptId: idSchema("attempt"),
    resources: leasedResourcesSchema,
    status: z.enum(LEASE_STATUSES),
    grantedAt: timestampSchema,
    releasedAt: timestampSchema.nullable(),
  })
  .refine((l) => (l.status === "released") === (l.releasedAt !== null), {
    message: "releasedAt is set exactly when the lease is released",
    path: ["releasedAt"],
  });

export interface CapacityLeaseInput {
  runId: RunId;
  attemptId: AttemptId;
  resources: LeasedResources;
}

export const capacityLeaseInputSchema: z.ZodType<CapacityLeaseInput> = z.strictObject({
  runId: idSchema("run"),
  attemptId: idSchema("attempt"),
  resources: leasedResourcesSchema,
});
