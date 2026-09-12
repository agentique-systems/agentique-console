import { runtimeToolResultBlocksInvocation, type JsonValue, type ProviderModel, type RuntimeToolCallRequest } from "@agentique-console/core";
import { z } from "zod";
import type { AttemptExecutionOutcome, AttemptExecutionRequest, InterruptionCause, ProviderCompletion, UsageChunk } from "./adapter.ts";
import { classifyProviderFailure, sanitizeFailureMessage } from "./failure-classifier.ts";
import { RETURN_RESULT_SHAPE, RUNTIME_TOOL_INPUT_SHAPES } from "./runtime-tool-shapes.ts";
import { RETURN_RESULT_DESCRIPTION, RETURN_RESULT_TOOL, RUNTIME_TOOL_DESCRIPTIONS } from "./tool-definitions.ts";

export interface AdapterTool {
  description: string;
  schema: z.ZodType;
  /** MCP tools supply their server's original JSON Schema. */
  jsonSchema?: Record<string, unknown>;
  /** Runtime tools omit this; capability calls carry the canonical authorization name. */
  capability?: string;
  execute(input: unknown): Promise<unknown>;
}

export interface AdapterLimits {
  maxTurns: number;
  transcriptMaxBytes: number;
  toolResultMaxBytes: number;
  continuationMaxBytes: number;
  toolTimeoutMs: number;
}
export const DEFAULT_ADAPTER_LIMITS: AdapterLimits = { maxTurns: 200, transcriptMaxBytes: 1_048_576, toolResultMaxBytes: 131_072, continuationMaxBytes: 4_194_304, toolTimeoutMs: 60_000 };

/** Bounded diagnostic stream. Session identifiers and authentication are never transcript content. */
export class ProviderTranscript {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly maxBytes: number) {}
  append(value: unknown): void {
    if (this.truncated) return;
    const line = JSON.stringify(value, (key, member: unknown) => {
      if (/^(session_?id|thread_?id|resume.*|continuation|transcript_path|env|headers|api_?key|authorization|access_token|refresh_token)$/i.test(key)) return "[redacted]";
      return typeof member === "string" ? redactSecrets(member) : member;
    });
    const bytes = Buffer.from(`${line}\n`);
    if (this.size + bytes.length > this.maxBytes) { this.truncated = true; return; }
    this.chunks.push(bytes);
    this.size += bytes.length;
  }
  bytes(): Uint8Array | null { return this.size ? Buffer.concat(this.chunks) : null; }
}

export function redactSecrets(value: string): string {
  return value.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/\b(?:Bearer|api_key|apiKey|access_token|refresh_token)\s*[:=]?\s*[A-Za-z0-9_.-]{12,}/gi, "[redacted]");
}

export function interruptionCause(signal: AbortSignal): InterruptionCause {
  const reason: unknown = signal.reason;
  return reason === "cancelled" || reason === "operator_pause" || reason === "deadline" || reason === "shutdown" ? reason : "provider";
}

/** Shared tool/stop boundary. SDKs own their loops; this owns only one Attempt's adapter state. */
export class AdapterAttempt {
  readonly controller = new AbortController();
  readonly startedAt = new Date().toISOString();
  readonly startedMs = performance.now();
  readonly transcript: ProviderTranscript;
  readonly tools: Record<string, AdapterTool> = Object.create(null) as Record<string, AdapterTool>;
  readonly diagnostics: Record<string, string> = {};
  readonly usage: UsageChunk[] = [];
  completion: ProviderCompletion | null = null;
  result: unknown = null;
  continuation: Uint8Array | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private calls = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly abort = () => this.controller.abort(this.request.signal.reason);

