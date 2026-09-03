/**
 * The production binding of the Claude adapter to the pinned
 * `@anthropic-ai/claude-agent-sdk`. Importing this module loads the SDK;
 * the adapter and its deterministic suite import `claude-sdk.ts` instead
 * and receive the surface by injection.
 */
import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSdk } from "./claude-sdk.ts";

export const CLAUDE_AGENT_SDK: ClaudeSdk = {
  query: (params) => query(params),
  createSdkMcpServer: (options) => createSdkMcpServer(options as Parameters<typeof createSdkMcpServer>[0]),
};
