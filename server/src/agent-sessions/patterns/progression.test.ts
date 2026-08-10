import { describe, expect, it } from "vitest";
import { loadConfig } from "../../config.ts";
import { hubContract } from "../topology.ts";
import { effectivePolicy, oscillating } from "./progression.ts";

describe("termination engine primitives", () => {
  it("oscillation detects A↔B round trips at the tail only", () => {
    expect(oscillating(["a>b", "b>a", "a>b", "b>a"], 2)).toBe(true);
    expect(oscillating(["c>d", "a>b", "b>a"], 1)).toBe(true);
    // A repeated same-direction hop is not a round trip.
    expect(oscillating(["a>b", "a>b", "a>b"], 1)).toBe(false);
    // The break must be at the tail: an old ping-pong does not count.
    expect(oscillating(["a>b", "b>a", "c>d"], 1)).toBe(false);
    expect(oscillating([], 1)).toBe(false);
  });

  it("effective policy = contract bounds with config ceilings as fallbacks", () => {
    const config = loadConfig({});
    const hub = effectivePolicy(hubContract(), config);
    expect(hub.maxHandoffs).toBe(config.patternHandoffCap);
    expect(hub.oscillationWindow).toBeUndefined();

    const strict = effectivePolicy({ ...hubContract(), termination: { maxHandoffs: 5 } }, config);
    expect(strict.maxHandoffs).toBe(5);
  });
});
