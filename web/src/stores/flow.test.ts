import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FLOW_FRESH_MS, useFlowStore } from "./flow";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

describe("flow store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useFlowStore.setState({ byAgentSession: {}, edgeGlow: null });
  });
  afterEach(() => vi.useRealTimers());

  it("pulse records direction per agent session and mirrors the edge glow", () => {
    useFlowStore.getState().pulse("as_1", "delegation");
    const pulse = useFlowStore.getState().byAgentSession["as_1"];
    expect(pulse?.direction).toBe("delegation");
    expect(pulse?.at).toBe(NOW);
    expect(useFlowStore.getState().edgeGlow).toEqual(pulse);
  });

  it("every pulse bumps the nonce so a repeat restarts the animation", () => {
    useFlowStore.getState().pulse("as_1", "delegation");
    const first = useFlowStore.getState().byAgentSession["as_1"]?.nonce;
    useFlowStore.getState().pulse("as_1", "result");
    const second = useFlowStore.getState().byAgentSession["as_1"];
    expect(first).toBeDefined();
    expect(second?.nonce).toBeGreaterThan(first as number);
    expect(second?.direction).toBe("result");
  });

  it("pulses on different sessions keep separate entries", () => {
    useFlowStore.getState().pulse("as_1", "delegation");
    useFlowStore.getState().pulse("as_2", "result");
    expect(
      useFlowStore.getState().byAgentSession["as_1"]?.direction,
    ).toBe("delegation");
    expect(
      useFlowStore.getState().byAgentSession["as_2"]?.direction,
    ).toBe("result");
  });

  it("freshness guard: a stale event ts (reconnect replay) never animates", () => {
    const staleTs = new Date(NOW - FLOW_FRESH_MS - 1).toISOString();
    useFlowStore.getState().pulse("as_1", "delegation", staleTs);
    expect(useFlowStore.getState().byAgentSession["as_1"]).toBeUndefined();
    expect(useFlowStore.getState().edgeGlow).toBeNull();
  });

  it("freshness guard: a fresh event ts pulses normally", () => {
    const freshTs = new Date(NOW - 1_000).toISOString();
    useFlowStore.getState().pulse("as_1", "result", freshTs);
    expect(useFlowStore.getState().byAgentSession["as_1"]?.direction).toBe(
      "result",
    );
  });
});
