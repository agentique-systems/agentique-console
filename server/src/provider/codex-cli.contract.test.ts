import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { CodexSdkAdapter } from "./codex-adapter.ts";
import { contractRequest } from "./adapter-test-support.ts";

it("the pinned Codex CLI exposes only mediated tool capabilities (offline wire contract)", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentique-codex-wire-"));
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try { requests.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { /* metadata probes */ }
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: "authentication_error", message: "contract fixture: no model work" } }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      requests.push(JSON.parse(data.toString()) as Record<string, unknown>);
      socket.send(JSON.stringify({ type: "error", status: 401, error: { type: "authentication_error", code: "invalid_api_key", message: "contract fixture: no model work" } }));
      socket.close();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bind failed");
    const adapter = new CodexSdkAdapter({ home: directory, fallbackWorkingDirectory: directory, apiKey: "contract-fixture", baseUrl: `http://127.0.0.1:${address.port}/v1` });
    const { request } = contractRequest(directory, { model: "gpt-5.6-terra", deadlineAt: new Date(Date.now() + 20_000).toISOString() });
    const outcome = await adapter.execute(request);
    expect(requests.length, JSON.stringify(outcome.completion)).toBeGreaterThan(0);
    const names: string[] = [];
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(collect); return; }
      if (value === null || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (typeof record.name === "string" && (record.type === "function" || record.type === "custom")) names.push(record.name);
      if (typeof record.description === "string" && record.name === "exec") names.push(...[...record.description.matchAll(/declare const tools: \{ (\w+)\(/g)].map((m) => m[1]!));
      Object.values(record).forEach(collect);
    };
    collect(requests);
    expect(names, JSON.stringify(names)).not.toContain("apply_patch");
    expect([...new Set(names)].sort()).toEqual(["list_mcp_resource_templates", "list_mcp_resources", "read_mcp_resource", "return_result"]);
    expect(names.some((name) => name.includes("return_result")), JSON.stringify(names)).toBe(true);
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 35_000);
