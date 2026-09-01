/**
 * The production Claude provider adapter (execution-model §1 "Provider",
 * §6.4, §6.5, §6.6, §13): one bound Attempt in, one typed outcome out, on
 * the pinned `@anthropic-ai/claude-agent-sdk`.
 *
 * Ownership. The adapter drives exactly one provider execution for the
 * Attempt the runtime prepared: it renders nothing, decides nothing about
 * Runs, Invocations, retries, allocation, scheduling, Patterns, approvals,
 * Tasks, Requirements, Decisions, Events, Artifacts, or result validity, and
 * it keeps no state the runtime depends on. No provider session becomes an
 * orchestration record: the SDK session id is an opaque continuation
 * payload the runtime's continuation service stores and verifies, never a
 * diagnostic, an Event, or a manifest member.
 *
 * Authorization. Every provider-native capability call passes through the
 * runtime's authorization port before it executes, through the one SDK
 * path that fires for every tool call: a `PreToolUse` hook. The hook maps
 * the native tool to the console's capability name, submits the exact
 * proposed call, and answers `allow` only for `allowed` and
 * `approved_once`; everything else is denied, and an `approval_required`
 * answer ends the turn with the typed completion carrying the same call.
 * The SDK's own permission path is configured so that it can never
 * substitute for that boundary: `permissionMode: "default"` (never a
 * bypass mode), an empty `allowedTools` list (nothing pre-approved), an
 * explicit `tools` list of exactly the exposed native tools, every other
 * classified native tool in `disallowedTools`, and a `canUseTool` callback
 * that denies whatever reaches the permission prompt (the hook decides
 * first; a call arriving at the prompt was not authorized). Runtime tools
 * are exposed as an in-process MCP server whose handlers call the runtime
 * tool port and nothing else; they are the port's business, not the
 * authorization port's.
 *
 * Isolation. `settingSources: []` loads no user, project, or local
 * settings (no ambient hooks, permission rules, instructions, plugins, or
 * agent files), `strictMcpConfig` admits no ambient MCP server, the system
 * prompt is a fixed adapter string (no preset, no `CLAUDE.md`, no memory),
 * no subagents, skills, or plugins are configured, and the subprocess
 * environment is the filtered one of `env.ts`.
 *
 * Accounting. Usage is read from the final result's per-model
 * `modelUsage` (cost and tokens per model, one chunk each); the cumulative
 * per-call assistant usage is used only when no result message arrived
 * (an interrupted or dead subprocess), deduplicated by message id and with
 * cost unknown. The transcript is a bounded, redacted JSONL of the message
 * stream. Failures classify through the closed `failure-classifier`.
 */
