/**
 * A scripted stand-in for the Claude Agent SDK surface the adapter uses
 * (`ClaudeSdk`), for the deterministic suite. It speaks the SDK's message
 * protocol (`system/init`, `assistant`, `user` tool results,
 * `system/permission_denied`, `system/api_retry`, `rate_limit_event`,
 * `result`) in streaming-input mode and — this is the point — applies the
 * same tool path the CLI applies to every scripted tool call:
 *
 *   1. an unknown tool (not in `tools`, or in `disallowedTools`, and no MCP
 *      tool of that name) fails without any hook or prompt;
 *   2. every `PreToolUse` hook whose matcher fits runs; `deny` wins over
 *      `allow`; `continue: false` ends the turn after the call;
 *   3. a call the hooks left undecided goes to the CLI's own permission
 *      evaluation: a bypass mode, `acceptEdits` for edit tools, an
 *      `allowedTools` rule, or a read-only tool in the default mode allows
 *      it WITHOUT consulting `canUseTool`; otherwise `canUseTool` decides
 *      (or the call is denied when no callback exists or `dontAsk` is set);
 *   4. an allowed native tool "executes" (its scripted result is returned);
 *   5. an allowed MCP tool of an in-process server validates its input
 *      against the registered zod schema and runs the registered handler.
 *
 * The fake records every hook call, prompt call, execution, denial, and
 * unknown tool so a test can prove which path a call took — and therefore
 * that the adapter's hook, not the SDK's defaults, decided it.
 */
import { z } from "zod";
import type { HookJSONOutput, ModelUsage, NonNullableUsage, Options, PermissionResult, Query, SDKAssistantMessageError, SDKMessage, SDKPermissionDenial, SDKUserMessage, TerminalReason } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSdk, ClaudeSdkServerOptions, ClaudeSdkTool } from "./claude-sdk.ts";

export interface FakeCallUsage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

export const DEFAULT_CALL_USAGE: Readonly<FakeCallUsage> = Object.freeze({ input: 100, cacheCreation: 0, cacheRead: 0, output: 20 });

export type FakeSdkStep =
  /** An assistant text message; `messageId` lets two messages share one API message id. */
  | { kind: "text"; text: string; usage?: Partial<FakeCallUsage>; messageId?: string }
  /**
   * An assistant tool_use, then the CLI tool path; `result`/`error` script a native tool's execution. `effect` runs when — and
   * only when — the native tool actually executes (after every hook and permission decision), with the subprocess working
   * directory: a test stands in for the tool's own side effect (a `Write` creating a file in the worktree) without the fake
   * inventing tool semantics of its own.
   */
  | { kind: "tool_use"; name: string; input: Record<string, unknown>; id?: string; result?: string; error?: string; usage?: Partial<FakeCallUsage>; messageId?: string; effect?: (context: { cwd: string }) => void | Promise<void> }
  | { kind: "api_retry"; attempt?: number; maxRetries?: number; status?: number | null; error?: SDKAssistantMessageError }
  /** An assistant message that carries an error and no content. */
  | { kind: "assistant_error"; error: SDKAssistantMessageError }
  | { kind: "rate_limit"; status: "allowed" | "allowed_warning" | "rejected" }
  /** Waits for the abort signal, then throws the SDK's abort error. */
  | { kind: "hang" }
  | { kind: "throw"; error: Error }
  /** The subprocess dies: the stream ends without a result message. */
  | { kind: "exit" };

export interface FakeSdkResult {
  subtype?: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries";
  isError?: boolean;
  /** The final text of a success result. */
  result?: string;
  errors?: string[];
  terminalReason?: TerminalReason;
  costUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  /** Per-model usage; `null` for a result without `modelUsage` figures; omitted derives one entry from the turn's calls. */
  modelUsage?: Record<string, Partial<ModelUsage>> | null;
  /** The main-loop usage; `null` omits it; omitted derives it from the turn's calls. */
  usage?: Partial<NonNullableUsage> | null;
  numTurns?: number;
}

