/**
 * Run Budget Increases (execution-model §7.6, §8.2; invariants 19 and 22):
 * the one execution-layer boundary through which the operator-facing layer
 * enlarges a Run's effective Budget, with three separated operations:
 *
 * - `request` opens the Run's one `budget_increase` Decision — always
 *   `operator_required`, exactly the options `approve` and `deny`, no
 *   default deadline, an immutable typed subject naming the Run, the
 *   partition, and the exact added cost, tokens, and Attempts. An identical
 *   open request replays; a different one is refused while another increase
 *   Decision is open; nothing is granted until the operator approves.
 * - `resolve` records the operator's answer: `deny` resolves the Decision
 *   and creates nothing; `approve` resolves it and records exactly one
 *   Budget Increase in the same root transaction, journaled in one
 *   correlation chain. It creates no Invocation, no Usage, and no narrative,
 *   and moves no Run: the next explicit scheduler pass derives that
 *   capacity is now available and performs the ordinary resume. Identical
 *   replays return the canonical result; conflicting ones are refused.
 * - `inspect` is a bounded read-only projection: the effective capacity, the
 *   increase Decisions and the increases they authorized, and the allowed
 *   actions.
 *
 * A Budget Increase is runtime control, never model work: no runtime tool
 * exposes it, and resolving one creates no `decision_resolution` turn. The
 * base Budget on the Run is never rewritten; every effective limit derives
 * from it plus these append-only records.
 */
import {
  addedAllocationSchema,
  BUDGET_INCREASE_OPTIONS,
  BUDGET_INCREASE_PARTITIONS,
  budgetIncreasePermitted,
  BudgetIncreaseRefusedError,
  budgetIncreaseSubjectOf,
  NotFoundError,
  parseOrThrow,
  RUN_MACHINE,
  ValidationError,
  type Allocation,
  type AllocationExtension,
  type BudgetIncrease,
  type BudgetIncreaseId,
  type BudgetIncreaseOption,
  type BudgetIncreasePartition,
  type Decision,
  type DecisionId,
  type Run,
  type RunCapacity,
  type RunId,
  type RunStatus,
} from "@agentique-console/core";
import { z } from "zod";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import { OPERATOR_ACTOR, type WriteOptions } from "../persistence/stores/support.ts";

export interface BudgetIncreaseRequestInput {
  runId: RunId;
  partition: BudgetIncreasePartition;
  /** The exact quantities to add; non-negative, at least one positive. */
  added: Allocation;
}

const requestInputSchema = z.strictObject({
  runId: z.string(),
  partition: z.enum(BUDGET_INCREASE_PARTITIONS),
  added: addedAllocationSchema,
});

export interface BudgetIncreaseResolveInput {
  runId: RunId;
  decisionId: DecisionId;
  option: BudgetIncreaseOption;
}

export type BudgetIncreaseResolutionOutcome =
  | { kind: "denied"; decisionId: DecisionId; replayed: boolean }
  | { kind: "approved"; decisionId: DecisionId; budgetIncreaseId: BudgetIncreaseId; replayed: boolean };

/** The bounded, read-only projection of a Run's Budget Increases for an operator-facing layer: facts and allowed actions only. */
export interface BudgetIncreaseProjection {
  runId: RunId;
  runStatus: RunStatus;
  /** The effective capacity: base limits, approved increases per partition, effective limits, and every account. */
  capacity: RunCapacity;
  openDecision: { decisionId: DecisionId; partition: BudgetIncreasePartition; added: Allocation } | null;
  decisions: { decisionId: DecisionId; partition: BudgetIncreasePartition; added: Allocation; status: Decision["status"]; chosenOptionId: string | null; budgetIncreaseId: BudgetIncreaseId | null }[];
  increases: BudgetIncrease[];
  /** Every Allocation Extension of the Run, in creation order. */
  extensions: AllocationExtension[];
  /** The partitions an increase may be requested for now, and whether the open Decision may be resolved. */
  allowedActions: ("request_ordinary" | "request_final_reserve" | "resolve")[];
}

export interface BudgetIncreaseServiceDependencies {
  ctx: PersistenceContext;
  stores: Stores;
}

const sameAllocation = (a: Allocation, b: Allocation) => a.costUsd === b.costUsd && a.tokens === b.tokens && a.attempts === b.attempts;

export class BudgetIncreaseService {
  constructor(private readonly deps: BudgetIncreaseServiceDependencies) {}

  private get ctx(): PersistenceContext {
    return this.deps.ctx;
  }

  private get stores(): Stores {
    return this.deps.stores;
  }

  // ---------------------------------------------------------------------------
  // Request: the budget_increase Decision
  // ---------------------------------------------------------------------------