import { boundedFailureMessage, runtimeToolResultBlocksInvocation, type DecisionId, type ExecutableRuntimeTool, type JsonValue, type ModelEffort, type ProposedToolCall, type RuntimeToolCallOutcome, type RuntimeToolCallRequest } from "@agentique-console/core";
import os from "node:os";
import type { CanUseTool, HookCallback, HookInput, McpServerConfig, McpSdkServerConfigWithInstance, Options, SDKAssistantMessage, SDKMessage, SDKResultMessage, SDKUserMessage, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { AttemptExecutionOutcome, AttemptExecutionRequest, InterruptionCause, ProviderAdapter, ProviderCompletion, UsageChunk } from "./adapter.ts";
import type { ClaudeSdk, ClaudeSdkTool } from "./claude-sdk.ts";
import { providerEnvironment } from "./env.ts";
import { classifyProviderFailure, sanitizeFailureMessage, type ProviderFailureKind } from "./failure-classifier.ts";
import { capabilityToolOf, disallowedNativeTools, isMcpToolName, mcpServerOf, nativeExposureOf } from "./native-tools.ts";
import { RETURN_RESULT_SHAPE, RUNTIME_TOOL_INPUT_SHAPES } from "./runtime-tool-shapes.ts";

export const CLAUDE_PROVIDER = "claude";

/** The in-process MCP server that carries the runtime tools; the SDK presents its tools as `mcp__agentique__<tool>`. */
export const RUNTIME_TOOL_SERVER = "agentique";
export const RETURN_RESULT_TOOL = "return_result";

export function runtimeToolNativeName(tool: string): string {
  return `mcp__${RUNTIME_TOOL_SERVER}__${tool}`;
}

export interface ClaudeAdapterLimits {
  /** The SDK's bound on agentic turns per Attempt; exhausting it is a permanent provider failure of the Attempt. */
  maxTurns: number;
  /** The bound on the diagnostic transcript bytes; a longer stream is stored as a prefix with a truncation marker. */
  transcriptMaxBytes: number;
  /** The bound on one runtime-tool response echoed to the model. */
  toolResultMaxBytes: number;
  /** The bound on the subprocess stderr tail kept for diagnostics. */
  stderrTailBytes: number;
}

export const DEFAULT_CLAUDE_ADAPTER_LIMITS: Readonly<ClaudeAdapterLimits> = Object.freeze({ maxTurns: 200, transcriptMaxBytes: 1_048_576, toolResultMaxBytes: 131_072, stderrTailBytes: 2_048 });

export interface ClaudeAdapterConfig {
  sdk: ClaudeSdk;
  /** The source environment the subprocess environment is filtered from (`process.env` by default). */
  environment?: NodeJS.ProcessEnv;
  /** Native continuation through the SDK's session resumption; `true` by default. */
  continuation?: boolean;
  limits?: Partial<ClaudeAdapterLimits>;
  /** The approved MCP server catalog; an Attempt receives exactly the catalog servers its effective capability set declares. */
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
  pathToClaudeCodeExecutable?: string;
  /** The working directory of an Attempt whose Run has no Workspace path (`os.tmpdir()` by default). */
  fallbackWorkingDirectory?: string;
}

/** The fixed adapter system prompt: protocol only; every instruction about the work is in the rendered Context Manifest. */
export const ATTEMPT_SYSTEM_PROMPT = [
  "You are executing exactly one Attempt of one Invocation for Agentique Console.",
  "The user message is the complete Context Manifest of the Invocation: instructions, inputs, Tasks, Requirements, Acceptance Criteria, Decisions, Handoffs, Artifact metadata, capabilities, Tool Policy, runtime tools, and approved calls. Nothing outside it is part of the Attempt.",
  "Rules:",
  "1. Work only inside the working directory. The runtime authorizes every tool call against the Tool Policy; a denied call is not available to you and a call that needs approval ends this Attempt so the operator can decide.",
  `2. Read and change console state only through the runtime tools (${runtimeToolNativeName("*")}): Requirements, Decisions, Tasks, Artifacts, the execution plan, Agent Definitions.`,
  `3. End the Attempt by calling ${runtimeToolNativeName(RETURN_RESULT_TOOL)} exactly once with the typed result the manifest requires, then stop without further tool calls.`,
  "4. When a runtime tool answers that the turn has ended (a requested Decision, an approval), stop immediately.",
  `5. Never ask the user a question; an operator question is a Decision requested through ${runtimeToolNativeName("request_decision")}.`,
].join("\n");

const RUNTIME_SERVER_INSTRUCTIONS = "The runtime tools of Agentique Console for this Attempt. Every call is validated and recorded by the runtime; results carry ids and closed codes.";

/** Model-facing descriptions of the runtime tools; every executable tool has one (a new tool without one does not compile). */
export const RUNTIME_TOOL_DESCRIPTIONS: Readonly<Record<ExecutableRuntimeTool, string>> = Object.freeze({
  read_requirements: "Read the Requirements visible to this Invocation (paged, canonical tree order).",
  read_decisions: "Read the Decisions visible to this Invocation (paged).",
  read_tasks: "Read the Tasks visible to this Invocation (paged).",
  read_artifact: "Read the metadata and a bounded content range of one Artifact named in the manifest.",
  read_execution_plan: "Read the current execution plan of the Run (nodes, edges, shapes).",
  read_agent_definitions: "Read the Agent Definition revisions available to plan with.",
  write_artifact: "Create one bounded Artifact from content you supply; the runtime derives its id, digest, and size.",
  propose_tasks: "Propose a batch of Worker Tasks for this coordinator node (Coordinator decompose or replan turns).",
  update_task: "Update one Task you are permitted to update; the runtime applies the transition.",
  request_completion: "Request Run completion (root Orchestrator only); the runtime opens the completion Gate after this turn.",
  request_decision: "Request a Decision (an operator choice or a Requirement waiver); a blocking request ends this turn.",
  create_tasks: "Create Run-level Tasks for the source Execution Plan to bind (root Orchestrator only); the runtime pins Requirement scope and identity.",
  record_decision: "Record a choice you made yourself, with the options you considered and your rationale, as a resolved orchestrator_choice Decision.",
  propose_requirements: "Propose a complete Requirement tree with rationale for the operator to approve, edit, or reject; nothing changes until the operator resolves it.",
  revise_execution_plan: "Submit a complete source Execution Plan; the runtime compiles it and records the accepted revision or the typed rejection.",
});

const RETURN_RESULT_DESCRIPTION = "Return the typed result of this Attempt exactly once, then stop.";

const CONTINUATION_PAYLOAD_VERSION = 1;
const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;

type Stop =
  | { kind: "result_returned" }
  | { kind: "decision_requested"; decisionId: DecisionId }
  | { kind: "approval_required"; call: ProposedToolCall }
  | { kind: "tool_failure"; tool: string; message: string };

interface UsageSnapshot {
  model: string;
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

/** Bounded UTF-8 line buffer: a stream longer than the bound is kept as a prefix plus one marker line. */
class BoundedLines {
  readonly #encoder = new TextEncoder();
  readonly #chunks: Uint8Array[] = [];
  #size = 0;
  truncated = false;
  lines = 0;

  constructor(private readonly maxBytes: number) {}

  append(line: string): void {
    this.lines += 1;
    if (this.truncated) return;
    const bytes = this.#encoder.encode(`${line}\n`);
    if (this.#size + bytes.byteLength > this.maxBytes) {
      this.truncated = true;
      const marker = this.#encoder.encode(`{"truncated":true}\n`);
      if (this.#size + marker.byteLength <= this.maxBytes) {
        this.#chunks.push(marker);
        this.#size += marker.byteLength;
      }
      return;
    }
    this.#chunks.push(bytes);
    this.#size += bytes.byteLength;
  }

  bytes(): Uint8Array | null {
    if (this.#size === 0) return null;
    const out = new Uint8Array(this.#size);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

/** The last `maxBytes` of a text stream. */
class Tail {
  #text = "";

  constructor(private readonly maxBytes: number) {}

  append(data: string): void {
    this.#text = (this.#text + data).slice(-this.maxBytes);
  }

  get text(): string {
    return this.#text;
  }
}

/** The one user message of an Attempt, then an open stream until the adapter closes it (so the CLI stays attached until the result arrived). */
class PromptStream implements AsyncIterable<SDKUserMessage> {
  readonly #closed: Promise<void>;
  #close!: () => void;

  constructor(private readonly text: string) {
    this.#closed = new Promise<void>((resolve) => {
      this.#close = resolve;
    });
  }

  close(): void {
    this.#close();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void, void> {
    yield { type: "user", message: { role: "user", content: [{ type: "text", text: this.text }] }, parent_tool_use_id: null };
    await this.#closed;
  }
}

function causeOf(signal: AbortSignal): InterruptionCause {
  const reason = signal.reason as unknown;
  return reason === "cancelled" || reason === "operator_pause" || reason === "deadline" ? reason : "provider";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /\baborted?\b/i.test(error.message));
}

const REDACTED_KEYS = new Set(["session_id", "transcript_path", "env", "apiKey", "api_key", "authorization"]);

/** A message as JSON with the members that would identify a provider session or carry a secret redacted. */
function redactedJson(value: unknown): string {
  return JSON.stringify(value, (key, member: unknown) => (REDACTED_KEYS.has(key) ? "[redacted]" : member));
}

function jsonValueOf(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function finiteQuantity(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export class ClaudeAgentSdkAdapter implements ProviderAdapter {
  readonly provider = CLAUDE_PROVIDER;
  readonly supportsContinuation: boolean;
  readonly limits: Readonly<ClaudeAdapterLimits>;

  constructor(private readonly config: ClaudeAdapterConfig) {
    this.supportsContinuation = config.continuation ?? true;
    this.limits = Object.freeze({ ...DEFAULT_CLAUDE_ADAPTER_LIMITS, ...config.limits });
  }

  async execute(request: AttemptExecutionRequest): Promise<AttemptExecutionOutcome> {
    const resume = this.supportsContinuation ? this.resumeOf(request.continuation) : { sessionId: null, diagnostic: request.continuation === null ? null : "disabled" };
    const first = await new AttemptExecution(this, request, resume.sessionId, resume.diagnostic).run();
    // A continuation the CLI cannot resume (the session is gone) starts fresh once, before any model work happened; every other outcome stands.
    if (first.fallback === "fresh") return (await new AttemptExecution(this, request, null, "fallback_fresh").run()).outcome;
    return first.outcome;
  }

  /** The verified payload's session id for `resume`, or `null` (with the reason) for a fresh start. */
  private resumeOf(continuation: Uint8Array | null): { sessionId: string | null; diagnostic: string | null } {
    if (continuation === null) return { sessionId: null, diagnostic: null };
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(continuation)) as { v?: unknown; sessionId?: unknown };
      if (parsed.v === CONTINUATION_PAYLOAD_VERSION && typeof parsed.sessionId === "string" && SESSION_ID.test(parsed.sessionId)) return { sessionId: parsed.sessionId, diagnostic: "resumed" };
    } catch {
      // Not the adapter's payload: start fresh below.
    }
    return { sessionId: null, diagnostic: "invalid" };
  }

  /** The opaque continuation payload for an observed session: adapter-owned bytes, never a diagnostic. */
  continuationPayload(sessionId: string): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ v: CONTINUATION_PAYLOAD_VERSION, sessionId }));
  }

  get sdk(): ClaudeSdk {
    return this.config.sdk;
  }

  get settings(): ClaudeAdapterConfig {
    return this.config;
  }
}

