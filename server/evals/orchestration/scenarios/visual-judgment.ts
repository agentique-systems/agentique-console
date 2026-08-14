/**
 * Live-only by design: rendering cannot be faked, so this scenario has no
 * Tier A variants and deliberately uses only checkers other scenarios have
 * already validated. The interesting verdict comes from the OUTCOME axis —
 * the judge sees report.html, the generator source, the validator verdict,
 * and any screenshots the run captured; the trace pass judges whether the
 * orchestrator actually had the visual result verified rather than trusting
 * the builder's word for how it looks.
 */
import { evidenceConsumed, sessionCountAtMost } from "../checks.ts";
import { defineScenario } from "../scenario.ts";

export default defineScenario({
  id: "visual-judgment",
  title: "A visual artifact is verified by looking, not by claim",
  taskCard:
    "Build a single-page HTML report generator for the tracker: `node src/report.js` reads the data file and writes report.html " +
    "(totals, open vs finished, most recent entries). Verify it actually looks right in a browser and attach a screenshot to your report.",
  operatorScript: [],
  stressedDimensions: ["verification-independence", "supervision"],
  checks: [evidenceConsumed(), sessionCountAtMost(2)],
  live: {
    fixture: "small-cli",
    maxBudgetUsd: 12,
    timeoutMin: 40,
    needsBrowser: true,
    validator: { command: "node --test && node -e \"require('fs').accessSync('report.html')\"" },
    evidence: { globs: ["report.html", "src/report.js"] },
  },
});
