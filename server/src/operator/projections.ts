/**
 * Read-only operator projections over canonical rows (execution-model §13):
 * what the API returns for a Run, its plan, ledger, budget, signoff, and
 * publication views. Every function reads stores and the scheduler's
 * read-only projection; none writes, none reads a transcript, and none
 * decides anything the runtime owns — a phase here is a presentation of the
 * Run row and its Publications, never a second state machine.
 */
import {
  PUBLICATION_MACHINE,
  type ArtifactId,
  type AttemptResponse,
  type BudgetResponse,
  type Decision,
  type DecisionAction,
  type DecisionView,
  type InvocationResponse,
  type PlanNode,
  type PlanNodeResponse,
  type PlanNodeSummary,
  type PlanResponse,
  type PublicationReport,
  type PublicationsResponse,
  type PublicationView,
  type Requirement,
  type RequirementsResponse,
  type RequirementView,
  type Run,
  type RunId,
  type RunOverview,
  type RunPhase,
  type RunProjection,
  type SignoffResponse,
  type TaskLedgerResponse,
  type TaskView,
  type UsageResponse,
  type WorkspaceKind,
  publicationReportSchema,
} from "@agentique-console/core";
import type { ConsoleRuntime } from "../composition/console-runtime.ts";
import { CompletionFacts } from "../execution/completion-requests.ts";
import { projectNodeTasks } from "../execution/task-projection.ts";
import { supportsPublication, WORKSPACE_CAPABILITIES } from "../workspace-state/capabilities.ts";

const HISTORY_LIMIT = 20;

export function runPhaseOf(runtime: ConsoleRuntime, run: Run, kind: WorkspaceKind): RunPhase {
  switch (run.status) {
    case "created":
      return "created";
    case "running":
      return "running";
    case "waiting":
      switch (run.waitReason) {
        case "decision":
          return "waiting_decision";
        case "budget":
          return "waiting_budget";
        case "provider_capacity":
          return "waiting_capacity";
        case "integration_conflict":
          return "waiting_conflict";
        default:
          return "paused";
      }
    case "verifying":
      return run.operatorPause !== null ? "paused" : "verifying";
    case "awaiting_signoff":
      return run.operatorPause !== null ? "paused" : "awaiting_signoff";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "completed": {
      if (!supportsPublication(kind)) return "publish_unsupported";
      const publications = runtime.stores.publications.listByRun(run.id);
      if (publications.some((p) => p.status === "succeeded")) return "published";
      if (publications.some((p) => !PUBLICATION_MACHINE.isTerminal(p.status))) return "publishing";
      const latest = publications.at(-1);
      if (latest !== undefined && latest.status === "failed") return "publish_failed";
      return "completed_unpublished";
    }
  }
}

export function runProjectionOf(runtime: ConsoleRuntime, runId: RunId): { projection: RunProjection | null; error: string | null } {
  try {
    const p = runtime.scheduler.reconcileRun(runId);
    return {
      projection: {
        revisionNumber: p.revisionNumber,
        stop: p.stop,
        nextActions: p.actions.map((a) => a.kind),
        waiting: p.waiting.map((w) => ({ planNodeId: w.nodeId, reason: w.reason, wakeAt: w.wakeAt })),
        remediating: p.remediating.map((r) => ({ planNodeId: r.nodeId, gateId: r.gateId, taskId: r.taskId })),
        limited: p.limited,
        inFlight: p.inFlight,
        wakeAt: p.wakeAt,
        concurrency: p.concurrency,
        nodes: p.nodes.map((n) => ({ planNodeId: n.nodeId, status: n.status, current: n.current, advice: n.advice?.kind ?? null })),
      },
      error: null,
    };
  } catch (error) {
    return { projection: null, error: error instanceof Error ? error.message.slice(0, 500) : "the projection could not be computed" };
  }
}

export function decisionActionOf(decision: Decision): DecisionAction {
  switch (decision.kind) {
    case "budget_increase":
      return decision.status === "open" ? "budget_increase" : "none";
    case "signoff":
      return decision.status === "open" ? "signoff" : "none";
    case "publish":
      return decision.status === "open" ? "publish" : "none";
    case "orchestrator_choice":
      return "none";
    case "operator_choice":
      if (decision.status === "open") return "resolve";
      return decision.status === "resolved" && decision.resolution?.resolvedBy === "policy:use_default_after_deadline" ? "supersede" : "none";
    default:
      return decision.status === "open" ? "resolve" : "none";
  }
}

