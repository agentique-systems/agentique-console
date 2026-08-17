/**
 * Builtin profile model tiers (operator decision 2026-08-16, superseding the
 * 2026-08-08 sonnet/opus split): every builtin runs on the same tier the
 * operator uses interactively. Coordination is the hardest reasoning in the
 * system, not the cheapest.
 */
import { describe, expect, it } from "vitest";
import { AgentProfileRegistry } from "./registry.ts";

const BUILTINS = ["coordinator", "explorer", "researcher", "implementer", "frontend-implementer", "reviewer", "visual-reviewer"];

describe("builtin model tiers", () => {
  const registry = new AgentProfileRegistry();

  it("every builtin runs on opus-5", () => {
    for (const id of BUILTINS) expect(registry.get(id).model).toBe("claude-opus-5");
  });
});
