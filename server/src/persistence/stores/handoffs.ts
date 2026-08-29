import { asc, eq, inArray } from "drizzle-orm";
import {
  HANDOFF_MACHINE,
  handoffInputSchema,
  handoffSchema,
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

/** Immutable routing rows with a `pending → delivered | cancelled` lifecycle. */
export class HandoffStore {
  constructor(private readonly ctx: PersistenceContext) {}

  create(input: HandoffInput, options?: WriteOptions): Handoff {
    const valid = parseOrThrow(handoffInputSchema, input, "Handoff input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      this.assertEndpoint(valid.source, run.id);
      this.assertEndpoint(valid.target, run.id);
      if (valid.taskIds.length > 0) {
        const rows = this.ctx.db.select({ id: tasks.id, runId: tasks.runId }).from(tasks).where(inArray(tasks.id, valid.taskIds)).all();
        for (const id of valid.taskIds) assertSameRun("Task", id, requireRow(rows.find((r) => r.id === id), "Task", id).runId, run.id);
      }
      if (valid.artifactIds.length > 0) {
        const rows = this.ctx.db.select({ id: artifacts.id, runId: artifacts.runId }).from(artifacts).where(inArray(artifacts.id, valid.artifactIds)).all();
        for (const id of valid.artifactIds) assertSameRun("Artifact", id, requireRow(rows.find((r) => r.id === id), "Artifact", id).runId, run.id);
      }
      const handoff: Handoff = {
        id: this.ctx.ids("handoff"),
        ...valid,
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
