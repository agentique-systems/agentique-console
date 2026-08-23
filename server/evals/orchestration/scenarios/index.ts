/** Scenario registry: implemented scenarios plus the planned set awaiting features. */
import type { OrchestrationScenario } from "../scenario.ts";
import agentFailure from "./agent-failure.ts";
import ambiguousSignal from "./ambiguous-signal.ts";
import hiddenConstraint from "./hidden-constraint.ts";
import parallelExploration from "./parallel-exploration.ts";
import hungAgent from "./hung-agent.ts";
import noisyContraryEvidence from "./noisy-contrary-evidence.ts";
import requirementTraceability from "./requirement-traceability.ts";
import restartHonesty from "./restart-honesty.ts";
import reviewerInvalidatesSpec from "./reviewer-invalidates-spec.ts";
import silentAssumption from "./silent-assumption.ts";
import stagedElaboration from "./staged-elaboration.ts";
import suboptimalFraming from "./suboptimal-framing.ts";
import trivialNoDelegation from "./trivial-no-delegation.ts";
import twoPerspectivesBetter from "./two-perspectives-better.ts";
import vagueGreenfield from "./vague-greenfield.ts";
import visualJudgment from "./visual-judgment.ts";
import wastefulParallelism from "./wasteful-parallelism.ts";
import wellSpecified from "./well-specified.ts";

export const SCENARIOS: OrchestrationScenario[] = [
  trivialNoDelegation,
  vagueGreenfield,
  wellSpecified,
  suboptimalFraming,
  wastefulParallelism,
  agentFailure,
  parallelExploration,
  hiddenConstraint,
  noisyContraryEvidence,
  ambiguousSignal,
  twoPerspectivesBetter,
  reviewerInvalidatesSpec,
  requirementTraceability,
  silentAssumption,
  stagedElaboration,
  hungAgent,
  restartHonesty,
  visualJudgment,
];

/**
 * Planned scenarios awaiting features. Empty: every planned scenario has
 * landed. (visual-judgment is live-only by design — rendering cannot be
 * faked — so it ships without Tier A variants and uses only checkers other
 * scenarios validate.)
 */
export const PLANNED: { id: string; awaiting: string }[] = [];
