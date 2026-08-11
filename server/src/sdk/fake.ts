/**
 * Test double for the SDK module surface (port of agentique-core's fake-sdk).
 * Test-only: the running app always talks to the real SDK. Records the prompt,
 * options, compiled tools, and interrupt calls; yields a scripted message
 * program. Programs receive the query options, so tests can invoke
 * `options.canUseTool` and `options.hooks` callbacks directly to exercise
 * interaction and task-mirror flows credential-free.
 *
 * Two prompt shapes, mirroring the real SDK:
 * - string prompt (specialist seats): one program run per query() call.
 * - streaming prompt (the persistent lane): ONE program invocation per pushed
 *   input message = one scripted turn. `captured.prompts[n]` is the nth turn
 *   prompt either way, so `waitForPrompt` keeps its meaning across both.
 *
 * Known scripted-vs-real divergences: programs may re-yield initMessage()
 * every turn (the real CLI emits init once per session — harmless, resume
 * patching is change-detecting), and each scripted turn should end with a
 * result message (the runner's `turn-idle` backstop only fires if a script
 * yields an idle frame deliberately).
 */
import { AsyncQueue } from "../async-queue.ts";
import { assertProviderToolSchema } from "../handoffs/schema.ts";
import type {
  CompiledTool,
  ConsoleSdk,
  SdkMessage,
  SdkOptions,
  SdkToolResult,
  SdkUserMessageLike,
} from "./types.ts";

export type FakeProgram = (
  options: SdkOptions,
  tools: CompiledTool[],
) => AsyncGenerator<SdkMessage, void, void>;

export interface FakeSdk {
  sdk: ConsoleSdk;
  captured: {
    /** Every turn prompt in arrival order (per query() call or streamed input). */
    prompts: string[];
    /** Options of every query() call, in order. */
    options: SdkOptions[];
    /** Raw messages pushed into streaming prompts, in arrival order. */
    inputs: SdkUserMessageLike[];
    interrupted: boolean;
    closed: boolean;
    tools: CompiledTool[];
  };
  /** Resolves once `captured.prompts[index]` exists. */
  waitForPrompt(index: number): Promise<string>;
}

/** The text a streamed input message carries, as the model would read it. */
function promptTextOf(message: SdkUserMessageLike): string {
  const blocks = message.message?.content;
  if (Array.isArray(blocks)) {
    const text = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (text !== "") return text;
  }
  return JSON.stringify(message);
}

/** A matcher entry from Options.hooks, structurally typed. */
type FakeHookMatcher = { matcher?: string; hooks: ((input: unknown, toolUseId: string | undefined, extra: { signal?: AbortSignal }) => Promise<Record<string, unknown>>)[] };

function hookMatchers(options: SdkOptions, event: string, toolName: string): FakeHookMatcher[] {
  const all = (options.hooks as Record<string, FakeHookMatcher[]> | undefined)?.[event] ?? [];
  return all.filter((entry) => entry.matcher === undefined || new RegExp(`^(?:${entry.matcher})$`).test(toolName));
}

/**
 * The other half of the same doctrine, on the way back out. `read_artifact`
 * returned Messages-API image content for an in-process MCP server that only
 * accepts MCP `ContentBlock`s, and every call failed with `invalid_union` in
 * db-live-2 — while this file happily did `part.text ?? ""`, turning an invalid
 * block into an empty string and a green test.
 *
 * Validates each block against MCP's ContentBlock shape and throws, so a wrong
 * result shape fails here the way it fails against the real server.
 */
