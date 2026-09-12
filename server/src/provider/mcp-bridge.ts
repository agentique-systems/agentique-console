import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AdapterAttempt } from "./attempt-session.ts";

/** One authenticated loopback endpoint per Attempt; no credentials are written to disk or diagnostics. */
export async function startMcpBridge(attempt: AdapterAttempt): Promise<{ url: string; token: string; close(): Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const active = new Set<Server>();
  const http = createServer(async (request, response) => {
    const actual = Buffer.from(request.headers.authorization ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || request.headers.origin !== undefined) { response.writeHead(401).end(); return; }
    if (request.url !== "/mcp" || request.method !== "POST") { response.writeHead(405).end(); return; }
    if (active.size >= 32) { response.writeHead(429).end(); return; }
    const server = new Server({ name: "agentique", version: "1.0.0" }, { capabilities: { tools: {} } });
    active.add(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => { active.delete(server); void server.close().catch(() => undefined); });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > 1_048_576) { response.writeHead(413).end(); request.destroy(); return; }
        chunks.push(bytes);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: Object.entries(attempt.tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: (tool.jsonSchema ?? z.toJSONSchema(tool.schema, { unrepresentable: "any", io: "input" })) as { type: "object" } })) }));
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        const result = await attempt.call(params.name, params.arguments ?? {});
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(400).end();
      else response.end();
      active.delete(server);
      await server.close().catch(() => undefined);
    }
  });
  http.requestTimeout = 30_000;
  http.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("Could not bind Attempt MCP endpoint");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, token,
    close: async () => {
      await Promise.allSettled([...active].map((server) => server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
