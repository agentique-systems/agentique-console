import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";

const HOME = path.resolve("/home/operator");

describe("configuration", () => {
  it("derives every path from the data directory and applies validated defaults", () => {
    const config = loadConfig({}, HOME);
    expect(config.dataDir).toBe(path.join(HOME, ".agentique-console"));
    expect(config.databaseFile).toBe(path.join(config.dataDir, "console.db"));
    expect(config.blobRoot).toBe(path.join(config.dataDir, "blobs"));
    expect(config.stateRoot).toBe(config.dataDir);
    expect(config).toMatchObject({ port: 4400, host: "127.0.0.1", provider: { effort: "medium", continuation: true, continuationTtlMs: null, mcpServers: {} }, governor: { providerMaxConcurrency: 4, processMaxAttempts: 6, maxWorktrees: null }, driver: { maxConcurrentRuns: 4 } });
    expect(config.defaults.completionCheck).toEqual({ command: "npm test", expectedExitCode: 0 });
    expect(config.defaults.evaluator).toBe("reviewer");
    expect(config.fsRoots.map((r) => r.label)).toEqual(["Home", "Filesystem"]);
  });

  it("reads the retained and new variables, ignores unknown CONSOLE_* names, and translates no retired name", () => {
    const config = loadConfig(
      {
        CONSOLE_DATA_DIR: "/data/console",
        CONSOLE_PORT: "5000",
        CONSOLE_HOST: "0.0.0.0",
        CONSOLE_FS_ROOTS: ["/srv/a", "/srv/b"].join(path.delimiter),
        CONSOLE_MODEL: "claude-haiku-4-5-20251001",
        CONSOLE_EFFORT: "low",
        CONSOLE_CONTINUATION: "0",
        CONSOLE_CONTINUATION_TTL_MS: "3600000",
        CONSOLE_BROWSER_MCP: "npx -y @browser/mcp --headless",
        CONSOLE_PROVIDER_MAX_CONCURRENCY: "2",
        CONSOLE_PROCESS_MAX_ATTEMPTS: "3",
        CONSOLE_MAX_WORKTREES: "5",
        CONSOLE_DEFAULT_MAX_COST_USD: "12.5",
        CONSOLE_DEFAULT_COMPLETION_CHECK: "",
        CONSOLE_DEFAULT_EVALUATOR: "none",
        // Retired names are neither honoured nor translated: unknown CONSOLE_* names are ignored.
        CONSOLE_AGENT_WORKTREES: "0",
        CONSOLE_MAX_RESIDENT_AGENTS: "99",
        CONSOLE_COMPLETION_POLICY: "advisory",
      },
      HOME,
    );
    expect(config.dataDir).toBe(path.resolve("/data/console"));
    expect(config).toMatchObject({ port: 5000, host: "0.0.0.0", provider: { model: "claude-haiku-4-5-20251001", effort: "low", continuation: false, continuationTtlMs: 3_600_000, mcpServers: { browser: { command: "npx", args: ["-y", "@browser/mcp", "--headless"] } } }, governor: { providerMaxConcurrency: 2, processMaxAttempts: 3, maxWorktrees: 5 } });
    expect(config.fsRoots.map((r) => r.path)).toEqual(["/srv/a", "/srv/b"]);
    expect(config.defaults.budget.maxCostUsd).toBe(12.5);
    expect(config.defaults.completionCheck).toBeNull();
    expect(config.defaults.evaluator).toBe("none");
    expect(JSON.stringify(config)).not.toMatch(/resident|worktrees":true|advisory/);
    // A disabled server leaves the catalog.
    expect(loadConfig({ CONSOLE_BROWSER_MCP: "cmd", CONSOLE_MCP_DISABLED: "browser" }, HOME).provider.mcpServers).toEqual({});
  });

  it("refuses an invalid value naming the variable", () => {
    expect(() => loadConfig({ CONSOLE_PORT: "http" }, HOME)).toThrow(ConfigError);
    expect(() => loadConfig({ CONSOLE_PORT: "70000" }, HOME)).toThrow(/CONSOLE_PORT/);
    expect(() => loadConfig({ CONSOLE_EFFORT: "extreme" }, HOME)).toThrow(/CONSOLE_EFFORT/);
    expect(() => loadConfig({ CONSOLE_FS_ROOTS: "relative/path" }, HOME)).toThrow(/CONSOLE_FS_ROOTS/);
    expect(() => loadConfig({ CONSOLE_CONTINUATION: "maybe" }, HOME)).toThrow(/CONSOLE_CONTINUATION/);
    expect(() => loadConfig({ CONSOLE_DEFAULT_EVALUATOR: "judge" }, HOME)).toThrow(/CONSOLE_DEFAULT_EVALUATOR/);
    expect(() => loadConfig({ CONSOLE_DEFAULT_MAX_COST_USD: "-1" }, HOME)).toThrow(/CONSOLE_DEFAULT_MAX_COST_USD/);
    expect(() => loadConfig({ CONSOLE_PROVIDER_MAX_CONCURRENCY: "0" }, HOME)).toThrow(/CONSOLE_PROVIDER_MAX_CONCURRENCY/);
  });
});