function assertMcpToolResult(name: string, result: SdkToolResult): void {
  if (result === null || typeof result !== "object" || !Array.isArray(result.content)) {
    throw new Error(`tool ${name}: result must be { content: ContentBlock[] }`);
  }
  for (const [index, block] of result.content.entries()) {
    const at = `tool ${name}: content[${index}]`;
    if (block === null || typeof block !== "object") throw new Error(`${at} is not an object`);
    const kind = (block as { type?: unknown }).type;
    if (kind === "text") {
      if (typeof (block as { text?: unknown }).text !== "string") throw new Error(`${at} is type "text" but has no string \`text\``);
      continue;
    }
    if (kind === "image") {
      const image = block as { data?: unknown; mimeType?: unknown; source?: unknown };
      if (image.source !== undefined) {
        throw new Error(`${at} uses the Messages API image shape (\`source\`); MCP wants { type: "image", data, mimeType }`);
      }
      if (typeof image.data !== "string") throw new Error(`${at} is type "image" but has no string \`data\``);
      if (typeof image.mimeType !== "string") throw new Error(`${at} is type "image" but has no string \`mimeType\``);
      if (image.mimeType.endsWith(";base64")) throw new Error(`${at} mimeType "${image.mimeType}" carries the console's storage suffix; strip \`;base64\` at the tool boundary`);
      continue;
    }
    throw new Error(`${at} has unsupported type ${JSON.stringify(kind)}; MCP content must be "text" or "image"`);
  }
}

/**
 * The fake must fail wherever the real API would, or `npm run verify` is
 * theatre. db-live-1 ran with 13/13 context rotations failing on a provider
 * 400 while the suite stayed green, because nothing here ever looked at the
 * schemas the console hands the SDK.
 *
 * `sdk.tool` takes a zod-shape object; a plain JSON Schema handed here would be
 * compiled into an `input_schema` the API rejects.
 */
function assertToolParameterShape(name: string, schema: unknown): void {
  if (schema === null || typeof schema !== "object") {
    throw new Error(`tool ${name}: parameters must be an object of zod fields`);
  }
  const asJsonSchema = schema as { type?: unknown; properties?: unknown };
  if (typeof asJsonSchema.type === "string" || Array.isArray(asJsonSchema.type)) {
    throw new Error(`tool ${name}: parameters look like a raw JSON Schema (has "type"); pass a zod shape so the SDK can compile a valid input_schema`);
  }
  for (const [field, value] of Object.entries(schema as Record<string, unknown>)) {
    const zodLike = value as { safeParse?: unknown; _def?: unknown } | null;
    if (zodLike === null || typeof zodLike !== "object" || (typeof zodLike.safeParse !== "function" && zodLike._def === undefined)) {
      throw new Error(`tool ${name}: parameter "${field}" is not a zod schema`);
    }
  }
}

/**
 * `outputFormat: {type: "json_schema"}` becomes a synthetic `StructuredOutput`
 * tool whose `input_schema` is this value verbatim, so it must satisfy the
 * provider's tool-schema rules. Enforcing it here is what makes the
 * `type: ["object","null"]` regression impossible to reintroduce silently.
 */
function assertOutputFormat(options: SdkOptions): void {
  const format = (options as { outputFormat?: { type?: string; schema?: unknown } }).outputFormat;
  if (!format || format.type !== "json_schema") return;
  assertProviderToolSchema("outputFormat.schema", format.schema);
}