  /**
   * Opens the Run's one `budget_increase` Decision for the exact increase.
   * An identical open request replays the existing Decision; a request
   * while another increase Decision is open is refused; a terminal Run, a
   * partition the Run's status no longer admits, and a zero or negative
   * increase are refused before any write.
   */
  request(input: BudgetIncreaseRequestInput, options: WriteOptions = {}): { decision: Decision; replayed: boolean } {
    const parsed = requestInputSchema.safeParse(input);
    if (!parsed.success) throw new BudgetIncreaseRefusedError("invalid_increase", `a Budget Increase adds non-negative quantities of which at least one is positive: ${parsed.error.issues[0]?.message ?? "invalid input"}`, { runId: input.runId });
    const valid = parsed.data;
    return this.ctx.tx.write(() => {
      const run = this.increasableRun(valid.runId as RunId, valid.partition);
      const open = this.stores.decisions.openBudgetIncreaseOf(run.id);
      if (open !== null) {
        const subject = budgetIncreaseSubjectOf(open);
        if (subject.partition === valid.partition && sameAllocation(subject.added, valid.added)) return { decision: open, replayed: true };
        throw new BudgetIncreaseRefusedError("budget_increase_decision_open", `Run ${run.id} already has open budget_increase Decision ${open.id} for another increase`, { runId: run.id, decisionId: open.id });
      }
      const decision = this.stores.decisions.request(
        {
          conversationId: run.conversationId,
          runId: run.id,
          kind: "budget_increase",
          resolutionPolicy: "operator_required",
          requestedBy: { kind: "operator" },
          question: `Increase the ${valid.partition === "ordinary" ? "ordinary" : "final-reserve"} Budget of Run ${run.id} by ${valid.added.costUsd} USD, ${valid.added.tokens} tokens, and ${valid.added.attempts} Attempts?`,
          options: [
            { id: BUDGET_INCREASE_OPTIONS[0], label: "Approve", description: null },
            { id: BUDGET_INCREASE_OPTIONS[1], label: "Deny", description: null },
          ],
          recommendedOptionId: null,
          rationale: null,
          affects: { requirementIds: [], taskIds: [], planNodeIds: [] },
          deadlineAt: null,
          activationCondition: null,
          subject: { kind: "budget_increase", runId: run.id, partition: valid.partition, added: valid.added },
          supersedesDecisionId: null,
        },
        { ...options, actor: options.actor ?? OPERATOR_ACTOR },
      );
      return { decision, replayed: false };
    });
  }

  // ---------------------------------------------------------------------------
  // Resolve: the operator's answer
  // ---------------------------------------------------------------------------

