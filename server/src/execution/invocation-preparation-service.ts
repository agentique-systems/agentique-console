/**
 * Atomic Invocation preparation (execution-model §6.1, §6.2). One root
 * transaction validates the requested logical Invocation, resolves its
 * operation from the node's immutable shape and the typed Pattern position
 * (never from a caller-supplied template), resolves the executable Agent
 * Definition revision, computes the effective capability and Tool Policy,
 * obtains the starting Snapshot and worktree through the execution-workspace
 * port, creates the Invocation with its Budget reservation (Plan Node
 * allocation, Task reservation transfer, or the Run final reserve), marks
 * the delivered Handoffs, starts its owned Tasks, assembles and persists
 * exactly one Context Manifest carrying exactly that operation's input, and
 * writes every Event. No caller sequences these by hand; a failure anywhere
 * rolls everything back and runs the port's compensation; no provider call
 * happens here.
 */
import {
  addAllocation,
  allocationSchema,
  ATTEMPT_MACHINE,
  ConflictError,
  effectiveCapabilityPolicy,
  EMPTY_MANIFEST_TEMPLATE,
  FINAL_RESERVE_USES,
  grantsWriteCapability,
  idSchema,
  INVOCATION_MACHINE,
  INVOCATION_PURPOSES,
  INVOCATION_ROLES,
  manifestInputSchema,
  MANIFEST_RENDERER_VERSION,
  nonEmptyString,
  operationAt,
  orchestratorDefinitionDefects,
  parseOrThrow,
  patternPositionDefects,
  patternPositionKey,
  patternPositionSchema,
  positiveCount,
  ROOT_SOURCE_PATH,
  RUN_MACHINE,
  uniqueIds,
  ValidationError,
  type AgentDefinitionRevision,
  type Allocation,
  type ArtifactId,
  type BudgetReservationId,
  type CompiledOperation,
  type ContextManifest,
  type EffectiveCapabilityPolicy,
  type FinalReserveUse,
  type HandoffId,
  type Invocation,
  type InvocationId,
  type InvocationPurpose,
  type InvocationRole,
  type ManifestInput,
  type ManifestTemplate,
  type PatternPlanNode,
  type PatternPosition,
  type PlanNodeId,
  type Run,
  type RunId,
  type SnapshotId,
  type TaskId,
  type WorkspaceCapabilityPolicy,
} from "@agentique-console/core";
import { z } from "zod";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import { resolveExecutableAgentDefinitionRevision } from "./agent-definitions.ts";
import { ContextManifestAssembler } from "./manifest/assembler.ts";
import type { ExecutionWorkspacePort, ExecutionWorkspaceRequest, PreparedExecutionWorkspace } from "./ports/execution-workspace.ts";

/** Where the Invocation's allocation is reserved from (execution-model §7.6). */
export type InvocationFunding =
  | { source: "plan_node" }
  | { source: "task_transfer"; taskReservationId: BudgetReservationId }
  | { source: "run_final_reserve"; use: FinalReserveUse };

const fundingSchema: z.ZodType<InvocationFunding> = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("plan_node") }),
  z.strictObject({ source: z.literal("task_transfer"), taskReservationId: idSchema("budgetReservation") }),
  z.strictObject({ source: z.literal("run_final_reserve"), use: z.enum(FINAL_RESERVE_USES) }),
]);

export interface InvocationPreparationRequest {
  runId: RunId;
  planNodeId: PlanNodeId;
  role: InvocationRole;
  purpose: InvocationPurpose;
  /**
   * The typed Pattern position the Invocation occupies; the operation
   * (Agent Definition revision, exact input, role) is resolved from the
   * node shape at this position. `null` only for a Gate Evaluator.
   */
  patternPosition: PatternPosition | null;
  /** Required for a position-less Invocation; for a positioned one it is derived from the operation and, when given, must agree with it. */
  agentDefinitionRevisionId?: string;
  continuedFromInvocationId: InvocationId | null;
  /**
   * The Tasks the Invocation owns and executes: exactly the operation's
   * `input.taskIds` (the default) or, for a `worker_task` position, the one
   * Task the position names. Never a wider set.
   */
  taskIds?: TaskId[];
  /** Defaults to the Agent Definition revision's default allocation. */
  allocation?: Allocation;
  /** Defaults to the revision's default wall-clock limit, bounded by the node's. */
  maxWallClockMs?: number | null;
  funding?: InvocationFunding;
  inputs?: ManifestInput[];
  handoffIds?: HandoffId[];
  artifactIds?: ArtifactId[];
  correlationId?: string | null;
  causationSeq?: number | null;
}

