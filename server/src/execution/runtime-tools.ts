/**
 * The runtime-owned runtime-tool call boundary (execution-model §6.4
 * "Runtime tools"), separate from provider-native capability authorization
 * (`tool-call-authorization.ts`). The executor binds one `RuntimeToolExecutor`
 * to the Attempt being executed — its Invocation, immutable Context
 * Manifest, role, purpose, Run, and Plan Node — and hands the adapter only
 * the `RuntimeToolCallPort` view: the effective callable set and `call`.
 * The adapter receives no store, database handle, transaction, execution
 * service, or persistence object.
 *
 * Effective callable tools = manifest permission ∩ registered handlers ∩
 * role/purpose validity. A call for any other tool is `not_callable` and
 * writes nothing.
 *
 * Every mutating call runs in its own short root transaction while the
 * provider executes outside every transaction: the validated call is
 * canonicalized and hashed; an existing `runtime_tool_calls` row for the
 * same logical turn, tool, and digest replays its committed result without
 * repeating effects; otherwise the caller is verified to be the running
 * Attempt of a running Invocation whose logical turn has not ended, the
 * handler validates (read-only) and applies, and the row and its Event
 * commit with the mutation. A rejected call writes no row, no domain
 * mutation, and no Event. A commit failure reports `failed` with the closed
 * failure kind and one diagnostic — never the thrown text; the adapter may
 * call again. Neither the raw input nor any transcript reaches an Event, a
 * diagnostic, or the record.
 *
 * An accepted `request_decision` ends the logical turn (execution-model
 * §8.2): after it commits, an identical call still replays, but every other
 * call of the turn is refused (`turn_ended`, or `decision_already_requested`
 * for a different request), and the Attempt executor ends the Invocation
 * `blocked` whatever the provider does next.
 */
import {
  boundedFailureMessage,
  canonicalRuntimeToolCall,
  failureKindOf,
  effectiveRuntimeTools,
  INVOCATION_MACHINE,
  isRuntimeToolReadTool,
  NotFoundError,
  patternPositionKey,
  runtimeToolCallMaxBytes,
  runtimeToolCallRequestSchema,
  type AttemptId,
  type ExecutableRuntimeTool,
  type Invocation,
  type InvocationId,
  type InvocationPurpose,
  type InvocationRole,
  type PlanNodeId,
  type RunId,
  type RuntimeTool,
  type RuntimeToolCallOutcome,
  type RuntimeToolCallRequest,
  type RuntimeToolCallTool,
  type RuntimeToolReadRequest,
  type RuntimeToolReadTool,
} from "@agentique-console/core";
import { sha256Hex } from "../persistence/blob-store.ts";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import type { RuntimeToolCallPort } from "../provider/adapter.ts";
import { ArtifactWriteService } from "./artifact-writes.ts";
import { CompletionRequestService } from "./completion-requests.ts";
import { DecisionRequestService, forbiddenDecisionKindOf } from "./decision-requests.ts";
import { ReadRefused, RuntimeReadService } from "./runtime-reads.ts";
import { TaskProposalService, type HandlerOutcome, type RuntimeToolCaller } from "./task-proposals.ts";
import type { ExecutionDiagnosticSink } from "./workspace-cleanup.ts";

/** What the runtime binds a runtime-tool port to; every fact comes from the canonical rows of the Attempt being executed. */
export interface RuntimeToolBinding {
  runId: RunId;
  planNodeId: PlanNodeId;
  invocationId: InvocationId;
  attemptId: AttemptId;
  role: InvocationRole;
  purpose: InvocationPurpose;
  /** The manifest permission: the Invocation's persisted `runtimeTools`. */
  manifestTools: readonly RuntimeTool[];
}

/**
 * The Invocations of one logical turn: the Invocation and every approval
 * predecessor it continues from (`continuesApprovalTurn`). An accepted call
 * of any of them belongs to the turn, so an approval successor never
 * duplicates its predecessor's accepted proposal, request, or Artifact, a
 * repeated call replays across the boundary, and the turn's write quotas
 * count every link. A predecessor blocked on a Decision it requested itself
 * ended its own logical turn (execution-model §8.2): the successor is a new
 * turn and replays nothing of it. This is replay identity only — never
 * Artifact-content authorization (`RuntimeReadService`).
 */
