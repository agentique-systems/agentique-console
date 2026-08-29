import { describe, expect, it } from "vitest";
import { decodeLabel, encodeLabel, parseSourcePath, sourcePath } from "./source-path.ts";

describe("source-path grammar", () => {
  it("builds every segment kind and parses it back", () => {
    const paths = {
      [sourcePath.expression(0)]: { kind: "expression", index: 0, segments: [] },
      [sourcePath.step("e1", 2)]: { kind: "expression", index: 1, segments: [{ kind: "step", index: 2 }] },
      [sourcePath.stepRun("e1", 0, 3)]: { kind: "expression", index: 1, segments: [{ kind: "step_run", from: 0, to: 3 }] },
      [sourcePath.item("e2/steps/1", 4)]: { kind: "expression", index: 2, segments: [{ kind: "step", index: 1 }, { kind: "item", index: 4 }] },
      [sourcePath.leaves("e0")]: { kind: "expression", index: 0, segments: [{ kind: "leaves" }] },
      [sourcePath.join("e0")]: { kind: "expression", index: 0, segments: [{ kind: "join" }] },
      [sourcePath.aggregate("e0")]: { kind: "expression", index: 0, segments: [{ kind: "aggregate" }] },
      [sourcePath.branch("e0", "fast path/2 ü")]: { kind: "expression", index: 0, segments: [{ kind: "branch", label: "fast path/2 ü" }] },
      [sourcePath.producerRound("e3", 2)]: { kind: "expression", index: 3, segments: [{ kind: "producer_round", round: 2 }] },
      [sourcePath.evaluateRound("e3", 2)]: { kind: "expression", index: 3, segments: [{ kind: "evaluate_round", round: 2 }] },
      root: { kind: "root" },
    };
    for (const [path, parsed] of Object.entries(paths)) expect(parseSourcePath(path), path).toEqual(parsed);
    expect(sourcePath.branch("e0", "fast path/2 ü")).toBe("e0/branches/fast%20path%2F2%20%C3%BC");
  });

  it("encodes labels injectively and never produces a path separator", () => {
    const labels = ["a", "a b", "a%20b", "a/b", "a%2Fb", "%", "-_", "üñî", "日本語", "", "steps"];
    const encoded = labels.map(encodeLabel);
    expect(new Set(encoded).size).toBe(labels.length);
    for (const [i, label] of labels.entries()) {
      expect(encoded[i]).not.toContain("/");
      expect(decodeLabel(encoded[i]!)).toBe(label);
    }
  });

  it("rejects paths outside the grammar", () => {
    for (const bad of ["", "x0", "e", "e01", "e0/steps", "e0/steps/x", "e0/steps/2..2", "e0/steps/3..1", "e0/items/-1", "e0/rounds/0/producer", "e0/rounds/1/other", "e0/branches/", "e0/branches/a b", "e0/unknown", "root/steps/0"]) {
      expect(() => parseSourcePath(bad), bad).toThrow();
    }
  });
});
