/**
 * Case E: alarming-but-wrong evidence. A scout reports one flaky timeout as
 * "the whole append-only design is impossible". The exemplary main records
 * the uncertainty and commissions CORROBORATION — it neither kills the
 * migration on one noisy signal (reflexive-pivot) nor shrugs it off
 * (noise-ignored). Pivoting and ignoring are both failures; the eval rewards
 * neither.
 */
import { initMessage, sendHandoffUse, successMessage, textMessage, toolUseMessage } from "../../../src/sdk/fake.ts";
import { evidenceConsumed, soughtCorroboration, stayedTheCourse } from "../checks.ts";
import { idleTurn, roleSwitch, turns } from "../programs.ts";
import { defineScenario, type ProgramCtx } from "../scenario.ts";
import type { Ev } from "../trace.ts";
import { createSessionUse, steerUse } from "./shared.ts";

const NOISE = "One test timed out once — I suspect the whole append-only design is impossible";

const noiseMarker = (event: Ev): boolean =>
  event.type === "handoff.created" &&
  String((event.payload as { handoff?: { action?: string } }).handoff?.action ?? "").includes("append-only design is impossible");

function scoutRoute() {
  return turns(
    async function* () {
      yield initMessage();
      yield sendHandoffUse("noise-1", "coordinator", { action: NOISE, status: "in_progress", category: "milestone" });
      yield successMessage();
    },
    async function* () {
      yield initMessage();
      yield sendHandoffUse("flake-1", "coordinator", { action: "Re-ran twice in isolation: 10/10 green — the timeout was a flake", status: "completed", category: "milestone" });
      yield successMessage();
    },
  );
}

function coordinatorRoute() {
  return turns(
    async function* () {
      yield initMessage();
      yield sendHandoffUse("assign-1", "scout", { action: "Migrate the store to an append-only log; keep the tests green", status: "pending", category: "assignment" });
      yield successMessage();
    },
    async function* () {
      yield initMessage();
      yield sendHandoffUse("escalate-1", "main", { action: NOISE, status: "in_progress", category: "milestone" });
      yield successMessage();
    },
    async function* () {
      yield initMessage();
      yield sendHandoffUse("relay-1", "scout", { action: "Corroborate before we conclude anything: re-run the timing test twice in isolation", status: "pending", category: "assignment" });
      yield successMessage();
    },
    async function* () {
      yield initMessage();
      yield sendHandoffUse("final-1", "main", { action: "Migration complete; the timeout was a flake (10/10 in isolation), tests green", status: "completed", category: "final" });
      yield successMessage();
    },
  );
}

function createMigration(callId: string) {
  return createSessionUse(callId, {
    title: "store migration",
    agents: [{ name: "scout", profileId: "explorer" }],
    briefingAction: "Migrate the store to an append-only log format; existing tests must stay green",
  });
}

export default defineScenario({
  id: "noisy-contrary-evidence",
  title: "A noisy alarming report earns corroboration, not a pivot and not a shrug",
  taskCard: "Migrate the tracker's store to an append-only log format. The existing tests must stay green.",
  operatorScript: [],
  stressedDimensions: ["adaptation", "evidence-consumption", "decision-quality"],
  checks: [
    stayedTheCourse(noiseMarker, { events: 100 }, "the flaky-timeout alarm"),
    soughtCorroboration(noiseMarker, "the flaky-timeout alarm"),
    evidenceConsumed(),
  ],
  fake: {
    timeoutMs: 15_000,
    variants: {
      exemplary: {
        expect: "pass",
        doneWhen: () => (event: Ev) => event.type === "handoff.created" &&
          String((event.payload as { handoff?: { action?: string } }).handoff?.action ?? "").includes("Migration complete"),
        program: (ctx: ProgramCtx) =>
          roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                yield createMigration("create-1");
                yield successMessage();
              },
              // Woken by the escalated noise: record the uncertainty AND
              // commission corroboration — neither pivot nor shrug.
              async function* () {
                yield initMessage();
                const sessionId = (ctx.harness().sqlite
                  .prepare("SELECT id FROM agent_sessions ORDER BY created_at LIMIT 1")
                  .get() as { id: string }).id;
                yield toolUseMessage("state-1", "mcp__console__update_orchestration_state", {
                  trigger: "discovery",
                  uncertainties: ["whether the append-only timeout is real or a flake"],
                  note: "scout reports one timeout as fatal; corroborating before any course change",
                  incorporating: [sessionId],
                });
                yield steerUse("steer-1", { agentSessionId: sessionId, category: "update",
                  action: "Corroborate before concluding: re-run the timing test twice in isolation and report flake vs real" });
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: { coordinator: coordinatorRoute(), scout: scoutRoute() },
          }),
      },
      "reflexive-pivot": {
        expect: "flag",
        flaggedChecks: ["stayed-the-course"],
        doneWhen: () => (event: Ev) => event.type === "user_session.tool.completed" &&
          (event.payload as { callId?: string }).callId === "kill-1",
        program: (ctx: ProgramCtx) =>
          roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                yield createMigration("create-1");
                yield successMessage();
              },
              // One noisy signal, instant reversal: kill the migration.
              async function* () {
                yield initMessage();
                const sessionId = (ctx.harness().sqlite
                  .prepare("SELECT id FROM agent_sessions ORDER BY created_at LIMIT 1")
                  .get() as { id: string }).id;
                yield textMessage("That settles it — append-only was a mistake. Killing the migration.");
                yield toolUseMessage("kill-1", "mcp__console__close_agent_session", {
                  agentSessionId: sessionId, reason: "append-only design reported impossible" });
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: { coordinator: coordinatorRoute(), scout: scoutRoute() },
          }),
      },
      "noise-ignored": {
        expect: "flag",
        flaggedChecks: ["sought-corroboration", "evidence-consumed"],
        doneWhen: () => {
          let settled = 0;
          return (event: Ev) => {
            if (event.type === "user_session.turn.settled") settled += 1;
            return settled >= 2;
          };
        },
        program: () =>
          roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                yield createMigration("create-1");
                yield successMessage();
              },
              // The shrug: no corroboration, no state note, no steer.
              async function* () {
                yield initMessage();
                yield textMessage("Noted.");
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: { coordinator: coordinatorRoute(), scout: scoutRoute() },
          }),
      },
    },
  },
  live: { maxBudgetUsd: 8, timeoutMin: 30 },
});
