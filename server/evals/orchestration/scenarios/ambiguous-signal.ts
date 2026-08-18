/**
 * Two credible investigations disagree. The exemplary main commissions a
 * DISCRIMINATING probe — the move that decides between the reports — then
 * consumes its answer; the violation coin-flips to the convenient report and
 * declares done. Adjudicating a factual conflict is not the operator's job,
 * so question economy stays tight.
 */
import type { FakeProgram } from "../../../src/sdk/fake.ts";
import { initMessage, sendHandoffUse, successMessage, textMessage, toolUseMessage } from "../../../src/sdk/fake.ts";
import { evidenceConsumed, questionCountAtMost, soughtCorroboration } from "../checks.ts";
import { idleTurn, roleSwitch, turns } from "../programs.ts";
import { agentRoleOf } from "../../../src/test-helpers.ts";
import { defineScenario, type ProgramCtx } from "../scenario.ts";
import type { Ev } from "../trace.ts";
import { createSessionUse, steerUse } from "./shared.ts";

const CONFLICT = "Conflict: scout-a says finish works (5/5 clean); scout-b says it is broken (entry stays open)";

const conflictMarker = (event: Ev): boolean =>
  event.type === "handoff.created" &&
  String((event.payload as { handoff?: { action?: string } }).handoff?.action ?? "").includes("Conflict: scout-a says");

/**
 * Content-driven coordinator, shared by BOTH sessions' coordinators and
 * discriminated by roster: the verification coordinator assigns both scouts,
 * escalates once both reported, and finals on main's resolution; the probe
 * coordinator assigns the prober and relays its answer to main.
 */
function coordinatorRoute(ctx: ProgramCtx): FakeProgram {
  let verifyAssigned = false;
  let escalated = false;
  const probe = turns(
    async function* () {
      yield initMessage();
      yield sendHandoffUse("p-assign", "prober", { action: "Rerun scout-b's exact reproduction against a fresh data file", status: "pending", category: "assignment" });
      yield successMessage();
    },
    async function* () {
      yield initMessage();
      yield sendHandoffUse("p-final", "main", { action: "Probe result: scout-b ran against a stale data file — finish works on the current format", status: "completed", category: "final" });
      yield successMessage();
    },
  );
  return async function* (options, tools) {
    const sessionId = agentRoleOf(options).agentSessionId;
    const isProbe = sessionId !== undefined && (ctx.harness().sqlite
      .prepare("SELECT count(*) AS n FROM agents WHERE agent_session_id = ? AND name = 'prober'")
      .get(sessionId) as { n: number }).n > 0;
    if (isProbe) {
      yield* probe(options, tools);
      return;
    }
    yield initMessage();
    if (!verifyAssigned) {
      verifyAssigned = true;
      yield sendHandoffUse("assign-a", "scout-a", { action: "Reproduce: does finish correctly update entries? Run it clean five times", status: "pending", category: "assignment" });
      yield sendHandoffUse("assign-b", "scout-b", { action: "Audit the finish code path independently", status: "pending", category: "assignment" });
      yield successMessage();
      return;
    }
    const resolved = sessionId !== undefined && (ctx.harness().sqlite
      .prepare("SELECT count(*) AS n FROM handoff_records WHERE agent_session_id = ? AND sender = 'main' AND core LIKE '%stale data%'")
      .get(sessionId) as { n: number }).n > 0;
    if (resolved) {
      yield sendHandoffUse("final-1", "main", { action: "Settled: finish works — scout-b's failure came from a stale data file", status: "completed", category: "final" });
      yield successMessage();
      return;
    }
    const reports = sessionId === undefined ? 0 : (ctx.harness().sqlite
      .prepare("SELECT count(*) AS n FROM handoff_records WHERE agent_session_id = ? AND sender IN ('scout-a','scout-b') AND recipient = 'coordinator'")
      .get(sessionId) as { n: number }).n;
    if (!escalated && reports >= 2) {
      escalated = true;
      yield sendHandoffUse("escalate-1", "main", { action: CONFLICT, status: "in_progress", category: "milestone" });
    }
    yield successMessage();
  };
}

const scoutRoutes = {
  "scout-a": turns(async function* () {
    yield initMessage();
    yield sendHandoffUse("a-1", "coordinator", { action: "finish works: 5/5 clean runs, entry closes every time", status: "completed", category: "milestone" });
    yield successMessage();
  }),
  "scout-b": turns(async function* () {
    yield initMessage();
    yield sendHandoffUse("b-1", "coordinator", { action: "finish is broken: in my run the entry stays open", status: "completed", category: "milestone" });
    yield successMessage();
  }),
};

