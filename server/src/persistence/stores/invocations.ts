import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  ACTIVE_INVOCATION_STATUSES,
  AllocationExhaustedError,
  ATTEMPT_MACHINE,
  attemptInputSchema,
  attemptSchema,
  canonicalJson,
  ConflictError,
  contextManifestContentSchema,
  contextManifestSchema,
  failureClassForTransition,
  INVOCATION_MACHINE,
  invocationInputSchema,
  invocationPositionKey,
  invocationSchema,
  InvariantViolationError,
  isRequestableDecisionKind,
  MANIFEST_RENDERER_VERSION,
  parseOrThrow,
  patternPositionDefects,
  PLAN_NODE_MACHINE,
  ValidationError,
  type Attempt,
  type AttemptId,
  type AttemptInput,
  type AttemptTransition,
  type BudgetReservationId,
  type ContextManifest,
  type ContextManifestContent,
  type GateId,
  type Invocation,
  type InvocationId,
  type InvocationInput,
  type InvocationRole,
  type InvocationTransition,
  type PlanNodeId,
  type RunId,
} from "@agentique-console/core";
import { sha256Hex } from "../blob-store.ts";
import type { PersistenceContext } from "../context.ts";
import { agentDefinitionRevisions, artifacts, attempts, capacityLeases, contextManifests, decisions, gates, invocations, planNodes, runs, tasks } from "../schema.ts";
import { ROOT_SOURCE_PATH } from "@agentique-console/core";
import type { BudgetReservationStore } from "./budgets.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";
import { keysetOrder, keysetWhere, type KeysetQuery } from "./paging.ts";
import type { UsageStore } from "./usage.ts";

type InvocationRow = typeof invocations.$inferSelect;
type AttemptRow = typeof attempts.$inferSelect;

function invocationToDomain(row: InvocationRow): Invocation {
  return parseOrThrow(
    invocationSchema,
    {
      id: row.id,
      runId: row.runId,
      planNodeId: row.planNodeId,
      role: row.role,
      purpose: row.purpose,
      agentDefinitionRevisionId: row.agentDefinitionRevisionId,
      continuedFromInvocationId: row.continuedFromInvocationId,
      patternPosition: row.patternPosition,
      gateId: row.gateId,
      taskIds: row.taskIds,
      allocation: { costUsd: row.allocCostUsd, tokens: row.allocTokens, attempts: row.allocAttempts },
      allocationSource: row.allocationSource,
      finalReserveUse: row.finalReserveUse,
      status: row.status,
      waitReason: row.waitReason,
      failureReason: row.failureReason,
      blockedByDecisionId: row.blockedByDecisionId,
      result: row.result,
      workspaceCleanup: row.workspaceCleanup,
      workspaceReleasedAt: row.workspaceReleasedAt,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    },
    "Invocation row",
  );
}

function attemptToDomain(row: AttemptRow): Attempt {
  const { retryNotBefore: _denormalized, ...attempt } = row;
  return parseOrThrow(attemptSchema, attempt, "Attempt row");
}

export interface InvocationCreateOptions extends WriteOptions {
  /** A Coordinator Task's active reservation to transfer instead of reserving afresh. */
  fromTaskReservationId?: BudgetReservationId;
}

/**
 * Invocations, their Attempts, and their immutable Context Manifests.
 * Creating an Invocation reserves its allocation in the same transaction:
 * from its Plan Node (or by transferring a Task reservation with two rows)
 * for `allocationSource: plan_node`, or directly from the Run's final
 * reserve for the two permitted `run_final_reserve` uses, which sit on the
 * root Plan Node. Creating an Attempt consumes one Attempt from the
 * allocation whatever its later outcome, so an interrupted Attempt is never
 * refunded.
 */
