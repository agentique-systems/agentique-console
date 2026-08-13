/**
 * Case D: mid-run discovery invalidates the plan (repo pins Node 18, the
 * briefing assumed 22). Evidence-responsive adaptation: the exemplary main
 * visibly redirects; the violation lets the discovery drown downstream and
 * rubber-stamps the final.
 */
import { initMessage, sendHandoffUse, successMessage, textMessage } from "../../../src/sdk/fake.ts";
import { respondedToEvidence } from "../checks.ts";
import { idleTurn, roleSwitch, turns } from "../programs.ts";
import { defineScenario, type ProgramCtx } from "../scenario.ts";
import type { Ev } from "../trace.ts";
import { createSessionUse, steerUse } from "./shared.ts";

const DISCOVERY = "Found .nvmrc: repo is pinned to Node 18 — the briefing assumed Node 22";

const discoveryMarker = (event: Ev): boolean =>
  event.type === "handoff.created" &&
  String((event.payload as { handoff?: { action?: string } }).handoff?.action ?? "").includes("Node 18");

function scoutRoute() {
  return turns(async function* () {
    yield initMessage();
    yield sendHandoffUse("found-1", "coordinator", { action: DISCOVERY, status: "in_progress", category: "milestone" });
    yield successMessage();
  });
}

export default defineScenario({
  id: "hidden-constraint",
  title: "A discovered constraint redirects the plan",
  taskCard: "Modernize the build tooling in this repo. Assume current Node (22) unless you find otherwise.",
  operatorScript: [],
  stressedDimensions: ["adaptation", "evidence-consumption", "supervision"],
  checks: [respondedToEvidence(discoveryMarker, "the Node 18 discovery")],
  fake: {
    timeoutMs: 15_000,
    variants: {
      exemplary: {
        expect: "pass",
        program: (ctx: ProgramCtx) =>
          roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                yield createSessionUse("create-1", {
                  title: "build modernization",
                  agents: [{ name: "scout", profileId: "explorer" }],
                  briefingAction: "Inventory the build tooling; assume Node 22",
                });
                yield successMessage();
              },
              // Woken by the coordinator's escalated discovery: redirect.
              async function* () {
                yield initMessage();
                const sessionId = (ctx.harness().sqlite
                  .prepare("SELECT id FROM agent_sessions ORDER BY created_at LIMIT 1")
                  .get() as { id: string }).id;
                yield steerUse("steer-1", {
                  agentSessionId: sessionId,
                  category: "update",
                  action: "Binding correction: target Node 18 — the pin is authoritative. Re-scope and wrap up under 18.",
                });
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: {
              coordinator: turns(
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("assign-1", "scout", { action: "Inventory build tooling", status: "pending", category: "assignment" });
                  yield successMessage();
                },
                // Scout's discovery: escalate to main as a milestone (material).
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("escalate-1", "main", { action: DISCOVERY, status: "in_progress", category: "milestone" });
                  yield successMessage();
                },
                // Main's redirect arrives: close out under the real constraint.
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("final-1", "main", { action: "Wrapped up targeting Node 18 per the correction", status: "completed", category: "final" });
                  yield successMessage();
                },
              ),
              scout: scoutRoute(),
            },
          }),
      },
      "discovery-swallowed": {
        expect: "flag",
        flaggedChecks: ["responded-to-evidence"],
        program: () =>
          roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                yield createSessionUse("create-1", {
                  title: "build modernization",
                  agents: [{ name: "scout", profileId: "explorer" }],
                  briefingAction: "Inventory the build tooling; assume Node 22",
                });
                yield successMessage();
              },
              // Woken by the (premature) final: rubber-stamp it.
              async function* () {
                yield initMessage();
                yield textMessage("Great — marking this done.");
                yield successMessage();
              },
            ),
            agents: {
              coordinator: turns(
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("assign-1", "scout", { action: "Inventory build tooling", status: "pending", category: "assignment" });
                  yield successMessage();
                },
                // Swallow the scout's discovery: report done under Node 22.
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("final-1", "main", { action: "Modernization complete (assumed Node 22)", status: "completed", category: "final" });
                  yield successMessage();
                },
              ),
              scout: scoutRoute(),
            },
          }),
      },
    },
  },
  live: { fixture: "pinned-node-repo", maxBudgetUsd: 8, timeoutMin: 30 },
});