export interface FakeSdkTurn {
  steps: FakeSdkStep[];
  /** The result message after the steps; `null` ends the stream without one (the subprocess died after the steps). */
  result?: FakeSdkResult | null;
}

export interface FakeSdkCapture {
  options: Options[];
  /** The text of every user message received. */
  prompts: string[];
  hookCalls: { tool: string; input: unknown; output: HookJSONOutput }[];
  /** Every `canUseTool` consultation. */
  promptCalls: { tool: string; input: unknown; result: PermissionResult }[];
  /** Native tools that actually executed. */
  executed: { tool: string; input: unknown }[];
  /** In-process MCP tool handler calls. */
  mcpCalls: { tool: string; input: unknown; isError: boolean; text: string }[];
  /** MCP calls the server's schema validation refused before the handler. */
  mcpRejected: { tool: string; input: unknown }[];
  denied: string[];
  unknownTools: string[];
  /** Times the consumer ended the stream early (`return`). */
  returned: number;
  interrupts: number;
  servers: Record<string, ClaudeSdkTool[]>;
  serverOptions: Record<string, ClaudeSdkServerOptions>;
}

/** Edit tools `acceptEdits` allows without a prompt. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "NotebookEdit"]);
/** Read-only tools the CLI allows in the default mode without ever consulting `canUseTool`. */
export const READ_ONLY_AUTO_ALLOWED: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "WebSearch", "TodoWrite", "TaskList", "TaskGet"]);

interface McpToolBinding {
  server: string;
  tool: ClaudeSdkTool;
}

function textOf(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  return content.map((block) => ("text" in block && typeof block.text === "string" ? block.text : "")).join("");
}

function abortError(): Error {
  const error = new Error("Claude Code process aborted by user");
  error.name = "AbortError";
  return error;
}

export class FakeClaudeSdk implements ClaudeSdk {
  readonly captured: FakeSdkCapture = { options: [], prompts: [], hookCalls: [], promptCalls: [], executed: [], mcpCalls: [], mcpRejected: [], denied: [], unknownTools: [], returned: 0, interrupts: 0, servers: {}, serverOptions: {} };
  readonly #turns: FakeSdkTurn[] = [];
  #counter = 0;

  /** Queues the turns consumed one per user message, across every `query`. */
  script(...turns: FakeSdkTurn[]): void {
    this.#turns.push(...turns);
  }

  get remainingTurns(): number {
    return this.#turns.length;
  }

  createSdkMcpServer(options: ClaudeSdkServerOptions) {
    const tools = options.tools ?? [];
    this.captured.servers[options.name] = tools;
    this.captured.serverOptions[options.name] = options;
    return { type: "sdk" as const, name: options.name, instance: { fakeTools: tools } as never };
  }

  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query {
    const { options } = params;
    this.captured.options.push(options);
    const generator = this.#run(params.prompt, options);
    const originalReturn = generator.return.bind(generator);
    generator.return = async (value: void | PromiseLike<void>) => {
      this.captured.returned += 1;
      return originalReturn(value);
    };
    return Object.assign(generator, {
      interrupt: async () => {
        this.captured.interrupts += 1;
        return undefined;
      },
    }) as unknown as Query;
  }