export class InvocationStore {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly reservations: BudgetReservationStore,
    private readonly usage: UsageStore,
  ) {}

  // ------------------------------------------------------------------ Invocations

  create(input: InvocationInput, options?: InvocationCreateOptions): Invocation {
    const valid = parseOrThrow(invocationInputSchema, input, "Invocation input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      const node = requireRow(
        this.ctx.db.select({ runId: planNodes.runId, kind: planNodes.kind, status: planNodes.status, sourcePath: planNodes.sourcePath, shape: planNodes.shape }).from(planNodes).where(eq(planNodes.id, valid.planNodeId)).get(),
        "PlanNode",
        valid.planNodeId,
      );
      assertSameRun("PlanNode", valid.planNodeId, node.runId, run.id);
      if (node.kind !== "pattern" || node.shape === null) {
        throw new InvariantViolationError(`join node ${valid.planNodeId} creates no Invocation`, { planNodeId: valid.planNodeId });
      }
      // The position belongs to the node's actual Pattern and agrees with the operation it names (core `patternPositionDefects`).
      if (valid.patternPosition !== null) {
        const defects = patternPositionDefects({ sourcePath: node.sourcePath, shape: node.shape }, valid.patternPosition, valid);
        if (defects.length > 0) throw new InvariantViolationError(`Pattern position is invalid for PlanNode ${valid.planNodeId}: ${defects.join("; ")}`, { planNodeId: valid.planNodeId, patternPosition: valid.patternPosition, defects });
      }
      const gateId = valid.gateId ?? null;
      if (gateId !== null && valid.purpose === "final_synthesis") this.assertFinalSynthesis(run, node.sourcePath, valid.finalReserveUse ?? null, gateId);
      else if (gateId !== null) this.assertGateEvaluator(run, valid.planNodeId, node.sourcePath, valid.agentDefinitionRevisionId, gateId);
      if (PLAN_NODE_MACHINE.isTerminal(node.status as never)) {
        throw new ConflictError(`PlanNode ${valid.planNodeId} is ${node.status}`);
      }
      const allocationSource = valid.allocationSource ?? "plan_node";
      const finalReserveUse = valid.finalReserveUse ?? null;
      if (allocationSource === "run_final_reserve") {
        if (node.sourcePath !== ROOT_SOURCE_PATH) {
          throw new InvariantViolationError(`a final-reserve Invocation belongs to the root Plan Node, not ${valid.planNodeId}`, { planNodeId: valid.planNodeId, finalReserveUse });
        }
        if (options?.fromTaskReservationId) {
          throw new ValidationError("a final-reserve Invocation cannot transfer a Task reservation", { finalReserveUse });
        }
      }
      requireRow(this.ctx.db.select({ id: agentDefinitionRevisions.id }).from(agentDefinitionRevisions).where(eq(agentDefinitionRevisions.id, valid.agentDefinitionRevisionId)).get(), "AgentDefinitionRevision", valid.agentDefinitionRevisionId);
      if (valid.continuedFromInvocationId !== null) {
        const previous = requireRow(this.ctx.db.select({ runId: invocations.runId, planNodeId: invocations.planNodeId, patternPosition: invocations.patternPosition, status: invocations.status }).from(invocations).where(eq(invocations.id, valid.continuedFromInvocationId)).get(), "Invocation", valid.continuedFromInvocationId);
        assertSameRun("Invocation", valid.continuedFromInvocationId, previous.runId, run.id);
        // A successor at the same logical position continues from a terminal predecessor of that position.
        if (valid.patternPosition !== null && previous.planNodeId === valid.planNodeId && canonicalJson(previous.patternPosition) === canonicalJson(valid.patternPosition) && !INVOCATION_MACHINE.isTerminal(previous.status as Invocation["status"])) {
          throw new ConflictError(`Invocation ${valid.continuedFromInvocationId} at the same position is still ${previous.status}`, { invocationId: valid.continuedFromInvocationId });
        }
      }
      if (valid.taskIds.length > 0) {
        const rows = this.ctx.db.select({ id: tasks.id, runId: tasks.runId }).from(tasks).where(inArray(tasks.id, valid.taskIds)).all();
        for (const id of valid.taskIds) assertSameRun("Task", id, requireRow(rows.find((r) => r.id === id), "Task", id).runId, run.id);
      }
      // At most one active Invocation per logical position of a node: a successor after a blocker shares the position, never concurrently.
      if (valid.patternPosition !== null) {
        const active = this.listAtPosition(valid.planNodeId, invocationPositionKey(valid.patternPosition)!).filter((i) => !INVOCATION_MACHINE.isTerminal(i.status));
        if (active.length > 0) throw new ConflictError(`PlanNode ${valid.planNodeId} already has active Invocation ${active[0]!.id} at position ${invocationPositionKey(valid.patternPosition)}`, { planNodeId: valid.planNodeId, invocationId: active[0]!.id });
      }
      // Invariant 20: at most one active Orchestrator Invocation per Run and one active Coordinator Invocation per node (the schema enforces it too).
      if (valid.role === "orchestrator") {
        const active = this.listActive(run.id, "orchestrator");
        if (active.length > 0) throw new ConflictError(`Run ${run.id} already has active Orchestrator Invocation ${active[0]!.id}`, { runId: run.id, invocationId: active[0]!.id });
      }
      if (valid.role === "coordinator") {
        const active = this.listActive(run.id, "coordinator").filter((i) => i.planNodeId === valid.planNodeId);
        if (active.length > 0) throw new ConflictError(`PlanNode ${valid.planNodeId} already has active Coordinator Invocation ${active[0]!.id}`, { planNodeId: valid.planNodeId, invocationId: active[0]!.id });
      }
      const { allocationSource: _source, finalReserveUse: _use, gateId: _gate, ...definition } = valid;
      const invocation: Invocation = {
        id: this.ctx.ids("invocation"),
        ...definition,
        gateId,
        allocationSource,
        finalReserveUse,
        status: "pending",
        waitReason: null,
        failureReason: null,
        blockedByDecisionId: null,
        result: null,
        workspaceCleanup: "none",
        workspaceReleasedAt: null,
        createdAt: this.ctx.clock(),
        startedAt: null,
        endedAt: null,
      };
      parseOrThrow(invocationSchema, invocation, "Invocation");
      this.ctx.journal.append({
        type: "invocation.created",
        scope: runScope(run, { planNodeId: invocation.planNodeId, invocationId: invocation.id }),
        subjectType: "invocation",
        subjectId: invocation.id,
        payload: invocation,
        ...writeMeta(options),
      });
      this.ctx.db.insert(invocations).values(this.toRow(invocation)).run();
      if (allocationSource === "run_final_reserve") {
        // The persisted row is the authorization; the reservation is created atomically with it.
        this.reservations.reserveFinalInvocation({ runId: run.id, invocationId: invocation.id }, options);
      } else if (options?.fromTaskReservationId) {
        const { created } = this.reservations.transferTaskToInvocation(options.fromTaskReservationId, invocation.id, options);
        if (
          created.reserved.costUsd !== valid.allocation.costUsd ||
          created.reserved.tokens !== valid.allocation.tokens ||
          created.reserved.attempts !== valid.allocation.attempts
        ) {
          throw new InvariantViolationError("the transferred Task reservation does not match the Invocation allocation", {
            reserved: created.reserved,
            allocation: valid.allocation,
          });
        }
      } else {
        this.reservations.reserveOrdinary(
          { runId: run.id, parent: { type: "plan_node", id: valid.planNodeId }, child: { type: "invocation", id: invocation.id }, amount: valid.allocation },
          options,
        );
      }
      return invocation;
    });
  }

  /**
   * A Gate Evaluator (execution-model §10) judges an open Gate of its Run: a
   * `node_exit` Gate of its own Plan Node, or a Run Gate from the root node;
   * it executes exactly the Run's verification-policy Evaluator revision;
   * and at most one Evaluator Invocation of a Gate is active at a time (the
   * database's partial unique index holds the same rule).
   */
  private assertGateEvaluator(run: { id: RunId }, planNodeId: PlanNodeId, sourcePath: string, agentDefinitionRevisionId: string, gateId: string): void {
    const gate = requireRow(this.ctx.db.select({ runId: gates.runId, planNodeId: gates.planNodeId, kind: gates.kind, status: gates.status }).from(gates).where(eq(gates.id, gateId)).get(), "Gate", gateId);
    assertSameRun("Gate", gateId, gate.runId, run.id);
    if (gate.status !== "open") throw new ConflictError(`Gate ${gateId} is ${gate.status}; an Evaluator is created for an open Gate`, { gateId });
    if (gate.planNodeId !== null ? gate.planNodeId !== planNodeId : sourcePath !== ROOT_SOURCE_PATH) {
      throw new InvariantViolationError(gate.planNodeId === null ? `Gate ${gateId} is a Run Gate judged from the root Plan Node, not PlanNode ${planNodeId}` : `Gate ${gateId} belongs to PlanNode ${gate.planNodeId}, not ${planNodeId}`, { gateId, planNodeId });
    }
    const policy = requireRow(this.ctx.db.select({ verificationPolicy: runs.verificationPolicy }).from(runs).where(eq(runs.id, run.id)).get(), "Run", run.id).verificationPolicy;
    if (policy.evaluatorAgentDefinitionRevisionId !== agentDefinitionRevisionId) {
      throw new InvariantViolationError(`a Gate Evaluator executes the Run's verification-policy revision ${policy.evaluatorAgentDefinitionRevisionId ?? "(none)"}, not ${agentDefinitionRevisionId}`, { gateId, agentDefinitionRevisionId });
    }
    const active = this.listByGate(gateId as GateId).filter((i) => i.role === "evaluator" && !INVOCATION_MACHINE.isTerminal(i.status));
    if (active.length > 0) throw new ConflictError(`Gate ${gateId} already has active Evaluator Invocation ${active[0]!.id}`, { gateId, invocationId: active[0]!.id });
  }

  /**
   * The Orchestrator's `final_synthesis` turn (execution-model §10) reports
   * on the open `run_completion` Gate of its Run from the root Plan Node,
   * funded from the final reserve; at most one Gate-owned Invocation of a
   * Gate is active at a time (the database's partial unique index holds the
   * same rule), and a Gate whose Evaluator is still active admits no
   * synthesis.
   */
  private assertFinalSynthesis(run: { id: RunId }, sourcePath: string, finalReserveUse: string | null, gateId: string): void {
    const gate = requireRow(this.ctx.db.select({ runId: gates.runId, kind: gates.kind, status: gates.status }).from(gates).where(eq(gates.id, gateId)).get(), "Gate", gateId);
    assertSameRun("Gate", gateId, gate.runId, run.id);
    if (gate.kind !== "run_completion" || gate.status !== "open") throw new ConflictError(`Gate ${gateId} is not an open run_completion Gate; a final_synthesis turn reports on one`, { gateId });
    if (sourcePath !== ROOT_SOURCE_PATH) throw new InvariantViolationError("a final_synthesis turn belongs to the root Plan Node", { gateId });
    if (finalReserveUse !== "final_synthesis") throw new InvariantViolationError("a final_synthesis turn is funded from the final reserve as final_synthesis", { gateId });
    const active = this.listByGate(gateId as GateId).filter((i) => i.purpose === "final_synthesis" && !INVOCATION_MACHINE.isTerminal(i.status));
    if (active.length > 0) throw new ConflictError(`Gate ${gateId} already has active final-synthesis Invocation ${active[0]!.id}`, { gateId, invocationId: active[0]!.id });
  }

  get(id: InvocationId): Invocation {
    return invocationToDomain(requireRow(this.ctx.db.select().from(invocations).where(eq(invocations.id, id)).get(), "Invocation", id));
  }

  /** Every Gate-owned Invocation of a Gate (its Evaluators, then a run_completion Gate's final-synthesis turn), in creation order: at most one is active. */
  listByGate(gateId: GateId): Invocation[] {
    return this.ctx.db.select().from(invocations).where(eq(invocations.gateId, gateId)).orderBy(asc(invocations.createdAt), asc(invocations.id)).all().map(invocationToDomain);
  }

  /** The most recently created Evaluator Invocation of a Gate, or `null` before the first; a run_completion Gate's synthesis turn is not one. */
  latestByGate(gateId: GateId): Invocation | null {
    return this.listByGate(gateId).filter((i) => i.role === "evaluator").at(-1) ?? null;
  }

  /** The most recently created final-synthesis turn of a run_completion Gate, or `null` before the first. */
  latestSynthesisByGate(gateId: GateId): Invocation | null {
    return this.listByGate(gateId).filter((i) => i.purpose === "final_synthesis").at(-1) ?? null;
  }

  listByPlanNode(planNodeId: PlanNodeId): Invocation[] {
    return this.ctx.db.select().from(invocations).where(eq(invocations.planNodeId, planNodeId)).orderBy(asc(invocations.createdAt), asc(invocations.id)).all().map(invocationToDomain);
  }

  transition(id: InvocationId, transition: InvocationTransition, options?: WriteOptions): Invocation {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      INVOCATION_MACHINE.assertTransition(current.status, transition.to, { invocationId: id });
      const run = loadRunRef(this.ctx, current.runId);
      const now = this.ctx.clock();
      const next: Invocation = { ...current, status: transition.to, waitReason: null };
      let type: "invocation.started" | "invocation.waiting" | "invocation.wait_cleared" | "invocation.blocked" | "invocation.succeeded" | "invocation.failed" | "invocation.cancelled";
      let payload: unknown;
      switch (transition.to) {
        case "running":
          next.startedAt = current.startedAt ?? now;
          type = current.status === "waiting" ? "invocation.wait_cleared" : "invocation.started";
          payload = { invocationId: id };
          break;
        case "waiting":
          next.waitReason = transition.waitReason;
          type = "invocation.waiting";
          payload = { invocationId: id, waitReason: transition.waitReason };
          break;
        case "blocked": {
          // The blocking Decision is an open Decision of this Run that this Invocation ended on: the side_effect_approval whose subject
          // names it, or the operator_choice / requirement_waiver it requested itself through request_decision (execution-model §8.2).
          const decision = requireRow(
            this.ctx.db.select({ runId: decisions.runId, kind: decisions.kind, status: decisions.status, subject: decisions.subject, requestedBy: decisions.requestedBy }).from(decisions).where(eq(decisions.id, transition.decisionId)).get(),
            "Decision",
            transition.decisionId,
          );
          const approvalOfThis = decision.kind === "side_effect_approval" && decision.subject?.kind === "side_effect_approval" && decision.subject.invocationId === id;
          const requestedByThis = isRequestableDecisionKind(decision.kind) && decision.requestedBy.kind === "invocation" && decision.requestedBy.invocationId === id;
          if (decision.runId !== current.runId || decision.status !== "open" || !(approvalOfThis || requestedByThis)) {
            throw new InvariantViolationError(`Decision ${transition.decisionId} is not an open Decision that Invocation ${id} ended on (its intercepted call's approval, or its own request)`, { decisionId: transition.decisionId, kind: decision.kind });
          }
          next.blockedByDecisionId = transition.decisionId;
          type = "invocation.blocked";
          payload = { invocationId: id, decisionId: transition.decisionId };
          break;
        }
        case "succeeded":
          next.result = transition.result;
          type = "invocation.succeeded";
          payload = { invocationId: id, result: transition.result };
          break;
        case "failed":
          next.failureReason = transition.failureReason;
          next.result = transition.result;
          type = "invocation.failed";
          payload = { invocationId: id, failureReason: transition.failureReason };
          break;
        case "cancelled":
          type = "invocation.cancelled";
          payload = { invocationId: id };
          break;
      }
      if (INVOCATION_MACHINE.isTerminal(next.status)) next.endedAt = now;
      parseOrThrow(invocationSchema, next, "Invocation");
      this.ctx.journal.append({
        type,
        scope: runScope(run, { planNodeId: current.planNodeId, invocationId: id }),
        subjectType: "invocation",
        subjectId: id,
        payload: payload as never,
        ...writeMeta(options),
      });
      this.ctx.db
        .update(invocations)
        .set({ status: next.status, waitReason: next.waitReason, failureReason: next.failureReason, blockedByDecisionId: next.blockedByDecisionId, result: next.result, startedAt: next.startedAt, endedAt: next.endedAt })
        .where(eq(invocations.id, id))
        .run();
      if (INVOCATION_MACHINE.isTerminal(next.status)) {
        const reservation = this.reservations.activeForChild({ type: "invocation", id });
        if (reservation) {
          // Complete actual consumption from Usage and Attempt rows; never clamped to the reservation.
          this.reservations.release(reservation.id, "child_terminal", this.usage.consumedByInvocation(id), options);
        }
      }
      return next;
    });
  }

  // ------------------------------------------------------------------ Workspace cleanup obligation

  /**
   * Records that the Invocation's isolated worktree exists and must be
   * released once the Invocation is terminal. Written in the preparation
   * transaction right after the port prepared the worktree, so a rollback
   * leaves no obligation (and the port's compensation removes the worktree).
   */
  recordWorkspaceObligation(id: InvocationId, worktreePath: string, options?: WriteOptions): Invocation {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (current.workspaceCleanup !== "none") throw new ConflictError(`Invocation ${id} already holds a Workspace cleanup obligation (${current.workspaceCleanup})`);
      if (INVOCATION_MACHINE.isTerminal(current.status)) throw new ConflictError(`Invocation ${id} is ${current.status}; a worktree is prepared before execution`);
      const run = loadRunRef(this.ctx, current.runId);
      this.ctx.journal.append({
        type: "invocation.workspace_prepared",
        scope: runScope(run, { planNodeId: current.planNodeId, invocationId: id }),
        subjectType: "invocation",
        subjectId: id,
        payload: { invocationId: id, worktreePath },
        ...writeMeta(options),
      });
      this.ctx.db.update(invocations).set({ workspaceCleanup: "pending" }).where(eq(invocations.id, id)).run();
      return { ...current, workspaceCleanup: "pending" };
    });
  }

  /**
   * Records that the external release succeeded. Only a terminal Invocation
   * with a pending obligation changes; an obligation already released is
   * returned unchanged (repeated release is harmless), and a non-terminal
   * Invocation never releases (a retry reattaches its worktree).
   */
  recordWorkspaceReleased(id: InvocationId, options?: WriteOptions): Invocation {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (current.workspaceCleanup === "released") return current;
      if (current.workspaceCleanup !== "pending") throw new ConflictError(`Invocation ${id} holds no Workspace cleanup obligation`);
      if (!INVOCATION_MACHINE.isTerminal(current.status)) throw new ConflictError(`Invocation ${id} is ${current.status}; its worktree is released only once it is terminal`);
      const run = loadRunRef(this.ctx, current.runId);
      const releasedAt = this.ctx.clock();
      this.ctx.journal.append({
        type: "invocation.workspace_released",
        scope: runScope(run, { planNodeId: current.planNodeId, invocationId: id }),
        subjectType: "invocation",
        subjectId: id,
        payload: { invocationId: id },
        ...writeMeta(options),
      });
      this.ctx.db.update(invocations).set({ workspaceCleanup: "released", workspaceReleasedAt: releasedAt }).where(eq(invocations.id, id)).run();
      return { ...current, workspaceCleanup: "released", workspaceReleasedAt: releasedAt };
    });
  }

  /** Terminal Invocations whose worktree release has not yet succeeded: the outstanding cleanup obligations, in creation order. */
  listPendingWorkspaceCleanup(): Invocation[] {
    return this.ctx.db
      .select()
      .from(invocations)
      .where(and(eq(invocations.workspaceCleanup, "pending"), inArray(invocations.status, [...INVOCATION_MACHINE.terminal])))
      .orderBy(asc(invocations.createdAt), asc(invocations.id))
      .all()
      .map(invocationToDomain);
  }

  // ------------------------------------------------------------------ Manifests

  /**
   * Persists the one immutable manifest of an Invocation together with the
   * renderer contract version it was assembled for; a second write is a
   * conflict. The manifest must agree with the Invocation's row on every
   * fact both carry.
   */
  putManifest(invocationId: InvocationId, content: ContextManifestContent, rendererVersion: number = MANIFEST_RENDERER_VERSION, options?: WriteOptions): ContextManifest {
    const valid = parseOrThrow(contextManifestContentSchema, content, "Context Manifest content");
    return this.ctx.tx.write(() => {
      const invocation = this.get(invocationId);
      if (this.ctx.db.select({ id: contextManifests.id }).from(contextManifests).where(eq(contextManifests.invocationId, invocationId)).get()) {
        throw new ConflictError(`Invocation ${invocationId} already has its Context Manifest`, { invocationId });
      }
      if (valid.runId !== invocation.runId || valid.planNodeId !== invocation.planNodeId) {
        throw new InvariantViolationError("the manifest names another Run or Plan Node than its Invocation");
      }
      if (valid.role !== invocation.role || valid.purpose !== invocation.purpose || valid.agentDefinitionRevisionId !== invocation.agentDefinitionRevisionId) {
        throw new InvariantViolationError("the manifest disagrees with its Invocation's role, purpose, or Agent Definition revision");
      }
      if (valid.continuedFromInvocationId !== invocation.continuedFromInvocationId) {
        throw new InvariantViolationError("the manifest disagrees with its Invocation's continuedFromInvocationId");
      }
      if (canonicalJson(valid.patternPosition) !== canonicalJson(invocation.patternPosition)) {
        throw new InvariantViolationError("the manifest disagrees with its Invocation's Pattern position");
      }
      if (
        valid.allocationSource !== invocation.allocationSource ||
        valid.finalReserveUse !== invocation.finalReserveUse ||
        valid.allocation.costUsd !== invocation.allocation.costUsd ||
        valid.allocation.tokens !== invocation.allocation.tokens ||
        valid.allocation.attempts !== invocation.allocation.attempts
      ) {
        throw new InvariantViolationError("the manifest disagrees with its Invocation's allocation or funding");
      }
      const taskIds = [...invocation.taskIds].sort();
      if (valid.tasks.length !== taskIds.length || valid.tasks.some((t, i) => t.taskId !== taskIds[i])) {
        throw new InvariantViolationError("the manifest's Tasks are exactly the Invocation's Tasks");
      }
      const run = loadRunRef(this.ctx, invocation.runId);
      const manifest: ContextManifest = {
        id: this.ctx.ids("contextManifest"),
        invocationId,
        runId: invocation.runId,
        content: valid,
        digest: sha256Hex(canonicalJson(valid)),
        rendererVersion,
        createdAt: this.ctx.clock(),
      };
      parseOrThrow(contextManifestSchema, manifest, "ContextManifest");
      this.ctx.journal.append({
        type: "context_manifest.created",
        scope: runScope(run, { planNodeId: invocation.planNodeId, invocationId }),
        subjectType: "context_manifest",
        subjectId: manifest.id,
        payload: manifest,
        ...writeMeta(options),
      });
      this.ctx.db.insert(contextManifests).values(manifest).run();
      return manifest;
    });
  }

  getManifest(invocationId: InvocationId): ContextManifest {
    return parseOrThrow(
      contextManifestSchema,
      requireRow(this.ctx.db.select().from(contextManifests).where(eq(contextManifests.invocationId, invocationId)).get(), "ContextManifest for Invocation", invocationId),
      "ContextManifest row",
    );
  }

  // ------------------------------------------------------------------ Attempts

  /**
   * Creates the next Attempt of an Invocation. Attempt 1 is `initial`; every
   * later one is `retry`. Every existing Attempt — succeeded, failed,
   * interrupted, cancelled — counts against the allocation; when none
   * remains the creation is rejected with `AllocationExhaustedError`.
   */
  createAttempt(input: AttemptInput, options?: WriteOptions): Attempt {
    const valid = parseOrThrow(attemptInputSchema, input, "Attempt input");
    return this.ctx.tx.write(() => {
      const invocation = this.get(valid.invocationId);
      if (INVOCATION_MACHINE.isTerminal(invocation.status)) {
        throw new ConflictError(`Invocation ${invocation.id} is ${invocation.status}; no further Attempt is possible`);
      }
      if (!this.ctx.db.select({ id: contextManifests.id }).from(contextManifests).where(eq(contextManifests.invocationId, invocation.id)).get()) {
        throw new InvariantViolationError(`Invocation ${invocation.id} has no Context Manifest; an Attempt cannot start`);
      }
      const existing = this.listAttempts(invocation.id);
      if (existing.some((a) => !ATTEMPT_MACHINE.isTerminal(a.status))) {
        throw new ConflictError(`Invocation ${invocation.id} already has an active Attempt`);
      }
      if (existing.length >= invocation.allocation.attempts) {
        throw new AllocationExhaustedError(
          `Invocation ${invocation.id} has consumed all ${invocation.allocation.attempts} of its Attempts`,
          { invocationId: invocation.id, attempts: existing.length, allocation: invocation.allocation },
        );
      }
      if (valid.resumedFromAttemptId !== null) {
        const prior = this.getAttempt(valid.resumedFromAttemptId);
        const permitted = prior.invocationId === invocation.id || prior.invocationId === invocation.continuedFromInvocationId;
        if (!permitted) {
          throw new InvariantViolationError(
            `Attempt ${prior.id} belongs to neither Invocation ${invocation.id} nor its continuedFromInvocationId`,
          );
        }
        if (!ATTEMPT_MACHINE.isTerminal(prior.status)) throw new ConflictError(`Attempt ${prior.id} has not ended`);
      }
      const number = existing.length + 1;
      const attempt: Attempt = {
        id: this.ctx.ids("attempt"),
        invocationId: invocation.id,
        runId: invocation.runId,
        planNodeId: invocation.planNodeId,
        number,
        kind: number === 1 ? "initial" : "retry",
        startMode: valid.startMode,
        resumedFromAttemptId: valid.resumedFromAttemptId,
        status: "pending",
        failureClass: null,
        failureDetail: null,
        retryDecision: null,
        transcriptArtifactId: null,
        capacityLeaseId: null,
        result: null,
        createdAt: this.ctx.clock(),
        startedAt: null,
        endedAt: null,
      };
      parseOrThrow(attemptSchema, attempt, "Attempt");
      const run = loadRunRef(this.ctx, invocation.runId);
      this.ctx.journal.append({
        type: "attempt.created",
        scope: runScope(run, { planNodeId: invocation.planNodeId, invocationId: invocation.id, attemptId: attempt.id }),
        subjectType: "attempt",
        subjectId: attempt.id,
        payload: attempt,
        ...writeMeta(options),
      });
      this.ctx.db.insert(attempts).values({ ...attempt, retryNotBefore: null }).run();
      return attempt;
    });
  }

  getAttempt(id: AttemptId): Attempt {
    return attemptToDomain(requireRow(this.ctx.db.select().from(attempts).where(eq(attempts.id, id)).get(), "Attempt", id));
  }

  listAttempts(invocationId: InvocationId): Attempt[] {
    return this.ctx.db.select().from(attempts).where(eq(attempts.invocationId, invocationId)).orderBy(asc(attempts.number)).all().map(attemptToDomain);
  }

  /** The highest-numbered Attempt of an Invocation, or `null` before the first. */
  latestAttempt(invocationId: InvocationId): Attempt | null {
    const row = this.ctx.db.select().from(attempts).where(eq(attempts.invocationId, invocationId)).orderBy(desc(attempts.number)).limit(1).get();
    return row ? attemptToDomain(row) : null;
  }

  /** The Invocation's non-terminal Attempt, if one exists (at most one by the schema). */
  activeAttempt(invocationId: InvocationId): Attempt | null {
    const row = this.ctx.db.select().from(attempts).where(and(eq(attempts.invocationId, invocationId), inArray(attempts.status, ["pending", "running"]))).get();
    return row ? attemptToDomain(row) : null;
  }

  /** Attempts consumed by an Invocation: every Attempt row, whatever its outcome. */
  attemptsConsumed(invocationId: InvocationId): number {
    return this.ctx.db.select({ id: attempts.id }).from(attempts).where(eq(attempts.invocationId, invocationId)).all().length;
  }

  transitionAttempt(id: AttemptId, transition: AttemptTransition, options?: WriteOptions): Attempt {
    return this.ctx.tx.write(() => {
      const current = this.getAttempt(id);
      ATTEMPT_MACHINE.assertTransition(current.status, transition.to, { attemptId: id });
      const run = loadRunRef(this.ctx, current.runId);
      const now = this.ctx.clock();
      const next: Attempt = { ...current, status: transition.to };
      let type: "attempt.started" | "attempt.succeeded" | "attempt.failed" | "attempt.timed_out" | "attempt.interrupted" | "attempt.cancelled";
      let payload: unknown;
      if (transition.to === "running") {
        if (transition.capacityLeaseId !== null) {
          const lease = requireRow(this.ctx.db.select({ attemptId: capacityLeases.attemptId, status: capacityLeases.status }).from(capacityLeases).where(eq(capacityLeases.id, transition.capacityLeaseId)).get(), "CapacityLease", transition.capacityLeaseId);
          if (lease.attemptId !== id || lease.status !== "active") throw new InvariantViolationError(`CapacityLease ${transition.capacityLeaseId} is not an active lease for Attempt ${id}`);
        }
        next.startedAt = now;
        next.capacityLeaseId = transition.capacityLeaseId;
        type = "attempt.started";
        payload = { attemptId: id, capacityLeaseId: transition.capacityLeaseId };
      } else {
        if (transition.transcriptArtifactId !== null) {
          const transcript = requireRow(this.ctx.db.select({ runId: artifacts.runId }).from(artifacts).where(eq(artifacts.id, transition.transcriptArtifactId)).get(), "Artifact", transition.transcriptArtifactId);
          assertSameRun("Artifact", transition.transcriptArtifactId, transcript.runId, current.runId);
        }
        next.transcriptArtifactId = transition.transcriptArtifactId;
        next.failureClass = failureClassForTransition(transition);
        if (transition.to !== "succeeded") {
          next.failureDetail = transition.failureDetail ?? null;
          next.retryDecision = transition.retryDecision ?? null;
        }
        next.endedAt = now;
        switch (transition.to) {
          case "succeeded":
            next.result = transition.result;
            type = "attempt.succeeded";
            payload = { attemptId: id, transcriptArtifactId: transition.transcriptArtifactId };
            break;
          case "failed":
            type = "attempt.failed";
            payload = { attemptId: id, failureClass: transition.failureClass };
            break;
          case "timed_out":
            type = "attempt.timed_out";
            payload = { attemptId: id };
            break;
          case "interrupted":
            type = "attempt.interrupted";
            payload = { attemptId: id };
            break;
          case "cancelled":
            type = "attempt.cancelled";
            payload = { attemptId: id };
            break;
        }
      }
      parseOrThrow(attemptSchema, next, "Attempt");
      this.ctx.journal.append({
        type,
        scope: runScope(run, { planNodeId: current.planNodeId, invocationId: current.invocationId, attemptId: id }),
        subjectType: "attempt",
        subjectId: id,
        payload: payload as never,
        ...writeMeta(options),
      });
      this.ctx.db
        .update(attempts)
        .set({
          status: next.status,
          failureClass: next.failureClass,
          failureDetail: next.failureDetail,
          retryDecision: next.retryDecision,
          retryNotBefore: next.retryDecision?.notBefore ?? null,
          transcriptArtifactId: next.transcriptArtifactId,
          capacityLeaseId: next.capacityLeaseId,
          result: next.result,
          startedAt: next.startedAt,
          endedAt: next.endedAt,
        })
        .where(eq(attempts.id, id))
        .run();
      return next;
    });
  }

  /** Every non-terminal Attempt in the database, in creation order: what a restarted process must interrupt. */
  activeAttempts(): Attempt[] {
    return this.ctx.db.select().from(attempts).where(and(inArray(attempts.status, ["pending", "running"]))).orderBy(asc(attempts.createdAt), asc(attempts.id)).all().map(attemptToDomain);
  }

  listByRun(runId: RunId): Invocation[] {
    return this.ctx.db.select().from(invocations).where(eq(invocations.runId, runId)).orderBy(asc(invocations.createdAt), asc(invocations.id)).all().map(invocationToDomain);
  }

  /** One keyset page of a Run's Invocations by `(createdAt, id)`, optionally narrowed to one Plan Node. */
  pageByRun(runId: RunId, query: KeysetQuery, planNodeId?: PlanNodeId): Invocation[] {
    const key = [invocations.createdAt, invocations.id];
    return this.ctx.db
      .select()
      .from(invocations)
      .where(and(eq(invocations.runId, runId), planNodeId === undefined ? undefined : eq(invocations.planNodeId, planNodeId), keysetWhere(key, query)))
      .orderBy(...keysetOrder(key, query))
      .limit(query.limit)
      .all()
      .map(invocationToDomain);
  }

  /** One keyset page of an Invocation's Attempts by number. */
  pageAttempts(invocationId: InvocationId, query: KeysetQuery): Attempt[] {
    const key = [attempts.number];
    return this.ctx.db.select().from(attempts).where(and(eq(attempts.invocationId, invocationId), keysetWhere(key, query))).orderBy(...keysetOrder(key, query)).limit(query.limit).all().map(attemptToDomain);
  }

  /** Non-terminal Invocations of a Run, optionally of one role, in creation order. */
  listActive(runId: RunId, role?: InvocationRole): Invocation[] {
    const conditions = [eq(invocations.runId, runId), inArray(invocations.status, [...ACTIVE_INVOCATION_STATUSES])];
    if (role) conditions.push(eq(invocations.role, role));
    return this.ctx.db.select().from(invocations).where(and(...conditions)).orderBy(asc(invocations.createdAt), asc(invocations.id)).all().map(invocationToDomain);
  }

  /** Every Invocation of a node at one logical position (by `patternPositionKey`), in creation order: the position's history, of which at most one is active. */
  listAtPosition(planNodeId: PlanNodeId, positionKey: string): Invocation[] {
    return this.ctx.db
      .select()
      .from(invocations)
      .where(and(eq(invocations.planNodeId, planNodeId), eq(invocations.patternPositionKey, positionKey)))
      .orderBy(asc(invocations.createdAt), asc(invocations.id))
      .all()
      .map(invocationToDomain);
  }

  /** The most recently created Invocation at a position, or `null` before the first: the predecessor a successor at that position continues from. */
  latestAtPosition(planNodeId: PlanNodeId, positionKey: string): Invocation | null {
    return this.listAtPosition(planNodeId, positionKey).at(-1) ?? null;
  }

  /** The most recently created Invocation of a role on a Plan Node (its logical predecessor for `continuedFromInvocationId`). */
  latestByRole(planNodeId: PlanNodeId, role: InvocationRole): Invocation | null {
    const row = this.ctx.db
      .select()
      .from(invocations)
      .where(and(eq(invocations.planNodeId, planNodeId), eq(invocations.role, role)))
      .orderBy(desc(invocations.createdAt), desc(invocations.id))
      .limit(1)
      .get();
    return row ? invocationToDomain(row) : null;
  }

  private toRow(invocation: Invocation): InvocationRow {
    return {
      id: invocation.id,
      runId: invocation.runId,
      planNodeId: invocation.planNodeId,
      role: invocation.role,
      purpose: invocation.purpose,
      agentDefinitionRevisionId: invocation.agentDefinitionRevisionId,
      continuedFromInvocationId: invocation.continuedFromInvocationId,
      patternPosition: invocation.patternPosition,
      patternPositionKey: invocationPositionKey(invocation.patternPosition),
      gateId: invocation.gateId,
      taskIds: invocation.taskIds,
      allocCostUsd: invocation.allocation.costUsd,
      allocTokens: invocation.allocation.tokens,
      allocAttempts: invocation.allocation.attempts,
      allocationSource: invocation.allocationSource,
      finalReserveUse: invocation.finalReserveUse,
      status: invocation.status,
      waitReason: invocation.waitReason,
      failureReason: invocation.failureReason,
      blockedByDecisionId: invocation.blockedByDecisionId,
      result: invocation.result,
      workspaceCleanup: invocation.workspaceCleanup,
      workspaceReleasedAt: invocation.workspaceReleasedAt,
      createdAt: invocation.createdAt,
      startedAt: invocation.startedAt,
      endedAt: invocation.endedAt,
    };
  }
}
