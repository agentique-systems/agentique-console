/**
 * The Context Manifest assembler (execution-model §6.2): resolves the
 * Invocation's authorized context by id from the canonical stores and
 * produces the one immutable manifest content. Every id is validated for
 * ownership: a foreign, missing, retired, or unauthorized object throws,
 * which fails Invocation preparation transactionally.
 *
 * Included: the Agent Definition revision (id, hash, instructions, model
 * policy); role, purpose, the typed Pattern position, continued-from; Run
 * and Plan Node ids; the Invocation's owned Tasks; the exact pinned leaf
 * Requirements of a scoped node or the current Requirements for the root
 * node, with their Acceptance Criteria; Decisions that reference those
 * Requirements, Tasks, or this node, that the Invocation's own operation
 * input names, or that were resolved since the previous Invocation's
 * manifest; the delivered Handoffs; the queued logical inputs; readable
 * Artifact metadata; the starting Snapshot and worktree; allocation,
 * funding, and limits; the effective capabilities, Tool Policy, and
 * runtime tools.
 *
 * The template applied is exactly the one operation's input (`operationInput`),
 * never the node's union of every operation: chain step `n` receives step
 * `n`'s Task, Decision, and Artifact references and nothing another step
 * named.
 *
 * Excluded by construction: any transcript, provider continuation state,
 * storage key, provider message, narrative status, routine Event, unrelated
 * object, Artifact content, or shared conversational history. The assembler
 * reads no transcript Artifact and no blob.
 */
import {
  ACTIVE_INVOCATION_STATUSES,
  canonicalJson,
  InvariantViolationError,
  NotFoundError,
  runtimeToolsFor,
  ValidationError,
  type AcceptanceCriterion,
  type AgentDefinitionRevision,
  type ArtifactId,
  type ContextManifestContent,
  type Decision,
  type DecisionId,
  type EffectiveCapabilityPolicy,
  type HandoffId,
  type Invocation,
  type ManifestAcceptanceCriterion,
  type ManifestDecision,
  type ManifestInput,
  type ManifestRequirement,
  type ManifestTemplate,
  type PatternPlanNode,
  type RequirementId,
  type RequirementRevisionId,
  type Run,
  type SnapshotId,
  type TaskId,
  approvalSubjectOf,
} from "@agentique-console/core";
import type { Stores } from "../../persistence/stores/index.ts";

export interface ManifestAssemblyRequest {
  run: Run;
  node: PatternPlanNode;
  invocation: Invocation;
  revision: AgentDefinitionRevision;
  policy: EffectiveCapabilityPolicy;
  /** Exactly the input of the operation at the Invocation's position (empty for a Gate Evaluator). */
  operationInput: ManifestTemplate;
  inputs: ManifestInput[];
  /** Handoffs the runtime delivers to this Invocation (already validated as addressed to it). */
  handoffIds: HandoffId[];
  /** Artifacts the runtime lists for this Invocation beyond the node template, Handoffs, and Task inputs. */
  artifactIds: ArtifactId[];
  startingSnapshotId: SnapshotId | null;
  worktreePath: string | null;
  maxWallClockMs: number | null;
}

