import { and, asc, eq } from "drizzle-orm";
import {
  ATTEMPT_MACHINE,
  capacityLeaseInputSchema,
  capacityLeaseSchema,
  ConflictError,
  LEASE_MACHINE,
  parseOrThrow,
  type CapacityLease,
  type CapacityLeaseId,
  type CapacityLeaseInput,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { attempts, capacityLeases } from "../schema.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

function toDomain(row: typeof capacityLeases.$inferSelect): CapacityLease {
  return parseOrThrow(capacityLeaseSchema, row, "CapacityLease row");
}

/** Resource Governor grants: one active lease per Attempt, released once. */
export class CapacityLeaseStore {
  constructor(private readonly ctx: PersistenceContext) {}

  grant(input: CapacityLeaseInput, options?: WriteOptions): CapacityLease {
    const valid = parseOrThrow(capacityLeaseInputSchema, input, "CapacityLease input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      const attempt = requireRow(
        this.ctx.db.select({ runId: attempts.runId, status: attempts.status, planNodeId: attempts.planNodeId, invocationId: attempts.invocationId }).from(attempts).where(eq(attempts.id, valid.attemptId)).get(),
        "Attempt",
        valid.attemptId,
      );
      assertSameRun("Attempt", valid.attemptId, attempt.runId, run.id);
      if (ATTEMPT_MACHINE.isTerminal(attempt.status as never)) throw new ConflictError(`Attempt ${valid.attemptId} has ended`);
      if (this.activeForAttempt(valid.attemptId)) throw new ConflictError(`Attempt ${valid.attemptId} already holds a lease`);
      const lease: CapacityLease = { id: this.ctx.ids("capacityLease"), ...valid, status: "active", grantedAt: this.ctx.clock(), releasedAt: null };
      parseOrThrow(capacityLeaseSchema, lease, "CapacityLease");
      this.ctx.journal.append({
        type: "capacity_lease.granted",
        scope: runScope(run, { planNodeId: attempt.planNodeId as never, invocationId: attempt.invocationId as never, attemptId: valid.attemptId }),
        subjectType: "capacity_lease",
        subjectId: lease.id,
        payload: lease,
        ...writeMeta(options),
      });
      this.ctx.db.insert(capacityLeases).values(lease).run();
      return lease;
    });
  }

  get(id: CapacityLeaseId): CapacityLease {
    return toDomain(requireRow(this.ctx.db.select().from(capacityLeases).where(eq(capacityLeases.id, id)).get(), "CapacityLease", id));
  }

  activeForAttempt(attemptId: string): CapacityLease | null {
    const row = this.ctx.db.select().from(capacityLeases).where(and(eq(capacityLeases.attemptId, attemptId), eq(capacityLeases.status, "active"))).get();
    return row ? toDomain(row) : null;
  }

  listActive(): CapacityLease[] {
    return this.ctx.db.select().from(capacityLeases).where(eq(capacityLeases.status, "active")).orderBy(asc(capacityLeases.grantedAt)).all().map(toDomain);
  }

  listByRun(runId: RunId): CapacityLease[] {
    return this.ctx.db.select().from(capacityLeases).where(eq(capacityLeases.runId, runId)).orderBy(asc(capacityLeases.grantedAt)).all().map(toDomain);
  }

  release(id: CapacityLeaseId, options?: WriteOptions): CapacityLease {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      LEASE_MACHINE.assertTransition(current.status, "released", { leaseId: id });
      const run = loadRunRef(this.ctx, current.runId);
      const next: CapacityLease = { ...current, status: "released", releasedAt: this.ctx.clock() };
      this.ctx.journal.append({
        type: "capacity_lease.released",
        scope: runScope(run, { attemptId: current.attemptId }),
        subjectType: "capacity_lease",
        subjectId: id,
        payload: { leaseId: id },
        ...writeMeta(options),
      });
      this.ctx.db.update(capacityLeases).set({ status: "released", releasedAt: next.releasedAt }).where(eq(capacityLeases.id, id)).run();
      return next;
    });
  }
}
