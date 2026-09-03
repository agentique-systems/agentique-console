import { and, asc, eq } from "drizzle-orm";
import {
  approvedToolCallUseInputSchema,
  approvedToolCallUseSchema,
  parseOrThrow,
  type ApprovalClaimOutcome,
  type ApprovalClaimRefusalReason,
  type ApprovedToolCallUse,
  type ApprovedToolCallUseInput,
  type AttemptId,
  type DecisionId,
  type InvocationId,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { approvedToolCallUses, attempts, contextManifests, decisions, invocations } from "../schema.ts";
import { loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

type Row = typeof approvedToolCallUses.$inferSelect;

function toDomain(row: Row): ApprovedToolCallUse {
  return parseOrThrow(approvedToolCallUseSchema, row, "ApprovedToolCallUse row");
}

/**
 * Approval uses: the canonical, append-only record that an `approve_once`
 * grant was claimed (execution-model §6.4). A claim is the one durable
 * authorization boundary for an `approval_required` call: it runs in its
 * own short root transaction while the provider executes, commits the row
 * and its Event, and only then may the adapter execute the call. The
 * database holds the at-most-once rule — one use per Decision through a
 * unique index, and a BEFORE INSERT trigger that re-checks every
 * ownership fact — so a race between two claimants has exactly one
 * committed winner without any process lock. A refused claim writes
 * nothing; a committed claim is never deleted or updated.
 */
export class ApprovedToolCallUseStore {
  constructor(private readonly ctx: PersistenceContext) {}

  /**
   * Claims the grant named by `input` for the running Attempt, or refuses
   * with a closed reason. Every fact is checked against canonical rows:
   * the Decision is a resolved `approve_once` `side_effect_approval` of the
   * Invocation's Run and Plan Node whose subject names exactly this tool
   * and digest and whose blocked Invocation is the successor's
   * `continuedFromInvocationId`; the successor's manifest carries the
   * grant; the Attempt belongs to the running successor and is itself
   * running; and no use exists yet.
   */
  claim(input: ApprovedToolCallUseInput, options?: WriteOptions): ApprovalClaimOutcome {
    const valid = parseOrThrow(approvedToolCallUseInputSchema, input, "ApprovedToolCallUse input");
    return this.ctx.tx.write((): ApprovalClaimOutcome => {
      const refuse = (reason: ApprovalClaimRefusalReason): ApprovalClaimOutcome => ({ kind: "refused", reason });
      const invocation = requireRow(
        this.ctx.db
          .select({ runId: invocations.runId, planNodeId: invocations.planNodeId, status: invocations.status, continuedFromInvocationId: invocations.continuedFromInvocationId })
          .from(invocations)
          .where(eq(invocations.id, valid.invocationId))
          .get(),
        "Invocation",
        valid.invocationId,
      );
      const attempt = requireRow(this.ctx.db.select({ invocationId: attempts.invocationId, status: attempts.status }).from(attempts).where(eq(attempts.id, valid.attemptId)).get(), "Attempt", valid.attemptId);
      const decision = requireRow(
        this.ctx.db
          .select({ runId: decisions.runId, kind: decisions.kind, status: decisions.status, chosenOptionId: decisions.chosenOptionId, subject: decisions.subject })
          .from(decisions)
          .where(eq(decisions.id, valid.decisionId))
          .get(),
        "Decision",
        valid.decisionId,
      );
      if (decision.kind !== "side_effect_approval" || decision.subject === null || decision.subject.kind !== "side_effect_approval") return refuse("not_side_effect_approval");
      if (decision.status !== "resolved") return refuse("not_resolved");
      if (decision.chosenOptionId !== "approve_once") return refuse("not_approved");
      const subject = decision.subject;
      if (subject.tool !== valid.tool || subject.callDigest !== valid.callDigest) return refuse("call_mismatch");
      if (decision.runId !== invocation.runId || subject.runId !== invocation.runId) return refuse("run_mismatch");
      if (subject.planNodeId !== invocation.planNodeId) return refuse("plan_node_mismatch");
      if (subject.invocationId !== invocation.continuedFromInvocationId) return refuse("predecessor_mismatch");
      const manifest = this.ctx.db.select({ content: contextManifests.content }).from(contextManifests).where(eq(contextManifests.invocationId, valid.invocationId)).get();
      if (!manifest || !manifest.content.approvedCalls.some((g) => g.decisionId === valid.decisionId && g.tool === valid.tool && g.callDigest === valid.callDigest)) return refuse("not_in_manifest");
      if (invocation.status !== "running") return refuse("invocation_not_running");
      if (attempt.invocationId !== valid.invocationId) return refuse("attempt_mismatch");
      if (attempt.status !== "running") return refuse("attempt_not_running");
      if (this.getByDecision(valid.decisionId) !== null) return refuse("already_used");
      const run = loadRunRef(this.ctx, invocation.runId);
      const use: ApprovedToolCallUse = {
        id: this.ctx.ids("approvedToolCallUse"),
        decisionId: valid.decisionId,
        tool: valid.tool,
        callDigest: valid.callDigest,
        runId: run.id,
        planNodeId: invocation.planNodeId as ApprovedToolCallUse["planNodeId"],
        invocationId: valid.invocationId,
        attemptId: valid.attemptId,
        claimedAt: this.ctx.clock(),
      };
      parseOrThrow(approvedToolCallUseSchema, use, "ApprovedToolCallUse");
      this.ctx.journal.append({
        type: "approved_tool_call.used",
        scope: runScope(run, { planNodeId: use.planNodeId, invocationId: use.invocationId, attemptId: use.attemptId }),
        subjectType: "approved_tool_call_use",
        subjectId: use.id,
        payload: use,
        ...writeMeta(options),
      });
      // The unique index on decision_id and the claim trigger are the database's own statement of the same rules.
      this.ctx.db.insert(approvedToolCallUses).values(use).run();
      return { kind: "claimed", use };
    });
  }

  get(id: ApprovedToolCallUse["id"]): ApprovedToolCallUse {
    return toDomain(requireRow(this.ctx.db.select().from(approvedToolCallUses).where(eq(approvedToolCallUses.id, id)).get(), "ApprovedToolCallUse", id));
  }

  /** The one use of a Decision, or `null` while the grant is unclaimed. */
  getByDecision(decisionId: DecisionId): ApprovedToolCallUse | null {
    const row = this.ctx.db.select().from(approvedToolCallUses).where(eq(approvedToolCallUses.decisionId, decisionId)).get();
    return row ? toDomain(row) : null;
  }

  listByInvocation(invocationId: InvocationId): ApprovedToolCallUse[] {
    return this.ctx.db.select().from(approvedToolCallUses).where(eq(approvedToolCallUses.invocationId, invocationId)).orderBy(asc(approvedToolCallUses.claimedAt), asc(approvedToolCallUses.id)).all().map(toDomain);
  }

  listByAttempt(attemptId: AttemptId): ApprovedToolCallUse[] {
    return this.ctx.db.select().from(approvedToolCallUses).where(eq(approvedToolCallUses.attemptId, attemptId)).orderBy(asc(approvedToolCallUses.claimedAt), asc(approvedToolCallUses.id)).all().map(toDomain);
  }

  listByRun(runId: RunId): ApprovedToolCallUse[] {
    return this.ctx.db.select().from(approvedToolCallUses).where(and(eq(approvedToolCallUses.runId, runId))).orderBy(asc(approvedToolCallUses.claimedAt), asc(approvedToolCallUses.id)).all().map(toDomain);
  }

  /**
   * Whether a Decision's grant can still be claimed, from canonical rows
   * alone: it is a resolved `approve_once` `side_effect_approval` with no
   * use. The Attempt-bound checks of `claim` are not repeated here.
   */
  claimable(decisionId: DecisionId): { claimable: true } | { claimable: false; reason: Extract<ApprovalClaimRefusalReason, "not_side_effect_approval" | "not_resolved" | "not_approved" | "already_used"> } {
    const decision = requireRow(this.ctx.db.select({ kind: decisions.kind, status: decisions.status, chosenOptionId: decisions.chosenOptionId }).from(decisions).where(eq(decisions.id, decisionId)).get(), "Decision", decisionId);
    if (decision.kind !== "side_effect_approval") return { claimable: false, reason: "not_side_effect_approval" };
    if (decision.status !== "resolved") return { claimable: false, reason: "not_resolved" };
    if (decision.chosenOptionId !== "approve_once") return { claimable: false, reason: "not_approved" };
    if (this.getByDecision(decisionId) !== null) return { claimable: false, reason: "already_used" };
    return { claimable: true };
  }
}
