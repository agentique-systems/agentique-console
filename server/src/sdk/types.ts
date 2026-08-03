/**
 * The narrow SDK surface this app consumes, typed structurally (v1's proven
 * approach): every message field optional, cast at the boundary. This keeps the
 * fake trivial to script and the mapper honest about absent fields, while
 * `Options` fidelity comes from type-only imports of the real package.
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";

export type SdkOptions = Options;

/** Loosely-typed SDK message — the union of every field the mapper reads. */
export interface SdkMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  uuid?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string };
  };
  message?: {
    content?: {
      type?: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }[];
  };
  /** B3: user-message provenance — peer = an in-process agent's SendMessage. */
  origin?: {
    kind?: string;
    from?: string;
    name?: string;
    senderTaskId?: string;
    body?: string;
  };
  // result fields
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  terminal_reason?: string;
  errors?: string[];
  // permission_denied fields
  tool_use_id?: string;
  tool_name?: string;
  [key: string]: unknown;
}

export interface QueryHandle extends AsyncGenerator<SdkMessage, void, void> {
  interrupt?: () => Promise<void>;
  close?: () => void;
}

/**
 * The user message a persistent lane pushes into its streaming-input query.
 * Structural mirror of the SDK's SDKUserMessage (input side): operator input
 * MUST carry origin {kind:"human"} — unattributed messages fail closed at the
 * SDK's isHuman() trust gates — while console-synthesized pushes (wake digests,
 * answer revivals) omit origin entirely; they are neither human nor peer.
 */
export interface SdkUserMessageLike {
  type: "user";
  message: { role: "user"; content: { type: "text"; text: string }[] };
  parent_tool_use_id: null;
  shouldQuery?: boolean;
  uuid?: string;
  timestamp?: string;
  origin?: { kind: "human" };
}

export interface SdkToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface CompiledTool {
  name: string;
  description: string;
  handler: (args: unknown, extra: unknown) => Promise<SdkToolResult>;
}

export interface SdkMcpServerConfig {
  name: string;
  version?: string;
  tools: unknown[];
}

/** The injectable module surface: real SDK in production, fake in tests/dev. */
export interface ConsoleSdk {
  query(params: {
    prompt: string | AsyncIterable<SdkUserMessageLike>;
    options: SdkOptions;
  }): QueryHandle;
  tool(
    name: string,
    description: string,
    schema: unknown,
    handler: (args: never, extra: unknown) => Promise<SdkToolResult>,
  ): unknown;
  createSdkMcpServer(config: SdkMcpServerConfig): unknown;
}

