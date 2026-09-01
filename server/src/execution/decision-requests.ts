/**
 * Agent-requested Decisions (execution-model §8.2): the `request_decision`
 * runtime-tool handler, the canonical facts it validates against, the one
 * place a requested Decision is created, and the two paths that end one —
 * the operator's resolution and the runtime's deterministic default
 * resolution once a `use_default_after_deadline` Decision is due.
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
 * boundary under both resolution policies: the Attempt executor ends the
 * Attempt and the Invocation `blocked` on the Decision once the provider
 * returns, whatever the provider did afterwards (`attempt-executor.ts`), and
 * no provider process ever waits for the operator.
 *
 * Resolution never invokes a provider and never prepares the continuation:
 * `resolve` (the operator) and `resolveDefault` (the scheduler's
 * `resolve_decision_default` action, projected from persisted rows and the
 * caller's clock — no timer, interval, or second scheduler) write the
 * Decision resolution and its Event in one transaction; a `waive` also
 * applies the Requirement's `waived` status change there; a waiver whose
 * pinned Requirement went stale is superseded instead, never applied to a
 * newer revision. The scheduler continues the blocked requester afterwards.
 */
import {
  DECISION_KINDS,
  DecisionRequestRefusedError,
  decisionResolutionInputOf,
  isAgentRequestedDecision,
  isRequestableDecisionKind,
  NotFoundError,
  REQUIREMENT_MACHINE,
  REQUIREMENT_WAIVER_OPTIONS,
  ROOT_SOURCE_PATH,
  RUN_MACHINE,
  runIsRunningOrDraining,
  runtimeToolHandlerBound,
  waiverSubjectOf,
  type ActivationCondition,
  type ArtifactId,
  type ContextManifest,
  type Decision,
  type DecisionId,
  type DecisionOption,
  type Evidence,
  type Invocation,
  type PatternPlanNode,
  type PlanNodeId,
  type RequestDecisionInput,
  type RequestedDecisionAffects,
  type RequirementId,
  type Run,
  type RunId,
  type RuntimeToolCall,
  type RuntimeToolRejection,
  type TaskId,
  type Timestamp,
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import { OPERATOR_ACTOR, type WriteOptions } from "../persistence/stores/support.ts";
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

/** The operator's resolution of an agent-requested Decision: the exact Decision and option, an optional rationale (required for a waiver), optional Evidence Artifacts of the Run. */
export interface DecisionResolveInput {
  decisionId: DecisionId;
  optionId: string;
  rationale?: string | null;
  artifactIds?: ArtifactId[];
}

export type DecisionResolutionOutcome =
  /** The Decision is resolved to `chosenOptionId` (now, or already identically: `replayed`). */
  | { kind: "resolved"; decisionId: DecisionId; chosenOptionId: string; resolvedBy: Decision["resolution"] extends infer R ? (R extends { resolvedBy: infer B } ? B : never) : never; replayed: boolean }
  /** A `requirement_waiver` whose pinned Requirement went stale was superseded (now, or already: `replayed`); no waiver was applied. */
  | { kind: "superseded"; decisionId: DecisionId; reason: "requirement_waiver_stale"; replayed: boolean };

/** A requester whose Decision ended and whose one successor does not exist yet: what the scheduler's `continue_decision_request` names. */
export interface DecisionSupersedeInput {
  /** The requested `operator_choice` the runtime resolved by its default policy. */
  decisionId: DecisionId;
  /** The option the operator chooses instead. */
  optionId: string;
  rationale?: string | null;
  artifactIds?: ArtifactId[];
}

export interface DecisionSupersessionOutcome {
  kind: "superseded";
  decisionId: DecisionId;
  /** The operator-requested `operator_choice` recorded as the explicit superseder, resolved to `chosenOptionId`. */
  supersedingDecisionId: DecisionId;
  chosenOptionId: string;
  replayed: boolean;
  /** How the choice reaches the work: the requester's pending continuation carries both resolutions, or the Orchestrator's next turn receives the superseding resolution as a queued input. */
  followUp: "continuation" | "queued_input" | "none";
}

export interface PendingContinuation {
  invocation: Invocation;
  decision: Decision;
}

/** Why a waiver Decision's pinned Requirement can no longer be waived as requested. */
export type WaiverStaleness = "requirement_retired" | "requirement_not_waivable" | "requirement_not_current_leaf" | "revision_superseded";

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
    // A soft-paused Run still accepts the request of a draining turn (execution-model §14); a hard-paused, verifying, or ended one does not.
    if (!runIsRunningOrDraining(run)) return reject("caller_not_permitted", `Run ${run.id} is ${run.status}${run.operatorPause === null ? "" : ` and paused (${run.operatorPause})`}; a Decision is requested from a running Run`);
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
    const scope = requestScopeOf(this.stores, run, node, invocation, manifest);
    const outOfScope = scopeViolationOf(scope, input.affects);
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
    const readable = readableArtifactIds(this.stores, invocation, manifest);
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
  // Operator resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolves an agent-requested Decision as the operator: the option must be
   * one of the Decision's; an identical completed resolution replays without
   * a write; a conflicting one is refused; a `requirement_waiver` needs the
   * operator's rationale, and `waive` sets the pinned Requirement `waived`
   * in the same transaction — unless the Requirement went stale, in which
   * case the Decision is superseded and no waiver is applied. Nothing here
   * invokes a provider or prepares the continuation; the scheduler continues
   * the blocked requester from rows, whether or not it can be funded now.
   */
  resolve(input: DecisionResolveInput, options: WriteOptions = {}): DecisionResolutionOutcome {
    if (options.actor !== undefined && options.actor.kind !== "operator") throw new DecisionRequestRefusedError("operator_required", `a requested Decision is resolved by the operator, not ${options.actor.kind}`, { decisionId: input.decisionId });
    return this.ctx.tx.write(() => {
      const decision = this.requested(input.decisionId);
      const run = this.stores.runs.get(decision.runId!);
      if (RUN_MACHINE.isTerminal(run.status)) throw new DecisionRequestRefusedError("run_terminal", `Run ${run.id} is ${run.status}; nothing is resolved for a terminal Run`, { decisionId: decision.id, runId: run.id });
      if (!decision.options.some((o) => o.id === input.optionId)) throw new DecisionRequestRefusedError("option_invalid", `${input.optionId} is not an option of Decision ${decision.id}`, { decisionId: decision.id, optionId: input.optionId });
      const replayed = this.replay(decision, input.optionId);
      if (replayed !== null) return replayed;
      const rationale = input.rationale ?? null;
      const artifactIds = [...new Set(input.artifactIds ?? [])].sort();
      for (const id of artifactIds) {
        let artifact;
        try {
          artifact = this.stores.artifacts.get(id);
        } catch {
          throw new DecisionRequestRefusedError("evidence_invalid", `Artifact ${id} does not exist`, { decisionId: decision.id, artifactId: id });
        }
        if (artifact.runId !== run.id) throw new DecisionRequestRefusedError("evidence_invalid", `Artifact ${id} belongs to another Run`, { decisionId: decision.id, artifactId: id });
      }
      const meta: WriteOptions = { actor: OPERATOR_ACTOR, correlationId: options.correlationId ?? decision.id, causationSeq: options.causationSeq ?? null };
      if (decision.kind !== "requirement_waiver") {
        this.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: input.optionId, rationale, artifactIds }, meta);
        return { kind: "resolved", decisionId: decision.id, chosenOptionId: input.optionId, resolvedBy: "operator", replayed: false };
      }
      if (rationale === null) throw new DecisionRequestRefusedError("rationale_required", `a requirement_waiver resolution records the operator's rationale`, { decisionId: decision.id });
      // A stale pinned Requirement supersedes the waiver whatever the option: a waiver is never applied to a newer revision or a changed Requirement.
      if (this.waiverStaleness(decision) !== null) {
        this.stores.decisions.supersede(decision.id, "requirement_waiver_stale", meta);
        return { kind: "superseded", decisionId: decision.id, reason: "requirement_waiver_stale", replayed: false };
      }
      const subject = waiverSubjectOf(decision);
      this.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: input.optionId, rationale, artifactIds }, meta);
      if (input.optionId === "waive") {
        const evidence: Evidence[] = artifactIds.map((artifactId) => ({ kind: "artifact", artifactId }));
        this.stores.requirements.recordStatusChange({ requirementId: subject.requirementId, runId: run.id, to: "waived", actor: "operator", evidence, gateId: null, decisionId: decision.id, rationale }, { ...meta, causationSeq: this.ctx.journal.lastSeq() });
      }
      return { kind: "resolved", decisionId: decision.id, chosenOptionId: input.optionId, resolvedBy: "operator", replayed: false };
    });
  }

  // ---------------------------------------------------------------------------
  // Operator supersession of a policy resolution
  // ---------------------------------------------------------------------------

  /**
   * Supersedes a requested `operator_choice` the runtime resolved by its
   * default policy (execution-model §8.2): a new `operator_choice`
   * requested by the operator — the same question, options, and affected
   * ids — is recorded as the explicit superseder (the original stays in
   * history as `superseded`, naming it) and resolved by the operator to the
   * chosen option in the same transaction. Nothing is undone, rerun, or
   * reallocated: a requester still awaiting its continuation continues once,
   * through the scheduler, with both resolutions in its manifest; when work
   * already proceeded, the superseding resolution is queued as a typed
   * input of the Orchestrator's next turn. A repeat with the same option
   * replays; a different option, or an operator-resolved Decision, is refused.
   */
  supersede(input: DecisionSupersedeInput, options: WriteOptions = {}): DecisionSupersessionOutcome {
    if (options.actor !== undefined && options.actor.kind !== "operator") throw new DecisionRequestRefusedError("operator_required", `a policy resolution is superseded by the operator, not ${options.actor.kind}`, { decisionId: input.decisionId });
    return this.ctx.tx.write((): DecisionSupersessionOutcome => {
      const decision = this.requested(input.decisionId);
      const run = this.stores.runs.get(decision.runId!);
      if (RUN_MACHINE.isTerminal(run.status)) throw new DecisionRequestRefusedError("run_terminal", `Run ${run.id} is ${run.status}; nothing is superseded for a terminal Run`, { decisionId: decision.id, runId: run.id });
      if (decision.kind !== "operator_choice") throw new DecisionRequestRefusedError("not_supersedable", `Decision ${decision.id} is a ${decision.kind}; only a policy-resolved operator_choice is superseded`, { decisionId: decision.id, kind: decision.kind });
      if (!decision.options.some((o) => o.id === input.optionId)) throw new DecisionRequestRefusedError("option_invalid", `${input.optionId} is not an option of Decision ${decision.id}`, { decisionId: decision.id, optionId: input.optionId });
      if (decision.status === "superseded") {
        const earlier = decision.supersededByDecisionId === null ? null : this.stores.decisions.get(decision.supersededByDecisionId);
        if (earlier !== null && earlier.resolution?.chosenOptionId === input.optionId) return { kind: "superseded", decisionId: decision.id, supersedingDecisionId: earlier.id, chosenOptionId: input.optionId, replayed: true, followUp: "none" };
        throw new DecisionRequestRefusedError("conflicting_resolution", `Decision ${decision.id} was already superseded${earlier === null ? "" : ` by Decision ${earlier.id} choosing ${String(earlier.resolution?.chosenOptionId)}`}`, { decisionId: decision.id });
      }
      if (decision.status !== "resolved" || decision.resolution === null || decision.resolution.resolvedBy !== "policy:use_default_after_deadline") {
        throw new DecisionRequestRefusedError("not_policy_resolved", `Decision ${decision.id} is ${decision.status}${decision.resolution === null ? "" : ` by ${decision.resolution.resolvedBy}`}; only a Decision the runtime resolved by its default policy is superseded by the operator`, { decisionId: decision.id });
      }
      if (decision.resolution.chosenOptionId === input.optionId) throw new DecisionRequestRefusedError("option_unchanged", `Decision ${decision.id} already resolved to ${input.optionId}; a supersession chooses another option`, { decisionId: decision.id, optionId: input.optionId });
      if (decision.requestedBy.kind !== "invocation") throw new DecisionRequestRefusedError("boundary_inconsistent", `Decision ${decision.id} names no requesting Invocation`, { decisionId: decision.id });
      const rationale = input.rationale ?? null;
      const artifactIds = [...new Set(input.artifactIds ?? [])].sort();
      for (const id of artifactIds) {
        let artifact;
        try {
          artifact = this.stores.artifacts.get(id);
        } catch {
          throw new DecisionRequestRefusedError("evidence_invalid", `Artifact ${id} does not exist`, { decisionId: decision.id, artifactId: id });
        }
        if (artifact.runId !== run.id) throw new DecisionRequestRefusedError("evidence_invalid", `Artifact ${id} belongs to another Run`, { decisionId: decision.id, artifactId: id });
      }
      const meta: WriteOptions = { actor: OPERATOR_ACTOR, correlationId: options.correlationId ?? decision.id, causationSeq: options.causationSeq ?? null };
      const chained = (): WriteOptions => ({ ...meta, causationSeq: this.ctx.journal.lastSeq() });
      const superseding = this.stores.decisions.request(
        {
          conversationId: run.conversationId,
          runId: run.id,
          kind: "operator_choice",
          resolutionPolicy: "operator_required",
          requestedBy: { kind: "operator" },
          question: decision.question,
          options: decision.options,
          recommendedOptionId: null,
          rationale,
          affects: decision.affects,
          deadlineAt: null,
          activationCondition: null,
          subject: null,
          supersedesDecisionId: decision.id,
        },
        meta,
      );
      this.stores.decisions.resolve(superseding.id, { resolvedBy: "operator", chosenOptionId: input.optionId, rationale, artifactIds }, chained());
      // The follow-up goes through canonical turns only: the requester's pending continuation (prepared by the scheduler from rows,
      // carrying both resolutions), or a typed input of the Orchestrator's next turn when work already proceeded.
      const requester = this.stores.invocations.get(decision.requestedBy.invocationId);
      const followUp: DecisionSupersessionOutcome["followUp"] = this.awaitsContinuation(requester, decision.id) ? "continuation" : "queued_input";
      if (followUp === "queued_input") this.stores.orchestratorInputs.enqueue(run.id, decisionResolutionInputOf(this.stores.decisions.get(superseding.id)), chained());
      return { kind: "superseded", decisionId: decision.id, supersedingDecisionId: superseding.id, chosenOptionId: input.optionId, replayed: false, followUp };
    });
  }

  // ---------------------------------------------------------------------------
  // Deterministic default resolution (the scheduler's action)
  // ---------------------------------------------------------------------------

  /** The Run's open `use_default_after_deadline` Decisions that are due at `now`, in canonical order: deadline, then creation, then id. */
  due(runId: RunId, now: Timestamp): Decision[] {
    return this.stores.decisions
      .openDefaultPolicyOf(runId)
      .filter((d) => this.isDue(d, now))
      .sort((a, b) => (a.deadlineAt ?? "~").localeCompare(b.deadlineAt ?? "~") || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** The earliest future deadline among the Run's open default-policy Decisions, or `null`: what the scheduler projects as a resumption time. */
  nextDeadline(runId: RunId, now: Timestamp): Timestamp | null {
    let earliest: Timestamp | null = null;
    for (const decision of this.stores.decisions.openDefaultPolicyOf(runId)) {
      if (decision.deadlineAt === null || decision.deadlineAt <= now) continue;
      if (earliest === null || decision.deadlineAt < earliest) earliest = decision.deadlineAt;
    }
    return earliest;
  }

  /** Whether a default-policy Decision is due: its deadline has passed at `now`, or its activation condition holds. */
  isDue(decision: Decision, now: Timestamp): boolean {
    if (decision.status !== "open" || decision.resolutionPolicy !== "use_default_after_deadline") return false;
    if (decision.deadlineAt !== null && decision.deadlineAt <= now) return true;
    return decision.activationCondition !== null && this.activationConditionHolds(decision.activationCondition);
  }

  /** Whether a deterministic activation condition holds now, from rows: `plan_node_ready` once the node has left `pending` for `ready`. */
  activationConditionHolds(condition: ActivationCondition): boolean {
    switch (condition.kind) {
      case "plan_node_ready": {
        let node;
        try {
          node = this.stores.plans.getNode(condition.planNodeId);
        } catch (error) {
          if (error instanceof NotFoundError) return false;
          throw error;
        }
        return node.status === "ready" || node.status === "running" || node.status === "waiting" || node.status === "succeeded" || node.status === "failed";
      }
    }
  }

  /**
   * Resolves a due `use_default_after_deadline` Decision to its persisted
   * recommendation, by policy, once: the Decision, its policy, and its
   * dueness are revalidated inside the transaction, so a Decision the
   * operator resolved meanwhile (or one not yet due) changes nothing.
   */
  resolveDefault(decisionId: DecisionId, now: Timestamp, options: WriteOptions = {}): { kind: "resolved"; decisionId: DecisionId; chosenOptionId: string } | { kind: "no_change"; reason: "not_open" | "not_default_policy" | "not_due" } {
    return this.ctx.tx.write(() => {
      const decision = this.stores.decisions.get(decisionId);
      if (decision.status !== "open") return { kind: "no_change", reason: "not_open" };
      if (decision.resolutionPolicy !== "use_default_after_deadline" || decision.recommendedOptionId === null) return { kind: "no_change", reason: "not_default_policy" };
      if (!this.isDue(decision, now)) return { kind: "no_change", reason: "not_due" };
      const meta: WriteOptions = { actor: { kind: "policy", policy: "use_default_after_deadline" }, correlationId: options.correlationId ?? decision.id, causationSeq: options.causationSeq ?? null };
      this.stores.decisions.resolve(decision.id, { resolvedBy: "policy:use_default_after_deadline", chosenOptionId: decision.recommendedOptionId, rationale: null, artifactIds: [] }, meta);
      return { kind: "resolved", decisionId: decision.id, chosenOptionId: decision.recommendedOptionId };
    });
  }

  // ---------------------------------------------------------------------------
  // Continuation (rows only)
  // ---------------------------------------------------------------------------

  /**
   * The Run's blocked requesters whose requested Decision has ended
   * (resolved or superseded) and that no successor continues yet, in
   * Invocation creation order. The scheduler projects one
   * `continue_decision_request` per entry; the node's runner (or the root
   * support) prepares the successor from rows inside one transaction, so a
   * pass that dies or repeats prepares nothing twice.
   */
  pendingContinuations(runId: RunId): PendingContinuation[] {
    const invocations = this.stores.invocations.listByRun(runId);
    const continued = new Set(invocations.flatMap((i) => (i.continuedFromInvocationId === null ? [] : [i.continuedFromInvocationId])));
    const pending: PendingContinuation[] = [];
    for (const invocation of invocations) {
      if (invocation.status !== "blocked" || invocation.blockedByDecisionId === null || continued.has(invocation.id)) continue;
      const decision = this.stores.decisions.get(invocation.blockedByDecisionId);
      if (!isAgentRequestedDecision(decision) || decision.status === "open") continue;
      pending.push({ invocation, decision });
    }
    return pending;
  }

  /** Whether `invocation` still awaits its continuation: blocked on `decisionId`, the Decision ended, and no successor exists (re-read inside a transaction by the scheduler). */
  awaitsContinuation(invocation: Invocation, decisionId: DecisionId): boolean {
    if (invocation.status !== "blocked" || invocation.blockedByDecisionId !== decisionId) return false;
    const decision = this.stores.decisions.get(decisionId);
    if (!isAgentRequestedDecision(decision) || decision.status === "open") return false;
    return !this.stores.invocations.listByRun(invocation.runId).some((i) => i.continuedFromInvocationId === invocation.id);
  }

  // ---------------------------------------------------------------------------
  // Canonical facts
  // ---------------------------------------------------------------------------

  /** The agent-requested Decision, refused typed when it does not exist or was not requested through `request_decision`. */
  requested(decisionId: DecisionId): Decision {
    let decision: Decision;
    try {
      decision = this.stores.decisions.get(decisionId);
    } catch (error) {
      if (error instanceof NotFoundError) throw new DecisionRequestRefusedError("decision_not_requested", `Decision ${decisionId} does not exist`, { decisionId });
      throw error;
    }
    if (!isAgentRequestedDecision(decision) || decision.runId === null) throw new DecisionRequestRefusedError("decision_not_requested", `Decision ${decisionId} is not a Decision an Invocation requested through request_decision`, { decisionId, kind: decision.kind });
    return decision;
  }

  /**
   * Why an open waiver can no longer be applied as requested, or `null`
   * while it can: the Requirement was retired, satisfied, or otherwise left
   * a waivable state; it is no longer a current leaf; or the Conversation's
   * current revision is no longer the pinned one.
   */
  waiverStaleness(decision: Decision): WaiverStaleness | null {
    const subject = waiverSubjectOf(decision);
    const requirement = this.stores.requirements.get(subject.requirementId);
    if (requirement.status === "retired") return "requirement_retired";
    if (!REQUIREMENT_MACHINE.canTransition(requirement.status, "waived")) return "requirement_not_waivable";
    const current = this.stores.requirements.currentRevision(decision.conversationId);
    if (current === null || current.id !== subject.requirementRevisionId) return "revision_superseded";
    if (!current.tree.some((e) => e.id === requirement.id) || current.tree.some((e) => e.parentId === requirement.id)) return "requirement_not_current_leaf";
    return null;
  }

  /** An identical completed resolution replays; a conflicting one is refused; a superseded Decision reports its supersession. */
  private replay(decision: Decision, optionId: string): DecisionResolutionOutcome | null {
    if (decision.status === "open") return null;
    if (decision.status === "superseded") {
      if (decision.supersessionReason === "requirement_waiver_stale") return { kind: "superseded", decisionId: decision.id, reason: "requirement_waiver_stale", replayed: true };
      throw new DecisionRequestRefusedError("conflicting_resolution", `Decision ${decision.id} was superseded by Decision ${String(decision.supersededByDecisionId)}`, { decisionId: decision.id });
    }
    const resolution = decision.resolution!;
    if (resolution.chosenOptionId === optionId) return { kind: "resolved", decisionId: decision.id, chosenOptionId: optionId, resolvedBy: resolution.resolvedBy, replayed: true };
    throw new DecisionRequestRefusedError("conflicting_resolution", `Decision ${decision.id} is resolved to ${resolution.chosenOptionId}; ${optionId} conflicts with it`, { decisionId: decision.id, chosen: resolution.chosenOptionId, requested: optionId });
  }
}

// ---------------------------------------------------------------------------
// Scope (rows only; shared with the Orchestrator's recorded choices and Task authoring)
// ---------------------------------------------------------------------------


/**
 * The ids a caller may affect: a Worker its own Tasks, its own node, and the Requirements of its manifest; a Coordinator its node,
 * the node's Tasks, and the node's pinned scope; the Orchestrator the current graph's nodes, the Run's current Tasks, and the
 * current revision's unretired Requirements. Historical, superseded, foreign, hidden, or inaccessible ids are never in scope.
 */
export function requestScopeOf(stores: Stores, run: Run, node: PatternPlanNode, invocation: Invocation, manifest: ContextManifest): RequestScope {
  switch (invocation.role) {
    case "worker":
      return { requirementIds: new Set(manifest.content.requirements.map((r) => r.requirementId)), taskIds: new Set(invocation.taskIds), planNodeIds: new Set([node.id]) };
    case "coordinator":
      return {
        requirementIds: new Set(stores.plans.listScope(node.id).map((row) => row.requirementId)),
        taskIds: new Set(stores.tasks.listByPlanNode(node.id).map((t) => t.id)),
        planNodeIds: new Set([node.id]),
      };
    case "orchestrator": {
      const revision = stores.requirements.currentRevision(run.conversationId);
      const live = new Set(stores.requirements.listByConversation(run.conversationId).filter((r) => r.status !== "retired").map((r) => r.id));
      return {
        requirementIds: new Set((revision?.tree ?? []).map((e) => e.id).filter((id) => live.has(id))),
        taskIds: new Set(stores.tasks.listByRun(run.id).filter((t) => stores.tasks.replacementOf(t.id) === null).map((t) => t.id)),
        planNodeIds: new Set(stores.plans.currentGraph(run.id).nodes.map((n) => n.id)),
      };
    }
    case "evaluator":
      return { requirementIds: new Set(), taskIds: new Set(), planNodeIds: new Set() };
  }
}

export function scopeViolationOf(scope: RequestScope, affects: RequestedDecisionAffects): { message: string; path: string } | null {
  for (const id of affects.requirementIds) if (!scope.requirementIds.has(id)) return { message: `Requirement ${id} is outside the caller's scope`, path: "affects.requirementIds" };
  for (const id of affects.taskIds) if (!scope.taskIds.has(id)) return { message: `Task ${id} is outside the caller's scope`, path: "affects.taskIds" };
  for (const id of affects.planNodeIds) if (!scope.planNodeIds.has(id)) return { message: `PlanNode ${id} is outside the caller's scope`, path: "affects.planNodeIds" };
  return null;
}

/** The Artifacts a caller may read: those its immutable manifest lists, and those its own logical turn produced. */
export function readableArtifactIds(stores: Stores, invocation: Invocation, manifest: ContextManifest): Set<ArtifactId> {
  const ids = new Set<ArtifactId>(manifest.content.artifacts.map((a) => a.artifactId));
  for (const artifact of stores.artifacts.listByRun(invocation.runId)) {
    if (artifact.producer.kind === "invocation" && artifact.producer.invocationId === invocation.id) ids.add(artifact.id);
  }
  return ids;
}
