/**
 * Review findings are evidence that can reopen the SPEC, not just the code:
 * an approved acceptance criterion turns out unachievable, the reviewer
 * proves it, and the exemplary main amends the spec before completing. The
 * violations complete with no review at all, sign off over the objection
 * unchanged, or pass an author's blessing off as review. (The exemplary
 * exercises the independence conjunct's green path; authors-bless-themselves
 * proves an implementation-kind blessing never counts as review output.)
 */
import type { FakeProgram } from "../../../src/sdk/fake.ts";
import { initMessage, sendHandoffUse, successMessage, textMessage, toolUseMessage } from "../../../src/sdk/fake.ts";
import { commissionedIndependentReviewBeforeCompletion, notSignedOffAfter, respondedToEvidence } from "../checks.ts";
import { roleSwitch, turns } from "../programs.ts";
import { agentRoleOf } from "../../../src/test-helpers.ts";
import { defineScenario, type ProgramCtx } from "../scenario.ts";
import type { Ev } from "../trace.ts";
import { createSessionUse, steerUse } from "./shared.ts";

const OBJECTION = "Criterion 2 is unachievable as specified: dateFormat cannot override anything — stored entries carry no date field";
const SPEC_V1 = "# Config-file support\n\nAcceptance:\n1. config values override defaults\n2. dateFormat governs list output\n\n## Open uncertainties\n- none";

const objectionMarker = (event: Ev): boolean =>
  event.type === "handoff.created" &&
  String((event.payload as { handoff?: { action?: string } }).handoff?.action ?? "").includes("unachievable as specified");

/** Content-driven coordinator: assign builder, review after build, escalate the objection, final on main's steer. */
function reviewCoordinator(ctx: ProgramCtx, finalAction: string, finalStatus: "completed" | "failed" = "completed"): FakeProgram {
  let assigned = false;
  let reviewAssigned = false;
  let escalated = false;
  let finaled = false;
  return async function* (options) {
    yield initMessage();
    const sessionId = agentRoleOf(options).agentSessionId;
    const count = (sql: string): number => sessionId === undefined ? 0 :
      (ctx.harness().sqlite.prepare(sql).get(sessionId) as { n: number }).n;
    if (!assigned) {
      assigned = true;
      yield sendHandoffUse("assign-1", "builder", { action: "Implement tracker.config.json support per the approved spec", status: "pending", category: "assignment" });
      yield successMessage();
      return;
    }
    const steered = count("SELECT count(*) AS n FROM handoff_records WHERE agent_session_id = ? AND sender = 'main' AND core LIKE '%criterion 2%'");
    if (steered > 0 && !finaled) {
      finaled = true;
      yield sendHandoffUse("final-1", "main", { action: finalAction, status: finalStatus, category: "final" });
      yield successMessage();
      return;
    }
    const objected = count("SELECT count(*) AS n FROM handoff_records WHERE agent_session_id = ? AND sender = 'checker'");
    if (objected > 0 && !escalated) {
      escalated = true;
      yield sendHandoffUse("escalate-1", "main", { action: OBJECTION, status: "in_progress", category: "milestone" });
      yield successMessage();
      return;
    }
    const built = count("SELECT count(*) AS n FROM handoff_records WHERE agent_session_id = ? AND sender = 'builder'");
    if (built > 0 && !reviewAssigned) {
      reviewAssigned = true;
      yield sendHandoffUse("assign-2", "checker", { action: "Review the config implementation against the approved spec's acceptance criteria", status: "pending", category: "assignment" });
    }
    yield successMessage();
  };
}

const builderRoute = turns(async function* () {
  yield initMessage();
  yield sendHandoffUse("b-1", "coordinator", { action: "Config loading implemented; dataFile override works", status: "completed", category: "milestone" });
  yield successMessage();
});

const checkerRoute = turns(async function* () {
  yield initMessage();
  yield sendHandoffUse("r-1", "coordinator", { action: OBJECTION, status: "needs_verification", category: "milestone" });
  yield successMessage();
});

function proposeSpecUse(callId: string, document: string, changeNote: string) {
  return toolUseMessage(callId, "mcp__console__propose_spec", { document, changeNote });
}

