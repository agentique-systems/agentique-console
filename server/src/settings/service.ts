import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { CONNECTION_IDS, ConflictError, ValidationError, settingsValuesSchema, type ConnectionId, type ConnectionTestRequest, type ConnectionTestResult, type CredentialMetadata, type SettingsExport, type SettingsResponse, type SettingsSave, type SettingsSection, type SettingsValues, type WorkspaceSettings } from "@agentique-console/core";
import { deploymentEnvironment, type Config } from "../config.ts";
import { SettingsStore, type StoredSettings } from "../persistence/settings-store.ts";
import { checkConnection, guardedFetch, validateEndpoint, type CheckHttp } from "../provider/connection-check.ts";
import type { ProviderRegistry } from "../provider/registry.ts";
import { applyConfiguration, DEFAULT_ENDPOINTS, fromConfig, getPath, KEY_VARIABLES, localLoginPresent, locksOf, setPath, validateSettings } from "./configuration.ts";
import { SecretVault } from "./secrets.ts";
import { discoverMcp } from "../provider/mcp-discovery.ts";
import { mcpTestSchema } from "@agentique-console/core";

export function defaultModelFor(id: ConnectionId, values: SettingsValues): string | undefined {
  if (id === "claude" || id === "codex") return values.providers.defaultModels[id];
  const current = values.providers.defaultModels["ai-sdk"];
  return current.replace(/^pi\//, "").startsWith(`${id}/`) ? current : values.providers.models["ai-sdk"].find((m) => m.id.replace(/^pi\//, "").startsWith(`${id}/`))?.id;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const providerOf = (id: string) => id === "claude" || id === "codex" ? id : "ai-sdk";

/** One typed service owns effective configuration, provenance, protected credentials and atomic edits. */
export class SettingsService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly baseline: SettingsValues;
  private readonly locks: Record<string, string>;
  private readonly vault: SecretVault;
  private readonly deploymentMcp: Config["provider"]["mcpServers"];
  private readonly startup: SettingsValues;
  private readonly pendingTests = new Map<string, { fingerprint: string; result: ConnectionTestResult }>();
  private readonly fingerprintKey: Buffer;
  private testing = false;
  private lastTestAt = 0;
  private registry: ProviderRegistry | null = null;
  private rebuild: (() => ProviderRegistry) | null = null;
  constructor(readonly config: Config, private readonly store: SettingsStore, private readonly testHttp?: CheckHttp) {
    this.env = deploymentEnvironment(config);
    this.baseline = fromConfig(config, this.env);
    this.locks = locksOf(config, this.env);
    this.vault = new SecretVault(config.administration.key);
    this.fingerprintKey = config.administration.key ? Buffer.from(config.administration.key, "base64") : randomBytes(32);
    this.deploymentMcp = structuredClone(config.provider.mcpServers);
    const stored = this.store.read().document;
    for (const [id, secret] of Object.entries(stored.secrets)) this.vault.decrypt(id, secret.ciphertext);
    this.startup = this.effective(stored);
    if (Object.keys(stored.values).length) validateSettings(this.startup);
    applyConfiguration(config, this.startup, (id) => this.credential(id, stored), this.env, this.deploymentMcp);
  }
  attach(registry: ProviderRegistry, rebuild: () => ProviderRegistry): void { this.registry = registry; this.rebuild = rebuild; this.decorateRegistry(registry); }
  get general(): SettingsValues["general"] { return this.effective(this.store.read().document).general; }
  get policy(): SettingsValues["security"] { return this.startup.security; }
  workspace(id: string): WorkspaceSettings {
    const override = structuredClone(this.effective(this.store.read().document).workspaces[id] ?? {});
    if (this.locks["providers.defaultProvider"]) delete override.provider;
    if (this.locks[`providers.defaultModels.${override.provider ?? this.config.execution.defaults.provider}`]) delete override.model;
    if (override.budget) for (const key of Object.keys(override.budget)) if (this.locks[`execution.budget.${key}`]) setPath(override, `budget.${key}`, getPath(this.config.defaults.budget, key));
    if (this.locks["execution.completionCheck"]) delete override.completionCheck;
    if (this.locks["execution.evaluator"]) delete override.evaluator;
    return override;
  }
  assertRevision(revision: number): void { if (this.store.read().revision !== revision) throw new ConflictError("Settings changed in another window. Reload before continuing."); }
  private effective(document: StoredSettings): SettingsValues {
    const values = structuredClone({ ...this.baseline, ...document.values });
    for (const key of Object.keys(this.locks)) setPath(values, key, getPath(this.baseline, key));
    const result = settingsValuesSchema.safeParse(values);
    if (!result.success) throw new ValidationError("Stored settings are invalid. Restore a compatible settings backup.");
    return result.data;
  }
  credential(id: string, document = this.store.read().document): string | undefined {
    if ((CONNECTION_IDS as readonly string[]).includes(id)) { const key = KEY_VARIABLES[id as ConnectionId].find((name) => !!this.env[name]); if (key) return this.env[key]; }
    const saved = document.secrets[id]; return saved ? this.vault.decrypt(id, saved.ciphertext) : undefined;
  }
  private metadata(id: string, document: StoredSettings, values: SettingsValues): CredentialMetadata {
    if ((CONNECTION_IDS as readonly string[]).includes(id)) {
      const cid = id as ConnectionId;
      if (KEY_VARIABLES[cid].some((key) => !!this.env[key]) || values.providers.connections[cid].auth === "deployment") return { present: true, source: "deployment", updatedAt: null, locked: true };
      if (values.providers.connections[cid].auth === "local_login") return { present: localLoginPresent(cid, this.config, this.env), source: "local_login", updatedAt: null, locked: true };
    }
    const saved = document.secrets[id]; const inherited = id.startsWith("mcp:") ? this.deploymentMcp[id.slice(4)] : undefined;
    if (inherited && (("env" in inherited && inherited.env) || ("headers" in inherited && inherited.headers))) return { present: true, source: "deployment", updatedAt: null, locked: true };
    return { present: !!saved, source: saved ? "saved" : "none", updatedAt: saved?.updatedAt ?? null, locked: false };
  }
  private fingerprint(id: ConnectionId, config: ConnectionTestRequest["config"], secret: string | undefined, model?: string): string {
    return createHmac("sha256", this.fingerprintKey).update(JSON.stringify([id, config, secret ?? "", model ?? "", localLoginPresent(id, this.config, this.env)])).digest("hex");
  }
  view(): SettingsResponse {
    const { revision, document } = this.store.read(); const values = this.effective(document);
    const credentials = Object.fromEntries([...CONNECTION_IDS, ...values.integrations.servers.map((s) => `mcp:${s.name}`)].map((id) => [id, this.metadata(id, document, values)]));
    const tests: Record<string, ConnectionTestResult> = {};
    for (const id of CONNECTION_IDS) { const saved = document.tests[id]; if (saved && saved.fingerprint === this.fingerprint(id, values.providers.connections[id], this.credential(id), defaultModelFor(id, values))) tests[id] = saved.result; }
    const sources: SettingsResponse["sources"] = {};
    const walk = (value: unknown, prefix = "") => {
      if (value && typeof value === "object" && !Array.isArray(value)) { for (const [key, item] of Object.entries(value)) walk(item, prefix ? `${prefix}.${key}` : key); return; }
      sources[prefix] = Object.keys(this.locks).some((k) => prefix === k || prefix.startsWith(`${k}.`)) ? "deployment" : Object.hasOwn(document.values, prefix.split(".")[0]!) ? "application" : "default";
    }; walk(values);
    for (const server of values.integrations.servers) { const id = `mcp:${server.name}`; const saved = document.tests[id]; if (saved && saved.fingerprint === this.mcpFingerprint(server, this.mcpSecret(server.name, document))) tests[id] = saved.result; }
    return { revision, values, running: { execution: structuredClone(this.startup.execution), security: structuredClone(this.startup.security), toolTimeoutMs: this.startup.integrations.toolTimeoutMs }, locks: { ...this.locks }, sources, credentials, tests, providers: this.registry?.catalog() ?? [],
      restartRequired: [!same(values.execution, this.startup.execution) ? "Agents & execution" : "", !same(values.security, this.startup.security) ? "Approval policy" : "", values.integrations.toolTimeoutMs !== this.startup.integrations.toolTimeoutMs ? "Tool timeout" : ""].filter(Boolean), activeDependencies: this.store.activeDependencies(),
      system: { version: "0.1.0", secretStorage: this.vault.available ? "available" : "unavailable", adminMode: this.config.administration.token ? "token" : "local", host: this.config.host, port: this.config.port, dataDir: this.config.dataDir, codexHome: this.config.execution.codex.home, fsRoots: this.config.fsRoots.map((r) => r.path), diagnosticsRetained: this.config.driver.diagnosticsRetained, trustedOrigins: this.config.administration.trustedOrigins },
    };
  }
  private guard(values: SettingsValues, previous: SettingsValues, document: StoredSettings, before: StoredSettings, acknowledgeExecutable: boolean): void {
    validateSettings(values);
    for (const key of Object.keys(this.locks)) if (!same(getPath(values, key), getPath(this.baseline, key))) throw new ValidationError(`This setting is locked by deployment: ${key}.`);
    const active = this.store.activeDependencies();
    for (const id of CONNECTION_IDS) {
      const connection = values.providers.connections[id]; const old = previous.providers.connections[id];
      if (!same(connection, old)) validateEndpoint(connection.endpoint, [new URL(DEFAULT_ENDPOINTS[id]).origin], this.config.administration.trustedOrigins);
      if (connection.auth === "none" && !this.config.administration.trustedOrigins.includes(new URL(connection.endpoint).origin)) throw new ValidationError("Unauthenticated endpoints require explicit deployment trust.");
      const changedSecret = !same(document.secrets[id], before.secrets[id]);
      if (!same(connection, old) || changedSecret) {
        if (active.some((a) => a.provider === providerOf(id))) throw new ConflictError("Active conversations or work depend on this connection. Finish or stop them before replacing credentials, changing endpoints, or disabling it. Changing defaults remains available.");
        if (new URL(connection.endpoint).origin !== new URL(old.endpoint).origin && this.credential(id, before) && !changedSecret) throw new ValidationError("Re-enter the credential to authorize sending it to the new endpoint origin.");
      }
    }
    for (const provider of ["claude", "codex", "ai-sdk"] as const) {
      const removed = previous.providers.models[provider].some((m) => !values.providers.models[provider].some((n) => same(m, n)));
      if (removed && active.some((a) => a.provider === provider)) throw new ConflictError("Active conversations depend on this model catalog. Keep their models until the conversations have stopped.");
    }
    if (values.providers.piHarness !== previous.providers.piHarness && active.some((a) => a.provider === "ai-sdk")) throw new ConflictError("Stop active AI SDK conversations before changing the harness.");
    if (!same(values.integrations.servers, previous.integrations.servers) || Object.keys(document.secrets).concat(Object.keys(before.secrets)).some((id) => id.startsWith("mcp:") && !same(document.secrets[id], before.secrets[id]))) {
      if (active.length) throw new ConflictError("Stop active conversations and work before changing MCP connections. Existing tool permissions remain unchanged.");
      for (const server of values.integrations.servers) {
        const slot = `mcp:${server.name}`;
        const old = previous.integrations.servers.find((s) => s.name === server.name);
        if (old && !same({ ...server, enabled: old.enabled }, old) && this.mcpSecret(server.name, before) && same(document.secrets[slot], before.secrets[slot])) throw new ValidationError("Re-enter protected values to authorize a changed MCP connection.");
        if (server.transport === "http") validateEndpoint(server.url, [], this.config.administration.trustedOrigins);
        if (server.transport === "stdio" && !same(server, previous.integrations.servers.find((s) => s.name === server.name))) {
          if (!acknowledgeExecutable) throw new ValidationError("Confirm the privileged executable configuration before saving.");
          if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(server.command)) throw new ValidationError("MCP configuration requires an absolute path to an already installed executable. Package-runner installation is not performed.");
        }
      }
    }
    const publicText = JSON.stringify(values);
    const protectedValues = [...CONNECTION_IDS.map((id) => this.credential(id, document)), ...values.integrations.servers.flatMap((s) => Object.values(JSON.parse(this.mcpSecret(s.name, document) ?? "{}") as Record<string, string>))];
    if (protectedValues.some((secret) => secret && publicText.includes(secret))) throw new ValidationError("A credential was found in a non-secret setting. Use the credential field instead.");
  }
  save(input: SettingsSave): SettingsResponse {
    this.assertRevision(input.revision);
    const { document: before } = this.store.read(); const document = structuredClone(before); const previous = this.effective(before); const values = structuredClone(previous);
    const parsed = settingsValuesSchema.shape[input.section].safeParse(input.value);
    if (!parsed.success) { const issue = parsed.error.issues[0]; throw new ValidationError(`Invalid ${input.section} settings: ${issue?.path.join(".") || "section"}. ${issue?.message ?? "Check the form."}`); }
    Object.assign(values, { [input.section]: parsed.data });
    for (const [id, change] of Object.entries(input.secrets ?? {})) {
      if ((input.section === "providers" && id.startsWith("mcp:")) || (input.section === "integrations" && !id.startsWith("mcp:")) || !["providers", "integrations"].includes(input.section)) throw new ValidationError("Credential update does not belong to this section.");
      if (this.metadata(id, before, previous).source === "deployment") throw new ValidationError("Deployment credentials are locked. Update them through the deployment secret manager.");
      if (change.action === "remove") delete document.secrets[id];
      else if (change.value?.trim()) {
        if (id.startsWith("mcp:") && !values.integrations.servers.some((s) => `mcp:${s.name}` === id)) throw new ValidationError("Protected values must belong to a configured MCP server.");
        let value = change.value.trim();
        if (id.startsWith("mcp:")) value = validateMcpSecret(value);
        document.secrets[id] = { ciphertext: this.vault.encrypt(id, value), updatedAt: new Date().toISOString() };
      }
    }
    this.guard(values, previous, document, before, input.acknowledgeExecutable === true);
    document.values[input.section] = values[input.section] as never;
    for (const [id, test] of this.pendingTests) {
      const server = values.integrations.servers.find((s) => `mcp:${s.name}` === id);
      const fingerprint = id.startsWith("mcp:") ? server ? this.mcpFingerprint(server, this.mcpSecret(server.name, document)) : null : this.fingerprint(id as ConnectionId, values.providers.connections[id as ConnectionId], this.credential(id, document), defaultModelFor(id as ConnectionId, values));
      if (test.fingerprint === fingerprint && Date.now() - Date.parse(test.result.checkedAt) < 300_000) document.tests[id] = test;
    }
    this.store.write(input.revision, document); this.applyLive(values); return this.view();
  }
  private applyLive(values: SettingsValues): void {
    const immediate = { ...values, execution: this.startup.execution, security: this.startup.security, integrations: { ...values.integrations, toolTimeoutMs: this.startup.integrations.toolTimeoutMs } };
    applyConfiguration(this.config, immediate, (id) => this.credential(id), this.env, this.deploymentMcp);
    if (this.registry && this.rebuild) { const next = this.rebuild(); this.decorateRegistry(next); this.registry.replace(next); }
  }
  private decorateRegistry(registry: ProviderRegistry): void {
    const values = this.effective(this.store.read().document);
    registry.configureAvailability((provider, model) => {
      const id = provider === "claude" || provider === "codex" ? provider : model.replace(/^pi\//, "").split("/")[0] as ConnectionId;
      const connection = values.providers.connections[id];
      if (!connection || !connection.enabled) return { configured: false, detail: "This connection is disabled in Settings." };
      if (connection.auth === "none") return { configured: true, detail: "Trusted compatible endpoint without authentication; generation access is unverified." };
      if (connection.auth === "local_login" || connection.auth === "deployment") return { configured: true, detail: "The SDK owns authentication. Credential presence is not authentication or model entitlement." };
      return { configured: !!this.credential(id), detail: this.credential(id) ? "Credential configured; check authentication and model visibility in Settings." : "Configure a credential in Settings → Providers & models." };
    });
  }
  async test(request: ConnectionTestRequest): Promise<ConnectionTestResult> {
    this.assertRevision(request.revision);
    if (this.testing || Date.now() - this.lastTestAt < 1000) throw new ConflictError("A connection check is running or was just completed. Wait a moment before retrying.");
    const current = this.effective(this.store.read().document); const candidate = structuredClone(current); candidate.providers.connections[request.connection] = request.config; validateSettings(candidate);
    const url = validateEndpoint(request.config.endpoint, [new URL(DEFAULT_ENDPOINTS[request.connection]).origin], this.config.administration.trustedOrigins);
    if (request.config.auth === "none" && !this.config.administration.trustedOrigins.includes(url.origin)) throw new ValidationError("Unauthenticated endpoints require explicit deployment trust.");
    const old = current.providers.connections[request.connection];
    if (new URL(old.endpoint).origin !== url.origin && !request.credential?.trim() && this.credential(request.connection)) throw new ValidationError("Re-enter the credential before testing a different endpoint origin.");
    if (this.metadata(request.connection, this.store.read().document, current).source === "deployment" && (request.credential || new URL(old.endpoint).origin !== url.origin)) throw new ValidationError("Deployment credentials cannot be replaced or forwarded to a different origin.");
    const credential = request.credential?.trim() || this.credential(request.connection);
    this.testing = true; this.lastTestAt = Date.now();
    try {
      const result = await checkConnection(request, credential, localLoginPresent(request.connection, this.config, this.env), this.testHttp ?? guardedFetch(url.origin, this.config.administration.trustedOrigins));
      this.assertRevision(request.revision);
      this.pendingTests.set(request.connection, { fingerprint: this.fingerprint(request.connection, request.config, credential, request.model), result });
      return result;
    } finally { this.testing = false; }
  }
  async testMcp(body: z.infer<typeof mcpTestSchema>): Promise<ConnectionTestResult> {
    this.assertRevision(body.revision);
    if (this.testing || Date.now() - this.lastTestAt < 1000) throw new ConflictError("A connection check is running or was just completed. Wait before retrying.");
    const current = this.effective(this.store.read().document).integrations.servers.find((s) => s.name === body.server.name);
    const inherited = this.deploymentMcp[body.server.name];
    const inheritedSecrets = inherited ? ("url" in inherited ? inherited.headers : inherited.env) : undefined;
    const saved = this.credential(`mcp:${body.server.name}`) ?? (inheritedSecrets ? JSON.stringify(inheritedSecrets) : undefined);
    if (saved && !same(current, body.server) && !body.secret?.trim()) throw new ValidationError("Re-enter protected values before testing a changed MCP connection. Saved credentials are never forwarded to a different connection.");
    if (inheritedSecrets && (!same(current, body.server) || body.secret?.trim())) throw new ValidationError("Deployment MCP credentials are locked to their configured connection.");
    const secret = body.secret?.trim() || saved;
    const extras = secret ? JSON.parse(validateMcpSecret(secret)) as Record<string, string> : {};
    this.testing = true; this.lastTestAt = Date.now();
    try {
      const result = await discoverMcp(body.server, extras, this.config.administration.trustedOrigins, body.acknowledgeExecutable === true);
      this.assertRevision(body.revision);
      this.pendingTests.set(`mcp:${body.server.name}`, { fingerprint: this.mcpFingerprint(body.server, secret), result });
      return result;
    }
    finally { this.testing = false; }
  }
  private mcpSecret(name: string, document = this.store.read().document): string | undefined {
    const inherited = this.deploymentMcp[name];
    const values = inherited ? "url" in inherited ? inherited.headers : inherited.env : undefined;
    return values ? JSON.stringify(values) : this.credential(`mcp:${name}`, document);
  }
  private mcpFingerprint(server: z.infer<typeof mcpTestSchema>["server"], secret: string | undefined): string {
    return createHmac("sha256", this.fingerprintKey).update(JSON.stringify([server, secret ? JSON.parse(secret) : {}])).digest("hex");
  }
  export(): SettingsExport { return { format: "agentique-settings", version: 1, values: this.effective(this.store.read().document) }; }
  import(revision: number, data: SettingsExport, acknowledgeExecutable: boolean): SettingsResponse {
    this.assertRevision(revision); const before = this.store.read().document; const previous = this.effective(before); const document = structuredClone(before);
    this.guard(data.values, previous, document, before, acknowledgeExecutable); document.values = data.values; document.tests = {};
    this.store.write(revision, document); this.applyLive(data.values); return this.view();
  }
  reset(revision: number, section: Exclude<SettingsSection, "system">): SettingsResponse {
    this.assertRevision(revision); const before = this.store.read().document; const document = structuredClone(before); delete document.values[section];
    const next = this.effective(document); this.guard(next, this.effective(before), document, before, true);
    document.tests = {}; this.store.write(revision, document); this.applyLive(next); return this.view();
  }
}

export function validateMcpSecret(value: string): string {
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new ValidationError("MCP secrets must be a JSON object of environment variables or HTTP headers."); }
  const secret = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/), z.string().max(8192)).safeParse(parsed);
  if (!secret.success || Object.keys(secret.data).length > 50) throw new ValidationError("MCP secrets must contain at most 50 named string values.");
  const forbidden = ["host", "cookie", "connection", "content-length", "transfer-encoding", "console_settings_key", "console_admin_token"];
  if (Object.keys(secret.data).some((k) => forbidden.includes(k.toLowerCase()))) throw new ValidationError("MCP secrets include a reserved header or administrative environment name.");
  return JSON.stringify(secret.data);
}
