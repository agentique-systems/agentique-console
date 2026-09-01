/**
 * The provider-neutral execution contract (execution-model §1 "Provider",
 * §6.5, §13). A provider adapter executes exactly one Attempt: it receives
 * the deterministic rendered input and the effective policies, drives the
 * model with its native tools, and returns one typed outcome. It holds no
 * state the runtime depends on for correctness.
 *
 * An adapter never: queries a canonical store; schedules, retries, or
 * creates another Attempt; transitions a Run, Plan Node, Invocation, Task,
 * Requirement, or Decision; assembles a Context Manifest; decides a
 * Pattern; performs fan-in; interprets Budget policy; or exposes a
 * continuation payload or storage key in a log, Event, or diagnostic. It
 * never treats an `approval_required` disposition as `allowed`, and it
 * never decides for itself whether a call may run: before executing any
 * provider-native capability call it submits the exact proposed call to
 * the request's `authorization` port and executes only on `allowed` or
 * `approved_once`; on `approval_required` it ends the execution with the
 * typed `approval_required` completion. The adapter keeps no
 * approval-consumption state — the runtime's canonical approval use
 * decides, so a fresh or restarted adapter cannot repeat a consumed call.
 *
 * A runtime-tool call whose accepted result `blocksInvocation`
 * (`request_decision`, execution-model §8.2) ends the logical turn: the
 * adapter stops driving the model at once and returns the typed
 * `decision_requested` completion. The runtime does not rely on it — the
 * committed call row is the boundary, and whatever the adapter reports
 * afterwards (a result, a failure, a throw, further calls) cannot override
 * it — but a conforming adapter never spends provider work past it.
 */
import type { AgentCapabilities, ApprovedToolCallUseId, AttemptId, DecisionId, ExecutableRuntimeTool, InvocationId, ModelEffort, ProposedToolCall, RunId, RuntimeToolCallOutcome, RuntimeToolCallRequest, Timestamp, ToolPolicy, UsageInput } from "@agentique-console/core";

/** The deterministic bytes rendered from the persisted Context Manifest (plus a bounded retry appendix). */
export interface RenderedInput {
  rendererVersion: number;
  text: string;
  /** SHA-256 of `text`, so tests and diagnostics can reference the exact bytes without repeating them. */
  digest: string;
}

/** Streaming provider output: transient, never journaled, carrying the Attempt id and nothing else about the system. */
export interface TransientOutput {
  attemptId: AttemptId;
  kind: "text" | "tool_call";
  text: string;
}

export type TransientOutputSink = (output: TransientOutput) => void;

/**
 * The closed outcome of authorizing one proposed call (execution-model
 * §6.4). Execution is permitted on exactly `allowed` and `approved_once`.
 */
export type ToolCallAuthorization =
  /** The tool's effective disposition is `allowed`; no approval is involved. */
  | { kind: "allowed"; tool: string }
  /** The tool's effective disposition is `denied` (or the tool is not declared); the call never executes. */
  | { kind: "denied"; tool: string }
  /** An exact matching `approve_once` grant was claimed and committed: this call, this once. */
  | { kind: "approved_once"; tool: string; callDigest: string; decisionId: DecisionId; useId: ApprovedToolCallUseId }
  /** The tool requires approval and no matching unconsumed grant exists; the execution ends with the `approval_required` completion carrying the call. */
  | { kind: "approval_required"; tool: string; callDigest: string }
  /** The call is malformed or exceeds the canonical bound; nothing is recorded and the call never executes. */
  | { kind: "invalid"; tool: string | null; message: string }
  /** The claim could not be recorded (a persistence failure); nothing persisted, nothing authorized; a retry may claim again. */
  | { kind: "failed"; tool: string; message: string }
  /** The Run no longer admits execution (cancelled, or hard-paused by the operator): the call never executes and the adapter ends with the `interrupted` completion of the same cause (execution-model §14). */
  | { kind: "interrupted"; tool: string; cause: Exclude<InterruptionCause, "provider"> };

/**
 * The runtime-owned authorization boundary the adapter consults before
 * every provider-native capability call. It is bound by the runtime to the
 * Attempt being executed; the adapter submits only the proposed call.
 */
export interface ToolCallAuthorizationPort {
  authorize(call: ProposedToolCall): ToolCallAuthorization;
}

