/**
 * The Claude adapter through the scripted SDK surface (execution-model §6.4,
 * §6.5, §6.6, §13; migration-contract §8): the SDK options that make the
 * runtime's authorization boundary the only one, the hook that carries every
 * native call to it, the runtime tools as an in-process MCP server, the
 * stop boundaries (a returned result, a blocking Decision, an approval), the
 * interruption and failure classification, the Usage accounting from the
 * final result without double counting, the bounded redacted transcript,
 * and the opaque continuation payload. The fake replays the CLI's own
 * tool path, so a test that shows the hook deciding a call shows the SDK's
 * defaults could not have.
 */
import { canonicalJson, type DecisionId, type ExecutableRuntimeTool, type ProposedToolCall, type RuntimeToolCallOutcome, type RuntimeToolCallRequest, type ToolPolicy } from "@agentique-console/core";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AttemptExecutionRequest, ToolCallAuthorization, TransientOutput } from "./adapter.ts";
import { ATTEMPT_SYSTEM_PROMPT, ClaudeAgentSdkAdapter, RETURN_RESULT_TOOL, RUNTIME_TOOL_SERVER, runtimeToolNativeName } from "./claude-adapter.ts";
import { FakeClaudeSdk, type FakeSdkStep, type FakeSdkTurn } from "./claude-sdk-test-support.ts";
import { ALWAYS_DENIED_NATIVE_TOOLS, CAPABILITY_TOOL_SURFACE } from "./native-tools.ts";

const DECISION_ID = "dec_000000000000000000000001" as DecisionId;
const DIGEST = "0".repeat(64);
const RESULT = { status: "completed", artifactIds: [], tasks: [], evidence: [], summary: "done", openItems: [], blocker: null, runOutcome: null, routeSelection: null, evaluation: null, finalReport: null };

type Authorizer = (call: ProposedToolCall) => ToolCallAuthorization;

/** A port scripted by outcome per tool; records every call. */
class FakeRuntimeToolPort {
  readonly calls: RuntimeToolCallRequest[] = [];
  constructor(
    readonly tools: readonly ExecutableRuntimeTool[],
    private readonly answer: (request: RuntimeToolCallRequest) => RuntimeToolCallOutcome | Promise<RuntimeToolCallOutcome> = defaultAnswer,
  ) {}
  async call(request: RuntimeToolCallRequest): Promise<RuntimeToolCallOutcome> {
    this.calls.push(request);
    return this.answer(request);
  }
}

function defaultAnswer(request: RuntimeToolCallRequest): RuntimeToolCallOutcome {
  if (request.tool === "read_tasks") return { kind: "read", tool: "read_tasks", result: { tool: "read_tasks", items: [], oversizedRecord: null, next: null } };
  if (request.tool === "request_decision") return { kind: "accepted", tool: "request_decision", callId: "rtc_000000000000000000000001" as never, callDigest: DIGEST, replayed: false, result: { tool: "request_decision", decisionId: DECISION_ID, status: "open", blocksInvocation: true } };
  if (request.tool === "write_artifact") return { kind: "accepted", tool: "write_artifact", callId: "rtc_000000000000000000000002" as never, callDigest: DIGEST, replayed: false, result: { tool: "write_artifact", artifactId: "art_000000000000000000000001" as never, mediaType: "text/plain", digest: DIGEST, byteSize: 5, title: "note" } };
  return { kind: "not_callable", tool: request.tool };
}

const allowAll: Authorizer = (call) => ({ kind: "allowed", tool: call.tool });

interface Built {
  request: AttemptExecutionRequest;
  authorizations: ProposedToolCall[];
  outputs: TransientOutput[];
  port: FakeRuntimeToolPort;
  controller: AbortController;
}

function build(overrides: { tools?: string[]; mcpServers?: string[]; policy?: ToolPolicy; runtimeTools?: ExecutableRuntimeTool[]; authorize?: Authorizer; port?: FakeRuntimeToolPort; continuation?: Uint8Array | null; workingDirectory?: string | null; effort?: "low" | "medium" | "high" | "max" } = {}): Built {
  const tools = overrides.tools ?? ["read", "search", "write", "shell"];
  const policy: ToolPolicy = overrides.policy ?? Object.fromEntries(tools.map((tool) => [tool, "allowed"]));
  const authorize = overrides.authorize ?? allowAll;
  const authorizations: ProposedToolCall[] = [];
  const outputs: TransientOutput[] = [];
  const port = overrides.port ?? new FakeRuntimeToolPort(overrides.runtimeTools ?? ["read_tasks", "request_decision", "write_artifact"]);
  const controller = new AbortController();
  const text = "# Context Manifest\nDo the work.";
  const request: AttemptExecutionRequest = {
    attemptId: "att_000000000000000000000001" as never,
    invocationId: "inv_000000000000000000000001" as never,
    runId: "run_000000000000000000000001" as never,
    model: "claude-fable-5",
    effort: overrides.effort ?? "medium",
    input: { rendererVersion: 1, text, digest: createHash("sha256").update(text).digest("hex") },
    capabilities: { tools, mcpServers: overrides.mcpServers ?? [] },
    toolPolicy: policy,
    authorization: {
      authorize(call) {
        authorizations.push(call);
        return authorize(call);
      },
    },
    runtimeTools: port,
    workingDirectory: overrides.workingDirectory === undefined ? "C:\\work\\wt" : overrides.workingDirectory,
    deadlineAt: null,
    signal: controller.signal,
    continuation: overrides.continuation ?? null,
    output: (o) => outputs.push(o),
  };
  return { request, authorizations, outputs, port, controller };
}

