import { describe, expect, it } from "vitest";
import { sdkEnv } from "./env.ts";

const PINNED = {
  CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: "1000",
};

describe("sdkEnv", () => {
  it("strips the launching Claude Code session's coupling and behaviour vars", () => {
    const env = sdkEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_BRIDGE_SESSION_ID: "def",
      CLAUDE_CODE_SSE_PORT: "1234",
      CLAUDE_CODE_EXECPATH: "/somewhere",
      CLAUDE_PID: "983",
      CLAUDE_EFFORT: "xhigh",
      AI_AGENT: "claude-code",
    });
    expect(env).toEqual(PINNED);
  });

  it("keeps paths, credentials and provider settings", () => {
    const env = sdkEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      ANTHROPIC_API_KEY: "sk-test",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      CLAUDE_CONFIG_DIR: "/home/me/.claude",
      HTTPS_PROXY: "http://proxy:8080",
      CLAUDE_EFFORT: "xhigh",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/me",
      ANTHROPIC_API_KEY: "sk-test",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      CLAUDE_CONFIG_DIR: "/home/me/.claude",
      HTTPS_PROXY: "http://proxy:8080",
      ...PINNED,
    });
  });

  it("drops undefined values", () => {
    expect(sdkEnv({ A: undefined, B: "b" })).toEqual({ B: "b", ...PINNED });
  });

  it("pins the console's subagent knobs over host-provided values", () => {
    const env = sdkEnv({ CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: "5" });
    expect(env).toEqual(PINNED);
  });
});
