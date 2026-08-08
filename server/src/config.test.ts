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
