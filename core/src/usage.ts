import { z } from "zod";
import { MODEL_EFFORTS, type ModelEffort } from "./agents.ts";
import type { Allocation } from "./budgets.ts";
import type { AttemptId, InvocationId, PlanNodeId, RunId, UsageId } from "./ids.ts";
import { count, idSchema, nonEmptyString, quantity, timestampSchema, type Timestamp } from "./validation.ts";

/**
 * Measured consumption of one provider result, attributed to its Attempt,
 * Invocation, Plan Node, and Run. Cached and uncached input tokens are
 * distinct fields and never merged.
 */
export interface Usage {
  id: UsageId;
  runId: RunId;
  planNodeId: PlanNodeId;
  invocationId: InvocationId;
  attemptId: AttemptId;
  model: string;
  effort: ModelEffort | null;
  inputTokensUncached: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  wallClockMs: number;
  providerMs: number | null;
  recordedAt: Timestamp;
}

export const usageSchema: z.ZodType<Usage> = z.strictObject({
  id: idSchema("usage"),
  runId: idSchema("run"),
  planNodeId: idSchema("planNode"),
  invocationId: idSchema("invocation"),
  attemptId: idSchema("attempt"),
  model: nonEmptyString,
  effort: z.enum(MODEL_EFFORTS).nullable(),
  inputTokensUncached: count,
  cacheCreationTokens: count,
  cacheReadTokens: count,
  outputTokens: count,
  costUsd: quantity,
  wallClockMs: count,
  providerMs: count.nullable(),
  recordedAt: timestampSchema,
});

export interface UsageInput {
  attemptId: AttemptId;
  model: string;
  effort: ModelEffort | null;
  inputTokensUncached: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  wallClockMs: number;
  providerMs: number | null;
}

export const usageInputSchema: z.ZodType<UsageInput> = z.strictObject({
  attemptId: idSchema("attempt"),
  model: nonEmptyString,
  effort: z.enum(MODEL_EFFORTS).nullable(),
  inputTokensUncached: count,
  cacheCreationTokens: count,
  cacheReadTokens: count,
  outputTokens: count,
  costUsd: quantity,
  wallClockMs: count,
  providerMs: count.nullable(),
});

/** A roll-up of Usage rows; every field is a plain sum except `rows`. */
export interface UsageTotals {
  rows: number;
  inputTokensUncached: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  wallClockMs: number;
  providerMs: number;
}

export const ZERO_USAGE_TOTALS: Readonly<UsageTotals> = Object.freeze({
  rows: 0,
  inputTokensUncached: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  wallClockMs: 0,
  providerMs: 0,
});

export function sumUsage(rows: Iterable<Pick<Usage, keyof Omit<UsageTotals, "rows" | "providerMs"> | "providerMs">>): UsageTotals {
  const totals: UsageTotals = { ...ZERO_USAGE_TOTALS };
  for (const row of rows) {
    totals.rows += 1;
    totals.inputTokensUncached += row.inputTokensUncached;
    totals.cacheCreationTokens += row.cacheCreationTokens;
    totals.cacheReadTokens += row.cacheReadTokens;
    totals.outputTokens += row.outputTokens;
    totals.costUsd += row.costUsd;
    totals.wallClockMs += row.wallClockMs;
    totals.providerMs += row.providerMs ?? 0;
  }
  return totals;
}

/** Total tokens counted against a token allocation: every input class plus output. */
export function totalTokens(totals: Pick<UsageTotals, "inputTokensUncached" | "cacheCreationTokens" | "cacheReadTokens" | "outputTokens">): number {
  return totals.inputTokensUncached + totals.cacheCreationTokens + totals.cacheReadTokens + totals.outputTokens;
}

/** The consumed cost and tokens of a set of rows, as reservation accounting sees them. */
export function consumedAllocation(totals: UsageTotals, attempts: number): Allocation {
  return { costUsd: totals.costUsd, tokens: totalTokens(totals), attempts };
}
