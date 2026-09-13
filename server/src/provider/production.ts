import fs from "node:fs";
import path from "node:path";
import type { CapabilitySupport, ProviderDescriptor } from "@agentique-console/core";
import type { ProviderConfiguration } from "./configuration.ts";
import type { ProviderAdapter } from "./adapter.ts";
import { ClaudeAgentSdkAdapter } from "./claude-adapter.ts";
import type { ClaudeSdk } from "./claude-sdk.ts";
import { CodexSdkAdapter } from "./codex-adapter.ts";
import { AiSdkAdapter } from "./ai-sdk-adapter.ts";
import { ProviderRegistry, type ProviderRegistration } from "./registry.ts";
import type { McpConnection } from "./mcp-tools.ts";
import { protectCredentials } from "./credential-redaction.ts";
import { withEndpointProxy, withMcpEndpointProxies } from "./endpoint-proxy.ts";

const supported = (detail: string): CapabilitySupport => ({ status: "supported", detail });
const limited = (detail: string): CapabilitySupport => ({ status: "limited", detail });

/** SDK construction and configuration are confined to the provider layer. */
export function createProviderRegistry(config: { execution: ProviderConfiguration; dataDir: string; administration?: { trustedOrigins: string[] }; provider: { continuation: boolean; mcpServers: Record<string, McpConnection>; mcpToolTimeoutMs: number | null } }, sdk: ClaudeSdk, overrides: readonly ProviderAdapter[] = []): ProviderRegistry {
  const settings = config.execution;
  const common = {
    ...(config.administration ? { trustedEndpointOrigins: config.administration.trustedOrigins } : {}),
    fallbackWorkingDirectory: path.join(config.dataDir, "providers", "scratch"),
    continuation: config.provider.continuation,
    mcpServers: config.provider.mcpServers,
    limits: { ...(config.provider.mcpToolTimeoutMs === null ? {} : { toolTimeoutMs: config.provider.mcpToolTimeoutMs }) },
  };
  const claudeServers = Object.fromEntries(Object.entries(config.provider.mcpServers).map(([name, connection]) => [name, "url" in connection ? { type: "http" as const, ...connection } : { type: "stdio" as const, ...connection, ...(config.provider.mcpToolTimeoutMs === null ? {} : { timeout: config.provider.mcpToolTimeoutMs }) }]));
  const makeClaude = (environment?: NodeJS.ProcessEnv) => withMcpEndpointProxies(common.continuation, claudeServers, config.administration?.trustedOrigins ?? [], (mcpServers) => new ClaudeAgentSdkAdapter({ sdk, ...(environment ? { environment } : {}), fallbackWorkingDirectory: config.dataDir, continuation: common.continuation, mcpToolTimeoutMs: config.provider.mcpToolTimeoutMs, mcpServers }));
  const adapters: ProviderAdapter[] = [
    makeClaude(settings.claudeEnvironment),
    new CodexSdkAdapter({ ...common, ...settings.codex, models: settings.models.codex }),
    new AiSdkAdapter({ ...common, ...settings.aiSdk, models: settings.models["ai-sdk"] }),
  ];
  const capabilities: ProviderDescriptor["capabilities"] = {
    streaming: supported("Transient text and tool events"),
    runtimeTools: supported("All effective Agentique runtime tools and structured return_result"),
    approvals: supported("Exact-call runtime authorization; approve-once and blocking Decisions"),
    mcp: supported("Explicit server catalog, exact tool policy, bounded calls and cleanup"),
    cancellation: supported("Abort, operator pause, shutdown and Invocation deadline"),
    workingDirectory: supported("Assigned worktree/integration directory"),
    diagnostics: supported("Bounded redacted transcripts, failure classification and timing"),
  };
  const readiness = (provider: string, model?: string) => {
    if (overrides.some((a) => a.provider === provider)) return { configured: true, detail: "Injected adapter" };
    if (provider === "claude") return { configured: true, detail: "Claude SDK uses configured API credentials or local login" };
    if (provider === "codex") return { configured: !!settings.codex.apiKey || fs.existsSync(path.join(settings.codex.home, "auth.json")), detail: "Set CODEX_API_KEY / OPENAI_API_KEY or log in using CONSOLE_CODEX_HOME" };
    const name = (model ?? "").replace(/^pi\//, "");
    if (model?.startsWith("pi/") && (name.startsWith("openai/") ? settings.aiSdk.openai.baseURL : settings.aiSdk.anthropic.baseURL)) return { configured: false, detail: "Pi uses native model endpoints; configured endpoint overrides are unsupported" };
    const key = name.startsWith("anthropic/") ? settings.aiSdk.anthropic.apiKey : name.startsWith("gateway/") ? settings.aiSdk.gateway.apiKey : settings.aiSdk.openai.apiKey;
    return { configured: !!key, detail: name.startsWith("anthropic/") ? "Requires ANTHROPIC_API_KEY" : name.startsWith("gateway/") ? "Requires AI_GATEWAY_API_KEY" : "Requires OPENAI_API_KEY" };
  };
  const registrations: ProviderRegistration[] = adapters.map((original) => {
    let adapter = original;
    const environment = settings.claudeEnvironment;
    if (original.provider === "claude" && environment?.ANTHROPIC_API_KEY && !environment.ANTHROPIC_AUTH_TOKEN && !environment.CLAUDE_CODE_OAUTH_TOKEN && ![environment.CLAUDE_CODE_USE_BEDROCK, environment.CLAUDE_CODE_USE_VERTEX, environment.CLAUDE_CODE_USE_FOUNDRY].some((value) => value === "1" || value === "true") && config.administration) {
      adapter = withEndpointProxy("claude", common.continuation, environment.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com", environment.ANTHROPIC_API_KEY, true, config.administration.trustedOrigins, (url, token) => makeClaude({ ...environment, ANTHROPIC_API_KEY: token, ANTHROPIC_BASE_URL: url }));
    }
    if (original.provider === "codex" && settings.codex.apiKey && config.administration) {
      adapter = withEndpointProxy("codex", common.continuation, settings.codex.baseUrl ?? "https://api.openai.com/v1", settings.codex.apiKey, false, config.administration.trustedOrigins, (url, token) => new CodexSdkAdapter({ ...common, ...settings.codex, apiKey: token, baseUrl: url, models: settings.models.codex }));
    }
    const id = adapter.provider as keyof typeof settings.models;
    const models = settings.models[id].map((model) => ({ ...model, availability: readiness(id, model.id) }));
    return {
      adapter: protectCredentials(overrides.find((a) => a.provider === id) ?? adapter, [settings.codex.apiKey, settings.aiSdk.openai.apiKey, settings.aiSdk.anthropic.apiKey, settings.aiSdk.gateway.apiKey, ...Object.entries(settings.claudeEnvironment ?? {}).filter(([key]) => /^(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_API_KEY|AZURE_OPENAI_API_KEY|GOOGLE_API_KEY)$/.test(key)).map(([, value]) => value), ...Object.values(config.provider.mcpServers).flatMap((s) => Object.values("url" in s ? s.headers ?? {} : s.env ?? {}))].filter((v): v is string => !!v)),
      descriptor: {
        id, label: id === "claude" ? "Claude" : id === "codex" ? "Codex" : "AI SDK", defaultModel: settings.defaultModels[id], models,
        availability: id === "ai-sdk" ? { configured: models.some((m) => m.availability.configured), detail: "Configure credentials for at least one model provider" } : readiness(id),
        capabilities: {
          ...capabilities,
          nativeTools: id === "claude" ? supported("Claude native tools behind PreToolUse authorization") : id === "codex" ? limited("The TypeScript SDK has no per-call approval callback. Guarded MCP capability tools implement read/search/write/shell/web; the CLI uses a read-only sandbox and native execution is disabled.") : limited("Authorized local tools and MCP for ToolLoopAgent/Agent; Pi harness native tools are filtered and replaced by authorized tools. Web capability fetches URLs; search requires MCP."),
          continuation: config.provider.continuation ? id === "ai-sdk" ? limited("Bounded model-message replay; Pi HarnessAgent session state when enabled") : supported("Opaque native session resume; provider/model identity verified") : { status: "unsupported", detail: "Disabled by CONSOLE_CONTINUATION" },
          usage: id === "claude" ? supported("SDK tokens, cache, cost and provider duration") : limited("SDK tokens and wall time. USD cost requires catalog pricing; Codex reports tokens only at turn completion, so aborts may leave usage unknown."),
        },
      },
    };
  });
  return new ProviderRegistry(registrations, settings.defaults);
}
