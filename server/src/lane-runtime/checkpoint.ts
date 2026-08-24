/**
 * Recovery-checkpoint naming, shared by both lane engines' CRASH-RECOVERY
 * paths (`composer.reconstructCheckpoint`, the runner's recovery draft). The
 * model-queried rotation checkpoint that used to live here left with the
 * console-side rotation subsystem — native compaction manages context, and
 * recovery reconstruction is the one checkpoint story that remains.
 */

/**
 * Marks a checkpoint rebuilt from durable console state after a lane died.
 * The prefix is a `startsWith` idempotence guard: a draft recovered from an
 * already-recovered draft must not stack prefixes.
 */
export const RECOVERY_PREFIX = "Recovery checkpoint: ";

export function recoveryAction(action: string): string {
  return action.startsWith(RECOVERY_PREFIX) ? action : `${RECOVERY_PREFIX}${action}`;
}
