/**
 * The scripted fake provider: a deterministic `ProviderAdapter` for the
 * default test suite. Every `execute` consumes the next scripted step, or
 * the default step when the script is empty, and records the complete
 * request so tests can assert the exact rendered bytes, retry appendix,
 * model and effort, working directory, capability and Tool Policy,
 * continuation handling, and cancellation. No network, no credentials, no
 * timers: a `hang` step resolves only when the runtime aborts the request,
 * and a `delay` step resolves only when the test releases it. A
 * `tool_calls` step submits each proposed call to the request's
 * authorization port exactly as a real adapter must, "executes" it (into
 * the `executed` ledger) only on `allowed` or `approved_once`, and ends on
 * the first refusal; the fake keeps no approval state of its own. A
 * `runtime_tool_calls` step submits each runtime-tool call to the request's
 * runtime-tool port in order, records every outcome, and continues with
 * `then` whatever the outcomes were (a scripted agent that corrects itself
 * scripts the corrected call as the next entry) — except that, like every
 * conforming adapter, it stops at an accepted result that blocks the
 * Invocation and reports the `decision_requested` completion; a step with
 * `ignoreStop` models a misbehaving adapter that keeps going. The fake
 * holds no canonical state and never inspects an outcome beyond recording it
 * and the typed stop flag.
 */
import { runtimeToolResultBlocksInvocation, type AttemptId, type ProposedToolCall, type RuntimeToolCallOutcome, type RuntimeToolCallRequest, type RuntimeToolCallTool, type Timestamp } from "@agentique-console/core";
import type { AttemptExecutionOutcome, AttemptExecutionRequest, InterruptionCause, ProviderAdapter, ProviderCompletion, ToolCallAuthorization, UsageChunk } from "./adapter.ts";

export interface FakeStepCommon {
  /** Usage chunks to report; defaults to one chunk of `DEFAULT_USAGE`. */
  usage?: UsageChunk[];
  /** Transcript text to return; defaults to a one-line transcript naming the Attempt. */
  transcript?: string | null;
  /** A continuation payload to return; `null` (default) offers none. */
  continuation?: string | null;
  /** Transient output chunks to stream before completing. */
  output?: string[];
  /** Safe diagnostics to attach. */
  diagnostics?: Record<string, string>;
}

export type FakeStep = FakeStepCommon &
  (
    | { kind: "succeed"; result: unknown }
    | { kind: "transient_error"; message?: string }
    | { kind: "permanent_error"; message?: string }
    | { kind: "tool_failure"; tool: string; message?: string }
    /** Proposes each call to the authorization port in order; on the first non-executable outcome the step ends, otherwise `then` follows. */
    | { kind: "tool_calls"; calls: ProposedToolCall[]; then: FakeStep }
    /** Submits each runtime-tool call to the runtime-tool port in order, recording every outcome, then `then` follows; stops at a blocking result unless `ignoreStop`. */
    | { kind: "runtime_tool_calls"; calls: RuntimeToolCallRequest[]; then: FakeStep; ignoreStop?: boolean }
    | { kind: "interrupted"; message?: string }
    /** A step computed when it executes, from the request alone (a test may derive it from ids minted earlier in the same pass); the fake reads nothing. */
    | { kind: "derived"; step: (request: AttemptExecutionRequest) => FakeStep }
    | { kind: "hang" }
    | { kind: "throw"; error: Error }
    | { kind: "delay"; key: string; then: FakeStep }
  );

/** One authorization the fake requested and the outcome it received. */
export interface RecordedAuthorization {
  attemptId: AttemptId;
  call: ProposedToolCall;
  authorization: ToolCallAuthorization;
}

/** One runtime-tool call the fake submitted and the outcome it received. */
export interface RecordedRuntimeToolCall {
  attemptId: AttemptId;
  call: RuntimeToolCallRequest;
  outcome: RuntimeToolCallOutcome;
}

export interface RecordedRequest {
  attemptId: AttemptId;
  request: Omit<AttemptExecutionRequest, "signal" | "output" | "continuation" | "authorization" | "runtimeTools">;
  /** The effective callable runtime tools the request exposed. */
  runtimeTools: RuntimeToolCallTool[];
  /** Every call submitted to the authorization port during this execution, in order, with its outcome. */
  authorizations: RecordedAuthorization[];
  /** Every runtime-tool call submitted during this execution, in order, with its outcome. */
  runtimeToolCalls: RecordedRuntimeToolCall[];
  /** A copy of the continuation bytes the runtime supplied, or `null` for a fresh start. */
  continuation: Uint8Array | null;
  /** Whether the request was aborted before the step completed, and why. */
  aborted: boolean;
  abortCause: InterruptionCause | null;
  /** Whether a persistence transaction was open when the provider was called; always expected false. */
  inTransaction: boolean;
  step: FakeStep;
}

