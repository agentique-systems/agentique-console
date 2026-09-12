import { createOpenAI } from "@ai-sdk/openai";
import fs from "node:fs/promises";
import path from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { ToolLoopAgent, isStepCount, jsonSchema, modelMessageSchema, type Agent, type LanguageModel, type ModelMessage, type ToolSet, type LanguageModelUsage } from "ai";
import { z } from "zod";
import type { ProviderModel } from "@agentique-console/core";
import type { AttemptExecutionOutcome, AttemptExecutionRequest, ProviderAdapter } from "./adapter.ts";
import { AdapterAttempt, DEFAULT_ADAPTER_LIMITS, type AdapterLimits } from "./attempt-session.ts";
import { addLocalTools } from "./local-tools.ts";
import { addMcpTools, type McpConnection } from "./mcp-tools.ts";
import { AGENT_INSTRUCTIONS } from "./tool-definitions.ts";
import type { HarnessContinuation, HarnessRun } from "./ai-sdk-harness.ts";

export interface AiSdkAdapterConfig {
  fallbackWorkingDirectory: string;
  continuation?: boolean;
  limits?: Partial<AdapterLimits>;
  models?: ProviderModel[];
  mcpServers?: Record<string, McpConnection>;
  openai?: { apiKey?: string; baseURL?: string };
  anthropic?: { apiKey?: string; baseURL?: string };
  gateway?: { apiKey?: string; baseURL?: string };
  harness?: "pi";
  /** Accept any normal SDK model or Agent without putting SDK types into orchestration. */
  resolveModel?: (model: string) => LanguageModel;
  createAgent?: (settings: { model: LanguageModel; tools: ToolSet; attempt: AdapterAttempt }) => Agent<never, ToolSet>;
}

const historySchema = z.strictObject({ version: z.literal(1), provider: z.literal("ai-sdk"), model: z.string(), kind: z.literal("messages"), messages: z.array(modelMessageSchema) });
const harnessSchema = z.strictObject({ version: z.literal(1), provider: z.literal("ai-sdk"), model: z.string(), kind: z.literal("harness"), sessionId: z.string().min(1).max(200), state: z.record(z.string(), z.unknown()), journal: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).optional() });

export class AiSdkAdapter implements ProviderAdapter {
  readonly provider = "ai-sdk";
  readonly supportsContinuation: boolean;
  constructor(private readonly config: AiSdkAdapterConfig) { this.supportsContinuation = config.continuation ?? true; }

  private model(id: string): LanguageModel {
    if (this.config.resolveModel) return this.config.resolveModel(id);
    const separator = id.indexOf("/");
    const provider = id.slice(0, separator);
    const name = id.slice(separator + 1);
    if (separator < 1 || !name) throw new Error("invalid request: AI SDK models use provider/model identifiers");
    if (provider === "openai") return createOpenAI(this.config.openai)(name);
    if (provider === "anthropic") return createAnthropic(this.config.anthropic)(name);
    if (provider === "gateway") return createGateway(this.config.gateway)(name);
    throw new Error(`invalid request: unconfigured AI SDK model provider ${provider}`);
  }

