/**
 * Completion Requests (execution-model §10 `run_completion`): the canonical
 * facts a completion attempt is built from and the `request_completion`
 * runtime-tool handler that creates one.
 *
 * `CompletionFacts` reads rows only. It derives, for a Run: the pinned
 * Requirement revision and its leaf Requirements; the completion criterion
 * set — the canonical union of the Run's declared
 * `runCompletionAcceptanceCriterionIds` (whose owning Requirement is not
 * retired and whose owning Task is not superseded) and the Acceptance
 * Criteria of every current leaf Requirement of the pinned revision that is
 * neither `waived` nor `retired`, deduplicated and ordered by id; the
 * deterministic, bounded candidate Artifact set (succeeded current node
 * outputs, completed current Task outputs, node-Gate Evaluation Evidence,
 * conflict-resolution outputs; never a transcript); the current Task ledger;
 * the unresolved operator-required Decisions; the minimum final-reserve
 * allocation the remaining completion work needs; and the closed preflight
 * codes that refuse a `request_completion` call or cancel a request whose
 * Run drifted. Nothing here reads a transcript, an Event, or process memory.
 *
 * `CompletionRequestService.request` is the handler behind the runtime-tool
 * port: callable only by the root Orchestrator's running turn (never from
 * its read-only `final_synthesis` turn, never by any other role or node),
 * it refuses transactionally with a closed code and writes nothing when the
 * preflight fails, and otherwise creates the one Completion Request the
 * accepted call names, so a replay of the call returns the same request.
 */
