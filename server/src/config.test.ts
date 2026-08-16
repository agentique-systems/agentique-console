/** Config defaults, env overrides, and the loud rejection of retired env names. */
import os from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig agent-lane knobs", () => {
  it("has resident/wake/naming defaults", () => {
    const config = loadConfig({});
    expect(config.policy.agentIdleReapMs).toBe(300_000);
    expect(config.policy.agentMaxResident)
      .toBe(Math.min(12, Math.max(4, Math.floor(os.totalmem() / (1.5 * 1024 ** 3)))));
    expect(config.policy.agentMaxResidentPerSession).toBe(4);
    expect(config.policy.agentSpawnTimeoutMs).toBe(30_000);
    expect(config.policy.peerNamePrefix).toBe("console-");
  });

  it("env overrides win", () => {
    const config = loadConfig({
      CONSOLE_AGENT_IDLE_REAP_MS: "1000",
      CONSOLE_MAX_RESIDENT_AGENTS: "2",
      CONSOLE_MAX_RESIDENT_AGENTS_PER_SESSION: "1",
      CONSOLE_AGENT_SPAWN_TIMEOUT_MS: "500",
      CONSOLE_PEER_NAME_PREFIX: "lab-",
    });
    expect(config.policy.agentIdleReapMs).toBe(1000);
    expect(config.policy.agentMaxResident).toBe(2);
    expect(config.policy.agentMaxResidentPerSession).toBe(1);
    expect(config.policy.agentSpawnTimeoutMs).toBe(500);
    expect(config.policy.peerNamePrefix).toBe("lab-");
  });

  it("MCP tool-call timeout defaults to 5 minutes and 0 disables it", () => {
    expect(loadConfig({}).policy.mcpToolTimeoutMs).toBe(300_000);
    expect(loadConfig({ CONSOLE_MCP_TOOL_TIMEOUT_MS: "60000" }).policy.mcpToolTimeoutMs).toBe(60_000);
    expect(loadConfig({ CONSOLE_MCP_TOOL_TIMEOUT_MS: "0" }).policy.mcpToolTimeoutMs).toBe(0);
  });

  it("rejects every retired env name loudly, naming the replacement", () => {
    expect(() => loadConfig({ CONSOLE_SEAT_IDLE_REAP_MS: "1000" }))
      .toThrow(/CONSOLE_SEAT_IDLE_REAP_MS \(use CONSOLE_AGENT_IDLE_REAP_MS\)/);
    expect(() => loadConfig({ CONSOLE_MAX_RESIDENT_SEATS: "2", CONSOLE_SEAT_WORKTREES: "0" }))
      .toThrow(/CONSOLE_MAX_RESIDENT_SEATS \(use CONSOLE_MAX_RESIDENT_AGENTS\).*CONSOLE_SEAT_WORKTREES \(use CONSOLE_AGENT_WORKTREES\)/);
    expect(() => loadConfig({ CONSOLE_MAX_RESIDENT_SEATS_PER_TREE: "1" }))
      .toThrow(/CONSOLE_MAX_RESIDENT_AGENTS_PER_SESSION/);
    expect(() => loadConfig({ CONSOLE_MAX_RESIDENT_AGENTS_PER_TREE: "1" }))
      .toThrow(/CONSOLE_MAX_RESIDENT_AGENTS_PER_SESSION/);
    expect(() => loadConfig({ CONSOLE_SEAT_SPAWN_TIMEOUT_MS: "500" }))
      .toThrow(/CONSOLE_AGENT_SPAWN_TIMEOUT_MS/);
  });
});
