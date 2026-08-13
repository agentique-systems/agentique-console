/**
 * The marginal-agent test, negative direction: a tiny mechanical change where
 * one agent is plenty. Extra sessions contribute no marginal information,
 * quality, or capacity — only coordination overhead.
 */
import { initMessage, sendHandoffUse, successMessage } from "../../../src/sdk/fake.ts";
import { questionCountAtMost, sessionCountAtMost } from "../checks.ts";
import { idleTurn, roleSwitch, turns } from "../programs.ts";
import { defineScenario } from "../scenario.ts";
import { createSessionUse } from "./shared.ts";

const agentRoutes = {
  coordinator: turns(
    async function* () {
      yield initMessage();
      yield sendHandoffUse("assign-1", "dev", { action: "Do the rename", status: "pending", category: "assignment" });
      yield successMessage();
    },
    async function* () {
      yield initMessage();
      yield sendHandoffUse("final-1", "main", { action: "Renamed fooBar to barFoo across 3 call sites", status: "completed", category: "final" });
      yield successMessage();
    },
  ),
  agent: turns(async function* () {
    yield initMessage();
    yield sendHandoffUse("done-1", "coordinator", { action: "Rename done, grep confirms zero stragglers", status: "completed", category: "milestone" });
    yield successMessage();
  }),
};

export default defineScenario({
  id: "wasteful-parallelism",
  title: "One agent is plenty for a mechanical rename",
  taskCard: "Rename the function fooBar to barFoo in src/util.ts and update its 3 call sites under src/.",
  operatorScript: [],
  stressedDimensions: ["marginal-agent-value", "unnecessary-work", "cost-latency"],
  checks: [sessionCountAtMost(1), questionCountAtMost(1)],
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
                  title: "rename fooBar",
                  agents: [{ name: "dev", profileId: "implementer", owns: ["src/"] }],
                  briefingAction: "Rename fooBar to barFoo, update 3 call sites, verify by grep",
                });
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: agentRoutes,
          }),
      },
      "spawns-a-fleet": {
        expect: "flag",
        flaggedChecks: ["session-count-at-most-1"],
        program: () =>
          roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                for (let i = 1; i <= 4; i += 1) {
                  yield createSessionUse(`create-${i}`, {
                    title: `rename shard ${i}`,
                    agents: [{ name: "dev", profileId: "implementer", owns: [`src/shard${i}/`] }],
                    briefingAction: `Rename occurrences, shard ${i}`,
                  });
                }
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: agentRoutes,
          }),
      },
    },
  },
  live: { fixture: "small-cli", maxBudgetUsd: 4, timeoutMin: 15 },
});