const byId = <T>(key: (item: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

function unique<T extends string>(ids: Iterable<T>): T[] {
  return [...new Set(ids)];
}

export class ContextManifestAssembler {
  constructor(private readonly stores: Stores) {}

  assemble(request: ManifestAssemblyRequest): ContextManifestContent {
    const { run, node, invocation, revision } = request;
    if (node.runId !== run.id) throw new InvariantViolationError(`PlanNode ${node.id} belongs to Run ${node.runId}, not ${run.id}`);
    if (invocation.runId !== run.id || invocation.planNodeId !== node.id) throw new InvariantViolationError(`Invocation ${invocation.id} does not belong to PlanNode ${node.id} of Run ${run.id}`);
    if (invocation.agentDefinitionRevisionId !== revision.id) throw new InvariantViolationError(`Invocation ${invocation.id} runs revision ${invocation.agentDefinitionRevisionId}, not ${revision.id}`);

    const tasks = this.tasks(run, invocation);
    const { requirementRevisionId, requirements } = this.requirements(run, node, invocation);
    const previousManifestAt = this.previousManifestAt(invocation);
    const decisions = this.decisions(run, node, invocation, requirements, tasks.map((t) => t.taskId), request.operationInput, request.inputs, previousManifestAt);
    const handoffs = this.handoffs(run, node, invocation, request.handoffIds);
    const inputs = this.inputs(run, node, invocation, request.inputs, handoffs);
    const acceptanceCriteria = this.acceptanceCriteria(run, requirementRevisionId, requirements, tasks.map((t) => t.taskId), inputs);
    const approvalArtifactIds = inputs.flatMap((i) => (i.kind === "side_effect_approval_resolution" ? [i.callArtifactId] : []));
    // An optimizer round's candidate and the Evidence Artifacts of its feedback are readable by id, like every Handoff Artifact.
    const optimizerArtifactIds = inputs.flatMap((i) => (i.kind === "optimizer_candidate" ? i.artifactIds : i.kind === "optimizer_feedback" ? i.evidence.flatMap((e) => (e.kind === "artifact" ? [e.artifactId] : e.kind === "command" ? [e.outputArtifactId] : [])) : []));
    // A Gate's candidate is readable by its Evaluator; a Gate result's candidate and its remediation Task's inputs (the judged and command-output Artifacts) by whoever remediates it.
    const gateArtifactIds = inputs.flatMap((i) => (i.kind === "gate_candidate" ? i.artifactIds : i.kind === "gate_result" ? [...i.artifactIds, ...(i.remediationTaskId === null ? [] : this.stores.tasks.get(i.remediationTaskId).inputArtifactIds)] : []));
    const artifacts = this.artifacts(run, unique([...request.operationInput.artifactIds, ...handoffs.flatMap((h) => h.artifactIds), ...request.artifactIds, ...approvalArtifactIds, ...optimizerArtifactIds, ...gateArtifactIds, ...this.taskInputArtifacts(tasks.map((t) => t.taskId))]));
    for (const id of request.operationInput.taskIds) {
      if (!invocation.taskIds.includes(id)) throw new InvariantViolationError(`operation input names Task ${id}, which Invocation ${invocation.id} does not own`);
    }
    // Approved calls: exactly the approve_once resolutions among the inputs, by Decision, tool, and digest; they widen no policy.
    const approvedCalls = inputs
      .flatMap((i) => (i.kind === "side_effect_approval_resolution" && i.outcome === "approve_once" ? [{ decisionId: i.decisionId, tool: i.tool, callDigest: i.callDigest }] : []))
      .sort(byId((c) => c.callDigest));
    if (request.startingSnapshotId !== null) {
      const snapshot = this.stores.snapshots.get(request.startingSnapshotId);
      if (snapshot.workspaceId !== run.workspaceId) throw new InvariantViolationError(`Snapshot ${request.startingSnapshotId} belongs to another Workspace`);
    }

    return {
      agentDefinitionRevisionId: revision.id,
      agentDefinitionContentHash: revision.contentHash,
      instructions: revision.instructions,
      modelPolicy: revision.modelPolicy,
      role: invocation.role,
      purpose: invocation.purpose,
      patternPosition: invocation.patternPosition,
      continuedFromInvocationId: invocation.continuedFromInvocationId,
      runId: run.id,
      planNodeId: node.id,
      tasks,
      requirementRevisionId,
      requirements,
      acceptanceCriteria,
      decisions,
      inputs,
      handoffs,
      artifacts,
      startingSnapshotId: request.startingSnapshotId,
      worktreePath: request.worktreePath,
      allocation: invocation.allocation,
      allocationSource: invocation.allocationSource,
      finalReserveUse: invocation.finalReserveUse,
      maxWallClockMs: request.maxWallClockMs,
      capabilities: request.policy.capabilities,
      toolPolicy: request.policy.toolPolicy,
      // Manifest permission: the role's runtime tools narrowed by the purpose; handler availability is decided at execution.
      runtimeTools: runtimeToolsFor(invocation.role, invocation.purpose),
      approvedCalls,
    };
  }

  private tasks(run: Run, invocation: Invocation) {
    return [...invocation.taskIds].sort().map((taskId) => {
      const task = this.stores.tasks.get(taskId);
      if (task.runId !== run.id) throw new InvariantViolationError(`Task ${taskId} belongs to Run ${task.runId}, not ${run.id}`);
      if (task.planNodeId !== null && task.planNodeId !== invocation.planNodeId) throw new InvariantViolationError(`Task ${taskId} is tagged with PlanNode ${task.planNodeId}, not ${invocation.planNodeId}`);
      return { taskId, subject: task.subject };
    });
  }

  private taskInputArtifacts(taskIds: TaskId[]): ArtifactId[] {
    return taskIds.flatMap((id) => this.stores.tasks.get(id).inputArtifactIds);
  }

  /**
   * A scoped node: exactly its pinned leaf Requirements in scope order — for a Worker executing one Coordinator Task,
   * exactly that Task's Requirements (a subset of the scope); the root node: the current revision's tree in tree order.
   */
  private requirements(run: Run, node: PatternPlanNode, invocation: Invocation): { requirementRevisionId: RequirementRevisionId | null; requirements: ManifestRequirement[] } {
    let scope = this.stores.plans.listScope(node.id);
    if (invocation.patternPosition?.kind === "worker_task") {
      const owned = new Set(this.stores.tasks.get(invocation.patternPosition.taskId).requirementIds);
      scope = scope.filter((row) => owned.has(row.requirementId));
    }
    if (node.scope !== null || scope.length > 0) {
      const revisionId = node.scope?.requirementRevisionId ?? scope[0]!.requirementRevisionId;
      const revision = this.stores.requirements.getRevision(revisionId);
      if (revision.conversationId !== run.conversationId) throw new InvariantViolationError(`RequirementRevision ${revisionId} belongs to another Conversation`);
      const requirements = scope.map((row) => {
        if (row.requirementRevisionId !== revisionId) throw new InvariantViolationError(`PlanNode ${node.id} scope pins two Requirement revisions`);
        const entry = revision.tree.find((e) => e.id === row.requirementId);
        if (!entry) throw new NotFoundError("Requirement at pinned revision", row.requirementId);
        return this.requirement(run, entry.id, entry.statement, entry.acceptanceCriterionIds, true);
      });
      return { requirementRevisionId: revisionId, requirements };
    }
    const current = this.stores.requirements.currentRevision(run.conversationId);
    if (!current) return { requirementRevisionId: null, requirements: [] };
    return {
      requirementRevisionId: current.id,
      requirements: [...current.tree]
        .sort((a, b) => a.position - b.position)
        .map((entry) => this.requirement(run, entry.id, entry.statement, entry.acceptanceCriterionIds, false)),
    };
  }

  private requirement(run: Run, id: RequirementId, statement: string, acceptanceCriterionIds: ManifestRequirement["acceptanceCriterionIds"], pinned: boolean): ManifestRequirement {
    const requirement = this.stores.requirements.get(id);
    if (requirement.conversationId !== run.conversationId) throw new InvariantViolationError(`Requirement ${id} belongs to another Conversation`);
    if (pinned && requirement.status === "retired") throw new ValidationError(`Requirement ${id} is retired and cannot be worked against`, { requirementId: id });
    return { requirementId: id, statement, status: requirement.status, acceptanceCriterionIds: [...acceptanceCriterionIds].sort() };
  }

  private acceptanceCriteria(run: Run, revisionId: RequirementRevisionId | null, requirements: ManifestRequirement[], taskIds: TaskId[], inputs: ManifestInput[]): ManifestAcceptanceCriterion[] {
    const criteria: AcceptanceCriterion[] = [];
    for (const requirement of requirements) {
      for (const criterion of this.stores.requirements.listAcceptanceCriteria({ requirementId: requirement.requirementId })) {
        if (criterion.requirementRevisionId === revisionId || requirement.acceptanceCriterionIds.includes(criterion.id)) criteria.push(criterion);
      }
    }
    for (const taskId of taskIds) criteria.push(...this.stores.requirements.listAcceptanceCriteria({ taskId }));
    // An optimizer round's or a Gate's Evaluator receives exactly the evaluated criteria it must judge, whatever the node's scope lists.
    for (const input of inputs) {
      if (input.kind === "optimizer_candidate" || input.kind === "gate_candidate") for (const id of input.acceptanceCriterionIds) criteria.push(this.stores.requirements.getAcceptanceCriterion(id));
    }
    for (const criterion of criteria) {
      if (criterion.conversationId !== run.conversationId) throw new InvariantViolationError(`AcceptanceCriterion ${criterion.id} belongs to another Conversation`);
    }
    const seen = new Set<string>();
    return criteria
      .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
      .map((c) => ({ acceptanceCriterionId: c.id, requirementId: c.requirementId, taskId: c.taskId, check: c.check }))
      .sort(byId((c) => c.acceptanceCriterionId));
  }

  private previousManifestAt(invocation: Invocation): string | null {
    if (invocation.continuedFromInvocationId === null) return null;
    try {
      return this.stores.invocations.getManifest(invocation.continuedFromInvocationId).createdAt;
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  /** Relevant Decisions only: the operation's, those affecting included Requirements, Tasks, or this node, those the inputs name, and those resolved since the previous manifest. */
  private decisions(run: Run, node: PatternPlanNode, invocation: Invocation, requirements: ManifestRequirement[], taskIds: TaskId[], operationInput: ManifestTemplate, inputs: ManifestInput[], previousManifestAt: string | null): ManifestDecision[] {
    const requirementIds = new Set(requirements.map((r) => r.requirementId));
    const taskSet = new Set<string>(taskIds);
    const named = new Set<DecisionId>([...operationInput.decisionIds, ...inputs.flatMap((i) => (i.kind === "decision_resolution" ? [i.decisionId] : []))]);
    const all = this.stores.decisions.listByConversation(run.conversationId);
    const byIdMap = new Map(all.map((d) => [d.id, d] as const));
    for (const id of named) {
      const decision = byIdMap.get(id) ?? this.stores.decisions.get(id);
      if (decision.conversationId !== run.conversationId) throw new InvariantViolationError(`Decision ${id} belongs to another Conversation`);
    }
    const relevant = (d: Decision): boolean =>
      named.has(d.id) ||
      d.affects.requirementIds.some((id) => requirementIds.has(id)) ||
      d.affects.taskIds.some((id) => taskSet.has(id)) ||
      d.affects.planNodeIds.includes(node.id) ||
      (previousManifestAt !== null && d.resolution !== null && d.resolution.resolvedAt > previousManifestAt && (d.runId === run.id || d.runId === null));
    return all
      .filter(relevant)
      .map((d) => ({
        decisionId: d.id,
        kind: d.kind,
        chosenOptionId: d.resolution?.chosenOptionId ?? null,
        resolvedSincePrevious: previousManifestAt !== null && d.resolution !== null && d.resolution.resolvedAt > previousManifestAt,
      }))
      .sort(byId((d) => d.decisionId));
  }

  private inputs(run: Run, node: PatternPlanNode, invocation: Invocation, inputs: ManifestInput[], delivered: { handoffId: HandoffId; artifactIds: ArtifactId[] }[]): ManifestInput[] {
    const handoffs = delivered.map((h) => ({ ...h, handoffKey: this.stores.handoffs.get(h.handoffId).handoffKey }));
    const digests = new Set<string>();
    for (const input of inputs) {
      switch (input.kind) {
        case "optimizer_candidate": {
          // The runtime supplies what the Evaluator judges: this round of this evaluator_optimizer node, a Snapshot of the
          // Run's Workspace, Artifacts of the Run, and exactly the node's evaluated Gate criteria.
          const shape = node.shape.pattern === "evaluator_optimizer" ? node.shape : null;
          if (shape === null) throw new InvariantViolationError(`PlanNode ${node.id} is not an evaluator_optimizer node`);
          const position = invocation.patternPosition;
          if (invocation.role !== "evaluator" || invocation.purpose !== "evaluate" || position === null || position.kind !== "evaluator_round") throw new InvariantViolationError(`Invocation ${invocation.id} is not an optimizer round Evaluator`);
          if (position.round !== input.round || position.maxRounds !== input.maxRounds || shape.maxRounds !== input.maxRounds) throw new InvariantViolationError(`optimizer_candidate input names round ${input.round} of ${input.maxRounds}, not the Invocation's ${position.round} of ${position.maxRounds}`);
          if (shape.round !== null && shape.round !== input.round) throw new InvariantViolationError(`PlanNode ${node.id} evaluates round ${shape.round}, not ${input.round}`);
          const snapshot = this.stores.snapshots.get(input.snapshotId);
          if (snapshot.workspaceId !== run.workspaceId) throw new InvariantViolationError(`Snapshot ${input.snapshotId} belongs to another Workspace`);
          for (const id of input.artifactIds) this.artifact(run, id);
          const evaluated = node.gateAcceptanceCriterionIds.filter((id) => this.stores.requirements.getAcceptanceCriterion(id).check.kind === "evaluated").sort();
          if (evaluated.length !== input.acceptanceCriterionIds.length || evaluated.some((id, i) => id !== input.acceptanceCriterionIds[i])) {
            throw new InvariantViolationError(`optimizer_candidate input names criteria ${input.acceptanceCriterionIds.join(", ")}, not the node's evaluated Gate criteria ${evaluated.join(", ")}`);
          }
          for (const id of input.acceptanceCriterionIds) {
            if (this.stores.requirements.getAcceptanceCriterion(id).conversationId !== run.conversationId) throw new InvariantViolationError(`AcceptanceCriterion ${id} belongs to another Conversation`);
          }
          // The delivered Handoffs (a prior round's feedback aside) carry exactly the candidate: the inline round's candidate
          // Handoff, or the producer subgraph's edge Handoffs.
          const carried = [...new Set(handoffs.filter((h) => !h.handoffKey.startsWith("optimizer_feedback:")).flatMap((h) => h.artifactIds))].sort();
          const expected = [...input.artifactIds].sort();
          if (carried.length !== expected.length || carried.some((id, i) => id !== expected[i])) throw new InvariantViolationError(`the delivered Handoffs carry Artifacts ${carried.join(", ")}, not the candidate ${expected.join(", ")}`);
          break;
        }
        case "optimizer_feedback": {
          // The canonical round verdict this producer round follows: of this Run, a failed or inconclusive optimizer_verdict of the
          // round before this one, on this inline node (producer_round or evaluator_round r + 1) or on the evaluate-only node whose
          // retry(r + 1) edge enters this node in the current revision; its judged Artifacts are exactly what the Handoff carries.
          const evaluation = this.stores.evaluations.get(input.evaluationId);
          if (evaluation.runId !== run.id) throw new InvariantViolationError(`Evaluation ${input.evaluationId} belongs to another Run`);
          if (evaluation.context === null || evaluation.context.kind !== "optimizer_verdict") throw new ValidationError(`Evaluation ${input.evaluationId} is not an optimizer round verdict`);
          if (evaluation.context.round !== input.round) throw new InvariantViolationError(`Evaluation ${input.evaluationId} judged round ${evaluation.context.round}, not ${input.round}`);
          if (evaluation.verdict !== input.verdict) throw new InvariantViolationError(`Evaluation ${input.evaluationId} recorded ${evaluation.verdict}, not ${input.verdict}`);
          if (canonicalJson(evaluation.evidence) !== canonicalJson(input.evidence)) throw new InvariantViolationError(`optimizer_feedback input disagrees with the Evidence of Evaluation ${input.evaluationId}`);
          const judged = [...evaluation.artifactIds].sort();
          let carried: ArtifactId[];
          if (evaluation.planNodeId === node.id) {
            const position = invocation.patternPosition;
            if (position === null || (position.kind !== "producer_round" && position.kind !== "evaluator_round") || position.round !== input.round + 1) {
              throw new InvariantViolationError(`Invocation ${invocation.id} does not follow round ${input.round} of PlanNode ${node.id}`);
            }
            const handoff = this.stores.handoffs.getByKey(run.id, `optimizer_feedback:${node.id}:${input.round}`);
            if (handoff === null || !handoffs.some((h) => h.handoffId === handoff.id)) throw new InvariantViolationError(`the feedback Handoff of round ${input.round} of PlanNode ${node.id} is not delivered to Invocation ${invocation.id}`);
            carried = [...handoff.artifactIds].sort();
          } else {
            const sourceId = evaluation.planNodeId;
            if (sourceId === null) throw new InvariantViolationError(`Evaluation ${input.evaluationId} belongs to no Plan Node`);
            const graph = this.stores.plans.currentGraph(run.id);
            const edge = graph.edges.find((e) => e.type === "retry" && e.sourceNodeId === sourceId && e.targetNodeId === node.id && e.round === input.round + 1);
            if (edge === undefined) throw new InvariantViolationError(`no current retry(${input.round + 1}) edge runs from PlanNode ${sourceId} to ${node.id}`);
            const handoff = this.stores.handoffs.getByKey(run.id, `retry:${sourceId}:${node.id}`);
            if (handoff === null || !handoffs.some((h) => h.handoffId === handoff.id)) throw new InvariantViolationError(`the retry Handoff from PlanNode ${sourceId} is not delivered to Invocation ${invocation.id}`);
            carried = [...handoff.artifactIds].sort();
          }
          if (carried.length !== judged.length || carried.some((id, i) => id !== judged[i])) throw new InvariantViolationError(`the Handoff carries Artifacts ${carried.join(", ")}, not the judged ${judged.join(", ")} of Evaluation ${input.evaluationId}`);
          break;
        }
        case "side_effect_approval_resolution": {
          // The resolved Decision is the successor's typed input; every fact must agree with the canonical Decision.
          const decision = this.stores.decisions.get(input.decisionId);
          if (decision.conversationId !== run.conversationId || decision.runId !== run.id) throw new InvariantViolationError(`Decision ${input.decisionId} belongs to another Run`);
          if (decision.kind !== "side_effect_approval" || decision.subject === null) throw new ValidationError(`Decision ${input.decisionId} is not a side_effect_approval`);
          if (decision.status !== "resolved" || decision.resolution === null) throw new ValidationError(`Decision ${input.decisionId} is ${decision.status}; a successor is created after resolution`);
          if (decision.resolution.chosenOptionId !== input.outcome) throw new InvariantViolationError(`Decision ${input.decisionId} resolved ${decision.resolution.chosenOptionId}, not ${input.outcome}`);
          // A consumed grant is never delivered again: the canonical use, not the manifest, says whether the approval remains claimable.
          const use = input.outcome === "approve_once" ? this.stores.approvedToolCallUses.getByDecision(decision.id) : null;
          if (use !== null) throw new ValidationError(`Decision ${input.decisionId} was already used by Attempt ${use.attemptId}; executing the call again needs a new approval`, { useId: use.id });
          const s = approvalSubjectOf(decision);
          if (s.invocationId !== input.blockedInvocationId || s.attemptId !== input.attemptId || s.tool !== input.tool || s.callDigest !== input.callDigest || s.callArtifactId !== input.callArtifactId) {
            throw new InvariantViolationError(`input disagrees with the subject of Decision ${input.decisionId}`);
          }
          if (invocation.continuedFromInvocationId !== input.blockedInvocationId) throw new InvariantViolationError(`Invocation ${invocation.id} does not continue from blocked Invocation ${input.blockedInvocationId}`);
          if (digests.has(input.callDigest)) throw new ValidationError(`approval resolution for call ${input.callDigest} appears twice`);
          digests.add(input.callDigest);
          break;
        }
        case "operator_message": {
          const message = this.stores.conversations.getMessage(input.conversationMessageId);
          if (message.conversationId !== run.conversationId) throw new InvariantViolationError(`ConversationMessage ${input.conversationMessageId} belongs to another Conversation`);
          if (message.runId !== null && message.runId !== run.id) throw new InvariantViolationError(`ConversationMessage ${input.conversationMessageId} was posted in another Run`);
          if (message.author !== "operator") throw new ValidationError(`ConversationMessage ${input.conversationMessageId} is not an operator message`);
          if (message.content !== input.content) throw new InvariantViolationError(`operator message ${input.conversationMessageId} content differs from the canonical message`);
          break;
        }
        case "node_result": {
          const resultNode = this.stores.plans.getNode(input.planNodeId);
          if (resultNode.runId !== run.id) throw new InvariantViolationError(`PlanNode ${input.planNodeId} belongs to another Run`);
          for (const id of input.outputArtifactIds) this.artifact(run, id);
          break;
        }
        case "decision_resolution": {
          const decision = this.stores.decisions.get(input.decisionId);
          if (decision.conversationId !== run.conversationId) throw new InvariantViolationError(`Decision ${input.decisionId} belongs to another Conversation`);
          break;
        }
        case "gate_result": {
          // The closed Gate's canonical facts, restated exactly (execution-model §10): its kind, node, cycle, verdict, pinned Snapshot and
          // candidate, failed criteria, every Evaluation, and its one remediation Task; delivered to the root Orchestrator or to the
          // Coordinator turn of the gated node, never to anyone else.
          const gate = this.stores.gates.get(input.gateId);
          if (gate.runId !== run.id) throw new InvariantViolationError(`Gate ${input.gateId} belongs to another Run`);
          if (gate.status === "open") throw new ValidationError(`Gate ${input.gateId} is open; a gate_result carries a closed Gate`, { gateId: gate.id });
          if (!(invocation.role === "orchestrator" || (invocation.role === "coordinator" && gate.planNodeId === node.id))) throw new InvariantViolationError(`Invocation ${invocation.id} does not remediate Gate ${gate.id}`);
          const failed = gate.failure?.kind === "criteria_failed" ? [...gate.failure.acceptanceCriterionIds].sort() : [];
          const evaluationIds = this.stores.evaluations.listByGate(gate.id).map((e) => e.id).sort();
          const task = this.stores.tasks.remediationTaskOf(gate.id);
          const facts = { gateKind: gate.kind, planNodeId: gate.planNodeId, ordinal: gate.ordinal, passed: gate.status === "passed", snapshotId: gate.snapshotId, artifactIds: [...gate.candidateArtifactIds].sort(), failedAcceptanceCriterionIds: failed, evaluationIds, remediationTaskId: task?.id ?? null };
          const given = { gateKind: input.gateKind, planNodeId: input.planNodeId, ordinal: input.ordinal, passed: input.passed, snapshotId: input.snapshotId, artifactIds: [...input.artifactIds].sort(), failedAcceptanceCriterionIds: [...input.failedAcceptanceCriterionIds].sort(), evaluationIds: [...input.evaluationIds].sort(), remediationTaskId: input.remediationTaskId };
          if (canonicalJson(facts) !== canonicalJson(given)) throw new InvariantViolationError(`gate_result input disagrees with the canonical facts of Gate ${gate.id}`, { gateId: gate.id });
          break;
        }
        case "gate_candidate": {
          // The runtime supplies what a Gate Evaluator judges: its own open Gate, the Gate's pinned Snapshot and candidate, and exactly the
          // Gate's evaluated criteria.
          if (invocation.role !== "evaluator" || invocation.purpose !== "evaluate" || invocation.patternPosition !== null || invocation.gateId !== input.gateId) throw new InvariantViolationError(`Invocation ${invocation.id} is not the Evaluator of Gate ${input.gateId}`);
          const gate = this.stores.gates.get(input.gateId);
          if (gate.runId !== run.id) throw new InvariantViolationError(`Gate ${input.gateId} belongs to another Run`);
          if (gate.status !== "open") throw new ValidationError(`Gate ${input.gateId} is ${gate.status}; an Evaluator judges an open Gate`, { gateId: gate.id });
          if (gate.kind !== input.gateKind) throw new InvariantViolationError(`Gate ${gate.id} is a ${gate.kind} Gate, not ${input.gateKind}`);
          if (gate.planNodeId !== null && gate.planNodeId !== node.id) throw new InvariantViolationError(`Gate ${gate.id} belongs to PlanNode ${gate.planNodeId}, not ${node.id}`);
          if (gate.snapshotId !== input.snapshotId) throw new InvariantViolationError(`Gate ${gate.id} pinned Snapshot ${String(gate.snapshotId)}, not ${input.snapshotId}`);
          const pinned = [...gate.candidateArtifactIds].sort();
          const given = [...input.artifactIds].sort();
          if (pinned.length !== given.length || pinned.some((id, i) => id !== given[i])) throw new InvariantViolationError(`Gate ${gate.id} judges candidate ${pinned.join(", ")}, not ${given.join(", ")}`);
          for (const id of input.artifactIds) this.artifact(run, id);
          const evaluated = gate.acceptanceCriterionIds.filter((id) => this.stores.requirements.getAcceptanceCriterion(id).check.kind === "evaluated").sort();
          if (evaluated.length !== input.acceptanceCriterionIds.length || evaluated.some((id, i) => id !== input.acceptanceCriterionIds[i])) {
            throw new InvariantViolationError(`gate_candidate input names criteria ${input.acceptanceCriterionIds.join(", ")}, not the Gate's evaluated criteria ${evaluated.join(", ")}`);
          }
          for (const id of input.acceptanceCriterionIds) {
            if (this.stores.requirements.getAcceptanceCriterion(id).conversationId !== run.conversationId) throw new InvariantViolationError(`AcceptanceCriterion ${id} belongs to another Conversation`);
          }
          break;
        }
        case "publication_result": {
          const publication = this.stores.publications.get(input.publicationId);
          if (publication.runId !== run.id) throw new InvariantViolationError(`Publication ${input.publicationId} belongs to another Run`);
          break;
        }
        case "route_selection": {
          // The canonical selection fact of this node: it exists, belongs to this route node, and names exactly this label.
          const evaluation = this.stores.evaluations.get(input.evaluationId);
          if (evaluation.runId !== run.id) throw new InvariantViolationError(`Evaluation ${input.evaluationId} belongs to another Run`);
          if (evaluation.planNodeId !== invocation.planNodeId) throw new InvariantViolationError(`Evaluation ${input.evaluationId} belongs to PlanNode ${String(evaluation.planNodeId)}, not ${invocation.planNodeId}`);
          if (evaluation.subject.kind !== "route_selection") throw new ValidationError(`Evaluation ${input.evaluationId} is not a route selection`);
          if (evaluation.subject.selectedLabel !== input.selectedLabel) throw new InvariantViolationError(`Evaluation ${input.evaluationId} selected ${evaluation.subject.selectedLabel}, not ${input.selectedLabel}`);
          if (invocation.patternPosition?.kind !== "route_branch" || invocation.patternPosition.label !== input.selectedLabel) throw new InvariantViolationError(`Invocation ${invocation.id} does not execute route branch ${input.selectedLabel}`);
          break;
        }
        case "coordinator_turn": {
          // The ledger names only Tasks of this coordinator_worker node, for a Coordinator turn of matching purpose.
          if (invocation.role !== "coordinator" || invocation.purpose !== input.purpose) throw new InvariantViolationError(`Invocation ${invocation.id} is not a ${input.purpose} Coordinator turn`);
          if (node.shape.pattern !== "coordinator_worker") throw new InvariantViolationError(`PlanNode ${node.id} is not a coordinator_worker node`);
          for (const entry of input.tasks) {
            const task = this.stores.tasks.get(entry.taskId);
            if (task.runId !== run.id || task.planNodeId !== node.id) throw new InvariantViolationError(`Task ${entry.taskId} does not belong to PlanNode ${node.id}`);
          }
          break;
        }
        case "coordinator_blocker": {
          if (invocation.role !== "coordinator") throw new InvariantViolationError(`Invocation ${invocation.id} is not a Coordinator turn`);
          const task = this.stores.tasks.get(input.blocker.taskId);
          if (task.runId !== run.id || task.planNodeId !== node.id) throw new InvariantViolationError(`Task ${input.blocker.taskId} does not belong to PlanNode ${node.id}`);
          if (input.blocker.kind === "integration_conflict") {
            const changeset = this.stores.changesets.get(input.blocker.changesetId);
            if (changeset.runId !== run.id) throw new InvariantViolationError(`Changeset ${input.blocker.changesetId} belongs to another Run`);
          }
          break;
        }
        case "plan_revision":
          break;
      }
    }
    return inputs;
  }

  private handoffs(run: Run, node: PatternPlanNode, invocation: Invocation, handoffIds: HandoffId[]) {
    return unique(handoffIds)
      .map((id) => {
        const handoff = this.stores.handoffs.get(id);
        if (handoff.runId !== run.id) throw new InvariantViolationError(`Handoff ${id} belongs to another Run`);
        const addressed = handoff.target.kind === "plan_node" ? handoff.target.planNodeId === node.id : handoff.target.invocationId === invocation.id;
        if (!addressed) throw new InvariantViolationError(`Handoff ${id} is not addressed to PlanNode ${node.id} or Invocation ${invocation.id}`);
        if (handoff.status === "cancelled") throw new ValidationError(`Handoff ${id} is cancelled`, { handoffId: id });
        return { handoffId: handoff.id, source: handoff.source, taskIds: [...handoff.taskIds].sort(), artifactIds: [...handoff.artifactIds].sort(), summary: handoff.summary };
      })
      .sort(byId((h) => h.handoffId));
  }

  private artifact(run: Run, id: ArtifactId) {
    const artifact = this.stores.artifacts.get(id);
    if (artifact.runId !== run.id) throw new InvariantViolationError(`Artifact ${id} belongs to Run ${artifact.runId}, not ${run.id}`);
    return artifact;
  }

  private artifacts(run: Run, ids: ArtifactId[]) {
    return ids
      .map((id) => this.artifact(run, id))
      .map((a) => ({ artifactId: a.id, mediaType: a.mediaType, byteSize: a.byteSize, title: a.title }))
      .sort(byId((a) => a.artifactId));
  }
}

/** Whether an Invocation currently holds its node's turn (non-terminal). */
export function isActiveInvocation(invocation: Pick<Invocation, "status">): boolean {
  return (ACTIVE_INVOCATION_STATUSES as readonly string[]).includes(invocation.status);
}
