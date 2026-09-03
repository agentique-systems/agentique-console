import { describe, expect, it } from "vitest";
import { DEFAULT_SDK_MAX_RETRIES, isStrippedVariable, providerEnvironment, STRIPPED_FEATURE_FLAGS } from "./env.ts";

describe("providerEnvironment", () => {
  it("strips host-session coupling and coordination flags, passes everything else through by key, caps SDK retries, and fixes the non-essential-traffic switches", () => {
    const env = providerEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/u",
      ANTHROPIC_API_KEY: "sk-ant-x",
      CLAUDE_CONFIG_DIR: "/home/u/.claude",
      HTTPS_PROXY: "http://proxy",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_SESSION_NAME: "host",
      CLAUDE_CODE_SSE_PORT: "1234",
      CLAUDE_PID: "99",
      AI_AGENT: "1",
      CLAUDE_EFFORT: "max",
      CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: "10",
      UNDEFINED_ONE: undefined,
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      ANTHROPIC_API_KEY: "sk-ant-x",
      CLAUDE_CONFIG_DIR: "/home/u/.claude",
      HTTPS_PROXY: "http://proxy",
      CLAUDE_CODE_MAX_RETRIES: DEFAULT_SDK_MAX_RETRIES,
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    for (const flag of STRIPPED_FEATURE_FLAGS) expect(isStrippedVariable(flag)).toBe(true);
    expect(isStrippedVariable("CLAUDECODE")).toBe(true);
    expect(isStrippedVariable("PATH")).toBe(false);
  });

  it("sets the SDK's MCP tool-call bound from the console's configuration, and leaves the inherited value alone when the console states none", () => {
    expect(providerEnvironment({ MCP_TOOL_TIMEOUT: "1" }, { mcpToolTimeoutMs: 5_000 }).MCP_TOOL_TIMEOUT).toBe("5000");
    expect(providerEnvironment({}, { mcpToolTimeoutMs: 30_000 }).MCP_TOOL_TIMEOUT).toBe("30000");
    expect(providerEnvironment({ MCP_TOOL_TIMEOUT: "1" }, { mcpToolTimeoutMs: null }).MCP_TOOL_TIMEOUT).toBe("1");
    expect(providerEnvironment({}).MCP_TOOL_TIMEOUT).toBeUndefined();
  });

  it("keeps an explicit retry cap and overrides an inherited traffic switch", () => {
    const env = providerEnvironment({ CLAUDE_CODE_MAX_RETRIES: "1", DISABLE_AUTOUPDATER: "0" });
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe("1");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
  });
});
