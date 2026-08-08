/** Builtin profile model tiers (operator decision 2026-08-08). */
import { describe, expect, it } from "vitest";
import { AgentProfileRegistry } from "./registry.ts";

describe("builtin model tiers", () => {
  const registry = new AgentProfileRegistry();
  const model = (id: string) => registry.get(id).model;

  it("coordination and evidence-gathering run on sonnet-5", () => {
    for (const id of ["coordinator", "explorer", "researcher"]) expect(model(id)).toBe("claude-sonnet-5");
  });

  it("implementation and review run on opus-5", () => {
    for (const id of ["implementer", "frontend-implementer", "reviewer", "visual-reviewer"]) expect(model(id)).toBe("claude-opus-5");
  });
});
