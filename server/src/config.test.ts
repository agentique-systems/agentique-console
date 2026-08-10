/** Config defaults and env overrides for the peer-mesh knobs. */
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig peer-mesh knobs", () => {
  it("has resident/wake/naming defaults", () => {
    const config = loadConfig({});
    expect(config.seatIdleReapMs).toBe(300_000);
    expect(config.seatMaxResident).toBe(8);
    expect(config.seatMaxResidentPerTree).toBe(4);
    expect(config.seatSpawnTimeoutMs).toBe(30_000);
    expect(config.peerNamePrefix).toBe("console-");
  });

  it("env overrides win", () => {
    const config = loadConfig({
      CONSOLE_SEAT_IDLE_REAP_MS: "1000",
      CONSOLE_MAX_RESIDENT_SEATS: "2",
      CONSOLE_MAX_RESIDENT_SEATS_PER_TREE: "1",
      CONSOLE_SEAT_SPAWN_TIMEOUT_MS: "500",
            CONSOLE_PEER_NAME_PREFIX: "lab-",
    });
    expect(config.seatIdleReapMs).toBe(1000);
    expect(config.seatMaxResident).toBe(2);
    expect(config.seatMaxResidentPerTree).toBe(1);
    expect(config.seatSpawnTimeoutMs).toBe(500);
    expect(config.peerNamePrefix).toBe("lab-");
  });
});