const requestSchema: z.ZodType<InvocationPreparationRequest> = z.strictObject({
  runId: idSchema("run"),
  planNodeId: idSchema("planNode"),
  role: z.enum(INVOCATION_ROLES),
  purpose: z.enum(INVOCATION_PURPOSES),
  patternPosition: patternPositionSchema.nullable(),
  agentDefinitionRevisionId: nonEmptyString.optional(),
  continuedFromInvocationId: idSchema("invocation").nullable(),
  taskIds: uniqueIds(idSchema("task")).optional(),
  allocation: allocationSchema.optional(),
  maxWallClockMs: positiveCount.nullable().optional(),
  funding: fundingSchema.optional(),
  inputs: z.array(manifestInputSchema).optional(),
  handoffIds: uniqueIds(idSchema("handoff")).optional(),
  artifactIds: uniqueIds(idSchema("artifact")).optional(),
  correlationId: nonEmptyString.nullable().optional(),
  causationSeq: z.number().int().min(1).nullable().optional(),
});

export interface PreparedWorkspace {
  request: ExecutionWorkspaceRequest;
  prepared: PreparedExecutionWorkspace;
}

export interface PreparedInvocation {
  invocation: Invocation;
  manifest: ContextManifest;
  policy: EffectiveCapabilityPolicy;
  workspace: PreparedWorkspace;
}

export interface InvocationPreparationConfig {
  workspacePolicy: WorkspaceCapabilityPolicy;
}

/** The operation an Invocation executes, resolved from the persisted node shape and the typed position. */
interface ResolvedOperation {
  operation: CompiledOperation | null;
  agentDefinitionRevisionId: string;
  /** Exactly this operation's input: the only template the manifest receives. */
  input: ManifestTemplate;
  taskIds: TaskId[];
}

