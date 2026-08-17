/**
 * Context-rotation arithmetic shared by the two lane engines (the agent-session
 * host and the orchestrator runner). Only consulted when `contextRotation` is
 * on; the reason is computed at the decision site and carried to the
 * `*.context.rotated` event — never reconstructed after the fact.
 *
 * Unconditional at the limit: the knob means what it says. A soft/hard split
 * (rotate at the next assignment boundary, force at 1.25×) existed while
 * rotation was the default; with native compaction carrying continuity, an
 * operator who turns rotation on wants it exactly where they set it.
 */
export type RotationReason = "token_limit" | "turn_limit";

export function rotationDue(input: {
  turnCount: number;
  contextTokens: number;
  /** 0 = no turn limit. */
  turnLimit: number;
  tokenLimit: number;
}): { reason: RotationReason } | null {
  if (input.contextTokens >= input.tokenLimit) return { reason: "token_limit" };
  if (input.turnLimit > 0 && input.turnCount >= input.turnLimit) return { reason: "turn_limit" };
  return null;
}