const returnResult = (result: unknown = RESULT): FakeSdkStep => ({ kind: "tool_use", name: runtimeToolNativeName(RETURN_RESULT_TOOL), input: result as Record<string, unknown> });
const bash = (command: string, extra: Record<string, unknown> = {}): FakeSdkStep => ({ kind: "tool_use", name: "Bash", input: { command, ...extra }, result: "ok" });
const read = (file_path: string): FakeSdkStep => ({ kind: "tool_use", name: "Read", input: { file_path }, result: "contents" });
const turn = (steps: FakeSdkStep[], result?: FakeSdkTurn["result"]): FakeSdkTurn => (result === undefined ? { steps } : { steps, result });

function adapterWith(sdk: FakeClaudeSdk, config: Partial<ConstructorParameters<typeof ClaudeAgentSdkAdapter>[0]> = {}) {
  return new ClaudeAgentSdkAdapter({ sdk, environment: { PATH: "/bin", HOME: "/home/u", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "host", ANTHROPIC_API_KEY: "sk-ant-secret-key-value-000000000000" }, ...config });
}

describe("ClaudeAgentSdkAdapter: SDK configuration", () => {
  it("hands the SDK exactly the exposed native tools, denies every other classified tool by name, pre-approves nothing, keeps the default permission mode, loads no ambient settings, and binds one PreToolUse hook and a fail-closed prompt", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([returnResult()]));
    const adapter = adapterWith(sdk);
    const { request } = build({ tools: ["read", "search", "shell"] });
    const outcome = await adapter.execute(request);
    expect(outcome.completion).toEqual({ kind: "completed" });
    const options = sdk.captured.options[0]!;
    expect(options.tools).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(options.allowedTools).toEqual([]);
    expect(options.disallowedTools).toEqual([...CAPABILITY_TOOL_SURFACE.filter((t) => !["Read", "Glob", "Grep", "Bash"].includes(t)), ...ALWAYS_DENIED_NATIVE_TOOLS]);
    for (const denied of ["Agent", "Task", "SendMessage", "Workflow", "TaskCreate", "TodoWrite", "ScheduleWakeup", "CronCreate", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "Monitor", "Skill", "ToolSearch", "Edit", "Write", "WebFetch"]) expect(options.disallowedTools, denied).toContain(denied);
    expect(options.permissionMode).toBe("default");
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.skills).toEqual([]);
    expect(options.agents).toBeUndefined();
    expect(options.plugins).toBeUndefined();
    expect(options.systemPrompt).toBe(ATTEMPT_SYSTEM_PROMPT);
    expect(typeof options.systemPrompt).toBe("string");
    expect(options.includePartialMessages).toBe(false);
    expect(options.maxTurns).toBe(adapter.limits.maxTurns);
    expect(options.cwd).toBe("C:\\work\\wt");
    expect(options.model).toBe("claude-fable-5");
    expect(options.effort).toBe("medium");
    expect(options.hooks?.PreToolUse).toHaveLength(1);
    expect(options.hooks?.PreToolUse?.[0]?.matcher).toBeUndefined();
    expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(Object.keys(options.hooks ?? {})).toEqual(["PreToolUse"]);
    expect(typeof options.canUseTool).toBe("function");
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(Object.keys(options.mcpServers ?? {})).toEqual([RUNTIME_TOOL_SERVER]);
    // The subprocess environment is the filtered one: host coupling stripped, credentials passed through by key, fixed variables set.
    expect(options.env?.CLAUDECODE).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(options.env?.ANTHROPIC_API_KEY).toBe("sk-ant-secret-key-value-000000000000");
    expect(options.env?.PATH).toBe("/bin");
    expect(options.env?.DISABLE_AUTOUPDATER).toBe("1");
    expect(options.env?.CLAUDE_CODE_MAX_RETRIES).toBe("3");
    // Exactly one user message: the rendered manifest bytes; the stream was then closed and the query returned.
    expect(sdk.captured.prompts).toEqual([request.input.text]);
    expect(sdk.captured.returned).toBeGreaterThanOrEqual(1);
    expect(sdk.remainingTurns).toBe(0);
  });

  it("exposes exactly the port's runtime tools plus return_result as the in-process MCP server, with model-facing raw shapes and the server-level always-load flag", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([returnResult()]));
    const { request } = build({ runtimeTools: ["read_tasks", "write_artifact"] });
    await adapterWith(sdk).execute(request);
    const tools = sdk.captured.servers[RUNTIME_TOOL_SERVER]!;
    expect(tools.map((t) => t.name)).toEqual(["read_tasks", "write_artifact", RETURN_RESULT_TOOL]);
    for (const tool of tools) {
      const shape = tool.inputSchema as unknown as Record<string, { safeParse?: unknown }>;
      expect(typeof shape.safeParse, `${tool.name} is a raw shape, not a schema`).toBe("undefined");
      for (const [field, member] of Object.entries(shape)) expect(typeof member.safeParse, `${tool.name}.${field}`).toBe("function");
      expect(tool._meta).toBeUndefined();
      expect(tool.description.length).toBeGreaterThan(10);
    }
    expect(sdk.captured.serverOptions[RUNTIME_TOOL_SERVER]?.alwaysLoad).toBe(true);
    const options = sdk.captured.options[0]!;
    expect(options.mcpServers?.[RUNTIME_TOOL_SERVER]).toMatchObject({ type: "sdk", name: RUNTIME_TOOL_SERVER });
  });

  it("passes only the declared, catalogued MCP servers and records the rest as diagnostics; the runtime server name is never a catalog entry", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([returnResult()]));
    const adapter = adapterWith(sdk, { mcpServers: { docs: { type: "stdio", command: "docs-server" }, other: { type: "http", url: "https://example.invalid" }, [RUNTIME_TOOL_SERVER]: { type: "stdio", command: "impostor" } } });
    const { request } = build({ mcpServers: ["docs", "missing", RUNTIME_TOOL_SERVER] });
    const outcome = await adapter.execute(request);
    const servers = sdk.captured.options[0]!.mcpServers!;
    expect(Object.keys(servers).sort()).toEqual([RUNTIME_TOOL_SERVER, "docs"]);
    expect(servers[RUNTIME_TOOL_SERVER]).toMatchObject({ type: "sdk" });
    expect(outcome.diagnostics.unavailableMcpServers).toBe(`${RUNTIME_TOOL_SERVER},missing`);
  });

  it("uses a fallback working directory for a Run without a Workspace path and records it", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([returnResult()]));
    const { request } = build({ workingDirectory: null });
    const outcome = await adapterWith(sdk, { fallbackWorkingDirectory: "D:\\scratch" }).execute(request);
    expect(sdk.captured.options[0]!.cwd).toBe("D:\\scratch");
    expect(outcome.diagnostics.workingDirectory).toBe("fallback");
  });
});

