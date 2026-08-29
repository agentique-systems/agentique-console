import { asc, eq } from "drizzle-orm";
import {
  ConflictError,
  parseOrThrow,
  RUN_MACHINE,
  runInputSchema,
  runSchema,
  runTransitionEventType,
  ValidationError,
  type ConversationId,
  type Run,
  type RunId,
  type RunInput,
  type RunTransition,
  type SnapshotId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { runs, snapshots } from "../schema.ts";
import type { ConversationStore } from "./conversations.ts";
import { assertSameRun, loadConversationRef, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

type Row = typeof runs.$inferSelect;

function toDomain(row: Row): Run {
  return parseOrThrow(
    runSchema,
    {
      id: row.id,
      conversationId: row.conversationId,
      workspaceId: row.workspaceId,
      kind: row.kind,
      status: row.status,
      waitReason: row.waitReason,
      target: row.target,
      budget: {
        maxCostUsd: row.maxCostUsd,
        maxTokens: row.maxTokens,
        maxAttempts: row.maxAttempts,
        maxWallClockMs: row.maxWallClockMs,
        maxConcurrency: row.maxConcurrency,
      },
      baseSnapshotId: row.baseSnapshotId,
      integrationSnapshotId: row.integrationSnapshotId,
      finalSnapshotId: row.finalSnapshotId,
      integrationWorkspacePath: row.integrationWorkspacePath,
      failure: row.failure,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      endedAt: row.endedAt,
    },
    "Run row",
  );
}

export class RunStore {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly conversations: ConversationStore,
  ) {}

  /** Creates a Run in `created` and makes it the Conversation's active Run. */
  create(input: RunInput, options?: WriteOptions): Run {
    const valid = parseOrThrow(runInputSchema, input, "Run input");
    return this.ctx.tx.write(() => {
      const conversation = loadConversationRef(this.ctx, valid.conversationId);
      const now = this.ctx.clock();
      const run: Run = {
        id: this.ctx.ids("run"),
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        kind: valid.kind,
        status: "created",
        waitReason: null,
        target: valid.target,
        budget: valid.budget,
        baseSnapshotId: null,
        integrationSnapshotId: null,
        finalSnapshotId: null,
        integrationWorkspacePath: null,
        failure: null,
        createdAt: now,
        updatedAt: now,
        endedAt: null,
      };
      parseOrThrow(runSchema, run, "Run");
      this.ctx.journal.append({
        type: "run.created",
        scope: runScope({ id: run.id, conversationId: run.conversationId, workspaceId: run.workspaceId, status: "created" }),
        subjectType: "run",
        subjectId: run.id,
        payload: { runId: run.id, kind: run.kind },
        ...writeMeta(options),
      });
      this.ctx.db.insert(runs).values(this.toRow(run)).run();
      // Claims the Conversation's single active-Run slot in the same transaction;
      // a second active Run rolls the whole creation back.
      this.conversations.setActiveRun(conversation.id, run.id, options);
      return run;
    });
  }

  get(id: RunId): Run {
    return toDomain(requireRow(this.ctx.db.select().from(runs).where(eq(runs.id, id)).get(), "Run", id));
  }

  listByConversation(conversationId: ConversationId): Run[] {
    return this.ctx.db.select().from(runs).where(eq(runs.conversationId, conversationId)).orderBy(asc(runs.createdAt)).all().map(toDomain);
  }

  /**
   * Applies one legal transition. Terminal states are final; `waiting` needs
   * a reason; leaving `waiting` for `running` states which reason cleared.
   */
  transition(id: RunId, transition: RunTransition, options?: WriteOptions): Run {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      RUN_MACHINE.assertTransition(current.status, transition.to, { runId: id });
      const now = this.ctx.clock();
      const next: Run = { ...current, status: transition.to, waitReason: null, updatedAt: now };
      let payload: unknown;
      switch (transition.to) {
        case "running":
          if (current.status === "waiting") {
            if (transition.clearedWaitReason !== current.waitReason) {
              throw new ValidationError(
                `Run ${id} is waiting on ${current.waitReason}; clearing ${String(transition.clearedWaitReason)} does not resume it`,
                { waitReason: current.waitReason, clearedWaitReason: transition.clearedWaitReason ?? null },
              );
            }
            payload = { from: current.status, to: "running", clearedWaitReason: transition.clearedWaitReason };
          } else {
            payload = { from: current.status, to: "running", reason: null };
          }
          break;
        case "waiting":
          next.waitReason = transition.waitReason;
          payload = { from: current.status, to: "waiting", waitReason: transition.waitReason };
          break;
        case "verifying":
        case "awaiting_signoff":
        case "cancelled":
          payload = { from: current.status, to: transition.to, reason: null };
          break;
        case "completed": {
          const snapshot = requireRow(
            this.ctx.db.select({ runId: snapshots.runId }).from(snapshots).where(eq(snapshots.id, transition.finalSnapshotId)).get(),
            "Snapshot",
            transition.finalSnapshotId,
          );
          assertSameRun("Snapshot", transition.finalSnapshotId, snapshot.runId ?? "", id);
          next.finalSnapshotId = transition.finalSnapshotId;
          payload = { from: current.status, to: "completed", finalSnapshotId: transition.finalSnapshotId };
          break;
        }
        case "failed":
          next.failure = transition.failure;
          payload = { from: current.status, to: "failed", failure: transition.failure };
          break;
      }
      if (RUN_MACHINE.isTerminal(next.status)) next.endedAt = now;
      parseOrThrow(runSchema, next, "Run");
      this.ctx.journal.append({
        type: runTransitionEventType(current.status, transition.to),
        scope: runScope(current),
        subjectType: "run",
        subjectId: id,
        payload: payload as never,
        ...writeMeta(options),
      });
      this.ctx.db.update(runs).set(this.toRow(next)).where(eq(runs.id, id)).run();
      if (RUN_MACHINE.isTerminal(next.status)) {
        this.conversations.setActiveRun(current.conversationId, null, options);
      }
      return next;
    });
  }

  /** Records the base or integration Snapshot; both are lifecycle fields, not transitions. */
  recordSnapshot(id: RunId, which: "base" | "integration", snapshotId: SnapshotId): Run {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (RUN_MACHINE.isTerminal(current.status)) throw new ConflictError(`Run ${id} has ended`);
      const snapshot = requireRow(
        this.ctx.db.select({ runId: snapshots.runId, workspaceId: snapshots.workspaceId }).from(snapshots).where(eq(snapshots.id, snapshotId)).get(),
        "Snapshot",
        snapshotId,
      );
      if (snapshot.workspaceId !== current.workspaceId) {
        throw new ConflictError(`Snapshot ${snapshotId} belongs to another Workspace`);
      }
      const next: Run = {
        ...current,
        baseSnapshotId: which === "base" ? snapshotId : current.baseSnapshotId,
        integrationSnapshotId: which === "integration" ? snapshotId : current.integrationSnapshotId,
        updatedAt: this.ctx.clock(),
      };
      this.ctx.db.update(runs).set(this.toRow(next)).where(eq(runs.id, id)).run();
      return next;
    });
  }

  private toRow(run: Run): Row {
    return {
      id: run.id,
      conversationId: run.conversationId,
      workspaceId: run.workspaceId,
      kind: run.kind,
      status: run.status,
      waitReason: run.waitReason,
      target: run.target,
      maxCostUsd: run.budget.maxCostUsd,
      maxTokens: run.budget.maxTokens,
      maxAttempts: run.budget.maxAttempts,
      maxWallClockMs: run.budget.maxWallClockMs,
      maxConcurrency: run.budget.maxConcurrency,
      baseSnapshotId: run.baseSnapshotId,
      integrationSnapshotId: run.integrationSnapshotId,
      finalSnapshotId: run.finalSnapshotId,
      integrationWorkspacePath: run.integrationWorkspacePath,
      failure: run.failure,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      endedAt: run.endedAt,
    };
  }
}
