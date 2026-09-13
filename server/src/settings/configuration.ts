import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ConnectionId, type SettingsValues, ValidationError, settingsValuesSchema, addAllocation, allocationFits, allocationOfLimits, ZERO_ALLOCATION } from "@agentique-console/core";
import { type Config } from "../config.ts";
import { loadProviderConfiguration } from "../provider/configuration.ts";
import type { McpConnection } from "../provider/mcp-tools.ts";

export const KEY_VARIABLES: Record<ConnectionId, string[]> = { claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"], codex: ["CODEX_API_KEY", "OPENAI_API_KEY"], openai: ["OPENAI_API_KEY"], anthropic: ["ANTHROPIC_API_KEY"], gateway: ["AI_GATEWAY_API_KEY"] };
export const DEFAULT_ENDPOINTS: Record<ConnectionId, string> = { claude: "https://api.anthropic.com", codex: "https://api.openai.com/v1", openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com/v1", gateway: "https://ai-gateway.vercel.sh/v4/ai" };
export const SETTING_VARIABLES: Record<string, string[]> = {
  "providers.defaultProvider": ["CONSOLE_PROVIDER"],
  "providers.defaultModels.claude": ["CONSOLE_CLAUDE_MODEL"], "providers.defaultModels.codex": ["CONSOLE_CODEX_MODEL"], "providers.defaultModels.ai-sdk": ["CONSOLE_AI_SDK_MODEL"],
  "providers.models.claude": ["CONSOLE_CLAUDE_MODELS", "CONSOLE_MODEL_CATALOG"], "providers.models.codex": ["CONSOLE_CODEX_MODELS", "CONSOLE_MODEL_CATALOG"], "providers.models.ai-sdk": ["CONSOLE_AI_SDK_MODELS", "CONSOLE_MODEL_CATALOG"],
  "providers.piHarness": ["CONSOLE_AI_SDK_HARNESS"],
  "providers.connections.claude.endpoint": ["ANTHROPIC_BASE_URL"], "providers.connections.codex.endpoint": ["CONSOLE_CODEX_BASE_URL"], "providers.connections.openai.endpoint": ["CONSOLE_OPENAI_BASE_URL"], "providers.connections.anthropic.endpoint": ["CONSOLE_ANTHROPIC_BASE_URL"], "providers.connections.gateway.endpoint": ["CONSOLE_AI_GATEWAY_BASE_URL"],
  "integrations.servers": ["CONSOLE_MCP_SERVERS", "CONSOLE_BROWSER_MCP", "CONSOLE_MCP_DISABLED"], "integrations.toolTimeoutMs": ["CONSOLE_MCP_TOOL_TIMEOUT_MS"],
  "execution.effort": ["CONSOLE_EFFORT"], "execution.budget.maxCostUsd": ["CONSOLE_DEFAULT_MAX_COST_USD"], "execution.budget.maxTokens": ["CONSOLE_DEFAULT_MAX_TOKENS"], "execution.budget.maxAttempts": ["CONSOLE_DEFAULT_MAX_ATTEMPTS"], "execution.budget.maxWallClockMs": ["CONSOLE_DEFAULT_MAX_WALL_CLOCK_MS"], "execution.budget.maxConcurrency": ["CONSOLE_DEFAULT_MAX_CONCURRENCY"],
  "execution.orchestratorAllocation.costUsd": ["CONSOLE_ORCHESTRATOR_COST_USD"], "execution.orchestratorAllocation.tokens": ["CONSOLE_ORCHESTRATOR_TOKENS"], "execution.orchestratorAllocation.attempts": ["CONSOLE_ORCHESTRATOR_ATTEMPTS"],
  "execution.nodeAllocation.costUsd": ["CONSOLE_NODE_COST_USD"], "execution.nodeAllocation.tokens": ["CONSOLE_NODE_TOKENS"], "execution.nodeAllocation.attempts": ["CONSOLE_NODE_ATTEMPTS"],
  "execution.maxWallClockMs": ["CONSOLE_ATTEMPT_MAX_WALL_CLOCK_MS"], "execution.completionCheck": ["CONSOLE_DEFAULT_COMPLETION_CHECK"], "execution.evaluator": ["CONSOLE_DEFAULT_EVALUATOR"],
  "execution.continuation": ["CONSOLE_CONTINUATION"], "execution.continuationTtlMs": ["CONSOLE_CONTINUATION_TTL_MS"],
  "execution.providerMaxConcurrency": ["CONSOLE_PROVIDER_MAX_CONCURRENCY"], "execution.processMaxAttempts": ["CONSOLE_PROCESS_MAX_ATTEMPTS"], "execution.maxWorktrees": ["CONSOLE_MAX_WORKTREES"], "execution.maxConcurrentRuns": ["CONSOLE_MAX_CONCURRENT_RUNS"], "execution.checkTimeoutMs": ["CONSOLE_CHECK_TIMEOUT_MS"],
};
export function getPath(value: unknown, key: string): unknown { return key.split(".").reduce<unknown>((v, k) => v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined, value); }
export function setPath(value: object, key: string, next: unknown): void {
  const parts = key.split("."); let target = value as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  target[parts.at(-1)!] = structuredClone(next);
}
export function localLoginPresent(id: ConnectionId, config: Config, env: NodeJS.ProcessEnv): boolean {
  if (id === "codex") return fs.existsSync(path.join(config.execution.codex.home, "auth.json"));
  if (id !== "claude") return false;
  // macOS may keep Claude login in Keychain; presence cannot be established by inspecting a file there.
  return !!env.CLAUDE_CODE_OAUTH_TOKEN || fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), ".credentials.json"));
}
export function fromConfig(c: Config, env: NodeJS.ProcessEnv): SettingsValues {
  const connections = Object.fromEntries((Object.keys(DEFAULT_ENDPOINTS) as ConnectionId[]).map((id) => [id, { enabled: true, auth: KEY_VARIABLES[id].some((key) => !!env[key]) ? "api_key" : id === "claude" || id === "codex" ? "local_login" : "api_key", endpoint: DEFAULT_ENDPOINTS[id] }])) as SettingsValues["providers"]["connections"];
  connections.claude.endpoint = env.ANTHROPIC_BASE_URL ?? DEFAULT_ENDPOINTS.claude;
  if ([env.CLAUDE_CODE_USE_BEDROCK, env.CLAUDE_CODE_USE_VERTEX, env.CLAUDE_CODE_USE_FOUNDRY].some((value) => value === "1" || value === "true") || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN) connections.claude.auth = "deployment";
  connections.codex.endpoint = c.execution.codex.baseUrl ?? DEFAULT_ENDPOINTS.codex;
  for (const id of ["openai", "anthropic", "gateway"] as const) connections[id].endpoint = c.execution.aiSdk[id].baseURL ?? DEFAULT_ENDPOINTS[id];
  return settingsValuesSchema.parse({
    general: { theme: "system", sendShortcut: "enter", autoScroll: true, notifications: true },
    providers: { defaultProvider: c.execution.defaults.provider, defaultModels: c.execution.defaultModels, models: c.execution.models, connections, piHarness: c.execution.aiSdk.harness === "pi" },
    integrations: { servers: Object.entries(c.provider.mcpServers).map(([name, s]) => ({ name, enabled: true, transport: "url" in s ? "http" : "stdio", command: "command" in s ? s.command : "", args: "args" in s ? s.args : [], url: "url" in s ? s.url : "" })), toolTimeoutMs: c.provider.mcpToolTimeoutMs },
    execution: { effort: c.provider.effort, budget: c.defaults.budget, orchestratorAllocation: c.defaults.orchestratorAllocation, nodeAllocation: c.defaults.nodeAllocation, maxWallClockMs: c.defaults.maxWallClockMs, completionCheck: c.defaults.completionCheck, evaluator: c.defaults.evaluator, continuation: c.provider.continuation, continuationTtlMs: c.provider.continuationTtlMs, ...c.governor, maxConcurrentRuns: c.driver.maxConcurrentRuns, checkTimeoutMs: c.checks.commandTimeoutMs },
    workspaces: {}, security: { deniedTools: [], approvalRequiredTools: [], deniedMcpServers: [] },
  });
}
export function locksOf(config: Config, env: NodeJS.ProcessEnv): Record<string, string> {
  const locks: Record<string, string> = {};
  for (const [key, variables] of Object.entries(SETTING_VARIABLES)) { const present = variables.filter((v) => env[v] !== undefined); if (present.length) locks[key] = present.join(", "); }
  if (env.CONSOLE_MODEL !== undefined) locks[`providers.defaultModels.${config.execution.defaults.provider}`] = "CONSOLE_MODEL";
  for (const id of Object.keys(KEY_VARIABLES) as ConnectionId[]) {
    const present = KEY_VARIABLES[id].filter((key) => !!env[key]);
    if (present.length) locks[`providers.connections.${id}.auth`] = present.join(", ");
  }
  if (fromConfig(config, env).providers.connections.claude.auth === "deployment") locks["providers.connections.claude"] = "Claude cloud / gateway authentication is enforced by deployment";
  return locks;
}
export function validateSettings(values: SettingsValues): void {
  const p = values.providers;
  for (const [id, connection] of Object.entries(p.connections)) {
    if (connection.auth === "local_login" && !["claude", "codex"].includes(id)) throw new ValidationError("Local login is supported only by Claude and Codex.");
    if (connection.auth === "deployment" && id !== "claude") throw new ValidationError("Deployment authentication is supported only by Claude.");
    if (connection.auth === "none" && id !== "openai") throw new ValidationError("Credential-free connections are supported only for explicitly trusted OpenAI-compatible endpoints.");
    if (connection.auth === "local_login" && connection.endpoint !== DEFAULT_ENDPOINTS[id as ConnectionId]) throw new ValidationError("Local-login credentials can only be used with the native provider endpoint.");
  }
  try {
    loadProviderConfiguration({ CONSOLE_PROVIDER: p.defaultProvider, CONSOLE_CLAUDE_MODEL: p.defaultModels.claude, CONSOLE_CODEX_MODEL: p.defaultModels.codex, CONSOLE_AI_SDK_MODEL: p.defaultModels["ai-sdk"], CONSOLE_MODEL_CATALOG: JSON.stringify(p.models), ...(p.piHarness ? { CONSOLE_AI_SDK_HARNESS: "pi" } : {}) }, ".");
  } catch { throw new ValidationError("Each default must be in its provider catalog. Use native Claude/Codex ids or openai/, anthropic/, gateway/ and enabled pi/ model prefixes."); }
  const e = values.execution;
  const reserve = addAllocation(e.orchestratorAllocation, e.evaluator === "reviewer" ? e.nodeAllocation : ZERO_ALLOCATION);
  if (!allocationFits(addAllocation(e.orchestratorAllocation, reserve), allocationOfLimits(e.budget))) throw new ValidationError("The budget must fund the initial Orchestrator allocation and final synthesis/review reserve.");
  for (const w of Object.values(values.workspaces)) {
    const provider = w.provider ?? p.defaultProvider;
    const model = w.model ?? p.defaultModels[provider];
    if (!p.models[provider].some((m) => m.id === model)) throw new ValidationError("A workspace default model is absent from its provider catalog.");
    if (w.budget && !allocationFits(addAllocation(e.orchestratorAllocation, addAllocation(e.orchestratorAllocation, (w.evaluator ?? e.evaluator) === "reviewer" ? e.nodeAllocation : ZERO_ALLOCATION)), allocationOfLimits(w.budget))) throw new ValidationError("The workspace budget must fund its initial allocation and final synthesis/review reserve.");
  }
  for (const model of p.models["ai-sdk"]) if (model.id.startsWith("pi/")) {
    const id = model.id.split("/")[1] as "openai" | "anthropic";
    if (p.connections[id].endpoint !== DEFAULT_ENDPOINTS[id]) throw new ValidationError("Pi models require native endpoints. Use the standard AI SDK model prefix with a compatible endpoint.");
  }
}

