/**
 * Delegation traceability end to end: an approved requirement revision
 * governs, the commission names the open requirements it serves (the
 * delegated sub-scope is journaled before the session exists), terminal
 * claims carry evidence, and the independent tier exists only where the
 * write-isolated reviewer seat filed the claim itself — the Console derives
 * `verifiedBy` from who stood behind the claim, so main "blessing" its own
 * verdicts can never manufacture independence. The violations commission with
 * no requirement refs (which also forfeits independent verification: an
 * undelegated reviewer cannot report), record every claim from main's own
 * hand on work whose stakes warranted independence, or delegate a requirement
 * that was already satisfied when the session was commissioned.
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

/** Main's own claim — the Console derives it as self-verified. */
function mainReportUse(callId: string, requirementId: string) {
  return toolUseMessage(callId, "mcp__console__report_requirement", {
    requirementId, status: "satisfied", evidence: EVIDENCE,
  });
}

/** The reviewer seat's claim — the Console derives it as independent. */
function checkerReportUse(callId: string, requirementId: string) {
  return toolUseMessage(callId, "mcp__console_agent__report_requirement", {
    requirementId, status: "satisfied", evidence: EVIDENCE,
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

/** The reviewer verifies and — when it can — files the claims itself. */
function checkerRoute(reports: boolean): FakeProgram {
  return turns(async function* () {
    yield initMessage();
    if (reports) {
      yield checkerReportUse("cr-1", "r1");
      yield checkerReportUse("cr-2", "r2");
    }
    yield sendHandoffUse("r-1", "coordinator", { action: "Re-ran the suite: malformed dates rejected, ISO accepted", status: "completed", category: "milestone" });
    yield successMessage();
  });
}

/**
 * One main shape, three postures: commission with/without requirement refs,
 * leave the verdicts to the reviewer seat or record them from main's own
 * hand, optionally pre-satisfy r2 before delegating it.
 */
function mainRoute(
  ctx: ProgramCtx,
  opts: { requirements?: string[]; reporter: "checker" | "main"; preSatisfyR2?: boolean },
): FakeProgram {
  let created = false;
  let reported = false;
  return async function* () {
    yield initMessage();
    if (!created) {
      created = true;
      yield toolUseMessage("req-1", "mcp__console__propose_requirements", { document: REQ_DOC, changeNote: "initial requirements" });
      if (opts.preSatisfyR2 === true) yield mainReportUse("pre-1", "r2");
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
    if (finalArrived && opts.reporter === "main" && !reported) {
      reported = true;
      yield mainReportUse("rep-1", "r1");
      if (opts.preSatisfyR2 !== true) yield mainReportUse("rep-2", "r2");
      yield successMessage();
      return;
    }
    yield successMessage();
  };
}

function variantProgram(
  opts: { requirements?: string[]; reporter: "checker" | "main"; preSatisfyR2?: boolean },
) {
  return (ctx: ProgramCtx) => roleSwitch({
    main: mainRoute(ctx, opts),
    agents: { coordinator: coordinatorRoute, builder: builderRoute, checker: checkerRoute(opts.reporter === "checker") },
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
        program: variantProgram({ requirements: ["r1", "r2"], reporter: "checker" }),
      },
      // No refs → no delegation → the reviewer seat cannot file claims, so the
      // untraced commission ALSO forfeits independent verification. Both
      // checks flag, and that cascade is the point.
      "untraced-commission": {
        expect: "flag",
        flaggedChecks: ["commissions-reference-open-requirements", "status-changes-carry-evidence"],
        doneWhen: () => statusChanged("r2"),
        program: variantProgram({ reporter: "main" }),
      },
      "self-blessed-satisfied": {
        expect: "flag",
        flaggedChecks: ["status-changes-carry-evidence"],
        doneWhen: () => statusChanged("r2"),
        program: variantProgram({ requirements: ["r1", "r2"], reporter: "main" }),
      },
      "delegates-satisfied-requirement": {
        expect: "flag",
        flaggedChecks: ["commissions-reference-open-requirements"],
        doneWhen: () => statusChanged("r1"),
        program: variantProgram({ requirements: ["r1", "r2"], reporter: "checker", preSatisfyR2: true }),
      },
    },
  },
  live: { fixture: "small-cli", maxBudgetUsd: 8, timeoutMin: 30,
    validator: { command: "node --test" },
    evidence: { globs: ["src/*.js"] } },
});
