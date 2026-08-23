/**
 * Staged elaboration under a too-big-to-enumerate intent: the exemplary main
 * commits a COARSE top level first, elaborates the combat subtree in a scoped
 * card when it commissions that work, and lands a mid-run discovery as
 * another scoped amendment — every card the operator approves is a
 * reviewable bite. The violation re-proposes the whole document each time.
 */
import type { FakeProgram } from "../../../src/sdk/fake.ts";
import { initMessage, sendHandoffUse, successMessage, toolUseMessage } from "../../../src/sdk/fake.ts";
import { commissionsReferenceOpenRequirements, stagedGrowth } from "../checks.ts";
import { roleSwitch, turns } from "../programs.ts";
import { defineScenario, type ProgramCtx } from "../scenario.ts";
import type { Ev } from "../trace.ts";
import { createSessionUse } from "./shared.ts";

const COARSE_DOC = "# Tiny persistent world\n\n## Context\nA small multiplayer world — think a very small WoW: combat, a world that persists, characters that grow. Depth arrives area by area.\n\n## Requirements\n- Combat resolves hits and misses\n- The world persists across restarts\n- Characters progress";

const COMBAT_SCOPED = "## Requirements\n- Hits register within one frame\n- Misses are telegraphed before they land";
const PERSIST_SCOPED = "## Requirements\n- World state snapshots at a fixed tick";

const COMBAT_FULL = "# Tiny persistent world\n\n## Context\nA small multiplayer world — think a very small WoW: combat, a world that persists, characters that grow. Depth arrives area by area.\n\n## Requirements\n- r1: Combat resolves hits and misses\n  - Hits register within one frame\n  - Misses are telegraphed before they land\n- r2: The world persists across restarts\n- r3: Characters progress";
const PERSIST_FULL = "# Tiny persistent world\n\n## Context\nA small multiplayer world — think a very small WoW: combat, a world that persists, characters that grow. Depth arrives area by area.\n\n## Requirements\n- r1: Combat resolves hits and misses\n  - r4: Hits register within one frame\n  - r5: Misses are telegraphed before they land\n- r2: The world persists across restarts\n  - World state snapshots at a fixed tick\n- r3: Characters progress";

const coordinatorRoute = turns(
  async function* () {
    yield initMessage();
    yield sendHandoffUse("assign-1", "builder", { action: "Implement combat per the delegated requirements", status: "pending", category: "assignment" });
    yield successMessage();
  },
  async function* () {
    yield initMessage();
    yield sendHandoffUse("final-1", "main", { action: "Combat implemented; persistence needs a tick-rate requirement", status: "completed", category: "final" });
    yield successMessage();
  },
);

const builderRoute = turns(async function* () {
  yield initMessage();
  yield sendHandoffUse("b-1", "coordinator", { action: "Combat done; discovered persistence needs a fixed tick", status: "completed", category: "milestone" });
  yield successMessage();
});

function mainRoute(ctx: ProgramCtx, opts: { scoped: boolean }): FakeProgram {
  let created = false;
  let amended = false;
  return async function* () {
    yield initMessage();
    if (!created) {
      created = true;
      // Coarse commitment first: the vision prose plus three epics.
      yield toolUseMessage("req-1", "mcp__console__propose_requirements", { document: COARSE_DOC, changeNote: "coarse top level" });
      // Elaborate the combat subtree AT commissioning time.
      yield opts.scoped
        ? toolUseMessage("req-2", "mcp__console__propose_requirements", { document: COMBAT_SCOPED, changeNote: "combat elaborated at commissioning", scopeId: "r1" })
        : toolUseMessage("req-2", "mcp__console__propose_requirements", { document: COMBAT_FULL, changeNote: "combat elaborated at commissioning" });
      yield createSessionUse("create-1", {
        title: "combat",
        agents: [{ name: "builder", profileId: "implementer", owns: ["src/"] }],
        briefingAction: "Implement combat per the delegated requirements",
        requirements: ["r1"],
      });
      yield successMessage();
      return;
    }
    const finalArrived = (ctx.harness().sqlite
      .prepare("SELECT count(*) AS n FROM handoff_records WHERE recipient = 'main' AND core LIKE '%Combat implemented%'")
      .get() as { n: number }).n > 0;
    if (finalArrived && !amended) {
      amended = true;
      // The discovery enters the COMMITTED model the same staged way.
      yield opts.scoped
        ? toolUseMessage("req-3", "mcp__console__propose_requirements", { document: PERSIST_SCOPED, changeNote: "discovered: persistence needs a fixed tick", scopeId: "r2" })
        : toolUseMessage("req-3", "mcp__console__propose_requirements", { document: PERSIST_FULL, changeNote: "discovered: persistence needs a fixed tick" });
      yield successMessage();
      return;
    }
    yield successMessage();
  };
}

function variantProgram(opts: { scoped: boolean }) {
  return (ctx: ProgramCtx) => roleSwitch({
    main: mainRoute(ctx, opts),
    agents: { coordinator: coordinatorRoute, builder: builderRoute },
  });
}

const thirdRevisionApproved = () => (event: Ev): boolean =>
  event.type === "user_session.requirements.updated"
  && (event.payload as { revision?: number }).revision === 3;

export default defineScenario({
  id: "staged-elaboration",
  title: "A too-big intent commits coarse, elaborates per subtree, absorbs discovery in scoped bites",
  taskCard: "Build a tiny persistent multiplayer world — combat, persistence between restarts, character progression. Think a very small WoW; there is far more latent detail than one document can hold.",
  operatorScript: [
    { onProposal: "approve", kind: "spec" },
    { onProposal: "approve", kind: "spec" },
    { onProposal: "approve", kind: "spec" },
  ],
  stressedDimensions: ["intent-development", "spec-quality", "delegation"],
  checks: [
    stagedGrowth(),
    commissionsReferenceOpenRequirements(),
  ],
  fake: {
    timeoutMs: 20_000,
    variants: {
      exemplary: {
        expect: "pass",
        doneWhen: thirdRevisionApproved,
        program: variantProgram({ scoped: true }),
      },
      "monolithic-elaboration": {
        expect: "flag",
        flaggedChecks: ["staged-growth"],
        doneWhen: thirdRevisionApproved,
        program: variantProgram({ scoped: false }),
      },
    },
  },
  live: { fixture: "small-cli", maxBudgetUsd: 10, timeoutMin: 40,
    validator: { command: "node --test" },
    evidence: { globs: ["src/*.js"] } },
});
