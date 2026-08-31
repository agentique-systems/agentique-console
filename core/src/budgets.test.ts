import { describe, expect, it } from "vitest";
import {
  allocationFits,
  budgetReservationSchema,
  capacityAccount,
  isReservationPair,
  RESERVATION_CHILD_TYPES,
  RESERVATION_PARENT_TYPES,
  RESERVATION_STATUSES,
  subtractAllocation,
} from "./budgets.ts";
import { newId } from "./ids.ts";
import { consumedAllocation, sumUsage, totalTokens, usageSchema } from "./usage.ts";
import { maxAllocation, minAllocation, reservationCharge, runCapacityAccount } from "./budgets.ts";
import { allocationExtensionSchema, allocationHasPositive, allocationShortfall, ALLOCATION_EXTENSION_TRIGGERS, budgetIncreaseSchema, BUDGET_INCREASE_PARTITIONS, NO_BUDGET_INCREASES, sumAllocations } from "./budgets.ts";
import { budgetIncreasePermitted, BUDGET_INCREASE_PERMITTED_STATUSES, RUN_STATUSES } from "./runs.ts";

describe("allocations", () => {
  it("compares every quantity and computes availability", () => {
    expect(allocationFits({ costUsd: 1, tokens: 10, attempts: 1 }, { costUsd: 1, tokens: 10, attempts: 1 })).toBe(true);
    expect(allocationFits({ costUsd: 1.01, tokens: 10, attempts: 1 }, { costUsd: 1, tokens: 10, attempts: 1 })).toBe(false);
    expect(allocationFits({ costUsd: 1, tokens: 11, attempts: 1 }, { costUsd: 1, tokens: 10, attempts: 1 })).toBe(false);
    expect(allocationFits({ costUsd: 1, tokens: 10, attempts: 2 }, { costUsd: 1, tokens: 10, attempts: 1 })).toBe(false);
    const account = capacityAccount(
      { costUsd: 10, tokens: 100, attempts: 10 },
      [
        { status: "active", reserved: { costUsd: 4, tokens: 40, attempts: 4 }, actual: { costUsd: 0, tokens: 0, attempts: 0 } },
        { status: "released", reserved: { costUsd: 2, tokens: 20, attempts: 2 }, actual: { costUsd: 1, tokens: 10, attempts: 1 } },
      ],
    );
    expect(account).toEqual({
      limit: { costUsd: 10, tokens: 100, attempts: 10 },
      reserved: { costUsd: 4, tokens: 40, attempts: 4 },
      consumed: { costUsd: 1, tokens: 10, attempts: 1 },
      active: { costUsd: 4, tokens: 40, attempts: 4 },
      committed: { costUsd: 5, tokens: 50, attempts: 5 },
      available: { costUsd: 5, tokens: 50, attempts: 5 },
    });
    // An active child that overran is charged max(reserved, actual) per component, never clamped.
    expect(reservationCharge({ status: "active", reserved: { costUsd: 4, tokens: 40, attempts: 4 }, actual: { costUsd: 6, tokens: 30, attempts: 5 } })).toEqual({ costUsd: 6, tokens: 40, attempts: 5 });
    expect(reservationCharge({ status: "released", reserved: { costUsd: 4, tokens: 40, attempts: 4 }, actual: { costUsd: 1, tokens: 90, attempts: 1 } })).toEqual({ costUsd: 1, tokens: 90, attempts: 1 });
    expect(maxAllocation({ costUsd: 1, tokens: 9, attempts: 3 }, { costUsd: 2, tokens: 8, attempts: 3 })).toEqual({ costUsd: 2, tokens: 9, attempts: 3 });
    expect(minAllocation({ costUsd: 1, tokens: 9, attempts: 3 }, { costUsd: 2, tokens: 8, attempts: 3 })).toEqual({ costUsd: 1, tokens: 8, attempts: 3 });
    expect(subtractAllocation({ costUsd: 1, tokens: 1, attempts: 1 }, { costUsd: 1, tokens: 1, attempts: 1 })).toEqual({ costUsd: 0, tokens: 0, attempts: 0 });
  });
});

