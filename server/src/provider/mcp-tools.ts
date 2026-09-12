import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { AdapterAttempt } from "./attempt-session.ts";

export type McpConnection = { command: string; args: string[]; env?: Record<string, string> } | { url: string; headers?: Record<string, string> };
export const mcpCatalogSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).refine((name) => !["agentique", "__proto__", "constructor", "prototype"].includes(name)), z.union([
  z.strictObject({ command: z.string().min(1), args: z.array(z.string()).max(100).default([]), env: z.record(z.string(), z.string()).optional() }),
  z.strictObject({ url: z.url().refine((value) => { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }), headers: z.record(z.string(), z.string()).optional() }),
]));

/** Explicit catalog only. All externally hosted MCP calls still pass runtime authorization. */
export async function addMcpTools(attempt: AdapterAttempt, catalog: Record<string, McpConnection>): Promise<() => Promise<void>> {
  const clients: Client[] = [];
  const close = async () => { await Promise.allSettled(clients.map((client) => client.close())); };
  try {
    for (const name of attempt.request.capabilities.mcpServers) {
      attempt.signal.throwIfAborted();
      const config = catalog[name];
      if (!config) throw new Error(`invalid request: MCP server ${name} is not configured`);
      const client = new Client({ name: "agentique-console", version: "1.0.0" });
      clients.push(client);
      const transport = "url" in config
        ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })
        : new StdioClientTransport({ command: config.command, args: config.args, ...(config.env === undefined ? {} : { env: config.env }), stderr: "ignore", cwd: attempt.request.workingDirectory ?? undefined });
      await client.connect(transport, { signal: attempt.signal, timeout: attempt.limits.toolTimeoutMs });
      let cursor: string | undefined;
      let count = 0;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor }, { signal: attempt.signal, timeout: attempt.limits.toolTimeoutMs });
        for (const tool of page.tools) {
          if (++count > 1000) throw new Error("invalid request: MCP tool catalog exceeds the size bound");
          const canonical = `mcp__${name}__${tool.name}`;
          if (!attempt.request.capabilities.tools.includes(canonical) || attempt.request.toolPolicy[canonical] === "denied") continue;
          attempt.add(canonical, {
            capability: canonical, description: tool.description ?? tool.name,
            schema: z.record(z.string(), z.unknown()), jsonSchema: tool.inputSchema,
            execute: async (input) => client.callTool({ name: tool.name, arguments: input as Record<string, unknown> }, undefined, { signal: attempt.signal, timeout: attempt.limits.toolTimeoutMs }),
          });
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    }
    return close;
  } catch (error) { await close(); throw error; }
}
