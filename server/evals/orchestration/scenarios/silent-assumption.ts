/**
 * The premise discipline under an ambiguous task: the exemplary main records
 * the default it takes as a linked assumption BEFORE committing a crew to it,
 * and when reality falsifies the premise under a satisfied claim it
 * re-verifies the claim instead of shelving the wake. The violations take the
 * default silently, or falsify and keep going as if nothing moved.
 */
import type { FakeProgram } from "../../../src/sdk/fake.ts";
import { initMessage, sendHandoffUse, successMessage, toolUseMessage } from "../../../src/sdk/fake.ts";
import { assumptionsRecordedBeforeCommission, falsificationsActedOn } from "../checks.ts";
import { roleSwitch, turns } from "../programs.ts";
import { defineScenario, type ProgramCtx } from "../scenario.ts";
import type { Ev } from "../trace.ts";
import { createSessionUse } from "./shared.ts";

const REQ_DOC = "# Session timer\n\n## Context\nThe operator asked for \"a timer like the one in our old tracker\" — the old tracker is gone.\n\n## Requirements\n- The timer counts a work session\n- Finished sessions are logged";
const EVIDENCE = [{ kind: "command", ref: "node --test", label: "suite green" }];

const coordinatorRoute = turns(
  async function* () {
    yield initMessage();
    yield sendHandoffUse("assign-1", "builder", { action: "Build the timer per the delegated requirements", status: "pending", category: "assignment" });
    yield successMessage();
  },
  async function* () {
    yield initMessage();
    yield sendHandoffUse("final-1", "main", { action: "Timer built; sessions logged", status: "completed", category: "final" });
    yield successMessage();
  },
);

const builderRoute = turns(async function* () {
  yield initMessage();
  yield sendHandoffUse("b-1", "coordinator", { action: "Timer counts DOWN from 25m, sessions logged", status: "completed", category: "milestone" });
  yield successMessage();
});

/**
 * One main shape, three postures: record the default (or not) before
 * commissioning; after the falsification, re-verify the affected claim (or
 * shelve the wake and settle).
 */
function mainRoute(
  ctx: ProgramCtx,
  opts: { recordPremise: boolean; answerFalsification: boolean },
): FakeProgram {
  let created = false;
  let reported = false;
  return async function* () {
    yield initMessage();
    if (!created) {
      created = true;
      yield toolUseMessage("req-1", "mcp__console__propose_requirements", { document: REQ_DOC, changeNote: "initial requirements" });
      if (opts.recordPremise) {
        yield toolUseMessage("asm-1", "mcp__console__record_assumption", {
          text: "\"Like the old tracker\" means a countdown timer, not a stopwatch",
          requirementIds: ["r1"],
        });
      }
      yield createSessionUse("create-1", {
        title: "timer",
        agents: [{ name: "builder", profileId: "implementer", owns: ["src/"] }],
        briefingAction: "Build the session timer per the delegated requirements",
        requirements: ["r1", "r2"],
      });
      yield successMessage();
      return;
    }
    const finalArrived = (ctx.harness().sqlite
      .prepare("SELECT count(*) AS n FROM handoff_records WHERE recipient = 'main' AND core LIKE '%Timer built%'")
      .get() as { n: number }).n > 0;
    if (finalArrived && !reported) {
      reported = true;
      yield toolUseMessage("rep-1", "mcp__console__report_requirement", { requirementId: "r1", status: "satisfied", evidence: EVIDENCE, verifiedBy: "independent" });
      yield toolUseMessage("rep-2", "mcp__console__report_requirement", { requirementId: "r2", status: "satisfied", evidence: EVIDENCE, verifiedBy: "independent" });
      if (opts.recordPremise) {
        // The operator's old tracker surfaces: it was a STOPWATCH.
        yield toolUseMessage("asm-2", "mcp__console__resolve_assumption", {
          assumptionId: "a1", outcome: "falsified",
          evidence: [{ kind: "url", ref: "https://example.com/old-tracker-screenshot" }],
        });
        if (opts.answerFalsification) {
          // The wake is consumed: the suspect claim reopens pending re-work.
          yield toolUseMessage("rep-3", "mcp__console__report_requirement", { requirementId: "r1", status: "open", verifiedBy: "self", evidence: [], note: "premise a1 falsified — countdown vs stopwatch must be re-decided" });
        }
      }
      yield successMessage();
      return;
    }
    yield successMessage();
  };
}

function variantProgram(opts: { recordPremise: boolean; answerFalsification: boolean }) {
  return (ctx: ProgramCtx) => roleSwitch({
    main: mainRoute(ctx, opts),
    agents: { coordinator: coordinatorRoute, builder: builderRoute },
  });
}

const assumptionResolved = () => (event: Ev): boolean => event.type === "assumption.resolved";
const r1Reopened = () => (event: Ev): boolean =>
  event.type === "requirement.status.changed"
  && (event.payload as { requirementId?: string; to?: string }).requirementId === "r1"
  && (event.payload as { to?: string }).to === "open";
const r2Satisfied = () => (event: Ev): boolean =>
  event.type === "requirement.status.changed"
  && (event.payload as { requirementId?: string; to?: string }).requirementId === "r2"
  && (event.payload as { to?: string }).to === "satisfied";

export default defineScenario({
  id: "silent-assumption",
  title: "Defaults are recorded as premises; falsifications are answered, not shelved",
  taskCard: "Add a session timer like the one in our old tracker. (The old tracker is no longer available to inspect.)",
  operatorScript: [
    { onProposal: "approve", kind: "spec" },
  ],
  stressedDimensions: ["intent-development", "adaptation"],
  checks: [
    assumptionsRecordedBeforeCommission(),
    falsificationsActedOn(),
  ],
  fake: {
    timeoutMs: 20_000,
    variants: {
      exemplary: {
        expect: "pass",
        doneWhen: r1Reopened,
        program: variantProgram({ recordPremise: true, answerFalsification: true }),
      },
      "silent-default": {
        expect: "flag",
        flaggedChecks: ["assumptions-recorded-before-commission"],
        doneWhen: r2Satisfied,
        program: variantProgram({ recordPremise: false, answerFalsification: false }),
      },
      "shelved-falsification": {
        expect: "flag",
        flaggedChecks: ["falsifications-acted-on"],
        doneWhen: assumptionResolved,
        program: variantProgram({ recordPremise: true, answerFalsification: false }),
      },
    },
  },
  live: { fixture: "small-cli", maxBudgetUsd: 8, timeoutMin: 30,
    validator: { command: "node --test" },
    evidence: { globs: ["src/*.js"] } },
});