describe("run capacity partitions", () => {
  it("bounds each partition by the global Run Budget and lets an overrun in either partition reduce the other's effective availability", () => {
    const limit = { costUsd: 100, tokens: 1000, attempts: 10 };
    const reserve = { costUsd: 10, tokens: 100, attempts: 2 };
    // Ordinary actual 95 > ordinary limit 90 (active child overran); final untouched.
    const base = { baseLimit: limit, baseFinalReserve: reserve, increases: NO_BUDGET_INCREASES };
    const overrun = runCapacityAccount(base, [{ status: "active", reserved: { costUsd: 60, tokens: 500, attempts: 5 }, actual: { costUsd: 95, tokens: 400, attempts: 5 } }], []);
    expect(overrun.ordinary.available).toEqual({ costUsd: -5, tokens: 400, attempts: 3 });
    expect(overrun.global.available).toEqual({ costUsd: 5, tokens: 500, attempts: 5 });
    expect(overrun.final.available).toEqual(reserve);
    // Final effective availability is bounded by what is globally left: 5, not 10.
    expect(overrun.final.effectiveAvailable).toEqual({ costUsd: 5, tokens: 100, attempts: 2 });
    expect(overrun.ordinary.effectiveAvailable).toEqual({ costUsd: -5, tokens: 400, attempts: 3 });
    // A final overrun reduces global and therefore ordinary effective availability, but ordinary never borrows unused reserve.
    const finalOverrun = runCapacityAccount(base, [{ status: "active", reserved: { costUsd: 50, tokens: 500, attempts: 5 }, actual: { costUsd: 0, tokens: 0, attempts: 0 } }], [{ status: "released", reserved: { costUsd: 10, tokens: 100, attempts: 2 }, actual: { costUsd: 45, tokens: 100, attempts: 2 } }]);
    expect(finalOverrun.global.available).toEqual({ costUsd: 5, tokens: 400, attempts: 3 });
    expect(finalOverrun.ordinary.available).toEqual({ costUsd: 40, tokens: 400, attempts: 3 });
    expect(finalOverrun.ordinary.effectiveAvailable).toEqual({ costUsd: 5, tokens: 400, attempts: 3 });
    expect(finalOverrun.final.effectiveAvailable).toEqual({ costUsd: -35, tokens: 0, attempts: 0 });
    const idle = runCapacityAccount(base, [], []);
    expect(idle.limit).toEqual(limit);
    expect(idle.finalReserve).toEqual(reserve);
    expect(idle.ordinary.limit).toEqual({ costUsd: 90, tokens: 900, attempts: 8 });
    expect(idle.ordinary.effectiveAvailable).toEqual({ costUsd: 90, tokens: 900, attempts: 8 });
    expect(idle.final.effectiveAvailable).toEqual(reserve);
  });
});