function createVerification(callId: string) {
  return createSessionUse(callId, {
    title: "finish verification",
    agents: [{ name: "scout-a", profileId: "explorer" }, { name: "scout-b", profileId: "explorer" }],
    briefingAction: "Two prior reports disagree on whether finish updates entries; verify independently",
  });
}

export default defineScenario({
  id: "ambiguous-signal",
  title: "Conflicting evidence earns a discriminating probe, not a coin flip",
  taskCard: "Verify whether the finish command correctly updates entries — two prior reports disagree. Settle it.",
  operatorScript: [],
  stressedDimensions: ["adaptation", "decision-quality", "stopping"],
  checks: [
    soughtCorroboration(conflictMarker, "the conflicting reports"),
    evidenceConsumed(),
    questionCountAtMost(1),
  ],
  fake: {
    timeoutMs: 15_000,
    variants: {
      exemplary: {
        expect: "pass",
        doneWhen: () => (event: Ev) => event.type === "handoff.created" &&
          String((event.payload as { handoff?: { action?: string } }).handoff?.action ?? "").includes("Settled: finish works"),
        program: (ctx: ProgramCtx) => {
          // Content-driven main: wakes may coalesce or duplicate, so each turn
          // decides from the journal — the probe is only consumed once its
          // final actually EXISTS.
          let created = false;
          let probed = false;
          let resolvedSent = false;
          const mainRoute: FakeProgram = async function* () {
            yield initMessage();
            if (!created) {
              created = true;
              yield createVerification("create-1");
              yield successMessage();
              return;
            }
            const sqlite = ctx.harness().sqlite;
            const probeRow = sqlite.prepare("SELECT id FROM agent_sessions WHERE title = 'discriminating probe'").get() as { id: string } | undefined;
            const probeReported = probeRow !== undefined && (sqlite
              .prepare("SELECT count(*) AS n FROM handoff_records WHERE agent_session_id = ? AND recipient = 'main' AND trigger = 'final'")
              .get(probeRow.id) as { n: number }).n > 0;
            if (probeReported && !resolvedSent) {
              resolvedSent = true;
              const verification = sqlite.prepare("SELECT id FROM agent_sessions WHERE title = 'finish verification'").get() as { id: string };
              yield toolUseMessage("state-1", "mcp__console__update_orchestration_state", {
                trigger: "discovery",
                uncertainties: [],
                note: "probe settled the conflict: scout-b ran against a stale data file; finish works",
                incorporating: [probeRow!.id],
              });
              yield steerUse("steer-1", { agentSessionId: verification.id, category: "update",
                action: "Resolved: scout-b's failure came from a stale data file. Wrap up: finish works" });
              yield successMessage();
              return;
            }
            const conflictSeen = (sqlite
              .prepare("SELECT count(*) AS n FROM handoff_records WHERE recipient = 'main' AND core LIKE '%Conflict: scout-a%'")
              .get() as { n: number }).n > 0;
            if (conflictSeen && !probed) {
              probed = true;
              yield createSessionUse("create-probe", {
                title: "discriminating probe",
                agents: [{ name: "prober", profileId: "explorer" }],
                briefingAction: "The reports differ in environment, not logic: rerun scout-b's exact reproduction against a fresh data file",
              });
              yield successMessage();
              return;
            }
            yield successMessage();
          };
          return roleSwitch({
            main: mainRoute,
            agents: {
              coordinator: coordinatorRoute(ctx),
              ...scoutRoutes,
              prober: turns(async function* () {
                yield initMessage();
                yield sendHandoffUse("p-1", "coordinator", { action: "Reproduction complete: with a fresh data file finish works; scout-b's file was stale-format", status: "completed", category: "milestone" });
                yield successMessage();
              }),
            },
          });
        },
      },
      "picks-the-convenient-report": {
        expect: "flag",
        flaggedChecks: ["sought-corroboration", "evidence-consumed"],
        doneWhen: () => (event: Ev) => event.type === "user_session.message.appended" &&
          String((event.payload as { message?: { text?: string } }).message?.text ?? "").includes("going with that"),
        program: (ctx: ProgramCtx) =>
          roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                yield createVerification("create-1");
                yield successMessage();
              },
              // The coin flip: no probe, no discriminating evidence.
              async function* () {
                yield initMessage();
                yield textMessage("scout-a says it works — going with that. Done.");
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: { coordinator: coordinatorRoute(ctx), ...scoutRoutes },
          }),
      },
    },
  },
  live: { fixture: "small-cli", maxBudgetUsd: 8, timeoutMin: 30 },
});
