import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponse, SettingsValues, WorkspaceResponse, ConversationResponse } from "@agentique-console/core";
import { openTestApp, removeAppDirectory, type TestApp } from "../api/test-support.ts";
import { returned } from "../api/e2e-fixture.ts";
import { SecretVault } from "./secrets.ts";
import { checkConnection, guardedFetch, isPublicAddress, validateEndpoint } from "../provider/connection-check.ts";
import { createServer } from "node:http";

const key = Buffer.alloc(32, 7).toString("base64");
const secret = "fixture-credential-without-standard-prefix";
const opened: TestApp[] = [];
afterEach(async () => { for (const t of opened.splice(0)) { await t.close(); removeAppDirectory(t.dir); } });
async function fixture(env: NodeJS.ProcessEnv = {}, http?: (url: string, init: RequestInit) => Promise<Response>) {
  const t = await openTestApp({ env: { CONSOLE_SETTINGS_KEY: key, ...env }, ...(http ? { connectionCheckHttp: http } : {}) }); opened.push(t); return t;
}
async function request(t: TestApp, method: "GET" | "PATCH" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await t.app.server.inject({ method, url, headers: { host: "localhost", "x-console-settings": "1", ...headers }, ...(body === undefined ? {} : { payload: body as never }) });
  return { status: response.statusCode, body: response.json() as SettingsResponse, text: response.body, headers: response.headers };
}
const view = async (t: TestApp) => (await request(t, "GET", "/api/settings")).body;
async function save(t: TestApp, section: keyof SettingsValues, value: unknown, secrets?: Record<string, { action: string; value?: string }>, revision?: number) { return request(t, "PATCH", "/api/settings", { revision: revision ?? (await view(t)).revision, section, value, ...(secrets ? { secrets } : {}) }); }
function apiKeyProvider(v: SettingsResponse) { const p = structuredClone(v.values.providers); p.connections.claude.auth = "api_key"; return p; }

describe("encrypted credential storage", () => {
  it("authenticates ciphertext and slot identity, rejects missing and wrong keys, and uses unique nonces", () => {
    const vault = new SecretVault(key); const payload = vault.encrypt("claude", secret);
    expect(payload).not.toContain(secret); expect(vault.decrypt("claude", payload)).toBe(secret);
    expect(vault.encrypt("claude", secret)).not.toBe(payload);
    expect(() => vault.decrypt("codex", payload)).toThrow(/decryption failed/);
    expect(() => new SecretVault(Buffer.alloc(32, 8).toString("base64")).decrypt("claude", payload)).toThrow(/decryption failed/);
    expect(() => new SecretVault().encrypt("claude", secret)).toThrow(/unavailable/);
    expect(() => new SecretVault().decrypt("claude", payload)).toThrow(/Restore/);
    expect(() => new SecretVault("short")).toThrow(/32-byte/);
  });
  it("persists replacement/removal and metadata atomically; blank preserves the existing credential", async () => {
    const t = await fixture(); const initial = await view(t); const p = apiKeyProvider(initial);
    const saved = await save(t, "providers", p, { claude: { action: "replace", value: secret } });
    expect(saved.status, saved.text).toBe(200); expect(saved.body.credentials.claude).toMatchObject({ present: true, source: "saved" });
    expect(saved.text).not.toContain(secret); expect(t.app.settings.credential("claude")).toBe(secret);
    const raw = t.app.runtime.database.sqlite.prepare("SELECT document FROM application_settings").get() as { document: string };
    expect(raw.document).not.toContain(secret); expect(raw.document).toContain("v1.");
    const blank = await save(t, "providers", p, { claude: { action: "replace", value: " " } });
    expect(blank.status).toBe(200); expect(t.app.settings.credential("claude")).toBe(secret);
    await save(t, "providers", p, { claude: { action: "replace", value: "replacement-private-value" } });
    expect(t.app.config.execution.claudeEnvironment?.ANTHROPIC_API_KEY).toBe("replacement-private-value");
    const exported = await request(t, "GET", "/api/settings/export"); expect(exported.text).not.toMatch(/replacement-private-value|ciphertext|updatedAt/);
    await save(t, "providers", p, { claude: { action: "remove" } });
    expect(t.app.settings.credential("claude")).toBeUndefined(); expect((await view(t)).credentials.claude?.present).toBe(false);
  });
  it("refuses to store credentials without a separately provisioned key", async () => {
    const t = await fixture({ CONSOLE_SETTINGS_KEY: undefined }); const initial = await view(t);
    expect(initial.system.secretStorage).toBe("unavailable");
    const result = await save(t, "providers", apiKeyProvider(initial), { claude: { action: "replace", value: secret } });
    expect(result.status).toBe(400); expect(result.text).not.toContain(secret); expect((await view(t)).revision).toBe(0);
  });
});

