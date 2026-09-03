import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  assertPlanNodeTransition,
  ConflictError,
  executionPlanRevisionSchema,
  InvariantViolationError,
  parseOrThrow,
  PLAN_NODE_MACHINE,
  planEdgeSchema,
  planNodeDefinitionSchema,
  planNodeRequirementRows,
  planNodeRequirementSchema,
  planNodeSchema,
  planNodeTransitionEventType,
  planRevisionNodeSchema,
  ROOT_SOURCE_PATH,
  RUN_MACHINE,
  validateExecutionPlanSource,
  ValidationError,
  type ArtifactId,
  type ExecutionPlanRevision,
  type ExecutionPlanSource,
  type InvocationId,
  type PlanEdge,
  type PlanEdgeId,
  type PlanEdgeType,
  type PlanGraph,
  type PlanLimits,
  type PlanNode,
  type PlanNodeDefinition,
  type PlanNodeFailureReason,
  type PlanNodeId,
  type PlanNodeRequirement,
  type PlanNodeScope,
  type PlanNodeWaitReason,
  type PlanRevisionNode,
  type RequirementId,
  type RequirementRevisionId,
  type ReservationReleaseReason,
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
  planRevisionNodes,
  requirementRevisions,
  requirements,
} from "../schema.ts";
import type { BudgetReservationStore } from "./budgets.ts";
import { assertSameConversation, assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";
import { keysetOrder, keysetWhere, type KeysetQuery } from "./paging.ts";
import type { UsageStore } from "./usage.ts";

type NodeRow = typeof planNodes.$inferSelect;
type EdgeRow = typeof planEdges.$inferSelect;
type ScopeRow = typeof planNodeRequirements.$inferSelect;

function scopeOfRows(rows: ScopeRow[]): PlanNodeScope | null {
  if (rows.length === 0) return null;
  const ordered = [...rows].sort((a, b) => a.position - b.position);
  return {
    requirementRevisionId: ordered[0]!.requirementRevisionId as RequirementRevisionId,
    requirementIds: ordered.map((r) => r.requirementId as RequirementId),
  };
}

function nodeToDomain(row: NodeRow, scopeRows: ScopeRow[]): PlanNode {
  const base = {
    id: row.id,
    runId: row.runId,
    createdInRevisionNumber: row.createdInRevisionNumber,
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
          shape: row.shape,
          input: row.input,
          onAllocationExhausted: row.onAllocationExhausted,
          gateAcceptanceCriterionIds: row.gateAcceptanceCriterionIds,
          scope: scopeOfRows(scopeRows),
        };
  return parseOrThrow(planNodeSchema, value, "PlanNode row");
}

function nodeToRow(node: PlanNode): NodeRow {
  return {
    id: node.id,
    runId: node.runId,
    createdInRevisionNumber: node.createdInRevisionNumber,
    kind: node.kind,
    pattern: node.kind === "pattern" ? node.pattern : null,
    title: node.title,
    sourcePath: node.sourcePath,
    status: node.status,
    waitReason: node.waitReason,
    fanInPolicy: node.kind === "join" ? node.fanInPolicy : null,
    input: node.kind === "pattern" ? node.input : null,
    shape: node.kind === "pattern" ? node.shape : null,
    allocCostUsd: node.allocation.costUsd,
    allocTokens: node.allocation.tokens,
    allocAttempts: node.allocation.attempts,
    maxConcurrency: node.maxConcurrency,
    maxWallClockMs: node.maxWallClockMs,
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
    revisionNumber: row.revisionNumber,
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

/** An edge of a revision as the compiler and reconciler hand it over. */
export interface RevisionEdgeInput {
  sourceNodeId: PlanNodeId;
  targetNodeId: PlanNodeId;
  type: PlanEdgeType;
  label?: string;
  round?: number;
  /** Fan-in order among edges into the same target, from 0. */
  position: number;
}

/** A node to create in a revision: its id (minted by the caller) and immutable definition. */
export interface RevisionNodeInput {
  id: PlanNodeId;
  definition: PlanNodeDefinition;
}

/**
 * The materialization of one accepted revision after reconciliation: the
 * ordered membership (reused existing nodes and new nodes, root first), the
 * new nodes to create, and the revision's edges. Nodes the reconciler
 * cancelled have been cancelled before this is applied; their ids are
 * recorded here for the `execution_plan.compiled` Event only.
 */
export interface RevisionMaterialization {
  runId: RunId;
  revisionNumber: number;
  membership: PlanNodeId[];
  createdNodes: RevisionNodeInput[];
  edges: RevisionEdgeInput[];
  cancelledNodeIds: PlanNodeId[];
}

/** Who or what cancelled a node; `invocation_cancelled` is the runtime ending a node whose Invocation was cancelled. */
export type PlanNodeCancellationReason = "plan_revision" | "orchestrator" | "operator" | "run_cancelled" | "invocation_cancelled";

export type PlanNodeTransition =
  | { to: "ready" }
  | { to: "running" }
  | { to: "waiting"; waitReason: PlanNodeWaitReason }
  | { to: "succeeded"; outputArtifactIds: ArtifactId[] }
  /** `artifactIds`: runtime index Artifacts recorded with a fan-in failure (a join or parallel index), for diagnosis. */
  | { to: "failed"; reason: PlanNodeFailureReason; artifactIds?: ArtifactId[] }
  | { to: "cancelled"; reason: PlanNodeCancellationReason }
  | { to: "skipped" };

function releaseReasonOf(reason: PlanNodeCancellationReason): ReservationReleaseReason {
  switch (reason) {
    case "plan_revision":
      return "plan_revision_cancelled";
    case "run_cancelled":
      return "run_cancelled";
    case "orchestrator":
    case "operator":
    case "invocation_cancelled":
      return "child_terminal";
  }
}

/**
 * Execution Plan persistence: immutable accepted source revisions, the
 * explicit ordered membership of every revision, revision-owned edges, and
 * Plan Nodes with their exact pinned Requirement scope. The plan-revision
 * service compiles and reconciles; this store validates the shape of what it
 * is handed, persists one revision atomically with its reservations and
 * Events, never edits a node's definition after insertion, and answers the
 * scheduler's graph queries from membership rows alone.
 */
export class ExecutionPlanStore {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly reservations: BudgetReservationStore,
    private readonly usage: UsageStore,
    private readonly limits?: PlanLimits,
  ) {}

  // -------------------------------------------------------------------------
  // Source revisions
  // -------------------------------------------------------------------------

  /**
   * Appends an accepted source revision numbered consecutively after the
   * latest one and journals `execution_plan.revised`. Callers apply the
   * compiled revision in the same root transaction with `materializeRevision`.
   */
  appendRevision(runId: RunId, source: unknown, proposedByInvocationId: InvocationId | null, options?: WriteOptions): ExecutionPlanRevision {
    const validSource = validateExecutionPlanSource(source, this.limits);
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, runId);
      if (RUN_MACHINE.isTerminal(run.status)) {
        throw new ConflictError(`Run ${runId} has ended; its Execution Plan cannot be revised`);
      }
      if (proposedByInvocationId !== null) this.assertOrchestratorInvocation(runId, proposedByInvocationId);
      const revision: ExecutionPlanRevision = {
        runId,
        number: this.latestRevisionNumber(runId) + 1,
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

  /** Throws unless the Invocation is an Orchestrator Invocation of this Run. */
  assertOrchestratorInvocation(runId: RunId, invocationId: InvocationId): void {
    const invocation = requireRow(
      this.ctx.db.select({ runId: invocations.runId, role: invocations.role }).from(invocations).where(eq(invocations.id, invocationId)).get(),
      "Invocation",
      invocationId,
    );
    assertSameRun("Invocation", invocationId, invocation.runId, runId);
    if (invocation.role !== "orchestrator") {
      throw new InvariantViolationError("only the Orchestrator revises the source Execution Plan", { role: invocation.role });
    }
  }

  getRevision(runId: RunId, number: number): ExecutionPlanRevision {
    const row = requireRow(
      this.ctx.db.select().from(executionPlanRevisions).where(and(eq(executionPlanRevisions.runId, runId), eq(executionPlanRevisions.number, number))).get(),
      "ExecutionPlanRevision",
      `${runId}:${number}`,
    );
    return parseOrThrow(executionPlanRevisionSchema, row, "ExecutionPlanRevision row");
  }

  /** One keyset page of a Run's accepted revisions by number. */
  pageRevisions(runId: RunId, query: KeysetQuery): ExecutionPlanRevision[] {
    const key = [executionPlanRevisions.number];
    return this.ctx.db
      .select()
      .from(executionPlanRevisions)
      .where(and(eq(executionPlanRevisions.runId, runId), keysetWhere(key, query)))
      .orderBy(...keysetOrder(key, query))
      .limit(query.limit)
      .all()
      .map((row) => parseOrThrow(executionPlanRevisionSchema, row, "ExecutionPlanRevision row"));
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

  /** The number of the latest accepted revision; 0 before the first. */
  latestRevisionNumber(runId: RunId): number {
    const row = this.ctx.db
      .select({ number: executionPlanRevisions.number })
      .from(executionPlanRevisions)
      .where(eq(executionPlanRevisions.runId, runId))
      .orderBy(asc(executionPlanRevisions.number))
      .all()
      .at(-1);
    return row?.number ?? 0;
  }

  /** The latest accepted revision; every Run has one from creation. */
  latestRevision(runId: RunId): ExecutionPlanRevision {
    const number = this.latestRevisionNumber(runId);
    if (number === 0) throw new InvariantViolationError(`Run ${runId} has no accepted Execution Plan revision`);
    return this.getRevision(runId, number);
  }

  /** The source of the latest accepted revision, for reconciliation and the Orchestrator's reads. */
  currentSource(runId: RunId): ExecutionPlanSource {
    return this.latestRevision(runId).source;
  }

  // -------------------------------------------------------------------------
  // Materialization
  // -------------------------------------------------------------------------

  /**
   * Persists one accepted revision's compiled graph in the enclosing root
   * transaction: new nodes (`pending`) with their scope rows and Run→Plan Node
   * reservations, the revision's immutable membership, its edges, and the
   * `execution_plan.compiled` and `plan_node.created` Events. Validates that
   * the membership starts with the root node, that every edge joins two
   * members, that fan-in edges target joins and joins receive only fan-in,
   * that the revision graph is acyclic, that source paths are unique within
   * the membership, and that every scope row names an existing leaf
   * Requirement of the Run's Conversation at its pinned revision.
   */
  materializeRevision(input: RevisionMaterialization, options?: WriteOptions): PlanGraph {
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, input.runId);
      if (RUN_MACHINE.isTerminal(run.status)) throw new ConflictError(`Run ${input.runId} has ended`);
      this.getRevision(input.runId, input.revisionNumber);
      if (this.listMembership(input.runId, input.revisionNumber).length > 0) {
        throw new ConflictError(`revision ${input.revisionNumber} of Run ${input.runId} is already materialized`);
      }
      const now = this.ctx.clock();

      const existing = new Map(this.listNodes(input.runId).map((n) => [n.id, n] as const));
      const created = new Map<PlanNodeId, PlanNode>();
      for (const { id, definition } of input.createdNodes) {
        if (existing.has(id) || created.has(id)) throw new ValidationError(`PlanNode ${id} already exists`);
        const valid = parseOrThrow(planNodeDefinitionSchema, definition, `PlanNode ${id} definition`);
        const node = {
          ...valid,
          id,
          runId: input.runId,
          createdInRevisionNumber: input.revisionNumber,
          status: "pending",
          waitReason: null,
          outputArtifactIds: null,
          createdAt: now,
          startedAt: null,
          endedAt: null,
        } as PlanNode;
        created.set(id, parseOrThrow(planNodeSchema, node, `PlanNode ${id}`));
      }

      const memberIds = new Set<PlanNodeId>();
      const members: PlanNode[] = input.membership.map((id) => {
        if (memberIds.has(id)) throw new ValidationError(`PlanNode ${id} appears twice in the membership`);
        memberIds.add(id);
        const node = created.get(id) ?? existing.get(id);
        if (!node) throw new ValidationError(`membership names unknown PlanNode ${id}`);
        return node;
      });
      for (const id of created.keys()) {
        if (!memberIds.has(id)) throw new ValidationError(`created PlanNode ${id} is not a member of revision ${input.revisionNumber}`);
      }
      if (members.length === 0 || members[0]!.sourcePath !== ROOT_SOURCE_PATH) {
        throw new InvariantViolationError("every accepted revision's membership begins with the root Orchestrator node");
      }
      const paths = new Set<string>();
      for (const member of members) {
        if (paths.has(member.sourcePath)) throw new ValidationError(`source path ${member.sourcePath} is held by two members of the revision`);
        paths.add(member.sourcePath);
      }
      for (const id of input.cancelledNodeIds) {
        const node = existing.get(id);
        if (!node) throw new ValidationError(`cancelled PlanNode ${id} does not exist`);
        if (node.status !== "cancelled") throw new InvariantViolationError(`PlanNode ${id} is reported cancelled but is ${node.status}`);
        if (memberIds.has(id)) throw new InvariantViolationError(`cancelled PlanNode ${id} cannot be a member of the new revision`);
      }

      const memberById = new Map(members.map((m) => [m.id, m] as const));
      const edges: PlanEdge[] = input.edges.map((compiled) => {
        const edge = parseOrThrow(
          planEdgeSchema,
          {
            id: this.ctx.ids("planEdge"),
            runId: input.runId,
            revisionNumber: input.revisionNumber,
            sourceNodeId: compiled.sourceNodeId,
            targetNodeId: compiled.targetNodeId,
            position: compiled.position,
            createdAt: now,
            type: compiled.type,
            ...(compiled.type === "branch" ? { label: compiled.label } : {}),
            ...(compiled.type === "retry" ? { round: compiled.round } : {}),
          },
          "PlanEdge",
        );
        const source = memberById.get(edge.sourceNodeId);
        const target = memberById.get(edge.targetNodeId);
        if (!source) throw new ValidationError(`PlanEdge source ${edge.sourceNodeId} is not a member of the revision`);
        if (!target) throw new ValidationError(`PlanEdge target ${edge.targetNodeId} is not a member of the revision`);
        if (edge.type === "fan_in" && target.kind !== "join") throw new ValidationError(`fan_in edge into ${target.id} requires a join node`);
        if (edge.type !== "fan_in" && target.kind === "join") throw new ValidationError(`join node ${target.id} accepts only fan_in edges`);
        if (target.sourcePath === ROOT_SOURCE_PATH) throw new InvariantViolationError("the root node has no predecessors");
        return edge;
      });
      const seenEdges = new Set<string>();
      const positionsByTarget = new Map<PlanNodeId, number[]>();
      for (const edge of edges) {
        const key = [edge.sourceNodeId, edge.targetNodeId, edge.type, "label" in edge ? edge.label : "", "round" in edge ? edge.round : 0].join("|");
        if (seenEdges.has(key)) throw new ValidationError(`duplicate PlanEdge ${edge.sourceNodeId} -> ${edge.targetNodeId} (${edge.type})`);
        seenEdges.add(key);
        const list = positionsByTarget.get(edge.targetNodeId) ?? [];
        list.push(edge.position);
        positionsByTarget.set(edge.targetNodeId, list);
      }
      for (const [target, positions] of positionsByTarget) {
        const sorted = [...positions].sort((a, b) => a - b);
        sorted.forEach((p, i) => {
          if (p !== i) throw new ValidationError(`edges into ${target} must be positioned 0..${positions.length - 1}`);
        });
      }
      assertAcyclic(edges);

      const scopeRows: PlanNodeRequirement[] = [];
      for (const node of created.values()) {
        if (node.kind === "pattern") {
          for (const row of planNodeRequirementRows(node)) scopeRows.push(parseOrThrow(planNodeRequirementSchema, row, "PlanNodeRequirement"));
        }
      }
      this.assertScopeOwnership(scopeRows, run.conversationId);

      const membership: PlanRevisionNode[] = members.map((node, position) =>
        parseOrThrow(planRevisionNodeSchema, { runId: input.runId, revisionNumber: input.revisionNumber, planNodeId: node.id, position }, "PlanRevisionNode"),
      );
      const allScopeRows = this.scopeRowsOf(members.map((m) => m.id));

      this.ctx.journal.append({
        type: "execution_plan.compiled",
        scope: runScope(run),
        subjectType: "execution_plan_revision",
        subjectId: `${input.runId}:${input.revisionNumber}`,
        payload: {
          runId: input.runId,
          revisionNumber: input.revisionNumber,
          membership,
          nodes: members,
          edges,
          requirements: [...allScopeRows, ...scopeRows],
          createdNodeIds: [...created.keys()],
          reusedNodeIds: members.filter((m) => !created.has(m.id)).map((m) => m.id),
          cancelledNodeIds: input.cancelledNodeIds,
        },
        ...writeMeta(options),
      });
      for (const node of created.values()) {
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
      if (scopeRows.length > 0) this.ctx.db.insert(planNodeRequirements).values(scopeRows).run();
      this.ctx.db.insert(planRevisionNodes).values(membership).run();
      for (const edge of edges) {
        this.ctx.db
          .insert(planEdges)
          .values({
            id: edge.id,
            runId: edge.runId,
            revisionNumber: edge.revisionNumber,
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
      // Allocation is reserved atomically with the new nodes from ordinary
      // Run capacity; a reused node keeps its reservation and a join reserves nothing.
      for (const node of created.values()) {
        if (node.kind === "pattern") {
          this.reservations.reserveOrdinary(
            { runId: input.runId, parent: { type: "run", id: input.runId }, child: { type: "plan_node", id: node.id }, amount: node.allocation },
            options,
          );
        }
      }
      return { runId: input.runId, revisionNumber: input.revisionNumber, nodes: members, edges: sortEdges(edges, membership) };
    });
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getNode(id: PlanNodeId): PlanNode {
    const row = requireRow(this.ctx.db.select().from(planNodes).where(eq(planNodes.id, id)).get(), "PlanNode", id);
    return nodeToDomain(row, this.ctx.db.select().from(planNodeRequirements).where(eq(planNodeRequirements.planNodeId, id)).all());
  }

  /** Every node the Run ever created, historical ones included, in creation order. */
  listNodes(runId: RunId): PlanNode[] {
    const rows = this.ctx.db.select().from(planNodes).where(eq(planNodes.runId, runId)).orderBy(asc(planNodes.createdAt), asc(planNodes.id)).all();
    return this.attachScope(rows);
  }

  /** The immutable membership list of one accepted revision, in position order. */
  listMembership(runId: RunId, revisionNumber: number): PlanRevisionNode[] {
    return this.ctx.db
      .select()
      .from(planRevisionNodes)
      .where(and(eq(planRevisionNodes.runId, runId), eq(planRevisionNodes.revisionNumber, revisionNumber)))
      .orderBy(asc(planRevisionNodes.position))
      .all()
      .map((row) => parseOrThrow(planRevisionNodeSchema, row, "PlanRevisionNode row"));
  }

  /** The member nodes of one accepted revision, in membership order, with their scope. */
  listMembers(runId: RunId, revisionNumber: number): PlanNode[] {
    const membership = this.listMembership(runId, revisionNumber);
    if (membership.length === 0) return [];
    const rows = this.ctx.db.select().from(planNodes).where(inArray(planNodes.id, membership.map((m) => m.planNodeId))).all();
    const byId = new Map(this.attachScope(rows).map((n) => [n.id, n] as const));
    return membership.map((m) => byId.get(m.planNodeId)!);
  }

  /** The membership position of `planNodeId` in one accepted revision, or `null` when it is not a member: the node cursor check. */
  memberPosition(runId: RunId, revisionNumber: number, planNodeId: PlanNodeId): number | null {
    const row = this.ctx.db
      .select({ position: planRevisionNodes.position })
      .from(planRevisionNodes)
      .where(and(eq(planRevisionNodes.runId, runId), eq(planRevisionNodes.revisionNumber, revisionNumber), eq(planRevisionNodes.planNodeId, planNodeId)))
      .get();
    return row?.position ?? null;
  }

  /** The subset of `ids` that are members of one accepted revision, in one bounded query. */
  membersAmong(runId: RunId, revisionNumber: number, ids: readonly PlanNodeId[]): PlanNodeId[] {
    if (ids.length === 0) return [];
    return this.ctx.db
      .select({ planNodeId: planRevisionNodes.planNodeId })
      .from(planRevisionNodes)
      .where(and(eq(planRevisionNodes.runId, runId), eq(planRevisionNodes.revisionNumber, revisionNumber), inArray(planRevisionNodes.planNodeId, [...ids])))
      .all()
      .map((row) => row.planNodeId as PlanNodeId);
  }

  /**
   * One keyset page of a revision's members in membership order, after the
   * member at position `afterPosition` (exclusive; -1 from the start), at
   * most `limit` nodes, with their scope: two bounded queries.
   */
  pageMembers(runId: RunId, revisionNumber: number, afterPosition: number, limit: number): PlanNode[] {
    const membership = this.ctx.db
      .select({ planNodeId: planRevisionNodes.planNodeId })
      .from(planRevisionNodes)
      .where(and(eq(planRevisionNodes.runId, runId), eq(planRevisionNodes.revisionNumber, revisionNumber), gt(planRevisionNodes.position, afterPosition)))
      .orderBy(asc(planRevisionNodes.position))
      .limit(limit)
      .all();
    if (membership.length === 0) return [];
    const rows = this.ctx.db.select().from(planNodes).where(inArray(planNodes.id, membership.map((m) => m.planNodeId))).all();
    const byId = new Map(this.attachScope(rows).map((n) => [n.id, n] as const));
    return membership.map((m) => byId.get(m.planNodeId as PlanNodeId)!);
  }

  /**
   * The canonical key of an edge of one accepted revision — its target's
   * membership position and its fan-in position, unique per revision — or
   * `null` when the edge is not the revision's: the edge cursor check.
   */
  edgeKey(runId: RunId, revisionNumber: number, edgeId: PlanEdgeId): { targetPosition: number; position: number } | null {
    const target = alias(planRevisionNodes, "target_member");
    const row = this.ctx.db
      .select({ targetPosition: target.position, position: planEdges.position })
      .from(planEdges)
      .innerJoin(target, and(eq(target.runId, planEdges.runId), eq(target.revisionNumber, planEdges.revisionNumber), eq(target.planNodeId, planEdges.targetNodeId)))
      .where(and(eq(planEdges.id, edgeId), eq(planEdges.runId, runId), eq(planEdges.revisionNumber, revisionNumber)))
      .get();
    return row ?? null;
  }

  /**
   * One keyset page of a revision's edges in the canonical order — target
   * membership position, then fan-in position (unique per revision) — after
   * the given key (exclusive; `null` from the start), at most `limit` edges:
   * one bounded query. The same order `listEdges` returns whole.
   */
  pageEdges(runId: RunId, revisionNumber: number, after: { targetPosition: number; position: number } | null, limit: number): PlanEdge[] {
    const target = alias(planRevisionNodes, "target_member");
    return this.ctx.db
      .select({ edge: planEdges })
      .from(planEdges)
      .innerJoin(target, and(eq(target.runId, planEdges.runId), eq(target.revisionNumber, planEdges.revisionNumber), eq(target.planNodeId, planEdges.targetNodeId)))
      .where(
        and(
          eq(planEdges.runId, runId),
          eq(planEdges.revisionNumber, revisionNumber),
          after === null ? undefined : or(gt(target.position, after.targetPosition), and(eq(target.position, after.targetPosition), gt(planEdges.position, after.position))),
        ),
      )
      .orderBy(asc(target.position), asc(planEdges.position))
      .limit(limit)
      .all()
      .map((row) => edgeToDomain(row.edge));
  }

  /** The edges owned by one accepted revision, in fan-in order per target, targets in membership order. */
  listEdges(runId: RunId, revisionNumber: number): PlanEdge[] {
    const rows = this.ctx.db
      .select()
      .from(planEdges)
      .where(and(eq(planEdges.runId, runId), eq(planEdges.revisionNumber, revisionNumber)))
      .all()
      .map(edgeToDomain);
    return sortEdges(rows, this.listMembership(runId, revisionNumber));
  }

  /** The complete graph of one accepted revision: the only input the scheduler reads. */
  graph(runId: RunId, revisionNumber: number): PlanGraph {
    this.getRevision(runId, revisionNumber);
    return { runId, revisionNumber, nodes: this.listMembers(runId, revisionNumber), edges: this.listEdges(runId, revisionNumber) };
  }

  /** The current executable graph: the latest accepted revision's membership and edges. */
  currentGraph(runId: RunId): PlanGraph {
    return this.graph(runId, this.latestRevision(runId).number);
  }

  /** Reconciliation lookup: the member of a revision compiled from `sourcePath`, if any. */
  findMember(runId: RunId, revisionNumber: number, sourcePath: string): PlanNode | null {
    return this.listMembers(runId, revisionNumber).find((n) => n.sourcePath === sourcePath) ?? null;
  }

  /** The Run's root Orchestrator node. */
  rootNode(runId: RunId): PlanNode {
    const row = requireRow(
      this.ctx.db.select().from(planNodes).where(and(eq(planNodes.runId, runId), eq(planNodes.sourcePath, ROOT_SOURCE_PATH))).get(),
      "root PlanNode of Run",
      runId,
    );
    return nodeToDomain(row, this.ctx.db.select().from(planNodeRequirements).where(eq(planNodeRequirements.planNodeId, row.id)).all());
  }

  /** A node's exact scope rows in scope order. */
  listScope(planNodeId: PlanNodeId): PlanNodeRequirement[] {
    return this.ctx.db
      .select()
      .from(planNodeRequirements)
      .where(eq(planNodeRequirements.planNodeId, planNodeId))
      .orderBy(asc(planNodeRequirements.position))
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

  // -------------------------------------------------------------------------
  // Node state
  // -------------------------------------------------------------------------

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
        case "cancelled":
          payload = { from: current.status, to: "cancelled", reason: transition.reason };
          break;
        case "failed": {
          const artifactIds = [...(transition.artifactIds ?? [])].sort();
          if (artifactIds.length > 0) {
            const rows = this.ctx.db.select({ id: artifacts.id, runId: artifacts.runId }).from(artifacts).where(inArray(artifacts.id, artifactIds)).all();
            for (const artifactId of artifactIds) {
              const row = rows.find((r) => r.id === artifactId);
              if (!row) throw new ValidationError(`failure Artifact ${artifactId} does not exist`);
              assertSameRun("Artifact", artifactId, row.runId, current.runId);
            }
          }
          payload = { from: current.status, to: "failed", reason: transition.reason, artifactIds };
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
          // Complete actual consumption of the Invocations funded from this node, never clamped to the
          // reservation; final-reserve Invocations attributed to the root are charged on their own reservation.
          this.reservations.release(
            reservation.id,
            transition.to === "cancelled" ? releaseReasonOf(transition.reason) : "child_terminal",
            this.usage.consumedFromPlanNodeAllocation(id),
            options,
          );
        }
      }
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private attachScope(rows: NodeRow[]): PlanNode[] {
    if (rows.length === 0) return [];
    const scope = this.scopeRowsOf(rows.map((r) => r.id as PlanNodeId));
    const byNode = new Map<string, ScopeRow[]>();
    for (const row of scope) {
      const list = byNode.get(row.planNodeId) ?? [];
      list.push(row as ScopeRow);
      byNode.set(row.planNodeId, list);
    }
    return rows.map((row) => nodeToDomain(row, byNode.get(row.id) ?? []));
  }

  private scopeRowsOf(nodeIds: PlanNodeId[]): PlanNodeRequirement[] {
    if (nodeIds.length === 0) return [];
    return this.ctx.db
      .select()
      .from(planNodeRequirements)
      .where(inArray(planNodeRequirements.planNodeId, nodeIds))
      .orderBy(asc(planNodeRequirements.planNodeId), asc(planNodeRequirements.position))
      .all()
      .map((row) => parseOrThrow(planNodeRequirementSchema, row, "PlanNodeRequirement row"));
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

/** Deterministic edge order: by target membership position, fan-in position, then source membership position. */
function sortEdges(edges: PlanEdge[], membership: PlanRevisionNode[]): PlanEdge[] {
  const position = new Map(membership.map((m) => [m.planNodeId, m.position] as const));
  const at = (id: PlanNodeId) => position.get(id) ?? Number.MAX_SAFE_INTEGER;
  return [...edges].sort(
    (a, b) => at(a.targetNodeId) - at(b.targetNodeId) || a.position - b.position || at(a.sourceNodeId) - at(b.sourceNodeId) || a.type.localeCompare(b.type),
  );
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

