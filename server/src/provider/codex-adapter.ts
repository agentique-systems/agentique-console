import fs from "node:fs/promises";
import path from "node:path";
import { Codex, type CodexOptions, type Thread, type ThreadOptions } from "@openai/codex-sdk";
import type { ProviderModel } from "@agentique-console/core";
import { z } from "zod";
import type { AttemptExecutionOutcome, AttemptExecutionRequest, ProviderAdapter } from "./adapter.ts";
import { AdapterAttempt, DEFAULT_ADAPTER_LIMITS, type AdapterLimits } from "./attempt-session.ts";
import { addLocalTools } from "./local-tools.ts";
import { addMcpTools, type McpConnection } from "./mcp-tools.ts";
import { startMcpBridge } from "./mcp-bridge.ts";
import { AGENT_INSTRUCTIONS } from "./tool-definitions.ts";
import { guardedCodexCatalog } from "./codex-model-catalog.ts";

export interface CodexClient {
  startThread(options?: ThreadOptions): Pick<Thread, "runStreamed" | "id">;
  resumeThread(id: string, options?: ThreadOptions): Pick<Thread, "runStreamed" | "id">;
}
export interface CodexAdapterConfig {
  home: string;
  fallbackWorkingDirectory: string;
  apiKey?: string;
  baseUrl?: string;
  codexPathOverride?: string;
  environment?: NodeJS.ProcessEnv;
  continuation?: boolean;
  limits?: Partial<AdapterLimits>;
  models?: ProviderModel[];
  mcpServers?: Record<string, McpConnection>;
  /** Production uses the official SDK; tests inject the same thread/event surface. */
  createClient?: (options: CodexOptions) => CodexClient;
}

const continuationSchema = z.strictObject({ version: z.literal(1), provider: z.literal("codex"), model: z.string(), threadId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) });

export class CodexSdkAdapter implements ProviderAdapter {
  readonly provider = "codex";
  readonly supportsContinuation: boolean;
  constructor(private readonly config: CodexAdapterConfig) { this.supportsContinuation = config.continuation ?? true; }