describe("authoritative settings and restart", () => {
  it("loads saved settings and encrypted credentials after a full application restart", async () => {
    const t = await fixture(); const initial = await view(t);
    await save(t, "general", { ...initial.values.general, theme: "dark", sendShortcut: "mod-enter" });
    await save(t, "providers", apiKeyProvider(initial), { claude: { action: "replace", value: secret } });
    const revision = (await view(t)).revision;
    await t.close(); opened.splice(opened.indexOf(t), 1);
    const restarted = await openTestApp({ dir: t.dir, env: { CONSOLE_SETTINGS_KEY: key } }); opened.push(restarted);
    expect((await view(restarted)).revision).toBe(revision);
    expect(restarted.app.settings.general).toMatchObject({ theme: "dark", sendShortcut: "mod-enter" });
    expect(restarted.app.config.execution.claudeEnvironment?.ANTHROPIC_API_KEY).toBe(secret);
  });
  it("rejects stale writers and invalid settings without partially changing credentials", async () => {
    const t = await fixture(); const initial = await view(t);
    expect((await save(t, "general", { ...initial.values.general, theme: "dark" }, undefined, 0)).status).toBe(200);
    expect((await save(t, "general", initial.values.general, undefined, 0)).status).toBe(409);
    const p = apiKeyProvider(initial); p.defaultModels.claude = "claude-typo";
    expect((await save(t, "providers", p, { claude: { action: "replace", value: secret } })).status).toBe(400);
    expect(t.app.settings.credential("claude")).toBeUndefined(); expect((await view(t)).values.general.theme).toBe("dark");
    expect((await save(t, "general", { ...initial.values.general, unknown: true })).status).toBe(400);
  });
  it("keeps deployment values and credentials locked, including through import", async () => {
    const t = await fixture({ CONSOLE_PROVIDER: "codex", CODEX_API_KEY: secret }); const initial = await view(t);
    expect(initial.locks["providers.defaultProvider"]).toBe("CONSOLE_PROVIDER"); expect(initial.credentials.codex?.source).toBe("deployment");
    const p = structuredClone(initial.values.providers); p.defaultProvider = "claude";
    expect((await save(t, "providers", p)).status).toBe(400);
    expect((await save(t, "providers", initial.values.providers, { codex: { action: "remove" } })).status).toBe(400);
    expect((await request(t, "POST", "/api/settings/import", { revision: 0, document: { format: "agentique-settings", version: 1, values: { ...initial.values, providers: p } } })).status).toBe(400);
    expect((await view(t)).revision).toBe(0);
  });
  it("preserves SDK OAuth and cloud authentication without converting a token into an API key", async () => {
    const t = await fixture({ CLAUDE_CODE_OAUTH_TOKEN: secret }); const initial = await view(t);
    expect(initial.values.providers.connections.claude.auth).toBe("deployment");
    expect(initial.credentials.claude?.source).toBe("deployment");
    expect(t.app.config.execution.claudeEnvironment?.CLAUDE_CODE_OAUTH_TOKEN).toBe(secret);
    expect(t.app.config.execution.claudeEnvironment?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(initial)).not.toContain(secret);
    const p = structuredClone(initial.values.providers); p.connections.claude.auth = "api_key";
    expect((await save(t, "providers", p)).status).toBe(400);
  });
  it("applies execution changes after restart and does not mutate the running limits", async () => {
    const t = await fixture(); const initial = await view(t); const before = t.app.config.defaults.budget.maxTokens;
    const execution = structuredClone(initial.values.execution); execution.budget.maxTokens += 2000;
    const saved = await save(t, "execution", execution); expect(saved.status, saved.text).toBe(200);
    expect(saved.body.restartRequired).toContain("Agents & execution"); expect(t.app.config.defaults.budget.maxTokens).toBe(before);
    await t.close(); opened.splice(opened.indexOf(t), 1);
    const restarted = await openTestApp({ dir: t.dir, env: { CONSOLE_SETTINGS_KEY: key } }); opened.push(restarted);
    expect(restarted.app.config.defaults.budget.maxTokens).toBe(before + 2000); expect((await view(restarted)).restartRequired).toEqual([]);
  });
  it("imports non-secret settings atomically and requires explicit reset confirmation", async () => {
    const t = await fixture(); const initial = await view(t); const values = structuredClone(initial.values); values.general.theme = "light";
    const imported = await request(t, "POST", "/api/settings/import", { revision: 0, document: { format: "agentique-settings", version: 1, values } });
    expect(imported.status, imported.text).toBe(200); expect(imported.body.values.general.theme).toBe("light");
    expect((await request(t, "POST", "/api/settings/reset", { revision: 1, section: "general" })).status).toBe(400);
    const reset = await request(t, "POST", "/api/settings/reset", { revision: 1, section: "general", confirmation: "RESET" });
    expect(reset.status).toBe(200); expect(reset.body.values.general.theme).toBe("system");
  });
});