export function logicalTurnInvocationIds(stores: Stores, invocation: Invocation): InvocationId[] {
  const ids: InvocationId[] = [invocation.id];
  let current = invocation;
  while (current.continuedFromInvocationId !== null) {
    const previous = stores.invocations.get(current.continuedFromInvocationId);
    if (!continuesApprovalTurn(stores, previous, current)) break;
    ids.push(previous.id);
    current = previous;
  }
  return ids;
}

/**
 * Whether `current` is the approval continuation of `previous` — the
 * successor a Pattern runner or the root support prepared once the
 * `side_effect_approval` Decision that blocked `previous` was resolved —
 * revalidated from persisted facts alone (execution-model §6.4): the
 * direct continuation link; the same Run, Plan Node, and role; the same
 * Pattern position (a Gate Evaluator has none and never continues); the
 * canonical purpose transition (the same purpose, or — for the root
 * Orchestrator's ordinary turns — `decision_resolution`, exactly as
 * `RootNodeSupport.successorInputs` continues them; a `gate_result` turn
 * continues as itself); the predecessor `blocked` on a resolved
 * `side_effect_approval` whose subject names that predecessor, its Run and
 * node, and one of its Attempts; and the successor's immutable manifest
 * carrying the resolution of exactly that Decision for exactly that
 * predecessor. A completed, failed, or cancelled predecessor, one blocked on
 * an agent-requested Decision, or a link the manifest does not corroborate
 * continues nothing.
 */
export function continuesApprovalTurn(stores: Stores, previous: Invocation, current: Invocation): boolean {
  if (current.continuedFromInvocationId !== previous.id) return false;
  if (previous.status !== "blocked" || previous.blockedByDecisionId === null) return false;
  if (previous.runId !== current.runId || previous.planNodeId !== current.planNodeId || previous.role !== current.role) return false;
  if (previous.patternPosition === null || current.patternPosition === null || patternPositionKey(previous.patternPosition) !== patternPositionKey(current.patternPosition)) return false;
  if (!approvalContinuationPurpose(previous.role, previous.purpose, current.purpose)) return false;
  const decision = stores.decisions.get(previous.blockedByDecisionId);
  if (decision.kind !== "side_effect_approval" || decision.status !== "resolved" || decision.subject === null || decision.subject.kind !== "side_effect_approval") return false;
  const subject = decision.subject;
  if (subject.runId !== previous.runId || subject.planNodeId !== previous.planNodeId || subject.invocationId !== previous.id) return false;
  try {
    if (stores.invocations.getAttempt(subject.attemptId).invocationId !== previous.id) return false;
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    throw error;
  }
  return stores.invocations.getManifest(current.id).content.inputs.some((input) => input.kind === "side_effect_approval_resolution" && input.decisionId === decision.id && input.blockedInvocationId === previous.id);
}

/** The purpose an approval continuation may carry: its predecessor's, or the root's `decision_resolution` for an ordinary Orchestrator turn. */
function approvalContinuationPurpose(role: InvocationRole, from: InvocationPurpose, to: InvocationPurpose): boolean {
  if (from === "final_synthesis") return false;
  if (from === to) return true;
  return role === "orchestrator" && to === "decision_resolution" && from !== "gate_result";
}

export class RuntimeToolExecutor implements RuntimeToolCallPort {
  readonly tools: readonly ExecutableRuntimeTool[];
  readonly #ctx: PersistenceContext;
  readonly #stores: Stores;
  readonly #binding: RuntimeToolBinding;
  readonly #options: WriteOptions;
  readonly #diagnostics: ExecutionDiagnosticSink;
  readonly #proposals: TaskProposalService;
  readonly #completion: CompletionRequestService;
  readonly #decisions: DecisionRequestService;
  readonly #artifacts: ArtifactWriteService;
  readonly #reads: RuntimeReadService;

  constructor(ctx: PersistenceContext, stores: Stores, binding: RuntimeToolBinding, options: WriteOptions = {}, diagnostics: ExecutionDiagnosticSink = () => {}) {
    this.#ctx = ctx;
    this.#stores = stores;
    this.#binding = binding;
    this.#options = options;
    this.#diagnostics = diagnostics;
    this.#proposals = new TaskProposalService(ctx, stores);
    this.#completion = new CompletionRequestService(ctx, stores);
    this.#decisions = new DecisionRequestService(ctx, stores);
    this.#artifacts = new ArtifactWriteService(stores);
    this.#reads = new RuntimeReadService(stores);
    this.tools = effectiveRuntimeTools(binding.manifestTools, binding.role, binding.purpose);
  }

