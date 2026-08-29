/**
 * The plan-revision service (execution-model §4.5): the one place a proposed
 * source revision is authorized, validated, compiled, reconciled against
 * the current accepted revision, and persisted atomically — or rejected
 * with structured reasons and exactly one `execution_plan.rejected` Event.
 * Only this service applies revisions; agents propose, the runtime decides.
 */
import {
  addAllocation,
  allocationFits,
  assertSourceObjectAcyclic,
  ConflictError,
  DomainError,
  InsufficientCapacityError,
  NotFoundError,
  planNodeDefinitionEquals,
  planNodeDefinitionOf,
  planNodeIsUnstarted,
  PLAN_REJECTION_CODES,
  ROOT_SOURCE_PATH,
  RUN_MACHINE,
  validateExecutionPlanSource,
  ValidationError,
  ZERO_ALLOCATION,
  type Allocation,
  type ExecutionPlanRevision,
  type ExecutionPlanSource,
  type InvocationId,
  type PlanGraph,
  type PlanLimits,
  type PlanNode,
  type PlanNodeId,
  type PlanRejectionCode,
  type PlanRejectionReason,
  type Run,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { RevisionEdgeInput, RevisionNodeInput } from "../persistence/stores/plans.ts";
import { runScope, type WriteOptions } from "../persistence/stores/support.ts";
import { resolveExecutableAgentDefinitionRevision } from "./agent-definitions.ts";
import { collectSourceReferences, compileExecutionPlan, rawSourceRejections } from "./compiler/compile.ts";
import type { CompileDefaults, CompileInput, CompiledDraft } from "./compiler/input.ts";

export interface PlanRevisionServiceConfig {
  defaults: CompileDefaults;
  limits: PlanLimits;
}

export interface PlanRevisionProposal {
  runId: RunId;
  /** The Orchestrator Invocation proposing the revision; every non-initial revision has one. */
  proposedByInvocationId: InvocationId;
  /** The raw proposed source, exactly as the tool received it. */
  source: unknown;
  correlationId?: string | null;
  causationSeq?: number | null;
}

export type PlanRevisionOutcome =
  | {
      accepted: true;
      revision: ExecutionPlanRevision;
      graph: PlanGraph;
      createdNodeIds: PlanNodeId[];
      reusedNodeIds: PlanNodeId[];
      cancelledNodeIds: PlanNodeId[];
    }
  | {
      accepted: false;
      reasons: PlanRejectionReason[];
      /** The accepted revision that remains current; no number was consumed. */
      currentRevisionNumber: number;
      /** The sequence number of the `execution_plan.rejected` Event. */
      eventSeq: number;
    };

/** A rejection decided before or during application; never escapes `propose`. */
class Rejected extends Error {
  constructor(readonly reasons: PlanRejectionReason[]) {
    super(reasons.map((r) => r.message).join("; "));
    this.name = "Rejected";
  }
}

interface Reconciliation {
  membership: PlanNodeId[];
  createdNodes: RevisionNodeInput[];
  reusedNodeIds: PlanNodeId[];
  cancelledNodeIds: PlanNodeId[];
  edges: RevisionEdgeInput[];
  /** Allocation the new pattern nodes need from ordinary Run capacity. */
  required: Allocation;
  /** Allocation the cancelled nodes' active reservations return. */
  released: Allocation;
}

export class PlanRevisionService {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
    private readonly config: PlanRevisionServiceConfig,
  ) {}

  /**
   * Applies a proposal. Authorization failures (a non-Orchestrator or foreign
   * Invocation) and infrastructure failures throw; an ordinary invalid
   * proposal returns a rejected outcome after journaling exactly one
   * `execution_plan.rejected` Event in its own transaction and writing
   * nothing else.
   */
  propose(proposal: PlanRevisionProposal): PlanRevisionOutcome {
    const run = this.stores.runs.get(proposal.runId);
    if (RUN_MACHINE.isTerminal(run.status)) {
      throw new ConflictError(`Run ${run.id} has ended; its Execution Plan cannot be revised`);
    }
    this.stores.plans.assertOrchestratorInvocation(run.id, proposal.proposedByInvocationId);
    const meta: WriteOptions = {
      actor: { kind: "invocation", invocationId: proposal.proposedByInvocationId },
      correlationId: proposal.correlationId ?? null,
      causationSeq: proposal.causationSeq ?? null,
    };
    try {
      const source = this.validateSource(proposal.source);
      const draft = this.compile(run, source);
      const current = this.stores.plans.currentGraph(run.id);
      const reconciliation = this.reconcile(current, draft);
      this.assertCapacity(run, reconciliation);
      return this.apply(run, source, proposal.proposedByInvocationId, reconciliation, meta);
    } catch (error) {
      if (!(error instanceof Rejected)) throw error;
      return this.reject(run, proposal.proposedByInvocationId, error.reasons, meta);
    }
  }

  // -------------------------------------------------------------------------
  // Validation and compilation
  // -------------------------------------------------------------------------

  private validateSource(raw: unknown): ExecutionPlanSource {
    try {
      assertSourceObjectAcyclic(raw);
    } catch (error) {
      throw new Rejected([reasonOf(error, "invalid_structure")]);
    }
    const rawReasons = rawSourceRejections(raw);
    if (rawReasons.length > 0) throw new Rejected(rawReasons);
    try {
      return validateExecutionPlanSource(raw, this.config.limits);
    } catch (error) {
      throw new Rejected([reasonOf(error, "invalid_structure")]);
    }
  }

  /**
   * Resolves every fact the compiler needs from the stores, then compiles.
   * Every referenced Agent Definition revision passes the executable-revision
   * resolver first (provenance ownership); a revision that does not resolve
   * rejects the proposal with `invalid_agent_definition_revision`, so the
   * pure compiler only ever sees revisions the Run may execute.
   */
  private compile(run: Run, source: ExecutionPlanSource): CompiledDraft {
    const references = collectSourceReferences(source);
    const owner = { workspaceId: run.workspaceId, conversationId: run.conversationId };
    const agentDefinitionRevisions = references.agentDefinitionRevisionIds.map((id) => {
      const resolved = resolveExecutableAgentDefinitionRevision(this.stores, owner, id);
      if (!resolved.ok) throw new Rejected([{ code: "invalid_agent_definition_revision", message: resolved.message, path: null }]);
      return resolved.revision;
    });
    const input: CompileInput = {
      runId: run.id,
      conversationId: run.conversationId,
      revisionNumber: this.stores.plans.latestRevisionNumber(run.id) + 1,
      source,
      agentDefinitionRevisions,
      requirementRevisions: references.requirementRevisionIds.flatMap((id) => {
        try {
          const revision = this.stores.requirements.getRevision(id as never);
          return [{ id: revision.id, conversationId: revision.conversationId, tree: revision.tree }];
        } catch (error) {
          if (error instanceof NotFoundError) return [];
          throw error;
        }
      }),
      requirements: this.stores.requirements.listByConversation(run.conversationId).map((r) => ({ id: r.id, conversationId: r.conversationId, status: r.status })),
      references: {
        taskIds: this.stores.tasks.listByRun(run.id).map((t) => t.id),
        decisionIds: this.stores.decisions.listByConversation(run.conversationId).map((d) => d.id),
        artifactIds: this.stores.artifacts.listByRun(run.id).map((a) => a.id),
        acceptanceCriterionIds: references.acceptanceCriterionIds.flatMap((id) => {
          try {
            const criterion = this.stores.requirements.getAcceptanceCriterion(id as never);
            return criterion.conversationId === run.conversationId ? [criterion.id] : [];
          } catch (error) {
            if (error instanceof NotFoundError) return [];
            throw error;
          }
        }),
      },
      defaults: this.config.defaults,
      limits: this.config.limits,
    };
    const result = compileExecutionPlan(input);
    if (!result.accepted) throw new Rejected(result.reasons);
    return result.draft;
  }

  // -------------------------------------------------------------------------
  // Reconciliation (execution-model §4.5)
  // -------------------------------------------------------------------------

  /**
   * Matches draft nodes to current members by source path and full immutable
   * definition: an equal definition reuses the node (id, state, scope,
   * reservation); a changed definition replaces an unstarted node and rejects
   * for a started or terminal one; a removed unstarted node is cancelled; a
   * removed started or historical node is left untouched and simply leaves
   * the membership. The root is always the first member.
   */
  private reconcile(current: PlanGraph, draft: CompiledDraft): Reconciliation {
    const root = current.nodes.find((n) => n.sourcePath === ROOT_SOURCE_PATH);
    if (!root) throw new Error(`Run ${current.runId} has no root node in revision ${current.revisionNumber}`);
    const byPath = new Map<string, PlanNode>(current.nodes.filter((n) => n !== root).map((n) => [n.sourcePath, n]));
    const membership: PlanNodeId[] = [root.id];
    const createdNodes: RevisionNodeInput[] = [];
    const reusedNodeIds: PlanNodeId[] = [root.id];
    const cancelledNodeIds: PlanNodeId[] = [];
    const conflicts: PlanRejectionReason[] = [];
    const idOfKey = new Map<string, PlanNodeId>();
    let required: Allocation = { ...ZERO_ALLOCATION };
    let released: Allocation = { ...ZERO_ALLOCATION };

    const create = (key: string, definition: RevisionNodeInput["definition"]): void => {
      const id = this.ctx.ids("planNode");
      createdNodes.push({ id, definition });
      idOfKey.set(key, id);
      membership.push(id);
      if (definition.kind === "pattern") required = addAllocation(required, definition.allocation);
    };
    const cancel = (node: PlanNode): void => {
      cancelledNodeIds.push(node.id);
      const reservation = this.stores.reservations.activeForChild({ type: "plan_node", id: node.id });
      if (reservation) released = addAllocation(released, reservation.reserved);
    };

    for (const { key, definition } of draft.nodes) {
      const existing = byPath.get(key);
      if (!existing) {
        create(key, definition);
        continue;
      }
      byPath.delete(key);
      if (planNodeDefinitionEquals(planNodeDefinitionOf(existing), definition)) {
        reusedNodeIds.push(existing.id);
        idOfKey.set(key, existing.id);
        membership.push(existing.id);
        continue;
      }
      if (!planNodeIsUnstarted(existing.status)) {
        conflicts.push({
          code: "started_node_changed",
          message: `node ${key} (${existing.id}) is ${existing.status}; its definition cannot change — cancel it and add a new expression instead`,
          path: key,
        });
        continue;
      }
      cancel(existing);
      create(key, definition);
    }
    if (conflicts.length > 0) throw new Rejected(conflicts);
    for (const removed of byPath.values()) {
      if (planNodeIsUnstarted(removed.status)) cancel(removed);
      // A running, waiting, or terminal node keeps its row and state; it simply leaves the membership.
    }
    const edges: RevisionEdgeInput[] = draft.edges.map((edge) => ({
      sourceNodeId: idOfKey.get(edge.sourceKey)!,
      targetNodeId: idOfKey.get(edge.targetKey)!,
      type: edge.type,
      position: edge.position,
      ...(edge.label !== undefined ? { label: edge.label } : {}),
      ...(edge.round !== undefined ? { round: edge.round } : {}),
    }));
    return { membership, createdNodes, reusedNodeIds, cancelledNodeIds, edges, required, released };
  }

  /** Rule 8: the whole candidate revision must fit ordinary capacity after the final reserve. */
  private assertCapacity(run: Run, reconciliation: Reconciliation): void {
    const available = addAllocation(this.stores.reservations.runCapacity(run.id).ordinary.available, reconciliation.released);
    if (!allocationFits(reconciliation.required, available)) {
      throw new Rejected([
        {
          code: "insufficient_capacity",
          message: `the revision needs ${describe(reconciliation.required)} but only ${describe(available)} of ordinary Run capacity is unreserved after the final reserve`,
          path: null,
        },
      ]);
    }
  }

  // -------------------------------------------------------------------------
  // Application
  // -------------------------------------------------------------------------

  /** One root transaction: revision, cancellations and releases, new nodes, membership, edges, scope, reservations, Events. */
  private apply(run: Run, source: ExecutionPlanSource, invocationId: InvocationId, reconciliation: Reconciliation, meta: WriteOptions): PlanRevisionOutcome {
    try {
      return this.ctx.tx.write(() => {
        const revision = this.stores.plans.appendRevision(run.id, source, invocationId, meta);
        const caused: WriteOptions = { ...meta, causationSeq: this.ctx.journal.lastSeq() };
        for (const id of reconciliation.cancelledNodeIds) {
          this.stores.plans.transitionNode(id, { to: "cancelled", reason: "plan_revision" }, caused);
        }
        const graph = this.stores.plans.materializeRevision(
          {
            runId: run.id,
            revisionNumber: revision.number,
            membership: reconciliation.membership,
            createdNodes: reconciliation.createdNodes,
            edges: reconciliation.edges,
            cancelledNodeIds: reconciliation.cancelledNodeIds,
          },
          caused,
        );
        return {
          accepted: true,
          revision,
          graph,
          createdNodeIds: reconciliation.createdNodes.map((n) => n.id),
          reusedNodeIds: reconciliation.reusedNodeIds,
          cancelledNodeIds: reconciliation.cancelledNodeIds,
        };
      });
    } catch (error) {
      // The transaction has rolled back; an allocation that no longer fits is an ordinary rejection.
      if (error instanceof InsufficientCapacityError) {
        throw new Rejected([{ code: "insufficient_capacity", message: error.message, path: null }]);
      }
      throw error;
    }
  }

  /** A separate, successful transaction that writes exactly one Event and nothing else. */
  private reject(run: Run, invocationId: InvocationId, reasons: PlanRejectionReason[], meta: WriteOptions): PlanRevisionOutcome {
    const currentRevisionNumber = this.stores.plans.latestRevisionNumber(run.id);
    const event = this.ctx.tx.write(() =>
      this.ctx.journal.append({
        type: "execution_plan.rejected",
        scope: runScope(run, { invocationId }),
        subjectType: "execution_plan_revision",
        subjectId: `${run.id}:${currentRevisionNumber}`,
        payload: { runId: run.id, proposedByInvocationId: invocationId, currentRevisionNumber, reasons },
        actor: meta.actor ?? { kind: "invocation", invocationId },
        correlationId: meta.correlationId ?? null,
        causationSeq: meta.causationSeq ?? null,
      }),
    );
    return { accepted: false, reasons, currentRevisionNumber, eventSeq: event.seq };
  }
}

function reasonOf(error: unknown, fallback: PlanRejectionCode): PlanRejectionReason {
  if (error instanceof DomainError && error instanceof ValidationError) {
    const code = error.details.code;
    const path = error.details.path;
    return {
      code: typeof code === "string" && (PLAN_REJECTION_CODES as readonly string[]).includes(code) ? (code as PlanRejectionCode) : fallback,
      message: error.message,
      path: typeof path === "string" && path.length > 0 ? path : null,
    };
  }
  throw error;
}

function describe(allocation: Allocation): string {
  return `${allocation.costUsd} USD / ${allocation.tokens} tokens / ${allocation.attempts} attempts`;
}