describe("provider checks and execution", () => {
  it("tests an unsaved credential, saves verification, and invalidates it on replacement", async () => {
    const http = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ data: [{ id: "claude-fable-5-1" }, { id: secret }] }));
    const t = await fixture({}, http); const initial = await view(t); const p = apiKeyProvider(initial);
    const result = await request(t, "POST", "/api/settings/test-connection", { revision: 0, connection: "claude", config: p.connections.claude, credential: secret, model: p.defaultModels.claude });
    expect(result.status, result.text).toBe(200); expect(result.body).toMatchObject({ status: "verified", authentication: "verified", modelAccess: "visible" }); expect(result.text).not.toContain(secret);
    expect(http).toHaveBeenCalledWith("https://api.anthropic.com/v1/models", expect.objectContaining({ method: "GET", headers: { "x-api-key": secret, "anthropic-version": "2023-06-01" } }));
    expect(t.sdk.captured.options).toHaveLength(0); expect(t.app.settings.credential("claude")).toBeUndefined();
    const saved = await save(t, "providers", p, { claude: { action: "replace", value: secret } });
    expect(saved.body.tests.claude?.status).toBe("verified");
    const replaced = await save(t, "providers", p, { claude: { action: "replace", value: "second-private-key" } });
    expect(replaced.body.tests.claude).toBeUndefined();
  });
  it("distinguishes failed credentials, unavailable models, and public Gateway discovery", async () => {
    const request = { revision: 0, connection: "openai" as const, config: { enabled: true, auth: "api_key" as const, endpoint: "https://api.openai.com/v1" }, model: "openai/example" };
    const unauthorized = await checkConnection(request, secret, false, async () => Response.json({ error: secret }, { status: 401 }));
    expect(unauthorized).toMatchObject({ status: "failed", authentication: "failed" }); expect(JSON.stringify(unauthorized)).not.toContain(secret);
    const missing = await checkConnection(request, secret, false, async () => Response.json({ data: [{ id: "different" }] }));
    expect(missing).toMatchObject({ status: "unverified", authentication: "verified", modelAccess: "not_visible" });
    const http = vi.fn(async () => Response.json({ data: [{ id: "openai/example" }] }));
    const gateway = await checkConnection({ ...request, connection: "gateway", model: "gateway/openai/example" }, secret, false, http);
    expect(gateway).toMatchObject({ status: "unverified", authentication: "not_tested" }); expect(http).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: {} }));
  });
  it("checks SDK login sources without starting a session or treating presence as authentication", async () => {
    const http = vi.fn(); const request = { revision: 0, connection: "codex" as const, config: { enabled: true, auth: "local_login" as const, endpoint: "https://api.openai.com/v1" }, model: "gpt-example" };
    expect(await checkConnection(request, undefined, true, http)).toMatchObject({ status: "unverified", authentication: "not_tested", modelAccess: "not_tested" });
    expect(await checkConnection(request, undefined, false, http)).toMatchObject({ status: "failed", authentication: "not_tested" }); expect(http).not.toHaveBeenCalled();
  });
  it("uses saved provider credentials and model in the real conversation execution path and pins active identity", async () => {
    const t = await fixture(); const initial = await view(t); const p = apiKeyProvider(initial);
    p.defaultModels.claude = "claude-haiku-4-5-20251001";
    expect((await save(t, "providers", p, { claude: { action: "replace", value: secret } })).status).toBe(200);
    const folder = path.join(t.dir, "workspace"); fs.mkdirSync(folder);
    const workspace = await t.call<WorkspaceResponse>("createWorkspace", { body: { rootPath: folder } });
    const conversation = await t.call<ConversationResponse>("createConversation", { body: { workspaceId: workspace.body.workspace.id } });
    t.sdk.script({ steps: [returned("Hello", { conversation: { reply: "Hello from configured Claude", work: null } })] });
    const message = await t.call("postConversationMessage", { params: { conversationId: conversation.body.conversation.id }, body: { content: "Hello", requestId: "settings-runtime" } });
    expect(message.status, JSON.stringify(message.body)).toBe(201); await t.app.host.idle();
    expect(t.sdk.captured.options[0]?.model).toBe("claude-haiku-4-5-20251001");
    expect(t.sdk.captured.options[0]?.env?.ANTHROPIC_API_KEY).toMatch(/^[a-f0-9]{64}$/);
    expect(t.sdk.captured.options[0]?.env?.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(t.sdk.captured.options[0]?.env?.CONSOLE_SETTINGS_KEY).toBeUndefined();
    p.defaultModels.claude = "claude-fable-5-1"; expect((await save(t, "providers", p)).status).toBe(200);
    expect(t.app.runtime.stores.runs.listByConversation(conversation.body.conversation.id)[0]?.execution?.model).toBe("claude-haiku-4-5-20251001");
    const disabled = structuredClone(p); disabled.connections.claude.enabled = false;
    expect((await save(t, "providers", disabled)).status).toBe(409);
    expect((await save(t, "providers", p, { claude: { action: "remove" } })).status).toBe(409);
  });
  it("consumes workspace overrides and leaves defaults inherited when overrides are removed", async () => {
    const t = await fixture(); const v = await view(t); const folder = path.join(t.dir, "workspace"); fs.mkdirSync(folder);
    const w = await t.call<WorkspaceResponse>("createWorkspace", { body: { rootPath: folder } }); const id = w.body.workspace.id;
    const budget = { ...v.values.execution.budget, maxTokens: 4_000_000 };
    expect((await save(t, "workspaces", { [id]: { model: "claude-haiku-4-5-20251001", budget } })).status).toBe(200);
    const c = await t.call<ConversationResponse>("createConversation", { body: { workspaceId: id } });
    t.sdk.script({ steps: [returned("Hello", { conversation: { reply: "Workspace defaults", work: null } })] });
    await t.call("postConversationMessage", { params: { conversationId: c.body.conversation.id }, body: { content: "Hello" } }); await t.app.host.idle();
    expect(t.sdk.captured.options[0]?.model).toBe("claude-haiku-4-5-20251001");
    expect((await save(t, "workspaces", {})).status).toBe(200); expect(t.app.settings.workspace(id)).toEqual({});
  });
});

