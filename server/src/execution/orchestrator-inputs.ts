/**
 * Operator steering (execution-model §4.6): the service-level boundary
 * through which an operator message reaches a Run's Orchestrator. The
 * message is posted to the Run's Conversation and queued as a typed
 * `operator_message` input; the scheduler's root advice turns queued inputs
 * into exactly one new logical Orchestrator turn — funded like every root
 * turn, purposed by the input table, delivering every queued input in its
 * manifest — once the latest turn is settled. Nothing is ever injected into
 * an active provider session, and a Run that ended accepts nothing.
 *
 * The same queue carries the operator's other resolutions (a superseding
 * Decision, a Requirement proposal's outcome), enqueued by their own
 * services; this service only reads them back.
 */
import { DomainError, RUN_MACHINE, utf8ByteLength, type ConversationMessage, type OrchestratorInput, type RunId } from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import { OPERATOR_ACTOR, type WriteOptions } from "../persistence/stores/support.ts";

export const OPERATOR_MESSAGE_MAX_BYTES = 32_768;

export const ORCHESTRATOR_INPUT_REFUSAL_CODES = [
  /** Steering needs an operator actor. */
  "operator_required",
  /** The Run ended; nothing is queued for a terminal Run. */
  "run_terminal",
  /** The message is empty or exceeds the bound. */
  "content_invalid",
] as const;
export type OrchestratorInputRefusalCode = (typeof ORCHESTRATOR_INPUT_REFUSAL_CODES)[number];

export class OrchestratorInputRefusedError extends DomainError {
  readonly refusal: OrchestratorInputRefusalCode;

  constructor(refusal: OrchestratorInputRefusalCode, message: string, details: Record<string, unknown> = {}) {
    super("conflict", message, { refusal, ...details });
    this.refusal = refusal;
  }
}

export interface OperatorMessageInput {
  runId: RunId;
  content: string;
}

export class OrchestratorInputService {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
  ) {}

  /** Posts the operator's message to the Run's Conversation and queues it for the Orchestrator's next `operator_input` turn. */
  postOperatorMessage(input: OperatorMessageInput, options: WriteOptions = {}): { message: ConversationMessage; queued: OrchestratorInput } {
    if (options.actor !== undefined && options.actor.kind !== "operator") throw new OrchestratorInputRefusedError("operator_required", `an operator message is posted by the operator, not ${options.actor.kind}`, { runId: input.runId });
    if (typeof input.content !== "string" || input.content.trim().length === 0) throw new OrchestratorInputRefusedError("content_invalid", "an operator message is non-empty", { runId: input.runId });
    if (utf8ByteLength(input.content) > OPERATOR_MESSAGE_MAX_BYTES) throw new OrchestratorInputRefusedError("content_invalid", `an operator message is at most ${OPERATOR_MESSAGE_MAX_BYTES} bytes`, { runId: input.runId });
    return this.ctx.tx.write(() => {
      const run = this.stores.runs.get(input.runId);
      if (RUN_MACHINE.isTerminal(run.status)) throw new OrchestratorInputRefusedError("run_terminal", `Run ${run.id} is ${run.status}; nothing is queued for a terminal Run`, { runId: run.id });
      const meta: WriteOptions = { actor: OPERATOR_ACTOR, correlationId: options.correlationId ?? run.id, causationSeq: options.causationSeq ?? null };
      const message = this.stores.conversations.postMessage({ conversationId: run.conversationId, author: "operator", content: input.content, runId: run.id, invocationId: null }, meta);
      const queued = this.stores.orchestratorInputs.enqueue(run.id, { kind: "operator_message", conversationMessageId: message.id, content: message.content }, { ...meta, causationSeq: this.ctx.journal.lastSeq() });
      return { message, queued };
    });
  }

  /** The Run's queued, undelivered inputs in delivery order. */
  pending(runId: RunId): OrchestratorInput[] {
    return this.stores.orchestratorInputs.pending(runId);
  }

  /** Every input ever queued for the Run, oldest first, with its delivering Invocation when delivered. */
  listByRun(runId: RunId): OrchestratorInput[] {
    return this.stores.orchestratorInputs.listByRun(runId);
  }
}
