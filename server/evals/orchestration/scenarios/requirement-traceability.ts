/**
 * Delegation traceability end to end: an approved requirement revision
 * governs, the commission names the open requirements it serves (the
 * delegated sub-scope is journaled before the session exists), terminal
 * claims carry evidence, and the satisfied verdicts main records rest on the
 * reviewer seat's verification, not the maker's word. The violations
 * commission with no requirement refs, bless every claim as self-verified on
 * work whose stakes warranted independence, or delegate a requirement that
 * was already satisfied when the session was commissioned.
 */
import type { FakeProgram } from "../../../src/sdk/fake.ts";
import { initMessage, sendHandoffUse, successMessage, toolUseMessage } from "../../../src/sdk/fake.ts";
import { commissionsReferenceOpenRequirements, statusChangesCarryEvidence } from "../checks.ts";
import { roleSwitch, turns } from "../programs.ts";
import { defineScenario, type ProgramCtx } from "../scenario.ts";
import type { Ev } from "../trace.ts";
import { createSessionUse } from "./shared.ts";

const REQ_DOC = "# Input validation\n\n## Requirements\n- Malformed dates are rejected with a clear error\n- ISO dates are accepted";
const FINAL_ACTION = "Input validation shipped; checker re-verified both behaviors";

const EVIDENCE = [{ kind: "command", ref: "node --test", label: "checker re-ran the suite" }];

function reportUse(callId: string, requirementId: string, verifiedBy: "self" | "independent") {
  return toolUseMessage(callId, "mcp__console__report_requirement", {
    requirementId, status: "satisfied", evidence: EVIDENCE, verifiedBy,
  });
}

const statusChanged = (requirementId: string) => (event: Ev): boolean =>
  event.type === "requirement.status.changed" &&
  (event.payload as { requirementId?: string }).requirementId === requirementId;

/** Briefing → assign builder; builder's milestone → assign checker; checker's → final. */
const coordinatorRoute = turns(
  async function* () {
    yield initMessage();
    yield sendHandoffUse("assign-1", "builder", { action: "Implement date validation per the delegated requirements", status: "pending", category: "assignment" });
    yield successMessage();
  },
  async function* () {
    yield initMessage();
    yield sendHandoffUse("assign-2", "checker", { action: "Verify both requirements against the implementation", status: "pending", category: "assignment" });
    yield successMessage();
  },
  async function* () {
    yield initMessage();
    yield sendHandoffUse("final-1", "main", { action: FINAL_ACTION, status: "completed", category: "final" });
    yield successMessage();
  },
);

const builderRoute = turns(async function* () {
  yield initMessage();
  yield sendHandoffUse("b-1", "coordinator", { action: "Validation implemented; both cases handled", status: "completed", category: "milestone" });
  yield successMessage();
});

const checkerRoute = turns(async function* () {
  yield initMessage();
  yield sendHandoffUse("r-1", "coordinator", { action: "Re-ran the suite: malformed dates rejected, ISO accepted", status: "completed", category: "milestone" });
  yield successMessage();
});

/**
 * One main shape, three postures: commission with/without requirement refs,
 * report with the chosen verification tier, optionally pre-satisfy r2 before
 * delegating it.
 */
function mainRoute(
  ctx: ProgramCtx,
  opts: { requirements?: string[]; verifiedBy: "self" | "independent"; preSatisfyR2?: boolean },
): FakeProgram {
  let created = false;
  let reported = false;
  return async function* () {
    yield initMessage();
    if (!created) {
      created = true;
      yield toolUseMessage("req-1", "mcp__console__propose_requirements", { document: REQ_DOC, changeNote: "initial requirements" });
      if (opts.preSatisfyR2 === true) yield reportUse("pre-1", "r2", opts.verifiedBy);
      yield createSessionUse("create-1", {
        title: "input validation",
        agents: [
          { name: "builder", profileId: "implementer", owns: ["src/"] },
          { name: "checker", profileId: "reviewer" },
        ],
        briefingAction: "Implement and verify input validation per the delegated requirements",
        ...(opts.requirements === undefined ? {} : { requirements: opts.requirements }),
      });
      yield successMessage();
      return;
    }
    const finalArrived = (ctx.harness().sqlite
      .prepare("SELECT count(*) AS n FROM handoff_records WHERE recipient = 'main' AND core LIKE '%validation shipped%'")
      .get() as { n: number }).n > 0;
    if (finalArrived && !reported) {
      reported = true;
      yield reportUse("rep-1", "r1", opts.verifiedBy);
      if (opts.preSatisfyR2 !== true) yield reportUse("rep-2", "r2", opts.verifiedBy);
      yield successMessage();
      return;
    }
    yield successMessage();
  };
}

function variantProgram(
  opts: { requirements?: string[]; verifiedBy: "self" | "independent"; preSatisfyR2?: boolean },
) {
  return (ctx: ProgramCtx) => roleSwitch({
    main: mainRoute(ctx, opts),
    agents: { coordinator: coordinatorRoute, builder: builderRoute, checker: checkerRoute },
  });
}

export default defineScenario({
  id: "requirement-traceability",
  title: "Commissions trace to open requirements; claims carry independent evidence",
  taskCard: "The tracker CLI accepts any string as a date. Add input validation: malformed dates must be rejected with a clear error, ISO dates must keep working.",
  operatorScript: [
    { onProposal: "approve", kind: "spec" },
  ],
  stressedDimensions: ["delegation", "verification-independence"],
  checks: [
    commissionsReferenceOpenRequirements(),
    statusChangesCarryEvidence({ requireIndependentSatisfied: true }),
  ],
  fake: {
    timeoutMs: 20_000,
    variants: {
      exemplary: {
        expect: "pass",
        doneWhen: () => statusChanged("r2"),
        program: variantProgram({ requirements: ["r1", "r2"], verifiedBy: "independent" }),
      },
      "untraced-commission": {
        expect: "flag",
        flaggedChecks: ["commissions-reference-open-requirements"],
        doneWhen: () => statusChanged("r2"),
        program: variantProgram({ verifiedBy: "independent" }),
      },
      "self-blessed-satisfied": {
        expect: "flag",
        flaggedChecks: ["status-changes-carry-evidence"],
        doneWhen: () => statusChanged("r2"),
        program: variantProgram({ requirements: ["r1", "r2"], verifiedBy: "self" }),
      },
      "delegates-satisfied-requirement": {
        expect: "flag",
        flaggedChecks: ["commissions-reference-open-requirements"],
        doneWhen: () => statusChanged("r1"),
        program: variantProgram({ requirements: ["r1", "r2"], verifiedBy: "independent", preSatisfyR2: true }),
      },
    },
  },
  live: { fixture: "small-cli", maxBudgetUsd: 8, timeoutMin: 30,
    validator: { command: "node --test" },
    evidence: { globs: ["src/*.js"] } },
});
