/**
 * Operator signoff resolution (execution-model §3, §9.3, §10
 * `operator_signoff`; invariants 12, 16, 19, 27). The one execution-layer
 * boundary through which the operator-facing layer resolves the
 * `signoff` Decision of a Run awaiting signoff, with three separated
 * operations:
 *
 * - `inspect` — a read-only, bounded projection of the signoff boundary from
 *   canonical rows: ids, statuses, Requirement statuses, Evaluation ids,
 *   Usage totals, Artifact metadata, and the allowed actions. It writes
 *   nothing, derives no new status, and returns no Artifact content,
 *   transcript, provider message, continuation, worktree path, or Event
 *   history.
 * - `accept` — one external read of the Integration Workspace through the
 *   finalization Workspace port (outside every transaction), confirming it
 *   still holds exactly the verified Snapshot and computing the exact
 *   base-to-verified diff; then one root transaction that stores the diff
 *   as a `text/x-diff` Artifact, records the Run's `final` Changeset, records
 *   the `accept` Signoff Resolution, resolves the Decision, closes the Gate
 *   `passed`, and completes the Run with its final references (the
 *   Conversation's active-Run reference cleared by the Run store). Drift,
 *   an unobservable Workspace, or unexpected active state refuses before any
 *   write; a database failure rolls everything back and compensates the
 *   diff blob; a repeated call returns the canonical existing outcome
 *   without inspecting the Workspace again.
 * - `requestChanges` — one root transaction that records the
 *   `request_changes` Signoff Resolution naming the operator's message,
 *   resolves the Decision, closes the Gate `failed` with
 *   `changes_requested`, returns the Run to `running`, prepares exactly one
 *   root `decision_resolution` Orchestrator turn from the root's ordinary
 *   allocation (refused before any write when it cannot be funded; the final
 *   reserve is never a fallback), and links it to the resolution.
 *
 * Every id the operations act on — the Snapshot, the Changeset, the report
 * Artifact, the Completion Request, the Run status, the diff — is resolved
 * from rows; a caller supplies only the Run, the Gate, the Decision, and
 * (for a change request) its message. No outcome is inferred from
 * Conversation text, an Orchestrator result, a model summary, a manifest,
 * or an unresolved Decision, and nothing here writes the operator's branch:
 * signoff accepts the verified Run result and publishing stays a separate,
 * later operation.
 */
