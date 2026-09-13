import { z } from "zod";
import { MODEL_EFFORTS } from "./agents.ts";
import { allocationSchema, budgetLimitsSchema } from "./budgets.ts";
import { executionSelectionSchema, type ProviderDescriptor } from "./providers.ts";

export const SETTINGS_SECTIONS = ["general", "providers", "integrations", "execution", "workspaces", "security", "system"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export const CONNECTION_IDS = ["claude", "codex", "openai", "anthropic", "gateway"] as const;
export type ConnectionId = (typeof CONNECTION_IDS)[number];
export const settingsEndpointSchema = z.union([z.literal(""), z.url({ protocol: /^https?$/ }).max(2048).refine((value) => /^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/.test(value), "Use an HTTP(S) endpoint without credentials, query parameters, or a fragment.")]);
export const connectionSettingsSchema = z.strictObject({
  enabled: z.boolean(), auth: z.enum(["api_key", "local_login", "none", "deployment"]), endpoint: settingsEndpointSchema.refine((v) => v.length > 0, "An endpoint is required."),
});
export type ConnectionSettings = z.infer<typeof connectionSettingsSchema>;
export const settingsModelSchema = z.strictObject({
  id: executionSelectionSchema.shape.model, label: z.string().trim().min(1).max(160),
  efforts: z.array(z.enum(MODEL_EFFORTS)).max(5), contextWindowTokens: z.number().int().min(1).max(100_000_000),
  pricing: z.strictObject({ input: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(), output: z.number().nonnegative() }).optional(),
});
const models = z.array(settingsModelSchema).min(1).max(100).refine((items) => new Set(items.map((m) => m.id)).size === items.length, "Model identifiers must be unique.");
const providerId = z.enum(["claude", "codex", "ai-sdk"]);
export const serverNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).refine((s) => !["agentique", "__proto__", "constructor", "prototype"].includes(s));
export const integrationSettingsSchema = z.strictObject({
  name: serverNameSchema, enabled: z.boolean(), transport: z.enum(["stdio", "http"]),
  command: z.string().max(2048), args: z.array(z.string().max(2048)).max(100), url: settingsEndpointSchema,
}).superRefine((v, ctx) => {
  if (v.transport === "stdio" && !v.command.trim()) ctx.addIssue({ code: "custom", path: ["command"], message: "An installed executable is required." });
  if (v.transport === "http" && !v.url) ctx.addIssue({ code: "custom", path: ["url"], message: "An endpoint is required." });
});
export type IntegrationSettings = z.infer<typeof integrationSettingsSchema>;
const boundedBudget = budgetLimitsSchema.refine((b) => b.maxCostUsd <= 1_000_000 && b.maxTokens <= 1_000_000_000 && b.maxAttempts <= 100_000 && (b.maxConcurrency ?? 1) <= 256, "Budget exceeds the supported bound.");
const completionCheck = z.strictObject({ command: z.string().trim().min(1).max(4096), expectedExitCode: z.number().int().min(0).max(255) }).nullable();
export const workspaceSettingsSchema = z.strictObject({
  provider: providerId.optional(), model: executionSelectionSchema.shape.model.optional(),
  budget: boundedBudget.optional(), completionCheck: completionCheck.optional(), evaluator: z.enum(["reviewer", "none"]).optional(),
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
const tools = z.array(z.string().min(1).max(160)).max(500);
export const settingsValuesSchema = z.strictObject({
  general: z.strictObject({ theme: z.enum(["system", "light", "dark"]), sendShortcut: z.enum(["enter", "mod-enter"]), autoScroll: z.boolean(), notifications: z.boolean() }),
  providers: z.strictObject({
    defaultProvider: providerId,
    defaultModels: z.strictObject({ claude: executionSelectionSchema.shape.model, codex: executionSelectionSchema.shape.model, "ai-sdk": executionSelectionSchema.shape.model }),
    models: z.strictObject({ claude: models, codex: models, "ai-sdk": models }),
    connections: z.strictObject({ claude: connectionSettingsSchema, codex: connectionSettingsSchema, openai: connectionSettingsSchema, anthropic: connectionSettingsSchema, gateway: connectionSettingsSchema }),
    piHarness: z.boolean(),
  }),
  integrations: z.strictObject({ servers: z.array(integrationSettingsSchema).max(32).refine((v) => new Set(v.map((s) => s.name)).size === v.length, "Server names must be unique."), toolTimeoutMs: z.number().int().min(1000).max(3_600_000).nullable() }),
  execution: z.strictObject({
    effort: z.enum(MODEL_EFFORTS), budget: boundedBudget, orchestratorAllocation: allocationSchema, nodeAllocation: allocationSchema,
    maxWallClockMs: z.number().int().min(1000).max(604_800_000), completionCheck, evaluator: z.enum(["reviewer", "none"]),
    continuation: z.boolean(), continuationTtlMs: z.number().int().min(1).max(31_536_000_000).nullable(),
    providerMaxConcurrency: z.number().int().min(1).max(256), processMaxAttempts: z.number().int().min(1).max(256),
    maxWorktrees: z.number().int().min(1).max(256).nullable(), maxConcurrentRuns: z.number().int().min(1).max(256),
    checkTimeoutMs: z.number().int().min(1000).max(3_600_000),
  }),
  workspaces: z.record(z.string().regex(/^ws_[A-Za-z0-9_-]+$/), workspaceSettingsSchema),
  security: z.strictObject({ deniedTools: tools, approvalRequiredTools: tools, deniedMcpServers: tools }),
});
export type SettingsValues = z.infer<typeof settingsValuesSchema>;
export const secretUpdateSchema = z.strictObject({ action: z.enum(["replace", "remove"]), value: z.string().max(32_768).optional() });
export const settingsSaveSchema = z.strictObject({
  revision: z.number().int().nonnegative(), section: z.enum(SETTINGS_SECTIONS).exclude(["system"]), value: z.unknown(),
  secrets: z.record(z.string().regex(/^(claude|codex|openai|anthropic|gateway|mcp:[A-Za-z][A-Za-z0-9_-]{0,63})$/), secretUpdateSchema).optional(),
  acknowledgeExecutable: z.boolean().optional(),
});
export type SettingsSave = z.infer<typeof settingsSaveSchema>;
export const connectionTestSchema = z.strictObject({
  revision: z.number().int().nonnegative(), connection: z.enum(CONNECTION_IDS), config: connectionSettingsSchema,
  credential: z.string().max(32_768).optional(), model: executionSelectionSchema.shape.model.optional(),
});
export type ConnectionTestRequest = z.infer<typeof connectionTestSchema>;
export interface ConnectionTestResult {
  status: "verified" | "unverified" | "failed";
  checkedAt: string;
  check: string;
  authentication: "verified" | "not_tested" | "not_required" | "failed";
  modelAccess: "visible" | "not_tested" | "not_visible";
  model?: string;
  models: string[];
  message: string;
}
export interface CredentialMetadata { present: boolean; source: "saved" | "deployment" | "local_login" | "none"; updatedAt: string | null; locked: boolean }
export interface SettingsResponse {
  revision: number; values: SettingsValues;
  running: Pick<SettingsValues, "execution" | "security"> & { toolTimeoutMs: number | null };
  locks: Record<string, string>;
  sources: Record<string, "deployment" | "application" | "default">;
  credentials: Record<string, CredentialMetadata>;
  tests: Record<string, ConnectionTestResult>;
  providers: ProviderDescriptor[];
  restartRequired: string[];
  activeDependencies: { provider: string; count: number }[];
  system: { version: string; secretStorage: "available" | "unavailable"; adminMode: "local" | "token"; host: string; port: number; dataDir: string; codexHome: string; fsRoots: string[]; diagnosticsRetained: number; trustedOrigins: string[] };
}
export const settingsImportSchema = z.strictObject({ revision: z.number().int().nonnegative(), document: z.strictObject({ format: z.literal("agentique-settings"), version: z.literal(1), values: settingsValuesSchema }), acknowledgeExecutable: z.boolean().optional() });
export type SettingsExport = z.infer<typeof settingsImportSchema>["document"];
export const settingsResetSchema = z.strictObject({ revision: z.number().int().nonnegative(), section: z.enum(SETTINGS_SECTIONS).exclude(["system"]), confirmation: z.literal("RESET") });
export const mcpTestSchema = z.strictObject({ revision: z.number().int().nonnegative(), server: integrationSettingsSchema, secret: z.string().max(32_768).optional(), acknowledgeExecutable: z.boolean().optional() });
