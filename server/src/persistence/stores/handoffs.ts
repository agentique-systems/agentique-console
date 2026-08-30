import { and, asc, eq, inArray } from "drizzle-orm";
import {
  canonicalJson,
  HANDOFF_MACHINE,
  handoffInputSchema,
  handoffKeyOf,
  handoffSchema,
  InvariantViolationError,
  parseOrThrow,
  type Handoff,
  type HandoffEndpoint,
  type HandoffId,
  type HandoffInput,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { artifacts, handoffs, invocations, planNodes, tasks } from "../schema.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

function toDomain(row: typeof handoffs.$inferSelect): Handoff {
  return parseOrThrow(handoffSchema, row, "Handoff row");
}

/**
 * Immutable routing rows with a `pending → delivered | cancelled` lifecycle,
 * identified by the stable key of the logical transfer they carry. One row
 * exists per key per Run: `ensure` is the idempotent entry point every
 * runtime path uses, and the unique index — not a check-then-insert — is
 * what makes repeated reconciliation, transaction retry, restart, and
 * racing callers converge on one Handoff.
 */
export class HandoffStore {
  constructor(private readonly ctx: PersistenceContext) {}

  /**
   * The Handoff for `input.route`, created now or found existing. An
   * existing row must carry the same routing (source, target, Task and
   * Artifact ids); a different transfer under the same key is an invariant
   * violation, never a silent overwrite. Creation writes `handoff.created`;
   * an existing row writes nothing.
   */
  ensure(input: HandoffInput, options?: WriteOptions): { handoff: Handoff; created: boolean } {
    const valid = parseOrThrow(handoffInputSchema, input, "Handoff input");
    return this.ctx.tx.write(() => {
      const existing = this.getByKey(valid.runId, handoffKeyOf(valid.route));
      if (existing !== null) {
        const same = canonicalJson({ source: existing.source, target: existing.target, taskIds: [...existing.taskIds].sort(), artifactIds: [...existing.artifactIds].sort() }) === canonicalJson({ source: valid.source, target: valid.target, taskIds: [...valid.taskIds].sort(), artifactIds: [...valid.artifactIds].sort() });
        if (!same) throw new InvariantViolationError(`Handoff ${existing.id} already carries key ${existing.handoffKey} with different routing`, { handoffId: existing.id, handoffKey: existing.handoffKey });
        return { handoff: existing, created: false };
      }
      return { handoff: this.create(valid, options), created: true };
    });
  }

  create(input: HandoffInput, options?: WriteOptions): Handoff {
    const valid = parseOrThrow(handoffInputSchema, input, "Handoff input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      this.assertEndpoint(valid.source, run.id);
      this.assertEndpoint(valid.target, run.id);
      this.assertRoute(valid);
      if (valid.taskIds.length > 0) {
        const rows = this.ctx.db.select({ id: tasks.id, runId: tasks.runId }).from(tasks).where(inArray(tasks.id, valid.taskIds)).all();
        for (const id of valid.taskIds) assertSameRun("Task", id, requireRow(rows.find((r) => r.id === id), "Task", id).runId, run.id);
      }
      if (valid.artifactIds.length > 0) {
        const rows = this.ctx.db.select({ id: artifacts.id, runId: artifacts.runId }).from(artifacts).where(inArray(artifacts.id, valid.artifactIds)).all();
        for (const id of valid.artifactIds) assertSameRun("Artifact", id, requireRow(rows.find((r) => r.id === id), "Artifact", id).runId, run.id);
      }
      const { route, ...routing } = valid;
      const handoff: Handoff = {
        id: this.ctx.ids("handoff"),
        handoffKey: handoffKeyOf(route),
        ...routing,
        status: "pending",
        createdAt: this.ctx.clock(),
        deliveredAt: null,
      };
      parseOrThrow(handoffSchema, handoff, "Handoff");
      this.ctx.journal.append({
        type: "handoff.created",
        scope: runScope(run, {
          planNodeId: valid.target.kind === "plan_node" ? valid.target.planNodeId : null,
          invocationId: valid.target.kind === "invocation" ? valid.target.invocationId : null,
        }),
        subjectType: "handoff",
        subjectId: handoff.id,
        payload: handoff,
        ...writeMeta(options),
      });
      this.ctx.db.insert(handoffs).values(handoff).run();
      return handoff;
    });
  }

  get(id: HandoffId): Handoff {
    return toDomain(requireRow(this.ctx.db.select().from(handoffs).where(eq(handoffs.id, id)).get(), "Handoff", id));
  }

  /** The one Handoff of a Run with `handoffKey`, or `null`. */
  getByKey(runId: RunId, handoffKey: string): Handoff | null {
    const row = this.ctx.db.select().from(handoffs).where(and(eq(handoffs.runId, runId), eq(handoffs.handoffKey, handoffKey))).get();
    return row ? toDomain(row) : null;
  }

  listByRun(runId: RunId): Handoff[] {
    return this.ctx.db.select().from(handoffs).where(eq(handoffs.runId, runId)).orderBy(asc(handoffs.createdAt)).all().map(toDomain);
  }

  /** Handoffs addressed to one endpoint, in creation order; `status` narrows to one lifecycle state. */
  listByTarget(runId: RunId, target: HandoffEndpoint, status?: Handoff["status"]): Handoff[] {
    return this.listByRun(runId).filter(
      (h) =>
        h.target.kind === target.kind &&
        (target.kind === "plan_node" ? h.target.kind === "plan_node" && h.target.planNodeId === target.planNodeId : h.target.kind === "invocation" && h.target.invocationId === target.invocationId) &&
        (status === undefined || h.status === status),
    );
  }

  transition(id: HandoffId, to: "delivered" | "cancelled", options?: WriteOptions): Handoff {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      HANDOFF_MACHINE.assertTransition(current.status, to, { handoffId: id });
      const run = loadRunRef(this.ctx, current.runId);
      const now = this.ctx.clock();
      const next: Handoff = { ...current, status: to, deliveredAt: to === "delivered" ? now : null };
      parseOrThrow(handoffSchema, next, "Handoff");
      this.ctx.journal.append({
        type: to === "delivered" ? "handoff.delivered" : "handoff.cancelled",
        scope: runScope(run),
        subjectType: "handoff",
        subjectId: id,
        payload: { handoffId: id },
        ...writeMeta(options),
      });
      this.ctx.db.update(handoffs).set({ status: next.status, deliveredAt: next.deliveredAt }).where(eq(handoffs.id, id)).run();
      return next;
    });
  }

  /** The endpoints agree with the route: a sequence transfer runs node to node; a chain-step transfer runs from a step Invocation to its own node. */
  private assertRoute(input: HandoffInput): void {
    const { route, source, target } = input;
    if (route.kind === "sequence") {
      if (source.kind !== "plan_node" || source.planNodeId !== route.sourceNodeId) throw new InvariantViolationError("a sequence Handoff's source is its source Plan Node", { route, source });
      if (target.kind !== "plan_node" || target.planNodeId !== route.targetNodeId) throw new InvariantViolationError("a sequence Handoff's target is its target Plan Node", { route, target });
      return;
    }
    if (target.kind !== "plan_node" || target.planNodeId !== route.planNodeId) throw new InvariantViolationError("a chain-step Handoff's target is its own Plan Node", { route, target });
    if (source.kind !== "invocation") throw new InvariantViolationError("a chain-step Handoff's source is the completed step Invocation", { route, source });
    const invocation = requireRow(this.ctx.db.select({ planNodeId: invocations.planNodeId, patternPosition: invocations.patternPosition }).from(invocations).where(eq(invocations.id, source.invocationId)).get(), "Invocation", source.invocationId);
    const position = invocation.patternPosition;
    if (invocation.planNodeId !== route.planNodeId || position === null || position.kind !== "chain_step" || position.index !== route.fromStep) {
      throw new InvariantViolationError(`Invocation ${source.invocationId} is not chain step ${route.fromStep} of PlanNode ${route.planNodeId}`, { route, source });
    }
  }

  private assertEndpoint(endpoint: HandoffEndpoint, runId: RunId): void {
    if (endpoint.kind === "plan_node") {
      const node = requireRow(this.ctx.db.select({ runId: planNodes.runId }).from(planNodes).where(eq(planNodes.id, endpoint.planNodeId)).get(), "PlanNode", endpoint.planNodeId);
      assertSameRun("PlanNode", endpoint.planNodeId, node.runId, runId);
    } else {
      const invocation = requireRow(this.ctx.db.select({ runId: invocations.runId }).from(invocations).where(eq(invocations.id, endpoint.invocationId)).get(), "Invocation", endpoint.invocationId);
      assertSameRun("Invocation", endpoint.invocationId, invocation.runId, runId);
    }
  }
}
