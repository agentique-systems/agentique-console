/**
 * Context-rotation arithmetic shared by the two lane engines (the agent-session
 * host and the orchestrator runner). The reason is computed at the decision
 * site and carried to the `*.context.rotated` event — never reconstructed
 * after the fact.
 */
export type RotationReason = "token_limit" | "turn_limit";

/**
 * `soft` = the budget is reached; rotate at the next natural boundary (the
 * seat host defers until the current assignment has a terminal report).
 * `hard` = 1.25× the budget; rotate now regardless. A live run rotated 47/47
 * times mid-assignment on the flat threshold, and every mid-work rotation
 * paid re-priming for state a boundary rotation would have carried for free.
 */
export type RotationUrgency = "soft" | "hard";

const HARD_FACTOR = 1.25;

export function rotationDue(input: {
  turnCount: number;
  contextTokens: number;
  turnLimit: number;
  tokenLimit: number;
}): { reason: RotationReason; urgency: RotationUrgency } | null {
  if (input.contextTokens >= input.tokenLimit * HARD_FACTOR) return { reason: "token_limit", urgency: "hard" };
  if (input.turnCount >= input.turnLimit * HARD_FACTOR) return { reason: "turn_limit", urgency: "hard" };
  if (input.contextTokens >= input.tokenLimit) return { reason: "token_limit", urgency: "soft" };
  if (input.turnCount >= input.turnLimit) return { reason: "turn_limit", urgency: "soft" };
  return null;
}
