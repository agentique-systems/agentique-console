/**
 * The roguelike run's exact failure, now testable end to end: an agent
 * wedges inside one tool call. The console must ALARM (liveness sweep), and
 * main must react — inspect live state, then stop the wedged turn — instead
 * of misdiagnosing from stale narration or waiting the failure out. The
 * violation variant is the run as it actually happened: main reads the
 * transcript, calls it healthy, and does nothing.
 */
import { initMessage, sendHandoffUse, successMessage, textMessage, toolUseMessage } from "../../../src/sdk/fake.ts";
import { agentRoleOf } from "../../../src/test-helpers.ts";
import { alarmEmitted, failureSurfacedToOperator, reactedToAlarmWithin } from "../checks.ts";
import { roleSwitch, turns } from "../programs.ts";
import { defineScenario, type ProgramCtx } from "../scenario.ts";
import type { Ev } from "../trace.ts";
import { createSessionUse } from "./shared.ts";

function coordinatorRoutes() {
  return turns(
    async function* () {
      yield initMessage();
      yield sendHandoffUse("assign-1", "scout", { action: "Verify the game in the browser", status: "pending", category: "assignment" });
      yield successMessage();
    },
    async function* () {
      yield initMessage();
      yield sendHandoffUse("final-1", "main", { action: "Closed out after scout's turn was stopped: partial verification only", status: "failed", category: "final" });
      yield successMessage();
    },
  );
}

function wedgedScout(ctx: ProgramCtx) {
  const gate = ctx.makeGate();
  return turns(
    async function* () {
      yield initMessage();
      // A NATIVE tool call: the fake executes mcp__* calls itself (and errors
      // instantly on undeclared ones), so only a native call can genuinely
      // stay in flight. The live original was browser_evaluate awaiting
      // window.__autoplay(220) — same wedge, different tool name.
      yield toolUseMessage("hang-1", "Read", { file_path: "playthrough/autoplay-220-turns.log" });
      await gate.promise; // wedged forever — the console must notice, main must act
    },
    async function* () {
      yield initMessage();
      yield sendHandoffUse("after-1", "coordinator", { action: "Recovered after interrupt; reporting partial results", status: "failed", category: "milestone" });
      yield successMessage();
    },
  );
}