describe("ClaudeAgentSdkAdapter: the authorization boundary", () => {
  it("submits every native call to the runtime's port through the hook — the SDK's read-only auto-allow never decides a Read, and an allowed call executes exactly once", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([read("src/a.ts"), bash("npm test"), returnResult()]));
    const { request, authorizations } = build();
    const outcome = await adapterWith(sdk).execute(request);
    expect(outcome.completion).toEqual({ kind: "completed" });
    expect(outcome.result).toEqual(RESULT);
    expect(authorizations).toEqual([
      { tool: "read", input: { file_path: "src/a.ts" } },
      { tool: "shell", input: { command: "npm test" } },
    ]);
    expect(sdk.captured.executed).toEqual([
      { tool: "Read", input: { file_path: "src/a.ts" } },
      { tool: "Bash", input: { command: "npm test" } },
    ]);
    // The hook decided both; the permission prompt saw nothing.
    expect(sdk.captured.hookCalls.map((c) => c.tool)).toEqual(["Read", "Bash", runtimeToolNativeName(RETURN_RESULT_TOOL)]);
    expect(sdk.captured.promptCalls).toEqual([]);
    expect(sdk.captured.denied).toEqual([]);
    expect(outcome.diagnostics.authorizedCalls).toBe("2");
  });

  it("denies a Read the Tool Policy denies even though the CLI would auto-allow a read-only tool, and denies a Bash the policy denies even though a permission rule would have pre-approved it", async () => {
    // Read is exposed (the definition declares `read`) but the port denies it: the hook's deny is what the CLI applies.
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([read("secret.txt"), bash("rm -rf /"), returnResult()]));
    const { request, authorizations } = build({ authorize: (call) => ({ kind: "denied", tool: call.tool }) });
    const outcome = await adapterWith(sdk).execute(request);
    expect(authorizations.map((a) => a.tool)).toEqual(["read", "shell"]);
    expect(sdk.captured.executed).toEqual([]);
    expect(sdk.captured.denied).toEqual(["Read", "Bash"]);
    expect(sdk.captured.promptCalls).toEqual([]);
    // Denied calls end nothing: the model went on to return its result.
    expect(outcome.completion).toEqual({ kind: "completed" });
    expect(outcome.diagnostics.hookDenials).toBe("2");
    expect(outcome.diagnostics.sdkDenials).toBe("2");
  });

  it("proves the SDK's own permission paths are inert: the CLI's read-only auto-allow and an allowedTools rule are modelled by the fake, and neither fires because the hook always decides first", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([read("a"), bash("ls"), returnResult()]));
    const { request } = build();
    await adapterWith(sdk).execute(request);
    // Without the adapter's hook, the fake's pipeline would auto-allow Read and prompt for Bash; with it, every decision is the hook's.
    const decisions = sdk.captured.hookCalls.filter((c) => c.tool === "Read" || c.tool === "Bash").map((c) => ("hookSpecificOutput" in c.output && c.output.hookSpecificOutput?.hookEventName === "PreToolUse" ? c.output.hookSpecificOutput.permissionDecision : undefined));
    expect(decisions).toEqual(["allow", "allow"]);
    expect(sdk.captured.promptCalls).toEqual([]);
    // The prompt itself is fail-closed: whatever reaches it is denied.
    const answer = await sdk.captured.options[0]!.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "toolu_x", requestId: "req_x" });
    expect(answer).toEqual({ behavior: "deny", message: "tool Bash was not authorized by the runtime", interrupt: false });
  });

  it("never exposes a tool the capability set does not grant: an unexposed native tool is unknown to the SDK and a denied-surface tool is unknown too, without any port call", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([{ kind: "tool_use", name: "WebFetch", input: { url: "https://example.invalid" }, result: "page" }, { kind: "tool_use", name: "Agent", input: { prompt: "do it" }, result: "spawned" }, { kind: "tool_use", name: "Edit", input: { file_path: "a", old_string: "x", new_string: "y" }, result: "edited" }, returnResult()]));
    const { request, authorizations } = build({ tools: ["read", "shell"] });
    const outcome = await adapterWith(sdk).execute(request);
    expect(sdk.captured.unknownTools).toEqual(["WebFetch", "Agent", "Edit"]);
    expect(sdk.captured.executed).toEqual([]);
    expect(authorizations).toEqual([]);
    expect(outcome.completion).toEqual({ kind: "completed" });
  });

  it("denies a native tool no capability maps to and a background shell request before any authorization, and lets the model continue", async () => {
    const sdk = new FakeClaudeSdk();
    // The fake makes NotebookEdit available although no capability maps it (a hypothetical SDK default): the hook still denies it.
    sdk.script(turn([bash("sleep 100", { run_in_background: true }), bash("echo hi"), returnResult()]));
    const { request, authorizations } = build();
    const outcome = await adapterWith(sdk).execute(request);
    expect(authorizations).toEqual([{ tool: "shell", input: { command: "echo hi" } }]);
    expect(sdk.captured.executed).toEqual([{ tool: "Bash", input: { command: "echo hi" } }]);
    expect(sdk.captured.denied).toEqual(["Bash"]);
    expect(outcome.completion).toEqual({ kind: "completed" });
  });

  it("ends the Attempt with approval_required carrying the exact proposed call in the console's form, executes nothing, and stops the turn", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([bash("git push"), bash("echo after"), returnResult()]));
    const { request, authorizations, port } = build({ policy: { read: "allowed", search: "allowed", write: "allowed", shell: "approval_required" }, authorize: (call) => (call.tool === "shell" ? { kind: "approval_required", tool: "shell", callDigest: DIGEST } : { kind: "allowed", tool: call.tool }) });
    const outcome = await adapterWith(sdk).execute(request);
    expect(outcome.completion).toEqual({ kind: "approval_required", call: { tool: "shell", input: { command: "git push" } } });
    expect(outcome.result).toBeNull();
    expect(authorizations).toEqual([{ tool: "shell", input: { command: "git push" } }]);
    expect(sdk.captured.executed).toEqual([]);
    // The hook stopped the turn: the second Bash and the return_result never ran.
    expect(sdk.captured.hookCalls.map((c) => c.tool)).toEqual(["Bash"]);
    expect(port.calls).toEqual([]);
    expect(outcome.usage).toHaveLength(1);
    expect(outcome.diagnostics.terminalReason).toBe("hook_stopped");
  });

  it("executes an approved_once call exactly as the port answers it and records nothing about approvals itself", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([bash("git push"), returnResult()]));
    const { request } = build({ authorize: (call) => (call.tool === "shell" ? { kind: "approved_once", tool: "shell", callDigest: DIGEST, decisionId: DECISION_ID, useId: "atu_000000000000000000000001" as never } : { kind: "allowed", tool: call.tool }) });
    const outcome = await adapterWith(sdk).execute(request);
    expect(sdk.captured.executed).toEqual([{ tool: "Bash", input: { command: "git push" } }]);
    expect(outcome.completion).toEqual({ kind: "completed" });
    expect(canonicalJson(outcome.diagnostics)).not.toMatch(/approv|dec_|atu_/);
  });

  it("ends with tool_failure when the authorization port fails or throws, and denies the call", async () => {
    for (const mode of ["failed", "throws"] as const) {
      const sdk = new FakeClaudeSdk();
      sdk.script(turn([bash("ls"), returnResult()]));
      const { request } = build({
        authorize: (call) => {
          if (mode === "throws") throw new Error("database is locked");
          return { kind: "failed", tool: call.tool, message: "claim transaction failed" };
        },
      });
      const outcome = await adapterWith(sdk).execute(request);
      expect(outcome.completion, mode).toMatchObject({ kind: "tool_failure", tool: "shell" });
      expect(sdk.captured.executed, mode).toEqual([]);
      expect(sdk.captured.hookCalls.map((c) => c.tool), mode).toEqual(["Bash"]);
    }
  });

  it("treats an interrupted authorization as the end of the turn", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([bash("ls"), returnResult()]));
    const { request, controller } = build({
      authorize: () => {
        controller.abort("operator_pause");
        return { kind: "interrupted", tool: "shell", cause: "operator_pause" };
      },
    });
    const outcome = await adapterWith(sdk).execute(request);
    expect(outcome.completion).toEqual({ kind: "interrupted", cause: "operator_pause", message: "aborted: operator_pause" });
    expect(sdk.captured.executed).toEqual([]);
  });
});

