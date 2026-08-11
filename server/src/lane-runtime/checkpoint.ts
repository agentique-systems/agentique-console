/** Checkpoint-query constants shared by both lane engines' rotation paths. */

/**
 * A checkpoint is a read-only self-description; every tool that could act on
 * the world (or fork context) is denied.
 */
export const CHECKPOINT_DENIED_TOOLS = [
  "Agent", "SendMessage", "Task", "Bash", "Edit", "Write", "WebSearch", "WebFetch",
];

/**
 * Marks a checkpoint rebuilt from the last real handoff after a failed
 * checkpoint query. The prefix is a `startsWith` idempotence guard: a draft
 * recovered from an already-recovered draft must not stack prefixes.
 */
export const RECOVERY_PREFIX = "Recovery checkpoint: ";

export function recoveryAction(action: string): string {
  return action.startsWith(RECOVERY_PREFIX) ? action : `${RECOVERY_PREFIX}${action}`;
}
