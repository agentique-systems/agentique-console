import { and, asc, eq, inArray } from "drizzle-orm";
import {
  COMPLETION_REQUEST_MACHINE,
  completionRequestInputSchema,
  completionRequestOutcomeSchema,
  completionRequestSchema,
  ConflictError,
  InvariantViolationError,
  parseOrThrow,
  type CompletionRequest,
  type CompletionRequestId,
  type CompletionRequestInput,
  type CompletionRequestTransition,
  type InvocationId,
  type RunId,
  type RuntimeToolCallId,
  runIsRunningOrDraining,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { artifacts, completionRequests, gates, invocations, runs, runtimeToolCalls } from "../schema.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

type Row = typeof completionRequests.$inferSelect;

function toDomain(row: Row): CompletionRequest {
  return parseOrThrow(completionRequestSchema, row, "CompletionRequest row");
}

/**
 * Completion Requests (execution-model §10 `run_completion`): the canonical
 * lifecycle record of one completion attempt, created by the accepted
 * `request_completion` runtime-tool call of a root Orchestrator turn. At
 * most one non-terminal request exists per Run (a partial unique index);
 * the requesting Invocation and the accepted call each name at most one
 * request, so a replay finds the same row. Every transition validates the
 * closed machine and writes its Event with the row; terminal rows are
 * history and never change again.
 */
export class CompletionRequestStore {
  constructor(private readonly ctx: PersistenceContext) {}

  /**
   * Creates a request in `requested` for a running root Orchestrator
   * Invocation of a running Run, naming the accepted runtime-tool call that
   * created it; a second non-terminal request of the Run is a conflict.
   */
  create(input: CompletionRequestInput, options?: WriteOptions & { id?: CompletionRequestId }): CompletionRequest {
    const valid = parseOrThrow(completionRequestInputSchema, input, "CompletionRequest input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      const pause = requireRow(this.ctx.db.select({ operatorPause: runs.operatorPause }).from(runs).where(eq(runs.id, run.id)).get(), "Run", run.id).operatorPause;
      // A running Run, or one draining its admitted turn under a soft operator pause (execution-model §14).
      if (!runIsRunningOrDraining({ status: run.status, operatorPause: pause as never })) throw new ConflictError(`Run ${run.id} is ${run.status}${pause === null ? "" : ` and paused (${pause})`}; completion is requested from a running Run`, { runId: run.id, status: run.status });
      const invocation = requireRow(this.ctx.db.select({ runId: invocations.runId, role: invocations.role, purpose: invocations.purpose, status: invocations.status }).from(invocations).where(eq(invocations.id, valid.invocationId)).get(), "Invocation", valid.invocationId);
      assertSameRun("Invocation", valid.invocationId, invocation.runId, run.id);
      if (invocation.role !== "orchestrator" || invocation.purpose === "final_synthesis") throw new InvariantViolationError(`Invocation ${valid.invocationId} (${invocation.role}/${invocation.purpose}) cannot request completion`, { invocationId: valid.invocationId });
      if (invocation.status !== "running") throw new ConflictError(`Invocation ${valid.invocationId} is ${invocation.status}; completion is requested by a running turn`, { invocationId: valid.invocationId });
      const call = requireRow(this.ctx.db.select({ invocationId: runtimeToolCalls.invocationId, tool: runtimeToolCalls.tool }).from(runtimeToolCalls).where(eq(runtimeToolCalls.id, valid.runtimeToolCallId)).get(), "RuntimeToolCall", valid.runtimeToolCallId);
      if (call.invocationId !== valid.invocationId || call.tool !== "request_completion") throw new InvariantViolationError(`RuntimeToolCall ${valid.runtimeToolCallId} is not a request_completion call of Invocation ${valid.invocationId}`, { runtimeToolCallId: valid.runtimeToolCallId });
      const active = this.activeOf(run.id);
      if (active !== null) throw new ConflictError(`Run ${run.id} already has Completion Request ${active.id} (${active.status})`, { runId: run.id, completionRequestId: active.id });
      const request: CompletionRequest = {
        id: options?.id ?? this.ctx.ids("completionRequest"),
        runId: run.id,
        invocationId: valid.invocationId,
        runtimeToolCallId: valid.runtimeToolCallId,
        status: "requested",
        gateId: null,
        reportArtifactId: null,
        outcome: null,
        createdAt: this.ctx.clock(),
        startedAt: null,
        endedAt: null,
      };
      parseOrThrow(completionRequestSchema, request, "CompletionRequest");
      this.ctx.journal.append({
        type: "completion_request.created",
        scope: runScope(run, { invocationId: request.invocationId }),
        subjectType: "completion_request",
        subjectId: request.id,
        payload: request,
        ...writeMeta(options, { kind: "invocation", invocationId: request.invocationId }),
      });
      this.ctx.db.insert(completionRequests).values(request).run();
      return request;
    });
  }

  get(id: CompletionRequestId): CompletionRequest {
    return toDomain(requireRow(this.ctx.db.select().from(completionRequests).where(eq(completionRequests.id, id)).get(), "CompletionRequest", id));
  }

  listByRun(runId: RunId): CompletionRequest[] {
    return this.ctx.db.select().from(completionRequests).where(eq(completionRequests.runId, runId)).orderBy(asc(completionRequests.createdAt), asc(completionRequests.id)).all().map(toDomain);
  }

  /** The Run's one non-terminal request (`requested` or `verifying`), or `null`; at most one exists (a database unique index). */
  activeOf(runId: RunId): CompletionRequest | null {
    const rows = this.ctx.db.select().from(completionRequests).where(and(eq(completionRequests.runId, runId), inArray(completionRequests.status, ["requested", "verifying"]))).all().map(toDomain);
    if (rows.length > 1) throw new InvariantViolationError(`Run ${runId} has ${rows.length} active Completion Requests`, { runId });
    return rows[0] ?? null;
  }

  /** The request an accepted `request_completion` call created, or `null`: what a replay of that call returns. */
  byRuntimeToolCall(runtimeToolCallId: RuntimeToolCallId): CompletionRequest | null {
    const row = this.ctx.db.select().from(completionRequests).where(eq(completionRequests.runtimeToolCallId, runtimeToolCallId)).get();
    return row ? toDomain(row) : null;
  }

  /** The request a root Orchestrator Invocation created, or `null`. */
  byInvocation(invocationId: InvocationId): CompletionRequest | null {
    const row = this.ctx.db.select().from(completionRequests).where(eq(completionRequests.invocationId, invocationId)).get();
    return row ? toDomain(row) : null;
  }

  /**
   * Applies one legal transition: `verifying` names the request's one open
   * `run_completion` Gate (of this Run, naming this request); `passed` names
   * the final-report Artifact of this Run; `failed` and `cancelled` carry
   * their closed outcome. Identity fields never change.
   */
  transition(id: CompletionRequestId, transition: CompletionRequestTransition, options?: WriteOptions): CompletionRequest {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      COMPLETION_REQUEST_MACHINE.assertTransition(current.status, transition.to, { completionRequestId: id });
      const run = loadRunRef(this.ctx, current.runId);
      const now = this.ctx.clock();
      const next: CompletionRequest = { ...current, status: transition.to };
      let type: "completion_request.verifying" | "completion_request.passed" | "completion_request.failed" | "completion_request.cancelled";
      switch (transition.to) {
        case "verifying": {
          const gate = requireRow(this.ctx.db.select({ runId: gates.runId, kind: gates.kind, status: gates.status, completionRequestId: gates.completionRequestId }).from(gates).where(eq(gates.id, transition.gateId)).get(), "Gate", transition.gateId);
          assertSameRun("Gate", transition.gateId, gate.runId, run.id);
          if (gate.kind !== "run_completion" || gate.status !== "open" || gate.completionRequestId !== id) {
            throw new InvariantViolationError(`Gate ${transition.gateId} is not the open run_completion Gate of Completion Request ${id}`, { gateId: transition.gateId, completionRequestId: id });
          }
          next.gateId = transition.gateId;
          next.startedAt = now;
          type = "completion_request.verifying";
          break;
        }
        case "passed": {
          const artifact = requireRow(this.ctx.db.select({ runId: artifacts.runId }).from(artifacts).where(eq(artifacts.id, transition.reportArtifactId)).get(), "Artifact", transition.reportArtifactId);
          assertSameRun("Artifact", transition.reportArtifactId, artifact.runId, run.id);
          const gate = requireRow(this.ctx.db.select({ status: gates.status, reportArtifactId: gates.reportArtifactId }).from(gates).where(eq(gates.id, current.gateId!)).get(), "Gate", current.gateId!);
          if (gate.status !== "passed" || gate.reportArtifactId !== transition.reportArtifactId) {
            throw new InvariantViolationError(`Gate ${current.gateId} has not passed with report Artifact ${transition.reportArtifactId}`, { gateId: current.gateId, reportArtifactId: transition.reportArtifactId });
          }
          next.reportArtifactId = transition.reportArtifactId;
          type = "completion_request.passed";
          break;
        }
        case "failed": {
          const gate = requireRow(this.ctx.db.select({ status: gates.status }).from(gates).where(eq(gates.id, current.gateId!)).get(), "Gate", current.gateId!);
          if (gate.status !== "failed") throw new InvariantViolationError(`Gate ${current.gateId} is ${gate.status}; a request fails once its Gate closed failed`, { gateId: current.gateId });
          next.outcome = parseOrThrow(completionRequestOutcomeSchema, transition.outcome, "CompletionRequest outcome");
          type = "completion_request.failed";
          break;
        }
        case "cancelled":
          next.outcome = parseOrThrow(completionRequestOutcomeSchema, transition.outcome, "CompletionRequest outcome");
          type = "completion_request.cancelled";
          break;
      }
      if (COMPLETION_REQUEST_MACHINE.isTerminal(next.status)) next.endedAt = now;
      parseOrThrow(completionRequestSchema, next, "CompletionRequest");
      this.ctx.journal.append({
        type,
        scope: runScope(run, { invocationId: current.invocationId }),
        subjectType: "completion_request",
        subjectId: id,
        payload: next,
        ...writeMeta(options),
      });
      this.ctx.db
        .update(completionRequests)
        .set({ status: next.status, gateId: next.gateId, reportArtifactId: next.reportArtifactId, outcome: next.outcome, startedAt: next.startedAt, endedAt: next.endedAt })
        .where(eq(completionRequests.id, id))
        .run();
      return next;
    });
  }
}
