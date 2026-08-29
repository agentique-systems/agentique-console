import { and, eq, inArray } from "drizzle-orm";
import {
  ConflictError,
  consumedAllocation,
  INVOCATION_MACHINE,
  parseOrThrow,
  sumUsage,
  usageInputSchema,
  usageSchema,
  type Allocation,
  type AttemptId,
  type InvocationId,
  type InvocationStatus,
  type PlanNodeId,
  type RunId,
  type Usage,
  type UsageInput,
  type UsageTotals,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { attempts, invocations, usage } from "../schema.ts";
import { loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

function toDomain(row: typeof usage.$inferSelect): Usage {
  return parseOrThrow(usageSchema, row, "Usage row");
}

/**
 * Append-only Usage rows per Attempt, attributed to Invocation, Plan Node,
 * and Run from the Attempt itself so attribution can never disagree with
 * the Attempt's ownership. Roll-ups are sums computed on read.
 */
export class UsageStore {
  constructor(private readonly ctx: PersistenceContext) {}

  /**
   * Records one Usage row. Usage is accepted while the owning Invocation is
   * non-terminal — including after its Attempt has ended — and rejected once
   * the Invocation is terminal, because its reservation was released with
   * the consumption known at that moment and must never go stale. The
   * runtime therefore records final Usage, then ends the Attempt, then ends
   * the Invocation.
   */
  record(input: UsageInput, options?: WriteOptions): Usage {
    const valid = parseOrThrow(usageInputSchema, input, "Usage input");
    return this.ctx.tx.write(() => {
      const attempt = requireRow(
        this.ctx.db
          .select({ runId: attempts.runId, planNodeId: attempts.planNodeId, invocationId: attempts.invocationId, invocationStatus: invocations.status })
          .from(attempts)
          .innerJoin(invocations, eq(invocations.id, attempts.invocationId))
          .where(eq(attempts.id, valid.attemptId))
          .get(),
        "Attempt",
        valid.attemptId,
      );
      if (INVOCATION_MACHINE.isTerminal(attempt.invocationStatus as InvocationStatus)) {
        throw new ConflictError(
          `Invocation ${attempt.invocationId} is ${attempt.invocationStatus}; its reservation is released and no further Usage can be attributed to it`,
          { invocationId: attempt.invocationId, attemptId: valid.attemptId, status: attempt.invocationStatus },
        );
      }
      const run = loadRunRef(this.ctx, attempt.runId);
      const row: Usage = {
        id: this.ctx.ids("usage"),
        runId: run.id,
        planNodeId: attempt.planNodeId as PlanNodeId,
        invocationId: attempt.invocationId as InvocationId,
        ...valid,
        recordedAt: this.ctx.clock(),
      };
      parseOrThrow(usageSchema, row, "Usage");
      this.ctx.journal.append({
        type: "usage.recorded",
        scope: runScope(run, { planNodeId: row.planNodeId, invocationId: row.invocationId, attemptId: row.attemptId }),
        subjectType: "usage",
        subjectId: row.id,
        payload: row,
        ...writeMeta(options),
      });
      this.ctx.db.insert(usage).values(row).run();
      return row;
    });
  }

  listByAttempt(attemptId: AttemptId): Usage[] {
    return this.ctx.db.select().from(usage).where(eq(usage.attemptId, attemptId)).all().map(toDomain);
  }

  totalsForAttempt(attemptId: AttemptId): UsageTotals {
    return sumUsage(this.ctx.db.select().from(usage).where(eq(usage.attemptId, attemptId)).all());
  }

  totalsForInvocation(invocationId: InvocationId): UsageTotals {
    return sumUsage(this.ctx.db.select().from(usage).where(eq(usage.invocationId, invocationId)).all());
  }

  totalsForPlanNode(planNodeId: PlanNodeId): UsageTotals {
    return sumUsage(this.ctx.db.select().from(usage).where(eq(usage.planNodeId, planNodeId)).all());
  }

  totalsForRun(runId: RunId): UsageTotals {
    return sumUsage(this.ctx.db.select().from(usage).where(eq(usage.runId, runId)).all());
  }

  /** Consumed cost, tokens, and Attempts of an Invocation as reservation accounting sees them. */
  consumedByInvocation(invocationId: InvocationId): Allocation {
    const attemptCount = this.ctx.db.select({ id: attempts.id }).from(attempts).where(eq(attempts.invocationId, invocationId)).all().length;
    return consumedAllocation(this.totalsForInvocation(invocationId), attemptCount);
  }

  /**
   * Consumed cost, tokens, and Attempts charged to a Plan Node's own
   * allocation: the Invocations funded from the node (`allocationSource:
   * plan_node`). Invocations funded directly from the Run final reserve are
   * attributed to the node for operator-facing `totalsForPlanNode` but are
   * excluded here, because their consumption is recorded on their own
   * Run → Invocation reservation; counting them here as well would charge
   * the Run twice when the node's reservation is released.
   */
  consumedFromPlanNodeAllocation(planNodeId: PlanNodeId): Allocation {
    const funded = this.ctx.db
      .select({ id: invocations.id })
      .from(invocations)
      .where(and(eq(invocations.planNodeId, planNodeId), eq(invocations.allocationSource, "plan_node")))
      .all()
      .map((r) => r.id);
    if (funded.length === 0) return { costUsd: 0, tokens: 0, attempts: 0 };
    const rows = this.ctx.db.select().from(usage).where(inArray(usage.invocationId, funded)).all();
    const attemptCount = this.ctx.db.select({ id: attempts.id }).from(attempts).where(inArray(attempts.invocationId, funded)).all().length;
    return consumedAllocation(sumUsage(rows), attemptCount);
  }
}