describe("budget increases and allocation extensions", () => {
  const limit = { costUsd: 100, tokens: 1000, attempts: 10 };
  const reserve = { costUsd: 10, tokens: 100, attempts: 2 };
  const zero = { costUsd: 0, tokens: 0, attempts: 0 };

  it("derives every effective limit from the immutable base plus the approved increases per partition, keeping the partitions disjoint", () => {
    const ordinary = runCapacityAccount({ baseLimit: limit, baseFinalReserve: reserve, increases: { ordinary: { costUsd: 20, tokens: 200, attempts: 4 }, finalReserve: zero } }, [], []);
    expect(ordinary.baseLimit).toEqual(limit);
    expect(ordinary.baseFinalReserve).toEqual(reserve);
    // An ordinary increase enlarges the global and ordinary limits and leaves the final reserve untouched.
    expect(ordinary.limit).toEqual({ costUsd: 120, tokens: 1200, attempts: 14 });
    expect(ordinary.finalReserve).toEqual(reserve);
    expect(ordinary.ordinary.limit).toEqual({ costUsd: 110, tokens: 1100, attempts: 12 });
    expect(ordinary.final.limit).toEqual(reserve);
    expect(ordinary.ordinary.effectiveAvailable).toEqual({ costUsd: 110, tokens: 1100, attempts: 12 });
    expect(ordinary.final.effectiveAvailable).toEqual(reserve);
    // A final-reserve increase enlarges the global and final limits together and leaves ordinary capacity untouched.
    const final = runCapacityAccount({ baseLimit: limit, baseFinalReserve: reserve, increases: { ordinary: zero, finalReserve: { costUsd: 5, tokens: 50, attempts: 1 } } }, [], []);
    expect(final.limit).toEqual({ costUsd: 105, tokens: 1050, attempts: 11 });
    expect(final.finalReserve).toEqual({ costUsd: 15, tokens: 150, attempts: 3 });
    expect(final.ordinary.limit).toEqual({ costUsd: 90, tokens: 900, attempts: 8 });
    expect(final.final.effectiveAvailable).toEqual({ costUsd: 15, tokens: 150, attempts: 3 });
    expect(final.ordinary.effectiveAvailable).toEqual({ costUsd: 90, tokens: 900, attempts: 8 });
    // Increases fabricate no consumption and clamp nothing: a released overrun stays negative until an increase covers it.
    const overrun = runCapacityAccount({ baseLimit: limit, baseFinalReserve: reserve, increases: NO_BUDGET_INCREASES }, [{ status: "released", reserved: { costUsd: 50, tokens: 500, attempts: 5 }, actual: { costUsd: 95, tokens: 950, attempts: 9 } }], []);
    expect(overrun.ordinary.available).toEqual({ costUsd: -5, tokens: -50, attempts: -1 });
    expect(overrun.ordinary.consumed).toEqual({ costUsd: 95, tokens: 950, attempts: 9 });
    const covered = runCapacityAccount({ baseLimit: limit, baseFinalReserve: reserve, increases: { ordinary: { costUsd: 10, tokens: 100, attempts: 2 }, finalReserve: zero } }, [{ status: "released", reserved: { costUsd: 50, tokens: 500, attempts: 5 }, actual: { costUsd: 95, tokens: 950, attempts: 9 } }], []);
    expect(covered.ordinary.consumed).toEqual({ costUsd: 95, tokens: 950, attempts: 9 });
    expect(covered.ordinary.available).toEqual({ costUsd: 5, tokens: 50, attempts: 1 });
  });

  it("charges an active Plan Node reservation its effective reserved allocation (original plus extensions) against actual consumption, and a released one its actual consumption once", () => {
    // The store hands the effective reserved amount (original + Σ extensions) as the charge's `reserved`.
    const original = { costUsd: 4, tokens: 40, attempts: 4 };
    const extended = sumAllocations([original, { costUsd: 0, tokens: 20, attempts: 1 }]);
    expect(extended).toEqual({ costUsd: 4, tokens: 60, attempts: 5 });
    expect(reservationCharge({ status: "active", reserved: extended, actual: { costUsd: 1, tokens: 10, attempts: 1 } })).toEqual(extended);
    expect(reservationCharge({ status: "active", reserved: extended, actual: { costUsd: 9, tokens: 70, attempts: 2 } })).toEqual({ costUsd: 9, tokens: 70, attempts: 5 });
    // Released: complete actual consumption, whatever was reserved or extended; the extension is provenance only.
    expect(reservationCharge({ status: "released", reserved: extended, actual: { costUsd: 2, tokens: 90, attempts: 6 } })).toEqual({ costUsd: 2, tokens: 90, attempts: 6 });
    const account = capacityAccount(limit, [{ status: "active", reserved: extended, actual: { costUsd: 9, tokens: 70, attempts: 2 } }]);
    expect(account.reserved).toEqual(extended);
    expect(account.active).toEqual({ costUsd: 9, tokens: 70, attempts: 5 });
    expect(account.available).toEqual({ costUsd: 91, tokens: 930, attempts: 5 });
  });

  it("computes the exact component-wise shortfall: never rounded up, never speculative, zero where covered", () => {
    expect(allocationShortfall({ costUsd: 2, tokens: 20_000, attempts: 2 }, { costUsd: 5, tokens: 5_000, attempts: 1 })).toEqual({ costUsd: 0, tokens: 15_000, attempts: 1 });
    expect(allocationShortfall({ costUsd: 2, tokens: 20, attempts: 2 }, { costUsd: 2, tokens: 20, attempts: 2 })).toEqual(zero);
    expect(allocationShortfall({ costUsd: 2, tokens: 20, attempts: 2 }, { costUsd: -3, tokens: -1, attempts: 0 })).toEqual({ costUsd: 5, tokens: 21, attempts: 2 });
    // Float noise below the tolerance is not a shortfall.
    expect(allocationShortfall({ costUsd: 0.3, tokens: 0, attempts: 0 }, { costUsd: 0.1 + 0.2, tokens: 0, attempts: 0 })).toEqual(zero);
    expect(allocationHasPositive(zero)).toBe(false);
    expect(allocationHasPositive({ costUsd: 0, tokens: 0, attempts: 1 })).toBe(true);
  });

  it("validates the two records: closed partitions and triggers, non-negative quantities with at least one positive", () => {
    expect(BUDGET_INCREASE_PARTITIONS).toEqual(["ordinary", "final_reserve"]);
    expect(ALLOCATION_EXTENSION_TRIGGERS).toEqual(["invocation", "task_batch", "gate_evaluator", "gate_remediation", "root_turn", "signoff_follow_up"]);
    const increase = { id: newId("budgetIncrease"), runId: newId("run"), decisionId: newId("decision"), partition: "ordinary", added: { costUsd: 0, tokens: 0, attempts: 1 }, createdAt: "2026-01-01T00:00:00.000Z" };
    expect(budgetIncreaseSchema.safeParse(increase).success).toBe(true);
    expect(budgetIncreaseSchema.safeParse({ ...increase, added: zero }).success).toBe(false);
    expect(budgetIncreaseSchema.safeParse({ ...increase, added: { costUsd: -1, tokens: 5, attempts: 0 } }).success).toBe(false);
    expect(budgetIncreaseSchema.safeParse({ ...increase, partition: "global" }).success).toBe(false);
    expect(budgetIncreaseSchema.safeParse({ ...increase, reason: "more" }).success).toBe(false);
    const extension = { id: newId("allocationExtension"), runId: newId("run"), planNodeId: newId("planNode"), reservationId: newId("budgetReservation"), added: { costUsd: 1, tokens: 0, attempts: 0 }, trigger: "invocation", createdAt: "2026-01-01T00:00:00.000Z" };
    expect(allocationExtensionSchema.safeParse(extension).success).toBe(true);
    expect(allocationExtensionSchema.safeParse({ ...extension, added: zero }).success).toBe(false);
    expect(allocationExtensionSchema.safeParse({ ...extension, trigger: "operator asked" }).success).toBe(false);
    expect(allocationExtensionSchema.safeParse({ ...extension, reason: "because" }).success).toBe(false);
  });

  it("admits an ordinary increase until the Run ends and a final-reserve increase only before verification began", () => {
    expect(BUDGET_INCREASE_PERMITTED_STATUSES).toEqual({ ordinary: ["created", "running", "waiting", "awaiting_signoff"], final_reserve: ["created", "running", "waiting"] });
    for (const status of RUN_STATUSES) {
      expect(budgetIncreasePermitted(status, "ordinary")).toBe(["created", "running", "waiting", "awaiting_signoff"].includes(status));
      expect(budgetIncreasePermitted(status, "final_reserve")).toBe(["created", "running", "waiting"].includes(status));
    }
  });
});

