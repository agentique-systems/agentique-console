import { asc, eq, notInArray } from "drizzle-orm";
import {
  ConflictError,
  InvariantViolationError,
  ORCHESTRATOR_DEFINITION_NAME,
  parseOrThrow,
  RUN_MACHINE,
  RunControlRefusedError,
  runInputSchema,
  runSchema,
  runTransitionEventType,
  ValidationError,
  type ConversationId,
  type OperatorPauseMode,
  type Run,
  type RunId,
  type RunInput,
  type RunTransition,
  type ChangesetId,
  type SnapshotId,
  type WorkspaceId,
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
      operatorPause: row.operatorPause,
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
      finalChangesetId: row.finalChangesetId,
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
        operatorPause: null,
        target: valid.target,
        budget: valid.budget,
        finalReserve: valid.finalReserve,
        verificationPolicy: valid.verificationPolicy,
        baseSnapshotId: null,
        integrationSnapshotId: null,
        finalSnapshotId: null,
        finalChangesetId: null,
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

  listByWorkspace(workspaceId: WorkspaceId): Run[] {
    return this.ctx.db.select().from(runs).where(eq(runs.workspaceId, workspaceId)).orderBy(asc(runs.createdAt)).all().map(toDomain);
  }

  /** Every Run that has not ended: what a restarted host reconstructs its work from. */
  listNonterminal(): Run[] {
    return this.ctx.db.select().from(runs).where(notInArray(runs.status, ["completed", "failed", "cancelled"])).orderBy(asc(runs.createdAt)).all().map(toDomain);
  }

  /**
   * Applies one legal transition. Terminal states are final; `waiting` needs
   * a reason; leaving `waiting` for `running` states which reason cleared;
   * `completed` records the final Snapshot and the Run's one `final`
   * Changeset, which must agree (the Changeset ends at that Snapshot and
   * starts at the Run's base Snapshot; execution-model §9.3), and clears the
   * Conversation's active-Run reference when it still names this Run. An
   * operator pause has precedence over every automatic transition: a paused
   * Run moves only to `cancelled` (which clears the pause) until the
   * operator resumes it, and the `operator` wait reason is never cleared
   * by a `running` transition — only by `resume`.
   */
  transition(id: RunId, transition: RunTransition, options?: WriteOptions): Run {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      RUN_MACHINE.assertTransition(current.status, transition.to, { runId: id });
      if (current.operatorPause !== null && transition.to !== "cancelled") {
        throw new ConflictError(`Run ${id} is paused by the operator (${current.operatorPause}); it moves to ${transition.to} only once resumed`, { runId: id, operatorPause: current.operatorPause, to: transition.to });
      }
      if (transition.to === "running" && transition.clearedWaitReason === "operator") {
        throw new ValidationError(`Run ${id}: the operator wait reason is cleared by resume, never by a running transition`, { runId: id, clearedWaitReason: "operator" });
      }
      const now = this.ctx.clock();
      const next: Run = { ...current, status: transition.to, waitReason: null, operatorPause: null, updatedAt: now };
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
          const changeset = requireRow(
            this.ctx.db.select({ runId: changesets.runId, kind: changesets.kind, beforeSnapshotId: changesets.beforeSnapshotId, afterSnapshotId: changesets.afterSnapshotId }).from(changesets).where(eq(changesets.id, transition.finalChangesetId)).get(),
            "Changeset",
            transition.finalChangesetId,
          );
          assertSameRun("Changeset", transition.finalChangesetId, changeset.runId, id);
          if (changeset.kind !== "final") throw new InvariantViolationError(`Changeset ${transition.finalChangesetId} is an ${changeset.kind} Changeset, not the Run's final Changeset`, { changesetId: transition.finalChangesetId });
          if (changeset.afterSnapshotId !== transition.finalSnapshotId) throw new InvariantViolationError(`final Changeset ${transition.finalChangesetId} ends at Snapshot ${changeset.afterSnapshotId}, not the final Snapshot ${transition.finalSnapshotId}`, { changesetId: transition.finalChangesetId });
          if (changeset.beforeSnapshotId !== current.baseSnapshotId) throw new InvariantViolationError(`final Changeset ${transition.finalChangesetId} starts at Snapshot ${changeset.beforeSnapshotId}, not the Run's base Snapshot ${String(current.baseSnapshotId)}`, { changesetId: transition.finalChangesetId });
          next.finalSnapshotId = transition.finalSnapshotId;
          next.finalChangesetId = transition.finalChangesetId;
          payload = { from: current.status, to: "completed", finalSnapshotId: transition.finalSnapshotId, finalChangesetId: transition.finalChangesetId };
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
          operatorPause: next.operatorPause,
          finalSnapshotId: next.finalSnapshotId,
          finalChangesetId: next.finalChangesetId,
          failure: next.failure,
          updatedAt: next.updatedAt,
          endedAt: next.endedAt,
        })
        .where(eq(runs.id, id))
        .run();
      // A terminal Run releases the Conversation's active-Run slot, but only when the slot still names this Run.
      if (RUN_MACHINE.isTerminal(next.status) && this.conversations.get(current.conversationId).activeRunId === id) {
        this.conversations.setActiveRun(current.conversationId, null, options);
      }
      return next;
    });
  }

  /**
   * Records the operator's pause (execution-model §14) in one write: a
   * `running` Run becomes `waiting` with reason `operator`; a `waiting` Run
   * keeps its status and its wait reason becomes `operator` (the superseded
   * reason is journaled, never restored); a `verifying` or
   * `awaiting_signoff` Run keeps its status and holds the pause beside it.
   * A repeated pause of the same or a weaker mode changes nothing; a `hard`
   * pause of a soft-paused Run escalates it. A `created` Run has nothing to
   * withhold (`not_started`); an ended Run is never paused (`run_terminal`).
   */
  pause(id: RunId, mode: OperatorPauseMode, options?: WriteOptions): { run: Run; change: "paused" | "escalated" | "unchanged" } {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (RUN_MACHINE.isTerminal(current.status)) throw new RunControlRefusedError("run_terminal", `Run ${id} is ${current.status}; an ended Run is never paused`, { runId: id, status: current.status });
      if (current.status === "created") throw new RunControlRefusedError("not_started", `Run ${id} has not started; there is no admitted work to withhold`, { runId: id, status: current.status });
      const now = this.ctx.clock();
      if (current.operatorPause !== null) {
        if (current.operatorPause === "hard" || mode === "soft") return { run: current, change: "unchanged" };
        const escalated: Run = { ...current, operatorPause: "hard", updatedAt: now };
        parseOrThrow(runSchema, escalated, "Run");
        this.ctx.journal.append({
          type: "run.paused",
          scope: runScope(current),
          subjectType: "run",
          subjectId: id,
          payload: { runId: id, mode: "hard", status: escalated.status, previousWaitReason: null, escalated: true },
          ...writeMeta(options),
        });
        this.ctx.db.update(runs).set({ operatorPause: escalated.operatorPause, updatedAt: escalated.updatedAt }).where(eq(runs.id, id)).run();
        return { run: escalated, change: "escalated" };
      }
      const next: Run = { ...current, operatorPause: mode, updatedAt: now };
      if (current.status === "running" || current.status === "waiting") {
        next.status = "waiting";
        next.waitReason = "operator";
      }
      parseOrThrow(runSchema, next, "Run");
      this.ctx.journal.append({
        type: "run.paused",
        scope: runScope(current),
        subjectType: "run",
        subjectId: id,
        payload: { runId: id, mode, status: next.status, previousWaitReason: current.waitReason, escalated: false },
        ...writeMeta(options),
      });
      if (current.status === "running") {
        this.ctx.journal.append({
          type: "run.waiting",
          scope: runScope(current),
          subjectType: "run",
          subjectId: id,
          payload: { from: "running", to: "waiting", waitReason: "operator" },
          ...writeMeta(options),
        });
      }
      this.ctx.db.update(runs).set({ status: next.status, waitReason: next.waitReason, operatorPause: next.operatorPause, updatedAt: next.updatedAt }).where(eq(runs.id, id)).run();
      return { run: next, change: "paused" };
    });
  }

  /**
   * Clears the operator's pause and nothing else (execution-model §14): a
   * `waiting` Run returns to `running` (the pre-pause wait reason is not
   * restored; the next pass recomputes readiness from rows); a `verifying`
   * or `awaiting_signoff` Run keeps its status. A Run that is not paused is
   * left as it is (`not_paused`); an ended Run is never resumed.
   */
  resume(id: RunId, options?: WriteOptions): { run: Run; change: "resumed" | "not_paused"; cleared: OperatorPauseMode | null } {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (RUN_MACHINE.isTerminal(current.status)) throw new RunControlRefusedError("run_terminal", `Run ${id} is ${current.status}; an ended Run is never resumed`, { runId: id, status: current.status });
      if (current.operatorPause === null) return { run: current, change: "not_paused", cleared: null };
      const now = this.ctx.clock();
      const next: Run = { ...current, operatorPause: null, updatedAt: now };
      if (current.status === "waiting") {
        next.status = "running";
        next.waitReason = null;
      }
      parseOrThrow(runSchema, next, "Run");
      this.ctx.journal.append({
        type: "run.resumed",
        scope: runScope(current),
        subjectType: "run",
        subjectId: id,
        payload: { runId: id, mode: current.operatorPause, status: next.status },
        ...writeMeta(options),
      });
      if (current.status === "waiting") {
        this.ctx.journal.append({
          type: "run.wait_cleared",
          scope: runScope(current),
          subjectType: "run",
          subjectId: id,
          payload: { from: "waiting", to: "running", clearedWaitReason: "operator" },
          ...writeMeta(options),
        });
      }
      this.ctx.db.update(runs).set({ status: next.status, waitReason: next.waitReason, operatorPause: next.operatorPause, updatedAt: next.updatedAt }).where(eq(runs.id, id)).run();
      return { run: next, change: "resumed", cleared: current.operatorPause };
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
      operatorPause: run.operatorPause,
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
      finalChangesetId: run.finalChangesetId,
      integrationWorkspacePath: run.integrationWorkspacePath,
      failure: run.failure,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      endedAt: run.endedAt,
    };
  }
}
