/**
 * A design question where two competing concerns (durability vs script
 * compatibility) genuinely pull apart: a second independent perspective
 * materially improves the recommendation. The exemplary main seats two
 * distinct-profile analysts and consumes both into the synthesis; the
 * violation runs a single lens. The session ceiling keeps this from ever
 * rewarding headcount — the point is marginal INFORMATION, not crowd size.
 */
import type { FakeProgram } from "../../../src/sdk/fake.ts";
import { initMessage, sendHandoffUse, successMessage, toolUseMessage } from "../../../src/sdk/fake.ts";
import { distinctPerspectivesAtLeast, evidenceConsumed, sessionCountAtMost } from "../checks.ts";
import { idleTurn, roleSwitch, turns } from "../programs.ts";
import { agentRoleOf } from "../../../src/test-helpers.ts";
import { defineScenario, type ProgramCtx } from "../scenario.ts";
import type { Ev } from "../trace.ts";
import { createSessionUse } from "./shared.ts";

const doneOnFinal = () => (event: Ev) => event.type === "handoff.created" &&
  String((event.payload as { handoff?: { action?: string } }).handoff?.action ?? "").includes("Design recommendation");

/** Content-driven: assign both analysts, then final once BOTH reported (wake coalescing safe). */
function analystCoordinator(ctx: ProgramCtx, finalAction: string): FakeProgram {
  let assigned = false;
  let finaled = false;
  return async function* (options) {
    yield initMessage();
    const sessionId = agentRoleOf(options).agentSessionId;
    if (!assigned) {
      assigned = true;
      yield sendHandoffUse("assign-1", "durability", { action: "Design the v2 storage format for durability: crash-safety, corruption recovery", status: "pending", category: "assignment" });
      yield sendHandoffUse("assign-2", "compat", { action: "Design the v2 CLI surface for script compatibility: flags, output stability", status: "pending", category: "assignment" });
      yield successMessage();
      return;
    }
    const reports = sessionId === undefined ? 0 : (ctx.harness().sqlite
      .prepare("SELECT count(*) AS n FROM handoff_records WHERE agent_session_id = ? AND sender IN ('durability','compat') AND recipient = 'coordinator'")
      .get(sessionId) as { n: number }).n;
    if (!finaled && reports >= 2) {
      finaled = true;
      yield sendHandoffUse("final-1", "main", { action: finalAction, status: "completed", category: "final" });
    }
    yield successMessage();
  };
}

export default defineScenario({
  id: "two-perspectives-better",
  title: "A second independent perspective earns its seat on a two-concern design",
  taskCard: "Design the v2 storage format and CLI surface — durability of user data AND script compatibility both matter. I want a design recommendation, not code.",
  operatorScript: [],
  stressedDimensions: ["marginal-agent-value", "pattern-selection", "delegation"],
  checks: [distinctPerspectivesAtLeast(2), evidenceConsumed(), sessionCountAtMost(2)],
  fake: {
    timeoutMs: 15_000,
    variants: {
      exemplary: {
        expect: "pass",
        doneWhen: () => {
          let finalSeen = false;
          return (event: Ev) => {
            if (doneOnFinal()(event)) finalSeen = true;
            return finalSeen && event.type === "user_session.turn.settled";
          };
        },
        program: (ctx: ProgramCtx) =>
          roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                yield createSessionUse("create-1", {
                  title: "v2 design",
                  agents: [
                    { name: "durability", profileId: "explorer" },
                    { name: "compat", profileId: "researcher" },
                  ],
                  briefingAction: "Two concerns pull apart: durability of the store vs script compatibility of the CLI. Analyze independently, then synthesize",
                });
                yield successMessage();
              },
              // Woken by the synthesized recommendation: consume it.
              async function* () {
                yield initMessage();
                const sessionId = (ctx.harness().sqlite
                  .prepare("SELECT id FROM agent_sessions ORDER BY created_at LIMIT 1")
                  .get() as { id: string }).id;
                yield toolUseMessage("state-1", "mcp__console__update_orchestration_state", {
                  trigger: "discovery",
                  strategy: "Adopt the two-file design: append-only log for durability, versioned JSON view for script compatibility",
                  note: "both perspectives landed; the synthesis reconciles them",
                  incorporating: [sessionId],
                });
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: {
              coordinator: analystCoordinator(ctx, "Design recommendation: append-only log (durability) + versioned JSON view (script compatibility) — the two concerns need different files"),
              durability: turns(async function* () {
                yield initMessage();
                yield sendHandoffUse("d-1", "coordinator", { action: "Durability lens: append-only log with checksummed records; rewrite-in-place loses data on crash", status: "completed", category: "milestone" });
                yield successMessage();
              }),
              compat: turns(async function* () {
                yield initMessage();
                yield sendHandoffUse("c-1", "coordinator", { action: "Compatibility lens: scripts parse the current JSON shape; any new format needs a stable JSON view", status: "completed", category: "milestone" });
                yield successMessage();
              }),
            },
          }),
      },
      "single-lens": {
        expect: "flag",
        flaggedChecks: ["distinct-perspectives-at-least-2"],
        doneWhen: doneOnFinal,
        program: () =>
          roleSwitch({
            main: turns(
              async function* () {
                yield initMessage();
                yield createSessionUse("create-1", {
                  title: "v2 design",
                  agents: [{ name: "durability", profileId: "explorer" }],
                  briefingAction: "Design the v2 storage format and CLI surface",
                });
                yield successMessage();
              },
              idleTurn(),
            ),
            agents: {
              coordinator: turns(
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("assign-1", "durability", { action: "Design the v2 storage format and CLI surface", status: "pending", category: "assignment" });
                  yield successMessage();
                },
                async function* () {
                  yield initMessage();
                  yield sendHandoffUse("final-1", "main", { action: "Design recommendation: append-only log everywhere; scripts will adapt", status: "completed", category: "final" });
                  yield successMessage();
                },
              ),
              durability: turns(async function* () {
                yield initMessage();
                yield sendHandoffUse("d-1", "coordinator", { action: "Durability lens: append-only log with checksummed records", status: "completed", category: "milestone" });
                yield successMessage();
              }),
            },
          }),
      },
    },
  },
  live: { fixture: "small-cli", maxBudgetUsd: 10, timeoutMin: 35,
    evidence: { globs: ["*.md", "docs/*.md"] } },
});
