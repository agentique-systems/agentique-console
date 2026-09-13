import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type ConnectionTestResult, type IntegrationSettings, ValidationError } from "@agentique-console/core";
import { guardedFetch, validateEndpoint } from "./connection-check.ts";

/** Initialize and listTools only. Nothing calls a tool or changes the capability policy. */
export async function discoverMcp(server: IntegrationSettings, extras: Record<string, string>, trustedOrigins: string[], consent: boolean): Promise<ConnectionTestResult> {
  if (server.transport === "stdio" && (!consent || !/^(?:[A-Za-z]:[\\/]|\/)/.test(server.command))) throw new ValidationError("Confirm starting this installed MCP executable and supply its absolute path. Discovery can execute server startup code.");
  const url = server.transport === "http" ? validateEndpoint(server.url, [], trustedOrigins) : null;
  const client = new Client({ name: "agentique-settings-discovery", version: "1.0.0" });
  const transport = url ? new StreamableHTTPClientTransport(url, { requestInit: { headers: extras }, fetch: guardedFetch(url.origin, trustedOrigins, 1_048_576) }) : new StdioClientTransport({ command: server.command, args: server.args, env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...extras }, stderr: "ignore" });
  const base: ConnectionTestResult = { status: "failed", checkedAt: new Date().toISOString(), check: "MCP initialize and listTools (no tool calls)", authentication: "not_tested", modelAccess: "not_tested", models: [], message: "" };
  const signal = AbortSignal.timeout(12_000);
  try {
    await client.connect(transport, { signal, timeout: 12_000 });
    const tools: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      if (++pages > 10) throw new Error("Too many pages");
      const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 12_000 });
      for (const tool of page.tools) { if (tools.length >= 500) throw new Error("Too many tools"); if (/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) && !Object.values(extras).some((value) => value && tool.name.includes(value))) tools.push(`mcp__${server.name}__${tool.name}`); }
      cursor = page.nextCursor;
    } while (cursor);
    return { ...base, status: "verified", models: tools, message: `${tools.length} tools discovered. No tool was called or authorized. Agent definitions must declare the server and exact tool names; existing approval policy still applies.` };
  } catch { return { ...base, message: signal.aborted ? "MCP discovery timed out after 12 seconds." : "MCP discovery failed. Check the installed executable, endpoint trust, credentials, and transport. Provider error bodies are not exposed." }; }
  finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); }
}
