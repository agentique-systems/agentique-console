/** Rotation arithmetic: unconditional at the limit; a turn limit of 0 is off. */
import { describe, expect, it } from "vitest";
import { rotationDue } from "./rotation.ts";

describe("rotationDue", () => {
  it("is due exactly at the token limit and not below", () => {
    expect(rotationDue({ turnCount: 0, contextTokens: 119_999, turnLimit: 0, tokenLimit: 120_000 })).toBeNull();
    expect(rotationDue({ turnCount: 0, contextTokens: 120_000, turnLimit: 0, tokenLimit: 120_000 })).toEqual({ reason: "token_limit" });
  });

  it("a turn limit of 0 never rotates on turns; a positive one rotates exactly at it", () => {
    expect(rotationDue({ turnCount: 1_000, contextTokens: 0, turnLimit: 0, tokenLimit: 120_000 })).toBeNull();
    expect(rotationDue({ turnCount: 29, contextTokens: 0, turnLimit: 30, tokenLimit: 120_000 })).toBeNull();
    expect(rotationDue({ turnCount: 30, contextTokens: 0, turnLimit: 30, tokenLimit: 120_000 })).toEqual({ reason: "turn_limit" });
  });

  it("the token reason wins when both limits are reached", () => {
    expect(rotationDue({ turnCount: 30, contextTokens: 120_000, turnLimit: 30, tokenLimit: 120_000 })).toEqual({ reason: "token_limit" });
  });
});
