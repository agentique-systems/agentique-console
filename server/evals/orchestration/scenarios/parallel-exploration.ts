/**
 * Independent surveys should overlap. Three sessions with barrier-gated scouts
 * guarantee deterministic concurrency in the exemplary variant; the violation
 * runs the identical surveys strictly serially.
 */
import { initMessage, sendHandoffUse, successMessage } from "../../../src/sdk/fake.ts";
import { parallelOverlapAtLeast, sessionCountAtMost } from "../checks.ts";
import { idleTurn, roleSwitch, turns } from "../programs.ts";
import { defineScenario } from "../scenario.ts";
import type { Ev } from "../trace.ts";
import { createSessionUse } from "./shared.ts";

const SURVEYS = ["src", "test", "docs"] as const;

function coordinatorRoutes() {
  return turns(
    async function* () {
      yield initMessage();
      yield sendHandoffUse("assign-1", "scout", { action: "Survey your subsystem", status: "pending", category: "assignment" });
      yield successMessage();
    },
    async function* () {
      yield initMessage();
      yield sendHandoffUse("final-1", "main", { action: "Survey complete", status: "completed", category: "final" });
      yield successMessage();
    },
  );
}

/** Done once all three sessions have returned results. */
function threeResults() {
  let seen = 0;
  return (event: Ev) => {
    if (event.type === "agent_session.result.returned") seen += 1;
    return seen >= 3;
  };
}

export default defineScenario({
  id: "parallel-exploration",
  title: "Independent surveys run concurrently",
  taskCard: "Survey three independent areas of this project — src/, test/, and docs/ — and give me an inventory of each. They share nothing.",
  operatorScript: [],
  stressedDimensions: ["parallelism", "exploration", "delegation"],
  checks: [parallelOverlapAtLeast(2), sessionCountAtMost(3)],
  fake: {
    timeoutMs: 15_000,
    doneWhen: threeResults,
    variants: {
      exemplary: {
        expect: "pass",
        program: () => {
          // Barrier: every scout parks until all three have arrived, so their
          // turns provably overlap regardless of delivery timing.
          let arrived = 0;
          let release: () => void = () => undefined;
          const everyone = new Promise<void>((resolve) => {
            release = resolve;
          });
          const arrive = () => {
            arrived += 1;
            if (arrived >= SURVEYS.length) release();
          };
          return roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                for (const [index, survey] of SURVEYS.entries()) {
                  yield createSessionUse(`create-${index}`, {
                    title: `survey ${survey}`,
                    agents: [{ name: "scout", profileId: "explorer" }],
                    briefingAction: `Survey the ${survey} subsystem`,
                  });
                }
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: {
              coordinator: coordinatorRoutes(),
              scout: turns(async function* () {
                yield initMessage();
                arrive();
                await everyone;
                yield sendHandoffUse("done-1", "coordinator", { action: "Inventory attached", status: "completed", category: "milestone" });
                yield successMessage();
              }),
            },
          });
        },
      },
      "strictly-serial": {
        expect: "flag",
        flaggedChecks: ["parallel-overlap-at-least-2"],
        program: () => {
          let created = 0;
          return roleSwitch({
            main: turns(async function* () {
              yield initMessage();
              if (created < SURVEYS.length) {
                const survey = SURVEYS[created]!;
                created += 1;
                yield createSessionUse(`create-${created}`, {
                  title: `survey ${survey}`,
                  agents: [{ name: "scout", profileId: "explorer" }],
                  briefingAction: `Survey the ${survey} subsystem`,
                });
              }
              yield successMessage();
            }),
            agents: {
              coordinator: coordinatorRoutes(),
              scout: turns(async function* () {
                yield initMessage();
                yield sendHandoffUse("done-1", "coordinator", { action: "Inventory attached", status: "completed", category: "milestone" });
                yield successMessage();
              }),
            },
          });
        },
      },
    },
  },
  live: { fixture: "small-cli", maxBudgetUsd: 10, timeoutMin: 30 },
});