import {
  addAllocation,
  allocationFits,
  operationAt,
  ROOT_SOURCE_PATH,
  TASK_MACHINE,
  TRANSCRIPT_MEDIA_TYPE,
  ZERO_ALLOCATION,
  type AcceptanceCriterion,
  type AcceptanceCriterionId,
  type Allocation,
  type ArtifactId,
  type CompletionPreflightCode,
  type Decision,
  type InvocationId,
  type PatternPlanNode,
  type RequirementId,
  type RequirementRevision,
  type RequirementTreeEntry,
  type Run,
  type RuntimeToolRejection,
  type SnapshotId,
  type Task,
  type TaskLedgerEntry,
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import type { HandlerOutcome, RuntimeToolCaller } from "./task-proposals.ts";

/** The Run's completion criteria by kind, in canonical id order. */
export interface CompletionCriteria {
  deterministic: AcceptanceCriterion[];
  evaluated: AcceptanceCriterionId[];
  all: AcceptanceCriterionId[];
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class CompletionFacts {
  constructor(private readonly stores: Stores) {}

  root(run: Pick<Run, "id">): PatternPlanNode {
    const root = this.stores.plans.rootNode(run.id);
    if (root.kind !== "pattern" || root.sourcePath !== ROOT_SOURCE_PATH) throw new Error(`Run ${run.id} has no root Orchestrator node`);
    return root;
  }

  /** The Requirement revision a completion attempt pins: the Conversation's current one. */
  pinnedRevision(run: Pick<Run, "conversationId">): RequirementRevision | null {
    return this.stores.requirements.currentRevision(run.conversationId);
  }

  /** The leaf entries of a revision's tree, in canonical id order. */
  leafEntries(revision: RequirementRevision): RequirementTreeEntry[] {
    const parents = new Set(revision.tree.map((e) => e.parentId).filter((id) => id !== null));
    return revision.tree.filter((e) => !parents.has(e.id)).sort(byId);
  }

  /** The exact current leaf Requirement ids of the pinned revision, in canonical id order. */
  leafIds(revision: RequirementRevision | null): RequirementId[] {
    return revision === null ? [] : this.leafEntries(revision).map((e) => e.id);
  }

  /** The Acceptance Criteria of one leaf at the pinned revision: those the tree entry lists and those pinned to the revision. */
  leafCriteria(revision: RequirementRevision, entry: RequirementTreeEntry): AcceptanceCriterion[] {
    const listed = new Set(entry.acceptanceCriterionIds);
    return this.stores.requirements
      .listAcceptanceCriteria({ requirementId: entry.id })
      .filter((c) => c.requirementRevisionId === revision.id || listed.has(c.id))
      .sort(byId);
  }

  /**
   * The completion criterion set: the canonical union of the Run's declared
   * criteria and every live leaf's criteria at the pinned revision,
   * deduplicated and in id order; never a historical revision's, a retired
   * Requirement's, a superseded Task's, or another Conversation's criterion.
   */
  criteriaOf(run: Run, revision: RequirementRevision | null): CompletionCriteria {
    const ids = new Set<AcceptanceCriterionId>();
    for (const id of run.verificationPolicy.runCompletionAcceptanceCriterionIds) {
      const criterion = this.stores.requirements.getAcceptanceCriterion(id);
      if (criterion.conversationId !== run.conversationId) continue;
      if (criterion.requirementId !== null && this.stores.requirements.get(criterion.requirementId).status === "retired") continue;
      if (criterion.taskId !== null && this.stores.tasks.replacementOf(criterion.taskId) !== null) continue;
      ids.add(id);
    }
    if (revision !== null) {
      for (const entry of this.leafEntries(revision)) {
        const status = this.stores.requirements.get(entry.id).status;
        if (status === "waived" || status === "retired") continue;
        for (const criterion of this.leafCriteria(revision, entry)) ids.add(criterion.id);
      }
    }
    const criteria = [...ids].sort().map((id) => this.stores.requirements.getAcceptanceCriterion(id));
    return { deterministic: criteria.filter((c) => c.check.kind === "deterministic"), evaluated: criteria.filter((c) => c.check.kind === "evaluated").map((c) => c.id), all: criteria.map((c) => c.id) };
  }

  /** The Run's current integration Snapshot (its base Snapshot before the first integration), or `null`. */
  integrationSnapshotId(run: Run): SnapshotId | null {
    return run.integrationSnapshotId ?? run.baseSnapshotId;
  }

  /** Every current Task of the Run (no replacement supersedes it), in creation order. */
  currentTasks(run: Pick<Run, "id">): Task[] {
    return this.stores.tasks.listByRun(run.id).filter((t) => this.stores.tasks.replacementOf(t.id) === null);
  }

  /** The canonical current Task ledger, ordered by Task id. */
  taskLedger(run: Pick<Run, "id">): TaskLedgerEntry[] {
    return this.currentTasks(run)
      .map((t) => ({ taskId: t.id, subject: t.subject, status: t.status, replacesTaskId: t.replacesTaskId, supersededByTaskId: null, outputArtifactIds: [...t.outputArtifactIds].sort() }))
      .sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
  }

  /** Unresolved operator-required Decisions of the Run or of its Conversation as a whole, in creation order. */
  openOperatorDecisions(run: Pick<Run, "id" | "conversationId">): Decision[] {
    return this.stores.decisions.listOpen(run.conversationId).filter((d) => d.resolutionPolicy === "operator_required" && (d.runId === run.id || d.runId === null));
  }

  /**
   * The deterministic, bounded candidate Artifact set of a completion cycle:
   * the outputs of every succeeded current non-root node, the outputs of
   * every completed current Task, and the Evidence Artifacts of every
   * `node_exit` Gate Evaluation of the Run, ordered by id; transcripts are
   * never candidates.
   */
  candidateArtifactIds(run: Run): ArtifactId[] {
    const ids = new Set<ArtifactId>();
    const graph = this.stores.plans.currentGraph(run.id);
    for (const node of graph.nodes) {
      if (node.sourcePath === ROOT_SOURCE_PATH || node.status !== "succeeded") continue;
      for (const id of node.outputArtifactIds ?? []) ids.add(id);
    }
    for (const task of this.currentTasks(run)) {
      if (task.status !== "completed") continue;
      for (const id of task.outputArtifactIds) ids.add(id);
    }
    for (const gate of this.stores.gates.listByKind(run.id, "node_exit")) {
      for (const evaluation of this.stores.evaluations.listByGate(gate.id)) {
        for (const evidence of evaluation.evidence) {
          if (evidence.kind === "artifact") ids.add(evidence.artifactId);
          if (evidence.kind === "command") ids.add(evidence.outputArtifactId);
        }
      }
    }
    return [...ids].filter((id) => this.stores.artifacts.get(id).mediaType !== TRANSCRIPT_MEDIA_TYPE).sort();
  }

  /** The least final-reserve allocation the remaining completion work needs: the Gate Evaluator (when evaluated criteria exist) plus the final synthesis. */
  requiredFinalAllocation(run: Run, criteria: CompletionCriteria): Allocation {
    const root = this.root(run);
    const operation = operationAt(root.shape, { kind: "orchestrator" });
    if (operation === null) throw new Error(`root PlanNode ${root.id} has no orchestrator position`);
    const synthesis = this.stores.agents.getRevision(operation.agentDefinitionRevisionId).defaultLimits.allocation;
    const evaluatorId = run.verificationPolicy.evaluatorAgentDefinitionRevisionId;
    const evaluator = criteria.evaluated.length > 0 && evaluatorId !== null ? this.stores.agents.getRevision(evaluatorId).defaultLimits.allocation : ZERO_ALLOCATION;
    return addAllocation(synthesis, evaluator);
  }

  /** Whether the Run's final reserve admits `allocation` now; ordinary capacity is never consulted. */
  finalReserveFits(run: Pick<Run, "id">, allocation: Allocation): boolean {
    return allocationFits(allocation, this.stores.reservations.runCapacity(run.id).final.effectiveAvailable);
  }

  /**
   * The closed reasons completion cannot begin now, from rows alone, in a
   * fixed order; empty when every precondition holds. `requestingInvocationId`
   * is the root turn that requests (or requested) completion: the one active
   * Invocation the Run may hold.
   */
  preflight(run: Run, requestingInvocationId: InvocationId | null): CompletionPreflightCode[] {
    const codes: CompletionPreflightCode[] = [];
    if (run.status !== "running") codes.push("run_not_running");
    const active = this.stores.completionRequests.activeOf(run.id);
    if (active !== null && active.invocationId !== requestingInvocationId) codes.push("completion_request_active");
    if (this.stores.gates.listByKind(run.id, "run_completion").length >= run.verificationPolicy.maxRunCompletionCycles) codes.push("run_completion_cycles_exhausted");
    const graph = this.stores.plans.currentGraph(run.id);
    let nodeActive = false;
    let nodeFailed = false;
    for (const node of graph.nodes) {
      if (node.sourcePath === ROOT_SOURCE_PATH) continue;
      if (node.status === "pending" || node.status === "ready" || node.status === "running" || node.status === "waiting") nodeActive = true;
      if (node.status === "failed") nodeFailed = true;
    }
    if (nodeActive) codes.push("node_active");
    if (nodeFailed) codes.push("node_failed");
    if (this.stores.changesets.listByRun(run.id).some((c) => c.integrationStatus !== "integrated")) codes.push("changeset_unintegrated");
    if (this.stores.gates.listByKind(run.id, "node_exit").some((g) => g.status === "open")) codes.push("gate_open");
    if (this.stores.tasks.listRemediationTasks(run.id).some((t) => !TASK_MACHINE.isTerminal(t.status) && this.stores.gates.get(t.gateId!).kind === "node_exit")) codes.push("gate_remediation_unresolved");
    if (this.stores.invocations.listActive(run.id).some((i) => i.id !== requestingInvocationId)) codes.push("invocation_active");
    if (this.currentTasks(run).some((t) => t.status !== "completed" && t.status !== "cancelled")) codes.push("task_unfinished");
    if (this.openOperatorDecisions(run).length > 0) codes.push("decision_unresolved");
    if (this.integrationSnapshotId(run) === null) codes.push("no_integration_snapshot");
    const criteria = this.criteriaOf(run, this.pinnedRevision(run));
    if (run.kind === "code" && criteria.deterministic.length === 0) codes.push("no_deterministic_completion_criterion");
    if (criteria.evaluated.length > 0 && run.verificationPolicy.evaluatorAgentDefinitionRevisionId === null) codes.push("evaluator_unavailable");
    if (!this.finalReserveFits(run, this.requiredFinalAllocation(run, criteria))) codes.push("final_reserve_insufficient");
    return codes;
  }
}

const PREFLIGHT_MESSAGES: Readonly<Record<CompletionPreflightCode, string>> = {
  completion_request_active: "another Completion Request of the Run is active",
  run_not_running: "the Run is not running",
  node_active: "a current Plan Node is still pending, ready, running, or waiting",
  node_failed: "a current Plan Node failed without a canonical resolution",
  changeset_unintegrated: "a Changeset is still pending or in conflict",
  gate_open: "a node_exit Gate is open",
  gate_remediation_unresolved: "a node_exit Gate remediation is unresolved",
  invocation_active: "another Invocation is active",
  task_unfinished: "a current Task is not completed or cancelled",
  decision_unresolved: "an operator-required Decision is unresolved",
  no_integration_snapshot: "the Run has no integration Snapshot",
  no_deterministic_completion_criterion: "a coding Run needs at least one deterministic completion criterion",
  evaluator_unavailable: "the completion criteria include an evaluated criterion but the Run names no Gate Evaluator",
  final_reserve_insufficient: "the Run's final reserve cannot fund the remaining completion work",
  run_completion_cycles_exhausted: "the Run's run_completion Gate cycles are exhausted",
};

export function preflightRejections(codes: readonly CompletionPreflightCode[]): RuntimeToolRejection[] {
  return codes.map((code) => ({ code, message: PREFLIGHT_MESSAGES[code], path: null }));
}

export class CompletionRequestService {
  private readonly facts: CompletionFacts;

  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
  ) {
    this.facts = new CompletionFacts(stores);
  }

  /**
   * The `request_completion` handler, inside the call's transaction: the
   * caller must be the root Orchestrator's running turn; the preflight must
   * hold; the Completion Request is created once the accepted call's row
   * exists (the request names the call, the call's result names the request).
   */
  request(caller: RuntimeToolCaller, options: WriteOptions): HandlerOutcome {
    if (caller.invocation.role !== "orchestrator" || caller.node.sourcePath !== ROOT_SOURCE_PATH || caller.invocation.purpose === "final_synthesis") {
      return { kind: "rejected", reasons: [{ code: "caller_not_permitted", message: "only the root Orchestrator's turn requests completion", path: null }] };
    }
    const run = this.stores.runs.get(caller.invocation.runId);
    const codes = this.facts.preflight(run, caller.invocation.id);
    if (codes.length > 0) return { kind: "rejected", reasons: preflightRejections(codes) };
    const id = this.ctx.ids("completionRequest");
    return {
      kind: "applied",
      result: { tool: "request_completion", completionRequestId: id, status: "requested" },
      then: (call) => {
        this.stores.completionRequests.create({ runId: run.id, invocationId: caller.invocation.id, runtimeToolCallId: call.id }, { ...options, id });
      },
    };
  }
}
