import { and, asc, eq } from "drizzle-orm";
import {
  CHANGESET_DIFF_MEDIA_TYPE,
  CHANGESET_MACHINE,
  changesetInputSchema,
  changesetSchema,
  ConflictError,
  finalChangesetInputSchema,
  InvariantViolationError,
  parseOrThrow,
  snapshotInputSchema,
  snapshotSchema,
  type Changeset,
  type ChangesetId,
  type ChangesetInput,
  type ChangesetTransition,
  type FinalChangesetInput,
  type RunId,
  type Snapshot,
  type SnapshotId,
  type SnapshotInput,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { artifacts, changesets, gates, invocations, runs, snapshots, tasks, workspaces } from "../schema.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, workspaceScope, writeMeta, type WriteOptions } from "./support.ts";
import { keysetOrder, keysetWhere, type KeysetQuery } from "./paging.ts";

function snapshotToDomain(row: typeof snapshots.$inferSelect): Snapshot {
  const identity =
    row.kind === "git" ? { kind: "git", commitId: row.commitId, treeId: row.treeId } : { kind: "directory", contentDigest: row.contentDigest };
  return parseOrThrow(
    snapshotSchema,
    { id: row.id, workspaceId: row.workspaceId, runId: row.runId, identity, reason: row.reason, takenAt: row.takenAt },
    "Snapshot row",
  );
}

function changesetToDomain(row: typeof changesets.$inferSelect): Changeset {
  return parseOrThrow(changesetSchema, row, "Changeset row");
}

export class SnapshotStore {
  constructor(private readonly ctx: PersistenceContext) {}

  record(input: SnapshotInput, options?: WriteOptions): Snapshot {
    const valid = parseOrThrow(snapshotInputSchema, input, "Snapshot input");
    return this.ctx.tx.write(() => {
      const workspace = requireRow(this.ctx.db.select({ id: workspaces.id, kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, valid.workspaceId)).get(), "Workspace", valid.workspaceId);
      if (workspace.kind !== valid.identity.kind) {
        throw new InvariantViolationError(`a ${workspace.kind} Workspace takes ${workspace.kind} Snapshots, not ${valid.identity.kind}`);
      }
      const run = valid.runId !== null ? loadRunRef(this.ctx, valid.runId) : null;
      if (run && run.workspaceId !== valid.workspaceId) throw new InvariantViolationError(`Run ${run.id} belongs to another Workspace`);
      const snapshot: Snapshot = { id: this.ctx.ids("snapshot"), ...valid, takenAt: this.ctx.clock() };
      parseOrThrow(snapshotSchema, snapshot, "Snapshot");
      this.ctx.journal.append({
        type: "snapshot.taken",
        scope: run ? runScope(run) : workspaceScope(valid.workspaceId),
        subjectType: "snapshot",
        subjectId: snapshot.id,
        payload: snapshot,
        ...writeMeta(options),
      });
      this.ctx.db
        .insert(snapshots)
        .values({
          id: snapshot.id,
          workspaceId: snapshot.workspaceId,
          runId: snapshot.runId,
          kind: snapshot.identity.kind,
          commitId: snapshot.identity.kind === "git" ? snapshot.identity.commitId : null,
          treeId: snapshot.identity.kind === "git" ? snapshot.identity.treeId : null,
          contentDigest: snapshot.identity.kind === "directory" ? snapshot.identity.contentDigest : null,
          reason: snapshot.reason,
          takenAt: snapshot.takenAt,
        })
        .run();
      return snapshot;
    });
  }

  get(id: SnapshotId): Snapshot {
    return snapshotToDomain(requireRow(this.ctx.db.select().from(snapshots).where(eq(snapshots.id, id)).get(), "Snapshot", id));
  }

  listByRun(runId: RunId): Snapshot[] {
    return this.ctx.db.select().from(snapshots).where(eq(snapshots.runId, runId)).orderBy(asc(snapshots.takenAt), asc(snapshots.id)).all().map(snapshotToDomain);
  }

  /** One keyset page of a Run's Snapshots by `(takenAt, id)`. */
  pageByRun(runId: RunId, query: KeysetQuery): Snapshot[] {
    const key = [snapshots.takenAt, snapshots.id];
    return this.ctx.db.select().from(snapshots).where(and(eq(snapshots.runId, runId), keysetWhere(key, query))).orderBy(...keysetOrder(key, query)).limit(query.limit).all().map(snapshotToDomain);
  }
}

/**
 * Changesets (execution-model §9.2, §9.3). `record` appends a writing
 * Invocation's `invocation` Changeset in `pending`, for the integration
 * lifecycle; `recordFinal` appends the Run's one `final` Changeset in
 * `recorded` — only while the Run is `awaiting_signoff`, from exactly the
 * Run's base Snapshot to exactly the open `operator_signoff` Gate's
 * verified Snapshot, with a `text/x-diff` Artifact of the Run — and the
 * database (unique index and trigger) holds the same rules. A final
 * Changeset never transitions; no Changeset is ever deleted.
 */
export class ChangesetStore {
  constructor(private readonly ctx: PersistenceContext) {}

  record(input: ChangesetInput, options?: WriteOptions): Changeset {
    const valid = parseOrThrow(changesetInputSchema, input, "Changeset input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      this.assertSnapshots(run, valid.beforeSnapshotId, valid.afterSnapshotId);
      const diff = requireRow(this.ctx.db.select({ runId: artifacts.runId }).from(artifacts).where(eq(artifacts.id, valid.diffArtifactId)).get(), "Artifact", valid.diffArtifactId);
      assertSameRun("Artifact", valid.diffArtifactId, diff.runId, run.id);
      const invocation = requireRow(this.ctx.db.select({ runId: invocations.runId }).from(invocations).where(eq(invocations.id, valid.invocationId)).get(), "Invocation", valid.invocationId);
      assertSameRun("Invocation", valid.invocationId, invocation.runId, run.id);
      const changeset: Changeset = {
        id: this.ctx.ids("changeset"),
        kind: "invocation",
        ...valid,
        integrationStatus: "pending",
        integratedSnapshotId: null,
        conflictTaskId: null,
        createdAt: this.ctx.clock(),
        integratedAt: null,
      };
      return this.insert(run, changeset, options);
    });
  }

  /**
   * The Run's one `final` Changeset, recorded at signoff acceptance: the Run
   * is `awaiting_signoff`, `beforeSnapshotId` is its base Snapshot,
   * `afterSnapshotId` is the open `operator_signoff` Gate's verified
   * Snapshot, and the diff Artifact is a `text/x-diff` of the Run. A second
   * final Changeset is a conflict here and a unique-index violation at the
   * database.
   */
  recordFinal(input: FinalChangesetInput, options?: WriteOptions): Changeset {
    const valid = parseOrThrow(finalChangesetInputSchema, input, "final Changeset input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      if (run.status !== "awaiting_signoff") throw new ConflictError(`Run ${run.id} is ${run.status}; the final Changeset is recorded at signoff acceptance of a Run awaiting signoff`, { runId: run.id, status: run.status });
      this.assertSnapshots(run, valid.beforeSnapshotId, valid.afterSnapshotId);
      const base = requireRow(this.ctx.db.select({ baseSnapshotId: runs.baseSnapshotId }).from(runs).where(eq(runs.id, run.id)).get(), "Run", run.id).baseSnapshotId;
      if (base !== valid.beforeSnapshotId) throw new InvariantViolationError(`the final Changeset starts at the Run's base Snapshot ${String(base)}, not ${valid.beforeSnapshotId}`, { runId: run.id, beforeSnapshotId: valid.beforeSnapshotId });
      const signoff = this.ctx.db.select({ id: gates.id, snapshotId: gates.snapshotId }).from(gates).where(and(eq(gates.runId, run.id), eq(gates.kind, "operator_signoff"), eq(gates.status, "open"))).get();
      if (signoff === undefined) throw new ConflictError(`Run ${run.id} has no open operator_signoff Gate; the final Changeset is recorded at its acceptance`, { runId: run.id });
      if (signoff.snapshotId !== valid.afterSnapshotId) throw new InvariantViolationError(`the final Changeset ends at the verified Snapshot ${signoff.snapshotId} of Gate ${signoff.id}, not ${valid.afterSnapshotId}`, { gateId: signoff.id, afterSnapshotId: valid.afterSnapshotId });
      const diff = requireRow(this.ctx.db.select({ runId: artifacts.runId, mediaType: artifacts.mediaType }).from(artifacts).where(eq(artifacts.id, valid.diffArtifactId)).get(), "Artifact", valid.diffArtifactId);
      assertSameRun("Artifact", valid.diffArtifactId, diff.runId, run.id);
      if (diff.mediaType !== CHANGESET_DIFF_MEDIA_TYPE) throw new InvariantViolationError(`Artifact ${valid.diffArtifactId} is ${diff.mediaType}, not a ${CHANGESET_DIFF_MEDIA_TYPE} Changeset diff`, { artifactId: valid.diffArtifactId });
      const existing = this.finalOf(run.id);
      if (existing !== null) throw new ConflictError(`Run ${run.id} already has final Changeset ${existing.id}`, { runId: run.id, changesetId: existing.id });
      const changeset: Changeset = {
        id: this.ctx.ids("changeset"),
        runId: run.id,
        kind: "final",
        invocationId: null,
        beforeSnapshotId: valid.beforeSnapshotId,
        afterSnapshotId: valid.afterSnapshotId,
        diffArtifactId: valid.diffArtifactId,
        integrationStatus: "recorded",
        integratedSnapshotId: null,
        conflictTaskId: null,
        createdAt: this.ctx.clock(),
        integratedAt: null,
      };
      return this.insert(run, changeset, options);
    });
  }

  private assertSnapshots(run: { workspaceId: string }, ...snapshotIds: string[]): void {
    for (const snapshotId of snapshotIds) {
      const snapshot = requireRow(this.ctx.db.select({ workspaceId: snapshots.workspaceId }).from(snapshots).where(eq(snapshots.id, snapshotId)).get(), "Snapshot", snapshotId);
      if (snapshot.workspaceId !== run.workspaceId) throw new InvariantViolationError(`Snapshot ${snapshotId} belongs to another Workspace`);
    }
  }

  private insert(run: { id: RunId; conversationId: string; workspaceId: string; status: string }, changeset: Changeset, options?: WriteOptions): Changeset {
    parseOrThrow(changesetSchema, changeset, "Changeset");
    this.ctx.journal.append({
      type: "changeset.recorded",
      scope: runScope(run as never, { invocationId: changeset.invocationId }),
      subjectType: "changeset",
      subjectId: changeset.id,
      payload: changeset,
      ...writeMeta(options),
    });
    this.ctx.db.insert(changesets).values(changeset).run();
    return changeset;
  }

  /** The Run's one `final` Changeset, or `null` before signoff acceptance; at most one exists (a database unique index). */
  finalOf(runId: RunId): Changeset | null {
    const rows = this.ctx.db.select().from(changesets).where(and(eq(changesets.runId, runId), eq(changesets.kind, "final"))).all().map(changesetToDomain);
    if (rows.length > 1) throw new InvariantViolationError(`Run ${runId} has ${rows.length} final Changesets`, { runId });
    return rows[0] ?? null;
  }

  get(id: ChangesetId): Changeset {
    return changesetToDomain(requireRow(this.ctx.db.select().from(changesets).where(eq(changesets.id, id)).get(), "Changeset", id));
  }

  listByRun(runId: RunId): Changeset[] {
    return this.ctx.db.select().from(changesets).where(eq(changesets.runId, runId)).orderBy(asc(changesets.createdAt)).all().map(changesetToDomain);
  }

  /** One keyset page of a Run's Changesets by `(createdAt, id)`. */
  pageByRun(runId: RunId, query: KeysetQuery): Changeset[] {
    const key = [changesets.createdAt, changesets.id];
    return this.ctx.db.select().from(changesets).where(and(eq(changesets.runId, runId), keysetWhere(key, query))).orderBy(...keysetOrder(key, query)).limit(query.limit).all().map(changesetToDomain);
  }

  transition(id: ChangesetId, transition: ChangesetTransition, options?: WriteOptions): Changeset {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (current.kind === "final") throw new ConflictError(`Changeset ${id} is the Run's final Changeset; it is recorded once and never integrated, retried, or resolved`, { changesetId: id });
      CHANGESET_MACHINE.assertTransition(current.integrationStatus, transition.to, { changesetId: id });
      const run = loadRunRef(this.ctx, current.runId);
      const next: Changeset = { ...current, integrationStatus: transition.to, conflictTaskId: null };
      if (transition.to === "integrated") {
        const snapshot = requireRow(this.ctx.db.select({ workspaceId: snapshots.workspaceId }).from(snapshots).where(eq(snapshots.id, transition.integratedSnapshotId)).get(), "Snapshot", transition.integratedSnapshotId);
        if (snapshot.workspaceId !== run.workspaceId) throw new InvariantViolationError(`Snapshot ${transition.integratedSnapshotId} belongs to another Workspace`);
        next.integratedSnapshotId = transition.integratedSnapshotId;
        next.integratedAt = this.ctx.clock();
      } else {
        const task = requireRow(this.ctx.db.select({ runId: tasks.runId }).from(tasks).where(eq(tasks.id, transition.conflictTaskId)).get(), "Task", transition.conflictTaskId);
        assertSameRun("Task", transition.conflictTaskId, task.runId, run.id);
        next.conflictTaskId = transition.conflictTaskId;
      }
      parseOrThrow(changesetSchema, next, "Changeset");
      this.ctx.journal.append({
        type: transition.to === "integrated" ? "changeset.integrated" : "changeset.conflicted",
        scope: runScope(run, { invocationId: current.invocationId }),
        subjectType: "changeset",
        subjectId: id,
        payload: (transition.to === "integrated"
          ? { changesetId: id, integratedSnapshotId: transition.integratedSnapshotId }
          : { changesetId: id, conflictTaskId: transition.conflictTaskId }) as never,
        ...writeMeta(options),
      });
      this.ctx.db
        .update(changesets)
        .set({ integrationStatus: next.integrationStatus, integratedSnapshotId: next.integratedSnapshotId, conflictTaskId: next.conflictTaskId, integratedAt: next.integratedAt })
        .where(eq(changesets.id, id))
        .run();
      return next;
    });
  }
}
