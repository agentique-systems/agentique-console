/**
 * Per-model context catalog. Windows are DELIBERATE under-estimates: an
 * under-estimated window only makes rotation trigger a little earlier, which
 * is safe; an over-estimate risks a hard context-overflow error, which is
 * not. The fable-5/opus-5/sonnet-5 tiers advertise 1M-token windows; the
 * catalog records the historically guaranteed 200K so the configured limit
 * stays binding for known models. `source` records which cascade step matched
 * so a surprising rotation threshold is traceable.
 */

export interface ModelContextInfo {
  contextWindow: number;
  maxOutput: number;
  source: "exact" | "family" | "default";
}

const EXACT: Record<string, Omit<ModelContextInfo, "source">> = {
  "claude-sonnet-5": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-opus-5": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-fable-5": { contextWindow: 200_000, maxOutput: 64_000 },
};

/** Longest-prefix families, matched after exact ids. */
const FAMILIES: Record<string, Omit<ModelContextInfo, "source">> = {
  "claude-opus-": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-sonnet-": { contextWindow: 200_000, maxOutput: 64_000 },
  // Without this a dated fable variant falls to DEFAULT and halves its ceiling.
  "claude-fable-": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-haiku-": { contextWindow: 180_000, maxOutput: 64_000 },
};

const DEFAULT: Omit<ModelContextInfo, "source"> = { contextWindow: 100_000, maxOutput: 32_000 };

export function resolveModelContext(modelId: string | null | undefined): ModelContextInfo {
  const normalized = (modelId ?? "").trim().toLowerCase();
  if (normalized !== "") {
    const exact = EXACT[normalized];
    if (exact) return { ...exact, source: "exact" };
    const family = Object.keys(FAMILIES)
      .filter((prefix) => normalized.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (family) return { ...FAMILIES[family]!, source: "family" };
  }
  return { ...DEFAULT, source: "default" };
}

/**
 * The rotation token ceiling for a participant: the operator's configured
 * limit, lowered — never raised — by what the model can actually hold after
 * reserving output room.
 */
export function rotationTokenLimit(configLimit: number, modelId: string | null | undefined): number {
  const info = resolveModelContext(modelId);
  return Math.min(configLimit, info.contextWindow - info.maxOutput);
}
