/**
 * The Orchestrator's recorded choices (execution-model §8.2
 * `record_decision`): the executable handler that turns a call into one
 * `orchestrator_choice` Decision requested by the calling Invocation and
 * resolved by the Orchestrator in the same transaction. Nothing blocks and
 * no one else resolves it: the operator never resolves an
 * `orchestrator_choice`, and the record exists so the choice, its
 * alternatives, and its rationale are canonical facts a later turn, a
 * reader, or the operator can inspect. Its scope is the Orchestrator's:
 * the current graph's nodes, the Run's current Tasks, and the current
 * revision's live Requirements.
 */
import { runIsRunningOrDraining, runtimeToolHandlerBound, type DecisionOption, type RecordDecisionInput } from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import { requestScopeOf, scopeViolationOf } from "./decision-requests.ts";
import type { HandlerOutcome, RuntimeToolCaller } from "./task-proposals.ts";

function rejected(code: Extract<HandlerOutcome, { kind: "rejected" }>["reasons"][number]["code"], message: string, path: string | null = null): HandlerOutcome {
  return { kind: "rejected", reasons: [{ code, message, path }] };
}

export class DecisionRecordService {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
  ) {}

  record(caller: RuntimeToolCaller, input: RecordDecisionInput, options: WriteOptions): HandlerOutcome {
    const { invocation, node } = caller;
    if (invocation.role !== "orchestrator" || !runtimeToolHandlerBound("record_decision", invocation.role, invocation.purpose)) return rejected("caller_not_permitted", `a ${invocation.role} Invocation with purpose ${invocation.purpose} never records a Decision`);
    if (invocation.gateId !== null) return rejected("caller_not_permitted", `Invocation ${invocation.id} is Gate-owned; a Gate evaluation never records a Decision`);
    if (invocation.status !== "running" || invocation.planNodeId !== node.id) return rejected("caller_not_running", `Invocation ${invocation.id} is ${invocation.status} or does not belong to PlanNode ${node.id}`);
    const run = this.stores.runs.get(invocation.runId);
    if (!runIsRunningOrDraining(run)) return rejected("caller_not_permitted", `Run ${run.id} is ${run.status}${run.operatorPause === null ? "" : ` and paused (${run.operatorPause})`}; a Decision is recorded in a running Run`);
    if (node.status !== "running") return rejected("caller_not_permitted", `PlanNode ${node.id} is ${node.status}; a Decision is recorded from running work`);
    const manifest = this.stores.invocations.getManifest(invocation.id);
    const violation = scopeViolationOf(requestScopeOf(this.stores, run, node, invocation, manifest), input.affects);
    if (violation !== null) return rejected("decision_scope_invalid", violation.message, violation.path);
    const decisionOptions: DecisionOption[] = input.options.map((o) => ({ id: o.key, label: o.label, description: o.description ?? null }));
    const decision = this.stores.decisions.request(
      {
        conversationId: run.conversationId,
        runId: run.id,
        kind: "orchestrator_choice",
        resolutionPolicy: "operator_required",
        requestedBy: { kind: "invocation", invocationId: invocation.id },
        question: input.question,
        options: decisionOptions,
        recommendedOptionId: input.chosenOptionKey,
        rationale: input.rationale,
        affects: { requirementIds: [...input.affects.requirementIds], taskIds: [...input.affects.taskIds], planNodeIds: [...input.affects.planNodeIds] },
        deadlineAt: null,
        activationCondition: null,
        subject: null,
        supersedesDecisionId: null,
      },
      options,
    );
    this.stores.decisions.resolve(decision.id, { resolvedBy: "orchestrator", chosenOptionId: input.chosenOptionKey, rationale: input.rationale, artifactIds: [] }, { ...options, causationSeq: this.ctx.journal.lastSeq() });
    return { kind: "applied", result: { tool: "record_decision", decisionId: decision.id, chosenOptionId: input.chosenOptionKey } };
  }
}