  /**
   * Resolves the Run's `budget_increase` Decision as the operator. `deny`
   * resolves it and creates nothing; `approve` resolves it and records
   * exactly one Budget Increase of exactly the subject's quantities in the
   * same transaction, both Events in one correlation chain. Identical
   * replays return the canonical result; a conflicting replay is refused;
   * an approval the Run's status no longer admits is refused before any
   * write. No Invocation, Usage, or Run transition results: the scheduler's
   * next pass derives the new capacity from rows.
   */
  resolve(input: BudgetIncreaseResolveInput, options: WriteOptions = {}): BudgetIncreaseResolutionOutcome {
    if (!(BUDGET_INCREASE_OPTIONS as readonly string[]).includes(input.option)) throw new BudgetIncreaseRefusedError("decision_mismatch", `${String(input.option)} is not a budget_increase option`, { decisionId: input.decisionId });
    return this.ctx.tx.write(() => {
      const run = this.stores.runs.get(input.runId);
      let decision: Decision;
      try {
        decision = this.stores.decisions.get(input.decisionId);
      } catch (error) {
        if (error instanceof NotFoundError) throw new BudgetIncreaseRefusedError("decision_mismatch", `Decision ${input.decisionId} does not exist`, { decisionId: input.decisionId });
        throw error;
      }
      if (decision.kind !== "budget_increase" || decision.runId !== run.id || decision.conversationId !== run.conversationId || decision.resolutionPolicy !== "operator_required") {
        throw new BudgetIncreaseRefusedError("decision_mismatch", `Decision ${input.decisionId} is not the operator-required budget_increase Decision of Run ${run.id}`, { runId: run.id, decisionId: input.decisionId });
      }
      let subject;
      try {
        subject = budgetIncreaseSubjectOf(decision);
      } catch (error) {
        if (error instanceof ValidationError) throw new BudgetIncreaseRefusedError("boundary_inconsistent", `Decision ${decision.id} carries no budget_increase subject`, { decisionId: decision.id });
        throw error;
      }
      if (subject.runId !== run.id) throw new BudgetIncreaseRefusedError("boundary_inconsistent", `the subject of Decision ${decision.id} names Run ${subject.runId}, not ${run.id}`, { runId: run.id, decisionId: decision.id });
      if (decision.status !== "open") {
        const chosen = decision.resolution?.chosenOptionId ?? null;
        if (decision.status === "resolved" && chosen === input.option) {
          if (chosen === "deny") return { kind: "denied", decisionId: decision.id, replayed: true };
          const existing = this.stores.budgetIncreases.byDecision(decision.id);
          if (existing === null) throw new BudgetIncreaseRefusedError("boundary_inconsistent", `Decision ${decision.id} was approved without its Budget Increase`, { decisionId: decision.id });
          return { kind: "approved", decisionId: decision.id, budgetIncreaseId: existing.id, replayed: true };
        }
        throw new BudgetIncreaseRefusedError("conflicting_resolution", `Decision ${decision.id} is ${decision.status}${chosen === null ? "" : ` (${chosen})`}; ${input.option} conflicts with it`, { decisionId: decision.id, chosen, requested: input.option });
      }
      const meta: WriteOptions = { actor: options.actor ?? OPERATOR_ACTOR, correlationId: options.correlationId ?? decision.id, causationSeq: options.causationSeq ?? null };
      if (input.option === "deny") {
        this.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "deny", rationale: null, artifactIds: [] }, meta);
        return { kind: "denied", decisionId: decision.id, replayed: false };
      }
      // `approve`: the Run must still admit the partition; then the resolution and the one increase commit together.
      this.increasableRun(run.id, subject.partition);
      this.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "approve", rationale: null, artifactIds: [] }, meta);
      const increase = this.stores.budgetIncreases.record({ runId: run.id, decisionId: decision.id, partition: subject.partition, added: subject.added }, { ...meta, causationSeq: this.ctx.journal.lastSeq() });
      return { kind: "approved", decisionId: decision.id, budgetIncreaseId: increase.id, replayed: false };
    });
  }

  // ---------------------------------------------------------------------------
  // Inspect (read-only)
  // ---------------------------------------------------------------------------

  /** The bounded projection of the Run's Budget Increases: effective capacity, Decisions, increases, extensions, and allowed actions; writes nothing. */
  inspect(runId: RunId): BudgetIncreaseProjection {
    const run = this.stores.runs.get(runId);
    const open = this.stores.decisions.openBudgetIncreaseOf(run.id);
    const decisions = this.stores.decisions.budgetIncreaseDecisionsOf(run.id).map((d) => {
      const subject = budgetIncreaseSubjectOf(d);
      return { decisionId: d.id, partition: subject.partition, added: subject.added, status: d.status, chosenOptionId: d.resolution?.chosenOptionId ?? null, budgetIncreaseId: this.stores.budgetIncreases.byDecision(d.id)?.id ?? null };
    });
    const allowedActions: BudgetIncreaseProjection["allowedActions"] = [];
    if (open === null && !RUN_MACHINE.isTerminal(run.status)) {
      if (budgetIncreasePermitted(run.status, "ordinary")) allowedActions.push("request_ordinary");
      if (budgetIncreasePermitted(run.status, "final_reserve")) allowedActions.push("request_final_reserve");
    }
    if (open !== null) allowedActions.push("resolve");
    const openSubject = open === null ? null : budgetIncreaseSubjectOf(open);
    return {
      runId: run.id,
      runStatus: run.status,
      capacity: this.stores.reservations.runCapacity(run.id),
      openDecision: open === null || openSubject === null ? null : { decisionId: open.id, partition: openSubject.partition, added: openSubject.added },
      decisions,
      increases: this.stores.budgetIncreases.listByRun(run.id),
      extensions: this.stores.allocationExtensions.listByRun(run.id),
      allowedActions,
    };
  }

  // ---------------------------------------------------------------------------
  // Shared
  // ---------------------------------------------------------------------------

  /** The Run, refused typed when terminal or when its status does not admit an increase of `partition`. */
  private increasableRun(runId: RunId, partition: BudgetIncreasePartition): Run {
    const run = this.stores.runs.get(runId);
    if (RUN_MACHINE.isTerminal(run.status)) throw new BudgetIncreaseRefusedError("run_terminal", `Run ${run.id} is ${run.status}; its Budget is never increased`, { runId: run.id, status: run.status });
    if (!budgetIncreasePermitted(run.status, partition)) {
      throw new BudgetIncreaseRefusedError("partition_not_increasable", `Run ${run.id} is ${run.status}; its ${partition} partition cannot be increased now`, { runId: run.id, status: run.status, partition });
    }
    return run;
  }
}
