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
    /**
     * Per-API-call usage on an assistant message. `input + cache_creation +
     * cache_read` is that ONE request's prompt size — i.e. actual context
     * occupancy. The result message's `usage` is the turn-wide SUM and is not
     * an occupancy measure; do not use it to decide rotation.
     */
    usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
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
  /** A "success" result may still carry is_error:true when the CLI itself failed. */
  is_error?: boolean;
  /** CUMULATIVE across turns in a streaming session — never sum these. */
  total_cost_usd?: number;
  num_turns?: number;
  terminal_reason?: string;
  stop_reason?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  model?: string;
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }>;
  errors?: string[];
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
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
  /** human = operator input; peer = a cross-session SendMessage delivery. */
  origin?: { kind: "human" } | { kind: "peer"; from: string };
}

export interface SdkToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/**
 * Structural hook plumbing (mirrors the SDK's HookCallbackMatcher wire shape).
 * Options carries the real types; these exist so console middleware and the
 * fake can construct/fire hooks without importing SDK internals. Cast at the
 * options boundary: `hooks: fragment as SdkOptions["hooks"]`.
 */
export interface SdkHookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  session_id?: string;
  [key: string]: unknown;
}
export interface SdkHookOutput {
  decision?: "approve" | "block";
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision?: "allow" | "deny" | "ask" | "defer";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    worktreePath?: string;
  };
}
export type SdkHookCallback = (
  input: SdkHookInput,
  toolUseId: string | undefined,
  extra: { signal?: AbortSignal },
) => Promise<SdkHookOutput>;
export interface SdkHookMatcher {
  matcher?: string;
  hooks: SdkHookCallback[];
}
export type SdkHooksFragment = Partial<Record<string, SdkHookMatcher[]>>;

export interface CompiledTool {
  name: string;
  description: string;
  handler: (args: unknown, extra: unknown) => Promise<SdkToolResult>;
}

export interface SdkMcpServerConfig {
  name: string;
  version?: string;
  tools: unknown[];
  /**
   * Keep this server's tools in the prompt instead of deferring them behind
   * ToolSearch. The console already decided a seat's tools via its profile;
   * making it rediscover them costs a full API round-trip each time (21 of them
   * in the db-live-1 run, ~10% of its input tokens).
   */
  alwaysLoad?: boolean;
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