describe("ClaudeAgentSdkAdapter: runtime tools", () => {
  it("routes a runtime tool call to the port without touching the authorization port, echoes the typed outcome to the model, and marks refusals as errors", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([{ kind: "tool_use", name: runtimeToolNativeName("read_tasks"), input: { limit: 5 } }, { kind: "tool_use", name: runtimeToolNativeName("write_artifact"), input: { title: "note", mediaType: "text/plain", encoding: "utf8", content: "hello" } }, returnResult()]));
    const port = new FakeRuntimeToolPort(["read_tasks", "write_artifact"], (request) => (request.tool === "write_artifact" ? { kind: "rejected", tool: "write_artifact", reasons: [{ code: "invalid_bounds", message: "too big", path: "content" }] } : defaultAnswer(request)));
    const { request, authorizations } = build({ port });
    const outcome = await adapterWith(sdk).execute(request);
    expect(port.calls).toEqual([
      { tool: "read_tasks", input: { limit: 5 } },
      { tool: "write_artifact", input: { title: "note", mediaType: "text/plain", encoding: "utf8", content: "hello" } },
    ]);
    expect(authorizations).toEqual([]);
    expect(sdk.captured.mcpCalls).toEqual([
      { tool: runtimeToolNativeName("read_tasks"), input: { limit: 5 }, isError: false },
      { tool: runtimeToolNativeName("write_artifact"), input: { title: "note", mediaType: "text/plain", encoding: "utf8", content: "hello" }, isError: true },
      { tool: runtimeToolNativeName(RETURN_RESULT_TOOL), input: RESULT, isError: false },
    ]);
    expect(outcome.completion).toEqual({ kind: "completed" });
  });

  it("lets the MCP server refuse a call that does not fit the core schema before the port sees it", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([{ kind: "tool_use", name: runtimeToolNativeName("read_tasks"), input: { limit: "five" } }, { kind: "tool_use", name: runtimeToolNativeName(RETURN_RESULT_TOOL), input: { status: "completed" } }, returnResult()]));
    const { request, port } = build();
    const outcome = await adapterWith(sdk).execute(request);
    expect(sdk.captured.mcpRejected.map((r) => r.tool)).toEqual([runtimeToolNativeName("read_tasks"), runtimeToolNativeName(RETURN_RESULT_TOOL)]);
    expect(port.calls).toEqual([]);
    expect(outcome.completion).toEqual({ kind: "completed" });
    expect(outcome.result).toEqual(RESULT);
  });

  it("stops at an accepted blocking request_decision: the completion names the Decision, later calls are refused without reaching the port, and the model is told to stop", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([{ kind: "tool_use", name: runtimeToolNativeName("request_decision"), input: { kind: "operator_choice", question: "Which framework?", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }], recommendedOptionKey: "a", rationale: "A is installed.", resolutionPolicy: { kind: "operator_required" }, affects: { requirementIds: [], taskIds: [], planNodeIds: [] } } }, bash("ls"), { kind: "tool_use", name: runtimeToolNativeName("read_tasks"), input: {} }, returnResult()]));
    const { request, port, authorizations } = build();
    const outcome = await adapterWith(sdk).execute(request);
    expect(outcome.completion).toEqual({ kind: "decision_requested", decisionId: DECISION_ID });
    expect(outcome.result).toBeNull();
    expect(port.calls.map((c) => c.tool)).toEqual(["request_decision"]);
    expect(authorizations).toEqual([]);
    expect(sdk.captured.executed).toEqual([]);
    // The turn ended at the first call after the boundary.
    expect(sdk.captured.hookCalls.map((c) => c.tool)).toEqual([runtimeToolNativeName("request_decision"), "Bash"]);
    expect(outcome.diagnostics.terminalReason).toBe("hook_stopped");
  });

  it("ends with tool_failure when the runtime-tool port throws", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([{ kind: "tool_use", name: runtimeToolNativeName("read_tasks"), input: {} }, returnResult()]));
    const port = new FakeRuntimeToolPort(["read_tasks"], () => {
      throw new Error("SQLITE_BUSY");
    });
    const { request } = build({ port });
    const outcome = await adapterWith(sdk).execute(request);
    expect(outcome.completion).toMatchObject({ kind: "tool_failure", tool: "read_tasks" });
    expect(outcome.completion.kind === "tool_failure" ? outcome.completion.message : "").toMatch(/runtime tool read_tasks failed/);
    expect(outcome.result).toBeNull();
  });

  it("keeps the first returned result and refuses a second; a completed stream without a result yields a null candidate", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([returnResult(RESULT), returnResult({ ...RESULT, summary: "second" })]), turn([{ kind: "text", text: "I am done." }]));
    const adapter = adapterWith(sdk);
    const first = await adapter.execute(build().request);
    expect(first.result).toEqual(RESULT);
    // The hook ends the turn at the second call: the MCP handler never runs again.
    expect(sdk.captured.mcpCalls.map((c) => c.isError)).toEqual([false]);
    expect(sdk.captured.denied).toEqual([runtimeToolNativeName(RETURN_RESULT_TOOL)]);
    expect(first.diagnostics.terminalReason).toBe("hook_stopped");
    const second = await adapter.execute(build().request);
    expect(second.completion).toEqual({ kind: "completed" });
    expect(second.result).toBeNull();
  });
});

