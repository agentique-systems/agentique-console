import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { CodexOptions, ThreadEvent, ThreadOptions, Input, TurnOptions } from "@openai/codex-sdk";
import type { AttemptExecutionRequest, TransientOutput } from "./adapter.ts";
import { CodexSdkAdapter } from "./codex-adapter.ts";
import { AiSdkAdapter } from "./ai-sdk-adapter.ts";

export const CONTRACT_RESULT = { status: "completed", artifactIds: [], tasks: [], evidence: [], summary: "done", openItems: [], blocker: null, runOutcome: null, routeSelection: null, evaluation: null, finalReport: null };
export type ToolScript = { name: string; input: unknown }[][];

export function contractRequest(directory: string, overrides: Partial<AttemptExecutionRequest> = {}) {
  const controller = new AbortController();
  const outputs: TransientOutput[] = [];
  const text = "Execute the Attempt. Return the required typed result.";
  const request: AttemptExecutionRequest = {
    attemptId: "att_000000000000000000000001" as never,
    invocationId: "inv_000000000000000000000001" as never,
    runId: "run_000000000000000000000001" as never,
    model: "test-model", effort: "medium", input: { rendererVersion: 1, text, digest: createHash("sha256").update(text).digest("hex") },
    capabilities: { tools: [], mcpServers: [] }, toolPolicy: {}, authorization: { authorize: ({ tool }) => ({ kind: "allowed", tool }) },
    runtimeTools: { tools: [], call: async () => { throw new Error("Unexpected runtime tool"); } },
    workingDirectory: directory, deadlineAt: null, signal: controller.signal, continuation: null,
    output: (output) => outputs.push(output), ...overrides,
  };
  return { request, controller, outputs };
}

export function contractAdapter(provider: "codex" | "ai-sdk", directory: string, script: ToolScript = [[{ name: "return_result", input: CONTRACT_RESULT }]], error?: Error | ((resumed: boolean) => Error | undefined)) {
  const calls: { name: string; input: unknown; result: unknown }[] = [];
  const options: CodexOptions[] = [];
  const threads: { resume: string | null; options: ThreadOptions | undefined }[] = [];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const failure = typeof error === "function" ? error(false) : error;
      if (failure) throw failure;
      const step = script.shift();
      if (!step) throw new Error("Unexpected model step");
      return { stream: convertArrayToReadableStream([
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "working" }, { type: "text-end" as const, id: "text" },
        ...step.map((call, index) => ({ type: "tool-call" as const, toolCallId: `call-${model.doStreamCalls.length}-${index}`, toolName: call.name, input: JSON.stringify(call.input) })),
        { type: "finish" as const, finishReason: { unified: step.length ? "tool-calls" as const : "stop" as const, raw: "test" }, usage: { inputTokens: { total: 100, noCache: 70, cacheRead: 20, cacheWrite: 10 }, outputTokens: { total: 50, text: 40, reasoning: 10 } } },
      ]) };
    },
  });
  const config = { fallbackWorkingDirectory: directory, models: [{ id: "test-model", label: "test", efforts: ["medium"], contextWindowTokens: 200_000, pricing: { input: 1, cacheRead: 0.1, cacheWrite: 1.2, output: 5 } }] };
  const adapter = provider === "ai-sdk" ? new AiSdkAdapter({ ...config, resolveModel: () => model }) : new CodexSdkAdapter({
    ...config, home: directory,
    createClient: (settings) => {
      options.push(settings);
      const make = (resume: string | null, threadOptions: ThreadOptions | undefined) => {
        threads.push({ resume, options: threadOptions });
        return { id: "thread_contract_123", runStreamed: async (_input: Input, turnOptions?: TurnOptions) => ({
          events: (async function* (): AsyncGenerator<ThreadEvent> {
            const failure = typeof error === "function" ? error(resume !== null) : error;
            if (failure) throw failure;
            yield { type: "thread.started", thread_id: "thread_contract_123" };
            const entry = (settings.config?.mcp_servers as Record<string, { url: string }>).agentique!;
            const client = new Client({ name: "codex-contract", version: "1" });
            try {
              await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: { Authorization: `Bearer ${settings.env?.AGENTIQUE_MCP_TOKEN}` } } }));
              await client.listTools();
              yield { type: "item.completed", item: { type: "agent_message", id: "text", text: "working" } };
              for (const step of script) {
                for (const call of step) {
                  const result = await client.callTool({ name: call.name, arguments: call.input as Record<string, unknown> });
                  calls.push({ ...call, result });
                  if (turnOptions?.signal?.aborted) return;
                }
              }
              yield { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 10 } };
            } finally { await client.close(); }
          })(),
        }) };
      };
      return { startThread: (threadOptions) => make(null, threadOptions), resumeThread: (id, threadOptions) => make(id, threadOptions) };
    },
  });
  return { adapter, calls, options, threads, model };
}