  async *#run(prompt: AsyncIterable<SDKUserMessage>, options: Options): AsyncGenerator<SDKMessage, void, void> {
    const signal = options.abortController?.signal;
    const throwIfAborted = () => {
      if (signal?.aborted) throw abortError();
    };
    const sessionId = `fake-session-${(this.#counter += 1)}`;
    const model = options.model ?? "claude-fake";
    const disallowed = new Set(options.disallowedTools ?? []);
    const available = new Set((Array.isArray(options.tools) ? options.tools : []).filter((tool) => !disallowed.has(tool)));
    const mcp = new Map<string, McpToolBinding>();
    for (const [server, config] of Object.entries(options.mcpServers ?? {})) {
      if (config.type !== "sdk") continue;
      const tools = ((config.instance as unknown as { fakeTools?: ClaudeSdkTool[] }).fakeTools ?? []) as ClaudeSdkTool[];
      for (const tool of tools) mcp.set(`mcp__${server}__${tool.name}`, { server, tool });
    }
    const uuid = () => `00000000-0000-4000-8000-${String((this.#counter += 1)).padStart(12, "0")}`;
    yield {
      type: "system",
      subtype: "init",
      ...(options.agents === undefined ? {} : { agents: Object.keys(options.agents) }),
      apiKeySource: "user",
      claude_code_version: "fake",
      cwd: options.cwd ?? "",
      tools: [...available, ...mcp.keys()],
      mcp_servers: Object.keys(options.mcpServers ?? {}).map((name) => ({ name, status: "connected" })),
      model,
      permissionMode: options.permissionMode ?? "default",
      slash_commands: [],
      output_style: "default",
      skills: [],
      plugins: [],
      uuid: uuid() as never,
      session_id: sessionId,
    } as SDKMessage;

