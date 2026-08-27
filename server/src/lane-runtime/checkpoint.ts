/**
 * Checkpoint naming, shared by both lane engines' Console-reconstructed
 * continuation paths (`composer.reconstructCheckpoint`, the runner's recovery
 * draft). The model-queried rotation checkpoint that used to live here left
 * with the old console-side rotation subsystem; both stories that remain —
 * crash recovery and wake-boundary generation retirement — are deterministic
 * reconstructions from durable state, differing only in source and quality
 * flags.
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

/**
 * Marks a checkpoint written at a PLANNED generation boundary (the seat's
 * provider session was retired for context burden, not lost). Same
 * idempotence guard as the recovery prefix.
 */
export const ROTATION_PREFIX = "Rotation checkpoint: ";

export function rotationAction(action: string): string {
  return action.startsWith(ROTATION_PREFIX) ? action : `${ROTATION_PREFIX}${action}`;
}
