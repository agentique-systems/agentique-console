import { describe, expect, it } from "vitest";
import { loadProviderConfiguration } from "./configuration.ts";
import { createProviderRegistry } from "./production.ts";
import { FakeClaudeSdk } from "./claude-sdk-test-support.ts";

function registry(env: NodeJS.ProcessEnv = {}) {
  return createProviderRegistry({ dataDir: process.cwd(), execution: loadProviderConfiguration(env, process.cwd()), provider: { continuation: true, mcpServers: {}, mcpToolTimeoutMs: null } }, new FakeClaudeSdk());
}

describe("provider configuration and registry", () => {
  it("preserves Claude defaults, supports all three catalogs, and isolates catalog mutation", () => {
    const providers = registry();
    expect(providers.defaults).toEqual({ provider: "claude", model: "claude-fable-5-1" });
    expect(providers.catalog().map((p) => p.id)).toEqual(["claude", "codex", "ai-sdk"]);
    providers.catalog()[0]!.models.length = 0;
    expect(providers.catalog()[0]!.models.length).toBeGreaterThan(0);
  });

  it("resolves legacy manifests to Claude, not the changed deployment default", () => {
    const providers = registry({ CONSOLE_PROVIDER: "codex", CODEX_API_KEY: "fixture-key" });
    expect(providers.select({})).toEqual({ provider: "codex", model: "gpt-5.6-terra" });
    expect(providers.resolve({ model: "legacy-claude-alias" }).provider).toBe("claude");
    expect(providers.resolve({ provider: "codex", model: "gpt-5.6-terra" }).provider).toBe("codex");
    expect(providers.select({ provider: "claude" }).model).toBe("claude-fable-5-1");
  });

  it("rejects unsupported provider/model pairs before admission", () => {
    const providers = registry({ OPENAI_API_KEY: "fixture-key" });
    expect(() => providers.select({ provider: "unknown" })).toThrow(/Unknown execution provider/);
    expect(() => providers.select({ provider: "codex", model: "claude-fable-5-1" })).toThrow(/not configured/);
    expect(() => providers.select({ provider: "ai-sdk", model: "openai/typo" })).toThrow(/not configured/);
  });

  it("checks credentials per model without leaking keys or preventing recovery", () => {
    const providers = registry({ OPENAI_API_KEY: "sk-contract-secret-no-output" });
    expect(providers.select({ provider: "ai-sdk", model: "openai/gpt-5.6-sol" }).provider).toBe("ai-sdk");
    expect(() => providers.select({ provider: "ai-sdk", model: "anthropic/claude-fable-5-1" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(registry().resolve({ provider: "ai-sdk", model: "openai/gpt-5.6-sol" }).provider).toBe("ai-sdk");
    expect(registry({ CONSOLE_CODEX_MODELS: "gpt-5.6-terra" }).resolve({ provider: "codex", model: "gpt-5.6-sol" }).provider).toBe("codex");
    expect(JSON.stringify(providers.catalog())).not.toContain("sk-contract-secret");
  });

  it("accepts configured catalogs, pricing, defaults, and isolated Pi opt-in", () => {
    const config = loadProviderConfiguration({ CONSOLE_PROVIDER: "ai-sdk", CONSOLE_AI_SDK_HARNESS: "pi", CONSOLE_MODEL: "pi/openai/gpt-5.6-terra", CONSOLE_MODEL_CATALOG: JSON.stringify({ "ai-sdk": [{ id: "pi/openai/gpt-5.6-terra", contextWindowTokens: 100000, efforts: ["medium"], pricing: { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 5 } }] }) }, process.cwd());
    expect(config.defaults.model).toBe("pi/openai/gpt-5.6-terra");
    expect(config.models["ai-sdk"][0]!.pricing?.output).toBe(5);
    expect(config.aiSdk.harness).toBe("pi");
  });

  it.each([
    { CONSOLE_PROVIDER: "bad" }, { CONSOLE_CODEX_MODELS: "gpt-5.6-terra,gpt-5.6-terra" },
    { CONSOLE_CLAUDE_MODEL: "gpt-5.6-terra" }, { CONSOLE_CODEX_MODEL: "claude-fable-5-1" },
    { CONSOLE_AI_SDK_MODEL: "pi/openai/gpt-5.6-terra" }, { CONSOLE_AI_SDK_MODEL: "openai/claude-fable-5-1" },
    { CONSOLE_MODEL_CATALOG: "not-json" }, { CONSOLE_OPENAI_BASE_URL: "https://user:secret@example.test" },
  ])("rejects invalid deployment configuration: %j", (env) => {
    expect(() => loadProviderConfiguration(env, process.cwd())).toThrow();
  });
});
