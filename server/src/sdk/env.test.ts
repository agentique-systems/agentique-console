import { describe, expect, it } from "vitest";
import { sdkEnv } from "./env.ts";

/**
 * `CLAUDE_CODE_MAX_RETRIES` is set on every child: the Console's wall-clock
 * budget is the real control, and the cap stops the CLI burning minutes of
 * back-off before the Console can act.
 */
const RETRY_CAP = { CLAUDE_CODE_MAX_RETRIES: "5" };

describe("sdkEnv", () => {
  it("strips the launching Claude Code session's coupling and behaviour vars", () => {
    const env = sdkEnv({ source: {
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_SESSION_NAME: "operators-own-name",
      CLAUDE_CODE_BRIDGE_SESSION_ID: "def",
      CLAUDE_CODE_SSE_PORT: "1234",
      CLAUDE_CODE_EXECPATH: "/somewhere",
      CLAUDE_PID: "983",
      CLAUDE_EFFORT: "xhigh",
      AI_AGENT: "claude-code",
    } });
    expect(env).toEqual({ ...RETRY_CAP });
  });

  it("keeps paths, credentials and provider settings", () => {
    const env = sdkEnv({ source: {
      PATH: "/usr/bin",
      HOME: "/home/me",
      ANTHROPIC_API_KEY: "sk-test",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      CLAUDE_CONFIG_DIR: "/home/me/.claude",
      HTTPS_PROXY: "http://proxy:8080",
      CLAUDE_EFFORT: "xhigh",
    } });
    expect(env).toEqual({
      ...RETRY_CAP,
      PATH: "/usr/bin",
      HOME: "/home/me",
      ANTHROPIC_API_KEY: "sk-test",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      CLAUDE_CONFIG_DIR: "/home/me/.claude",
      HTTPS_PROXY: "http://proxy:8080",
    });
  });

  it("drops undefined values", () => {
    expect(sdkEnv({ source: { A: undefined, B: "b" } })).toEqual({ ...RETRY_CAP, B: "b" });
  });

  it("drops native subagent knobs", () => {
    const env = sdkEnv({ source: { CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: "5" } });
    expect(env).toEqual({ ...RETRY_CAP });
  });

  it("names the session, displacing any inherited name", () => {
    const env = sdkEnv({
      sessionName: "console-scout-8fbb2c",
      source: { PATH: "/usr/bin", CLAUDE_CODE_SESSION_NAME: "operators-own-name" },
    });
    expect(env).toEqual({ ...RETRY_CAP, PATH: "/usr/bin", CLAUDE_CODE_SESSION_NAME: "console-scout-8fbb2c" });
  });
});
