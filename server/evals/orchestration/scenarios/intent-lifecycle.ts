/**
 * The whole intent lifecycle in one trace: a vague, oversized ask → coarse
 * committed top level with the default RECORDED as a linked assumption →
 * scoped elaboration at commissioning, with the ledger unit naming the
 * requirement it discharges → an independent satisfied claim → a discovery
 * that FALSIFIES the premise under that claim → the claim reopened, the
 * statement amended in a scoped card, the work re-verified against the new
 * words. The violations skip the premise (silent default) or shelve the
 * falsification (the claim stands on a dead premise).
 */
import type { FakeProgram } from "../../../src/sdk/fake.ts";
import { initMessage, sendHandoffUse, successMessage, toolUseMessage } from "../../../src/sdk/fake.ts";
import {
  assumptionsRecordedBeforeCommission,
  commissionsReferenceOpenRequirements,
  falsificationsActedOn,
  stagedGrowth,
  statusChangesCarryEvidence,
  tasksNameRequirements,
} from "../checks.ts";
import { roleSwitch, turns } from "../programs.ts";
import { defineScenario, type ProgramCtx } from "../scenario.ts";
import type { Ev } from "../trace.ts";
import { createSessionUse } from "./shared.ts";

const COARSE_DOC = "# Tiny persistent world\n\n## Context\nA small multiplayer world — think a very small WoW. The reference game is gone; its combat model is remembered, not documented.\n\n## Requirements\n- Combat works\n- The world persists across restarts";
const COMBAT_SCOPED = "## Requirements\n- Hits resolve against armor";
const COMBAT_AMENDED = "## Requirements\n- r3: Hits resolve against armor in deterministic turn order";
const EVIDENCE = [{ kind: "command", ref: "node --test", label: "combat suite green" }];

const coordinatorRoute = turns(
  async function* () {
    yield initMessage();
    yield sendHandoffUse("assign-1", "builder", { action: "Implement combat per the delegated requirements", status: "pending", category: "assignment" });
    yield successMessage();
  },
  async function* () {
    yield initMessage();
    yield sendHandoffUse("final-1", "main", { action: "Combat implemented real-time; NOTE: the reference game was turn-based", status: "completed", category: "final" });
    yield successMessage();
  },
);

const builderRoute = turns(async function* () {
  yield initMessage();
  yield sendHandoffUse("b-1", "coordinator", { action: "Combat done; found footage — the reference game is TURN-BASED", status: "completed", category: "milestone" });
  yield successMessage();
});