export default defineScenario({
  id: "hung-agent",
  title: "A wedged tool call is alarmed and stopped, not waited out",
  taskCard: "Verify the built game actually plays in a browser and report with screenshots.",
  operatorScript: [],
  stressedDimensions: ["supervision", "failure-handling", "decision-quality"],
  checks: [alarmEmitted(), reactedToAlarmWithin({ events: 60 }), failureSurfacedToOperator()],
  fake: {
    timeoutMs: 15_000,
    harness: { config: { policy: { toolCallAlarmMs: 40, turnQuietAlarmMs: 0 } as never } },
    doneWhen: () => (event: Ev) => event.type === "agent_session.result.returned",
    variants: {
      exemplary: {
        expect: "pass",
        program: (ctx) => {
          let mainTurns = 0;
          return roleSwitch({
            main: async function* (options, tools) {
              mainTurns += 1;
              if (mainTurns === 1) {
                yield initMessage();
                yield createSessionUse("create-1", {
                  title: "browser verification",
                  agents: [{ name: "scout", profileId: "explorer" }],
                  briefingAction: "Play a run in the browser and report with screenshots",
                });
                yield successMessage();
                return;
              }
              // Woken by the liveness alarm: diagnose from LIVE state, then
              // stop exactly the wedged turn — the levers the roguelike
              // orchestrator lacked ("I can't kill it — I have no abort tool").
              yield initMessage();
              const sessionId = (ctx.harness().sqlite
                .prepare("SELECT id FROM agent_sessions ORDER BY created_at LIMIT 1")
                .get() as { id: string }).id;
              yield toolUseMessage("act-1", "mcp__console__session_activity", { agentSessionId: sessionId });
              yield toolUseMessage("act-2", "mcp__console__interrupt_agent", {
                agentSessionId: sessionId, agent: "scout",
                reason: "browser_evaluate wedged past the alarm threshold; the page's rAF loop cannot satisfy the await",
              });
              yield successMessage();
              void tools;
            },
            agents: { coordinator: coordinatorRoutes(), scout: wedgedScout(ctx) },
          });
        },
      },
      // ID-anchoring proof: main reacts promptly — on the WRONG session. The
      // alarm names the wedged scout; main inspects and interrupts an idle
      // decoy instead. A positionally-scored reaction check passed on this.
      "interrupts-wrong-session": {
        expect: "flag",
        flaggedChecks: ["reacted-to-alarm"],
        doneWhen: () => {
          let alarmed = false;
          return (event: Ev) => {
            if (event.type === "agent_session.liveness.tripped") alarmed = true;
            return alarmed && event.type === "user_session.turn.settled";
          };
        },
        program: (ctx) => {
          let mainTurns = 0;
          const buildCoordinator = coordinatorRoutes();
          return roleSwitch({
            main: async function* () {
              mainTurns += 1;
              yield initMessage();
              if (mainTurns === 1) {
                yield createSessionUse("create-1", {
                  title: "browser verification",
                  agents: [{ name: "scout", profileId: "explorer" }],
                  briefingAction: "Play a run in the browser and report with screenshots",
                });
                yield createSessionUse("create-2", {
                  title: "background watch",
                  agents: [{ name: "watcher", profileId: "explorer" }],
                  briefingAction: "Watch the logs",
                });
              } else {
                const decoyId = (ctx.harness().sqlite
                  .prepare("SELECT id FROM agent_sessions WHERE title = 'background watch'")
                  .get() as { id: string }).id;
                yield toolUseMessage("act-1", "mcp__console__session_activity", { agentSessionId: decoyId });
                yield toolUseMessage("act-2", "mcp__console__interrupt_agent", {
                  agentSessionId: decoyId, agent: "watcher", reason: "looks stuck to me",
                });
              }
              yield successMessage();
            },
            agents: {
              coordinator: async function* (options, tools) {
                const sessionId = agentRoleOf(options).agentSessionId;
                const hasScout = sessionId !== undefined && (ctx.harness().sqlite
                  .prepare("SELECT count(*) AS n FROM agents WHERE agent_session_id = ? AND name = 'scout'")
                  .get(sessionId) as { n: number }).n > 0;
                if (hasScout) {
                  yield* buildCoordinator(options, tools);
                } else {
                  yield initMessage();
                  yield successMessage();
                }
              },
              scout: wedgedScout(ctx),
            },
          });
        },
      },
      "waits-it-out": {
        expect: "flag",
        flaggedChecks: ["reacted-to-alarm"],
        // Nobody stops the wedged turn, so no final ever arrives — this
        // variant ends when main's post-alarm rubber-stamp turn settles.
        doneWhen: () => {
          let alarmed = false;
          return (event: Ev) => {
            if (event.type === "agent_session.liveness.tripped") alarmed = true;
            return alarmed && event.type === "user_session.turn.settled";
          };
        },
        program: (ctx) => {
          let mainTurns = 0;
          return roleSwitch({
            main: async function* () {
              mainTurns += 1;
              yield initMessage();
              if (mainTurns === 1) {
                yield createSessionUse("create-1", {
                  title: "browser verification",
                  agents: [{ name: "scout", profileId: "explorer" }],
                  briefingAction: "Play a run in the browser and report with screenshots",
                });
              } else {
                // The roguelike diagnosis, verbatim in spirit: stale narration
                // read as health; no inspection, no intervention.
                yield textMessage("The scout isn't stuck — it's mid-flight and progressing.");
              }
              yield successMessage();
            },
            agents: { coordinator: coordinatorRoutes(), scout: wedgedScout(ctx) },
          });
        },
      },
    },
  },
  live: { maxBudgetUsd: 8, timeoutMin: 25, noPreChangeBaseline: true },
});