export const decisionView = (decision: Decision): DecisionView => ({ decision, action: decisionActionOf(decision) });

export function runOverview(runtime: ConsoleRuntime, run: Run): RunOverview {
  const { stores } = runtime;
  const conversation = stores.conversations.get(run.conversationId);
  const workspace = stores.workspaces.get(run.workspaceId);
  const { projection, error } = runProjectionOf(runtime, run.id);
  const decisions = stores.decisions.listByRun(run.id);
  const openDecisions = decisions.filter((d) => d.status === "open" && decisionActionOf(d) !== "none");
  const activeRequest = stores.completionRequests.activeOf(run.id) ?? stores.completionRequests.listByRun(run.id).at(-1) ?? null;
  const completionGate = activeRequest?.gateId === null || activeRequest === null ? null : stores.gates.get(activeRequest.gateId);
  const signoffGate = stores.gates.listByKind(run.id, "operator_signoff").find((g) => g.status === "open") ?? null;
  const signoffDecision = signoffGate === null ? null : stores.decisions.signoffOf(signoffGate.id);
  const finalReport: ArtifactId | null = stores.gates.listByKind(run.id, "run_completion").findLast((g) => g.status === "passed")?.reportArtifactId ?? null;
  const publications = stores.publications.listByRun(run.id);
  return {
    run,
    conversation,
    workspace,
    phase: runPhaseOf(runtime, run, workspace.kind),
    capacity: stores.reservations.runCapacity(run.id),
    usage: stores.usage.totalsForRun(run.id),
    projection,
    projectionError: error,
    openDecisions,
    openProposal: stores.requirementProposals.openFor(run.id),
    completion: activeRequest === null ? null : { request: activeRequest, gate: completionGate },
    signoff: signoffGate !== null && signoffDecision !== null ? { gateId: signoffGate.id, decisionId: signoffDecision.id } : null,
    finalReportArtifactId: finalReport,
    publication: { supported: supportsPublication(workspace.kind), latest: publications.at(-1) ?? null, openDecisionId: stores.decisions.openPublishOf(run.id)?.id ?? null },
    pendingInputs: stores.orchestratorInputs.pending(run.id).length,
    deadlineAt: null,
  };
}

function nodeSummary(runtime: ConsoleRuntime, node: PlanNode): PlanNodeSummary {
  const { stores } = runtime;
  const invocations = stores.invocations.listByPlanNode(node.id);
  return {
    node,
    invocations: invocations.map((i) => ({ id: i.id, role: i.role, purpose: i.purpose, status: i.status, attempts: stores.invocations.listAttempts(i.id).length })),
    tasks: stores.tasks.listByPlanNode(node.id).length,
    gates: stores.gates.listByPlanNode(node.id).map((g) => ({ id: g.id, kind: g.kind, status: g.status })),
    usage: stores.usage.totalsForPlanNode(node.id),
    allocation: node.kind === "pattern" ? allocationOf(runtime, node.id) : null,
  };
}

function allocationOf(runtime: ConsoleRuntime, planNodeId: PlanNode["id"]) {
  try {
    return runtime.stores.reservations.planNodeAllocation(planNodeId);
  } catch {
    return null;
  }
}

export function planResponse(runtime: ConsoleRuntime, runId: RunId): PlanResponse {
  const graph = runtime.stores.plans.currentGraph(runId);
  return { revisionNumber: graph.revisionNumber, revisionCount: runtime.stores.plans.latestRevisionNumber(runId), graph, nodes: graph.nodes.map((node) => nodeSummary(runtime, node)) };
}

