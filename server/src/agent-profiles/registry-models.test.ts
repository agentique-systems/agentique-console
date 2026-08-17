/**
 * Builtin profile model and effort tiers (operator decision 2026-08-16,
 * superseding the 2026-08-08 sonnet/opus split): every builtin runs on the
 * same model tier the operator uses interactively — coordination is the
 * hardest reasoning in the system, not the cheapest — and the lanes that
 * write and judge code think at xhigh.
 */
import { describe, expect, it } from "vitest";
import { AgentProfileRegistry, ProfileSchema } from "./registry.ts";

const BUILTINS = ["coordinator", "explorer", "researcher", "implementer", "frontend-implementer", "reviewer", "visual-reviewer"];

describe("builtin model and effort tiers", () => {
  const registry = new AgentProfileRegistry();

  it("every builtin runs on opus-5", () => {
    for (const id of BUILTINS) expect(registry.get(id).model).toBe("claude-opus-5");
  });

  it("write and review profiles run at xhigh; coordination and evidence-gathering at high", () => {
    for (const id of ["implementer", "frontend-implementer", "reviewer", "visual-reviewer"]) expect(registry.get(id).effort).toBe("xhigh");
    for (const id of ["coordinator", "explorer", "researcher"]) expect(registry.get(id).effort).toBe("high");
  });

  it("the profile schema rejects an effort the SDK does not know", () => {
    const base = registry.get("explorer");
    expect(ProfileSchema.safeParse({ ...base, effort: "turbo" }).success).toBe(false);
    expect(ProfileSchema.safeParse({ ...base, effort: "max" }).success).toBe(true);
  });
});
