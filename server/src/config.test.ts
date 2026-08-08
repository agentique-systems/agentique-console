/** Config defaults and env overrides for the scheduler caps. */
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig scheduler caps", () => {
  it("defaults to 8 global and 4 per-session agent turns", () => {
    const config = loadConfig({});
    expect(config.globalAgentTurns).toBe(8);
    expect(config.perAgentSessionTurns).toBe(4);
  });

  it("env overrides win", () => {
    const config = loadConfig({
      CONSOLE_GLOBAL_AGENT_TURNS: "3",
      CONSOLE_PER_SESSION_AGENT_TURNS: "1",
    });
    expect(config.globalAgentTurns).toBe(3);
    expect(config.perAgentSessionTurns).toBe(1);
  });
});

describe("loadConfig peer-mesh knobs", () => {
  it("has resident/wake/naming defaults", () => {
    const config = loadConfig({});
    expect(config.seatIdleReapMs).toBe(300_000);
    expect(config.seatMaxResident).toBe(8);
    expect(config.seatMaxResidentPerSession).toBe(4);
    expect(config.sendWakeTimeoutMs).toBe(30_000);
    expect(config.deliveryHoldLeaseMs).toBe(60_000);
    expect(config.peerNamePrefix).toBe("console-");
  });

  it("env overrides win", () => {
    const config = loadConfig({
      CONSOLE_SEAT_IDLE_REAP_MS: "1000",
      CONSOLE_MAX_RESIDENT_SEATS: "2",
      CONSOLE_MAX_RESIDENT_SEATS_PER_SESSION: "1",
      CONSOLE_SEND_WAKE_TIMEOUT_MS: "500",
      CONSOLE_DELIVERY_HOLD_LEASE_MS: "2000",
      CONSOLE_PEER_NAME_PREFIX: "lab-",
    });
    expect(config.seatIdleReapMs).toBe(1000);
    expect(config.seatMaxResident).toBe(2);
    expect(config.seatMaxResidentPerSession).toBe(1);
    expect(config.sendWakeTimeoutMs).toBe(500);
    expect(config.deliveryHoldLeaseMs).toBe(2000);
    expect(config.peerNamePrefix).toBe("lab-");
  });
});