/** One provider execution of one Attempt: the options, the hook and tool handlers, the message loop, and the typed outcome. */
class AttemptExecution {
  readonly #transcript: BoundedLines;
  readonly #stderr: Tail;
  readonly #assistantUsage = new Map<string, UsageSnapshot>();
  readonly #diagnostics: Record<string, string> = {};
  #stop: Stop | null = null;
  #candidate: unknown = null;
  #sessionId: string | null = null;
  #lastResult: SDKResultMessage | null = null;
  #lastAssistantError: string | null = null;
  #threw: string | null = null;
  #ended = false;
  #assistantMessages = 0;
  #apiRetries = 0;
  #sdkDenials = 0;
  #hookDenials = 0;
  #promptDenials = 0;
  #unavailableCalls = 0;
  #authorized = 0;
  #capacityRejected = false;

  constructor(
    private readonly adapter: ClaudeAgentSdkAdapter,
    private readonly request: AttemptExecutionRequest,
    private readonly resume: string | null,
    continuationDiagnostic: string | null,
  ) {
    this.#transcript = new BoundedLines(adapter.limits.transcriptMaxBytes);
    this.#stderr = new Tail(adapter.limits.stderrTailBytes);
    if (continuationDiagnostic !== null) this.#diagnostics.continuation = continuationDiagnostic;
  }