  async execute(request: AttemptExecutionRequest): Promise<AttemptExecutionOutcome> {
    const attempt = new AdapterAttempt(request, { ...DEFAULT_ADAPTER_LIMITS, ...this.config.limits });
    let closeMcp: (() => Promise<void>) | undefined;
    let bridge: Awaited<ReturnType<typeof startMcpBridge>> | undefined;
    let catalog: Awaited<ReturnType<typeof guardedCodexCatalog>> | undefined;
    try {
      if (attempt.ended) return await attempt.finish();
      const cwd = request.workingDirectory ?? path.join(this.config.fallbackWorkingDirectory, request.invocationId);
      if (request.workingDirectory === null) await fs.mkdir(cwd, { recursive: true });
      const modelInfo = this.config.models?.find((m) => m.id === request.model);
      if (modelInfo?.efforts.length && !modelInfo.efforts.includes(request.effort)) throw new Error("invalid request: reasoning effort is unsupported for this model");
      addLocalTools(attempt, cwd);
      closeMcp = await addMcpTools(attempt, this.config.mcpServers ?? {});
      bridge = await startMcpBridge(attempt);
      await fs.mkdir(this.config.home, { recursive: true });
      const source = this.config.environment ?? process.env;
      const env: Record<string, string> = {};
      // Child environment contains OS necessities and explicitly selected credentials, never a parent session.
      for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]) {
        if (source[key] !== undefined) env[key] = source[key];
      }
      env.CODEX_HOME = path.resolve(this.config.home);
      env.AGENTIQUE_MCP_TOKEN = bridge.token;
      if (!this.config.createClient) catalog = await guardedCodexCatalog(this.config.home, request.model, env, attempt.signal, this.config.codexPathOverride);
      const client = (this.config.createClient ?? ((options) => new Codex(options)))({
        env,
        ...(this.config.apiKey === undefined ? {} : { apiKey: this.config.apiKey }),
        ...(this.config.baseUrl === undefined ? {} : { baseUrl: this.config.baseUrl }),
        ...(this.config.codexPathOverride === undefined ? {} : { codexPathOverride: this.config.codexPathOverride }),
        // Replace, rather than merge, any ambient MCP catalog in the dedicated CLI home.
        configOverrides: [`mcp_servers={agentique={url=${JSON.stringify(bridge.url)},bearer_token_env_var="AGENTIQUE_MCP_TOKEN",required=true,tool_timeout_sec=${Math.ceil(attempt.limits.toolTimeoutMs / 1000)}}}`],
        config: {
          developer_instructions: AGENT_INSTRUCTIONS,
          project_doc_max_bytes: 0,
          ...(catalog ? { model_catalog_json: catalog.filename } : {}),
          agents: { enabled: false },
          tools: { experimental_request_user_input: { enabled: false }, update_plan: { enabled: false } },
          features: { shell_tool: false, unified_exec: false, multi_agent: false, multi_agent_v2: false, apps: false, plugins: false, hooks: false, memories: false, goals: false, browser_use: false, computer_use: false, image_generation: false, view_image: false, code_mode: false, code_mode_host: false, skill_search: false, skill_mcp_dependency_install: false, skip_host_skill_discovery: true, shell_snapshot: false, sleep_tool: false, worktrees: false },
          web_search: "disabled",
          mcp_servers: { agentique: { url: bridge.url, bearer_token_env_var: "AGENTIQUE_MCP_TOKEN", required: true, tool_timeout_sec: Math.ceil(attempt.limits.toolTimeoutMs / 1000) } },
        },
      });
      let resume: z.infer<typeof continuationSchema> | null = null;
      if (request.continuation !== null && this.supportsContinuation) {
        try {
          if (request.continuation.byteLength > attempt.limits.continuationMaxBytes) throw new Error("oversized");
          const parsed = continuationSchema.safeParse(JSON.parse(Buffer.from(request.continuation).toString("utf8")));
          if (parsed.success && parsed.data.model === request.model) resume = parsed.data;
        } catch { /* A missing/corrupt payload starts fresh. */ }
        if (resume === null) attempt.diagnostics.continuation = "invalid_or_incompatible_fresh";
      }
      const options: ThreadOptions = { model: request.model, modelReasoningEffort: request.effort, workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never", networkAccessEnabled: false, webSearchMode: "disabled" };
      let thread = resume === null ? client.startThread(options) : client.resumeThread(resume.threadId, options);
      attempt.diagnostics.continuation ??= resume === null ? "fresh" : "resumed";
      attempt.diagnostics.nativeTools = "SDK lacks per-call authorization; capability tools use the guarded MCP bridge";
      const missingSession = (value: unknown) => /(?:session|thread|rollout).*(?:not found|missing|does not exist|unknown)|no (?:session|thread).*found/i.test(value instanceof Error ? value.message : String(value));
      for (let start = 0; start < 2; start++) {
        let terminal = false;
        let itemCount = 0;
        let freshFallback = false;
        const canFallback = (value: unknown) => start === 0 && resume !== null && itemCount === 0 && attempt.toolCalls === 0 && !attempt.ended && missingSession(value);
        const textByItem = new Map<string, string>();
        try {
          const turn = await thread.runStreamed(`${AGENT_INSTRUCTIONS}\n\n${request.input.text}`, { signal: attempt.signal });
          for await (const event of turn.events) {
            attempt.transcript.append(event);
            if (event.type === "thread.started" && this.supportsContinuation) attempt.continuation = Buffer.from(JSON.stringify({ version: 1, provider: "codex", model: request.model, threadId: event.thread_id }));
            if (event.type === "item.started" && ++itemCount > attempt.limits.maxTurns * 20) { attempt.fail("Provider item bound exhausted", "max_turns"); break; }
            if (event.type === "item.updated" || event.type === "item.completed") {
              if (event.item.type === "agent_message") {
                const before = textByItem.get(event.item.id) ?? "";
                const text = event.item.text;
                request.output({ attemptId: request.attemptId, kind: "text", text: text.startsWith(before) ? text.slice(before.length) : text });
                textByItem.set(event.item.id, text);
              }
            }
            if (event.type === "turn.completed") {
              const u = event.usage;
              attempt.recordUsage({ input: Math.max(0, u.input_tokens - u.cached_input_tokens - (u.cache_write_input_tokens ?? 0)), cached: u.cached_input_tokens, cacheWrite: u.cache_write_input_tokens ?? 0, output: u.output_tokens }, this.config.models?.find((m) => m.id === request.model));
              terminal = true;
            } else if (event.type === "turn.failed" || event.type === "error") {
              const message = event.type === "error" ? event.message : event.error.message;
              if (canFallback(message)) { freshFallback = true; break; }
              attempt.fail(message);
              terminal = true;
            }
          }
        } catch (error) { if (canFallback(error)) freshFallback = true; else throw error; }
        if (freshFallback) {
          attempt.diagnostics.continuation = "missing_native_session_fresh";
          attempt.continuation = null;
          thread = client.startThread(options);
          continue;
        }
        if (!terminal && !attempt.ended) attempt.fail("Codex stream ended without a terminal event", "process_exit");
        break;
      }
    } catch (error) { attempt.fail(error); }
    finally {
      await Promise.allSettled([bridge?.close(), closeMcp?.(), catalog?.close()]);
    }
    return attempt.finish();
  }
}
