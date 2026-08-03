/**
 * The SDK injection seam: resolves the real `@anthropic-ai/claude-agent-sdk`
 * lazily, so the first turn pays the import and a server with no sessions
 * never loads it. Tests construct services with a `fakeSdk(...)` instance
 * directly and never touch this file.
 */
import type { ConsoleSdk } from "./types.ts";

let cached: Promise<ConsoleSdk> | null = null;

export function resolveSdk(): Promise<ConsoleSdk> {
  cached ??= loadReal();
  return cached;
}

async function loadReal(): Promise<ConsoleSdk> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return {
    query: (params) =>
      sdk.query(
        params as Parameters<typeof sdk.query>[0],
      ) as unknown as ReturnType<ConsoleSdk["query"]>,
    tool: (name, description, schema, handler) =>
      sdk.tool(
        name,
        description,
        schema as Parameters<typeof sdk.tool>[2],
        handler as unknown as Parameters<typeof sdk.tool>[3],
      ),
    createSdkMcpServer: (config) =>
      sdk.createSdkMcpServer(
        config as unknown as Parameters<typeof sdk.createSdkMcpServer>[0],
      ),
  };
}
