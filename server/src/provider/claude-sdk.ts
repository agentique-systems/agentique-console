/**
 * The narrow surface of `@anthropic-ai/claude-agent-sdk` the Claude adapter
 * uses, as an injectable interface: `query` in streaming-input mode and the
 * in-process MCP server constructor. The production binding
 * (`claude-sdk-binding.ts`) hands over the real module; the deterministic
 * suite hands over a scripted fake that speaks the same message protocol
 * and applies the same hook and permission path the CLI applies. The
 * adapter's mapping, authorization, tool, interruption, result, and Usage
 * code is identical either way.
 *
 * Only types are imported from the SDK here, so loading this module never
 * loads the SDK.
 */
import type { McpSdkServerConfigWithInstance, Options, Query, SDKUserMessage, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

export type { Options as ClaudeSdkOptions, Query as ClaudeSdkQuery, SDKUserMessage as ClaudeSdkUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** A tool of the adapter's in-process MCP server; `inputSchema` is a zod schema the MCP server validates calls against. */
export type ClaudeSdkTool = SdkMcpToolDefinition<never>;

export interface ClaudeSdkServerOptions {
  name: string;
  version?: string;
  instructions?: string;
  /** Every tool of the server is always in the prompt, never deferred behind tool search. */
  alwaysLoad?: boolean;
  tools?: ClaudeSdkTool[];
}

export interface ClaudeSdk {
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query;
  createSdkMcpServer(options: ClaudeSdkServerOptions): McpSdkServerConfigWithInstance;
}
