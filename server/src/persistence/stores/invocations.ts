import { and, asc, eq, inArray } from "drizzle-orm";
import {
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
  invocationSchema,
  InvariantViolationError,
  parseOrThrow,
  PLAN_NODE_MACHINE,
  type Attempt,
  type AttemptId,
  type AttemptInput,
  type AttemptTransition,
  type BudgetReservationId,
  type ContextManifest,
  type ContextManifestContent,
  type Invocation,
  type InvocationId,
  type InvocationInput,
  type InvocationTransition,
  type PlanNodeId,
} from "@agentique-console/core";
import { sha256Hex } from "../blob-store.ts";
import type { PersistenceContext } from "../context.ts";
import { agentDefinitionRevisions, artifacts, attempts, capacityLeases, contextManifests, invocations, planNodes, tasks } from "../schema.ts";
import type { BudgetReservationStore } from "./budgets.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";
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
      taskIds: row.taskIds,
      allocation: { costUsd: row.allocCostUsd, tokens: row.allocTokens, attempts: row.allocAttempts },
      status: row.status,
      waitReason: row.waitReason,
      failureReason: row.failureReason,
      result: row.result,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    },
    "Invocation row",
  );
}

function attemptToDomain(row: AttemptRow): Attempt {
  return parseOrThrow(attemptSchema, row, "Attempt row");
}

export interface InvocationCreateOptions extends WriteOptions {
  /** A Coordinator Task's active reservation to transfer instead of reserving afresh. */
  fromTaskReservationId?: BudgetReservationId;
}

/**
 * Invocations, their Attempts, and their immutable Context Manifests.
 * Creating an Invocation reserves its allocation from its Plan Node (or
 * transfers a Task reservation with two rows) in the same transaction.
 * Creating an Attempt consumes one Attempt from the allocation whatever its
 * later outcome, so an interrupted Attempt is never refunded.
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
        this.ctx.db.select({ runId: planNodes.runId, kind: planNodes.kind, status: planNodes.status }).from(planNodes).where(eq(planNodes.id, valid.planNodeId)).get(),
        "PlanNode",
        valid.planNodeId,
      );
      assertSameRun("PlanNode", valid.planNodeId, node.runId, run.id);
      if (node.kind !== "pattern") {
        throw new InvariantViolationError(`join node ${valid.planNodeId} creates no Invocation`, { planNodeId: valid.planNodeId });
      }
      if (PLAN_NODE_MACHINE.isTerminal(node.status as never)) {
        throw new ConflictError(`PlanNode ${valid.planNodeId} is ${node.status}`);
      }
      requireRow(this.ctx.db.select({ id: agentDefinitionRevisions.id }).from(agentDefinitionRevisions).where(eq(agentDefinitionRevisions.id, valid.agentDefinitionRevisionId)).get(), "AgentDefinitionRevision", valid.agentDefinitionRevisionId);
      if (valid.continuedFromInvocationId !== null) {
        const previous = requireRow(this.ctx.db.select({ runId: invocations.runId }).from(invocations).where(eq(invocations.id, valid.continuedFromInvocationId)).get(), "Invocation", valid.continuedFromInvocationId);
        assertSameRun("Invocation", valid.continuedFromInvocationId, previous.runId, run.id);
      }
      if (valid.taskIds.length > 0) {
        const rows = this.ctx.db.select({ id: tasks.id, runId: tasks.runId }).from(tasks).where(inArray(tasks.id, valid.taskIds)).all();
        for (const id of valid.taskIds) assertSameRun("Task", id, requireRow(rows.find((r) => r.id === id), "Task", id).runId, run.id);
      }
      const invocation: Invocation = {
        id: this.ctx.ids("invocation"),
        ...valid,
        status: "pending",
        waitReason: null,
        failureReason: null,
        result: null,
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
      if (options?.fromTaskReservationId) {
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
        this.reservations.reserve(
          { runId: run.id, parent: { type: "plan_node", id: valid.planNodeId }, child: { type: "invocation", id: invocation.id }, amount: valid.allocation },
          options,
        );
      }
      return invocation;
    });
  }

  get(id: InvocationId): Invocation {
    return invocationToDomain(requireRow(this.ctx.db.select().from(invocations).where(eq(invocations.id, id)).get(), "Invocation", id));
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
      let type: "invocation.started" | "invocation.waiting" | "invocation.wait_cleared" | "invocation.succeeded" | "invocation.failed" | "invocation.cancelled";
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
        .set({ status: next.status, waitReason: next.waitReason, failureReason: next.failureReason, result: next.result, startedAt: next.startedAt, endedAt: next.endedAt })
        .where(eq(invocations.id, id))
        .run();
      if (INVOCATION_MACHINE.isTerminal(next.status)) {
        const reservation = this.reservations.activeForChild({ type: "invocation", id });
        if (reservation) {
          const consumed = this.usage.consumedByInvocation(id);
          this.reservations.release(
            reservation.id,
            "child_terminal",
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

  // ------------------------------------------------------------------ Manifests

  /** Persists the one immutable manifest of an Invocation; a second write is a conflict. */
  putManifest(invocationId: InvocationId, content: ContextManifestContent, options?: WriteOptions): ContextManifest {
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
      const run = loadRunRef(this.ctx, invocation.runId);
      const manifest: ContextManifest = {
        id: this.ctx.ids("contextManifest"),
        invocationId,
        runId: invocation.runId,
        content: valid,
        digest: sha256Hex(canonicalJson(valid)),
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
      this.ctx.db.insert(attempts).values(attempt).run();
      return attempt;
    });
  }

  getAttempt(id: AttemptId): Attempt {
    return attemptToDomain(requireRow(this.ctx.db.select().from(attempts).where(eq(attempts.id, id)).get(), "Attempt", id));
  }

  listAttempts(invocationId: InvocationId): Attempt[] {
    return this.ctx.db.select().from(attempts).where(eq(attempts.invocationId, invocationId)).orderBy(asc(attempts.number)).all().map(attemptToDomain);
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

  activeAttempts(): Attempt[] {
    return this.ctx.db.select().from(attempts).where(and(inArray(attempts.status, ["pending", "running"]))).all().map(attemptToDomain);
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
      taskIds: invocation.taskIds,
      allocCostUsd: invocation.allocation.costUsd,
      allocTokens: invocation.allocation.tokens,
      allocAttempts: invocation.allocation.attempts,
      status: invocation.status,
      waitReason: invocation.waitReason,
      failureReason: invocation.failureReason,
      result: invocation.result,
      createdAt: invocation.createdAt,
      startedAt: invocation.startedAt,
      endedAt: invocation.endedAt,
    };
  }
}
