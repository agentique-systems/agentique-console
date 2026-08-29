import { and, asc, eq, inArray } from "drizzle-orm";
import {
  assertPlanNodeTransition,
  ConflictError,
  executionPlanRevisionSchema,
  InvariantViolationError,
  parseOrThrow,
  PLAN_NODE_MACHINE,
  planEdgeSchema,
  planNodeRequirementSchema,
  planNodeSchema,
  planNodeTransitionEventType,
  RUN_MACHINE,
  validateExecutionPlanSource,
  ValidationError,
  ZERO_ALLOCATION,
  type ArtifactId,
  type ExecutionPlanRevision,
  type InvocationId,
  type PlanEdge,
  type PlanLimits,
  type PlanNode,
  type PlanNodeId,
  type PlanNodeRequirement,
  type PlanNodeStatus,
  type PlanNodeWaitReason,
  type RequirementId,
  type RequirementRevisionId,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import {
  artifacts,
  executionPlanRevisions,
  invocations,
  planEdges,
  planNodeRequirements,
  planNodes,
  requirementRevisions,
  requirements,
} from "../schema.ts";
import type { BudgetReservationStore } from "./budgets.ts";
import { assertSameConversation, assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";
import type { UsageStore } from "./usage.ts";

type NodeRow = typeof planNodes.$inferSelect;
type EdgeRow = typeof planEdges.$inferSelect;

function nodeToDomain(row: NodeRow): PlanNode {
  const base = {
    id: row.id,
    runId: row.runId,
    revisionNumber: row.revisionNumber,
    title: row.title,
    sourcePath: row.sourcePath,
    status: row.status,
    waitReason: row.waitReason,
    allocation: { costUsd: row.allocCostUsd, tokens: row.allocTokens, attempts: row.allocAttempts },
    maxConcurrency: row.maxConcurrency,
    maxWallClockMs: row.maxWallClockMs,
    runOnDependencyFailure: row.runOnDependencyFailure,
    outputArtifactIds: row.outputArtifactIds,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
  const value =
    row.kind === "join"
      ? { ...base, kind: "join", fanInPolicy: row.fanInPolicy }
      : {
          ...base,
          kind: "pattern",
          pattern: row.pattern,
          input: row.input,
          agents: row.agents,
          bounds: row.bounds,
          onAllocationExhausted: row.onAllocationExhausted,
          gateAcceptanceCriterionIds: row.gateAcceptanceCriterionIds,
        };
  return parseOrThrow(planNodeSchema, value, "PlanNode row");
}

function nodeToRow(node: PlanNode): NodeRow {
  return {
    id: node.id,
    runId: node.runId,
    revisionNumber: node.revisionNumber,
    kind: node.kind,
    pattern: node.kind === "pattern" ? node.pattern : null,
    title: node.title,
    sourcePath: node.sourcePath,
    status: node.status,
    waitReason: node.waitReason,
    fanInPolicy: node.kind === "join" ? node.fanInPolicy : null,
    input: node.kind === "pattern" ? node.input : null,
    agents: node.kind === "pattern" ? node.agents : null,
    allocCostUsd: node.allocation.costUsd,
    allocTokens: node.allocation.tokens,
    allocAttempts: node.allocation.attempts,
    maxConcurrency: node.maxConcurrency,
    maxWallClockMs: node.maxWallClockMs,
    bounds: node.kind === "pattern" ? node.bounds : null,
    onAllocationExhausted: node.kind === "pattern" ? node.onAllocationExhausted : null,
    runOnDependencyFailure: node.runOnDependencyFailure,
    gateAcceptanceCriterionIds: node.kind === "pattern" ? node.gateAcceptanceCriterionIds : null,
    outputArtifactIds: node.outputArtifactIds,
    createdAt: node.createdAt,
    startedAt: node.startedAt,
    endedAt: node.endedAt,
  };
}

function edgeToDomain(row: EdgeRow): PlanEdge {
  const base = {
    id: row.id,
    runId: row.runId,
    sourceNodeId: row.sourceNodeId,
    targetNodeId: row.targetNodeId,
    position: row.position,
    createdAt: row.createdAt,
  };
  const value =
    row.type === "branch"
      ? { ...base, type: "branch", label: row.label }
      : row.type === "retry"
        ? { ...base, type: "retry", round: row.round }
        : { ...base, type: row.type };
  return parseOrThrow(planEdgeSchema, value, "PlanEdge row");
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A compiled node as the compiler hands it over: everything but status and timestamps. */
export type CompiledPlanNode = DistributiveOmit<PlanNode, "status" | "waitReason" | "outputArtifactIds" | "createdAt" | "startedAt" | "endedAt">;

export type CompiledPlanEdge = DistributiveOmit<PlanEdge, "id" | "runId" | "createdAt">;

export interface CompiledPlanRequirement {
  planNodeId: PlanNodeId;
  requirementId: RequirementId;
  requirementRevisionId: RequirementRevisionId;
}

export interface CompiledGraph {
  runId: RunId;
  revisionNumber: number;
  nodes: CompiledPlanNode[];
  edges: CompiledPlanEdge[];
  requirements: CompiledPlanRequirement[];
}

export type PlanNodeTransition =
  | { to: "ready" }
  | { to: "running" }
  | { to: "waiting"; waitReason: PlanNodeWaitReason }
  | { to: "succeeded"; outputArtifactIds: ArtifactId[] }
  | { to: "failed" }
  | { to: "cancelled" }
  | { to: "skipped" };

/**
 * Execution Plan persistence: immutable source revisions and the compiled
 * graph (nodes, typed edges, exact pinned Requirement scope). The compiler
 * (Phase 2) produces the graph; this store validates its shape, reserves
 * every pattern node's allocation atomically, and never edits a node's
 * definition after insertion.
 */
export class ExecutionPlanStore {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly reservations: BudgetReservationStore,
    private readonly usage: UsageStore,
    private readonly limits?: PlanLimits,
  ) {}

  appendRevision(runId: RunId, source: unknown, proposedByInvocationId: InvocationId | null, options?: WriteOptions): ExecutionPlanRevision {
    const validSource = validateExecutionPlanSource(source, this.limits);
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, runId);
      if (RUN_MACHINE.isTerminal(run.status)) {
        throw new ConflictError(`Run ${runId} has ended; its Execution Plan cannot be revised`);
      }
      if (proposedByInvocationId !== null) {
        const invocation = requireRow(
          this.ctx.db.select({ runId: invocations.runId, role: invocations.role }).from(invocations).where(eq(invocations.id, proposedByInvocationId)).get(),
          "Invocation",
          proposedByInvocationId,
        );
        assertSameRun("Invocation", proposedByInvocationId, invocation.runId, runId);
        if (invocation.role !== "orchestrator") {
          throw new InvariantViolationError("only the Orchestrator revises the source Execution Plan", { role: invocation.role });
        }
      }
      const last = this.ctx.db
        .select({ number: executionPlanRevisions.number })
        .from(executionPlanRevisions)
        .where(eq(executionPlanRevisions.runId, runId))
        .orderBy(asc(executionPlanRevisions.number))
        .all()
        .at(-1);
      const revision: ExecutionPlanRevision = {
        runId,
        number: (last?.number ?? 0) + 1,
        source: validSource,
        proposedByInvocationId,
        createdAt: this.ctx.clock(),
      };
      parseOrThrow(executionPlanRevisionSchema, revision, "ExecutionPlanRevision");
      this.ctx.journal.append({
        type: "execution_plan.revised",
        scope: runScope(run, { invocationId: proposedByInvocationId }),
        subjectType: "execution_plan_revision",
        subjectId: `${runId}:${revision.number}`,
        payload: revision,
        ...writeMeta(options, proposedByInvocationId ? { kind: "invocation", invocationId: proposedByInvocationId } : undefined),
      });
      this.ctx.db.insert(executionPlanRevisions).values(revision).run();
      return revision;
    });
  }

  getRevision(runId: RunId, number: number): ExecutionPlanRevision {
    const row = requireRow(
      this.ctx.db.select().from(executionPlanRevisions).where(and(eq(executionPlanRevisions.runId, runId), eq(executionPlanRevisions.number, number))).get(),
      "ExecutionPlanRevision",
      `${runId}:${number}`,
    );
    return parseOrThrow(executionPlanRevisionSchema, row, "ExecutionPlanRevision row");
  }

  listRevisions(runId: RunId): ExecutionPlanRevision[] {
    return this.ctx.db
      .select()
      .from(executionPlanRevisions)
      .where(eq(executionPlanRevisions.runId, runId))
      .orderBy(asc(executionPlanRevisions.number))
      .all()
      .map((row) => parseOrThrow(executionPlanRevisionSchema, row, "ExecutionPlanRevision row"));
  }

  /**
   * Persists a compiled graph in one transaction: nodes (`pending`), edges,
   * scope rows, and one Run→Plan Node reservation per pattern node. Rejects
   * join nodes with a Pattern or scope, pattern nodes without a Pattern,
   * edges that cross Runs or loop, fan-in edges into non-join nodes,
   * non-fan-in edges into join nodes, duplicate edges, and cycles.
   */
  insertCompiledGraph(graph: CompiledGraph, options?: WriteOptions): { nodes: PlanNode[]; edges: PlanEdge[]; requirements: PlanNodeRequirement[] } {
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, graph.runId);
      if (RUN_MACHINE.isTerminal(run.status)) throw new ConflictError(`Run ${graph.runId} has ended`);
      this.getRevision(graph.runId, graph.revisionNumber);
      const now = this.ctx.clock();

      const nodes: PlanNode[] = graph.nodes.map((compiled) => {
        if (compiled.runId !== graph.runId) throw new InvariantViolationError(`PlanNode ${compiled.id} names another Run`);
        const node = {
          ...compiled,
          status: "pending",
          waitReason: null,
          outputArtifactIds: null,
          createdAt: now,
          startedAt: null,
          endedAt: null,
        } as PlanNode;
        return parseOrThrow(planNodeSchema, node, `PlanNode ${compiled.id}`);
      });
      const nodeById = new Map<PlanNodeId, PlanNode>();
      for (const node of nodes) {
        if (nodeById.has(node.id)) throw new ValidationError(`PlanNode ${node.id} appears twice`);
        nodeById.set(node.id, node);
      }
      const existingNodes = new Map(this.listNodes(graph.runId).map((n) => [n.id, n] as const));
      const resolveNode = (id: PlanNodeId): PlanNode => {
        const node = nodeById.get(id) ?? existingNodes.get(id);
        if (!node) throw new ValidationError(`PlanEdge references unknown PlanNode ${id}`);
        return node;
      };

      const edges: PlanEdge[] = graph.edges.map((compiled) => {
        const edge = parseOrThrow(planEdgeSchema, { ...compiled, id: this.ctx.ids("planEdge"), runId: graph.runId, createdAt: now }, "PlanEdge");
        const target = resolveNode(edge.targetNodeId);
        resolveNode(edge.sourceNodeId);
        if (edge.type === "fan_in" && target.kind !== "join") {
          throw new ValidationError(`fan_in edge into ${target.id} requires a join node`);
        }
        if (edge.type !== "fan_in" && target.kind === "join") {
          throw new ValidationError(`join node ${target.id} accepts only fan_in edges`);
        }
        return edge;
      });
      const seenEdges = new Set<string>();
      const existingEdges = this.listEdges(graph.runId);
      for (const edge of [...existingEdges, ...edges]) {
        const key = [edge.sourceNodeId, edge.targetNodeId, edge.type, "label" in edge ? edge.label : "", "round" in edge ? edge.round : 0].join("|");
        if (seenEdges.has(key)) throw new ValidationError(`duplicate PlanEdge ${edge.sourceNodeId} -> ${edge.targetNodeId} (${edge.type})`);
        seenEdges.add(key);
      }
      assertAcyclic([...existingEdges, ...edges]);

      const scopeRows: PlanNodeRequirement[] = graph.requirements.map((row) => {
        const node = nodeById.get(row.planNodeId);
        if (!node) throw new ValidationError(`scope row names PlanNode ${row.planNodeId}, which is not in this graph`);
        if (node.kind === "join") throw new ValidationError(`join node ${node.id} has no Requirement scope`);
        return parseOrThrow(planNodeRequirementSchema, { ...row, runId: graph.runId }, "PlanNodeRequirement");
      });
      const scopeKeys = new Set<string>();
      for (const row of scopeRows) {
        const key = `${row.planNodeId}|${row.requirementId}|${row.requirementRevisionId}`;
        if (scopeKeys.has(key)) throw new ValidationError(`duplicate scope row ${key}`);
        scopeKeys.add(key);
      }
      this.assertScopeOwnership(scopeRows, run.conversationId);

      this.ctx.journal.append({
        type: "execution_plan.compiled",
        scope: runScope(run),
        subjectType: "execution_plan_revision",
        subjectId: `${graph.runId}:${graph.revisionNumber}`,
        payload: { runId: graph.runId, revisionNumber: graph.revisionNumber, nodes, edges, requirements: scopeRows },
        ...writeMeta(options),
      });
      for (const node of nodes) {
        this.ctx.journal.append({
          type: "plan_node.created",
          scope: runScope(run, { planNodeId: node.id }),
          subjectType: "plan_node",
          subjectId: node.id,
          payload: node,
          ...writeMeta(options),
        });
        this.ctx.db.insert(planNodes).values(nodeToRow(node)).run();
      }
      for (const edge of edges) {
        this.ctx.db
          .insert(planEdges)
          .values({
            id: edge.id,
            runId: edge.runId,
            sourceNodeId: edge.sourceNodeId,
            targetNodeId: edge.targetNodeId,
            type: edge.type,
            label: edge.type === "branch" ? edge.label : null,
            round: edge.type === "retry" ? edge.round : null,
            position: edge.position,
            createdAt: edge.createdAt,
          })
          .run();
      }
      if (scopeRows.length > 0) this.ctx.db.insert(planNodeRequirements).values(scopeRows).run();
      // Allocation is reserved atomically with the nodes; a join reserves nothing.
      for (const node of nodes) {
        if (node.kind === "pattern") {
          this.reservations.reserve(
            { runId: graph.runId, parent: { type: "run", id: graph.runId }, child: { type: "plan_node", id: node.id }, amount: node.allocation },
            options,
          );
        }
      }
      return { nodes, edges, requirements: scopeRows };
    });
  }

  getNode(id: PlanNodeId): PlanNode {
    return nodeToDomain(requireRow(this.ctx.db.select().from(planNodes).where(eq(planNodes.id, id)).get(), "PlanNode", id));
  }

  listNodes(runId: RunId): PlanNode[] {
    return this.ctx.db.select().from(planNodes).where(eq(planNodes.runId, runId)).orderBy(asc(planNodes.createdAt), asc(planNodes.id)).all().map(nodeToDomain);
  }

  listEdges(runId: RunId): PlanEdge[] {
    return this.ctx.db.select().from(planEdges).where(eq(planEdges.runId, runId)).orderBy(asc(planEdges.position), asc(planEdges.id)).all().map(edgeToDomain);
  }

  listScope(planNodeId: PlanNodeId): PlanNodeRequirement[] {
    return this.ctx.db
      .select()
      .from(planNodeRequirements)
      .where(eq(planNodeRequirements.planNodeId, planNodeId))
      .all()
      .map((row) => parseOrThrow(planNodeRequirementSchema, row, "PlanNodeRequirement row"));
  }

  /** One indexed primary-key lookup; no ancestor walk. */
  isInScope(planNodeId: PlanNodeId, requirementId: RequirementId, requirementRevisionId: RequirementRevisionId): boolean {
    return (
      this.ctx.db
        .select({ planNodeId: planNodeRequirements.planNodeId })
        .from(planNodeRequirements)
        .where(
          and(
            eq(planNodeRequirements.planNodeId, planNodeId),
            eq(planNodeRequirements.requirementId, requirementId),
            eq(planNodeRequirements.requirementRevisionId, requirementRevisionId),
          ),
        )
        .get() !== undefined
    );
  }

  transitionNode(id: PlanNodeId, transition: PlanNodeTransition, options?: WriteOptions): PlanNode {
    return this.ctx.tx.write(() => {
      const current = this.getNode(id);
      assertPlanNodeTransition(current, transition.to);
      const run = loadRunRef(this.ctx, current.runId);
      const now = this.ctx.clock();
      const next: PlanNode = { ...current, status: transition.to, waitReason: null };
      let payload: unknown = { from: current.status, to: transition.to, reason: null };
      switch (transition.to) {
        case "running":
          next.startedAt = current.startedAt ?? now;
          break;
        case "waiting":
          next.waitReason = transition.waitReason;
          payload = { from: current.status, to: "waiting", waitReason: transition.waitReason };
          break;
        case "succeeded": {
          if (transition.outputArtifactIds.length > 0) {
            const rows = this.ctx.db.select({ id: artifacts.id, runId: artifacts.runId }).from(artifacts).where(inArray(artifacts.id, transition.outputArtifactIds)).all();
            for (const artifactId of transition.outputArtifactIds) {
              const row = rows.find((r) => r.id === artifactId);
              if (!row) throw new ValidationError(`output Artifact ${artifactId} does not exist`);
              assertSameRun("Artifact", artifactId, row.runId, current.runId);
            }
          }
          next.outputArtifactIds = transition.outputArtifactIds;
          payload = { from: current.status, to: "succeeded", outputArtifactIds: transition.outputArtifactIds };
          break;
        }
        default:
          break;
      }
      if (PLAN_NODE_MACHINE.isTerminal(next.status)) next.endedAt = now;
      parseOrThrow(planNodeSchema, next, "PlanNode");
      this.ctx.journal.append({
        type: planNodeTransitionEventType(current.status, transition.to),
        scope: runScope(run, { planNodeId: id }),
        subjectType: "plan_node",
        subjectId: id,
        payload: payload as never,
        ...writeMeta(options),
      });
      this.ctx.db
        .update(planNodes)
        .set({
          status: next.status,
          waitReason: next.waitReason,
          outputArtifactIds: next.outputArtifactIds,
          startedAt: next.startedAt,
          endedAt: next.endedAt,
        })
        .where(eq(planNodes.id, id))
        .run();
      if (PLAN_NODE_MACHINE.isTerminal(next.status) && next.kind === "pattern") {
        const reservation = this.reservations.activeForChild({ type: "plan_node", id });
        if (reservation) {
          const consumed = this.usage.consumedByPlanNode(id);
          this.reservations.release(
            reservation.id,
            transition.to === "cancelled" ? "plan_revision_cancelled" : "child_terminal",
            {
              costUsd: Math.min(consumed.costUsd, reservation.reserved.costUsd),
              tokens: Math.min(consumed.tokens, reservation.reserved.tokens),
              attempts: Math.min(consumed.attempts, reservation.reserved.attempts),
            },
            options,
          );
        }
      }
      return next;
    });
  }

  private assertScopeOwnership(rows: PlanNodeRequirement[], conversationId: string): void {
    if (rows.length === 0) return;
    const requirementIds = [...new Set(rows.map((r) => r.requirementId))];
    const revisionIds = [...new Set(rows.map((r) => r.requirementRevisionId))];
    const reqRows = this.ctx.db.select({ id: requirements.id, conversationId: requirements.conversationId }).from(requirements).where(inArray(requirements.id, requirementIds)).all();
    const revRows = this.ctx.db.select({ id: requirementRevisions.id, conversationId: requirementRevisions.conversationId, tree: requirementRevisions.tree }).from(requirementRevisions).where(inArray(requirementRevisions.id, revisionIds)).all();
    for (const row of rows) {
      const requirement = reqRows.find((r) => r.id === row.requirementId);
      if (!requirement) throw new ValidationError(`scope Requirement ${row.requirementId} does not exist`);
      assertSameConversation("Requirement", row.requirementId, requirement.conversationId, conversationId);
      const revision = revRows.find((r) => r.id === row.requirementRevisionId);
      if (!revision) throw new ValidationError(`scope revision ${row.requirementRevisionId} does not exist`);
      assertSameConversation("RequirementRevision", row.requirementRevisionId, revision.conversationId, conversationId);
      const entry = revision.tree.find((e) => e.id === row.requirementId);
      if (!entry) throw new ValidationError(`Requirement ${row.requirementId} does not exist at revision ${row.requirementRevisionId}`);
      if (revision.tree.some((e) => e.parentId === row.requirementId)) {
        throw new ValidationError(`Requirement ${row.requirementId} is not a leaf at revision ${row.requirementRevisionId}`);
      }
    }
  }
}

function assertAcyclic(edges: ReadonlyArray<Pick<PlanEdge, "sourceNodeId" | "targetNodeId">>): void {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.sourceNodeId) ?? [];
    list.push(edge.targetNodeId);
    adjacency.set(edge.sourceNodeId, list);
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (node: string): void => {
    const current = state.get(node);
    if (current === "done") return;
    if (current === "visiting") throw new ValidationError(`the compiled Execution Plan contains a cycle through ${node}`);
    state.set(node, "visiting");
    for (const next of adjacency.get(node) ?? []) visit(next);
    state.set(node, "done");
  };
  for (const node of adjacency.keys()) visit(node);
}