  async call(request: RuntimeToolCallRequest): Promise<RuntimeToolCallOutcome> {
    // The provider executes outside every transaction, so every call — a read included — arrives outside every one.
    if (this.#ctx.tx.inTransaction) throw new Error("a runtime-tool call is submitted outside any persistence transaction");
    const named = typeof request === "object" && request !== null && typeof (request as { tool?: unknown }).tool === "string" ? (request as { tool: string }).tool : "unknown";
    if (!(this.tools as readonly string[]).includes(named)) return { kind: "not_callable", tool: named };
    const tool = named as ExecutableRuntimeTool;
    // A closed Decision kind with another owner is refused by name before schema validation (execution-model §8.2).
    if (tool === "request_decision") {
      const forbidden = forbiddenDecisionKindOf((request as { input?: unknown }).input);
      if (forbidden !== null) return { kind: "rejected", tool, reasons: [{ code: "decision_kind_not_permitted", message: `a ${forbidden} Decision is never requested by an agent`, path: "kind" }] };
    }
    const parsed = runtimeToolCallRequestSchema.safeParse(request);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { kind: "rejected", tool, reasons: [{ code: "invalid_input", message: boundedFailureMessage(issue?.message ?? "malformed runtime-tool call", 300), path: issue && issue.path.length > 0 ? issue.path.map(String).join(".") : null }] };
    }
    const valid = parsed.data;
    const canonical = canonicalRuntimeToolCall(valid);
    const maxBytes = runtimeToolCallMaxBytes(tool);
    if (new TextEncoder().encode(canonical).byteLength > maxBytes) {
      return { kind: "rejected", tool, reasons: [{ code: "invalid_input", message: `the ${tool} call exceeds the ${maxBytes}-byte canonical bound`, path: null }] };
    }
    const callDigest = sha256Hex(canonical);
    if (isRuntimeToolReadTool(tool)) return this.#read(tool, valid as RuntimeToolReadRequest, callDigest);
    const mutating = tool as RuntimeToolCallTool;
    try {
      return this.#ctx.tx.write((): RuntimeToolCallOutcome => {
        const invocation = this.#stores.invocations.get(this.#binding.invocationId);
        // A call the logical turn already committed replays its result; the predecessor's row serves the successor.
        const turn = logicalTurnInvocationIds(this.#stores, invocation);
        for (const invocationId of turn) {
          const existing = this.#stores.runtimeToolCalls.find(invocationId, mutating, callDigest);
          if (existing !== null) return { kind: "accepted", tool: mutating, callId: existing.id, callDigest, replayed: true, result: existing.result };
        }
        const attempt = this.#stores.invocations.getAttempt(this.#binding.attemptId);
        if (invocation.status !== "running" || INVOCATION_MACHINE.isTerminal(invocation.status) || attempt.invocationId !== invocation.id || attempt.status !== "running") {
          return { kind: "rejected", tool: mutating, reasons: [{ code: "caller_not_running", message: `Invocation ${invocation.id} is ${invocation.status} and Attempt ${attempt.id} is ${attempt.status}`, path: null }] };
        }
        // An accepted blocking request ended the logical turn: nothing else of the turn is executed, and a different request is refused.
        const blocking = turn.flatMap((id) => this.#stores.runtimeToolCalls.listByInvocation(id)).find((c) => c.tool === "request_decision");
        if (blocking !== undefined) {
          return mutating === "request_decision"
            ? { kind: "rejected", tool: mutating, reasons: [{ code: "decision_already_requested", message: `this logical turn already requested Decision ${blocking.result.tool === "request_decision" ? blocking.result.decisionId : ""}`, path: null }] }
            : { kind: "rejected", tool: mutating, reasons: [{ code: "turn_ended", message: `the logical turn ended on an accepted request_decision (${blocking.id}); no further call is executed`, path: null }] };
        }
        const node = this.#stores.plans.getNode(invocation.planNodeId);
        if (node.kind !== "pattern") throw new Error(`PlanNode ${node.id} is a join node`);
        const caller: RuntimeToolCaller = { invocation, node };
        const outcome = this.#handle(caller, turn, valid);
        if (outcome.kind === "rejected") return { kind: "rejected", tool: mutating, reasons: outcome.reasons };
        const call = this.#stores.runtimeToolCalls.record({ invocationId: invocation.id, attemptId: attempt.id, tool: mutating, callDigest, result: outcome.result }, this.#options);
        // A handler whose canonical record names the call row (a Completion Request) writes it now, in the same transaction.
        outcome.then?.(call);
        return { kind: "accepted", tool: mutating, callId: call.id, callDigest, replayed: false, result: call.result };
      });
    } catch (error) {
      return this.#failed(mutating, callDigest, error);
    }
  }