describe("ClaudeAgentSdkAdapter: interruption and failures", () => {
  it("maps a runtime abort to the interrupted completion with the runtime's cause, keeps the partial assistant Usage with cost unknown, and keeps the transcript", async () => {
    for (const cause of ["cancelled", "operator_pause", "deadline"] as const) {
      const sdk = new FakeClaudeSdk();
      sdk.script(turn([{ kind: "text", text: "thinking" }, { kind: "text", text: "more" }, { kind: "hang" }]));
      const { request, controller } = build();
      const execution = adapterWith(sdk).execute(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort(cause);
      const outcome = await execution;
      expect(outcome.completion, cause).toEqual({ kind: "interrupted", cause, message: `aborted: ${cause}` });
      expect(outcome.result, cause).toBeNull();
      expect(outcome.usage, cause).toEqual([{ model: "claude-fable-5", effort: "medium", inputTokensUncached: 200, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 40, costUsd: 0, wallClockMs: expect.any(Number), providerMs: null }]);
      expect(outcome.diagnostics.costUnknown, cause).toBe("true");
      expect(outcome.diagnostics.resultMessage, cause).toBe("none");
      expect(outcome.transcript, cause).not.toBeNull();
      expect(new TextDecoder().decode(outcome.transcript!).split("\n").filter(Boolean), cause).toHaveLength(3);
    }
  });

  it("returns interrupted at once for an already-aborted request without starting the SDK", async () => {
    const sdk = new FakeClaudeSdk();
    const { request, controller } = build();
    controller.abort("cancelled");
    const outcome = await adapterWith(sdk).execute(request);
    expect(outcome.completion).toEqual({ kind: "interrupted", cause: "cancelled", message: "not started: cancelled" });
    expect(sdk.captured.options).toEqual([]);
    expect(outcome.usage).toEqual([]);
  });

  it("classifies result errors through the closed classifier: max turns is permanent, an overloaded API is transient, an authentication error is permanent, a CLI failure disguised as success is a provider error, and a dead subprocess is transient", async () => {
    const cases: { name: string; turn: FakeSdkTurn; transient: boolean; pattern: RegExp }[] = [
      { name: "max turns", turn: turn([{ kind: "text", text: "loop" }], { subtype: "error_max_turns", errors: ["Reached max turns (200)"] }), transient: false, pattern: /^max_turns:/ },
      { name: "overloaded", turn: turn([{ kind: "assistant_error", error: "overloaded" }], { subtype: "error_during_execution", errors: ["API Error: 529 overloaded_error"] }), transient: true, pattern: /^overloaded:/ },
      { name: "authentication", turn: turn([{ kind: "assistant_error", error: "authentication_failed" }], { subtype: "error_during_execution", errors: ["API Error: 401 authentication_error"] }), transient: false, pattern: /^authentication:/ },
      { name: "disguised", turn: turn([], { subtype: "success", isError: true, result: "Error: getaddrinfo ENOTFOUND api.anthropic.com" }), transient: true, pattern: /^transport:/ },
      { name: "dead", turn: turn([{ kind: "text", text: "partial" }], null), transient: true, pattern: /^process_exit:/ },
      { name: "capacity", turn: turn([{ kind: "rate_limit", status: "rejected" }], { subtype: "error_during_execution", errors: ["You've hit your usage limit · resets 2:20am"] }), transient: true, pattern: /^capacity:/ },
    ];
    for (const c of cases) {
      const sdk = new FakeClaudeSdk();
      sdk.script(c.turn);
      const outcome = await adapterWith(sdk).execute(build().request);
      expect(outcome.completion.kind, c.name).toBe("provider_error");
      if (outcome.completion.kind !== "provider_error") throw new Error("unreachable");
      expect(outcome.completion.transient, c.name).toBe(c.transient);
      expect(outcome.completion.message, c.name).toMatch(c.pattern);
      expect(outcome.result, c.name).toBeNull();
    }
  });

  it("treats a thrown SDK error as a transient provider error with a sanitized message and a dead stream after a returned result as completed", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([{ kind: "throw", error: new Error("spawn failed: sk-ant-secret-key-value-000000000000 rejected") }]), turn([returnResult(), { kind: "exit" }]));
    const adapter = adapterWith(sdk);
    const thrown = await adapter.execute(build().request);
    expect(thrown.completion).toMatchObject({ kind: "provider_error", transient: true });
    expect(thrown.diagnostics.sdkError).not.toMatch(/sk-ant-secret/);
    expect(thrown.diagnostics.sdkError).toMatch(/\[redacted\]/);
    const completed = await adapter.execute(build().request);
    expect(completed.completion).toEqual({ kind: "completed" });
    expect(completed.result).toEqual(RESULT);
    expect(completed.diagnostics.resultMessage).toBe("none");
  });

  it("accounts SDK transport retries to the Attempt's one result and records the retry count", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([{ kind: "api_retry", attempt: 1, status: 529, error: "overloaded" }, { kind: "api_retry", attempt: 2, status: 529, error: "overloaded" }, returnResult()], { costUsd: 0.05 }));
    const outcome = await adapterWith(sdk).execute(build().request);
    expect(outcome.completion).toEqual({ kind: "completed" });
    expect(outcome.diagnostics.apiRetries).toBe("2");
    expect(outcome.usage.map((u) => u.costUsd)).toEqual([0.05]);
  });
});