export function planNodeResponse(runtime: ConsoleRuntime, node: PlanNode): PlanNodeResponse {
  const { stores } = runtime;
  return {
    node,
    invocations: stores.invocations.listByPlanNode(node.id),
    tasks: stores.tasks.listByPlanNode(node.id),
    gates: stores.gates.listByPlanNode(node.id),
    evaluations: stores.evaluations.listByPlanNode(node.id),
    usage: stores.usage.totalsForPlanNode(node.id),
    allocation: node.kind === "pattern" ? allocationOf(runtime, node.id) : null,
    extensions: stores.allocationExtensions.listByPlanNode(node.id),
  };
}

export function invocationResponse(runtime: ConsoleRuntime, invocationId: InvocationResponse["invocation"]["id"]): InvocationResponse {
  const { stores } = runtime;
  const invocation = stores.invocations.get(invocationId);
  const manifest = stores.invocations.getManifest(invocationId);
  const artifacts = stores.artifacts.listByRun(invocation.runId).filter((a) => a.producer.kind === "invocation" && a.producer.invocationId === invocationId);
  return {
    invocation,
    // The worktree path is a filesystem location under the state root: withheld from the wire.
    manifest: { ...manifest, content: { ...manifest.content, worktreePath: null } },
    attempts: stores.invocations.listAttempts(invocationId),
    runtimeToolCalls: stores.runtimeToolCalls.listByInvocation(invocationId),
    usage: stores.usage.totalsForInvocation(invocationId),
    artifacts,
    definition: stores.agents.getRevision(invocation.agentDefinitionRevisionId),
  };
}

export function attemptResponse(runtime: ConsoleRuntime, attemptId: AttemptResponse["attempt"]["id"]): AttemptResponse {
  const { stores } = runtime;
  const attempt = stores.invocations.getAttempt(attemptId);
  return {
    attempt,
    usage: stores.usage.listByAttempt(attemptId),
    runtimeToolCalls: stores.runtimeToolCalls.listByAttempt(attemptId),
    transcript: attempt.transcriptArtifactId === null ? null : stores.artifacts.get(attempt.transcriptArtifactId),
  };
}

export function taskLedger(runtime: ConsoleRuntime, runId: RunId): TaskLedgerResponse {
  const { stores } = runtime;
  const tasks = stores.tasks.listByRun(runId);
  const dependencies = stores.tasks.dependencies(runId);
  const artifacts = new Map(stores.artifacts.listByRun(runId).map((a) => [a.id, a] as const));
  const states = new Map<string, TaskView["state"]>();
  const supersededBy = new Map<string, string>();
  const nodeIds = new Set(tasks.map((t) => t.planNodeId).filter((id): id is NonNullable<typeof id> => id !== null));
  for (const planNodeId of nodeIds) {
    const node = stores.plans.getNode(planNodeId);
    if (node.kind !== "pattern" || node.pattern !== "coordinator_worker") continue;
    try {
      const projection = projectNodeTasks(stores, { id: node.id, runId });
      for (const [taskId, state] of projection.states) states.set(taskId, { kind: state.kind, ...("awaiting" in state ? { awaiting: state.awaiting } : {}), ...("blockReason" in state ? { blockReason: state.blockReason } : {}) } as TaskView["state"]);
      for (const [taskId, by] of projection.supersededBy) supersededBy.set(taskId, by);
    } catch {
      // A contradictory ledger leaves its Tasks without a projected state; the rows still show.
    }
  }
  return {
    tasks: tasks.map((task) => ({
      task,
      dependencies: dependencies.filter((d) => d.taskId === task.id).map((d) => d.dependsOnTaskId),
      dependents: dependencies.filter((d) => d.dependsOnTaskId === task.id).map((d) => d.taskId),
      supersededBy: (supersededBy.get(task.id) as TaskView["supersededBy"]) ?? null,
      state: states.get(task.id) ?? null,
      outputs: task.outputArtifactIds.map((id) => artifacts.get(id)).filter((a): a is NonNullable<typeof a> => a !== undefined),
    })),
    dependencies,
  };
}

export function requirementView(runtime: ConsoleRuntime, requirement: Requirement): RequirementView {
  const { stores } = runtime;
  const revision = stores.requirements.currentRevision(requirement.conversationId);
  return {
    requirement,
    entry: revision?.tree.find((e) => e.id === requirement.id) ?? null,
    criteria: stores.requirements.listAcceptanceCriteria({ requirementId: requirement.id }),
    history: stores.requirements.history(requirement.id).slice(-HISTORY_LIMIT),
    waiverDecisionId: stores.requirements.latestWaiverDecisionOf(requirement.id),
  };
}