  /**
   * An infrastructure failure of a call (execution-model §6.4, §14): nothing
   * persisted, one bounded diagnostic, the call may be retried. The outcome
   * and the diagnostic carry the tool, the caller's ids, the call digest,
   * and the closed failure kind (`failureKindOf`) — never the thrown
   * message, which may embed a path, a storage key, raw call input, or
   * Artifact bytes; truncating such text would not make it safe.
   */
  #failed(tool: ExecutableRuntimeTool, callDigest: string, error: unknown): RuntimeToolCallOutcome {
    const message = boundedFailureMessage(`${tool} failed: ${failureKindOf(error)}`);
    this.#diagnostics({ kind: "runtime_tool_call_failed", invocationId: this.#binding.invocationId, attemptId: this.#binding.attemptId, tool, callDigest, message });
    return { kind: "failed", tool, message };
  }

  /**
   * A read (execution-model §6.4 "Runtime read tools"): executed outside
   * every transaction against the canonical stores, authorized against the
   * caller's rows and immutable manifest, and never journaled — no
   * `runtime_tool_calls` row, no Event, no Usage, no receipt. The same
   * liveness and logical-turn boundary applies as to a mutating call; a
   * failure carries bounded identifiers and one diagnostic, never content.
   */
  #read(tool: RuntimeToolReadTool, request: RuntimeToolReadRequest, callDigest: string): RuntimeToolCallOutcome {
    try {
      const invocation = this.#stores.invocations.get(this.#binding.invocationId);
      const turn = logicalTurnInvocationIds(this.#stores, invocation);
      const attempt = this.#stores.invocations.getAttempt(this.#binding.attemptId);
      if (invocation.status !== "running" || attempt.invocationId !== invocation.id || attempt.status !== "running") {
        return { kind: "rejected", tool, reasons: [{ code: "caller_not_running", message: `Invocation ${invocation.id} is ${invocation.status} and Attempt ${attempt.id} is ${attempt.status}`, path: null }] };
      }
      const blocking = turn.flatMap((id) => this.#stores.runtimeToolCalls.listByInvocation(id)).find((c) => c.tool === "request_decision");
      if (blocking !== undefined) {
        return { kind: "rejected", tool, reasons: [{ code: "turn_ended", message: `the logical turn ended on an accepted request_decision (${blocking.id}); no further call is executed`, path: null }] };
      }
      const node = this.#stores.plans.getNode(invocation.planNodeId);
      if (node.kind !== "pattern") throw new Error(`PlanNode ${node.id} is a join node`);
      const manifest = this.#stores.invocations.getManifest(invocation.id);
      const run = this.#stores.runs.get(invocation.runId);
      const result = this.#reads.read({ run, node, invocation, manifest, turnInvocationIds: turn }, request);
      return { kind: "read", tool, result };
    } catch (error) {
      if (error instanceof ReadRefused) return { kind: "rejected", tool, reasons: error.reasons };
      return this.#failed(tool, callDigest, error);
    }
  }

  #handle(caller: RuntimeToolCaller, turn: readonly InvocationId[], request: RuntimeToolCallRequest): HandlerOutcome {
    switch (request.tool) {
      case "propose_tasks": {
        // One accepted proposal batch per logical Coordinator turn: a different proposal after one committed is refused.
        if (turn.some((id) => this.#stores.runtimeToolCalls.listByInvocation(id).some((c) => c.tool === "propose_tasks"))) {
          return { kind: "rejected", reasons: [{ code: "proposal_already_accepted", message: "this Coordinator turn already accepted a Task proposal", path: null }] };
        }
        return this.#proposals.propose(caller, request.input, this.#options);
      }
      case "update_task":
        return this.#proposals.cancel(caller, request.input, this.#options);
      case "request_completion":
        return this.#completion.request(caller, this.#options);
      case "request_decision":
        return this.#decisions.request(caller, request.input, this.#options);
      case "write_artifact":
        return this.#artifacts.write(caller, this.#binding.attemptId, turn, request.input, this.#options);
      default:
        // Read tools never reach the mutating handler; the executor dispatched them before opening a transaction.
        throw new Error(`no mutating handler for ${request.tool}`);
    }
  }
}
