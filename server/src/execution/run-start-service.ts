/**
 * Starting a Run (execution-model §3, §4.6): given a bootstrapped Run in
 * `created` and the operator's initial message, one root transaction moves
 * the root node `pending → ready → running`, the Run `created → running`,
 * and prepares the first Orchestrator Invocation — role `orchestrator`,
 * purpose `operator_input`, ordinary Plan Node funding, no predecessor —
 * with its reservation and Context Manifest. Nothing executes here; the
 * Attempt executor runs the prepared Invocation when explicitly asked.
 * Starting a Run twice is a conflict and creates no second Invocation.
 */
import { ConflictError, idSchema, InsufficientCapacityError, nonEmptyString, parseOrThrow, ValidationError, type ConversationMessageId, type PlanNode, type Run, type RunId } from "@agentique-console/core";
import { z } from "zod";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { InvocationPreparationService, PreparedInvocation } from "./invocation-preparation-service.ts";
import { PlanNodeCapacity } from "./plan-node-capacity.ts";

export interface RunStartRequest {
  runId: RunId;
  /** The operator message that starts the Run; it must belong to the Run's Conversation. */
  conversationMessageId: ConversationMessageId;
  correlationId?: string | null;
}

const requestSchema: z.ZodType<RunStartRequest> = z.strictObject({
  runId: idSchema("run"),
  conversationMessageId: idSchema("conversationMessage"),
  correlationId: nonEmptyString.nullable().optional(),
});

export interface StartedRun {
  run: Run;
  root: PlanNode;
  prepared: PreparedInvocation;
}

export class RunStartService {
  private readonly capacity: PlanNodeCapacity;

  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
    private readonly preparation: InvocationPreparationService,
  ) {
    this.capacity = new PlanNodeCapacity(ctx, stores);
  }

  start(request: RunStartRequest): StartedRun {
    const valid = parseOrThrow(requestSchema, request, "Run start request");
    const meta = { correlationId: valid.correlationId ?? null };
    return this.ctx.tx.write(() => {
      const run = this.stores.runs.get(valid.runId);
      if (run.status !== "created") throw new ConflictError(`Run ${run.id} is ${run.status}; a Run starts once, from created`, { runId: run.id, status: run.status });
      const message = this.stores.conversations.getMessage(valid.conversationMessageId);
      if (message.conversationId !== run.conversationId) throw new ValidationError(`ConversationMessage ${message.id} belongs to Conversation ${message.conversationId}, not the Run's ${run.conversationId}`);
      if (message.runId !== null && message.runId !== run.id) throw new ValidationError(`ConversationMessage ${message.id} was posted in Run ${message.runId}`);
      if (message.author !== "operator") throw new ValidationError(`ConversationMessage ${message.id} is not an operator message`);
      const root = this.stores.plans.rootNode(run.id);
      if (root.kind !== "pattern" || root.shape.pattern !== "single" || root.shape.role !== "orchestrator") throw new Error(`Run ${run.id} has no Orchestrator root node`);
      if (root.status !== "pending") throw new ConflictError(`root PlanNode ${root.id} is ${root.status}`);
      this.stores.plans.transitionNode(root.id, { to: "ready" }, meta);
      const running = this.stores.plans.transitionNode(root.id, { to: "running" }, meta);
      const started = this.stores.runs.transition(run.id, { to: "running" }, meta);
      // The first operator turn is ordinary root work: funded through the one capacity operation (the root's `extend` policy applies).
      const funded = this.capacity.ensure(running as never, this.stores.agents.getRevision(root.shape.operation.agentDefinitionRevisionId).defaultLimits.allocation, "root_turn", meta);
      if (funded.kind !== "funded") throw new InsufficientCapacityError(`the root node of Run ${run.id} cannot fund its first Orchestrator turn`, { runId: run.id, planNodeId: root.id, outcome: funded.kind });
      const prepared = this.preparation.prepare({
        runId: run.id,
        planNodeId: root.id,
        role: "orchestrator",
        purpose: "operator_input",
        patternPosition: { kind: "orchestrator" },
        continuedFromInvocationId: null,
        funding: { source: "plan_node" },
        inputs: [{ kind: "operator_message", conversationMessageId: message.id, content: message.content }],
        correlationId: meta.correlationId,
        causationSeq: this.ctx.journal.lastSeq(),
      });
      return { run: started, root: running, prepared };
    });
  }
}
