import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import {
  canonicalJson,
  ConflictError,
  InvariantViolationError,
  parseOrThrow,
  PREPARE_FAILURE_KINDS,
  PUBLICATION_MACHINE,
  publicationInputSchema,
  publicationSchema,
  publishSubjectOf,
  type DecisionId,
  type Publication,
  type PublicationId,
  type PublicationInput,
  type PublicationStatus,
  type PublicationTransition,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { artifacts, decisions, publications, runs, snapshots } from "../schema.ts";
import { assertSameRun, loadRunRef, requireRow, runScope, writeMeta, type RunRef, type WriteOptions } from "./support.ts";

type Row = typeof publications.$inferSelect;

function toDomain(row: Row): Publication {
  return parseOrThrow(publicationSchema, row, "Publication row");
}

const TERMINAL: readonly PublicationStatus[] = ["succeeded", "failed"];

/** The failure kinds each nonterminal status may fail with; anything else is an illegal transition here and at the database. */
const FAILURE_KINDS_BY_STATUS: Readonly<Partial<Record<PublicationStatus, readonly string[]>>> = {
  requested: PREPARE_FAILURE_KINDS,
  prepared: ["verification_failed", "candidate_invalid"],
  applying: ["target_changed"],
};

/**
 * Publications (execution-model §9.4): the recoverable lifecycle record of
 * one authorized Target update. `create` admits a `requested` row only for a
 * `completed` Run, from its operator-resolved `publish` Decision, naming the
 * Run's own final Changeset — one per Decision, at most one nonterminal and
 * one succeeded per Run (unique indexes; the baseline migration's triggers
 * re-check the boundary at insertion). `transition` applies one legal step
 * of the closed machine and journals it with the row; the terminal step also
 * journals the Run-scoped `run.published` / `run.publish_failed` Event.
 * Terminal rows never change again except their staging-cleanup obligation,
 * which `recordStagingReleased` closes once, after the external release ran.
 */
export class PublicationStore {
  constructor(private readonly ctx: PersistenceContext) {}

  create(input: PublicationInput, options?: WriteOptions & { id?: PublicationId }): Publication {
    const valid = parseOrThrow(publicationInputSchema, input, "Publication input");
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, valid.runId);
      if (run.status !== "completed") throw new ConflictError(`Run ${run.id} is ${run.status}; only a completed Run may have a Publication`, { runId: run.id, status: run.status });
      const runRow = requireRow(this.ctx.db.select({ finalChangesetId: runs.finalChangesetId }).from(runs).where(eq(runs.id, run.id)).get(), "Run", run.id);
      if (runRow.finalChangesetId !== valid.changesetId) {
        throw new InvariantViolationError(`a Publication applies the Run's final Changeset ${String(runRow.finalChangesetId)}, not ${valid.changesetId}`, { runId: run.id, changesetId: valid.changesetId });
      }
      const decisionRow = requireRow(this.ctx.db.select().from(decisions).where(eq(decisions.id, valid.decisionId)).get(), "Decision", valid.decisionId);
      if (decisionRow.kind !== "publish" || decisionRow.runId !== run.id || decisionRow.conversationId !== run.conversationId) {
        throw new InvariantViolationError(`Decision ${valid.decisionId} is not a publish Decision of Run ${run.id}`, { decisionId: valid.decisionId });
      }
      if (decisionRow.status !== "resolved" || decisionRow.resolvedBy !== "operator" || decisionRow.chosenOptionId !== "publish") {
        throw new InvariantViolationError(`Decision ${valid.decisionId} was not resolved 'publish' by the operator`, { decisionId: valid.decisionId, status: decisionRow.status });
      }
      const subject = publishSubjectOf({ id: valid.decisionId, kind: decisionRow.kind, subject: decisionRow.subject });
      if (subject.runId !== run.id || subject.workspaceId !== run.workspaceId || subject.finalChangesetId !== valid.changesetId || canonicalJson(subject.requestedStrategy) !== canonicalJson(valid.requestedStrategy)) {
        throw new InvariantViolationError(`the subject of Decision ${valid.decisionId} does not authorize this Publication`, { decisionId: valid.decisionId });
      }
      const existing = this.byDecision(valid.decisionId);
      if (existing !== null) throw new ConflictError(`Decision ${valid.decisionId} already authorized Publication ${existing.id}`, { decisionId: valid.decisionId, publicationId: existing.id });
      const active = this.activeOf(run.id);
      if (active !== null) throw new ConflictError(`Run ${run.id} already has nonterminal Publication ${active.id} (${active.status})`, { runId: run.id, publicationId: active.id });
      const succeeded = this.succeededOf(run.id);
      if (succeeded !== null) throw new ConflictError(`Run ${run.id} was published by Publication ${succeeded.id}; a succeeded Run is never published again`, { runId: run.id, publicationId: succeeded.id });
      const publication: Publication = {
        id: options?.id ?? this.ctx.ids("publication"),
        ...valid,
        strategy: null,
        targetBeforeSnapshotId: null,
        candidateSnapshotId: null,
        targetAfterSnapshotId: null,
        status: "requested",
        failure: null,
        reportArtifactId: null,
        stagingCleanup: "pending",
        createdAt: this.ctx.clock(),
        preparedAt: null,
        verifiedAt: null,
        applyingAt: null,
        endedAt: null,
        stagingReleasedAt: null,
      };
      parseOrThrow(publicationSchema, publication, "Publication");
      this.append(run, "publication.requested", publication, options);
      this.ctx.db.insert(publications).values(publication).run();
      return publication;
    });
  }

  get(id: PublicationId): Publication {
    return toDomain(requireRow(this.ctx.db.select().from(publications).where(eq(publications.id, id)).get(), "Publication", id));
  }

  listByRun(runId: RunId): Publication[] {
    return this.ctx.db.select().from(publications).where(eq(publications.runId, runId)).orderBy(asc(publications.createdAt), asc(publications.id)).all().map(toDomain);
  }

  /** The Publication a resolved publish Decision authorized, or `null`; at most one exists (a database unique index). */
  byDecision(decisionId: DecisionId): Publication | null {
    const row = this.ctx.db.select().from(publications).where(eq(publications.decisionId, decisionId)).get();
    return row ? toDomain(row) : null;
  }

  /** The Run's one nonterminal Publication, or `null`; at most one exists (a database unique index). */
  activeOf(runId: RunId): Publication | null {
    const rows = this.ctx.db.select().from(publications).where(and(eq(publications.runId, runId), notInArray(publications.status, [...TERMINAL]))).all().map(toDomain);
    if (rows.length > 1) throw new InvariantViolationError(`Run ${runId} has ${rows.length} nonterminal Publications`, { runId });
    return rows[0] ?? null;
  }

  /** The Run's one succeeded Publication, or `null`; at most one exists (a database unique index). */
  succeededOf(runId: RunId): Publication | null {
    const rows = this.ctx.db.select().from(publications).where(and(eq(publications.runId, runId), eq(publications.status, "succeeded"))).all().map(toDomain);
    if (rows.length > 1) throw new InvariantViolationError(`Run ${runId} has ${rows.length} succeeded Publications`, { runId });
    return rows[0] ?? null;
  }

  /** Every nonterminal Publication, in creation order: what recovery reconciles. */
  listNonterminal(): Publication[] {
    return this.ctx.db.select().from(publications).where(notInArray(publications.status, [...TERMINAL])).orderBy(asc(publications.createdAt), asc(publications.id)).all().map(toDomain);
  }

  /** Every terminal Publication whose staging cleanup is still pending: what recovery releases. */
  listPendingCleanup(): Publication[] {
    return this.ctx.db
      .select()
      .from(publications)
      .where(and(inArray(publications.status, [...TERMINAL]), eq(publications.stagingCleanup, "pending")))
      .orderBy(asc(publications.createdAt), asc(publications.id))
      .all()
      .map(toDomain);
  }

  /**
   * Applies one legal transition. `prepared` records the selected strategy
   * and the Target-before and candidate Snapshots (of the Run's Workspace;
   * an exact strategy request must be honored exactly); `verified` and
   * `applying` are durable milestones; `succeeded` sets the Target-after
   * reference to exactly the candidate and records the report; `failed`
   * records the closed failure fact permitted at the current status and the
   * report. Every transition journals the row; the terminal ones also
   * journal `run.published` / `run.publish_failed`.
   */
  transition(id: PublicationId, transition: PublicationTransition, options?: WriteOptions): Publication {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      PUBLICATION_MACHINE.assertTransition(current.status, transition.to, { publicationId: id });
      const run = loadRunRef(this.ctx, current.runId);
      const now = this.ctx.clock();
      const next: Publication = { ...current, status: transition.to };
      switch (transition.to) {
        case "prepared": {
          for (const snapshotId of [transition.targetBeforeSnapshotId, transition.candidateSnapshotId]) {
            const snapshot = requireRow(this.ctx.db.select({ workspaceId: snapshots.workspaceId }).from(snapshots).where(eq(snapshots.id, snapshotId)).get(), "Snapshot", snapshotId);
            if (snapshot.workspaceId !== run.workspaceId) throw new InvariantViolationError(`Snapshot ${snapshotId} belongs to another Workspace`, { snapshotId });
          }
          if (current.requestedStrategy.kind === "exact" && canonicalJson(transition.strategy) !== canonicalJson(current.requestedStrategy.strategy)) {
            throw new InvariantViolationError(`Publication ${id} requested exactly ${canonicalJson(current.requestedStrategy.strategy)}; ${canonicalJson(transition.strategy)} does not honor it`, { publicationId: id });
          }
          next.strategy = transition.strategy;
          next.targetBeforeSnapshotId = transition.targetBeforeSnapshotId;
          next.candidateSnapshotId = transition.candidateSnapshotId;
          next.preparedAt = now;
          break;
        }
        case "verified":
          next.verifiedAt = now;
          break;
        case "applying":
          next.applyingAt = now;
          break;
        case "succeeded":
          next.targetAfterSnapshotId = current.candidateSnapshotId;
          next.reportArtifactId = this.reportOf(run, transition.reportArtifactId);
          next.endedAt = now;
          break;
        case "failed": {
          const permitted = FAILURE_KINDS_BY_STATUS[current.status] ?? [];
          if (!permitted.includes(transition.failure.kind)) {
            throw new InvariantViolationError(`a ${current.status} Publication cannot fail with ${transition.failure.kind}`, { publicationId: id, status: current.status, failure: transition.failure.kind });
          }
          next.failure = transition.failure;
          next.reportArtifactId = this.reportOf(run, transition.reportArtifactId);
          next.endedAt = now;
          break;
        }
      }
      parseOrThrow(publicationSchema, next, "Publication");
      this.append(run, `publication.${transition.to}` as const, next, options);
      if (transition.to === "succeeded" || transition.to === "failed") {
        this.append(run, transition.to === "succeeded" ? "run.published" : "run.publish_failed", next, options);
      }
      // Only the columns this transition changes are written; the prepared-once and terminal-immutability triggers guard the rest.
      const changed: Partial<Row> = { status: next.status };
      if (transition.to === "prepared") Object.assign(changed, { strategy: next.strategy, targetBeforeSnapshotId: next.targetBeforeSnapshotId, candidateSnapshotId: next.candidateSnapshotId, preparedAt: next.preparedAt });
      if (transition.to === "verified") changed.verifiedAt = next.verifiedAt;
      if (transition.to === "applying") changed.applyingAt = next.applyingAt;
      if (transition.to === "succeeded") Object.assign(changed, { targetAfterSnapshotId: next.targetAfterSnapshotId, reportArtifactId: next.reportArtifactId, endedAt: next.endedAt });
      if (transition.to === "failed") Object.assign(changed, { failure: next.failure, reportArtifactId: next.reportArtifactId, endedAt: next.endedAt });
      this.ctx.db.update(publications).set(changed).where(eq(publications.id, id)).run();
      return next;
    });
  }

  /** Closes the durable staging-cleanup obligation once, after the external release ran for a terminal Publication. */
  recordStagingReleased(id: PublicationId, options?: WriteOptions): Publication {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (!TERMINAL.includes(current.status)) throw new ConflictError(`Publication ${id} is ${current.status}; staging is released only after a terminal outcome`, { publicationId: id, status: current.status });
      if (current.stagingCleanup === "released") throw new ConflictError(`Publication ${id} already released its staging resources`, { publicationId: id });
      const run = loadRunRef(this.ctx, current.runId);
      const next: Publication = { ...current, stagingCleanup: "released", stagingReleasedAt: this.ctx.clock() };
      parseOrThrow(publicationSchema, next, "Publication");
      this.ctx.journal.append({
        type: "publication.workspace_released",
        scope: runScope(run),
        subjectType: "publication",
        subjectId: id,
        payload: { publicationId: id },
        ...writeMeta(options),
      });
      this.ctx.db.update(publications).set({ stagingCleanup: "released", stagingReleasedAt: next.stagingReleasedAt }).where(eq(publications.id, id)).run();
      return next;
    });
  }

  private reportOf(run: RunRef, reportArtifactId: Publication["reportArtifactId"] & string) {
    const artifact = requireRow(this.ctx.db.select({ runId: artifacts.runId }).from(artifacts).where(eq(artifacts.id, reportArtifactId)).get(), "Artifact", reportArtifactId);
    assertSameRun("Artifact", reportArtifactId, artifact.runId, run.id);
    return reportArtifactId;
  }

  private append(run: RunRef, type: "publication.requested" | "publication.prepared" | "publication.verified" | "publication.applying" | "publication.succeeded" | "publication.failed" | "run.published" | "run.publish_failed", publication: Publication, options?: WriteOptions): void {
    this.ctx.journal.append({
      type,
      scope: runScope(run),
      subjectType: "publication",
      subjectId: publication.id,
      payload: publication,
      ...writeMeta(options),
    });
  }
}
