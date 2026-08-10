/** Catalog resolution and rotation-limit derivation. */
import { describe, expect, it } from "vitest";
import { ORCHESTRATOR_MODELS } from "@agentique-console/shared";
import { resolveModelContext, rotationTokenLimit } from "./model-catalog.ts";

describe("resolveModelContext", () => {
  it("matches family prefixes, dated variants included", () => {
    expect(resolveModelContext("claude-opus-5").contextWindow).toBe(200_000);
    expect(resolveModelContext("claude-opus-5-20990101").contextWindow).toBe(200_000);
    expect(resolveModelContext("claude-sonnet-4-6").contextWindow).toBe(200_000);
    expect(resolveModelContext("claude-fable-5-20990101").contextWindow).toBe(200_000);
    expect(resolveModelContext("claude-haiku-4-5-20251001").contextWindow).toBe(180_000);
  });

  it("normalizes case and whitespace", () => {
    expect(resolveModelContext("  Claude-Opus-5  ").contextWindow).toBe(200_000);
  });

  it("unknown, empty, and null ids get the conservative default", () => {
    for (const id of ["gpt-oss-9000", "", null, undefined]) {
      expect(resolveModelContext(id)).toMatchObject({ contextWindow: 100_000, maxOutput: 32_000 });
    }
  });
});

describe("rotationTokenLimit", () => {
  it("config binds for known models", () => {
    expect(rotationTokenLimit(120_000, "claude-opus-5")).toBe(120_000);
  });

  // The failure this guards is silent: an offered model with no catalog entry
  // halves its own rotation ceiling and nothing says so.
  it("every selectable orchestrator model keeps the configured limit binding", () => {
    for (const model of ORCHESTRATOR_MODELS) {
      expect(rotationTokenLimit(120_000, model.id)).toBe(120_000);
    }
  });

  it("catalog binds for unknown models", () => {
    expect(rotationTokenLimit(120_000, "mystery-model")).toBe(68_000);
  });

  it("a tiny configured limit always binds", () => {
    expect(rotationTokenLimit(10_000, "claude-sonnet-5")).toBe(10_000);
    expect(rotationTokenLimit(10_000, "mystery-model")).toBe(10_000);
  });
});