  async run(): Promise<{ outcome: AttemptExecutionOutcome; fallback: "fresh" | null }> {
    const { request } = this;
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    if (request.signal.aborted) {
      const cause = causeOf(request.signal);
      const endedAt = new Date().toISOString();
      return { outcome: { completion: { kind: "interrupted", cause, message: `not started: ${cause}` }, result: null, usage: [], transcript: null, continuation: null, timing: { startedAt, endedAt, providerMs: null }, diagnostics: { ...this.#diagnostics, started: "false" } }, fallback: null };
    }
    const controller = new AbortController();
    const onAbort = () => {
      if (!controller.signal.aborted) controller.abort(request.signal.reason);
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    const prompt = new PromptStream(request.input.text);
    const options = this.options(controller);
    let query: ReturnType<ClaudeSdk["query"]> | null = null;
    try {
      query = this.adapter.sdk.query({ prompt, options });
      for await (const message of query) {
        this.observe(message);
        if (message.type === "result") {
          this.#lastResult = message;
          prompt.close();
          break;
        }
      }
    } catch (error) {
      if (!(isAbortError(error) && request.signal.aborted)) this.#threw = sanitizeFailureMessage(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    } finally {
      prompt.close();
      request.signal.removeEventListener("abort", onAbort);
      if (query !== null) {
        try {
          await query.return(undefined);
        } catch {
          // The subprocess is gone either way.
        }
      }
    }
    const endedAt = new Date().toISOString();
    const elapsedMs = Math.max(0, Date.now() - startedMs);
    // A resumed session the CLI could not find, before any model work: the caller starts fresh once.
    if (this.resume !== null && this.#assistantMessages === 0 && this.#lastResult !== null && this.#lastResult.subtype !== "success" && /no conversation found|session.*not found|could not (find|resume)/i.test(this.#lastResult.errors.join(" "))) {
      return { outcome: this.outcome(startedAt, endedAt, elapsedMs), fallback: "fresh" };
    }
    return { outcome: this.outcome(startedAt, endedAt, elapsedMs), fallback: null };
  }

  // ---------------------------------------------------------------------------
  // Options
  // ---------------------------------------------------------------------------

  private options(controller: AbortController): Options {
    const { request, adapter } = this;
    const exposure = nativeExposureOf(request.capabilities.tools);
    if (exposure.unmapped.length > 0) this.#diagnostics.unmappedCapabilities = exposure.unmapped.join(",");
    const servers: Record<string, McpServerConfig> = { [RUNTIME_TOOL_SERVER]: this.runtimeToolServer() };
    const missing: string[] = [];
    for (const name of [...request.capabilities.mcpServers].sort()) {
      const config = adapter.settings.mcpServers?.[name];
      if (config === undefined || name === RUNTIME_TOOL_SERVER) {
        missing.push(name);
        continue;
      }
      servers[name] = config;
    }
    if (missing.length > 0) this.#diagnostics.unavailableMcpServers = missing.join(",");
    const cwd = request.workingDirectory ?? adapter.settings.fallbackWorkingDirectory ?? os.tmpdir();
    if (request.workingDirectory === null) this.#diagnostics.workingDirectory = "fallback";
    return {
      cwd,
      env: providerEnvironment(adapter.settings.environment),
      model: request.model,
      effort: request.effort satisfies ModelEffort,
      systemPrompt: ATTEMPT_SYSTEM_PROMPT,
      // Exactly the exposed native tools (MCP tools come from their servers); every other classified native tool denied by name;
      // nothing pre-approved; the default permission mode.
      tools: exposure.tools,
      allowedTools: [],
      disallowedTools: disallowedNativeTools(exposure.tools),
      permissionMode: "default",
      canUseTool: this.canUseTool,
      hooks: { PreToolUse: [{ hooks: [this.preToolUse] }] },
      // No ambient configuration of any kind.
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      mcpServers: servers,
      maxTurns: adapter.limits.maxTurns,
      persistSession: adapter.supportsContinuation,
      ...(this.resume === null ? {} : { resume: this.resume }),
      abortController: controller,
      includePartialMessages: false,
      stderr: (data) => this.#stderr.append(data),
      ...(adapter.settings.pathToClaudeCodeExecutable === undefined ? {} : { pathToClaudeCodeExecutable: adapter.settings.pathToClaudeCodeExecutable }),
    };
  }

  private runtimeToolServer(): McpSdkServerConfigWithInstance {
    const tools: ClaudeSdkTool[] = this.request.runtimeTools.tools.map((tool) => ({
      name: tool,
      description: RUNTIME_TOOL_DESCRIPTIONS[tool],
      inputSchema: RUNTIME_TOOL_INPUT_SHAPES[tool] as never,
      handler: (args: unknown) => this.runtimeToolCall(tool, args),
    }));
    tools.push({ name: RETURN_RESULT_TOOL, description: RETURN_RESULT_DESCRIPTION, inputSchema: RETURN_RESULT_SHAPE as never, handler: (args: unknown) => this.returnResult(args) });
    // Always loaded: a runtime tool is never deferred behind a search tool the Attempt does not have.
    return this.adapter.sdk.createSdkMcpServer({ name: RUNTIME_TOOL_SERVER, version: "1.0.0", instructions: RUNTIME_SERVER_INSTRUCTIONS, alwaysLoad: true, tools });
  }

  // ---------------------------------------------------------------------------
  // The authorization boundary: the PreToolUse hook and the fail-closed prompt
  // ---------------------------------------------------------------------------

  private readonly preToolUse: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const name = input.tool_name;
    if (this.#ended) return this.deny(`the Attempt has ended (${this.#stop?.kind ?? "result returned"}); make no further tool calls`, true);
    if (input.agent_id !== undefined) return this.deny("subagent execution is not available in an Attempt", true);
    if (isMcpToolName(name) && mcpServerOf(name) === RUNTIME_TOOL_SERVER) return this.allow("runtime tool");
    const capability = capabilityToolOf(name);
    if (capability === null) {
      this.#unavailableCalls += 1;
      return this.deny(`tool ${name} is not available in this Attempt`, false);
    }
    if (name === "Bash" && typeof input.tool_input === "object" && input.tool_input !== null && (input.tool_input as { run_in_background?: unknown }).run_in_background === true) {
      return this.deny("background shell execution is not available in an Attempt; run the command synchronously", false);
    }
    let authorization;
    try {
      authorization = this.request.authorization.authorize({ tool: capability, input: jsonValueOf(input.tool_input) });
    } catch (error) {
      this.#stop ??= { kind: "tool_failure", tool: capability, message: boundedFailureMessage(`authorization failed: ${error instanceof Error ? error.message : String(error)}`) };
      this.#ended = true;
      return this.deny("the runtime could not authorize the call; the Attempt ends", true);
    }
    switch (authorization.kind) {
      case "allowed":
      case "approved_once":
        this.#authorized += 1;
        return this.allow(authorization.kind === "allowed" ? "allowed by the Tool Policy" : "approved once by the operator");
      case "denied":
        return this.deny(`tool ${capability} is denied by the Tool Policy`, false);
      case "invalid":
        return this.deny(`the call is invalid: ${authorization.message}`, false);
      case "approval_required":
        this.#stop ??= { kind: "approval_required", call: { tool: capability, input: jsonValueOf(input.tool_input) } };
        this.#ended = true;
        return this.deny(`tool ${capability} requires the operator's approval for this exact call; the Attempt ends here so the operator can decide`, true);
      case "failed":
        this.#stop ??= { kind: "tool_failure", tool: capability, message: boundedFailureMessage(authorization.message) };
        this.#ended = true;
        return this.deny("the runtime could not record the authorization; the Attempt ends", true);
      case "interrupted":
        this.#ended = true;
        return this.deny(`the Run no longer admits execution (${authorization.cause})`, true);
    }
  };

  /** Nothing is authorized at the permission prompt: the hook decides, so a call arriving here was not authorized. */
  private readonly canUseTool: CanUseTool = async (toolName) => {
    this.#promptDenials += 1;
    return { behavior: "deny", message: `tool ${toolName} was not authorized by the runtime`, interrupt: false };
  };

  private allow(reason: string): SyncHookJSONOutput {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: reason } };
  }

  private deny(reason: string, stop: boolean): SyncHookJSONOutput {
    this.#hookDenials += 1;
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }, ...(stop ? { continue: false, stopReason: reason } : {}) };
  }

