/**
 * The effort levels a lane may run at — the SDK's own union, listed once so
 * config and profile validation reject a typo at boot instead of shipping it
 * to the CLI unchecked.
 */
import type { SdkOptions } from "./types.ts";

export type EffortLevel = NonNullable<SdkOptions["effort"]>;

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];

/** Compile-time completeness: adding a level to the SDK union fails THIS line, not a live run. */
type Unlisted = Exclude<EffortLevel, (typeof EFFORT_LEVELS)[number]>;
type AssertNone<T extends never> = T;
export type _AllEffortLevelsListed = AssertNone<Unlisted>;

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}
