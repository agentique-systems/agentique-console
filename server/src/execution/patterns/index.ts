/**
 * The Pattern runners: `single` and `chain` over the shared sequential step
 * engine, `route`, `parallel`, `coordinator_worker` (with the pure Task
 * projection), and `evaluator_optimizer` (with the deterministic check
 * service) over the shared node support, plus the root Orchestrator node's
 * support. Every one of the six Patterns has a runner.
 */
import type { Pattern, PatternPosition, PlanNodeId, Timestamp } from "@agentique-console/core";
import type { WriteOptions } from "../../persistence/stores/support.ts";
import { RunCompletionEngine } from "../completion.ts";
import { ChainPatternRunner } from "./chain.ts";
import { CoordinatorWorkerPatternRunner } from "./coordinator-worker.ts";
import { EvaluatorOptimizerPatternRunner } from "./evaluator-optimizer.ts";
import { ParallelPatternRunner } from "./parallel.ts";
import { RootNodeSupport } from "./root.ts";
import { RoutePatternRunner } from "./route.ts";
import { SinglePatternRunner } from "./single.ts";
import type { NodeAdvice, PatternRunnerDependencies, PatternRunnerOutcome } from "./support.ts";

export { ChainPatternRunner } from "./chain.ts";
export { CoordinatorWorkerPatternRunner } from "./coordinator-worker.ts";
export { EvaluatorOptimizerPatternRunner } from "./evaluator-optimizer.ts";
export { ParallelPatternRunner } from "./parallel.ts";
export { RootNodeSupport } from "./root.ts";
export type { RootAdvice, RootOutcome } from "./root.ts";
export { RoutePatternRunner } from "./route.ts";
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
  /** The `node_exit` Gate phase (execution-model §10), delegated to the shared Gate engine; never advised by `evaluator_optimizer`. */
  openGate(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions): PatternRunnerOutcome;
  verifyGate(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions): Promise<PatternRunnerOutcome>;
  prepareGateEvaluator(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions): PatternRunnerOutcome;
  settleGate(nodeId: PlanNodeId, expectedRevisionNumber: number, options?: WriteOptions): PatternRunnerOutcome;
}

export interface PatternRunners {
  single: SinglePatternRunner;
  chain: ChainPatternRunner;
  route: RoutePatternRunner;
  parallel: ParallelPatternRunner;
  coordinatorWorker: CoordinatorWorkerPatternRunner;
  evaluatorOptimizer: EvaluatorOptimizerPatternRunner;
  root: RootNodeSupport;
  /** The Run completion engine (execution-model §10 `run_completion`), driven by the same scheduler. */
  completion: RunCompletionEngine;
}

export function createPatternRunners(deps: PatternRunnerDependencies): PatternRunners {
  const completion = new RunCompletionEngine(deps);
  return {
    single: new SinglePatternRunner(deps),
    chain: new ChainPatternRunner(deps),
    route: new RoutePatternRunner(deps),
    parallel: new ParallelPatternRunner(deps),
    coordinatorWorker: new CoordinatorWorkerPatternRunner(deps),
    evaluatorOptimizer: new EvaluatorOptimizerPatternRunner(deps),
    root: new RootNodeSupport(deps, completion),
    completion,
  };
}

/** The runner for a Pattern. */
export function runnerFor(runners: PatternRunners, pattern: Pattern): PatternRunner {
  switch (pattern) {
    case "single":
      return runners.single;
    case "chain":
      return runners.chain;
    case "route":
      return runners.route;
    case "parallel":
      return runners.parallel;
    case "coordinator_worker":
      return runners.coordinatorWorker;
    case "evaluator_optimizer":
      return runners.evaluatorOptimizer;
  }
}