  async execute(request: AttemptExecutionRequest): Promise<AttemptExecutionOutcome> {
    const attempt = new AdapterAttempt(request, { ...DEFAULT_ADAPTER_LIMITS, ...this.config.limits });
    let closeMcp: (() => Promise<void>) | undefined;
    let harness: HarnessRun | undefined;
    try {
      if (attempt.ended) return await attempt.finish();
      const cwd = request.workingDirectory ?? path.join(this.config.fallbackWorkingDirectory, request.invocationId);
      if (request.workingDirectory === null) await fs.mkdir(cwd, { recursive: true });
      const configuredModel = this.config.models?.find((m) => m.id === request.model);
      if (configuredModel?.efforts.length && !configuredModel.efforts.includes(request.effort)) throw new Error("invalid request: reasoning effort is unsupported for this model");
      addLocalTools(attempt, cwd);
      closeMcp = await addMcpTools(attempt, this.config.mcpServers ?? {});
      const tools: ToolSet = Object.fromEntries(Object.entries(attempt.tools).map(([name, definition]) => [name, {
        description: definition.description,
        inputSchema: definition.jsonSchema ? jsonSchema(definition.jsonSchema) : definition.schema,
        execute: (input: unknown) => attempt.call(name, input),
      }]));
      const messages: ModelMessage[] = [];
      let harnessResume: HarnessContinuation | null = null;
      if (request.continuation !== null && this.supportsContinuation) {
        try {
          if (request.continuation.byteLength > attempt.limits.continuationMaxBytes) throw new Error("oversized");
          const value: unknown = JSON.parse(Buffer.from(request.continuation).toString("utf8"));
          const history = historySchema.safeParse(value);
          const native = harnessSchema.safeParse(value);
          if (history.success && history.data.model === request.model) messages.push(...history.data.messages);
          else if (native.success && native.data.model === request.model) harnessResume = { sessionId: native.data.sessionId, state: native.data.state as unknown as HarnessContinuation["state"], ...(native.data.journal ? { journal: native.data.journal } : {}) };
          else attempt.diagnostics.continuation = "invalid_or_incompatible_fresh";
        } catch { attempt.diagnostics.continuation = "invalid_or_incompatible_fresh"; }
      }
      messages.push({ role: "user", content: request.input.text });
      attempt.diagnostics.continuation ??= messages.length > 1 || harnessResume !== null ? "resumed" : "fresh";
      const isHarness = request.model.startsWith("pi/");
      const stream = await (async () => {
        if (isHarness) {
          if (this.config.harness !== "pi") throw new Error("invalid request: Pi harness is not enabled");
          if (request.model.startsWith("pi/openai/") ? this.config.openai?.baseURL : this.config.anthropic?.baseURL) throw new Error("invalid request: Pi does not support configured endpoint overrides");
          const { streamPiHarness } = await import("./ai-sdk-harness.ts");
          const auth: Record<string, string> = {};
          // Pi prefers gateway routing if a gateway key is present. Supply only
          // the selected native model's credential so identity cannot change.
          if (request.model.startsWith("pi/openai/") && this.config.openai?.apiKey) auth.OPENAI_API_KEY = this.config.openai.apiKey;
          if (request.model.startsWith("pi/anthropic/") && this.config.anthropic?.apiKey) auth.ANTHROPIC_API_KEY = this.config.anthropic.apiKey;
          harness = await streamPiHarness(attempt, tools, request.model.slice(3), auth, harnessResume);
          attempt.diagnostics.agentRuntime = "HarnessAgent/Pi (experimental)";
          return harness.stream;
        }
        const model = this.model(request.model);
        const modelInfo = this.config.models?.find((m) => m.id === request.model);
        if (modelInfo && modelInfo.efforts.length === 0) attempt.diagnostics.effort = "not configurable for this model";
        const agent = this.config.createAgent?.({ model, tools, attempt }) ?? new ToolLoopAgent({
          model, tools, instructions: AGENT_INSTRUCTIONS, maxRetries: 0,
          stopWhen: [isStepCount(attempt.limits.maxTurns), () => attempt.ended],
          ...(request.model.startsWith("openai/") && (!modelInfo || modelInfo.efforts.includes(request.effort)) ? { providerOptions: { openai: { reasoningEffort: request.effort } } } : {}),
        });
        attempt.diagnostics.agentRuntime = this.config.createAgent ? "Agent" : "ToolLoopAgent";
        return agent.stream({ messages, abortSignal: attempt.signal });
      })();
      let steps = 0;
      let finishReason: string | undefined;
      for await (const part of stream.stream) {
        attempt.transcript.append(part);
        if (part.type === "text-delta") request.output({ attemptId: request.attemptId, kind: "text", text: part.text });
        else if (part.type === "error") attempt.fail(part.error);
        else if (part.type === "finish-step") { steps++; this.usage(attempt, part.usage); }
        else if (part.type === "finish") finishReason = part.finishReason;
        else if (part.type === "abort" && !attempt.ended) attempt.controller.abort("provider");
        else if (part.type === "tool-approval-request") {
          // Custom Agents must use the supplied execute functions. No provider approval can grant runtime authority.
          attempt.fail("invalid request: an Agent requested approval outside the runtime tool boundary", "invalid_request");
        }
      }
      attempt.diagnostics.steps = String(steps);
      if (!attempt.ended && steps >= attempt.limits.maxTurns) attempt.fail("AI SDK agent exhausted its step limit", "max_turns");
      if (!attempt.ended && (finishReason === "error" || finishReason === "content-filter")) attempt.fail(`AI SDK finish reason: ${finishReason}`, "invalid_request");
      if (!attempt.ended && finishReason === undefined) attempt.fail("AI SDK stream ended without a terminal event", "process_exit");
      if (this.supportsContinuation && !isHarness && !attempt.signal.aborted) {
        const history = [...messages, ...await stream.responseMessages];
        const bytes = Buffer.from(JSON.stringify({ version: 1, provider: "ai-sdk", model: request.model, kind: "messages", messages: history }));
        if (bytes.length <= attempt.limits.continuationMaxBytes) attempt.continuation = bytes;
        else attempt.diagnostics.continuation = "too_large_fresh_next_attempt";
      }
      if (harness !== undefined && this.supportsContinuation) {
        const state = await harness.stop();
        harness = undefined;
        const bytes = Buffer.from(JSON.stringify({ version: 1, provider: "ai-sdk", model: request.model, kind: "harness", ...state }));
        if (bytes.length <= attempt.limits.continuationMaxBytes) attempt.continuation = bytes;
        else attempt.diagnostics.continuation = "too_large_fresh_next_attempt";
      }
    } catch (error) { attempt.fail(error); }
    finally { await Promise.allSettled([harness?.destroy(), closeMcp?.()]); }
    return attempt.finish();
  }

  private usage(attempt: AdapterAttempt, u: LanguageModelUsage): void {
    const cached = u.inputTokenDetails.cacheReadTokens ?? 0;
    const cacheWrite = u.inputTokenDetails.cacheWriteTokens ?? 0;
    attempt.recordUsage({ input: u.inputTokenDetails.noCacheTokens ?? Math.max(0, (u.inputTokens ?? 0) - cached - cacheWrite), cached, cacheWrite, output: u.outputTokens ?? 0 }, this.config.models?.find((m) => m.id === attempt.request.model));
  }
}