import {
  canonicalJson,
  CHANGESET_DIFF_MEDIA_TYPE,
  FINAL_REPORT_MEDIA_TYPE,
  INVOCATION_MACHINE,
  operationAt,
  ROOT_SOURCE_PATH,
  SignoffRefusedError,
  signoffSubjectOf,
  TASK_MACHINE,
  type Artifact,
  type ArtifactId,
  type ChangesetId,
  type ChangesetIntegrationStatus,
  type CompletionRequest,
  type ConversationMessageId,
  type Decision,
  type DecisionId,
  type EvaluationId,
  type Gate,
  type GateId,
  type InvocationId,
  type OperatorPauseMode,
  type PlanNodeId,
  type PlanNodeStatus,
  type RequirementId,
  type RequirementRevisionId,
  type RequirementStatus,
  type Run,
  type RunId,
  type RunStatus,
  type SignoffOption,
  type SignoffResolution,
  type SignoffResolutionId,
  type Snapshot,
  type SnapshotId,
  type TaskId,
  type TaskStatus,
  type Timestamp,
  type UsageTotals,
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import { OPERATOR_ACTOR, type WriteOptions } from "../persistence/stores/support.ts";
import { CompletionFacts } from "./completion-requests.ts";
import type { InvocationPreparationService } from "./invocation-preparation-service.ts";
import type { PlanNodeCapacity } from "./plan-node-capacity.ts";
import type { RunFinalizationWorkspacePort } from "./ports/run-finalization-workspace.ts";

/** Bounded Artifact facts: never content. */
export interface SignoffArtifactFacts {
  artifactId: ArtifactId;
  mediaType: string;
  byteSize: number;
  digest: string;
  title: string | null;
}

/** Why the open boundary cannot be resolved right now: unexpected active state, from rows alone (ids and closed facts). */
export type SignoffBlocker =
  /** The operator paused the Run: signoff is resolved only once it is resumed (execution-model §14). */
  | { kind: "run_paused"; mode: OperatorPauseMode }
  | { kind: "invocation_active"; invocationId: InvocationId }
  | { kind: "attempt_active"; attemptId: string }
  | { kind: "lease_active"; leaseId: string }
  | { kind: "workspace_cleanup_pending"; invocationId: InvocationId }
  | { kind: "reservation_active"; reservationId: string }
  | { kind: "changeset_unintegrated"; changesetId: ChangesetId; status: ChangesetIntegrationStatus }
  | { kind: "node_gate_open"; gateId: GateId; planNodeId: PlanNodeId }
  | { kind: "remediation_unresolved"; taskId: TaskId; gateId: GateId }
  | { kind: "decision_unresolved"; decisionId: DecisionId }
  | { kind: "completion_request_active"; completionRequestId: CompletionRequest["id"] }
  | { kind: "task_unfinished"; taskId: TaskId; status: TaskStatus }
  | { kind: "node_unfinished"; planNodeId: PlanNodeId; status: PlanNodeStatus }
  | { kind: "requirement_unsatisfied"; requirementId: RequirementId; status: RequirementStatus }
  | { kind: "requirement_revision_changed"; pinnedRequirementRevisionId: RequirementRevisionId; currentRequirementRevisionId: RequirementRevisionId | null }
  | { kind: "snapshot_moved"; pinnedSnapshotId: SnapshotId; currentSnapshotId: SnapshotId | null };

/** The bounded, read-only projection of a Run's signoff boundary for an operator-facing layer. */
export interface SignoffProjection {
  runId: RunId;
  runStatus: RunStatus;
  gate: { id: GateId; status: Gate["status"] };
  decision: { id: DecisionId; status: Decision["status"]; chosenOptionId: string | null };
  verifiedSnapshotId: SnapshotId;
  completionRequestId: CompletionRequest["id"];
  completionGateId: GateId;
  report: SignoffArtifactFacts;
  requirementRevisionId: RequirementRevisionId;
  requirements: { requirementId: RequirementId; status: RequirementStatus; waiverDecisionId: DecisionId | null }[];
  waiverDecisionIds: DecisionId[];
  evaluationIds: EvaluationId[];
  usage: UsageTotals;
  candidate: SignoffArtifactFacts[];
  resolution: { id: SignoffResolutionId; outcome: SignoffOption; resolvedAt: Timestamp; operatorMessageId: ConversationMessageId | null; finalChangesetId: ChangesetId | null; followUpInvocationId: InvocationId | null } | null;
  finalSnapshotId: SnapshotId | null;
  finalChangesetId: ChangesetId | null;
  /** What keeps the open boundary from being resolved now; empty once resolved. */
  blockers: SignoffBlocker[];
  allowedActions: SignoffOption[];
}

export type SignoffOutcome =
  | { kind: "accepted"; signoffResolutionId: SignoffResolutionId; runId: RunId; gateId: GateId; decisionId: DecisionId; finalSnapshotId: SnapshotId; finalChangesetId: ChangesetId; diffArtifactId: ArtifactId; replayed: boolean }
  | { kind: "changes_requested"; signoffResolutionId: SignoffResolutionId; runId: RunId; gateId: GateId; decisionId: DecisionId; operatorMessageId: ConversationMessageId; followUpInvocationId: InvocationId; replayed: boolean };

export interface SignoffAcceptRequest {
  runId: RunId;
  gateId: GateId;
  decisionId: DecisionId;
}

export interface SignoffRequestChangesRequest extends SignoffAcceptRequest {
  operatorMessageId: ConversationMessageId;
}

export interface SignoffServiceDependencies {
  ctx: PersistenceContext;
  stores: Stores;
  preparation: InvocationPreparationService;
  /** Reservable root capacity for the follow-up turn (execution-model §7.6). */
  capacity: PlanNodeCapacity;
  finalization: RunFinalizationWorkspacePort;
}

/** Every row of one signoff boundary, loaded and cross-checked from canonical stores. */
interface SignoffBoundary {
  run: Run;
  gate: Gate;
  decision: Decision;
  completionGate: Gate;
  request: CompletionRequest;
  report: Artifact;
  verifiedSnapshot: Snapshot;
  resolution: SignoffResolution | null;
}

const facts = (artifact: Artifact): SignoffArtifactFacts => ({ artifactId: artifact.id, mediaType: artifact.mediaType, byteSize: artifact.byteSize, digest: artifact.digest, title: artifact.title });

export class RunSignoffService {
  private readonly completion: CompletionFacts;

  constructor(private readonly deps: SignoffServiceDependencies) {
    this.completion = new CompletionFacts(deps.stores);
  }

  private get stores(): Stores {
    return this.deps.stores;
  }

  // ---------------------------------------------------------------------------
  // Inspection (read-only)
  // ---------------------------------------------------------------------------

  /** The bounded projection of the Run's latest signoff boundary; throws typed when the boundary is missing or inconsistent. Writes nothing. */
  inspect(runId: RunId): SignoffProjection {
    const boundary = this.boundaryOf(runId, null);
    const { run, gate, decision, completionGate, request, report, resolution } = boundary;
    const revision = this.stores.requirements.getRevision(completionGate.requirementRevisionId!);
    const requirements = completionGate.requirementIds.map((requirementId) => {
      const requirement = this.stores.requirements.get(requirementId);
      const waiver = requirement.status === "waived" ? (this.stores.requirements.history(requirementId).findLast((c) => c.to === "waived")?.decisionId ?? null) : null;
      return { requirementId, status: requirement.status, waiverDecisionId: waiver };
    });
    const blockers = resolution === null ? this.blockersOf(boundary) : [];
    return {
      runId: run.id,
      runStatus: run.status,
      gate: { id: gate.id, status: gate.status },
      decision: { id: decision.id, status: decision.status, chosenOptionId: decision.resolution?.chosenOptionId ?? null },
      verifiedSnapshotId: gate.snapshotId!,
      completionRequestId: request.id,
      completionGateId: completionGate.id,
      report: facts(report),
      requirementRevisionId: revision.id,
      requirements,
      waiverDecisionIds: requirements.flatMap((r) => (r.waiverDecisionId === null ? [] : [r.waiverDecisionId])).sort(),
      evaluationIds: this.stores.evaluations.listByGate(completionGate.id).map((e) => e.id).sort(),
      usage: this.stores.usage.totalsForRun(run.id),
      candidate: gate.candidateArtifactIds.map((id) => facts(this.stores.artifacts.get(id))),
      resolution: resolution === null ? null : { id: resolution.id, outcome: resolution.outcome, resolvedAt: resolution.resolvedAt, operatorMessageId: resolution.operatorMessageId, finalChangesetId: resolution.finalChangesetId, followUpInvocationId: resolution.followUpInvocationId },
      finalSnapshotId: run.finalSnapshotId,
      finalChangesetId: run.finalChangesetId,
      blockers,
      allowedActions: resolution === null && blockers.length === 0 ? ["accept", "request_changes"] : [],
    };
  }

  // ---------------------------------------------------------------------------
  // Boundary facts (rows only)
  // ---------------------------------------------------------------------------

  /**
   * The signoff boundary of the Run: the named (or latest) `operator_signoff`
   * Gate, its `signoff` Decision, the passed `run_completion` Gate and
   * Completion Request it presents, the final-report Artifact, the verified
   * Snapshot, and the resolution if any — every reference cross-checked.
   */
  private boundaryOf(runId: RunId, gateId: GateId | null): SignoffBoundary {
    const run = this.stores.runs.get(runId);
    const gate = gateId === null ? (this.stores.gates.listByKind(runId, "operator_signoff").at(-1) ?? null) : this.gateOf(gateId);
    if (gate === null) throw new SignoffRefusedError("gate_mismatch", `Run ${runId} has no operator_signoff Gate`, { runId });
    if (gate.runId !== run.id || gate.kind !== "operator_signoff") throw new SignoffRefusedError("gate_mismatch", `Gate ${gate.id} is not an operator_signoff Gate of Run ${runId}`, { runId, gateId: gate.id });
    const decision = this.stores.decisions.signoffOf(gate.id);
    if (decision === null) throw new SignoffRefusedError("decision_mismatch", `Gate ${gate.id} has no signoff Decision`, { gateId: gate.id });
    if (decision.kind !== "signoff" || decision.runId !== run.id || decision.conversationId !== run.conversationId || decision.resolutionPolicy !== "operator_required") {
      throw new SignoffRefusedError("decision_mismatch", `Decision ${decision.id} is not the operator-required signoff Decision of Run ${runId}`, { decisionId: decision.id });
    }
    const subject = signoffSubjectOf(decision);
    const inconsistent = (message: string, details: Record<string, unknown> = {}) => new SignoffRefusedError("boundary_inconsistent", message, { runId, gateId: gate.id, decisionId: decision.id, ...details });
    if (subject.runId !== run.id || subject.gateId !== gate.id || subject.completionGateId !== gate.completionGateId || subject.completionRequestId !== gate.completionRequestId || subject.snapshotId !== gate.snapshotId || subject.reportArtifactId !== gate.reportArtifactId) {
      throw inconsistent(`the subject of Decision ${decision.id} disagrees with Gate ${gate.id}`);
    }
    if (gate.completionGateId === null || gate.completionRequestId === null || gate.snapshotId === null || gate.reportArtifactId === null) throw inconsistent(`Gate ${gate.id} is missing a signoff reference`);
    const completionGate = this.stores.gates.get(gate.completionGateId);
    if (completionGate.runId !== run.id || completionGate.kind !== "run_completion" || completionGate.status !== "passed" || completionGate.completionRequestId !== gate.completionRequestId || completionGate.snapshotId !== gate.snapshotId || completionGate.reportArtifactId !== gate.reportArtifactId || completionGate.requirementRevisionId !== gate.requirementRevisionId) {
      throw inconsistent(`Gate ${completionGate.id} is not the passed run_completion Gate that Gate ${gate.id} presents`, { completionGateId: completionGate.id });
    }
    const request = this.stores.completionRequests.get(gate.completionRequestId);
    if (request.runId !== run.id || request.status !== "passed" || request.gateId !== completionGate.id || request.reportArtifactId !== gate.reportArtifactId) {
      throw inconsistent(`Completion Request ${request.id} has not passed on Gate ${completionGate.id} with report ${gate.reportArtifactId}`, { completionRequestId: request.id });
    }
    const report = this.stores.artifacts.get(gate.reportArtifactId);
    if (report.runId !== run.id || report.mediaType !== FINAL_REPORT_MEDIA_TYPE) throw inconsistent(`Artifact ${report.id} is not the final report of Run ${runId}`, { reportArtifactId: report.id });
    const verifiedSnapshot = this.stores.snapshots.get(gate.snapshotId);
    if (verifiedSnapshot.workspaceId !== run.workspaceId || verifiedSnapshot.runId !== run.id) throw inconsistent(`Snapshot ${verifiedSnapshot.id} does not belong to Run ${runId} and its Workspace`, { snapshotId: verifiedSnapshot.id });
    const resolution = this.stores.signoffResolutions.byGate(gate.id);
    if (resolution === null) {
      if (gate.status !== "open" || decision.status !== "open") throw inconsistent(`Gate ${gate.id} (${gate.status}) and Decision ${decision.id} (${decision.status}) are closed without a Signoff Resolution`);
      if (run.status !== "awaiting_signoff") throw new SignoffRefusedError("run_not_awaiting_signoff", `Run ${runId} is ${run.status}`, { runId, status: run.status });
    } else {
      if (resolution.decisionId !== decision.id || resolution.runId !== run.id) throw inconsistent(`Signoff Resolution ${resolution.id} names another Decision or Run`, { signoffResolutionId: resolution.id });
      if (gate.status === "open" || decision.status !== "resolved" || decision.resolution?.chosenOptionId !== resolution.outcome) throw inconsistent(`Signoff Resolution ${resolution.id} disagrees with Gate ${gate.id} and Decision ${decision.id}`, { signoffResolutionId: resolution.id });
      if (resolution.outcome === "accept" && (gate.status !== "passed" || run.status !== "completed" || run.finalChangesetId !== resolution.finalChangesetId || run.finalSnapshotId !== gate.snapshotId)) {
        throw inconsistent(`accept Signoff Resolution ${resolution.id} disagrees with the completed Run`, { signoffResolutionId: resolution.id });
      }
      if (resolution.outcome === "request_changes" && (gate.status !== "failed" || gate.failure?.kind !== "changes_requested" || gate.failure.decisionId !== decision.id || resolution.followUpInvocationId === null)) {
        throw inconsistent(`request_changes Signoff Resolution ${resolution.id} disagrees with the failed Gate ${gate.id}`, { signoffResolutionId: resolution.id });
      }
    }
    return { run, gate, decision, completionGate, request, report, verifiedSnapshot, resolution };
  }

  private gateOf(gateId: GateId): Gate | null {
    try {
      return this.stores.gates.get(gateId);
    } catch {
      return null;
    }
  }

  /** The named Gate and Decision are the boundary's own. */
  private assertNamed(boundary: SignoffBoundary, gateId: GateId, decisionId: DecisionId): void {
    if (boundary.gate.id !== gateId) throw new SignoffRefusedError("gate_mismatch", `Gate ${gateId} is not the operator_signoff Gate of Run ${boundary.run.id}`, { runId: boundary.run.id, gateId });
    if (boundary.decision.id !== decisionId) throw new SignoffRefusedError("decision_mismatch", `Decision ${decisionId} is not the signoff Decision of Gate ${gateId}`, { gateId, decisionId });
  }

  /**
   * The complete quiescence the accepted state requires (execution-model
   * §10): no active Invocation, Attempt, lease, cleanup obligation, or
   * reservation below the root; no invocation Changeset pending or in
   * conflict; no open node Gate or unresolved remediation; no other
   * operator-required Decision; no active Completion Request; every current
   * Task and non-root node ended; the pinned leaves satisfied, waived, or
   * retired on the still-current Requirement revision; the integration
   * Snapshot unchanged. Nothing is released or repaired here.
   */
  private blockersOf(boundary: SignoffBoundary): SignoffBlocker[] {
    const { run, gate, decision, completionGate } = boundary;
    const blockers: SignoffBlocker[] = [];
    if (run.operatorPause !== null) blockers.push({ kind: "run_paused", mode: run.operatorPause });
    for (const invocation of this.stores.invocations.listActive(run.id)) blockers.push({ kind: "invocation_active", invocationId: invocation.id });
    for (const attempt of this.stores.invocations.activeAttempts()) if (attempt.runId === run.id) blockers.push({ kind: "attempt_active", attemptId: attempt.id });
    for (const lease of this.stores.leases.listByRun(run.id)) if (lease.status === "active") blockers.push({ kind: "lease_active", leaseId: lease.id });
    for (const invocation of this.stores.invocations.listPendingWorkspaceCleanup()) if (invocation.runId === run.id) blockers.push({ kind: "workspace_cleanup_pending", invocationId: invocation.id });
    const root = this.completion.root(run);
    for (const reservation of this.stores.reservations.listByParent({ type: "run", id: run.id })) {
      if (reservation.status !== "active") continue;
      // The root node's own allocation stays reserved for the life of the Run; every other Run-level child (a node, a final-reserve Invocation) must be released.
      if (reservation.child.type === "plan_node" && reservation.child.id === root.id) continue;
      blockers.push({ kind: "reservation_active", reservationId: reservation.id });
    }
    for (const node of this.stores.plans.listNodes(run.id)) {
      for (const reservation of this.stores.reservations.listByParent({ type: "plan_node", id: node.id })) {
        if (reservation.status === "active") blockers.push({ kind: "reservation_active", reservationId: reservation.id });
      }
    }
    for (const changeset of this.stores.changesets.listByRun(run.id)) {
      if (changeset.kind === "invocation" && changeset.integrationStatus !== "integrated") blockers.push({ kind: "changeset_unintegrated", changesetId: changeset.id, status: changeset.integrationStatus });
    }
    for (const node of this.stores.gates.listByKind(run.id, "node_exit")) if (node.status === "open") blockers.push({ kind: "node_gate_open", gateId: node.id, planNodeId: node.planNodeId! });
    for (const task of this.stores.tasks.listRemediationTasks(run.id)) if (!TASK_MACHINE.isTerminal(task.status)) blockers.push({ kind: "remediation_unresolved", taskId: task.id, gateId: task.gateId! });
    for (const open of this.completion.openOperatorDecisions(run)) if (open.id !== decision.id) blockers.push({ kind: "decision_unresolved", decisionId: open.id });
    const active = this.stores.completionRequests.activeOf(run.id);
    if (active !== null) blockers.push({ kind: "completion_request_active", completionRequestId: active.id });
    for (const task of this.completion.currentTasks(run)) if (task.status !== "completed" && task.status !== "cancelled") blockers.push({ kind: "task_unfinished", taskId: task.id, status: task.status });
    for (const node of this.stores.plans.currentGraph(run.id).nodes) {
      if (node.sourcePath === ROOT_SOURCE_PATH) continue;
      if (!["succeeded", "cancelled", "skipped"].includes(node.status)) blockers.push({ kind: "node_unfinished", planNodeId: node.id, status: node.status });
    }
    for (const requirementId of completionGate.requirementIds) {
      const status = this.stores.requirements.get(requirementId).status;
      if (status !== "satisfied" && status !== "waived" && status !== "retired") blockers.push({ kind: "requirement_unsatisfied", requirementId, status });
    }
    const current = this.completion.pinnedRevision(run);
    if (current?.id !== completionGate.requirementRevisionId) blockers.push({ kind: "requirement_revision_changed", pinnedRequirementRevisionId: completionGate.requirementRevisionId!, currentRequirementRevisionId: current?.id ?? null });
    const integration = this.completion.integrationSnapshotId(run);
    if (integration !== gate.snapshotId) blockers.push({ kind: "snapshot_moved", pinnedSnapshotId: gate.snapshotId!, currentSnapshotId: integration });
    return blockers;
  }

  private assertOpenAndQuiescent(boundary: SignoffBoundary): void {
    if (boundary.run.status !== "awaiting_signoff") throw new SignoffRefusedError("run_not_awaiting_signoff", `Run ${boundary.run.id} is ${boundary.run.status}`, { runId: boundary.run.id, status: boundary.run.status });
    if (boundary.run.operatorPause !== null) throw new SignoffRefusedError("run_paused", `Run ${boundary.run.id} is paused by the operator (${boundary.run.operatorPause}); resume it before resolving its signoff`, { runId: boundary.run.id, operatorPause: boundary.run.operatorPause });
    if (boundary.run.baseSnapshotId === null) throw new SignoffRefusedError("boundary_inconsistent", `Run ${boundary.run.id} has no base Snapshot`, { runId: boundary.run.id });
    const blockers = this.blockersOf(boundary);
    if (blockers.length > 0) throw new SignoffRefusedError("active_state", `Run ${boundary.run.id} holds unexpected active state: ${blockers.map((b) => b.kind).join(", ")}`, { runId: boundary.run.id, blockers });
  }

  /** The canonical existing outcome of an already-resolved boundary, or the typed conflict when the replay asks for something else. */
  private replay(boundary: SignoffBoundary, resolution: SignoffResolution, requested: SignoffOption, operatorMessageId: ConversationMessageId | null): SignoffOutcome {
    if (resolution.outcome !== requested) {
      throw new SignoffRefusedError("conflicting_resolution", `Gate ${resolution.gateId} was resolved ${resolution.outcome}; ${requested} conflicts with it`, { signoffResolutionId: resolution.id, outcome: resolution.outcome, requested });
    }
    if (resolution.outcome === "request_changes") {
      if (resolution.operatorMessageId !== operatorMessageId) {
        throw new SignoffRefusedError("conflicting_resolution", `Gate ${resolution.gateId} was resolved request_changes for another operator message`, { signoffResolutionId: resolution.id, operatorMessageId });
      }
      return { kind: "changes_requested", signoffResolutionId: resolution.id, runId: resolution.runId, gateId: resolution.gateId, decisionId: resolution.decisionId, operatorMessageId: resolution.operatorMessageId!, followUpInvocationId: resolution.followUpInvocationId!, replayed: true };
    }
    const changeset = this.stores.changesets.get(resolution.finalChangesetId!);
    return { kind: "accepted", signoffResolutionId: resolution.id, runId: resolution.runId, gateId: resolution.gateId, decisionId: resolution.decisionId, finalSnapshotId: boundary.run.finalSnapshotId!, finalChangesetId: changeset.id, diffArtifactId: changeset.diffArtifactId, replayed: true };
  }

  /** The correlation chain of one resolution: every Event of the operation shares the correlation id and is caused by the previous one. */
  private chain(meta: WriteOptions): WriteOptions {
    return { ...meta, causationSeq: this.deps.ctx.journal.lastSeq() };
  }

  // ---------------------------------------------------------------------------
  // Accept
  // ---------------------------------------------------------------------------

  async accept(input: SignoffAcceptRequest, options: WriteOptions = {}): Promise<SignoffOutcome> {
    const { ctx, finalization } = this.deps;
    if (ctx.tx.inTransaction) throw new Error("signoff acceptance inspects the Integration Workspace and never runs inside a transaction");
    // Step 1: the complete boundary, before any external read.
    const first = this.boundaryOf(input.runId, input.gateId);
    this.assertNamed(first, input.gateId, input.decisionId);
    if (first.resolution !== null) return this.replay(first, first.resolution, "accept", null);
    this.assertOpenAndQuiescent(first);
    // Step 2: the external observation, outside every transaction: the Integration Workspace must still hold exactly the verified Snapshot.
    const base = this.stores.snapshots.get(first.run.baseSnapshotId!);
    const observed = await finalization.inspect({ runId: first.run.id, workspaceId: first.run.workspaceId, integrationWorkspacePath: first.run.integrationWorkspacePath, baseSnapshot: base.identity, verifiedSnapshot: first.verifiedSnapshot.identity });
    if (observed.kind === "failed") throw new SignoffRefusedError("finalization_failed", `the Integration Workspace of Run ${first.run.id} could not be inspected (${observed.failure})`, { runId: first.run.id, failure: observed.failure, message: observed.message });
    if (canonicalJson(observed.currentSnapshot) !== canonicalJson(first.verifiedSnapshot.identity) || !observed.workspace.clean) {
      throw new SignoffRefusedError("workspace_drifted", `the Integration Workspace of Run ${first.run.id} no longer holds exactly the verified Snapshot ${first.verifiedSnapshot.id}`, { runId: first.run.id, verifiedSnapshotId: first.verifiedSnapshot.id, clean: observed.workspace.clean });
    }
    // Step 3: one root transaction over revalidated rows; the diff bytes go into the Artifact Store and nowhere else.
    return ctx.tx.write((): SignoffOutcome => {
      const boundary = this.boundaryOf(input.runId, input.gateId);
      this.assertNamed(boundary, input.gateId, input.decisionId);
      if (boundary.resolution !== null) return this.replay(boundary, boundary.resolution, "accept", null);
      this.assertOpenAndQuiescent(boundary);
      const { run, gate, decision } = boundary;
      if (run.updatedAt !== first.run.updatedAt || run.baseSnapshotId !== first.run.baseSnapshotId || gate.snapshotId !== first.gate.snapshotId) {
        throw new SignoffRefusedError("boundary_inconsistent", `Run ${run.id} changed while its Integration Workspace was inspected`, { runId: run.id });
      }
      const id = ctx.ids("signoffResolution");
      const meta: WriteOptions = { actor: options.actor ?? OPERATOR_ACTOR, correlationId: options.correlationId ?? id, causationSeq: options.causationSeq ?? null };
      const artifact = this.stores.artifacts.create({ runId: run.id, mediaType: CHANGESET_DIFF_MEDIA_TYPE, producer: { kind: "runtime", component: "changeset" }, taskId: null, title: `final changeset of ${run.id}` }, observed.diff, meta);
      const changeset = this.stores.changesets.recordFinal({ runId: run.id, beforeSnapshotId: run.baseSnapshotId!, afterSnapshotId: gate.snapshotId!, diffArtifactId: artifact.id }, this.chain(meta));
      const resolution = this.stores.signoffResolutions.record({ runId: run.id, gateId: gate.id, decisionId: decision.id, outcome: "accept", finalChangesetId: changeset.id }, { ...this.chain(meta), id });
      this.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "accept", rationale: null, artifactIds: [] }, this.chain(meta));
      this.stores.gates.close(gate.id, "passed", null, this.chain(meta));
      this.stores.runs.transition(run.id, { to: "completed", finalSnapshotId: gate.snapshotId!, finalChangesetId: changeset.id }, this.chain(meta));
      return { kind: "accepted", signoffResolutionId: resolution.id, runId: run.id, gateId: gate.id, decisionId: decision.id, finalSnapshotId: gate.snapshotId!, finalChangesetId: changeset.id, diffArtifactId: artifact.id, replayed: false };
    });
  }

  // ---------------------------------------------------------------------------
  // Request changes
  // ---------------------------------------------------------------------------

  requestChanges(input: SignoffRequestChangesRequest, options: WriteOptions = {}): SignoffOutcome {
    const { ctx, preparation } = this.deps;
    return ctx.tx.write((): SignoffOutcome => {
      const boundary = this.boundaryOf(input.runId, input.gateId);
      this.assertNamed(boundary, input.gateId, input.decisionId);
      if (boundary.resolution !== null) return this.replay(boundary, boundary.resolution, "request_changes", input.operatorMessageId);
      this.assertOpenAndQuiescent(boundary);
      const { run, gate, decision } = boundary;
      // The operator's message: of the Run's Conversation, the operator's own, not consumed by another resolution.
      const message = this.messageOf(run, input.operatorMessageId);
      // Funding preflight: the follow-up turn is an ordinary root turn; when the root's effective allocation cannot admit it — directly or
      // through the exact Allocation Extension the root's `extend` policy draws from the Run's effective ordinary capacity — nothing is
      // written (the final reserve is never a fallback).
      const root = this.completion.root(run);
      const operation = operationAt(root.shape, { kind: "orchestrator" });
      if (operation === null) throw new SignoffRefusedError("boundary_inconsistent", `root PlanNode ${root.id} has no orchestrator position`, { planNodeId: root.id });
      const allocation = this.stores.agents.getRevision(operation.agentDefinitionRevisionId).defaultLimits.allocation;
      const unfundable = () => new SignoffRefusedError("ordinary_capacity_insufficient", `the root node's ordinary allocation cannot fund the follow-up Orchestrator turn of Run ${run.id}`, { runId: run.id, planNodeId: root.id });
      if (!this.deps.capacity.admits(root, allocation).fits) throw unfundable();
      const latest = this.stores.invocations.latestAtPosition(root.id, "orchestrator");
      if (latest !== null && !INVOCATION_MACHINE.isTerminal(latest.status)) throw new SignoffRefusedError("active_state", `Orchestrator Invocation ${latest.id} is still ${latest.status}`, { invocationId: latest.id });
      const id = ctx.ids("signoffResolution");
      const meta: WriteOptions = { actor: options.actor ?? OPERATOR_ACTOR, correlationId: options.correlationId ?? id, causationSeq: options.causationSeq ?? null };
      const resolution = this.stores.signoffResolutions.record({ runId: run.id, gateId: gate.id, decisionId: decision.id, outcome: "request_changes", operatorMessageId: message.id }, { ...meta, id });
      this.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "request_changes", rationale: null, artifactIds: [] }, this.chain(meta));
      this.stores.gates.close(gate.id, "failed", { kind: "changes_requested", decisionId: decision.id }, this.chain(meta));
      this.stores.runs.transition(run.id, { to: "running" }, this.chain(meta));
      // The follow-up's funding and the follow-up itself commit with the resolution or not at all: a refusal here (a race) rolls everything back.
      const funded = this.deps.capacity.ensure(root, allocation, "signoff_follow_up", this.chain(meta));
      if (funded.kind !== "funded") throw unfundable();
      const prepared = preparation.prepare({
        runId: run.id,
        planNodeId: root.id,
        role: "orchestrator",
        purpose: "decision_resolution",
        patternPosition: { kind: "orchestrator" },
        continuedFromInvocationId: latest?.id ?? null,
        funding: { source: "plan_node" },
        handoffIds: [],
        inputs: [
          { kind: "signoff_resolution", signoffResolutionId: resolution.id, gateId: gate.id, decisionId: decision.id, completionGateId: boundary.completionGate.id, outcome: "request_changes", operatorMessageId: message.id, verifiedSnapshotId: gate.snapshotId!, reportArtifactId: boundary.report.id },
          { kind: "operator_message", conversationMessageId: message.id, content: message.content },
        ],
        artifactIds: [boundary.report.id],
        correlationId: meta.correlationId ?? null,
        causationSeq: ctx.journal.lastSeq(),
      });
      this.stores.signoffResolutions.link(resolution.id, prepared.invocation.id, this.chain(meta));
      return { kind: "changes_requested", signoffResolutionId: resolution.id, runId: run.id, gateId: gate.id, decisionId: decision.id, operatorMessageId: message.id, followUpInvocationId: prepared.invocation.id, replayed: false };
    });
  }

  private messageOf(run: Run, operatorMessageId: ConversationMessageId) {
    let message;
    try {
      message = this.stores.conversations.getMessage(operatorMessageId);
    } catch {
      throw new SignoffRefusedError("operator_message_invalid", `ConversationMessage ${operatorMessageId} does not exist`, { operatorMessageId });
    }
    if (message.conversationId !== run.conversationId) throw new SignoffRefusedError("operator_message_invalid", `ConversationMessage ${operatorMessageId} belongs to another Conversation`, { operatorMessageId });
    if (message.runId !== null && message.runId !== run.id) throw new SignoffRefusedError("operator_message_invalid", `ConversationMessage ${operatorMessageId} was posted in another Run`, { operatorMessageId });
    if (message.author !== "operator") throw new SignoffRefusedError("operator_message_invalid", `ConversationMessage ${operatorMessageId} is not the operator's`, { operatorMessageId });
    const consumed = this.stores.signoffResolutions.byOperatorMessage(operatorMessageId);
    if (consumed !== null) throw new SignoffRefusedError("operator_message_invalid", `ConversationMessage ${operatorMessageId} already answered Signoff Resolution ${consumed.id}`, { operatorMessageId, signoffResolutionId: consumed.id });
    return message;
  }
}
