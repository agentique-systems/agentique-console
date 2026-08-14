/**
 * Tier A: structural orchestration evals. Gates CI (plain `npm test` picks
 * this up). For every scenario: the exemplary variant must pass EVERY check,
 * and each violation variant must trip at least one of its named checks —
 * which is what validates the checker library that Tier B's mechanical
 * scoring reuses. A red run here means the substrate broke, the evaluability
 * contract broke (a signal stopped being journaled), or a checker regressed.
 */
import { describe, expect, it } from "vitest";
import { PLANNED, SCENARIOS } from "./scenarios/index.ts";
import { runScenarioVariant } from "./structural-runner.ts";

describe("orchestration structural evals (Tier A)", () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.id, () => {
      for (const [variantName, variant] of Object.entries(scenario.fake?.variants ?? {})) {
        it(`${variantName} (${variant.expect})`, { timeout: 30_000 }, async () => {
          const run = await runScenarioVariant(scenario, variantName);
          expect(run.injectionFailures).toEqual([]);
          const failed = run.results.filter((entry) => !entry.result.pass);
          if (variant.expect === "pass") {
            expect(
              failed.map((entry) => `${entry.id}: ${entry.result.detail}`),
            ).toEqual([]);
          } else {
            const flagged = failed.map((entry) => entry.id);
            const expected = variant.flaggedChecks ?? [];
            expect(
              expected.some((id) => flagged.includes(id)),
              `expected one of [${expected.join(", ")}] to flag; failing checks: [${flagged.join(", ")}]`,
            ).toBe(true);
          }
        });
      }
    });
  }

  it("every Tier A scenario ships an exemplary AND at least one violation variant", () => {
    // The framework's own rule, enforced rather than aspirational: a checker
    // only counts as validated when a violating trace has proven it can flag.
    for (const scenario of SCENARIOS) {
      if (!scenario.fake) continue;
      const variants = Object.values(scenario.fake.variants);
      expect(variants.some((variant) => variant.expect === "pass"), `${scenario.id} has no exemplary variant`).toBe(true);
      expect(variants.some((variant) => variant.expect === "flag"), `${scenario.id} has no violation variant`).toBe(true);
    }
  });

  describe("planned scenarios (land with their features)", () => {
    for (const planned of PLANNED) {
      it.todo(`${planned.id} — awaiting ${planned.awaiting}`);
    }
  });
});