  // ---------------------------------------------------------------------------
  // Runtime tools
  // ---------------------------------------------------------------------------

  private async runtimeToolCall(tool: ExecutableRuntimeTool, args: unknown): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
    if (this.#ended) return this.toolText(`the Attempt has ended (${this.#stop?.kind ?? "result returned"}); make no further calls`, true);
    let outcome: RuntimeToolCallOutcome;
    try {
      outcome = await this.request.runtimeTools.call({ tool, input: args } as RuntimeToolCallRequest);
    } catch (error) {
      this.#stop ??= { kind: "tool_failure", tool, message: boundedFailureMessage(`runtime tool ${tool} failed: ${error instanceof Error ? error.message : String(error)}`) };
      this.#ended = true;
      return this.toolText(`the runtime tool ${tool} could not execute; the Attempt ends`, true);
    }
    this.request.output({ attemptId: this.request.attemptId, kind: "tool_call", text: `${tool} ${outcome.kind}` });
    if (outcome.kind === "accepted" && runtimeToolResultBlocksInvocation(outcome.result) && outcome.result.tool === "request_decision") {
      // The stop boundary of the adapter contract: the committed blocking request ends the logical turn here.
      this.#stop ??= { kind: "decision_requested", decisionId: outcome.result.decisionId };
      this.#ended = true;
    }
    const text = JSON.stringify(outcome);
    if (new TextEncoder().encode(text).byteLength > this.adapter.limits.toolResultMaxBytes) return this.toolText(JSON.stringify({ kind: outcome.kind, tool, error: "the response exceeds the adapter's size bound" }), true);
    return this.toolText(text, outcome.kind === "rejected" || outcome.kind === "failed" || outcome.kind === "not_callable");
  }