describe("reservation records", () => {
  it("uses closed parent and child types and only the defined pairs", () => {
    expect(RESERVATION_PARENT_TYPES).toEqual(["run", "plan_node", "invocation"]);
    expect(RESERVATION_CHILD_TYPES).toEqual(["plan_node", "invocation", "task"]);
    expect(RESERVATION_STATUSES).toEqual(["active", "released"]);
    expect(isReservationPair("run", "plan_node")).toBe(true);
    expect(isReservationPair("plan_node", "invocation")).toBe(true);
    expect(isReservationPair("plan_node", "task")).toBe(true);
    expect(isReservationPair("run", "invocation")).toBe(true);
    expect(isReservationPair("run", "task")).toBe(false);
    expect(isReservationPair("invocation", "task")).toBe(false);
  });

  it("requires release fields exactly when released", () => {
    const base = {
      id: newId("budgetReservation"),
      runId: newId("run"),
      parent: { type: "run", id: newId("run") },
      child: { type: "plan_node", id: newId("planNode") },
      reserved: { costUsd: 1, tokens: 10, attempts: 2 },
      consumed: null,
      capacitySource: "ordinary",
      finalReserveUse: null,
      status: "active",
      transferredFromReservationId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      releasedAt: null,
      releaseReason: null,
    };
    expect(budgetReservationSchema.safeParse(base).success).toBe(true);
    expect(budgetReservationSchema.safeParse({ ...base, status: "released" }).success).toBe(false);
    expect(budgetReservationSchema.safeParse({ ...base, status: "released", releasedAt: base.createdAt, releaseReason: "child_terminal", consumed: { costUsd: 0.5, tokens: 5, attempts: 1 } }).success).toBe(true);
    expect(budgetReservationSchema.safeParse({ ...base, releaseReason: "child_terminal" }).success).toBe(false);
    expect(budgetReservationSchema.safeParse({ ...base, child: { type: "task", id: newId("task") } }).success).toBe(false);
    expect(budgetReservationSchema.safeParse({ ...base, parent: { type: "seat", id: newId("run") } }).success).toBe(false);
    // Only a Run → Invocation reservation may draw from the final reserve, and it always records its use.
    const finalUse = { ...base, child: { type: "invocation", id: newId("invocation") }, capacitySource: "final_reserve", finalReserveUse: "final_synthesis" };
    expect(budgetReservationSchema.safeParse(finalUse).success).toBe(true);
    expect(budgetReservationSchema.safeParse({ ...finalUse, finalReserveUse: null }).success).toBe(false);
    expect(budgetReservationSchema.safeParse({ ...finalUse, capacitySource: "ordinary" }).success).toBe(false);
    expect(budgetReservationSchema.safeParse({ ...base, capacitySource: "final_reserve", finalReserveUse: "final_synthesis" }).success).toBe(false);
    expect(budgetReservationSchema.safeParse({ ...base, finalReserveUse: "run_completion" }).success).toBe(false);
    expect(budgetReservationSchema.safeParse({ ...finalUse, transferredFromReservationId: newId("budgetReservation") }).success).toBe(false);
    expect(budgetReservationSchema.safeParse({ ...base, parent: { type: "plan_node", id: newId("planNode") }, child: { type: "invocation", id: newId("invocation") }, capacitySource: "final_reserve", finalReserveUse: "run_completion" }).success).toBe(false);
  });
});

