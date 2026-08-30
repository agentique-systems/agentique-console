/**
 * The Pattern runners: `single` and `chain` over the shared sequential step
 * engine, plus the root Orchestrator node's support. Every other Pattern
 * has no runner yet and `runnerFor` returns `null` for it, so it is never
 * falsely scheduled.
 */
import type { Pattern, PatternPosition, PlanNodeId, Timestamp } from "@agentique-console/core";
import type { WriteOptions } from "../../persistence/stores/support.ts";
import { ChainPatternRunner } from "./chain.ts";
import { RootNodeSupport } from "./root.ts";
import { SinglePatternRunner } from "./single.ts";
import type { NodeAdvice, PatternRunnerDependencies, PatternRunnerOutcome } from "./support.ts";

export { ChainPatternRunner } from "./chain.ts";
export { RootNodeSupport } from "./root.ts";
export type { RootAdvice, RootOutcome } from "./root.ts";
export { SinglePatternRunner } from "./single.ts";
export { PatternNodeSupport, SequentialStepEngine, activeInvocationAdvice, blockedOn, blockingDecisionOf, outstandingChangesetOf } from "./support.ts";
export type { IntegrationStep, NodeAdvice, PatternRunnerDependencies, PatternRunnerOutcome, PreparationRequest, WaitContext } from "./support.ts";

/** What every Pattern runner exposes to the scheduler. */
export interface PatternRunner {
  readonly pattern: Pattern;
  inspect(nodeId: PlanNodeId, now?: Timestamp): NodeAdvice;
  start(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions): PatternRunnerOutcome;
  startPosition(nodeId: PlanNodeId, expectedRevisionNumber: number, position: PatternPosition, options?: WriteOptions): PatternRunnerOutcome;
  settle(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions): Promise<PatternRunnerOutcome>;
  settleRemoved(nodeId: PlanNodeId, options?: WriteOptions): Promise<PatternRunnerOutcome>;
  resume(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions): PatternRunnerOutcome;
  markWaiting(nodeId: PlanNodeId, expectedRevisionNumber: number, reason: "provider_capacity" | "budget", options?: WriteOptions): PatternRunnerOutcome;
}

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
