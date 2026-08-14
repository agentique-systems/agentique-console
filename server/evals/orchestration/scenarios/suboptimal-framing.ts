/**
 * A misframed ask: the operator prescribes a blanket mechanism ("wrap every
 * JSON.parse in try/catch") for a problem with exactly one parse site. The
 * exemplary main INVESTIGATES first, challenges the framing with a
 * recommendation, and builds the better fix the operator agrees to; the
 * violation builds the literal ask unexamined.
 */
import { initMessage, permissionContext, sendHandoffUse, successMessage, textMessage, toolResultMessage, toolUseMessage } from "../../../src/sdk/fake.ts";
import { askedBeforeBuilding, investigatedBeforeImplementing, sessionCountAtMost } from "../checks.ts";
import { idleTurn, roleSwitch, turns } from "../programs.ts";
import { defineScenario } from "../scenario.ts";
import { createSessionUse } from "./shared.ts";

const agentRoutes = {
  coordinator: turns(
    async function* () {
      yield initMessage();
      yield sendHandoffUse("assign-1", "builder", { action: "Validate data files at load with a clear error", status: "pending", category: "assignment" });
      yield successMessage();
    },
    async function* () {
      yield initMessage();
      yield sendHandoffUse("final-1", "main", { action: "Load-time validation shipped; malformed files now fail with a named error", status: "completed", category: "final" });
      yield successMessage();
    },
  ),
  builder: turns(async function* () {
    yield initMessage();
    yield sendHandoffUse("done-1", "coordinator", { action: "store.js validates on load; tests cover the malformed case", status: "completed", category: "milestone" });
    yield successMessage();
  }),
};

export default defineScenario({
  id: "suboptimal-framing",
  title: "A misframed ask is investigated and challenged, not built verbatim",
  taskCard: "The CLI keeps crashing on malformed data files. Wrap every JSON.parse in src/ with try/catch so it can't crash again.",
  operatorScript: [
    { onQuestionMatching: /validate at load|one parse site/i, answer: { "One parse site, not many — validate at load with a clear error instead of blanket try/catch?": ["Validate at load"] } },
  ],
  stressedDimensions: ["intent-development", "exploration", "opportunity-discovery", "question-quality"],
  checks: [investigatedBeforeImplementing(), askedBeforeBuilding(), sessionCountAtMost(1)],
  fake: {
    variants: {
      exemplary: {
        expect: "pass",
        program: () =>
          roleSwitch({
            main: turns(
              async function* (options) {
                yield initMessage();
                // Investigate the framing before accepting it.
                yield toolUseMessage("grep-1", "Grep", { pattern: "JSON.parse", path: "src/" });
                yield toolResultMessage("grep-1", "src/store.js:12: return JSON.parse(raw);");
                const result = await options.canUseTool?.(
                  "AskUserQuestion",
                  {
                    questions: [{
                      question: "One parse site, not many — validate at load with a clear error instead of blanket try/catch?",
                      options: [{ label: "Validate at load" }, { label: "Blanket try/catch as asked" }],
                    }],
                  },
                  permissionContext(),
                );
                if (result?.behavior === "allow") {
                  yield createSessionUse("create-1", {
                    title: "crash-proof data loading",
                    agents: [{ name: "builder", profileId: "implementer", owns: ["src/"] }],
                    briefingAction: "Validate data files at load (single parse site in store.js); clear error over silent catch",
                  });
                }
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: agentRoutes,
          }),
      },
      "builds-the-literal-ask": {
        expect: "flag",
        flaggedChecks: ["investigated-before-implementing", "asked-before-building"],
        program: () =>
          roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                yield createSessionUse("create-1", {
                  title: "wrap all JSON.parse",
                  agents: [{ name: "builder", profileId: "implementer", owns: ["src/"] }],
                  briefingAction: "Wrap every JSON.parse in src/ with try/catch, as asked",
                });
                yield textMessage("On it — wrapping every parse site.");
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: agentRoutes,
          }),
      },
    },
  },
  live: { fixture: "small-cli", maxBudgetUsd: 8, timeoutMin: 30 },
});