describe("ClaudeAgentSdkAdapter: Usage, transcript, continuation", () => {
  it("records one Usage chunk per model from the result's modelUsage, never summing the per-call assistant usage on top", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([{ kind: "text", text: "a", usage: { input: 1000, output: 10 } }, { kind: "text", text: "b", usage: { input: 1000, output: 10 } }, returnResult()], { modelUsage: { "claude-fable-5": { inputTokens: 2100, outputTokens: 30, cacheReadInputTokens: 500, cacheCreationInputTokens: 200, costUSD: 0.4 }, "claude-haiku-4-5": { inputTokens: 300, outputTokens: 5, costUSD: 0.01 } }, costUsd: 0.41, durationMs: 5000, durationApiMs: 4200 }));
    const outcome = await adapterWith(sdk).execute(build().request);
    expect(outcome.usage).toEqual([
      { model: "claude-fable-5", effort: "medium", inputTokensUncached: 2100, cacheCreationTokens: 200, cacheReadTokens: 500, outputTokens: 30, costUsd: 0.4, wallClockMs: 5000, providerMs: 4200 },
      { model: "claude-haiku-4-5", effort: "medium", inputTokensUncached: 300, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 5, costUsd: 0.01, wallClockMs: 0, providerMs: null },
    ]);
    expect(outcome.timing.providerMs).toBe(4200);
    expect(outcome.diagnostics.totalCostUsd).toBe("0.41");
    expect(outcome.diagnostics.costUnknown).toBeUndefined();
  });

  it("falls back to the result's main-loop usage when no per-model figures exist, and counts repeated assistant messages of one API message once when no result arrived", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([returnResult()], { modelUsage: null, usage: { input_tokens: 42, output_tokens: 7, cache_creation_input_tokens: 3, cache_read_input_tokens: 9 }, costUsd: 0.002 }), turn([{ kind: "text", text: "x", messageId: "msg_same", usage: { input: 50, output: 5 } }, { kind: "text", text: "y", messageId: "msg_same", usage: { input: 50, output: 5 } }, { kind: "hang" }]));
    const adapter = adapterWith(sdk);
    const withResult = await adapter.execute(build().request);
    expect(withResult.usage).toEqual([{ model: "claude-fable-5", effort: "medium", inputTokensUncached: 42, cacheCreationTokens: 3, cacheReadTokens: 9, outputTokens: 7, costUsd: 0.002, wallClockMs: 1234, providerMs: 1000 }]);
    const { request, controller } = build();
    const execution = adapter.execute(request);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort("deadline");
    const interrupted = await execution;
    expect(interrupted.usage.map((u) => [u.inputTokensUncached, u.outputTokens, u.costUsd])).toEqual([[50, 5, 0]]);
  });

  it("stores a bounded, redacted JSONL transcript: no session id, no environment, a truncation marker past the bound", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([{ kind: "text", text: "x".repeat(4000) }, { kind: "text", text: "y".repeat(4000) }, returnResult()]));
    const outcome = await adapterWith(sdk, { limits: { transcriptMaxBytes: 6000 } }).execute(build().request);
    const text = new TextDecoder().decode(outcome.transcript!);
    expect(outcome.transcript!.byteLength).toBeLessThanOrEqual(6000);
    expect(text).not.toMatch(/fake-session/);
    expect(text).toMatch(/"session_id":"\[redacted\]"/);
    expect(text.trim().split("\n").at(-1)).toBe('{"truncated":true}');
    expect(outcome.diagnostics.transcriptTruncated).toBe("true");
    expect(Number(outcome.diagnostics.transcriptLines)).toBeGreaterThan(3);
    // Diagnostics carry no session id, payload, or environment either.
    expect(canonicalJson(outcome.diagnostics)).not.toMatch(/fake-session|sk-ant|PATH|HOME/);
  });

  it("returns an opaque continuation payload for the observed session, resumes from a valid payload, starts fresh from an invalid one, and offers none when continuation is disabled", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([returnResult()]), turn([returnResult()]), turn([returnResult()]), turn([returnResult()]));
    const adapter = adapterWith(sdk);
    const first = await adapter.execute(build().request);
    expect(first.continuation).not.toBeNull();
    const payload = JSON.parse(new TextDecoder().decode(first.continuation!)) as { v: number; sessionId: string };
    expect(payload).toEqual({ v: 1, sessionId: "fake-session-1" });
    expect(sdk.captured.options[0]!.persistSession).toBe(true);
    expect(sdk.captured.options[0]!.resume).toBeUndefined();
    const resumed = await adapter.execute(build({ continuation: first.continuation }).request);
    expect(sdk.captured.options[1]!.resume).toBe("fake-session-1");
    expect(resumed.diagnostics.continuation).toBe("resumed");
    const fresh = await adapter.execute(build({ continuation: new TextEncoder().encode("not a payload") }).request);
    expect(sdk.captured.options[2]!.resume).toBeUndefined();
    expect(fresh.diagnostics.continuation).toBe("invalid");
    const disabled = new ClaudeAgentSdkAdapter({ sdk, continuation: false, environment: {} });
    const none = await disabled.execute(build({ continuation: first.continuation }).request);
    expect(none.continuation).toBeNull();
    expect(sdk.captured.options[3]!.persistSession).toBe(false);
    expect(sdk.captured.options[3]!.resume).toBeUndefined();
    expect(none.diagnostics.continuation).toBe("disabled");
    expect(disabled.supportsContinuation).toBe(false);
  });

  it("starts fresh exactly once when the CLI cannot find the resumed session before any model work, and never when work happened", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([], { subtype: "error_during_execution", errors: ["No conversation found with session ID: fake-session-9"] }), turn([returnResult()]), turn([{ kind: "text", text: "worked" }], { subtype: "error_during_execution", errors: ["No conversation found with session ID: fake-session-9"] }));
    const adapter = adapterWith(sdk);
    const payload = adapter.continuationPayload("fake-session-9");
    const recovered = await adapter.execute(build({ continuation: payload }).request);
    expect(recovered.completion).toEqual({ kind: "completed" });
    expect(sdk.captured.options.map((o) => o.resume)).toEqual(["fake-session-9", undefined]);
    expect(recovered.diagnostics.continuation).toBe("fallback_fresh");
    const failed = await adapter.execute(build({ continuation: payload }).request);
    expect(failed.completion.kind).toBe("provider_error");
    expect(sdk.captured.options).toHaveLength(3);
  });

  it("emits transient output for assistant text and tool calls without input", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.script(turn([{ kind: "text", text: "Reading." }, bash("cat secret"), returnResult()]));
    const { request, outputs } = build();
    await adapterWith(sdk).execute(request);
    expect(outputs.map((o) => [o.kind, o.text])).toEqual([
      ["text", "Reading."],
      ["tool_call", "Bash"],
      ["tool_call", runtimeToolNativeName(RETURN_RESULT_TOOL)],
      ["tool_call", `${RETURN_RESULT_TOOL} recorded`],
    ]);
    expect(canonicalJson(outputs)).not.toMatch(/cat secret/);
  });
});
