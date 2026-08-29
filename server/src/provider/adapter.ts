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
 * never treats an `approval_required` disposition as `allowed`: such a call
 * ends the execution with the typed `approval_required` completion.
 */
import type { AgentCapabilities, AttemptId, InvocationId, ModelEffort, RunId, Timestamp, ToolPolicy, UsageInput } from "@agentique-console/core";

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

export interface AttemptExecutionRequest {
  attemptId: AttemptId;
  invocationId: InvocationId;
  runId: RunId;
  model: string;
  effort: ModelEffort;
  input: RenderedInput;
  /** The effective capability set: which provider-native tools and MCP servers may be exposed. */
  capabilities: AgentCapabilities;
  /** The effective Tool Policy over every declared tool; `approval_required` calls end the execution. */
  toolPolicy: ToolPolicy;
  /** The worktree (or Integration Workspace for a read-only Invocation) the Attempt runs in; `null` for a Run without one. */
  workingDirectory: string | null;
  /** The wall-clock deadline the runtime enforces; the adapter may also stop itself at it. */
  deadlineAt: Timestamp | null;
  /** Aborted by the runtime on cancellation or deadline; the reason is an `InterruptionCause`. */
  signal: AbortSignal;
  /** A verified opaque continuation payload for a `resumed` start, or `null` for a `fresh` start. */
  continuation: Uint8Array | null;
  output: TransientOutputSink;
}

export const INTERRUPTION_CAUSES = ["cancelled", "deadline", "provider"] as const;
export type InterruptionCause = (typeof INTERRUPTION_CAUSES)[number];

/** How the provider execution ended, as the runtime's classification input (execution-model §7.2). */
export type ProviderCompletion =
  | { kind: "completed" }
  | { kind: "provider_error"; transient: boolean; message: string }
  | { kind: "tool_failure"; tool: string; message: string }
  | { kind: "approval_required"; tool: string; call: string }
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
