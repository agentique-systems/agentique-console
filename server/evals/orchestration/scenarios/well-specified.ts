/**
 * The inverse of vague-greenfield: a fully specified task earns ZERO
 * clarifying questions and one lean session. Question economy is a skill.
 */
import { initMessage, permissionContext, sendHandoffUse, successMessage, textMessage } from "../../../src/sdk/fake.ts";
import { sessionCountAtMost, zeroClarifyingQuestions } from "../checks.ts";
import { idleTurn, roleSwitch, turns } from "../programs.ts";
import { defineScenario } from "../scenario.ts";
import { createSessionUse } from "./shared.ts";

const agentRoutes = {
  coordinator: turns(
    async function* () {
      yield initMessage();
      yield sendHandoffUse("assign-1", "dev", { action: "Add the --version flag exactly as specified", status: "pending", category: "assignment" });
      yield successMessage();
    },
    async function* () {
      yield initMessage();
      yield sendHandoffUse("final-1", "main", { action: "--version flag added; prints package.json version, exits 0", status: "completed", category: "final" });
      yield successMessage();
    },
  ),
  dev: turns(async function* () {
    yield initMessage();
    yield sendHandoffUse("done-1", "coordinator", { action: "Flag implemented and verified against the acceptance line", status: "completed", category: "milestone" });
    yield successMessage();
  }),
};

export default defineScenario({
  id: "well-specified",
  title: "A fully specified task earns zero questions",
  taskCard:
    "Add a --json flag to the list command in src/cli.js. It must print the entries as a JSON array and exit 0. " +
    "No other output, no other changes. Acceptance: `node src/cli.js list --json` prints valid JSON alone.",
  operatorScript: [
    // Only the violation variant ever asks; answering keeps its flow moving so
    // the flagged check is question COUNT, not a timeout.
    { onQuestionMatching: /which file|what version|exit code/i, answer: { "Which file is the CLI entry?": ["src/cli.js"] } },
  ],
  stressedDimensions: ["question-economy", "marginal-agent-value", "operator-alignment"],
  checks: [zeroClarifyingQuestions(), sessionCountAtMost(1)],
  fake: {
    variants: {
      exemplary: {
        expect: "pass",
        program: () =>
          roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                yield createSessionUse("create-1", {
                  title: "--version flag",
                  agents: [{ name: "dev", profileId: "implementer", owns: ["src/"] }],
                  briefingAction: "Add --version exactly per the operator's acceptance line",
                });
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: agentRoutes,
          }),
      },
      "asks-redundant-questions": {
        expect: "flag",
        flaggedChecks: ["zero-clarifying-questions"],
        program: () =>
          roleSwitch({
            main: turns(
              async function* (options) {
                yield initMessage();
                await options.canUseTool?.(
                  "AskUserQuestion",
                  {
                    questions: [
                      { question: "Which file is the CLI entry?", options: [{ label: "src/cli.js" }, { label: "src/index.js" }] },
                    ],
                  },
                  permissionContext(),
                );
                yield createSessionUse("create-1", {
                  title: "--version flag",
                  agents: [{ name: "dev", profileId: "implementer", owns: ["src/"] }],
                  briefingAction: "Add --version",
                });
                yield textMessage("Asked to be safe.");
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: agentRoutes,
          }),
      },
    },
  },
  live: { fixture: "small-cli", maxBudgetUsd: 5, timeoutMin: 20, defaultRuns: 2,
    validator: { command: "node --test && node src/cli.js list --json" },
    evidence: { globs: ["src/cli.js"] } },
});
