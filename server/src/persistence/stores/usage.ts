import { eq } from "drizzle-orm";
import {
  consumedAllocation,
  parseOrThrow,
  sumUsage,
  usageInputSchema,
  usageSchema,
  type Allocation,
  type AttemptId,
  type InvocationId,
  type PlanNodeId,
  type RunId,
  type Usage,
  type UsageInput,
  type UsageTotals,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { attempts, usage } from "../schema.ts";
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

  record(input: UsageInput, options?: WriteOptions): Usage {
    const valid = parseOrThrow(usageInputSchema, input, "Usage input");
    return this.ctx.tx.write(() => {
      const attempt = requireRow(
        this.ctx.db
          .select({ runId: attempts.runId, planNodeId: attempts.planNodeId, invocationId: attempts.invocationId })
          .from(attempts)
          .where(eq(attempts.id, valid.attemptId))
          .get(),
        "Attempt",
        valid.attemptId,
      );
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

  /** Consumed cost, tokens, and Attempts of every Invocation of a Plan Node. */
  consumedByPlanNode(planNodeId: PlanNodeId): Allocation {
    const attemptCount = this.ctx.db.select({ id: attempts.id }).from(attempts).where(eq(attempts.planNodeId, planNodeId)).all().length;
    return consumedAllocation(this.totalsForPlanNode(planNodeId), attemptCount);
  }
}