describe("administration and network boundaries", () => {
  it("requires local peers, a safe Host, same origin, and the custom mutation header", async () => {
    const t = await fixture();
    for (const options of [{ remoteAddress: "192.0.2.44", headers: { host: "localhost" } }, { headers: { host: "attacker.example" } }, { headers: { host: "localhost", origin: "https://attacker.example" } }, { headers: { host: "localhost", "sec-fetch-site": "cross-site" } }]) {
      expect((await t.app.server.inject({ method: "GET", url: "/api/settings", ...options })).statusCode).toBe(403);
    }
    expect((await t.app.server.inject({ method: "PATCH", url: "/api/settings", headers: { host: "localhost" }, payload: {} })).statusCode).toBe(403);
    expect((await request(t, "GET", "/api/settings")).headers["cache-control"]).toBe("no-store");
    for (const url of ["/api/%73ettings", "/api/settings/", "/api/settings%2fexport"]) expect((await t.app.server.inject({ method: "GET", url, remoteAddress: "192.0.2.44", headers: { host: "localhost" } })).statusCode).toBeGreaterThanOrEqual(400);
  });
  it("requires a deployment bearer token and HTTPS origin for remote administration", async () => {
    const token = "administration-token-at-least-32-characters";
    const t = await fixture({ CONSOLE_ADMIN_TOKEN: token, CONSOLE_PUBLIC_ORIGIN: "https://console.example" });
    expect((await request(t, "GET", "/api/settings")).status).toBe(403);
    const allowed = await t.app.server.inject({ method: "GET", url: "/api/settings", remoteAddress: "192.0.2.44", headers: { host: "console.example", origin: "https://console.example", authorization: `Bearer ${token}` } });
    expect(allowed.statusCode).toBe(200); expect(allowed.body).not.toContain(token);
  });
  it("refuses private addresses, unsafe endpoints, and credential forwarding to an unapproved host", async () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.20.1.1", "192.168.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1"]) expect(isPublicAddress(address), address).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    for (const endpoint of ["file:///etc/passwd", "https://user:password@api.openai.com", "https://api.openai.com?key=secret", "http://127.0.0.1:1234"]) expect(() => validateEndpoint(endpoint, ["https://api.openai.com"], [])).toThrow();
    const t = await fixture(); const p = apiKeyProvider(await view(t)); await save(t, "providers", p, { claude: { action: "replace", value: secret } });
    expect((await request(t, "POST", "/api/settings/test-connection", { revision: 1, connection: "claude", config: { ...p.connections.claude, endpoint: "https://attacker.example" } })).status).toBe(400);
  });
  it("allows explicitly approved local endpoints and refuses redirects without contacting the redirect host", async () => {
    const sink = vi.fn(); const server = createServer((req, res) => { sink(req.url); res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }); res.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number }; const origin = `http://127.0.0.1:${address.port}`;
    try {
      expect(validateEndpoint(origin, [], [origin]).origin).toBe(origin);
      await expect(guardedFetch(origin, [origin])(`${origin}/models`, { headers: { authorization: `Bearer ${secret}` } })).rejects.toThrow(/redirect/);
      expect(sink).toHaveBeenCalledTimes(1);
      await expect(guardedFetch(origin, [])(`${origin}/models`)).rejects.toThrow(/non-public/);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("does not authorize MCP tools on enablement and requires executable consent", async () => {
    const t = await fixture(); const v = await view(t);
    const integrations = { ...v.values.integrations, servers: [{ name: "browser", enabled: true, transport: "stdio", command: process.execPath, args: ["installed-server.js"], url: "" }] };
    expect((await save(t, "integrations", integrations)).status).toBe(400);
    const saved = await request(t, "PATCH", "/api/settings", { revision: 0, section: "integrations", value: integrations, acknowledgeExecutable: true });
    expect(saved.status, saved.text).toBe(200); expect(t.app.config.provider.mcpServers.browser).toEqual({ command: process.execPath, args: ["installed-server.js"] });
    expect(t.app.runtime.agents.builtins.orchestrator.capabilities.mcpServers).not.toContain("browser");
    const check = await request(t, "POST", "/api/settings/test-mcp", { revision: 1, server: integrations.servers[0] });
    expect(check.status).toBe(400); expect(t.sdk.captured.options).toHaveLength(0);
  });
  it("discovers MCP over HTTP without tools/call, persists the check, protects headers, and invalidates changed connections", async () => {
    const methods: string[] = [];
    const server = createServer((req, res) => { void (async () => {
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string }; methods.push(message.method);
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { tools: [{ name: "inspect", inputSchema: { type: "object" } }] };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const t = await fixture({ CONSOLE_TRUSTED_ENDPOINT_ORIGINS: origin }); const v = await view(t);
      const entry = { name: "browser", enabled: true, transport: "http", command: "", args: [], url: `${origin}/mcp` };
      const secretJson = JSON.stringify({ Authorization: "Bearer private-mcp-test-key" });
      const result = await request(t, "POST", "/api/settings/test-mcp", { revision: 0, server: entry, secret: secretJson });
      expect(result.status, result.text).toBe(200); expect(result.body).toMatchObject({ status: "verified", models: ["mcp__browser__inspect"] });
      const saved = await save(t, "integrations", { ...v.values.integrations, servers: [entry] }, { "mcp:browser": { action: "replace", value: secretJson } });
      expect(saved.body.tests["mcp:browser"]?.status).toBe("verified"); expect(saved.text).not.toContain("private-mcp-test-key");
      expect(methods).not.toContain("tools/call"); expect(t.app.runtime.agents.builtins.orchestrator.capabilities.mcpServers).not.toContain("browser");
      expect((await save(t, "integrations", { ...v.values.integrations, servers: [{ ...entry, url: `${origin}/other` }] })).status).toBe(400);
      expect((await save(t, "integrations", { ...v.values.integrations, servers: [{ ...entry, enabled: false }] })).body.tests["mcp:browser"]).toBeUndefined();
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
