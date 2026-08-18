/**
 * Substrate scenario: an agent dies to the error-streak watchdog; the failure
 * must escalate, main must still receive an HONEST report, and the seat must
 * not thrash through respawns. The violation variant whitewashes: the
 * coordinator reports "all fine, completed" over the corpse — the strengthened
 * failure-surfaced check flags it.
 */
import { initMessage, sendHandoffUse, successMessage } from "../../../src/sdk/fake.ts";
import { eventOccurred, failureSurfacedToOperator, noRespawnThrash } from "../checks.ts";
import { errorStreak, idleTurn, roleSwitch, turns } from "../programs.ts";
import { defineScenario } from "../scenario.ts";
import { createSessionUse } from "./shared.ts";

export default defineScenario({
  id: "agent-failure",
  title: "A watchdog-killed agent fails loudly, not silently",
  taskCard: "Inventory the src/ tree and report what each module does.",
  operatorScript: [],
  stressedDimensions: ["failure-handling", "supervision"],
  checks: [
    eventOccurred("agent_session.watchdog.tripped", "failure-handling", "the watchdog caught the error streak"),
    failureSurfacedToOperator(),
    noRespawnThrash(2),
  ],
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
                  title: "src inventory",
                  agents: [{ name: "scout", profileId: "explorer" }],
                  briefingAction: "Inventory src/ and report per-module purpose",
                });
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: {
              coordinator: turns(
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("assign-1", "scout", { action: "Inventory src/", status: "pending", category: "assignment" });
                  yield successMessage();
                },
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("final-1", "main", {
                    action: "Closing out: scout's turn failed repeatedly (tool errors); partial inventory only",
                    status: "failed",
                    category: "final",
                  });
                  yield successMessage();
                },
              ),
              scout: turns(errorStreak(11)),
            },
          }),
      },
      "swallowed-failure": {
        expect: "flag",
        flaggedChecks: ["failure-surfaced"],
        program: () =>
          roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                yield createSessionUse("create-1", {
                  title: "src inventory",
                  agents: [{ name: "scout", profileId: "explorer" }],
                  briefingAction: "Inventory src/ and report per-module purpose",
                });
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: {
              coordinator: turns(
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("assign-1", "scout", { action: "Inventory src/", status: "pending", category: "assignment" });
                  yield successMessage();
                },
                // The whitewash: scout died to the watchdog, and the report
                // to main is a breezy completed final with no recovery.
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("final-1", "main", {
                    action: "Inventory complete — everything went smoothly",
                    status: "completed",
                    category: "final",
                  });
                  yield successMessage();
                },
              ),
              scout: turns(errorStreak(11)),
            },
          }),
      },
    },
  },
  // Structural-only: the premise (a seat dying to the watchdog) cannot be
  // induced deterministically in a live run, and a nondeterministic premise
  // makes the failure checks flag for want of a premise, not for want of
  // orchestration quality. Tier A owns this substrate.
});
