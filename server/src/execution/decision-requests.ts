/**
 * Agent-requested Decisions (execution-model §8.2): the `request_decision`
 * runtime-tool handler, the canonical facts it validates against, and the
 * one place a requested Decision is created.
 *
 * An Orchestrator turn (never the read-only `final_synthesis`), a
 * Coordinator's executable turns, and a Worker's current work may request
 * exactly two Decision kinds — an `operator_choice` or, for the root
 * Orchestrator alone, a `requirement_waiver`. Every other kind has its own
 * owner and is refused typed. The runtime owns authorization, input and scope
 * validation, idempotency, and Decision creation; the model supplies only the
 * bounded question, options, recommendation, rationale, policy, and the ids
 * the answer affects — every id is validated against the caller's scope, and
 * the mere presence of an id in the input authorizes nothing.
 *
 * The handler runs inside the runtime-tool call's short root transaction: a
 * refusal writes nothing, and an accepted call creates exactly one open
 * Decision in the same transaction that records the accepted
 * `runtime_tool_calls` row. An accepted request is a hard logical-turn
 * boundary: the Attempt executor ends the Attempt and the Invocation
 * `blocked` on the Decision once the provider returns, whatever the provider
 * did afterwards (`attempt-executor.ts`).
 */
import {
  DECISION_KINDS,
  isRequestableDecisionKind,
  REQUIREMENT_MACHINE,
  REQUIREMENT_WAIVER_OPTIONS,
  ROOT_SOURCE_PATH,
  runtimeToolHandlerBound,
  type ActivationCondition,
  type ArtifactId,
  type ContextManifest,
  type Decision,
  type DecisionOption,
  type Invocation,
  type PatternPlanNode,
  type PlanNodeId,
  type RequestDecisionInput,
  type RequestedDecisionAffects,
  type RequirementId,
  type Run,
  type RuntimeToolCall,
  type RuntimeToolRejection,
  type TaskId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import type { HandlerOutcome, RuntimeToolCaller } from "./task-proposals.ts";

/** The accepted `request_decision` call of an Invocation (the row that ended its logical turn), or `null`. */
export function blockingRequestOf(stores: Stores, invocation: Pick<Invocation, "id">): RuntimeToolCall | null {
  return stores.runtimeToolCalls.listByInvocation(invocation.id).find((c) => c.tool === "request_decision") ?? null;
}

/** Whether a raw `request_decision` input names a Decision kind an agent may never request (a closed kind with another owner). */
export function forbiddenDecisionKindOf(input: unknown): string | null {
  const kind = typeof input === "object" && input !== null && typeof (input as { kind?: unknown }).kind === "string" ? (input as { kind: string }).kind : null;
  if (kind === null || isRequestableDecisionKind(kind)) return null;
  return (DECISION_KINDS as readonly string[]).includes(kind) ? kind : null;
}

/** The ids a caller may name, by role (execution-model §8.2 "Scope rules"). */
interface RequestScope {
  requirementIds: Set<RequirementId>;
  taskIds: Set<TaskId>;
  planNodeIds: Set<PlanNodeId>;
}

const reject = (code: RuntimeToolRejection["code"], message: string, path: string | null = null): HandlerOutcome => ({ kind: "rejected", reasons: [{ code, message, path }] });

export class DecisionRequestService {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
  ) {}

  // ---------------------------------------------------------------------------
  // The request_decision handler (inside the call's transaction)
  // ---------------------------------------------------------------------------

  /**
   * Creates the one Decision an accepted call names, after re-validating the
   * caller (a running Invocation of a running node of a running Run, in a
   * role and purpose the handler is bound to, never a Gate-owned or
   * final-synthesis Invocation), the request, and its scope. The executor
   * has already replayed an identical call and refused a second request of
   * the same logical turn.
   */
  request(caller: RuntimeToolCaller, input: RequestDecisionInput, options: WriteOptions): HandlerOutcome {
    const { invocation, node } = caller;
    const run = this.stores.runs.get(invocation.runId);
    if (!runtimeToolHandlerBound("request_decision", invocation.role, invocation.purpose)) return reject("caller_not_permitted", `a ${invocation.role} Invocation with purpose ${invocation.purpose} never requests a Decision`);
    // A Gate Evaluator, a run_completion Evaluator, and the final synthesis are Gate-owned; none of them requests a Decision.
    if (invocation.gateId !== null || invocation.role === "evaluator") return reject("caller_not_permitted", `Invocation ${invocation.id} is Gate-owned; a Gate or Run completion evaluation never requests a Decision`);
    if (run.status !== "running") return reject("caller_not_permitted", `Run ${run.id} is ${run.status}; a Decision is requested from a running Run`);
    if (node.status !== "running" || invocation.status !== "running") return reject("caller_not_permitted", `PlanNode ${node.id} is ${node.status} and Invocation ${invocation.id} is ${invocation.status}; a Decision is requested from running executable work`);
    if (!isRequestableDecisionKind(input.kind)) return reject("decision_kind_not_permitted", `a ${String((input as { kind: string }).kind)} Decision is never requested by an agent`, "kind");
    const manifest = this.stores.invocations.getManifest(invocation.id);
    switch (input.kind) {
      case "requirement_waiver":
        return this.requestWaiver(run, node, invocation, manifest, input, options);
      case "operator_choice":
        return this.requestChoice(run, node, invocation, manifest, input, options);
    }
  }

  /** An `operator_choice`: the caller's scope bounds every affected id and the activation condition; options keep their order. */
  private requestChoice(run: Run, node: PatternPlanNode, invocation: Invocation, manifest: ContextManifest, input: Extract<RequestDecisionInput, { kind: "operator_choice" }>, options: WriteOptions): HandlerOutcome {
    const scope = this.scopeOf(run, node, invocation, manifest);
    const outOfScope = this.outOfScope(scope, input.affects);
    if (outOfScope !== null) return reject("decision_scope_invalid", outOfScope.message, outOfScope.path);
    const policy = input.resolutionPolicy;
    let activationCondition: ActivationCondition | null = null;
    if (policy.kind === "use_default_after_deadline") {
      if (policy.activationCondition !== undefined) {
        if (!scope.planNodeIds.has(policy.activationCondition.planNodeId)) return reject("decision_scope_invalid", `activation condition names PlanNode ${policy.activationCondition.planNodeId}, which is outside the caller's scope`, "resolutionPolicy.activationCondition.planNodeId");
        activationCondition = policy.activationCondition;
      }
      if (policy.deadlineAt === undefined && activationCondition === null) return reject("invalid_resolution_policy", "use_default_after_deadline requires a deadline or an activation condition", "resolutionPolicy");
      if (input.recommendedOptionKey === undefined || input.rationale === undefined) return reject("invalid_resolution_policy", "use_default_after_deadline requires a recommended option and a rationale", "resolutionPolicy");
    }
    const decisionOptions: DecisionOption[] = input.options.map((o) => ({ id: o.key, label: o.label, description: o.description ?? null }));
    const decision = this.stores.decisions.request(
      {
        conversationId: run.conversationId,
        runId: run.id,
        kind: "operator_choice",
        resolutionPolicy: policy.kind,
        requestedBy: { kind: "invocation", invocationId: invocation.id },
        question: input.question,
        options: decisionOptions,
        recommendedOptionId: input.recommendedOptionKey ?? null,
        rationale: input.rationale ?? null,
        affects: { requirementIds: [...input.affects.requirementIds], taskIds: [...input.affects.taskIds], planNodeIds: [...input.affects.planNodeIds] },
        deadlineAt: policy.kind === "use_default_after_deadline" ? (policy.deadlineAt ?? null) : null,
        activationCondition,
        subject: null,
        supersedesDecisionId: null,
      },
      options,
    );
    return this.accepted(decision);
  }

  /**
   * A `requirement_waiver`: only the root Orchestrator; the Requirement is a
   * current leaf of the Conversation's current revision in a state the
   * transition table lets become `waived`, with no other waiver open for it;
   * the Evidence belongs to the Run and is readable by the caller; the
   * options, policy, and pinned subject are fixed by the runtime.
   */
  private requestWaiver(run: Run, node: PatternPlanNode, invocation: Invocation, manifest: ContextManifest, input: Extract<RequestDecisionInput, { kind: "requirement_waiver" }>, options: WriteOptions): HandlerOutcome {
    if (invocation.role !== "orchestrator" || node.sourcePath !== ROOT_SOURCE_PATH) return reject("caller_not_permitted", "only the root Orchestrator requests a requirement_waiver");
    const requirement = this.stores.requirements.listByConversation(run.conversationId).find((r) => r.id === input.requirementId);
    if (requirement === undefined) return reject("decision_scope_invalid", `Requirement ${input.requirementId} does not belong to the Run's Conversation`, "requirementId");
    const revision = this.stores.requirements.currentRevision(run.conversationId);
    const entry = revision?.tree.find((e) => e.id === requirement.id);
    if (revision === null || entry === undefined) return reject("requirement_not_waivable", `Requirement ${requirement.id} is not in the current Requirement revision`, "requirementId");
    if (revision.tree.some((e) => e.parentId === requirement.id)) return reject("requirement_not_waivable", `Requirement ${requirement.id} is not a leaf; only a leaf Requirement is waived`, "requirementId");
    if (!REQUIREMENT_MACHINE.canTransition(requirement.status, "waived")) return reject("requirement_not_waivable", `Requirement ${requirement.id} is ${requirement.status}; it cannot become waived`, "requirementId");
    if (this.stores.decisions.openWaiversOf(run.conversationId, requirement.id).length > 0) return reject("requirement_not_waivable", `Requirement ${requirement.id} already has an open requirement_waiver Decision`, "requirementId");
    const evidence = [...new Set(input.evidenceArtifactIds ?? [])].sort();
    const readable = this.readableArtifactIds(invocation, manifest);
    for (const id of evidence) {
      let artifact;
      try {
        artifact = this.stores.artifacts.get(id);
      } catch {
        return reject("evidence_invalid", `Artifact ${id} does not exist`, "evidenceArtifactIds");
      }
      if (artifact.runId !== run.id) return reject("evidence_invalid", `Artifact ${id} belongs to another Run`, "evidenceArtifactIds");
      if (!readable.has(id)) return reject("evidence_invalid", `Artifact ${id} is not readable by Invocation ${invocation.id}`, "evidenceArtifactIds");
    }
    const decision = this.stores.decisions.request(
      {
        conversationId: run.conversationId,
        runId: run.id,
        kind: "requirement_waiver",
        resolutionPolicy: "operator_required",
        requestedBy: { kind: "invocation", invocationId: invocation.id },
        question: `Waive Requirement ${requirement.id}?`,
        options: [
          { id: REQUIREMENT_WAIVER_OPTIONS[0], label: "Waive", description: "Accept the outcome without this Requirement's Acceptance Criteria." },
          { id: REQUIREMENT_WAIVER_OPTIONS[1], label: "Deny", description: "Keep the Requirement; the requester continues without a waiver." },
        ],
        recommendedOptionId: null,
        rationale: input.rationale,
        affects: { requirementIds: [requirement.id], taskIds: [], planNodeIds: [] },
        deadlineAt: null,
        activationCondition: null,
        subject: { kind: "requirement_waiver", runId: run.id, requirementId: requirement.id, requirementRevisionId: revision.id, evidenceArtifactIds: evidence },
        supersedesDecisionId: null,
      },
      options,
    );
    return this.accepted(decision);
  }

  private accepted(decision: Decision): HandlerOutcome {
    return { kind: "applied", result: { tool: "request_decision", decisionId: decision.id, status: "open", blocksInvocation: true } };
  }

  // ---------------------------------------------------------------------------
  // Scope (rows only)
  // ---------------------------------------------------------------------------

  /**
   * The ids a caller may affect: a Worker its own Tasks, its own node, and the Requirements of its manifest; a Coordinator its node,
   * the node's Tasks, and the node's pinned scope; the Orchestrator the current graph's nodes, the Run's current Tasks, and the
   * current revision's unretired Requirements. Historical, superseded, foreign, hidden, or inaccessible ids are never in scope.
   */
  private scopeOf(run: Run, node: PatternPlanNode, invocation: Invocation, manifest: ContextManifest): RequestScope {
    switch (invocation.role) {
      case "worker":
        return { requirementIds: new Set(manifest.content.requirements.map((r) => r.requirementId)), taskIds: new Set(invocation.taskIds), planNodeIds: new Set([node.id]) };
      case "coordinator":
        return {
          requirementIds: new Set(this.stores.plans.listScope(node.id).map((row) => row.requirementId)),
          taskIds: new Set(this.stores.tasks.listByPlanNode(node.id).map((t) => t.id)),
          planNodeIds: new Set([node.id]),
        };
      case "orchestrator": {
        const revision = this.stores.requirements.currentRevision(run.conversationId);
        const live = new Set(this.stores.requirements.listByConversation(run.conversationId).filter((r) => r.status !== "retired").map((r) => r.id));
        return {
          requirementIds: new Set((revision?.tree ?? []).map((e) => e.id).filter((id) => live.has(id))),
          taskIds: new Set(this.stores.tasks.listByRun(run.id).filter((t) => this.stores.tasks.replacementOf(t.id) === null).map((t) => t.id)),
          planNodeIds: new Set(this.stores.plans.currentGraph(run.id).nodes.map((n) => n.id)),
        };
      }
      case "evaluator":
        return { requirementIds: new Set(), taskIds: new Set(), planNodeIds: new Set() };
    }
  }

  private outOfScope(scope: RequestScope, affects: RequestedDecisionAffects): { message: string; path: string } | null {
    for (const id of affects.requirementIds) if (!scope.requirementIds.has(id)) return { message: `Requirement ${id} is outside the caller's scope`, path: "affects.requirementIds" };
    for (const id of affects.taskIds) if (!scope.taskIds.has(id)) return { message: `Task ${id} is outside the caller's scope`, path: "affects.taskIds" };
    for (const id of affects.planNodeIds) if (!scope.planNodeIds.has(id)) return { message: `PlanNode ${id} is outside the caller's scope`, path: "affects.planNodeIds" };
    return null;
  }

  /** The Artifacts a caller may read: those its immutable manifest lists, and those its own logical turn produced. */
  private readableArtifactIds(invocation: Invocation, manifest: ContextManifest): Set<ArtifactId> {
    const ids = new Set<ArtifactId>(manifest.content.artifacts.map((a) => a.artifactId));
    for (const artifact of this.stores.artifacts.listByRun(invocation.runId)) {
      if (artifact.producer.kind === "invocation" && artifact.producer.invocationId === invocation.id) ids.add(artifact.id);
    }
    return ids;
  }
}