export function applyConfiguration(config: Config, values: SettingsValues, credential: (id: string) => string | undefined, env: NodeJS.ProcessEnv, deploymentMcp: Record<string, McpConnection>): void {
  const p = values.providers;
  config.execution.defaults = { provider: p.defaultProvider, model: p.defaultModels[p.defaultProvider] };
  config.execution.models = structuredClone(p.models);
  config.execution.defaultModels = { ...p.defaultModels };
  config.provider.model = config.execution.defaults.model;
  const keyFor = (id: ConnectionId) => p.connections[id].auth === "api_key" ? credential(id) : undefined;
  const codexKey = keyFor("codex");
  config.execution.codex = { home: config.execution.codex.home, ...(config.execution.codex.codexPathOverride ? { codexPathOverride: config.execution.codex.codexPathOverride } : {}), ...(codexKey ? { apiKey: codexKey } : {}), ...(p.connections.codex.endpoint !== DEFAULT_ENDPOINTS.codex ? { baseUrl: p.connections.codex.endpoint } : {}) };
  config.execution.aiSdk = {
    ...Object.fromEntries((["openai", "anthropic", "gateway"] as const).map((id) => [id, { apiKey: keyFor(id) ?? (p.connections[id].auth === "none" ? "local-provider" : ""), ...(p.connections[id].endpoint !== DEFAULT_ENDPOINTS[id] ? { baseURL: p.connections[id].endpoint } : {}) }])),
    ...(p.piHarness ? { harness: "pi" as const } : {}),
  } as Config["execution"]["aiSdk"];
  if (p.connections.openai.auth === "none") config.execution.aiSdk.openai.noAuth = true;
  config.execution.claudeEnvironment = { ...env };
  if (p.connections.claude.auth !== "deployment") {
    delete config.execution.claudeEnvironment.ANTHROPIC_API_KEY;
    delete config.execution.claudeEnvironment.ANTHROPIC_AUTH_TOKEN;
    delete config.execution.claudeEnvironment.CLAUDE_CODE_OAUTH_TOKEN;
    if (p.connections.claude.auth === "local_login" && env.CLAUDE_CODE_OAUTH_TOKEN) config.execution.claudeEnvironment.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
    const key = keyFor("claude");
    if (key) config.execution.claudeEnvironment.ANTHROPIC_API_KEY = key;
    config.execution.claudeEnvironment.ANTHROPIC_BASE_URL = p.connections.claude.endpoint;
  }
  // Never pass the encryption key or administration token to a provider subprocess.
  delete config.execution.claudeEnvironment.CONSOLE_SETTINGS_KEY;
  delete config.execution.claudeEnvironment.CONSOLE_ADMIN_TOKEN;
  config.provider.mcpServers = Object.fromEntries(values.integrations.servers.filter((s) => s.enabled).map((s) => {
    const secret = credential(`mcp:${s.name}`);
    const extras = secret ? JSON.parse(secret) as Record<string, string> : undefined;
    const inherited = deploymentMcp[s.name];
    return [s.name, s.transport === "http" ? { url: s.url, ...(extras ? { headers: extras } : inherited && "headers" in inherited ? { headers: inherited.headers } : {}) } : { command: s.command, args: s.args, ...(extras ? { env: extras } : inherited && "env" in inherited ? { env: inherited.env } : {}) }];
  }));
  const e = values.execution;
  Object.assign(config.provider, { effort: e.effort, continuation: e.continuation, continuationTtlMs: e.continuationTtlMs, mcpToolTimeoutMs: values.integrations.toolTimeoutMs });
  Object.assign(config.defaults, { budget: e.budget, orchestratorAllocation: e.orchestratorAllocation, nodeAllocation: e.nodeAllocation, maxWallClockMs: e.maxWallClockMs, completionCheck: e.completionCheck, evaluator: e.evaluator });
  Object.assign(config.governor, { providerMaxConcurrency: e.providerMaxConcurrency, processMaxAttempts: e.processMaxAttempts, maxWorktrees: e.maxWorktrees });
  config.driver.maxConcurrentRuns = e.maxConcurrentRuns;
  config.checks.commandTimeoutMs = e.checkTimeoutMs;
}
