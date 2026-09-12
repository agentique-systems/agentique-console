import path from "node:path";
import { z } from "zod";
import { executionSelectionSchema, MODEL_EFFORTS, type ExecutionSelection, type ProviderModel } from "@agentique-console/core";

export const PROVIDER_IDS = ["claude", "codex", "ai-sdk"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export interface ProviderConfiguration {
  defaults: ExecutionSelection;
  models: Record<ProviderId, ProviderModel[]>;
  defaultModels: Record<ProviderId, string>;
  codex: { home: string; apiKey?: string; baseUrl?: string; codexPathOverride?: string };
  aiSdk: { openai: { apiKey?: string; baseURL?: string }; anthropic: { apiKey?: string; baseURL?: string }; gateway: { apiKey?: string; baseURL?: string }; harness?: "pi" };
}

export class ProviderConfigError extends Error {
  constructor(readonly variable: string, message: string) { super(`${variable}: ${message}`); }
}

const modelSchema = z.strictObject({
  id: executionSelectionSchema.shape.model,
  label: z.string().min(1).max(160).optional(),
  efforts: z.array(z.enum(MODEL_EFFORTS)).default(["low", "medium", "high"]),
  contextWindowTokens: z.number().int().min(1).default(200_000),
  pricing: z.strictObject({ input: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(), output: z.number().nonnegative() }).optional(),
});
const catalogSchema = z.partialRecord(z.enum(PROVIDER_IDS), z.array(modelSchema).min(1).max(100));

/** Explicit model catalogs avoid accepting an embedding model, another backend's id, or a typo at launch. */
export function loadProviderConfiguration(env: NodeJS.ProcessEnv, dataDir: string): ProviderConfiguration {
  const provider = env.CONSOLE_PROVIDER?.trim() || "claude";
  if (!(PROVIDER_IDS as readonly string[]).includes(provider)) throw new ProviderConfigError("CONSOLE_PROVIDER", "expected claude, codex, or ai-sdk");
  const harness = env.CONSOLE_AI_SDK_HARNESS?.trim();
  if (harness && harness !== "pi") throw new ProviderConfigError("CONSOLE_AI_SDK_HARNESS", "expected pi or an empty value");
  const defaultModels = {
    claude: env.CONSOLE_CLAUDE_MODEL?.trim() || "claude-fable-5-1",
    codex: env.CONSOLE_CODEX_MODEL?.trim() || "gpt-5.6-terra",
    "ai-sdk": env.CONSOLE_AI_SDK_MODEL?.trim() || "openai/gpt-5.6-sol",
  };
  if (env.CONSOLE_MODEL?.trim()) defaultModels[provider as ProviderId] = env.CONSOLE_MODEL.trim();
  let overrides: z.infer<typeof catalogSchema> = {};
  if (env.CONSOLE_MODEL_CATALOG) {
    try { overrides = catalogSchema.parse(JSON.parse(env.CONSOLE_MODEL_CATALOG)); }
    catch { throw new ProviderConfigError("CONSOLE_MODEL_CATALOG", "expected an object of provider ids to model arrays with id, optional label, efforts, contextWindowTokens, and pricing"); }
  }
  const ids: Record<ProviderId, string[]> = {
    claude: [defaultModels.claude, "claude-fable-5-1", "claude-haiku-4-5-20251001"],
    codex: [defaultModels.codex, "gpt-5.6-terra", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna"],
    "ai-sdk": [defaultModels["ai-sdk"], "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "anthropic/claude-fable-5-1", ...(harness === "pi" ? ["pi/openai/gpt-5.5"] : [])],
  };
  const models = Object.fromEntries(PROVIDER_IDS.map((id) => {
    const variable = `CONSOLE_${id === "ai-sdk" ? "AI_SDK" : id.toUpperCase()}_MODELS`;
    const names = env[variable]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [...new Set(ids[id])];
    const entries = overrides[id]?.map((m) => ({ ...m, label: m.label ?? m.id })) ?? names.map((name) => ({ id: name, label: name, efforts: id === "ai-sdk" && !name.startsWith("openai/") && !name.startsWith("pi/") ? [] : [...MODEL_EFFORTS], contextWindowTokens: 200_000 }));
    if (!entries.length || new Set(entries.map((m) => m.id)).size !== entries.length) throw new ProviderConfigError(variable, "model list must be nonempty and unique");
    for (const model of entries) {
      if (!executionSelectionSchema.safeParse({ provider: id, model: model.id }).success) throw new ProviderConfigError(variable, "invalid model identifier");
      if (id === "claude" && !/^claude-|^(sonnet|opus|haiku)$/.test(model.id)) throw new ProviderConfigError(variable, "Claude models must be Claude model ids or aliases");
      if (id === "codex" && (model.id.includes("/") || model.id.startsWith("claude"))) throw new ProviderConfigError(variable, "Codex models use native OpenAI model ids");
      if (id === "ai-sdk" && !/^(openai|anthropic|gateway|pi)\/.+/.test(model.id)) throw new ProviderConfigError(variable, "AI SDK models use openai/, anthropic/, gateway/, or pi/ prefixes");
      if (id === "ai-sdk" && (/^(pi\/)?openai\/claude/.test(model.id) || /^(pi\/)?anthropic\/(?!claude-)/.test(model.id))) throw new ProviderConfigError(variable, "model family does not match its AI SDK provider");
      if (model.id.startsWith("pi/") && !/^pi\/(openai|anthropic)\/[^/]+$/.test(model.id)) throw new ProviderConfigError(variable, "configured Pi models support openai/ or anthropic/ model identifiers");
      if (model.id.startsWith("pi/") && harness !== "pi") throw new ProviderConfigError(variable, "pi/ models require CONSOLE_AI_SDK_HARNESS=pi");
    }
    if (!entries.some((m) => m.id === defaultModels[id])) throw new ProviderConfigError(variable, "the provider default model must be in its catalog");
    return [id, entries];
  })) as Record<ProviderId, ProviderModel[]>;
  const endpoint = (name: string): string | undefined => {
    const value = env[name]?.trim();
    if (!value) return undefined;
    try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(); }
    catch { throw new ProviderConfigError(name, "expected an HTTP(S) endpoint without embedded credentials"); }
    return value;
  };
  return {
    defaults: { provider, model: defaultModels[provider as ProviderId] }, models, defaultModels,
    codex: { home: path.resolve(env.CONSOLE_CODEX_HOME ?? path.join(dataDir, "providers", "codex")), ...(env.CODEX_API_KEY || env.OPENAI_API_KEY ? { apiKey: env.CODEX_API_KEY ?? env.OPENAI_API_KEY } : {}), ...(endpoint("CONSOLE_CODEX_BASE_URL") ? { baseUrl: endpoint("CONSOLE_CODEX_BASE_URL")! } : {}), ...(env.CONSOLE_CODEX_PATH ? { codexPathOverride: env.CONSOLE_CODEX_PATH } : {}) },
    aiSdk: {
      openai: { ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}), ...(endpoint("CONSOLE_OPENAI_BASE_URL") ? { baseURL: endpoint("CONSOLE_OPENAI_BASE_URL")! } : {}) },
      anthropic: { ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}), ...(endpoint("CONSOLE_ANTHROPIC_BASE_URL") ? { baseURL: endpoint("CONSOLE_ANTHROPIC_BASE_URL")! } : {}) },
      gateway: { ...(env.AI_GATEWAY_API_KEY ? { apiKey: env.AI_GATEWAY_API_KEY } : {}), ...(endpoint("CONSOLE_AI_GATEWAY_BASE_URL") ? { baseURL: endpoint("CONSOLE_AI_GATEWAY_BASE_URL")! } : {}) },
      ...(harness === "pi" ? { harness: "pi" as const } : {}),
    },
  };
}
