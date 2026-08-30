import { asc, eq } from "drizzle-orm";
import {
  ConflictError,
  ORCHESTRATOR_DEFINITION_NAME,
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
  type ChangesetId,
  type SnapshotId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { agentDefinitionRevisions, agentDefinitions, changesets, runs, snapshots } from "../schema.ts";
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
      finalReserve: { costUsd: row.finalReserveCostUsd, tokens: row.finalReserveTokens, attempts: row.finalReserveAttempts },
      verificationPolicy: row.verificationPolicy,
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

/** The Workspace-state fields a Run acquires during its life; each is recorded once it exists. */
export interface RunWorkspaceState {
  baseSnapshotId?: SnapshotId;
  integrationSnapshotId?: SnapshotId;
  integrationWorkspacePath?: string;
}

/**
 * Run rows. The Run's kind, Target, Budget, final reserve, and verification
 * policy are chosen at creation and never updated (the schema's
 * `runs_definition_immutable` trigger enforces it); every later write names
 * only lifecycle columns.
 */
export class RunStore {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly conversations: ConversationStore,
  ) {}

  /**
   * Creates a Run in `created` with its Budget and persisted final reserve
   * and makes it the Conversation's active Run. The complete initial state
   * of a Run (base Snapshot, Integration Workspace, revision 1, root node) is
   * established by the Run creation service in the same root transaction.
   */
  create(input: RunInput, options?: WriteOptions): Run {
    const valid = parseOrThrow(runInputSchema, input, "Run input");
    return this.ctx.tx.write(() => {
      const conversation = loadConversationRef(this.ctx, valid.conversationId);
      // The Gate Evaluator revision exists and is not the Orchestrator definition; provenance is the Run creation service's check.
      const evaluatorId = valid.verificationPolicy.evaluatorAgentDefinitionRevisionId;
      if (evaluatorId !== null) {
        const revision = requireRow(
          this.ctx.db.select({ name: agentDefinitions.name }).from(agentDefinitionRevisions).innerJoin(agentDefinitions, eq(agentDefinitions.id, agentDefinitionRevisions.definitionId)).where(eq(agentDefinitionRevisions.id, evaluatorId)).get(),
          "AgentDefinitionRevision",
          evaluatorId,
        );
        if (revision.name === ORCHESTRATOR_DEFINITION_NAME) throw new ValidationError(`the ${ORCHESTRATOR_DEFINITION_NAME} definition cannot be the Run's Gate Evaluator`, { evaluatorAgentDefinitionRevisionId: evaluatorId });
      }
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
        finalReserve: valid.finalReserve,
        verificationPolicy: valid.verificationPolicy,
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
        payload: run,
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
      this.ctx.db
        .update(runs)
        .set({
          status: next.status,
          waitReason: next.waitReason,
          finalSnapshotId: next.finalSnapshotId,
          failure: next.failure,
          updatedAt: next.updatedAt,
          endedAt: next.endedAt,
        })
        .where(eq(runs.id, id))
        .run();
      if (RUN_MACHINE.isTerminal(next.status)) {
        this.conversations.setActiveRun(current.conversationId, null, options);
      }
      return next;
    });
  }

  /**
   * Records the base or integration Snapshot and the Integration Workspace
   * path; these are lifecycle fields, not transitions. A Snapshot must belong
   * to the Run's Workspace; the base Snapshot and the path are recorded once.
   */
  recordWorkspaceState(id: RunId, state: RunWorkspaceState): Run {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (RUN_MACHINE.isTerminal(current.status)) throw new ConflictError(`Run ${id} has ended`);
      for (const snapshotId of [state.baseSnapshotId, state.integrationSnapshotId]) {
        if (snapshotId === undefined) continue;
        const snapshot = requireRow(
          this.ctx.db.select({ runId: snapshots.runId, workspaceId: snapshots.workspaceId }).from(snapshots).where(eq(snapshots.id, snapshotId)).get(),
          "Snapshot",
          snapshotId,
        );
        if (snapshot.workspaceId !== current.workspaceId) {
          throw new ConflictError(`Snapshot ${snapshotId} belongs to another Workspace`);
        }
      }
      if (state.baseSnapshotId !== undefined && current.baseSnapshotId !== null) {
        throw new ConflictError(`Run ${id} already has base Snapshot ${current.baseSnapshotId}`);
      }
      if (state.integrationWorkspacePath !== undefined && current.integrationWorkspacePath !== null) {
        throw new ConflictError(`Run ${id} already has an Integration Workspace at ${current.integrationWorkspacePath}`);
      }
      const next: Run = {
        ...current,
        baseSnapshotId: state.baseSnapshotId ?? current.baseSnapshotId,
        integrationSnapshotId: state.integrationSnapshotId ?? current.integrationSnapshotId,
        integrationWorkspacePath: state.integrationWorkspacePath ?? current.integrationWorkspacePath,
        updatedAt: this.ctx.clock(),
      };
      parseOrThrow(runSchema, next, "Run");
      this.ctx.db
        .update(runs)
        .set({
          baseSnapshotId: next.baseSnapshotId,
          integrationSnapshotId: next.integrationSnapshotId,
          integrationWorkspacePath: next.integrationWorkspacePath,
          updatedAt: next.updatedAt,
        })
        .where(eq(runs.id, id))
        .run();
      return next;
    });
  }

  /**
   * Advances the Run's integration Snapshot after one Changeset was
   * integrated, journaling `run.integrated`. The Snapshot belongs to the
   * Run's Workspace and the Changeset to the Run; the Changeset's own
   * transition is recorded by its store in the same transaction.
   */
  recordIntegration(id: RunId, state: { changesetId: ChangesetId; integrationSnapshotId: SnapshotId }, options?: WriteOptions): Run {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (RUN_MACHINE.isTerminal(current.status)) throw new ConflictError(`Run ${id} has ended`);
      const snapshot = requireRow(this.ctx.db.select({ workspaceId: snapshots.workspaceId }).from(snapshots).where(eq(snapshots.id, state.integrationSnapshotId)).get(), "Snapshot", state.integrationSnapshotId);
      if (snapshot.workspaceId !== current.workspaceId) throw new ConflictError(`Snapshot ${state.integrationSnapshotId} belongs to another Workspace`);
      const changeset = requireRow(this.ctx.db.select({ runId: changesets.runId }).from(changesets).where(eq(changesets.id, state.changesetId)).get(), "Changeset", state.changesetId);
      assertSameRun("Changeset", state.changesetId, changeset.runId, id);
      const next: Run = { ...current, integrationSnapshotId: state.integrationSnapshotId, updatedAt: this.ctx.clock() };
      parseOrThrow(runSchema, next, "Run");
      this.ctx.journal.append({
        type: "run.integrated",
        scope: runScope(current),
        subjectType: "run",
        subjectId: id,
        payload: { runId: id, changesetId: state.changesetId, integrationSnapshotId: state.integrationSnapshotId },
        ...writeMeta(options),
      });
      this.ctx.db.update(runs).set({ integrationSnapshotId: next.integrationSnapshotId, updatedAt: next.updatedAt }).where(eq(runs.id, id)).run();
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
      finalReserveCostUsd: run.finalReserve.costUsd,
      finalReserveTokens: run.finalReserve.tokens,
      finalReserveAttempts: run.finalReserve.attempts,
      verificationPolicy: run.verificationPolicy,
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