    for await (const user of prompt) {
      throwIfAborted();
      this.captured.prompts.push(textOf(user));
      const turn = this.#turns.shift();
      if (turn === undefined) throw new Error("FakeClaudeSdk: no scripted turn for the user message");
      const denials: SDKPermissionDenial[] = [];
      const totals: FakeCallUsage = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };
      const seenMessageIds = new Set<string>();
      let calls = 0;
      let stopped: string | null = null;
      let exited = false;
      for (const step of turn.steps) {
        throwIfAborted();
        if (stopped !== null) break;
        switch (step.kind) {
          case "text":
          case "tool_use": {
            calls += 1;
            const usage = { ...DEFAULT_CALL_USAGE, ...step.usage };
            const messageId = step.messageId ?? `msg_${(this.#counter += 1)}`;
            if (!seenMessageIds.has(messageId)) {
              seenMessageIds.add(messageId);
              totals.input += usage.input;
              totals.cacheCreation += usage.cacheCreation;
              totals.cacheRead += usage.cacheRead;
              totals.output += usage.output;
            }
            const toolUseId = step.kind === "tool_use" ? (step.id ?? `toolu_${(this.#counter += 1)}`) : null;
            const content = step.kind === "text" ? [{ type: "text", text: step.text }] : [{ type: "tool_use", id: toolUseId, name: step.name, input: step.input }];
            yield this.assistant(messageId, model, content, usage, sessionId, uuid());
            if (step.kind === "tool_use") {
              const handled = await this.#toolPath(step, toolUseId!, options, available, mcp, sessionId, signal);
              for (const message of handled.messages) yield { ...message, uuid: uuid() as never, session_id: sessionId } as SDKMessage;
              if (handled.denial !== null) denials.push(handled.denial);
              stopped = handled.stop;
            }
            break;
          }
          case "api_retry":
            yield { type: "system", subtype: "api_retry", attempt: step.attempt ?? 1, max_retries: step.maxRetries ?? 3, retry_delay_ms: 1000, error_status: step.status ?? null, error: step.error ?? "server_error", uuid: uuid() as never, session_id: sessionId } as SDKMessage;
            break;
          case "assistant_error":
            calls += 1;
            yield { type: "assistant", message: { id: `msg_${(this.#counter += 1)}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: null }, parent_tool_use_id: null, error: step.error, uuid: uuid() as never, session_id: sessionId } as unknown as SDKMessage;
            break;
          case "rate_limit":
            yield { type: "rate_limit_event", rate_limit_info: { status: step.status, resetsAt: 0, rateLimitType: "five_hour", utilization: 1 }, uuid: uuid() as never, session_id: sessionId } as unknown as SDKMessage;
            break;
          case "hang":
            if (signal === undefined) throw new Error("FakeClaudeSdk: a hang step needs an abort controller");
            if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            throw abortError();
          case "throw":
            throw step.error;
          case "exit":
            exited = true;
            break;
        }
        if (exited) return;
      }
      if (turn.result === null) return;
      yield this.result(turn.result ?? {}, { model, sessionId, uuid: uuid(), calls, totals, denials, stopped });
    }
  }

  private assistant(messageId: string, model: string, content: unknown[], usage: FakeCallUsage, sessionId: string, uuid: string): SDKMessage {
    return {
      type: "assistant",
      message: { id: messageId, type: "message", role: "assistant", model, content, stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: usage.output, cache_creation_input_tokens: usage.cacheCreation, cache_read_input_tokens: usage.cacheRead } },
      parent_tool_use_id: null,
      uuid,
      session_id: sessionId,
    } as unknown as SDKMessage;
  }

  private result(spec: FakeSdkResult, context: { model: string; sessionId: string; uuid: string; calls: number; totals: FakeCallUsage; denials: SDKPermissionDenial[]; stopped: string | null }): SDKMessage {
    const subtype = spec.subtype ?? "success";
    const cost = spec.costUsd ?? Number((context.calls * 0.001).toFixed(6));
    const usage: NonNullableUsage | undefined =
      spec.usage === null
        ? undefined
        : ({ input_tokens: context.totals.input, output_tokens: context.totals.output, cache_creation_input_tokens: context.totals.cacheCreation, cache_read_input_tokens: context.totals.cacheRead, ...spec.usage } as NonNullableUsage);
    const modelUsage: Record<string, ModelUsage> =
      spec.modelUsage === null
        ? {}
        : spec.modelUsage === undefined
          ? { [context.model]: { inputTokens: context.totals.input, outputTokens: context.totals.output, cacheReadInputTokens: context.totals.cacheRead, cacheCreationInputTokens: context.totals.cacheCreation, webSearchRequests: 0, costUSD: cost, contextWindow: 200_000, maxOutputTokens: 32_000 } }
          : Object.fromEntries(Object.entries(spec.modelUsage).map(([name, u]) => [name, { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 200_000, maxOutputTokens: 32_000, ...u }]));
    const base = {
      type: "result" as const,
      duration_ms: spec.durationMs ?? 1234,
      duration_api_ms: spec.durationApiMs ?? 1000,
      is_error: spec.isError ?? subtype !== "success",
      num_turns: spec.numTurns ?? context.calls,
      stop_reason: "end_turn",
      total_cost_usd: cost,
      ...(usage === undefined ? {} : { usage }),
      modelUsage,
      permission_denials: context.denials,
      terminal_reason: spec.terminalReason ?? (context.stopped !== null ? "hook_stopped" : subtype === "success" ? "completed" : undefined),
      uuid: context.uuid,
      session_id: context.sessionId,
    };
    if (subtype === "success") return { ...base, subtype, result: spec.result ?? (context.stopped ?? "done") } as unknown as SDKMessage;
    return { ...base, subtype, errors: spec.errors ?? [] } as unknown as SDKMessage;
  }

  /** The CLI tool path for one tool_use: unknown → hooks → own permission evaluation → execution. */
  async #toolPath(
    step: Extract<FakeSdkStep, { kind: "tool_use" }>,
    toolUseId: string,
    options: Options,
    available: Set<string>,
    mcp: Map<string, McpToolBinding>,
    sessionId: string,
    signal: AbortSignal | undefined,
  ): Promise<{ messages: Partial<SDKMessage>[]; denial: SDKPermissionDenial | null; stop: string | null }> {
    const name = step.name;
    const toolResult = (text: string, isError: boolean): Partial<SDKMessage> => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text, is_error: isError }] }, parent_tool_use_id: null }) as Partial<SDKMessage>;
    if (!available.has(name) && !mcp.has(name)) {
      this.captured.unknownTools.push(name);
      return { messages: [toolResult(`Error: Unknown tool ${name}`, true)], denial: null, stop: null };
    }
    let decision: "allow" | "deny" | "ask" = "ask";
    let reason = "";
    let stop: string | null = null;
    for (const matcher of options.hooks?.PreToolUse ?? []) {
      if (matcher.matcher !== undefined && !new RegExp(matcher.matcher).test(name)) continue;
      for (const hook of matcher.hooks) {
        const output = await hook({ hook_event_name: "PreToolUse", tool_name: name, tool_input: step.input, tool_use_id: toolUseId, session_id: sessionId, transcript_path: "", cwd: options.cwd ?? "", permission_mode: options.permissionMode ?? "default" }, toolUseId, { signal: signal ?? new AbortController().signal });
        this.captured.hookCalls.push({ tool: name, input: step.input, output });
        if ("async" in output) continue;
        const specific = output.hookSpecificOutput;
        const verdict = specific !== undefined && specific.hookEventName === "PreToolUse" ? specific.permissionDecision : undefined;
        if (verdict === "deny") {
          decision = "deny";
          reason = (specific !== undefined && specific.hookEventName === "PreToolUse" ? specific.permissionDecisionReason : undefined) ?? "denied by hook";
        } else if (verdict === "allow" && decision !== "deny") {
          decision = "allow";
        }
        if (output.continue === false) stop = output.stopReason ?? "stopped by hook";
      }
    }
    if (decision === "ask") {
      const mode = options.permissionMode ?? "default";
      if (mode === "bypassPermissions") decision = "allow";
      else if (mode === "acceptEdits" && EDIT_TOOLS.has(name)) decision = "allow";
      else if ((options.allowedTools ?? []).includes(name)) decision = "allow";
      else if (READ_ONLY_AUTO_ALLOWED.has(name) && mode !== "dontAsk") decision = "allow";
      else if (mode === "dontAsk" || options.canUseTool === undefined) {
        decision = "deny";
        reason = "no permission prompt is available";
      } else {
        const answer = await options.canUseTool(name, step.input, { signal: signal ?? new AbortController().signal, toolUseID: toolUseId, requestId: `req_${toolUseId}` });
        // A callback that answers nothing leaves the call unpermitted.
        const result: PermissionResult = answer ?? { behavior: "deny", message: "no permission decision" };
        this.captured.promptCalls.push({ tool: name, input: step.input, result });
        if (result.behavior === "allow") decision = "allow";
        else {
          decision = "deny";
          reason = result.message;
          if (result.interrupt === true) stop = result.message;
        }
      }
    }
    if (decision === "deny") {
      this.captured.denied.push(name);
      return { messages: [{ type: "system", subtype: "permission_denied", tool_name: name, tool_use_id: toolUseId } as Partial<SDKMessage>, toolResult(`Permission denied: ${reason}`, true)], denial: { tool_name: name, tool_use_id: toolUseId, tool_input: step.input }, stop };
    }
    const binding = mcp.get(name);
    if (binding !== undefined) {
      const schema = binding.tool.inputSchema as unknown;
      const parser: z.ZodType = typeof (schema as { safeParse?: unknown }).safeParse === "function" ? (schema as z.ZodType) : z.object(schema as z.ZodRawShape);
      const parsed = parser.safeParse(step.input);
      if (!parsed.success) {
        this.captured.mcpRejected.push({ tool: name, input: step.input });
        return { messages: [toolResult(`MCP error -32602: Invalid arguments for tool ${binding.tool.name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, true)], denial: null, stop };
      }
      const result = (await binding.tool.handler(parsed.data as never, {})) as { content: { type: string; text?: string }[]; isError?: boolean };
      const text = result.content.map((c) => c.text ?? "").join("");
      this.captured.mcpCalls.push({ tool: name, input: step.input, isError: result.isError === true, text });
      return { messages: [toolResult(text, result.isError === true)], denial: null, stop };
    }
    if (step.effect !== undefined) await step.effect({ cwd: options.cwd ?? "" });
    this.captured.executed.push({ tool: name, input: step.input });
    return { messages: [toolResult(step.error ?? step.result ?? `${name} ok`, step.error !== undefined)], denial: null, stop };
  }
}
