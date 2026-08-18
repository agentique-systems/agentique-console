/**
 * Per-model context ceilings. Windows are DELIBERATE under-estimates: an
 * under-estimated window only makes rotation trigger a little earlier, which
 * is safe; an over-estimate risks a hard context-overflow error, which is
 * not. The fable/opus/sonnet tiers advertise 1M-token windows; the catalog
 * records the historically guaranteed 200K so the configured limit stays
 * binding for known models. Unknown ids fall to a conservative floor.
 */

interface ModelContext {
  contextWindow: number;
  maxOutput: number;
}

/** Longest-prefix families; every dated variant of a family matches. */
const FAMILIES: Record<string, ModelContext> = {
  "claude-opus-": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-sonnet-": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-fable-": { contextWindow: 200_000, maxOutput: 64_000 },
  "claude-haiku-": { contextWindow: 180_000, maxOutput: 64_000 },
};

const DEFAULT: ModelContext = { contextWindow: 100_000, maxOutput: 32_000 };

export function resolveModelContext(modelId: string | null | undefined): ModelContext {
  const normalized = (modelId ?? "").trim().toLowerCase();
  const family = Object.keys(FAMILIES)
    .filter((prefix) => normalized.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  return family ? FAMILIES[family]! : DEFAULT;
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
