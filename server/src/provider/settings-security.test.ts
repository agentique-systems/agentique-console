import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startEndpointProxy } from "./endpoint-proxy.ts";
import { protectCredentials } from "./credential-redaction.ts";
import { contractRequest } from "./adapter-test-support.ts";
import type { ProviderAdapter } from "./adapter.ts";
import { AiSdkAdapter } from "./ai-sdk-adapter.ts";
import { guardedFetch } from "./connection-check.ts";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } });
async function listen(server: Server) { servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }

describe("protected native SDK transport", () => {
  it("sends no Authorization header to an explicitly unauthenticated compatible endpoint", async () => {
    const received = vi.fn();
    const origin = await listen(createServer((req, res) => { received(req.headers); res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"fixture"}}'); }));
    const adapter = new AiSdkAdapter({ fallbackWorkingDirectory: ".", trustedEndpointOrigins: [origin], openai: { baseURL: `${origin}/v1`, apiKey: "local-provider", noAuth: true } });
    await adapter.execute(contractRequest(".", { model: "openai/fixture" }).request);
    expect(received).toHaveBeenCalled(); expect(received.mock.calls[0]?.[0].authorization).toBeUndefined();
  });
  it("bounds streamed discovery responses even when Content-Length is omitted", async () => {
    const origin = await listen(createServer((_req, res) => { res.write("123456"); res.end("7890"); }));
    const response = await guardedFetch(origin, [origin], 8)(origin);
    await expect(response.text()).rejects.toThrow(/bound/);
  });
  it.each([true, false])("injects the saved credential only at the pinned upstream and refuses redirects (Anthropic: %s)", async (anthropic) => {
    const received: string[] = []; let redirected = 0;
    const sink = await listen(createServer((_req, res) => { redirected++; res.end("unexpected"); }));
    const origin = await listen(createServer((req, res) => { received.push(String(anthropic ? req.headers["x-api-key"] : req.headers.authorization)); if (req.url === "/v1/redirect") res.writeHead(307, { location: sink }); res.end("ok"); }));
    const proxy = await startEndpointProxy(`${origin}/v1`, "private-native-key", anthropic, [origin], new AbortController().signal);
    try {
      expect((await fetch(`${proxy.url}/messages`)).status).toBe(403);
      const headers = anthropic ? { "x-api-key": proxy.token } : { authorization: `Bearer ${proxy.token}` };
      expect(await (await fetch(`${proxy.url}/messages`, { method: "POST", headers, body: "{}" })).text()).toBe("ok");
      const refused = await fetch(`${proxy.url}/redirect`, { headers }); expect(refused.status).toBe(502); expect(await refused.text()).not.toContain("private-native-key");
      expect(received).toEqual([anthropic ? "private-native-key" : "Bearer private-native-key", anthropic ? "private-native-key" : "Bearer private-native-key"]); expect(redirected).toBe(0);
    } finally { await proxy.close(); }
  });
  it("preserves MCP protocol headers while protecting configured HTTP credentials", async () => {
    const received = vi.fn();
    const origin = await listen(createServer((req, res) => { received(req.headers); res.writeHead(200, { "mcp-session-id": "session-fixture" }); res.end("ok"); }));
    const proxy = await startEndpointProxy(`${origin}/mcp`, "", false, [origin], new AbortController().signal, { "x-access-key": "private-mcp-key" });
    try {
      const result = await fetch(proxy.url, { headers: { authorization: `Bearer ${proxy.token}`, "mcp-protocol-version": "2025-03-26" } }); await result.text();
      expect(received).toHaveBeenCalledWith(expect.objectContaining({ "x-access-key": "private-mcp-key", "mcp-protocol-version": "2025-03-26" }));
      expect(received.mock.calls[0]?.[0].authorization).toBeUndefined(); expect(result.headers.get("mcp-session-id")).toBe("session-fixture");
    } finally { await proxy.close(); }
  });
});

it("redacts split streams and refuses credential-bearing calls before audit or durable writes", async () => {
  const secret = "abcabc-private-credential";
  const calls = vi.fn(), authorization = vi.fn();
  const base = contractRequest(".", { runtimeTools: { tools: [], call: calls }, authorization: { authorize: authorization } });
  const adapter: ProviderAdapter = { provider: "fixture", supportsContinuation: true, async execute(request) {
    request.output({ attemptId: request.attemptId, kind: "text", text: `before ${secret.slice(0, 8)}` });
    request.output({ attemptId: request.attemptId, kind: "text", text: `${secret.slice(8)} after` });
    expect(request.authorization.authorize({ tool: "shell", input: { command: secret } } as never).kind).toBe("invalid");
    expect((await request.runtimeTools.call({ tool: "write_artifact", input: { text: secret } } as never)).kind).toBe("failed");
    return { completion: { kind: "provider_failure", failureKind: "unknown", message: secret }, result: null, usage: [], diagnostics: { detail: secret }, transcript: Buffer.from(secret), continuation: Buffer.from(secret) } as never;
  } };
  const result = await protectCredentials(adapter, [secret]).execute(base.request);
  expect(base.outputs.map((v) => v.text).join("")).toBe("before [redacted] after");
  expect(JSON.stringify(result)).not.toContain(secret); expect(result.continuation).toBeNull(); expect(calls).not.toHaveBeenCalled(); expect(authorization).not.toHaveBeenCalled();
});
