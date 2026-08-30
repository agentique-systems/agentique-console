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
 * same logical Coordinator turn, tool, and digest replays its committed
 * result without repeating effects; otherwise the caller is verified to be
 * the running Attempt of a running Invocation, the handler validates
 * (read-only) and applies, and the row and its Event commit with the
 * mutation. A rejected call writes no row, no domain mutation, and no
 * Event. A commit failure reports `failed` with a bounded message and one
 * diagnostic; the adapter may call again. Neither the raw input nor any
 * transcript reaches an Event, a diagnostic, or the record.
 */
import {
  boundedFailureMessage,
  canonicalRuntimeToolCall,
  effectiveRuntimeTools,
  INVOCATION_MACHINE,
  RUNTIME_TOOL_CALL_MAX_BYTES,
  runtimeToolCallRequestSchema,
  type AttemptId,
  type Invocation,
  type InvocationId,
  type InvocationPurpose,
  type InvocationRole,
  type PatternPlanNode,
  type PlanNodeId,
  type RunId,
  type RuntimeTool,
  type RuntimeToolCallOutcome,
  type RuntimeToolCallRequest,
  type RuntimeToolCallTool,
} from "@agentique-console/core";
import { sha256Hex } from "../persistence/blob-store.ts";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import type { RuntimeToolCallPort } from "../provider/adapter.ts";
import { CompletionRequestService } from "./completion-requests.ts";
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
 * The Invocations of one logical Coordinator turn: the Invocation and every
 * approval predecessor it continues from (a `blocked` predecessor at the
 * same position). An accepted call of any of them belongs to the turn, so a
 * successor never duplicates its predecessor's accepted proposal and a
 * repeated call replays across the boundary.
 */
export function logicalTurnInvocationIds(stores: Stores, invocation: Invocation): InvocationId[] {
  const ids: InvocationId[] = [invocation.id];
  let current = invocation;
  while (current.continuedFromInvocationId !== null) {
    const previous = stores.invocations.get(current.continuedFromInvocationId);
    if (previous.status !== "blocked" || previous.planNodeId !== current.planNodeId || previous.purpose !== current.purpose) break;
    ids.push(previous.id);
    current = previous;
  }
  return ids;
}

export class RuntimeToolExecutor implements RuntimeToolCallPort {
  readonly tools: readonly RuntimeToolCallTool[];
  readonly #ctx: PersistenceContext;
  readonly #stores: Stores;
  readonly #binding: RuntimeToolBinding;
  readonly #options: WriteOptions;
  readonly #diagnostics: ExecutionDiagnosticSink;
  readonly #proposals: TaskProposalService;
  readonly #completion: CompletionRequestService;

  constructor(ctx: PersistenceContext, stores: Stores, binding: RuntimeToolBinding, options: WriteOptions = {}, diagnostics: ExecutionDiagnosticSink = () => {}) {
    this.#ctx = ctx;
    this.#stores = stores;
    this.#binding = binding;
    this.#options = options;
    this.#diagnostics = diagnostics;
    this.#proposals = new TaskProposalService(ctx, stores);
    this.#completion = new CompletionRequestService(ctx, stores);
    this.tools = effectiveRuntimeTools(binding.manifestTools, binding.role, binding.purpose);
  }

  async call(request: RuntimeToolCallRequest): Promise<RuntimeToolCallOutcome> {
    // The provider executes outside every transaction, so a call always opens its own root transaction.
    if (this.#ctx.tx.inTransaction) throw new Error("a runtime-tool call is submitted outside any persistence transaction");
    const named = typeof request === "object" && request !== null && typeof (request as { tool?: unknown }).tool === "string" ? (request as { tool: string }).tool : "unknown";
    if (!(this.tools as readonly string[]).includes(named)) return { kind: "not_callable", tool: named };
    const tool = named as RuntimeToolCallTool;
    const parsed = runtimeToolCallRequestSchema.safeParse(request);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { kind: "rejected", tool, reasons: [{ code: "invalid_input", message: boundedFailureMessage(issue?.message ?? "malformed runtime-tool call", 300), path: issue && issue.path.length > 0 ? issue.path.map(String).join(".") : null }] };
    }
    const valid = parsed.data;
    const canonical = canonicalRuntimeToolCall(valid);
    if (new TextEncoder().encode(canonical).byteLength > RUNTIME_TOOL_CALL_MAX_BYTES) {
      return { kind: "rejected", tool, reasons: [{ code: "invalid_input", message: `the ${tool} call exceeds the ${RUNTIME_TOOL_CALL_MAX_BYTES}-byte canonical bound`, path: null }] };
    }
    const callDigest = sha256Hex(canonical);
    try {
      return this.#ctx.tx.write((): RuntimeToolCallOutcome => {
        const invocation = this.#stores.invocations.get(this.#binding.invocationId);
        // A call the logical turn already committed replays its result; the predecessor's row serves the successor.
        for (const invocationId of logicalTurnInvocationIds(this.#stores, invocation)) {
          const existing = this.#stores.runtimeToolCalls.find(invocationId, tool, callDigest);
          if (existing !== null) return { kind: "accepted", tool, callId: existing.id, callDigest, replayed: true, result: existing.result };
        }
        const attempt = this.#stores.invocations.getAttempt(this.#binding.attemptId);
        if (invocation.status !== "running" || INVOCATION_MACHINE.isTerminal(invocation.status) || attempt.invocationId !== invocation.id || attempt.status !== "running") {
          return { kind: "rejected", tool, reasons: [{ code: "caller_not_running", message: `Invocation ${invocation.id} is ${invocation.status} and Attempt ${attempt.id} is ${attempt.status}`, path: null }] };
        }
        const node = this.#stores.plans.getNode(invocation.planNodeId);
        if (node.kind !== "pattern") throw new Error(`PlanNode ${node.id} is a join node`);
        const caller: RuntimeToolCaller = { invocation, node };
        const outcome = this.#handle(caller, valid);
        if (outcome.kind === "rejected") return { kind: "rejected", tool, reasons: outcome.reasons };
        const call = this.#stores.runtimeToolCalls.record({ invocationId: invocation.id, attemptId: attempt.id, tool, callDigest, result: outcome.result }, this.#options);
        // A handler whose canonical record names the call row (a Completion Request) writes it now, in the same transaction.
        outcome.then?.(call);
        return { kind: "accepted", tool, callId: call.id, callDigest, replayed: false, result: call.result };
      });
    } catch (error) {
      const message = boundedFailureMessage(error instanceof Error ? error.message : String(error));
      this.#diagnostics({ kind: "runtime_tool_call_failed", invocationId: this.#binding.invocationId, attemptId: this.#binding.attemptId, tool, callDigest, message });
      return { kind: "failed", tool, message };
    }
  }

  #handle(caller: RuntimeToolCaller, request: RuntimeToolCallRequest): HandlerOutcome {
    switch (request.tool) {
      case "propose_tasks": {
        // One accepted proposal batch per logical Coordinator turn: a different proposal after one committed is refused.
        const turn = logicalTurnInvocationIds(this.#stores, caller.invocation);
        if (turn.some((id) => this.#stores.runtimeToolCalls.listByInvocation(id).some((c) => c.tool === "propose_tasks"))) {
          return { kind: "rejected", reasons: [{ code: "proposal_already_accepted", message: "this Coordinator turn already accepted a Task proposal", path: null }] };
        }
        return this.#proposals.propose(caller, request.input, this.#options);
      }
      case "update_task":
        return this.#proposals.cancel(caller, request.input, this.#options);
      case "request_completion":
        return this.#completion.request(caller, this.#options);
    }
  }
}