function mainRoute(
  ctx: ProgramCtx,
  opts: { recordPremise: boolean; answerFalsification: boolean },
): FakeProgram {
  let created = false;
  let reported = false;
  // The post-commission premise is "a2" when a1 was recorded first, else "a1".
  const latePremiseId = opts.recordPremise ? "a2" : "a1";
  return async function* () {
    yield initMessage();
    if (!created) {
      created = true;
      yield toolUseMessage("req-1", "mcp__console__propose_requirements", { document: COARSE_DOC, changeNote: "coarse top level" });
      if (opts.recordPremise) {
        yield toolUseMessage("asm-1", "mcp__console__record_assumption", {
          text: "\"Combat works\" like the reference means REAL-TIME combat",
          requirementIds: ["r1"],
        });
      }
      yield toolUseMessage("req-2", "mcp__console__propose_requirements", { document: COMBAT_SCOPED, changeNote: "combat elaborated at commissioning", scopeId: "r1" });
      yield toolUseMessage("link-1", "mcp__console__link_requirements", { fromId: "r2", kind: "depends_on", toId: "r1", note: "persistence snapshots combat state" });
      yield createSessionUse("create-1", {
        title: "combat",
        agents: [{ name: "builder", profileId: "implementer", owns: ["src/"] }],
        briefingAction: "Implement combat per the delegated requirements",
        requirements: ["r1"],
        tasks: [{ taskId: "impl", subject: "Implement hit resolution", owner: "builder", requirementId: "r3" }],
      });
      yield successMessage();
      return;
    }
    const finalArrived = (ctx.harness().sqlite
      .prepare("SELECT count(*) AS n FROM handoff_records WHERE recipient = 'main' AND core LIKE '%Combat implemented%'")
      .get() as { n: number }).n > 0;
    if (finalArrived && !reported) {
      reported = true;
      yield toolUseMessage("rep-1", "mcp__console__report_requirement", { requirementId: "r3", status: "satisfied", evidence: EVIDENCE, verifiedBy: "independent" });
      // The discovery: the remembered combat model was wrong.
      yield toolUseMessage("asm-2", "mcp__console__record_assumption", {
        text: "The reference game's combat was real-time", requirementIds: ["r3"],
      });
      yield toolUseMessage("asm-3", "mcp__console__resolve_assumption", {
        assumptionId: latePremiseId, outcome: "falsified",
        evidence: [{ kind: "journal", ref: "handoff_builder", label: "builder found footage" }],
      });
      if (opts.answerFalsification) {
        // Answer the wake: reopen the suspect claim, amend the words it was
        // verified against, and re-verify against the NEW words.
        yield toolUseMessage("rep-2", "mcp__console__report_requirement", { requirementId: "r3", status: "open", evidence: [], verifiedBy: "self", note: "premise falsified — combat model re-decided" });
        yield toolUseMessage("req-3", "mcp__console__propose_requirements", { document: COMBAT_AMENDED, changeNote: "combat is turn-based like the reference", scopeId: "r1" });
        yield toolUseMessage("rep-3", "mcp__console__report_requirement", { requirementId: "r3", status: "satisfied", evidence: EVIDENCE, verifiedBy: "independent" });
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

const r3SatisfiedTwice = () => {
  let count = 0;
  return (event: Ev): boolean => {
    if (event.type === "requirement.status.changed"
      && (event.payload as { requirementId?: string; to?: string }).requirementId === "r3"
      && (event.payload as { to?: string }).to === "satisfied") count += 1;
    return count >= 2;
  };
};
const premiseFalsified = () => (event: Ev): boolean =>
  event.type === "assumption.resolved"
  && (event.payload as { outcome?: string }).outcome === "falsified";

export default defineScenario({
  id: "intent-lifecycle",
  title: "Vague intent → recorded premises → staged commitment → discovery → amendment → re-verification",
  taskCard: "Build a tiny persistent multiplayer world like our old reference game — combat and persistence first. The reference game no longer exists; nobody fully remembers how its combat worked.",
  operatorScript: [
    { onProposal: "approve", kind: "spec" },
    { onProposal: "approve", kind: "spec" },
    { onProposal: "approve", kind: "spec" },
  ],
  stressedDimensions: ["intent-development", "spec-quality", "adaptation", "delegation"],
  checks: [
    assumptionsRecordedBeforeCommission(),
    stagedGrowth(),
    commissionsReferenceOpenRequirements(),
    tasksNameRequirements(),
    statusChangesCarryEvidence({ requireIndependentSatisfied: true }),
    falsificationsActedOn(),
  ],
  fake: {
    timeoutMs: 25_000,
    variants: {
      exemplary: {
        expect: "pass",
        doneWhen: r3SatisfiedTwice,
        program: variantProgram({ recordPremise: true, answerFalsification: true }),
      },
      "skip-assumptions": {
        expect: "flag",
        flaggedChecks: ["assumptions-recorded-before-commission"],
        doneWhen: r3SatisfiedTwice,
        program: variantProgram({ recordPremise: false, answerFalsification: true }),
      },
      "never-amend": {
        expect: "flag",
        flaggedChecks: ["falsifications-acted-on"],
        doneWhen: premiseFalsified,
        program: variantProgram({ recordPremise: true, answerFalsification: false }),
      },
    },
  },
  live: { fixture: "small-cli", maxBudgetUsd: 12, timeoutMin: 45,
    validator: { command: "node --test" },
    evidence: { globs: ["src/*.js"] } },
});