export function requirementsResponse(runtime: ConsoleRuntime, conversationId: Requirement["conversationId"]): RequirementsResponse {
  const revision = runtime.stores.requirements.currentRevision(conversationId);
  const order = new Map((revision?.tree ?? []).map((e, i) => [e.id, i] as const));
  const requirements = runtime.stores.requirements
    .listByConversation(conversationId)
    .map((r) => requirementView(runtime, r))
    .sort((a, b) => (order.get(a.requirement.id) ?? 1e9) - (order.get(b.requirement.id) ?? 1e9) || (a.requirement.id < b.requirement.id ? -1 : 1));
  return { revision, requirements };
}

export function budgetResponse(runtime: ConsoleRuntime, runId: RunId): BudgetResponse {
  const projection = runtime.budgetIncreases.inspect(runId);
  const facts = new CompletionFacts(runtime.stores);
  const run = runtime.stores.runs.get(runId);
  let required = { costUsd: 0, tokens: 0, attempts: 0 };
  try {
    required = facts.requiredFinalAllocation(run, facts.criteriaOf(run, facts.pinnedRevision(run)));
  } catch {
    // A Run whose completion facts cannot be computed (a foreign criterion) reports no requirement.
  }
  return { ...projection, requiredFinalAllocation: required };
}

export function usageResponse(runtime: ConsoleRuntime, runId: RunId): UsageResponse {
  const { stores } = runtime;
  const nodes = stores.plans.listNodes(runId);
  const invocations = stores.invocations.listByRun(runId);
  return {
    run: stores.usage.totalsForRun(runId),
    byPlanNode: nodes.map((n) => ({ planNodeId: n.id, totals: stores.usage.totalsForPlanNode(n.id) })),
    byInvocation: invocations.map((i) => ({ invocationId: i.id, planNodeId: i.planNodeId, totals: stores.usage.totalsForInvocation(i.id) })),
  };
}

export function signoffResponse(runtime: ConsoleRuntime, runId: RunId): SignoffResponse {
  let signoff: SignoffResponse["signoff"] = null;
  if (runtime.stores.gates.listByKind(runId, "operator_signoff").length > 0) {
    try {
      signoff = runtime.signoff.inspect(runId);
    } catch {
      signoff = null;
    }
  }
  return { signoff, resolutions: runtime.stores.signoffResolutions.listByRun(runId) };
}

export function publicationView(runtime: ConsoleRuntime, publicationId: PublicationView["publication"]["id"]): PublicationView {
  const publication = runtime.stores.publications.get(publicationId);
  let report: PublicationReport | null = null;
  if (publication.reportArtifactId !== null) {
    try {
      const { bytes } = runtime.stores.artifacts.read(publication.reportArtifactId);
      const parsed = publicationReportSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
      report = parsed.success ? parsed.data : null;
    } catch {
      report = null;
    }
  }
  return { publication, report, evaluationIds: runtime.stores.evaluations.publicationCriterionEvaluationsOf(publication.id).map((e) => e.id).sort() };
}

export function publicationsResponse(runtime: ConsoleRuntime, runId: RunId): PublicationsResponse {
  const projection = runtime.publication.inspect(runId);
  const run = runtime.stores.runs.get(runId);
  const workspace = runtime.stores.workspaces.get(run.workspaceId);
  const supported = supportsPublication(workspace.kind);
  return {
    runId: projection.runId,
    runStatus: projection.runStatus,
    target: projection.target,
    capability: { supported, strategies: [...WORKSPACE_CAPABILITIES[workspace.kind].publicationStrategies], reason: supported ? null : WORKSPACE_CAPABILITIES[workspace.kind].publicationApply },
    finalSnapshotId: projection.finalSnapshotId,
    finalChangesetId: projection.finalChangesetId,
    openDecision: projection.openDecision,
    publications: projection.publications.map((p) => publicationView(runtime, p.publicationId)),
    allowedActions: supported ? projection.allowedActions : projection.allowedActions.filter((a) => a !== "request_publish"),
  };
}