/**
 * The runtime-tool call boundary (execution-model §6.4 "Runtime tools"),
 * separate from provider-native capability authorization. The runtime binds
 * it to exactly one running Attempt, Invocation, immutable Context Manifest,
 * role, purpose, Run, and Plan Node; the adapter receives no store, database
 * handle, transaction, execution service, or persistence object. `tools` is
 * the **effective callable set** — manifest permission ∩ runtime handler
 * availability ∩ role/purpose validity — and the adapter exposes exactly
 * these to the model and submits calls only for them. Every mutating call
 * commits in its own short root transaction while the provider runs outside
 * every transaction; an accepted call is replayable by canonical digest, a
 * rejected call writes nothing, and results carry ids and stable refusal
 * codes rather than domain history. A read tool returns a typed bounded
 * projection (`kind: "read"`) with no durable record of any kind. Runtime
 * tools never go through side-effect approval and expose no transcript or
 * continuation state.
 */
export interface RuntimeToolCallPort {
  readonly tools: readonly ExecutableRuntimeTool[];
  call(request: RuntimeToolCallRequest): Promise<RuntimeToolCallOutcome>;
}

export interface AttemptExecutionRequest {
  attemptId: AttemptId;
  invocationId: InvocationId;
  runId: RunId;
  model: string;
  effort: ModelEffort;
  input: RenderedInput;
  /** The effective capability set: which provider-native tools and MCP servers may be exposed. */
  capabilities: AgentCapabilities;
  /** The effective Tool Policy over every declared tool, for exposing tools; the `authorization` port is the authority for every call. */
  toolPolicy: ToolPolicy;
  /**
   * The runtime's authorization boundary for this Attempt. Every
   * provider-native capability call is submitted here first and executes
   * only on `allowed` or `approved_once`; an `approval_required` outcome
   * ends the execution with the typed completion carrying the same call.
   * An approval widens no Tool Policy: it is one exact digest, once.
   */
  authorization: ToolCallAuthorizationPort;
  /** The runtime-tool call boundary bound to this Attempt; the adapter exposes exactly `runtimeTools.tools`. */
  runtimeTools: RuntimeToolCallPort;
  /** The worktree (or Integration Workspace for a read-only Invocation) the Attempt runs in; `null` for a Run without one. */
  workingDirectory: string | null;
  /** The wall-clock deadline the runtime enforces; the adapter may also stop itself at it. */
  deadlineAt: Timestamp | null;
  /** Aborted by the runtime on cancellation, a hard operator pause, or the deadline; the reason is an `InterruptionCause`. */
  signal: AbortSignal;
  /** A verified opaque continuation payload for a `resumed` start, or `null` for a `fresh` start. */
  continuation: Uint8Array | null;
  output: TransientOutputSink;
}

/**
 * Why an execution was interrupted: `cancelled` (the Run was cancelled; no
 * retry), `operator_pause` (the operator hard-paused the Run; the Attempt is
 * retried once the Run resumes), `deadline` (the Invocation-wide wall-clock
 * limit), or `provider` (the provider ended the stream itself).
 */
export const INTERRUPTION_CAUSES = ["cancelled", "operator_pause", "deadline", "provider"] as const;
export type InterruptionCause = (typeof INTERRUPTION_CAUSES)[number];

/** How the provider execution ended, as the runtime's classification input (execution-model §7.2). */
export type ProviderCompletion =
  | { kind: "completed" }
  | { kind: "provider_error"; transient: boolean; message: string }
  | { kind: "tool_failure"; tool: string; message: string }
  /** The authorization port answered `approval_required`: the exact proposed call in the provider-neutral form the runtime canonicalizes and records. */
  | { kind: "approval_required"; call: ProposedToolCall }
  /** The runtime-tool port accepted a blocking `request_decision`: the adapter stopped at that boundary; the runtime settles it from the committed row. */
  | { kind: "decision_requested"; decisionId: DecisionId }
  | { kind: "interrupted"; cause: InterruptionCause; message: string };

/** One provider result's measured consumption; the runtime records one Usage row per chunk. */
export type UsageChunk = Omit<UsageInput, "attemptId">;

export interface ProviderTiming {
  startedAt: Timestamp;
  endedAt: Timestamp;
  providerMs: number | null;
}

export interface AttemptExecutionOutcome {
  completion: ProviderCompletion;
  /** The candidate typed result returned through `return_result`, unvalidated; `null` when none was returned. */
  result: unknown;
  usage: UsageChunk[];
  /** Bounded transcript bytes for the diagnostic transcript Artifact, or `null`. */
  transcript: Uint8Array | null;
  /** An opaque payload the provider can continue from, or `null` when it offers none. */
  continuation: Uint8Array | null;
  timing: ProviderTiming;
  /** Safe, non-sensitive diagnostic metadata (never a payload, storage key, prompt, or secret). */
  diagnostics: Record<string, string>;
}

export interface ProviderAdapter {
  /** The provider name recorded on Usage attribution and continuation index rows. */
  readonly provider: string;
  readonly supportsContinuation: boolean;
  execute(request: AttemptExecutionRequest): Promise<AttemptExecutionOutcome>;
}