describe("usage roll-ups", () => {
  const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: newId("usage"),
    runId: newId("run"),
    planNodeId: newId("planNode"),
    invocationId: newId("invocation"),
    attemptId: newId("attempt"),
    model: "claude-fable-5",
    effort: "medium",
    inputTokensUncached: 100,
    cacheCreationTokens: 20,
    cacheReadTokens: 300,
    outputTokens: 50,
    costUsd: 0.25,
    wallClockMs: 1500,
    providerMs: 1200,
    recordedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  it("keeps cached and uncached token classes distinct and sums each field", () => {
    const a = usageSchema.parse(row());
    const b = usageSchema.parse(row({ inputTokensUncached: 1, cacheCreationTokens: 2, cacheReadTokens: 3, outputTokens: 4, costUsd: 0.75, wallClockMs: 500, providerMs: null }));
    const totals = sumUsage([a, b]);
    expect(totals).toEqual({ rows: 2, inputTokensUncached: 101, cacheCreationTokens: 22, cacheReadTokens: 303, outputTokens: 54, costUsd: 1, wallClockMs: 2000, providerMs: 1200 });
    expect(totalTokens(totals)).toBe(480);
    expect(consumedAllocation(totals, 2)).toEqual({ costUsd: 1, tokens: 480, attempts: 2 });
  });

  it("rejects negative quantities and unknown efforts", () => {
    expect(usageSchema.safeParse(row({ outputTokens: -1 })).success).toBe(false);
    expect(usageSchema.safeParse(row({ effort: "extreme" })).success).toBe(false);
  });
});
