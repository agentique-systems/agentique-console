/**
 * Case B: a vague greenfield ask. Intent must be developed BEFORE building —
 * a clarifying question card precedes the first commissioned session.
 */
import { initMessage, permissionContext, sendHandoffUse, successMessage, textMessage } from "../../../src/sdk/fake.ts";
import { askedBeforeBuilding, questionCountAtMost, sessionCountAtMost } from "../checks.ts";
import { idleTurn, roleSwitch, turns } from "../programs.ts";
import { defineScenario } from "../scenario.ts";
import { createSessionUse } from "./shared.ts";

const agentRoutes = {
  coordinator: turns(
    async function* () {
      yield initMessage();
      yield sendHandoffUse("assign-1", "builder", { action: "Build the tracker CLI", status: "pending", category: "assignment" });
      yield successMessage();
    },
    async function* () {
      yield initMessage();
      yield sendHandoffUse("final-1", "main", { action: "Reading tracker delivered: add/list/finish commands, JSON store", status: "completed", category: "final" });
      yield successMessage();
    },
  ),
  builder: turns(async function* () {
    yield initMessage();
    yield sendHandoffUse("done-1", "coordinator", { action: "CLI built and self-tested", status: "completed", category: "milestone" });
    yield successMessage();
  }),
};

export default defineScenario({
  id: "vague-greenfield",
  title: "Vague greenfield ask develops intent before building",
  taskCard: "Build me something to track my reading.",
  operatorScript: [
    { onQuestionMatching: /web app or cli/i, answer: { "Web app or CLI?": ["CLI"] } },
  ],
  stressedDimensions: ["intent-development", "question-quality", "spec-quality", "delegation"],
  checks: [askedBeforeBuilding(), questionCountAtMost(2), sessionCountAtMost(1)],
  fake: {
    variants: {
      exemplary: {
        expect: "pass",
        program: () =>
          roleSwitch({
            main: turns(
              async function* (options) {
                yield initMessage();
                const result = await options.canUseTool?.(
                  "AskUserQuestion",
                  {
                    questions: [
                      {
                        question: "Web app or CLI?",
                        options: [{ label: "CLI" }, { label: "Web app" }],
                      },
                    ],
                  },
                  permissionContext(),
                );
                if (result?.behavior === "allow") {
                  yield createSessionUse("create-1", {
                    title: "reading tracker",
                    agents: [{ name: "builder", profileId: "implementer", owns: ["src/"] }],
                    briefingAction: "Build a CLI reading tracker per the operator's answers",
                  });
                }
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: agentRoutes,
          }),
      },
      "builds-immediately": {
        expect: "flag",
        flaggedChecks: ["asked-before-building"],
        program: () =>
          roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                yield createSessionUse("create-1", {
                  title: "reading tracker",
                  agents: [{ name: "builder", profileId: "implementer", owns: ["src/"] }],
                  briefingAction: "Build a reading tracker; assume a web app",
                });
                yield textMessage("Kicked off the build on my assumptions.");
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: agentRoutes,
          }),
      },
    },
  },
  live: { fixture: "empty-workspace", maxBudgetUsd: 8, timeoutMin: 30 },
});