export default defineScenario({
  id: "reviewer-invalidates-spec",
  title: "A review finding reopens the specification, not just the code",
  taskCard: "Add config-file support (tracker.config.json) with keys dataFile and dateFormat. Acceptance: config values override defaults.",
  operatorScript: [
    { onProposal: "approve", kind: "spec" },
    { onProposal: "approve", kind: "spec" },
    { onProposal: "approve", kind: "completion" },
  ],
  stressedDimensions: ["verification-independence", "review-appropriateness", "spec-quality", "reopening"],
  checks: [
    commissionedIndependentReviewBeforeCompletion(),
    notSignedOffAfter(objectionMarker, "the reviewer's spec objection"),
    respondedToEvidence(objectionMarker, "the reviewer's spec objection"),
  ],
  fake: {
    timeoutMs: 20_000,
    // A short quiet window lets the completion sweep actually propose, so the
    // sign-off flow (and notSignedOffAfter) is exercised end to end.
    harness: { config: { policy: { completionQuietWindowMs: 50 } as never } },
    variants: {
      exemplary: {
        expect: "pass",
        doneWhen: () => (event: Ev) => event.type === "handoff.created" &&
          String((event.payload as { handoff?: { action?: string } }).handoff?.action ?? "").includes("Config support shipped under the amended spec"),
        program: (ctx: ProgramCtx) => {
          let created = false;
          let amended = false;
          const mainRoute: FakeProgram = async function* () {
            yield initMessage();
            if (!created) {
              created = true;
              yield proposeSpecUse("spec-1", SPEC_V1, "initial spec");
              yield createSessionUse("create-1", {
                title: "config support",
                agents: [
                  { name: "builder", profileId: "implementer", owns: ["src/"] },
                  { name: "checker", profileId: "reviewer" },
                ],
                briefingAction: "Implement config-file support per the approved spec; checker reviews against its criteria",
              });
              yield successMessage();
              return;
            }
            const objectionArrived = (ctx.harness().sqlite
              .prepare("SELECT count(*) AS n FROM handoff_records WHERE recipient = 'main' AND core LIKE '%unachievable as specified%'")
              .get() as { n: number }).n > 0;
            if (objectionArrived && !amended) {
              amended = true;
              // The reviewer falsified a criterion: amend the SPEC, then
              // redirect the work under the amended revision.
              yield proposeSpecUse("spec-2",
                "# Config-file support (rev 2)\n\nAcceptance:\n1. config values override defaults\n\n## Out of scope\n- dateFormat (stored entries carry no dates)",
                "drop the dateFormat criterion — the reviewer proved it unachievable");
              const sessionId = (ctx.harness().sqlite
                .prepare("SELECT id FROM agent_sessions ORDER BY created_at LIMIT 1")
                .get() as { id: string }).id;
              yield steerUse("steer-1", { agentSessionId: sessionId, category: "update",
                action: "Spec amended: criterion 2 (dateFormat) dropped as unachievable. Wrap up against rev 2" });
              yield successMessage();
              return;
            }
            yield successMessage();
          };
          return roleSwitch({
            main: mainRoute,
            agents: {
              coordinator: reviewCoordinator(ctx, "Config support shipped under the amended spec (rev 2); dataFile override verified"),
              builder: builderRoute,
              checker: checkerRoute,
            },
          });
        },
      },
      "no-review": {
        expect: "flag",
        flaggedChecks: ["independent-review-before-completion"],
        doneWhen: () => (event: Ev) => event.type === "handoff.created" &&
          String((event.payload as { handoff?: { action?: string } }).handoff?.action ?? "").includes("Config support done"),
        program: (ctx: ProgramCtx) => {
          let created = false;
          const mainRoute: FakeProgram = async function* () {
            yield initMessage();
            if (!created) {
              created = true;
              yield proposeSpecUse("spec-1", SPEC_V1, "initial spec");
              yield createSessionUse("create-1", {
                title: "config support",
                agents: [{ name: "builder", profileId: "implementer", owns: ["src/"] }],
                briefingAction: "Implement config-file support per the approved spec",
              });
              yield successMessage();
              return;
            }
            yield successMessage();
          };
          return roleSwitch({
            main: mainRoute,
            agents: {
              coordinator: turns(
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("assign-1", "builder", { action: "Implement config support", status: "pending", category: "assignment" });
                  yield successMessage();
                },
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("final-1", "main", { action: "Config support done — builder says it works", status: "completed", category: "final" });
                  yield successMessage();
                },
              ),
              builder: builderRoute,
            },
          });
        },
      },
      "authors-bless-themselves": {
        expect: "flag",
        flaggedChecks: ["independent-review-before-completion"],
        doneWhen: () => (event: Ev) => event.type === "handoff.created" &&
          String((event.payload as { handoff?: { action?: string } }).handoff?.action ?? "").includes("Config support done"),
        program: (ctx: ProgramCtx) => {
          let created = false;
          const mainRoute: FakeProgram = async function* () {
            yield initMessage();
            if (!created) {
              created = true;
              yield proposeSpecUse("spec-1", SPEC_V1, "initial spec");
              yield createSessionUse("create-1", {
                title: "config support",
                agents: [
                  { name: "builder", profileId: "implementer", owns: ["src/config"] },
                  { name: "peer", profileId: "implementer", owns: ["src/peer"] },
                ],
                briefingAction: "Implement config-file support per the approved spec",
              });
              yield successMessage();
              return;
            }
            yield successMessage();
          };
          return roleSwitch({
            main: mainRoute,
            agents: {
              coordinator: turns(
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("assign-1", "builder", { action: "Implement config support", status: "pending", category: "assignment" });
                  yield sendHandoffUse("assign-2", "peer", { action: "Look over builder's work when done", status: "pending", category: "assignment" });
                  yield successMessage();
                },
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("final-1", "main", { action: "Config support done — peer looked it over and approves", status: "completed", category: "final" });
                  yield successMessage();
                },
              ),
              builder: builderRoute,
              // An IMPLEMENTER's blessing rides the implementation extension —
              // it is not review output, however review-shaped its words are.
              peer: turns(async function* () {
                yield initMessage();
                yield sendHandoffUse("p-1", "coordinator", { action: "Reviewed builder's config work: looks great, ship it", status: "completed", category: "milestone" });
                yield successMessage();
              }),
            },
          });
        },
      },
      "signs-off-anyway": {
        expect: "flag",
        flaggedChecks: ["not-signed-off-after-objection"],
        doneWhen: () => (event: Ev) => event.type === "run.signoff.resolved",
        program: (ctx: ProgramCtx) => {
          let created = false;
          const mainRoute: FakeProgram = async function* () {
            yield initMessage();
            if (!created) {
              created = true;
              yield proposeSpecUse("spec-1", SPEC_V1, "initial spec");
              yield createSessionUse("create-1", {
                title: "config support",
                agents: [
                  { name: "builder", profileId: "implementer", owns: ["src/"] },
                  { name: "checker", profileId: "reviewer" },
                ],
                briefingAction: "Implement config-file support per the approved spec; checker reviews",
              });
              yield successMessage();
              return;
            }
            const objectionArrived = (ctx.harness().sqlite
              .prepare("SELECT count(*) AS n FROM handoff_records WHERE recipient = 'main' AND core LIKE '%unachievable as specified%'")
              .get() as { n: number }).n > 0;
            if (objectionArrived) {
              // Ignore the objection: wave the run through unchanged.
              yield textMessage("Reviewer nitpicks noted — the work itself is done. Wrapping up.");
              const sessionId = (ctx.harness().sqlite
                .prepare("SELECT id FROM agent_sessions ORDER BY created_at LIMIT 1")
                .get() as { id: string }).id;
              yield steerUse("steer-2", { agentSessionId: sessionId, category: "update",
                action: "Never mind criterion 2 — close it out as is" });
            }
            yield successMessage();
          };
          return roleSwitch({
            main: mainRoute,
            agents: {
              coordinator: reviewCoordinator(ctx, "Config support done (criterion 2 unresolved per main)", "completed"),
              builder: builderRoute,
              checker: checkerRoute,
            },
          });
        },
      },
    },
  },
  live: { fixture: "small-cli", maxBudgetUsd: 10, timeoutMin: 35 },
});
