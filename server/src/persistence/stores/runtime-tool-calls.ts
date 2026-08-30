import { and, asc, eq } from "drizzle-orm";
import {
  ConflictError,
  InvariantViolationError,
  parseOrThrow,
  runtimeToolCallInputSchema,
  runtimeToolCallSchema,
  type AttemptId,
  type InvocationId,
  type PlanNodeId,
  type RuntimeToolCall,
  type RuntimeToolCallId,
  type RuntimeToolCallInput,
  type RuntimeToolCallTool,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { attempts, invocations, runtimeToolCalls } from "../schema.ts";
import { loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

type Row = typeof runtimeToolCalls.$inferSelect;

function toDomain(row: Row): RuntimeToolCall {
  return parseOrThrow(runtimeToolCallSchema, row, "RuntimeToolCall row");
}

/**
 * Runtime-tool calls (execution-model §6.4): the append-only canonical record
 * of every accepted mutating runtime-tool call, keyed by Invocation, tool,
 * and canonical digest. The runtime-tool executor records a call in the same
 * short root transaction as the domain mutation it applied; a retry that
 * submits the same call finds the row and replays its bounded result. A
 * rejected call never reaches this store. Rows are never updated or deleted.
 */
export class RuntimeToolCallStore {
  constructor(private readonly ctx: PersistenceContext) {}

  /**
   * Records one accepted call for the running Attempt of a running
   * Invocation. The Run and Plan Node derive from the Invocation; a second
   * row for the same Invocation, tool, and digest is a conflict, as is a
   * second `propose_tasks` row for one Invocation.
   */
  record(input: RuntimeToolCallInput, options?: WriteOptions): RuntimeToolCall {
    const valid = parseOrThrow(runtimeToolCallInputSchema, input, "RuntimeToolCall input");
    return this.ctx.tx.write(() => {
      const invocation = requireRow(
        this.ctx.db.select({ runId: invocations.runId, planNodeId: invocations.planNodeId, status: invocations.status }).from(invocations).where(eq(invocations.id, valid.invocationId)).get(),
        "Invocation",
        valid.invocationId,
      );
      const attempt = requireRow(this.ctx.db.select({ invocationId: attempts.invocationId, status: attempts.status }).from(attempts).where(eq(attempts.id, valid.attemptId)).get(), "Attempt", valid.attemptId);
      if (attempt.invocationId !== valid.invocationId) throw new InvariantViolationError(`Attempt ${valid.attemptId} does not belong to Invocation ${valid.invocationId}`);
      if (invocation.status !== "running" || attempt.status !== "running") {
        throw new ConflictError(`Invocation ${valid.invocationId} (${invocation.status}) and Attempt ${valid.attemptId} (${attempt.status}) must both be running to accept a runtime-tool call`);
      }
      if (this.find(valid.invocationId, valid.tool, valid.callDigest) !== null) {
        throw new ConflictError(`Invocation ${valid.invocationId} already committed ${valid.tool} call ${valid.callDigest}`, { tool: valid.tool, callDigest: valid.callDigest });
      }
      if (valid.tool === "propose_tasks" && this.listByInvocation(valid.invocationId).some((c) => c.tool === "propose_tasks")) {
        throw new ConflictError(`Invocation ${valid.invocationId} already accepted a Task proposal`, { invocationId: valid.invocationId });
      }
      const run = loadRunRef(this.ctx, invocation.runId);
      const call: RuntimeToolCall = {
        id: this.ctx.ids("runtimeToolCall"),
        runId: run.id,
        planNodeId: invocation.planNodeId as PlanNodeId,
        invocationId: valid.invocationId,
        attemptId: valid.attemptId,
        tool: valid.tool,
        callDigest: valid.callDigest,
        result: valid.result,
        committedAt: this.ctx.clock(),
      };
      parseOrThrow(runtimeToolCallSchema, call, "RuntimeToolCall");
      this.ctx.journal.append({
        type: "runtime_tool_call.committed",
        scope: runScope(run, { planNodeId: call.planNodeId, invocationId: call.invocationId, attemptId: call.attemptId }),
        subjectType: "runtime_tool_call",
        subjectId: call.id,
        payload: call,
        ...writeMeta(options, { kind: "invocation", invocationId: call.invocationId }),
      });
      this.ctx.db.insert(runtimeToolCalls).values(call).run();
      return call;
    });
  }

  get(id: RuntimeToolCallId): RuntimeToolCall {
    return toDomain(requireRow(this.ctx.db.select().from(runtimeToolCalls).where(eq(runtimeToolCalls.id, id)).get(), "RuntimeToolCall", id));
  }

  /** The committed call of an Invocation with this tool and digest, or `null`: the replay lookup. */
  find(invocationId: InvocationId, tool: RuntimeToolCallTool, callDigest: string): RuntimeToolCall | null {
    const row = this.ctx.db
      .select()
      .from(runtimeToolCalls)
      .where(and(eq(runtimeToolCalls.invocationId, invocationId), eq(runtimeToolCalls.tool, tool), eq(runtimeToolCalls.callDigest, callDigest)))
      .get();
    return row ? toDomain(row) : null;
  }

  listByInvocation(invocationId: InvocationId): RuntimeToolCall[] {
    return this.ctx.db.select().from(runtimeToolCalls).where(eq(runtimeToolCalls.invocationId, invocationId)).orderBy(asc(runtimeToolCalls.committedAt), asc(runtimeToolCalls.id)).all().map(toDomain);
  }

  listByAttempt(attemptId: AttemptId): RuntimeToolCall[] {
    return this.ctx.db.select().from(runtimeToolCalls).where(eq(runtimeToolCalls.attemptId, attemptId)).orderBy(asc(runtimeToolCalls.committedAt), asc(runtimeToolCalls.id)).all().map(toDomain);
  }

  listByPlanNode(planNodeId: PlanNodeId): RuntimeToolCall[] {
    return this.ctx.db.select().from(runtimeToolCalls).where(eq(runtimeToolCalls.planNodeId, planNodeId)).orderBy(asc(runtimeToolCalls.committedAt), asc(runtimeToolCalls.id)).all().map(toDomain);
  }
}
