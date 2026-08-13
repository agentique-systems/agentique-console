/** Scenario registry: implemented scenarios plus the planned set awaiting features. */
import type { OrchestrationScenario } from "../scenario.ts";
import agentFailure from "./agent-failure.ts";
import hiddenConstraint from "./hidden-constraint.ts";
import parallelExploration from "./parallel-exploration.ts";
import hungAgent from "./hung-agent.ts";
import trivialNoDelegation from "./trivial-no-delegation.ts";
import vagueGreenfield from "./vague-greenfield.ts";
import wastefulParallelism from "./wasteful-parallelism.ts";
import wellSpecified from "./well-specified.ts";

export const SCENARIOS: OrchestrationScenario[] = [
  trivialNoDelegation,
  vagueGreenfield,
  wellSpecified,
  wastefulParallelism,
  agentFailure,
  parallelExploration,
  hiddenConstraint,
  hungAgent,
];

/**
 * Planned scenarios that depend on capabilities this project is adding; each
 * lands (and its it.todo flips to a real test) with the feature it names.
 * Scenarios marked live-only never get a Tier A variant.
 */
export const PLANNED: { id: string; awaiting: string }[] = [
  { id: "suboptimal-framing", awaiting: "features landed; scenario authoring pending (framing-challenge quality is judge-only)" },
  { id: "noisy-contrary-evidence", awaiting: "features landed (orchestration state); scenario authoring pending" },
  { id: "ambiguous-signal", awaiting: "features landed (orchestration state); scenario authoring pending" },
  { id: "two-perspectives-better", awaiting: "features landed (add_agent, composition levers); scenario authoring pending" },
  { id: "reviewer-invalidates-spec", awaiting: "features landed (spec_revisions, sign-off); scenario authoring pending" },
  { id: "restart-honesty", awaiting: "features landed (boot digests); needs restart support in the structural runner" },
  { id: "visual-judgment", awaiting: "live-only by design (rendering cannot be faked); lands with Tier B" },
];