export class InvocationPreparationService {
  private readonly assembler: ContextManifestAssembler;

  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
    private readonly workspace: ExecutionWorkspacePort,
    private readonly config: InvocationPreparationConfig,
  ) {
    this.assembler = new ContextManifestAssembler(stores);
  }

  prepare(request: InvocationPreparationRequest): PreparedInvocation {
    const valid = parseOrThrow(requestSchema, request, "Invocation preparation request");
    const meta: WriteOptions = { correlationId: valid.correlationId ?? null, causationSeq: valid.causationSeq ?? null };
    return this.ctx.tx.write(() => {
      const run = this.stores.runs.get(valid.runId);
      if (RUN_MACHINE.isTerminal(run.status)) throw new ConflictError(`Run ${run.id} is ${run.status}; no Invocation can be prepared`);
      const node = this.node(run, valid);
      const resolved = this.operation(node, valid);
      const revision = this.revision(run, valid, resolved.agentDefinitionRevisionId);
      const policy = effectiveCapabilityPolicy(revision, valid.role, this.config.workspacePolicy);
      const tasks = this.tasks(run, node, valid, resolved.taskIds);
      this.assertContinuation(run, node, valid);
      const funding = valid.funding ?? { source: "plan_node" };
      this.assertFunding(node, valid, resolved.taskIds, funding);
      const allocation = valid.allocation ?? revision.defaultLimits.allocation;
      const maxWallClockMs = this.wallClock(node, revision, valid.maxWallClockMs);

      const invocation = this.stores.invocations.create(
        {
          runId: run.id,
          planNodeId: node.id,
          role: valid.role,
          purpose: valid.purpose,
          agentDefinitionRevisionId: revision.id,
          continuedFromInvocationId: valid.continuedFromInvocationId,
          patternPosition: valid.patternPosition,
          taskIds: resolved.taskIds,
          allocation,
          allocationSource: funding.source === "run_final_reserve" ? "run_final_reserve" : "plan_node",
          finalReserveUse: funding.source === "run_final_reserve" ? funding.use : null,
        },
        { ...meta, ...(funding.source === "task_transfer" ? { fromTaskReservationId: funding.taskReservationId } : {}) },
      );
      const caused: WriteOptions = { ...meta, causationSeq: this.ctx.journal.lastSeq() };
      // Workspace preparation is an external side effect inside the transaction; its compensation runs only on rollback.
      const writes = grantsWriteCapability(policy);
      const workspaceRequest: ExecutionWorkspaceRequest = { runId: run.id, invocationId: invocation.id, role: valid.role, writes, integrationWorkspacePath: run.integrationWorkspacePath, integrationSnapshot: this.integrationSnapshot(run) };
      const prepared = this.workspace.prepare(workspaceRequest);
      this.ctx.tx.afterRollback(() => this.workspace.discard(workspaceRequest, prepared));
      if (writes && prepared.startingSnapshot === null) throw new ValidationError("a writing Invocation needs a starting Snapshot from the execution-workspace port");
      // A writing Invocation's worktree is a durable cleanup obligation from this moment; a read-only one owns nothing to clean up.
      let obliged = invocation;
      if (writes) {
        if (prepared.worktreePath === null) throw new ValidationError("a writing Invocation needs an isolated worktree from the execution-workspace port");
        obliged = this.stores.invocations.recordWorkspaceObligation(invocation.id, prepared.worktreePath, caused);
      }
      const startingSnapshotId = this.startingSnapshot(run, prepared, caused);
      for (const handoffId of valid.handoffIds ?? []) this.deliverHandoff(run, node, invocation, handoffId, caused);
      const content = this.assembler.assemble({
        run,
        node,
        invocation,
        revision,
        policy,
        operationInput: resolved.input,
        inputs: valid.inputs ?? [],
        handoffIds: valid.handoffIds ?? [],
        artifactIds: valid.artifactIds ?? [],
        startingSnapshotId,
        worktreePath: prepared.worktreePath,
        maxWallClockMs,
      });
      const manifest = this.stores.invocations.putManifest(invocation.id, content, MANIFEST_RENDERER_VERSION, caused);
      for (const task of tasks) this.stores.tasks.transition(task.id, { to: "running", invocationId: invocation.id }, caused);
      return { invocation: obliged, manifest, policy, workspace: { request: workspaceRequest, prepared } };
    });
  }

  // ---------------------------------------------------------------------------

  private node(run: Run, request: InvocationPreparationRequest): PatternPlanNode {
    const node = this.stores.plans.getNode(request.planNodeId);
    if (node.runId !== run.id) throw new ValidationError(`PlanNode ${node.id} belongs to Run ${node.runId}, not ${run.id}`);
    if (node.kind !== "pattern") throw new ValidationError(`join node ${node.id} creates no Invocation`);
    if (node.status !== "running") throw new ConflictError(`PlanNode ${node.id} is ${node.status}; an Invocation is prepared for a running node`);
    const isRoot = node.sourcePath === ROOT_SOURCE_PATH;
    if (request.role === "orchestrator" && !isRoot) throw new ValidationError("only the root Plan Node holds Orchestrator Invocations", { planNodeId: node.id });
    if (isRoot && request.role !== "orchestrator" && !(request.role === "evaluator" && request.funding?.source === "run_final_reserve" && request.funding.use === "run_completion")) {
      throw new ValidationError(`the root Plan Node holds Orchestrator Invocations and the run_completion Evaluator, not a ${request.role}`, { planNodeId: node.id });
    }
    if (request.role === "coordinator" && node.pattern !== "coordinator_worker") throw new ValidationError(`a Coordinator Invocation belongs to a coordinator_worker node, not a ${node.pattern} node`);
    return node;
  }

  /**
   * The operation at the typed position of the node's immutable shape. A
   * positioned Invocation runs exactly that operation's Agent Definition
   * revision with exactly its input and owns exactly its Tasks; a
   * position-less Gate Evaluator names its revision explicitly, receives no
   * operation input, and owns no Task.
   */
  private operation(node: PatternPlanNode, request: InvocationPreparationRequest): ResolvedOperation {
    if (request.patternPosition === null) {
      if (!(request.role === "evaluator" && request.purpose === "evaluate")) throw new ValidationError("every Invocation but a Gate Evaluator names its Pattern position", { role: request.role, purpose: request.purpose });
      if (request.agentDefinitionRevisionId === undefined) throw new ValidationError("a position-less Evaluator Invocation names its Agent Definition revision");
      if ((request.taskIds ?? []).length > 0) throw new ValidationError("an Evaluator Invocation holds no Task");
      return { operation: null, agentDefinitionRevisionId: request.agentDefinitionRevisionId, input: { ...EMPTY_MANIFEST_TEMPLATE }, taskIds: [] };
    }
    const operation = operationAt(node.shape, request.patternPosition);
    const defects = patternPositionDefects(node, request.patternPosition, { role: request.role, purpose: request.purpose, agentDefinitionRevisionId: (request.agentDefinitionRevisionId ?? operation?.agentDefinitionRevisionId ?? "agdr_none") as never });
    if (operation === null || defects.length > 0) {
      throw new ValidationError(`Pattern position is invalid for PlanNode ${node.id}: ${defects.join("; ")}`, { planNodeId: node.id, patternPosition: request.patternPosition, defects });
    }
    const owned = request.patternPosition.kind === "worker_task" ? [request.patternPosition.taskId] : [...operation.input.taskIds].sort();
    if (request.taskIds !== undefined) {
      const requested = [...request.taskIds].sort();
      if (requested.length !== owned.length || requested.some((id, i) => id !== owned[i])) {
        throw new ValidationError(`an Invocation at ${patternPositionKey(request.patternPosition)} owns exactly the operation's Tasks`, { requested, owned });
      }
    }
    return { operation, agentDefinitionRevisionId: operation.agentDefinitionRevisionId, input: operation.input, taskIds: owned };
  }

  private revision(run: Run, request: InvocationPreparationRequest, agentDefinitionRevisionId: string): AgentDefinitionRevision {
    const resolved = resolveExecutableAgentDefinitionRevision(this.stores, { workspaceId: run.workspaceId, conversationId: run.conversationId }, agentDefinitionRevisionId);
    if (!resolved.ok) throw new ValidationError(`the Agent Definition revision is not executable by this Run: ${resolved.message}`, { revisionId: resolved.revisionId });
    const revision = this.stores.agents.getRevision(resolved.revision.id);
    if (request.role === "orchestrator") {
      const defects = orchestratorDefinitionDefects(resolved.revision.definitionName, revision);
      if (defects.length > 0) throw new ValidationError(`Agent Definition revision ${revision.id} cannot hold the Orchestrator role: ${defects.join("; ")}`, { defects });
    }
    return revision;
  }

  /**
   * `continuedFromInvocationId` must belong to the same Run and be the
   * correct logical predecessor: for a positioned Invocation, the latest
   * Invocation at the same position of the same node (the previous
   * Orchestrator turn, Coordinator turn, or the blocked predecessor of the
   * same step), and no longer active. The first Invocation at a position
   * continues from nothing; a later one always names its predecessor.
   */
  private assertContinuation(run: Run, node: PatternPlanNode, request: InvocationPreparationRequest): void {
    const latest = request.patternPosition === null ? null : this.stores.invocations.latestAtPosition(node.id, patternPositionKey(request.patternPosition));
    if (request.continuedFromInvocationId === null) {
      if (latest !== null) {
        throw new ValidationError(`a later Invocation at ${patternPositionKey(request.patternPosition!)} records continuedFromInvocationId ${latest.id}`, { latestInvocationId: latest.id });
      }
      return;
    }
    const previous = this.stores.invocations.get(request.continuedFromInvocationId);
    if (previous.runId !== run.id) throw new ValidationError(`Invocation ${previous.id} belongs to Run ${previous.runId}, not ${run.id}`);
    if (previous.planNodeId !== node.id) throw new ValidationError(`Invocation ${previous.id} belongs to PlanNode ${previous.planNodeId}, not ${node.id}`);
    if (previous.role !== request.role) throw new ValidationError(`Invocation ${previous.id} holds the ${previous.role} role, not ${request.role}`);
    if (!INVOCATION_MACHINE.isTerminal(previous.status)) throw new ConflictError(`Invocation ${previous.id} is still ${previous.status}`);
    if (latest !== null && latest.id !== previous.id) {
      throw new ValidationError(`Invocation ${previous.id} is not the latest ${request.role} Invocation at ${patternPositionKey(request.patternPosition!)} (${latest.id})`, { latestInvocationId: latest.id });
    }
    const active = this.stores.invocations.activeAttempt(previous.id);
    if (active && !ATTEMPT_MACHINE.isTerminal(active.status)) throw new ConflictError(`Invocation ${previous.id} still has an active Attempt`);
  }

  private tasks(run: Run, node: PatternPlanNode, request: InvocationPreparationRequest, taskIds: TaskId[]) {
    if (request.purpose === "task" && taskIds.length !== 1) throw new ValidationError("a task Invocation executes exactly one Task", { taskIds });
    if (request.role === "evaluator" && taskIds.length > 0) throw new ValidationError("an Evaluator Invocation holds no Task");
    return taskIds.map((id) => {
      const task = this.stores.tasks.get(id);
      if (task.runId !== run.id) throw new ValidationError(`Task ${id} belongs to Run ${task.runId}, not ${run.id}`);
      if (task.planNodeId !== null && task.planNodeId !== node.id) throw new ValidationError(`Task ${id} belongs to PlanNode ${task.planNodeId}, not ${node.id}`);
      if (task.status !== "ready") throw new ConflictError(`Task ${id} is ${task.status}; an Invocation starts a ready Task`);
      return task;
    });
  }

  private assertFunding(node: PatternPlanNode, request: InvocationPreparationRequest, taskIds: TaskId[], funding: InvocationFunding): void {
    if (funding.source === "run_final_reserve") {
      if (node.sourcePath !== ROOT_SOURCE_PATH) throw new ValidationError("a final-reserve Invocation belongs to the root Plan Node");
      if (taskIds.length > 0) throw new ValidationError("a final-reserve Invocation executes no Task");
    }
    if (funding.source === "task_transfer") {
      const reservation = this.stores.reservations.get(funding.taskReservationId);
      if (reservation.child.type !== "task" || !taskIds.includes(reservation.child.id)) {
        throw new ValidationError(`reservation ${funding.taskReservationId} is not a reservation of the Invocation's Task`);
      }
    }
    if (request.role === "orchestrator" && request.patternPosition?.kind !== "orchestrator") throw new ValidationError("an Orchestrator Invocation occupies the orchestrator position");
  }

  private wallClock(node: PatternPlanNode, revision: AgentDefinitionRevision, requested: number | null | undefined): number | null {
    const own = requested === undefined ? revision.defaultLimits.maxWallClockMs : requested;
    if (own === null) return node.maxWallClockMs;
    return node.maxWallClockMs === null ? own : Math.min(own, node.maxWallClockMs);
  }

  /** The identity of the Run's current integration Snapshot (or base Snapshot), which every worktree is created from. */
  private integrationSnapshot(run: Run) {
    const id = run.integrationSnapshotId ?? run.baseSnapshotId;
    return id === null ? null : this.stores.snapshots.get(id).identity;
  }

  /** A writing Invocation starts from the Snapshot the port took; a read-only one from the Run's current integration (or base) Snapshot. */
  private startingSnapshot(run: Run, prepared: PreparedExecutionWorkspace, meta: WriteOptions): SnapshotId | null {
    if (prepared.startingSnapshot !== null) {
      return this.stores.snapshots.record({ workspaceId: run.workspaceId, runId: run.id, identity: prepared.startingSnapshot, reason: "before_invocation" }, meta).id;
    }
    return run.integrationSnapshotId ?? run.baseSnapshotId;
  }

  private deliverHandoff(run: Run, node: PatternPlanNode, invocation: Invocation, handoffId: HandoffId, meta: WriteOptions): void {
    const handoff = this.stores.handoffs.get(handoffId);
    if (handoff.runId !== run.id) throw new ValidationError(`Handoff ${handoffId} belongs to another Run`);
    const addressed = handoff.target.kind === "plan_node" ? handoff.target.planNodeId === node.id : handoff.target.invocationId === invocation.id;
    if (!addressed) throw new ValidationError(`Handoff ${handoffId} is not addressed to PlanNode ${node.id}`);
    if (handoff.status === "pending") this.stores.handoffs.transition(handoffId, "delivered", meta);
    else if (handoff.status === "cancelled") throw new ValidationError(`Handoff ${handoffId} is cancelled`);
  }
}

/** Sums the allocations of the Invocations a node funded, for callers that bound a new allocation by the node's remainder. */
export function allocationOf(invocations: readonly Pick<Invocation, "allocation">[]): Allocation {
  return invocations.reduce((sum, i) => addAllocation(sum, i.allocation), { costUsd: 0, tokens: 0, attempts: 0 });
}
