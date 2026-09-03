import { asc, eq } from "drizzle-orm";
import {
  addAllocation,
  budgetIncreasePermitted,
  budgetIncreaseInputSchema,
  budgetIncreaseSchema,
  budgetIncreaseSubjectOf,
  ConflictError,
  InvariantViolationError,
  parseOrThrow,
  RUN_MACHINE,
  ZERO_ALLOCATION,
  type Allocation,
  type BudgetIncrease,
  type BudgetIncreaseId,
  type BudgetIncreaseInput,
  type DecisionId,
  type RunBudgetIncreases,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { budgetIncreases, decisions } from "../schema.ts";
import { loadRunRef, OPERATOR_ACTOR, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

type Row = typeof budgetIncreases.$inferSelect;

function toDomain(row: Row): BudgetIncrease {
  return parseOrThrow(
    budgetIncreaseSchema,
    {
      id: row.id,
      runId: row.runId,
      decisionId: row.decisionId,
      partition: row.partition,
      added: { costUsd: row.addedCostUsd, tokens: row.addedTokens, attempts: row.addedAttempts },
      createdAt: row.createdAt,
    },
    "BudgetIncrease row",
  );
}

/**
 * Budget Increases (execution-model §7.6): the append-only record of every
 * operator-approved enlargement of a Run's effective Budget. `record` admits
 * one row per `budget_increase` Decision the operator resolved `approve`,
 * for a nonterminal Run whose status still admits the named partition, with
 * exactly the partition and quantities the Decision's immutable subject
 * names; the baseline migration's trigger re-checks the same facts at
 * insertion. Nothing here touches the Run row, a reservation, an
 * Invocation, or Usage: effective limits are derived on read
 * (`BudgetReservationStore.runCapacity`).
 */
export class BudgetIncreaseStore {
  constructor(private readonly ctx: PersistenceContext) {}

  record(input: BudgetIncreaseInput, options?: WriteOptions & { id?: BudgetIncreaseId }): BudgetIncrease {
    const valid = parseOrThrow(budgetIncreaseInputSchema, input, "BudgetIncrease input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      if (RUN_MACHINE.isTerminal(run.status)) throw new ConflictError(`Run ${run.id} is ${run.status}; a Budget Increase is recorded for a nonterminal Run`, { runId: run.id, status: run.status });
      if (!budgetIncreasePermitted(run.status, valid.partition)) {
        throw new ConflictError(`Run ${run.id} is ${run.status}; its ${valid.partition} partition cannot be increased now`, { runId: run.id, status: run.status, partition: valid.partition });
      }
      const decisionRow = requireRow(this.ctx.db.select().from(decisions).where(eq(decisions.id, valid.decisionId)).get(), "Decision", valid.decisionId);
      if (decisionRow.kind !== "budget_increase" || decisionRow.runId !== run.id || decisionRow.conversationId !== run.conversationId) {
        throw new InvariantViolationError(`Decision ${valid.decisionId} is not a budget_increase Decision of Run ${run.id}`, { decisionId: valid.decisionId });
      }
      if (decisionRow.status !== "resolved" || decisionRow.resolvedBy !== "operator" || decisionRow.chosenOptionId !== "approve") {
        throw new InvariantViolationError(`Decision ${valid.decisionId} was not resolved 'approve' by the operator`, { decisionId: valid.decisionId, status: decisionRow.status });
      }
      const subject = budgetIncreaseSubjectOf({ id: valid.decisionId, kind: decisionRow.kind, subject: decisionRow.subject });
      if (subject.runId !== run.id || subject.partition !== valid.partition || subject.added.costUsd !== valid.added.costUsd || subject.added.tokens !== valid.added.tokens || subject.added.attempts !== valid.added.attempts) {
        throw new InvariantViolationError(`the subject of Decision ${valid.decisionId} does not authorize this Budget Increase`, { decisionId: valid.decisionId });
      }
      const existing = this.byDecision(valid.decisionId);
      if (existing !== null) throw new ConflictError(`Decision ${valid.decisionId} already authorized Budget Increase ${existing.id}`, { decisionId: valid.decisionId, budgetIncreaseId: existing.id });
      const increase: BudgetIncrease = { id: options?.id ?? this.ctx.ids("budgetIncrease"), runId: run.id, decisionId: valid.decisionId, partition: valid.partition, added: valid.added, createdAt: this.ctx.clock() };
      parseOrThrow(budgetIncreaseSchema, increase, "BudgetIncrease");
      this.ctx.journal.append({
        type: "budget_increase.recorded",
        scope: runScope(run),
        subjectType: "budget_increase",
        subjectId: increase.id,
        payload: increase,
        ...writeMeta(options, OPERATOR_ACTOR),
      });
      this.ctx.db
        .insert(budgetIncreases)
        .values({ id: increase.id, runId: increase.runId, decisionId: increase.decisionId, partition: increase.partition, addedCostUsd: increase.added.costUsd, addedTokens: increase.added.tokens, addedAttempts: increase.added.attempts, createdAt: increase.createdAt })
        .run();
      return increase;
    });
  }

  get(id: BudgetIncreaseId): BudgetIncrease {
    return toDomain(requireRow(this.ctx.db.select().from(budgetIncreases).where(eq(budgetIncreases.id, id)).get(), "BudgetIncrease", id));
  }

  /** The increase an approved Decision authorized, or `null`; at most one exists (a database unique index). */
  byDecision(decisionId: DecisionId): BudgetIncrease | null {
    const row = this.ctx.db.select().from(budgetIncreases).where(eq(budgetIncreases.decisionId, decisionId)).get();
    return row ? toDomain(row) : null;
  }

  /** Every approved increase of a Run, in creation order. */
  listByRun(runId: RunId): BudgetIncrease[] {
    return this.ctx.db.select().from(budgetIncreases).where(eq(budgetIncreases.runId, runId)).orderBy(asc(budgetIncreases.createdAt), asc(budgetIncreases.id)).all().map(toDomain);
  }

  /** The approved increases of a Run summed per partition: what the effective limits add to the immutable base. */
  totalsByRun(runId: RunId): RunBudgetIncreases {
    let ordinary: Allocation = { ...ZERO_ALLOCATION };
    let finalReserve: Allocation = { ...ZERO_ALLOCATION };
    for (const increase of this.listByRun(runId)) {
      if (increase.partition === "ordinary") ordinary = addAllocation(ordinary, increase.added);
      else finalReserve = addAllocation(finalReserve, increase.added);
    }
    return { ordinary, finalReserve };
  }
}