  constructor(readonly request: AttemptExecutionRequest, readonly limits: AdapterLimits = DEFAULT_ADAPTER_LIMITS) {
    this.transcript = new ProviderTranscript(limits.transcriptMaxBytes);
    if (request.signal.aborted) this.abort();
    else request.signal.addEventListener("abort", this.abort, { once: true });
    if (request.deadlineAt !== null) {
      const remaining = Date.parse(request.deadlineAt) - Date.now();
      if (!Number.isFinite(remaining)) throw new TypeError("Invalid Attempt deadline");
      if (remaining <= 0) this.controller.abort("deadline");
      else {
        this.timer = setTimeout(() => this.controller.abort("deadline"), Math.min(remaining, 2_147_483_647));
        this.timer.unref();
      }
    }
    for (const name of request.runtimeTools.tools) this.add(name, {
      description: RUNTIME_TOOL_DESCRIPTIONS[name], schema: z.object(RUNTIME_TOOL_INPUT_SHAPES[name]),
      execute: async (input) => {
        const outcome = await request.runtimeTools.call({ tool: name, input } as RuntimeToolCallRequest);
        if (outcome.kind === "accepted" && runtimeToolResultBlocksInvocation(outcome.result) && outcome.result.tool === "request_decision") this.stop({ kind: "decision_requested", decisionId: outcome.result.decisionId });
        return outcome;
      },
    });
    this.add(RETURN_RESULT_TOOL, {
      description: RETURN_RESULT_DESCRIPTION, schema: z.object(RETURN_RESULT_SHAPE),
      execute: async (input) => {
        this.result = input;
        this.stop({ kind: "completed" }, false);
        return { recorded: true, instruction: "End your turn now. No further calls are permitted." };
      },
    });
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get toolCalls(): number { return this.calls; }
  get ended(): boolean { return this.completion !== null || this.signal.aborted; }
  add(name: string, tool: AdapterTool): void {
    if (Object.hasOwn(this.tools, name)) throw new TypeError(`Duplicate provider tool: ${name}`);
    this.tools[name] = tool;
  }
  stop(completion: ProviderCompletion, abort = true): void {
    if (this.completion !== null) return;
    this.completion = completion;
    if (abort) this.controller.abort("adapter_stop");
  }

  /** Serial admission prevents a parallel tool batch from crossing a committed stop boundary. */
  call(name: string, input: unknown): Promise<unknown> {
    const result = this.queue.then(() => this.invoke(name, input));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async invoke(name: string, input: unknown): Promise<unknown> {
    if (this.ended) return { error: "The Attempt has ended; this call did not execute." };
    const tool = this.tools[name];
    if (!tool) return { error: "Tool is unavailable in this Attempt." };
    if (++this.calls > this.limits.maxTurns) {
      this.fail("max_turns: provider tool-call bound exhausted", "max_turns");
      return { error: "Attempt tool-call bound exhausted." };
    }
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) return { error: "Invalid tool input", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) };
    try {
      if (tool.capability !== undefined) {
        const call = { tool: tool.capability, input: JSON.parse(JSON.stringify(input)) as JsonValue };
        const auth = this.request.authorization.authorize(call);
        switch (auth.kind) {
          case "allowed": case "approved_once": break;
          case "approval_required": this.stop({ kind: "approval_required", call }); return { error: "Operator approval required. The Attempt has ended." };
          case "interrupted": this.stop({ kind: "interrupted", cause: auth.cause, message: `Run interrupted: ${auth.cause}` }); return { error: "Run interrupted." };
          case "failed": this.stop({ kind: "tool_failure", tool: tool.capability, message: sanitizeFailureMessage(auth.message) }); return { error: "Authorization failed." };
          case "invalid": case "denied": return { error: `Tool authorization: ${auth.kind}` };
        }
      }
      this.request.output({ attemptId: this.request.attemptId, kind: "tool_call", text: name });
      const result = await tool.execute(parsed.data);
      const text = JSON.stringify(result ?? null);
      this.transcript.append({ type: "tool", name, result });
      if (Buffer.byteLength(text) > this.limits.toolResultMaxBytes) return { error: "Tool response exceeds the size bound. Request a smaller range." };
      return result ?? null;
    } catch (error) {
      if (!this.ended) this.stop({ kind: "tool_failure", tool: tool.capability ?? name, message: sanitizeFailureMessage(error instanceof Error ? error.message : String(error)) });
      return { error: "Tool execution failed. The Attempt has ended." };
    }
  }

  fail(error: unknown, kind?: Parameters<typeof classifyProviderFailure>[0]["kind"]): void {
    if (this.ended) return;
    const text = error instanceof Error ? error.message : String(error);
    const metadata = error !== null && typeof error === "object" ? error as { statusCode?: unknown; status?: unknown; name?: unknown } : {};
    const status = metadata.statusCode ?? metadata.status;
    if (kind === undefined && typeof status === "number") {
      if (status === 401 || status === 403) kind = "authentication";
      else if (status === 402) kind = "billing";
      else if (status === 429) kind = "rate_limited";
      else if (status >= 500) kind = "server_error";
      else if (status >= 400) kind = "invalid_request";
    }
    if (kind === undefined && typeof metadata.name === "string" && /LoadAPIKey|Authentication|Credentials/.test(metadata.name)) kind = "authentication";
    const failure = classifyProviderFailure({ text, ...(kind === undefined ? {} : { kind }) });
    this.stop({ kind: "provider_error", transient: failure.transient, message: failure.message });
  }

  recordUsage(tokens: { input: number; cached: number; cacheWrite: number; output: number }, model?: ProviderModel): void {
    const counts = Object.fromEntries(Object.entries(tokens).map(([key, value]) => [key, Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0])) as typeof tokens;
    const price = model?.pricing;
    const cost = price ? (counts.input * price.input + counts.cached * price.cacheRead + counts.cacheWrite * price.cacheWrite + counts.output * price.output) / 1_000_000 : 0;
    this.diagnostics.costUnknown = String(price === undefined);
    this.usage.push({ model: this.request.model, effort: this.request.effort, inputTokensUncached: counts.input, cacheReadTokens: counts.cached, cacheCreationTokens: counts.cacheWrite, outputTokens: counts.output, costUsd: cost, ...(price === undefined ? { costKnown: false } : {}), wallClockMs: 0, providerMs: null });
  }

  async finish(): Promise<AttemptExecutionOutcome> {
    await this.queue;
    clearTimeout(this.timer);
    this.request.signal.removeEventListener("abort", this.abort);
    const elapsed = Math.round(performance.now() - this.startedMs);
    if (this.usage[0]) this.usage[0].wallClockMs = elapsed;
    const interruption = this.request.signal.aborted ? this.request.signal : this.signal;
    const completion = this.completion?.kind === "decision_requested" || this.completion?.kind === "approval_required" || this.completion?.kind === "tool_failure" ? this.completion
      : interruption.aborted && interruption.reason !== "adapter_stop" ? { kind: "interrupted" as const, cause: interruptionCause(interruption), message: `Attempt interrupted: ${interruptionCause(interruption)}` }
      : this.completion ?? { kind: "completed" as const };
    return { completion, result: completion.kind === "completed" ? this.result : null, usage: this.usage, transcript: this.transcript.bytes(), continuation: this.continuation, timing: { startedAt: this.startedAt, endedAt: new Date().toISOString(), providerMs: null }, diagnostics: { ...this.diagnostics, toolCalls: String(this.calls), transcriptTruncated: String(this.transcript.truncated), usageAvailable: String(this.usage.length > 0) } };
  }
}