  private async returnResult(args: unknown): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
    if (this.#ended) return this.toolText(`the Attempt has ended (${this.#stop?.kind ?? "result returned"}); the result was not recorded`, true);
    this.#candidate = args;
    this.#stop ??= { kind: "result_returned" };
    this.#ended = true;
    this.request.output({ attemptId: this.request.attemptId, kind: "tool_call", text: `${RETURN_RESULT_TOOL} recorded` });
    return this.toolText("Result recorded. End your turn now without further tool calls.", false);
  }

  private toolText(text: string, isError: boolean): { content: { type: "text"; text: string }[]; isError?: boolean } {
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  }

  // ---------------------------------------------------------------------------
  // The message stream
  // ---------------------------------------------------------------------------

  private observe(message: SDKMessage): void {
    this.#transcript.append(redactedJson(message));
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          this.#sessionId = message.session_id;
          this.#diagnostics.permissionMode = message.permissionMode;
          this.#diagnostics.apiKeySource = message.apiKeySource;
          this.#diagnostics.sdkModel = message.model;
          this.#diagnostics.sdkTools = String(message.tools.length);
          this.#diagnostics.mcpServers = message.mcp_servers.map((s) => `${s.name}:${s.status}`).join(",");
        } else if (message.subtype === "api_retry") {
          this.#apiRetries += 1;
          this.#diagnostics.lastApiRetryStatus = String(message.error_status ?? "");
        } else if (message.subtype === "permission_denied") {
          this.#sdkDenials += 1;
        }
        return;
      case "assistant":
        this.observeAssistant(message);
        return;
      case "rate_limit_event":
        if (message.rate_limit_info.status === "rejected") this.#capacityRejected = true;
        return;
      default:
        return;
    }
  }

  private observeAssistant(message: SDKAssistantMessage): void {
    this.#assistantMessages += 1;
    if (message.error !== undefined) this.#lastAssistantError = message.error;
    const api = message.message;
    if (api.usage !== undefined && api.usage !== null) {
      // Several messages may share one API message id; the latest snapshot for an id counts once.
      this.#assistantUsage.set(api.id, { model: api.model, input: finiteCount(api.usage.input_tokens), cacheCreation: finiteCount(api.usage.cache_creation_input_tokens), cacheRead: finiteCount(api.usage.cache_read_input_tokens), output: finiteCount(api.usage.output_tokens) });
    }
    for (const block of api.content ?? []) {
      if (block.type === "text" && block.text.length > 0) this.request.output({ attemptId: this.request.attemptId, kind: "text", text: block.text });
      else if (block.type === "tool_use") this.request.output({ attemptId: this.request.attemptId, kind: "tool_call", text: block.name });
    }
  }

  // ---------------------------------------------------------------------------
  // The typed outcome
  // ---------------------------------------------------------------------------

  private outcome(startedAt: string, endedAt: string, elapsedMs: number): AttemptExecutionOutcome {
    const completion = this.completion();
    const usage = this.usage(elapsedMs);
    const diagnostics: Record<string, string> = {
      ...this.#diagnostics,
      assistantMessages: String(this.#assistantMessages),
      apiRetries: String(this.#apiRetries),
      authorizedCalls: String(this.#authorized),
      hookDenials: String(this.#hookDenials),
      sdkDenials: String(this.#sdkDenials),
      promptDenials: String(this.#promptDenials),
      unavailableCalls: String(this.#unavailableCalls),
      transcriptLines: String(this.#transcript.lines),
      transcriptTruncated: String(this.#transcript.truncated),
      ...(this.#lastResult === null ? { resultMessage: "none" } : { resultMessage: this.#lastResult.subtype, terminalReason: this.#lastResult.terminal_reason ?? "", numTurns: String(this.#lastResult.num_turns), totalCostUsd: String(this.#lastResult.total_cost_usd) }),
      ...(this.#stderr.text === "" ? {} : { stderrTail: sanitizeFailureMessage(this.#stderr.text) }),
      ...(this.#threw === null ? {} : { sdkError: this.#threw }),
    };
    return {
      completion,
      result: completion.kind === "completed" ? this.#candidate : null,
      usage,
      transcript: this.#transcript.bytes(),
      continuation: this.adapter.supportsContinuation && this.#sessionId !== null ? this.adapter.continuationPayload(this.#sessionId) : null,
      timing: { startedAt, endedAt, providerMs: this.#lastResult?.duration_api_ms ?? null },
      diagnostics,
    };
  }

  private completion(): ProviderCompletion {
    const stop = this.#stop;
    if (stop?.kind === "decision_requested") return { kind: "decision_requested", decisionId: stop.decisionId };
    if (stop?.kind === "approval_required") return { kind: "approval_required", call: stop.call };
    if (stop?.kind === "tool_failure") return { kind: "tool_failure", tool: stop.tool, message: stop.message };
    if (this.request.signal.aborted) {
      const cause = causeOf(this.request.signal);
      return { kind: "interrupted", cause, message: `aborted: ${cause}` };
    }
    // A returned result stands whatever the stream did afterwards; the runtime validates it.
    if (stop?.kind === "result_returned") return { kind: "completed" };
    const result = this.#lastResult;
    if (result === null) {
      if (this.#threw !== null) return { kind: "provider_error", transient: true, message: this.#threw };
      return { kind: "provider_error", transient: true, message: sanitizeFailureMessage("process_exit: the provider subprocess ended without a result") };
    }
    if (result.subtype === "success" && !result.is_error) return { kind: "completed" };
    if (result.subtype === "success") {
      // A CLI-level failure reported as a successful result with `is_error`: classify the prose.
      const classified = classifyProviderFailure({ error: this.#lastAssistantError, text: result.result, kind: this.#capacityRejected ? "capacity" : undefined });
      return { kind: "provider_error", transient: classified.transient, message: classified.message };
    }
    if (result.terminal_reason === "aborted_streaming" || result.terminal_reason === "aborted_tools") {
      return { kind: "interrupted", cause: "provider", message: sanitizeFailureMessage(`provider stream ended: ${result.terminal_reason}`) };
    }
    const kind: ProviderFailureKind | undefined = result.subtype === "error_max_turns" ? "max_turns" : this.#capacityRejected ? "capacity" : undefined;
    const classified = classifyProviderFailure({ error: this.#lastAssistantError, text: result.errors.join("; "), kind });
    return { kind: "provider_error", transient: classified.transient, message: classified.message };
  }

  /** Per-model chunks from the result's `modelUsage`; the result's main-loop `usage` when no per-model figures exist; the deduplicated assistant snapshots when no result arrived (cost unknown). */
  private usage(elapsedMs: number): UsageChunk[] {
    const { effort, model } = this.request;
    const result = this.#lastResult;
    if (result !== null) {
      const models = Object.entries(result.modelUsage ?? {}).filter(([, u]) => u !== null && typeof u === "object");
      if (models.length > 0) {
        return models.map(([name, u], index) => ({
          model: name,
          effort,
          inputTokensUncached: finiteCount(u.inputTokens),
          cacheCreationTokens: finiteCount(u.cacheCreationInputTokens),
          cacheReadTokens: finiteCount(u.cacheReadInputTokens),
          outputTokens: finiteCount(u.outputTokens),
          costUsd: finiteQuantity(u.costUSD),
          wallClockMs: index === 0 ? finiteCount(result.duration_ms) : 0,
          providerMs: index === 0 ? finiteCount(result.duration_api_ms) : null,
        }));
      }
      const u = result.usage;
      if (u !== undefined && u !== null) {
        return [{ model, effort, inputTokensUncached: finiteCount(u.input_tokens), cacheCreationTokens: finiteCount(u.cache_creation_input_tokens), cacheReadTokens: finiteCount(u.cache_read_input_tokens), outputTokens: finiteCount(u.output_tokens), costUsd: finiteQuantity(result.total_cost_usd), wallClockMs: finiteCount(result.duration_ms), providerMs: finiteCount(result.duration_api_ms) }];
      }
    }
    if (this.#assistantUsage.size === 0) return [];
    const byModel = new Map<string, UsageSnapshot>();
    for (const snapshot of this.#assistantUsage.values()) {
      const total = byModel.get(snapshot.model) ?? { model: snapshot.model, input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };
      byModel.set(snapshot.model, { model: snapshot.model, input: total.input + snapshot.input, cacheCreation: total.cacheCreation + snapshot.cacheCreation, cacheRead: total.cacheRead + snapshot.cacheRead, output: total.output + snapshot.output });
    }
    this.#diagnostics.costUnknown = "true";
    return [...byModel.values()].map((total, index) => ({ model: total.model, effort, inputTokensUncached: total.input, cacheCreationTokens: total.cacheCreation, cacheReadTokens: total.cacheRead, outputTokens: total.output, costUsd: 0, wallClockMs: index === 0 ? elapsedMs : 0, providerMs: null }));
  }
}