export const DEFAULT_USAGE: UsageChunk = {
  model: "fake-model",
  effort: "medium",
  inputTokensUncached: 100,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 50,
  costUsd: 0.01,
  wallClockMs: 10,
  providerMs: 8,
};

export interface ScriptedProviderOptions {
  provider?: string;
  supportsContinuation?: boolean;
  clock: () => Timestamp;
  /** Reports whether a persistence transaction is open at call time (the runtime must never call inside one). */
  inTransaction?: () => boolean;
  /** The step used when the script is empty. */
  defaultStep?: FakeStep;
}

function causeOf(signal: AbortSignal): InterruptionCause {
  const reason = signal.reason as unknown;
  return reason === "cancelled" || reason === "deadline" ? reason : "provider";
}

export class ScriptedProvider implements ProviderAdapter {
  readonly provider: string;
  readonly supportsContinuation: boolean;
  readonly requests: RecordedRequest[] = [];
  readonly outputs: { attemptId: AttemptId; text: string }[] = [];
  /** Every authorization requested, across executions. */
  readonly authorizations: RecordedAuthorization[] = [];
  /** The external side effects the fake performed: exactly the calls the port answered `allowed` or `approved_once`. */
  readonly executed: RecordedAuthorization[] = [];
  /** Every runtime-tool call submitted, across executions, with its outcome. */
  readonly runtimeToolCalls: RecordedRuntimeToolCall[] = [];
  readonly #script: FakeStep[] = [];
  readonly #released = new Map<string, () => void>();
  readonly #clock: () => Timestamp;
  readonly #inTransaction: () => boolean;
  readonly #defaultStep: FakeStep;

  constructor(options: ScriptedProviderOptions) {
    this.provider = options.provider ?? "fake";
    this.supportsContinuation = options.supportsContinuation ?? true;
    this.#clock = options.clock;
    this.#inTransaction = options.inTransaction ?? (() => false);
    this.#defaultStep = options.defaultStep ?? { kind: "succeed", result: { status: "completed", artifactIds: [], tasks: [], evidence: [], summary: "done", openItems: [], blocker: null, runOutcome: null, routeSelection: null, evaluation: null, finalReport: null } };
  }

  /** Queues steps in execution order. */
  script(...steps: FakeStep[]): this {
    this.#script.push(...steps);
    return this;
  }

  get pendingSteps(): number {
    return this.#script.length;
  }

  /** Lets a `delay` step with `key` complete. */
  release(key: string): void {
    const release = this.#released.get(key);
    if (!release) throw new Error(`no delayed execution is waiting on ${key}`);
    this.#released.delete(key);
    release();
  }