export function fakeSdk(program: FakeProgram): FakeSdk {
  const captured: FakeSdk["captured"] = {
    prompts: [],
    options: [],
    inputs: [],
    interrupted: false,
    closed: false,
    tools: [],
  };
  const waiters: { index: number; resolve: (text: string) => void }[] = [];

  /**
   * The peer mesh in miniature: streaming queries whose env carries
   * CLAUDE_CODE_SESSION_NAME register their input queue under that name for
   * the life of the query — exactly the visibility window of the real
   * registry+socket. SendMessage delivery pushes into the target queue.
   */
  const peers = new Map<string, { push: (message: SdkUserMessageLike) => void }>();

  /**
   * Native-SendMessage execution: run the sender's PreToolUse chain (the
   * console middleware), deliver on allow, and synthesize the tool_result the
   * real harness would return. Returns the frames to emit downstream.
   */
  async function executeSendMessage(options: SdkOptions, callId: string, input: Record<string, unknown>): Promise<SdkMessage[]> {
    let updatedInput: Record<string, unknown> | undefined;
    for (const matcher of hookMatchers(options, "PreToolUse", "SendMessage")) {
      for (const hook of matcher.hooks) {
        const out = await hook({ hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_input: updatedInput ?? input }, callId, {});
        const specific = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } }).hookSpecificOutput;
        if (specific?.permissionDecision === "deny") {
          return [toolResultMessage(callId, specific.permissionDecisionReason ?? "denied", true)];
        }
        if (specific?.updatedInput) updatedInput = specific.updatedInput;
      }
    }
    const final = updatedInput ?? input;
    const to = typeof final.to === "string" ? final.to.replace(/\s+\[[0-9a-f]+\]$/, "") : "";
    const target = peers.get(to);
    const response = target
      ? `{"success":true,"message":"delivered","msg_id":"fake-${callId}"}`
      : `{"success":false,"message":"'${to}' is not an agent in this conversation. Re-send with the ref to confirm."}`;
    for (const matcher of hookMatchers(options, "PostToolUse", "SendMessage")) {
      for (const hook of matcher.hooks) {
        await hook({ hook_event_name: "PostToolUse", tool_name: "SendMessage", tool_input: final, tool_response: [{ type: "text", text: response }] }, callId, {});
      }
    }
    if (target) {
      const from = (options.env as Record<string, string> | undefined)?.CLAUDE_CODE_SESSION_NAME ?? "peer";
      target.push({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: typeof final.message === "string" ? final.message : "" }] },
        parent_tool_use_id: null,
        origin: { kind: "peer", from },
      } as SdkUserMessageLike);
    }
    return [toolResultMessage(callId, [{ type: "text", text: response }])];
  }

  function sendMessageCall(message: SdkMessage): { callId: string; input: Record<string, unknown> } | null {
    if (message.type !== "assistant") return null;
    const block = (message.message?.content ?? []).find((entry) => entry.type === "tool_use" && entry.name === "SendMessage");
    if (!block) return null;
    return { callId: block.id ?? "unknown", input: (block.input ?? {}) as Record<string, unknown> };
  }

  function mcpToolCall(message: SdkMessage): { callId: string; name: string; input: unknown } | null {
    if (message.type !== "assistant") return null;
    const block = (message.message?.content ?? []).find((entry) => entry.type === "tool_use" && (entry.name ?? "").startsWith("mcp__"));
    if (!block) return null;
    return { callId: block.id ?? "unknown", name: block.name ?? "", input: block.input ?? {} };
  }

  /**
   * Run a console MCP tool for real, the way the SDK does: resolve the handler
   * the console registered, invoke it, and feed the result back as a
   * tool_result. Without this the fake could only script NATIVE tool calls, so
   * no e2e ever exercised the seat → console-tool path that now carries every
   * transfer — the suite would have kept passing while testing a dead route.
   */
  async function executeMcpTool(options: SdkOptions, callId: string, qualifiedName: string, input: unknown): Promise<SdkMessage[]> {
    // MUST resolve from THIS query's own servers. Every seat registers its own
    // `send_handoff` bound to its own identity, so a global lookup by name
    // silently runs a specialist's call as the coordinator — which routes
    // orchestrator→orchestrator and vanishes.
    const servers = (options.mcpServers ?? {}) as Record<string, { instance?: { tools?: unknown[] } }>;
    const own: CompiledTool[] = Object.values(servers)
      .flatMap((server) => (server?.instance?.tools ?? []) as CompiledTool[])
      .filter((candidate) => typeof candidate?.name === "string");
    const tool = own.find((candidate) => qualifiedName.endsWith(`__${candidate.name}`) || candidate.name === qualifiedName);
    if (!tool) return [toolResultMessage(callId, `no such tool: ${qualifiedName}`, true)];
    try {
      const result = await tool.handler(input as never, {});
      assertMcpToolResult(tool.name, result);
      // Image blocks are rendered as a marker rather than dropped, so a test
      // can assert the seat actually received one. Silently coercing them to
      // "" is what hid the read_artifact defect for a whole live run.
      const text = result.content
        .map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType} ${part.data.length}b64]`))
        .join("");
      return [toolResultMessage(callId, text, result.isError === true)];
    } catch (error) {
      return [toolResultMessage(callId, error instanceof Error ? error.message : String(error), true)];
    }
  }

  const record = (text: string): void => {
    captured.prompts.push(text);
    for (const waiter of waiters.splice(0)) {
      const value = captured.prompts[waiter.index];
      if (value !== undefined) waiter.resolve(value);
      else waiters.push(waiter);
    }
  };

  const sdk: ConsoleSdk = {
    query({ prompt, options }) {
      assertOutputFormat(options);
      captured.options.push(options);
      if (typeof prompt === "string") {
        record(prompt);
        const generator = program(options, captured.tools);
        return Object.assign(generator, {
          interrupt: async () => {
            captured.interrupted = true;
          },
          close: () => {
            captured.closed = true;
          },
        });
      }

      // Streaming prompt: one program invocation per pushed message = one
      // scripted turn. The turn generator is PULL-driven — it advances only
      // when the consumer asks — preserving the string-prompt interleaving
      // (a program that awaits canUseTool between yields does so only after
      // the consumer has applied the preceding message). Interrupt and close
      // are raced against the pending pull, like the real CLI's control lane:
      // an interrupt abandons a turn blocked in canUseTool and settles it
      // with an interrupted error result.
      const stream = prompt;
      let signalInterrupt: (() => void) | null = null;
      let signalClose: (() => void) | null = null;
      const closeRequested = new Promise<"close">((resolve) => {
        signalClose = () => resolve("close");
      });

      // Peer-mesh registration: named streaming queries are addressable for
      // exactly as long as the query lives (the registry+socket in miniature).
      const peerName = (options.env as Record<string, string> | undefined)?.CLAUDE_CODE_SESSION_NAME;
      const pushable = stream as { push?: (message: SdkUserMessageLike) => void };
      if (peerName !== undefined && typeof pushable.push === "function") {
        peers.set(peerName, { push: (message) => pushable.push!(message) });
      }
      const unregister = () => { if (peerName !== undefined && peers.get(peerName)?.push !== undefined) peers.delete(peerName); };

      async function* consume(): AsyncGenerator<SdkMessage, void, void> {
        try {
          for await (const message of stream) {
            captured.inputs.push(message);
            if (message.shouldQuery === false) continue;
            record(promptTextOf(message));
            const turn = program(options, captured.tools);
            let interrupted = false;
            const interruptRequested = new Promise<"interrupt">((resolve) => {
              signalInterrupt = () => resolve("interrupt");
            });
            try {
              for (;;) {
                const raced = await Promise.race([
                  turn.next(),
                  interruptRequested,
                  closeRequested,
                ]);
                if (raced === "close") return;
                if (raced === "interrupt") {
                  interrupted = true;
                  // Abandon the (possibly forever-parked) pending pull.
                  void turn.return(undefined).catch(() => undefined);
                  break;
                }
                if (raced.done) break;
                yield raced.value;
                // A scripted native SendMessage executes for real: middleware
                // chain, delivery into the target peer's queue, tool_result.
                const send = sendMessageCall(raced.value);
                if (send) {
                  for (const frame of await executeSendMessage(options, send.callId, send.input)) yield frame;
                }
                const mcp = mcpToolCall(raced.value);
                if (mcp) {
                  for (const frame of await executeMcpTool(options, mcp.callId, mcp.name, mcp.input)) yield frame;
                }
              }
            } finally {
              signalInterrupt = null;
            }
            if (interrupted) {
              yield errorMessage("error_during_execution", {
                terminal_reason: "interrupted",
              });
            }
          }
        } finally {
          unregister();
        }
      }
      return Object.assign(consume(), {
        interrupt: async () => {
          captured.interrupted = true;
          signalInterrupt?.();
        },
        close: () => {
          captured.closed = true;
          unregister();
          signalClose?.();
        },
      });
    },
    tool(name, description, schema, handler) {
      assertToolParameterShape(name, schema);
      const compiled: CompiledTool = {
        name,
        description,
        handler: handler as CompiledTool["handler"],
      };
      captured.tools.push(compiled);
      return compiled;
    },
    createSdkMcpServer(config) {
      return { type: "sdk", name: config.name, instance: config };
    },
  };

  return {
    sdk,
    captured,
    waitForPrompt(index: number): Promise<string> {
      const existing = captured.prompts[index];
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<string>((resolve) => {
        waiters.push({ index, resolve });
      });
    },
  };
}

let permissionSeq = 0;

/** A fully-shaped canUseTool context for driving permission flows from tests. */
export function permissionContext(): Parameters<
  NonNullable<SdkOptions["canUseTool"]>
>[2] {
  permissionSeq += 1;
  return {
    signal: new AbortController().signal,
    toolUseID: `tu_fake_${permissionSeq}`,
    requestId: `req_fake_${permissionSeq}`,
  } as Parameters<NonNullable<SdkOptions["canUseTool"]>>[2];
}

// --- Message builders -------------------------------------------------------

let fakeSession = 0;

export function initMessage(sessionId?: string): SdkMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId ?? `fake-session-${++fakeSession}`,
  };
}

export function deltaMessage(text: string): SdkMessage {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

export function reasoningDeltaMessage(thinking: string): SdkMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking },
    },
  };
}

export function textMessage(text: string): SdkMessage {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

export function toolUseMessage(
  id: string,
  name: string,
  input: unknown,
): SdkMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  };
}

export function toolResultMessage(
  toolUseId: string,
  content: unknown,
  isError = false,
  structured?: unknown,
): SdkMessage {
  return {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError },
      ],
    },
    ...(structured === undefined ? {} : { tool_use_result: structured }),
  };
}

export function successMessage(
  output?: unknown,
  extra: Partial<SdkMessage> = {},
): SdkMessage {
  return {
    type: "result",
    subtype: "success",
    ...(output === undefined ? {} : { structured_output: output }),
    ...extra,
  };
}


export function errorMessage(subtype: string, extra: Partial<SdkMessage> = {}): SdkMessage {
  return { type: "result", subtype, ...extra };
}


/** Stamps any built frame as a subagent's own traffic. */
export function tagged(message: SdkMessage, parentCallId: string): SdkMessage {
  return { ...message, parent_tool_use_id: parentCallId };
}


/**
 * A scripted `send_handoff` — the console-carried typed transfer that replaced
 * the native envelope. The fake dispatches it to the real registered handler,
 * so a test drives the same path production does.
 */
export function sendHandoffUse(
  callId: string,
  to: string,
  fields: {
    action: string;
    stateSummary?: string;
    status?: "pending" | "in_progress" | "blocked" | "needs_verification" | "completed" | "failed";
    category?: "assignment" | "update" | "milestone" | "failure" | "final" | "decision";
    risk?: "low" | "medium" | "high";
    evidence?: { kind: string; ref: string }[];
    resultSummary?: string | null;
    artifacts?: { kind: string; ref: string }[];
    uncertainty?: string[];
    nextAction?: string | null;
    taskId?: string | null;
    dedupeKey?: string;
  },
): SdkMessage {
  return toolUseMessage(callId, "mcp__console_agent__send_handoff", {
    to,
    category: fields.category ?? "update",
    status: fields.status ?? "in_progress",
    risk: fields.risk ?? "low",
    action: fields.action,
    stateSummary: fields.stateSummary ?? fields.action,
    evidence: fields.evidence ?? [],
    resultSummary: fields.resultSummary ?? null,
    artifacts: fields.artifacts ?? [],
    uncertainty: fields.uncertainty ?? [],
    nextAction: fields.nextAction ?? null,
    taskId: fields.taskId ?? null,
    requestExpandedContext: false,
    ...(fields.dedupeKey === undefined ? {} : { dedupeKey: fields.dedupeKey }),
  });
}



