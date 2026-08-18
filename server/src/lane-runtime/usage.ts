/** Cumulative cost/api-duration last seen for a provider session. */
export interface UsageWatermark { costUsd: number; apiDurationMs: number }

/**
 * `cumulativeCostUsd`/`cumulativeApiDurationMs` restate the provider session's
 * running total on every result, so a turn's own figure is the delta since the
 * watermark last advanced.
 * Mutates the watermark as a side effect — call exactly once per result.
 */
export function advanceUsageWatermark(watermark: UsageWatermark, event: { cumulativeCostUsd?: number; cumulativeApiDurationMs?: number }): { costUsd: number | null; apiDurationMs: number | null } {
  // A total BELOW the watermark means the counter restarted underneath us (a
  // genuinely fresh provider session). Take the raw value rather than clamping
  // a real turn to zero — correct under either SDK behaviour.
  if (event.cumulativeCostUsd !== undefined && event.cumulativeCostUsd < watermark.costUsd) {
    watermark.costUsd = 0;
    watermark.apiDurationMs = 0;
  }
  const costUsd = event.cumulativeCostUsd === undefined ? null : Math.max(0, event.cumulativeCostUsd - watermark.costUsd);
  const apiDurationMs = event.cumulativeApiDurationMs === undefined ? null : Math.max(0, event.cumulativeApiDurationMs - watermark.apiDurationMs);
  if (event.cumulativeCostUsd !== undefined) watermark.costUsd = event.cumulativeCostUsd;
  if (event.cumulativeApiDurationMs !== undefined) watermark.apiDurationMs = event.cumulativeApiDurationMs;
  return { costUsd, apiDurationMs };
}
