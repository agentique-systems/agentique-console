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
  taskCard: "Where does the tracker store its data by default? Just tell me.",
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
              yield toolUseMessage("read-1", "Grep", { pattern: "DATA_FILE", path: "src" });
              yield toolResultMessage("read-1", 'store.js: export const DATA_FILE = process.env.READING_TRACKER_FILE ?? ".reading-tracker.json";');
              yield textMessage(".reading-tracker.json in the working directory (READING_TRACKER_FILE overrides it).");
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
  live: { fixture: "small-cli", maxBudgetUsd: 2, timeoutMin: 10, defaultRuns: 3 },
});
