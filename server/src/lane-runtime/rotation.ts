/**
 * Context-rotation arithmetic shared by the two lane engines (the agent-session
 * host and the orchestrator runner). The reason is computed at the decision
 * site and carried to the `*.context.rotated` event — never reconstructed
 * after the fact.
 */
export type RotationReason = "token_limit" | "turn_limit";

export function rotationDue(input: {
  turnCount: number;
  contextTokens: number;
  turnLimit: number;
  tokenLimit: number;
}): { reason: RotationReason } | null {
  if (input.contextTokens >= input.tokenLimit) return { reason: "token_limit" };
  if (input.turnCount >= input.turnLimit) return { reason: "turn_limit" };
  return null;
}
