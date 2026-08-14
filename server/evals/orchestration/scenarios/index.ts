/** Scenario registry: implemented scenarios plus the planned set awaiting features. */
import type { OrchestrationScenario } from "../scenario.ts";
import agentFailure from "./agent-failure.ts";
import ambiguousSignal from "./ambiguous-signal.ts";
import hiddenConstraint from "./hidden-constraint.ts";
import parallelExploration from "./parallel-exploration.ts";
import hungAgent from "./hung-agent.ts";
import noisyContraryEvidence from "./noisy-contrary-evidence.ts";
import suboptimalFraming from "./suboptimal-framing.ts";
import trivialNoDelegation from "./trivial-no-delegation.ts";
import twoPerspectivesBetter from "./two-perspectives-better.ts";
import vagueGreenfield from "./vague-greenfield.ts";
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
  hungAgent,
];

/**
 * Planned scenarios that depend on capabilities this project is adding; each
 * lands (and its it.todo flips to a real test) with the feature it names.
 * Scenarios marked live-only never get a Tier A variant.
 */
export const PLANNED: { id: string; awaiting: string }[] = [
  { id: "reviewer-invalidates-spec", awaiting: "scenario authoring (uses the runner's proposal resolution)" },
  { id: "restart-honesty", awaiting: "scenario authoring (uses the runner's restart phases)" },
  { id: "visual-judgment", awaiting: "live-only by design (rendering cannot be faked); lands with the artifact-evidence bundle" },
];
