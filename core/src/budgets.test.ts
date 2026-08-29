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

describe("allocations", () => {
  it("compares every quantity and computes availability", () => {
    expect(allocationFits({ costUsd: 1, tokens: 10, attempts: 1 }, { costUsd: 1, tokens: 10, attempts: 1 })).toBe(true);
    expect(allocationFits({ costUsd: 1.01, tokens: 10, attempts: 1 }, { costUsd: 1, tokens: 10, attempts: 1 })).toBe(false);
    expect(allocationFits({ costUsd: 1, tokens: 11, attempts: 1 }, { costUsd: 1, tokens: 10, attempts: 1 })).toBe(false);
    expect(allocationFits({ costUsd: 1, tokens: 10, attempts: 2 }, { costUsd: 1, tokens: 10, attempts: 1 })).toBe(false);
    const account = capacityAccount({ costUsd: 10, tokens: 100, attempts: 10 }, { costUsd: 4, tokens: 40, attempts: 4 }, { costUsd: 1, tokens: 10, attempts: 1 });
    expect(account.available).toEqual({ costUsd: 5, tokens: 50, attempts: 5 });
    expect(subtractAllocation({ costUsd: 1, tokens: 1, attempts: 1 }, { costUsd: 1, tokens: 1, attempts: 1 })).toEqual({ costUsd: 0, tokens: 0, attempts: 0 });
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
    expect(isReservationPair("run", "invocation")).toBe(false);
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
