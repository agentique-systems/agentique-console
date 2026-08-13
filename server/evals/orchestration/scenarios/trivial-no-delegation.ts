/**
 * Case A of the design test: a trivial repo question. The correct
 * orchestration is almost no orchestration — main answers from its own read
 * tools, commissions nobody, asks nothing.
 */
import { initMessage, sendHandoffUse, successMessage, textMessage, toolResultMessage, toolUseMessage } from "../../../src/sdk/fake.ts";
import { noAgentSessions, settledWithinTurns, zeroClarifyingQuestions } from "../checks.ts";
import { defineScenario } from "../scenario.ts";
import { idleTurn, roleSwitch, turns } from "../programs.ts";
import { createSessionUse } from "./shared.ts";

export default defineScenario({
  id: "trivial-no-delegation",
  title: "Trivial repo question needs no crew",
  taskCard: "What port does the console listen on by default? Just tell me.",
  operatorScript: [],
  stressedDimensions: ["marginal-agent-value", "question-economy", "cost-latency"],
  checks: [noAgentSessions(), zeroClarifyingQuestions(), settledWithinTurns(2)],
  fake: {
    doneWhen: () => (event) => event.type === "user_session.turn.settled",
    variants: {
      exemplary: {
        expect: "pass",
        program: () =>
          roleSwitch({
            main: turns(async function* () {
              yield initMessage();
              yield toolUseMessage("read-1", "Grep", { pattern: "CONSOLE_PORT", path: "server/src" });
              yield toolResultMessage("read-1", "config.ts: port: Number(env.CONSOLE_PORT ?? 4400)");
              yield textMessage("4400 by default (CONSOLE_PORT overrides it).");
              yield successMessage();
            }),
          }),
      },
      "commissions-a-crew": {
        expect: "flag",
        flaggedChecks: ["no-agent-sessions"],
        program: () =>
          roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                yield createSessionUse("create-1", {
                  title: "port investigation",
                  agents: [{ name: "scout", profileId: "explorer" }],
                  briefingAction: "Investigate which port the console listens on",
                });
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: {
              coordinator: turns(async function* () {
                yield initMessage();
                yield sendHandoffUse("close-1", "main", { action: "It is port 4400", status: "completed", category: "final" });
                yield successMessage();
              }),
              scout: idleTurn(),
            },
          }),
      },
    },
  },
  live: { maxBudgetUsd: 2, timeoutMin: 10 },
});