  get delayedKeys(): string[] {
    return [...this.#released.keys()].sort();
  }

  async execute(request: AttemptExecutionRequest): Promise<AttemptExecutionOutcome> {
    const step = this.#script.shift() ?? this.#defaultStep;
    const { signal, output, continuation, authorization: _port, runtimeTools, ...rest } = request;
    const recorded: RecordedRequest = {
      attemptId: request.attemptId,
      request: rest,
      runtimeTools: [...runtimeTools.tools],
      authorizations: [],
      runtimeToolCalls: [],
      continuation: continuation ? Uint8Array.from(continuation) : null,
      aborted: false,
      abortCause: null,
      inTransaction: this.#inTransaction(),
      step,
    };
    this.requests.push(recorded);
    const startedAt = this.#clock();
    const outcome = await this.#run(step, request, recorded);
    return { ...outcome, timing: { startedAt, endedAt: this.#clock(), providerMs: outcome.usage.reduce((sum, u) => sum + (u.providerMs ?? 0), 0) } };
  }

  async #run(step: FakeStep, request: AttemptExecutionRequest, recorded: RecordedRequest): Promise<Omit<AttemptExecutionOutcome, "timing">> {
    if (step.kind === "derived") return this.#run(step.step(request), request, recorded);
    if (step.kind === "delay") {
      await new Promise<void>((resolve) => {
        const finish = () => resolve();
        this.#released.set(step.key, finish);
        request.signal.addEventListener("abort", finish, { once: true });
      });
      this.#released.delete(step.key);
      if (request.signal.aborted) return this.#interrupted(step, request, recorded);
      return this.#run({ ...step.then, usage: step.then.usage ?? step.usage, transcript: step.then.transcript ?? step.transcript, continuation: step.then.continuation ?? step.continuation }, request, recorded);
    }
    for (const text of step.output ?? []) {
      this.outputs.push({ attemptId: request.attemptId, text });
      request.output({ attemptId: request.attemptId, kind: "text", text });
    }
    if (step.kind === "throw") throw step.error;
    if (step.kind === "hang") {
      if (!request.signal.aborted) await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      return this.#interrupted(step, request, recorded);
    }
    if (step.kind === "runtime_tool_calls") {
      for (const call of step.calls) {
        const outcome = await request.runtimeTools.call(call);
        const record: RecordedRuntimeToolCall = { attemptId: request.attemptId, call, outcome };
        this.runtimeToolCalls.push(record);
        recorded.runtimeToolCalls.push(record);
        request.output({ attemptId: request.attemptId, kind: "tool_call", text: `${call.tool} ${outcome.kind}` });
        // The stop boundary of the adapter contract: an accepted blocking result ends the execution here.
        if (outcome.kind === "accepted" && runtimeToolResultBlocksInvocation(outcome.result) && outcome.result.tool === "request_decision" && step.ignoreStop !== true) {
          return { ...this.#base(step, request), completion: { kind: "decision_requested", decisionId: outcome.result.decisionId }, result: null };
        }
      }
      return this.#run({ ...step.then, usage: step.then.usage ?? step.usage, transcript: step.then.transcript ?? step.transcript, continuation: step.then.continuation ?? step.continuation }, request, recorded);
    }
    if (step.kind === "tool_calls") {
      for (const call of step.calls) {
        const authorization = request.authorization.authorize(call);
        const record: RecordedAuthorization = { attemptId: request.attemptId, call, authorization };
        this.authorizations.push(record);
        recorded.authorizations.push(record);
        switch (authorization.kind) {
          case "allowed":
          case "approved_once":
            this.executed.push(record);
            request.output({ attemptId: request.attemptId, kind: "tool_call", text: `${authorization.tool} executed` });
            continue;
          case "approval_required":
            return { ...this.#base(step, request), completion: { kind: "approval_required", call }, result: null };
          case "denied":
            return { ...this.#base(step, request), completion: { kind: "tool_failure", tool: authorization.tool, message: `tool ${authorization.tool} is denied by the Tool Policy` }, result: null };
          case "invalid":
            return { ...this.#base(step, request), completion: { kind: "tool_failure", tool: authorization.tool ?? "unknown", message: authorization.message }, result: null };
          case "failed":
            return { ...this.#base(step, request), completion: { kind: "tool_failure", tool: authorization.tool, message: `authorization failed: ${authorization.message}` }, result: null };
        }
      }
      return this.#run({ ...step.then, usage: step.then.usage ?? step.usage, transcript: step.then.transcript ?? step.transcript, continuation: step.then.continuation ?? step.continuation }, request, recorded);
    }
    const base = this.#base(step, request);
    switch (step.kind) {
      case "succeed":
        return { ...base, completion: { kind: "completed" }, result: step.result };
      case "transient_error":
        return { ...base, completion: { kind: "provider_error", transient: true, message: step.message ?? "provider overloaded" }, result: null };
      case "permanent_error":
        return { ...base, completion: { kind: "provider_error", transient: false, message: step.message ?? "model not available" }, result: null };
      case "tool_failure":
        return { ...base, completion: { kind: "tool_failure", tool: step.tool, message: step.message ?? `${step.tool} failed` }, result: null };
      case "interrupted":
        return { ...base, completion: { kind: "interrupted", cause: "provider", message: step.message ?? "provider stream ended" }, result: null };
    }
  }

  #interrupted(step: FakeStep, request: AttemptExecutionRequest, recorded: RecordedRequest): Omit<AttemptExecutionOutcome, "timing"> {
    recorded.aborted = true;
    recorded.abortCause = causeOf(request.signal);
    return { ...this.#base(step, request), completion: { kind: "interrupted", cause: recorded.abortCause, message: `aborted: ${recorded.abortCause}` }, result: null };
  }

  #base(step: FakeStep, request: AttemptExecutionRequest): Pick<AttemptExecutionOutcome, "usage" | "transcript" | "continuation" | "diagnostics"> {
    const encoder = new TextEncoder();
    const transcript = step.transcript === undefined ? `transcript of ${request.attemptId}` : step.transcript;
    return {
      usage: step.usage ?? [{ ...DEFAULT_USAGE, model: request.model, effort: request.effort }],
      transcript: transcript === null ? null : encoder.encode(transcript),
      continuation: step.continuation === undefined || step.continuation === null ? null : encoder.encode(step.continuation),
      diagnostics: step.diagnostics ?? {},
    };
  }
}
