import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises"; // Node stream transport, not an execution pattern.
import { guardedFetch } from "./connection-check.ts";
import type { ProviderAdapter } from "./adapter.ts";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

/** Native SDKs do not expose fetch. A per-attempt loopback bridge owns the actual API credential and refuses upstream redirects. */
export async function startEndpointProxy(endpoint: string, credential: string, anthropic: boolean, trustedOrigins: string[], signal: AbortSignal, forwardHeaders?: Record<string, string>) {
  const target = new URL(endpoint);
  const token = randomBytes(32).toString("hex");
  const http = guardedFetch(target.origin, trustedOrigins);
  const stopped = new AbortController();
  const server = createServer((request, response) => {
    void (async () => {
      const provided = String(anthropic ? request.headers["x-api-key"] ?? "" : request.headers.authorization?.replace(/^Bearer /, "") ?? "");
      const a = Buffer.from(provided), b = Buffer.from(token);
      if (a.length !== b.length || !timingSafeEqual(a, b) || !request.url?.startsWith("/") || request.url.startsWith("//")) { response.writeHead(403).end(); return; }
      const url = new URL(request.url, target.origin);
      const base = target.pathname.replace(/\/$/, "");
      if (url.origin !== target.origin || (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`))) { response.writeHead(403).end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { const data = Buffer.from(chunk as Uint8Array); size += data.length; if (size > 16_777_216) { response.writeHead(413).end(); return; } chunks.push(data); }
      const headers: Record<string, string> = {};
      for (const name of ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta", "user-agent", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) if (typeof request.headers[name] === "string") headers[name] = request.headers[name];
      if (forwardHeaders) Object.assign(headers, forwardHeaders);
      else if (anthropic) headers["x-api-key"] = credential; else headers.authorization = `Bearer ${credential}`;
      const result = await http(url, { method: request.method ?? "POST", headers, ...(size ? { body: Buffer.concat(chunks) } : {}), signal: AbortSignal.any([signal, stopped.signal]) });
      response.statusCode = result.status;
      for (const name of ["content-type", "retry-after", "request-id", "x-request-id", "mcp-session-id", "mcp-protocol-version"]) { const value = result.headers.get(name); if (value && (!credential || !value.includes(credential))) response.setHeader(name, value); }
      if (result.body) await pipeline(Readable.fromWeb(result.body as never), response); else response.end();
    })().catch(() => { if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" }).end('{"error":{"message":"Provider endpoint request refused or failed."}}'); else response.destroy(); });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n"));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}${target.pathname.replace(/\/$/, "")}`, token,
    async close() { stopped.abort(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

export function withMcpEndpointProxies(continuation: boolean, servers: Record<string, McpServerConfig>, trustedOrigins: string[], adapter: (servers: Record<string, McpServerConfig>) => ProviderAdapter): ProviderAdapter {
  return { provider: "claude", supportsContinuation: continuation, async execute(request) {
    const proxies: Awaited<ReturnType<typeof startEndpointProxy>>[] = [];
    const connections = { ...servers };
    try {
      for (const name of request.capabilities.mcpServers) {
        const connection = servers[name];
        if (connection && "url" in connection) {
          const proxy = await startEndpointProxy(connection.url, "", false, trustedOrigins, request.signal, connection.headers ?? {});
          proxies.push(proxy); connections[name] = { type: "http", url: proxy.url, headers: { Authorization: `Bearer ${proxy.token}` } };
        }
      }
      return await adapter(connections).execute(request);
    } finally { await Promise.all(proxies.map((p) => p.close())); }
  } };
}

export function withEndpointProxy(provider: string, continuation: boolean, endpoint: string, credential: string, anthropic: boolean, trustedOrigins: string[], adapter: (url: string, token: string) => ProviderAdapter): ProviderAdapter {
  return { provider, supportsContinuation: continuation, async execute(request) {
    const proxy = await startEndpointProxy(endpoint, credential, anthropic, trustedOrigins, request.signal);
    try { return await adapter(proxy.url, proxy.token).execute(request); }
    finally { await proxy.close(); }
  } };
}
