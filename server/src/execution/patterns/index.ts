/**
 * The Pattern runners of Phase 2C: `single` and `chain`, over the shared
 * sequential step engine, plus the root Orchestrator node's support. Every
 * other Pattern is deferred to a later phase and never falsely scheduled.
 */
import type { Pattern } from "@agentique-console/core";
import { ChainPatternRunner } from "./chain.ts";
import { RootNodeSupport } from "./root.ts";
import { SinglePatternRunner } from "./single.ts";
import type { PatternRunnerDependencies } from "./support.ts";

export { ChainPatternRunner } from "./chain.ts";
export { RootNodeSupport } from "./root.ts";
export type { RootAdvice, RootOutcome } from "./root.ts";
export { SinglePatternRunner } from "./single.ts";
export { SequentialStepEngine, blockingDecisionOf, outstandingChangesetOf } from "./support.ts";
export type { NodeAdvice, PatternRunnerDependencies, PatternRunnerOutcome } from "./support.ts";

export type PatternRunner = SinglePatternRunner | ChainPatternRunner;

export interface PatternRunners {
  single: SinglePatternRunner;
  chain: ChainPatternRunner;
  root: RootNodeSupport;
}

export function createPatternRunners(deps: PatternRunnerDependencies): PatternRunners {
  return { single: new SinglePatternRunner(deps), chain: new ChainPatternRunner(deps), root: new RootNodeSupport(deps) };
}

/** The runner for a Pattern, or `null` when the Pattern belongs to a later phase. */
export function runnerFor(runners: PatternRunners, pattern: Pattern): PatternRunner | null {
  switch (pattern) {
    case "single":
      return runners.single;
    case "chain":
      return runners.chain;
    default:
      return null;
  }
}
