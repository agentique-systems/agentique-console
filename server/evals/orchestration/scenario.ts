/**
 * Scenario contract for the orchestration evaluation suite.
 *
 * A scenario is one task the orchestrator can be confronted with, written so
 * BOTH tiers run it: Tier A drives scripted fake-SDK programs through the real
 * composition root and asserts the checks against the journal; Tier B replays
 * the same taskCard/operatorScript against the real orchestrator and runs the
 * SAME checks (plus judged rubrics) over the exported journal. The checks are
 * the shared artifact — Tier A proves they can tell an exemplary trace from a
 * violating one, which is what makes Tier B's mechanical scores trustworthy.
 */
import type { FakeProgram } from "../../src/sdk/fake.ts";
import type { Harness, HarnessOptions } from "../../src/test-helpers.ts";
import type { Ev, Trace } from "./trace.ts";

/** Evaluation dimensions; judged rubrics in rubrics/ use the same ids. */
export type DimensionId =
  | "intent-development"
  | "spec-quality"
  | "question-quality"
  | "question-economy"
  | "exploration"
  | "delegation"
  | "pattern-selection"
  | "marginal-agent-value"
  | "parallelism"
  | "adaptation"
  | "evidence-consumption"
  | "opportunity-discovery"
  | "supervision"
  | "failure-handling"
  | "verification-independence"
  | "review-appropriateness"
  | "reopening"
  | "stopping"
  | "operator-alignment"
  | "decision-quality"
  | "outcome-quality"
  | "cost-latency"
  | "unnecessary-work";

export interface CheckResult {
  pass: boolean;
  /** Event seqs the verdict rests on — evidence, not vibes. */
  evidence: number[];
  detail: string;
}

export interface TraceCheck {
  id: string;
  dimension: DimensionId;
  description: string;
  run(trace: Trace): CheckResult;
}

/** One scripted operator behavior; steps are consulted in order, first match wins. */
export type OperatorStep =
  | {
      /** Answer the first pending question whose text matches. */
      onQuestionMatching: RegExp;
      /** Option labels per question text; free text under `freeText`. */
      answer: Record<string, string[]>;
      freeText?: Record<string, string>;
    }
  | {
      /** Say something in chat after the first event matching the predicate. */
      afterEvent: (event: Ev) => boolean;
      say: string;
    }
  | {
      /**
       * Resolve a proposed spec/plan card or a completion sign-off.
       * `kind` narrows the match: "spec" = a plan card carrying the spec
       * marker, "completion" = the sign-off; omitted = first of either.
       */
      onProposal: "approve" | "reject";
      kind?: "spec" | "completion";
      note?: string;
    };

export interface ScenarioVariant {
  program: (ctx: ProgramCtx) => FakeProgram;
  /** "pass": every check must pass. "flag": at least one of flaggedChecks must fail. */
  expect: "pass" | "flag";
  /** Check ids expected to flag on a violation variant (any one suffices). */
  flaggedChecks?: string[];
  /**
   * Variant-specific done predicate (factory, fresh per run) — a violation
   * often cannot conclude the way the exemplary flow does (e.g. a wedged
   * agent nobody stops never produces a final).
   */
  doneWhen?: () => (event: Ev) => boolean;
}

/** Mutable per-run context handed to program factories (gates, counters). */
export interface ProgramCtx {
  /** A promise-gate: `gate.promise` never resolves until `gate.release()`. */
  makeGate(): { promise: Promise<void>; release: () => void };
  /**
   * The live harness for THIS run — available once programs execute (set
   * right after construction). Lets a scripted main look up ids it could not
   * otherwise know (e.g. the agentSessionId it just created) via raw SQL.
   */
  harness(): Harness;
}

export interface OrchestrationScenario {
  id: string;
  title: string;
  /** The operator's opening message — identical across tiers. */
  taskCard: string;
  operatorScript: OperatorStep[];
  /** Dimensions this scenario is designed to stress (drives Tier B judging). */
  stressedDimensions: DimensionId[];
  /** Checks run on both tiers' journals. */
  checks: TraceCheck[];
  /** Tier A material; absent for live-only scenarios (e.g. visual judgment). */
  fake?: {
    variants: Record<string, ScenarioVariant>;
    harness?: HarnessOptions;
    /**
     * Two-phase run: phase 1 collects until `when` fires, then the harness
     * restarts (same sqlite, real bootApp recovery — the restart-honesty
     * substrate), and phase 2 collects until doneWhen. Unfired operator
     * steps re-arm on the restarted harness.
     */
    restart?: { when: () => (event: Ev) => boolean };
    /**
     * Factory for the done predicate (fresh per run so counting predicates
     * cannot leak state across variants). Defaults to the first
     * agent_session.result.returned.
     */
    doneWhen?: () => (event: Ev) => boolean;
    /** Collection timeout for the done event. */
    timeoutMs?: number;
  };
  live?: {
    /** Fixture directory under evals/orchestration/fixtures/ seeded as the workspace. */
    fixture?: string;
    maxBudgetUsd: number;
    timeoutMin: number;
    /** Persona hint for an LLM-simulated operator (scripted table still wins). */
    operatorPersona?: string;
    /**
     * True when the scenario has no meaningful pre-change baseline because the
     * behavior under test depends on capabilities that did not exist before
     * this project (alarms, spec tools, orchestration state). Marked, never
     * manufactured.
     */
    noPreChangeBaseline?: boolean;
  };
}

export function defineScenario(scenario: OrchestrationScenario): OrchestrationScenario {
  return scenario;
}
