/**
 * Goodhart rule 3, enforced: rubric text must never enter any orchestrator
 * prompt. If a rubric's anchor language shows up in the brief or the tool
 * descriptions, the model is being trained to the test — the check that was
 * promised as "(Structural check.)" and never existed until now.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

function normalize(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim().toLowerCase();
}

describe("rubric leak", () => {
  it("no rubric anchor line appears in the orchestrator prompt or tool source", () => {
    const rubricsDir = path.join(here, "rubrics");
    const anchorLines = fs.readdirSync(rubricsDir)
      .filter((name) => name.endsWith(".md") && !name.startsWith("_"))
      .flatMap((name) => fs.readFileSync(path.join(rubricsDir, name), "utf8").split("\n"))
      .map((line) => normalize(line.replace(/^[-*#>\d.\s]+/, "")))
      .filter((line) => line.length >= 30);
    expect(anchorLines.length).toBeGreaterThan(20);

    const promptSources = ["../../src/orchestrator/prompt.ts", "../../src/orchestrator/tools.ts"]
      .map((file) => normalize(fs.readFileSync(path.join(here, file), "utf8")));
    const leaks = anchorLines.filter((line) => promptSources.some((source) => source.includes(line)));
    expect(leaks, `rubric text leaked into an orchestrator prompt: ${leaks.slice(0, 3).join(" | ")}`).toEqual([]);
  });
});
