import { asc, eq } from "drizzle-orm";
import {
  CHANGESET_MACHINE,
  changesetInputSchema,
  changesetSchema,
  ConflictError,
  InvariantViolationError,
  parseOrThrow,
  publicationInputSchema,
  publicationSchema,
  snapshotInputSchema,
  snapshotSchema,
  type Changeset,
  type ChangesetId,
  type ChangesetInput,
  type ChangesetTransition,
  type Publication,
  type PublicationId,
  type PublicationInput,
  type RunId,
  type Snapshot,
  type SnapshotId,
  type SnapshotInput,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { artifacts, changesets, decisions, invocations, publications, snapshots, tasks, workspaces } from "../schema.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, workspaceScope, writeMeta, type WriteOptions } from "./support.ts";

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

function publicationToDomain(row: typeof publications.$inferSelect): Publication {
  return parseOrThrow(publicationSchema, row, "Publication row");
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
}

export class ChangesetStore {
  constructor(private readonly ctx: PersistenceContext) {}

  record(input: ChangesetInput, options?: WriteOptions): Changeset {
    const valid = parseOrThrow(changesetInputSchema, input, "Changeset input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      for (const snapshotId of [valid.beforeSnapshotId, valid.afterSnapshotId]) {
        const snapshot = requireRow(this.ctx.db.select({ workspaceId: snapshots.workspaceId }).from(snapshots).where(eq(snapshots.id, snapshotId)).get(), "Snapshot", snapshotId);
        if (snapshot.workspaceId !== run.workspaceId) throw new InvariantViolationError(`Snapshot ${snapshotId} belongs to another Workspace`);
      }
      const diff = requireRow(this.ctx.db.select({ runId: artifacts.runId }).from(artifacts).where(eq(artifacts.id, valid.diffArtifactId)).get(), "Artifact", valid.diffArtifactId);
      assertSameRun("Artifact", valid.diffArtifactId, diff.runId, run.id);
      if (valid.invocationId !== null) {
        const invocation = requireRow(this.ctx.db.select({ runId: invocations.runId }).from(invocations).where(eq(invocations.id, valid.invocationId)).get(), "Invocation", valid.invocationId);
        assertSameRun("Invocation", valid.invocationId, invocation.runId, run.id);
      }
      const changeset: Changeset = {
        id: this.ctx.ids("changeset"),
        ...valid,
        integrationStatus: "pending",
        integratedSnapshotId: null,
        conflictTaskId: null,
        createdAt: this.ctx.clock(),
        integratedAt: null,
      };
      parseOrThrow(changesetSchema, changeset, "Changeset");
      this.ctx.journal.append({
        type: "changeset.recorded",
        scope: runScope(run, { invocationId: valid.invocationId }),
        subjectType: "changeset",
        subjectId: changeset.id,
        payload: changeset,
        ...writeMeta(options),
      });
      this.ctx.db.insert(changesets).values(changeset).run();
      return changeset;
    });
  }

  get(id: ChangesetId): Changeset {
    return changesetToDomain(requireRow(this.ctx.db.select().from(changesets).where(eq(changesets.id, id)).get(), "Changeset", id));
  }

  listByRun(runId: RunId): Changeset[] {
    return this.ctx.db.select().from(changesets).where(eq(changesets.runId, runId)).orderBy(asc(changesets.createdAt)).all().map(changesetToDomain);
  }

  transition(id: ChangesetId, transition: ChangesetTransition, options?: WriteOptions): Changeset {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
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

export class PublicationStore {
  constructor(private readonly ctx: PersistenceContext) {}

  /** Records one publish action on a `completed` Run authorized by an operator-resolved Decision. */
  record(input: PublicationInput, options?: WriteOptions): Publication {
    const valid = parseOrThrow(publicationInputSchema, input, "Publication input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      if (run.status !== "completed") throw new ConflictError(`Run ${run.id} is ${run.status}; only a completed Run is published`);
      const decision = requireRow(
        this.ctx.db.select({ conversationId: decisions.conversationId, kind: decisions.kind, status: decisions.status, resolvedBy: decisions.resolvedBy }).from(decisions).where(eq(decisions.id, valid.decisionId)).get(),
        "Decision",
        valid.decisionId,
      );
      if (decision.conversationId !== run.conversationId) throw new InvariantViolationError(`Decision ${valid.decisionId} belongs to another Conversation`);
      if (decision.kind !== "publish" && decision.kind !== "operator_choice") throw new InvariantViolationError(`a ${decision.kind} Decision does not authorize publishing`);
      if (decision.status !== "resolved" || decision.resolvedBy !== "operator") throw new InvariantViolationError(`Decision ${valid.decisionId} was not resolved by the operator`);
      const changeset = requireRow(this.ctx.db.select({ runId: changesets.runId }).from(changesets).where(eq(changesets.id, valid.changesetId)).get(), "Changeset", valid.changesetId);
      assertSameRun("Changeset", valid.changesetId, changeset.runId, run.id);
      for (const snapshotId of [valid.targetBeforeSnapshotId, valid.targetAfterSnapshotId]) {
        if (snapshotId === null) continue;
        const snapshot = requireRow(this.ctx.db.select({ workspaceId: snapshots.workspaceId }).from(snapshots).where(eq(snapshots.id, snapshotId)).get(), "Snapshot", snapshotId);
        if (snapshot.workspaceId !== run.workspaceId) throw new InvariantViolationError(`Snapshot ${snapshotId} belongs to another Workspace`);
      }
      if (valid.artifactId !== null) {
        const artifact = requireRow(this.ctx.db.select({ runId: artifacts.runId }).from(artifacts).where(eq(artifacts.id, valid.artifactId)).get(), "Artifact", valid.artifactId);
        assertSameRun("Artifact", valid.artifactId, artifact.runId, run.id);
      }
      const publication: Publication = { id: this.ctx.ids("publication"), ...valid, createdAt: this.ctx.clock() };
      parseOrThrow(publicationSchema, publication, "Publication");
      this.ctx.journal.append({
        type: valid.outcome === "succeeded" ? "run.published" : "run.publish_failed",
        scope: runScope(run),
        subjectType: "publication",
        subjectId: publication.id,
        payload: publication,
        ...writeMeta(options),
      });
      this.ctx.db.insert(publications).values(publication).run();
      return publication;
    });
  }

  get(id: PublicationId): Publication {
    return publicationToDomain(requireRow(this.ctx.db.select().from(publications).where(eq(publications.id, id)).get(), "Publication", id));
  }

  listByRun(runId: RunId): Publication[] {
    return this.ctx.db.select().from(publications).where(eq(publications.runId, runId)).orderBy(asc(publications.createdAt)).all().map(publicationToDomain);
  }
}
