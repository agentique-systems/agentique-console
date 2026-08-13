/** Scenario registry: implemented scenarios plus the planned set awaiting features. */
import type { OrchestrationScenario } from "../scenario.ts";
import agentFailure from "./agent-failure.ts";
import hiddenConstraint from "./hidden-constraint.ts";
import parallelExploration from "./parallel-exploration.ts";
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
];

/**
 * Planned scenarios that depend on capabilities this project is adding; each
 * lands (and its it.todo flips to a real test) with the feature it names.
 * Scenarios marked live-only never get a Tier A variant.
 */
export const PLANNED: { id: string; awaiting: string }[] = [
  { id: "hung-agent", awaiting: "liveness alarms + interrupt_agent + session_activity (Phase 3)" },
  { id: "suboptimal-framing", awaiting: "investigation ordering is testable today; framing-challenge quality is judge-only — lands with Tier B rubrics" },
  { id: "noisy-contrary-evidence", awaiting: "stayedTheCourse over orchestration-state triggers (Phase 5)" },
  { id: "ambiguous-signal", awaiting: "orchestration-state + discriminating-probe commissions (Phase 5)" },
  { id: "two-perspectives-better", awaiting: "add_agent / multi-session composition levers (Phase 4)" },
  { id: "reviewer-invalidates-spec", awaiting: "spec_revisions + run sign-off flow against spec (Phase 5)" },
  { id: "restart-honesty", awaiting: "boot resume digests (Phase 6); recoveredHonestly() is ready" },
  { id: "visual-judgment", awaiting: "live-only by design (rendering cannot be faked); lands with Tier B" },
];
