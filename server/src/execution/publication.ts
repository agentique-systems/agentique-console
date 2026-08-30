/**
 * Publication (execution-model §9.4; invariant 16): the one deterministic
 * runtime boundary that may modify a Run's Target, and the only code that
 * calls the publication Workspace port. Publication is separate from Run
 * execution, signoff acceptance, Changeset integration, provider/model
 * execution, and the Run scheduler: no timer, no polling, no action graph,
 * no Invocation, no model call, no provider message read — a completed Run stays `completed` whatever
 * happens here.
 *
 * The flow is staged and every stage is a durable boundary:
 *
 * 1. `request` opens the Run's one `publish` Decision (operator_required,
 *    options `publish` and `cancel`, a typed subject naming the completed
 *    Run, its Workspace, the exact Target, the final Snapshot, the final
 *    Changeset, and the requested strategy).
 * 2. `resolve` records the operator's answer: `cancel` resolves the
 *    Decision and creates nothing; `publish` resolves it and creates
 *    exactly one `requested` Publication in the same transaction.
 * 3. `advance` moves one Publication through one durable boundary per
 *    call, always re-reading canonical state first: `requested` prepares
 *    the candidate through the port (outside every transaction; the Target
 *    is not modified) and persists the prepared facts; `prepared` runs the
 *    accepted completion boundary's deterministic Acceptance Criteria on
 *    the candidate through the shared check service and persists
 *    `verified`; `verified` durably persists `applying` before any Target
 *    call; `applying` performs the port's idempotent atomic
 *    compare-and-swap-plus-receipt and records the canonical outcome; a
 *    terminal Publication releases its staging resources. Deterministic
 *    refusals become closed terminal failures with a canonical
 *    publication-report Artifact; infrastructure uncertainty leaves the
 *    status unchanged for a later pass.
 * 4. `reconcileOutstanding` re-drives every nonterminal Publication and
 *    every pending cleanup after a restart; `releaseOutstanding` retries
 *    cleanup alone.
 *
 * SQLite and the Workspace provider are never pretended to be one
 * transaction: every port call runs outside every database transaction, and
 * every external-call/record crash window is bridged by idempotent port
 * operations (prepare replays, the durable apply receipt, idempotent
 * release) plus re-reads of canonical rows.
 */
import {
  boundedFailureMessage,
  canonicalJson,
  canonicalPublicationReport,
  NotFoundError,
  InvariantViolationError,
  PUBLICATION_MACHINE,
  PUBLICATION_REPORT_MEDIA_TYPE,
  PublicationRefusedError,
  publishSubjectOf,
  PUBLISH_OPTIONS,
  type AcceptanceCriterionId,
  type Artifact,
  type ArtifactId,
  type ChangesetId,
  type Decision,
  type DecisionId,
  type EvaluationId,
  type Publication,
  type PublicationFailure,
  type PublicationId,
  type PublicationReport,
  type PublicationStagingCleanup,
  type PublicationStatus,
  type PublicationStrategy,
  type PublicationStrategyRequest,
  type PublishOption,
  type Run,
  type RunId,
  type RunStatus,
  type RunTarget,
  type SnapshotId,
  type Timestamp,
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import { OPERATOR_ACTOR, RUNTIME_ACTOR, type WriteOptions } from "../persistence/stores/support.ts";
import type { AcceptanceCheckService } from "./acceptance-checks.ts";
import type { ArtifactContentSource } from "./ports/integration-workspace.ts";
import type { PublicationPrepareOutcome, PublicationPrepareRequest, PublicationWorkspaceIdentity, PublicationWorkspacePort } from "./ports/publication-workspace.ts";
import type { ExecutionDiagnosticSink } from "./workspace-cleanup.ts";

/** The media type of a Publication's bounded diagnostic Artifact (a conflict report, a provider message). */
export const PUBLICATION_DIAGNOSTIC_MEDIA_TYPE = "text/plain";

/** The bound on a Publication diagnostic Artifact's bytes. */
export const PUBLICATION_DIAGNOSTIC_MAX_BYTES = 16_384;

export interface PublicationRequestInput {
  runId: RunId;
  requestedStrategy: PublicationStrategyRequest;
}

export interface PublicationResolveInput {
  runId: RunId;
  decisionId: DecisionId;
  option: PublishOption;
}

export type PublicationResolutionOutcome =
  | { kind: "cancelled"; decisionId: DecisionId; replayed: boolean }
  | { kind: "publishing"; decisionId: DecisionId; publicationId: PublicationId; replayed: boolean };

/** What one `advance` call did: exactly one durable boundary, or the typed reason nothing durable could happen. */
export type PublicationAdvanceOutcome =
  | { kind: "prepared"; publicationId: PublicationId }
  | { kind: "verified"; publicationId: PublicationId; checks: number }
  | { kind: "applying"; publicationId: PublicationId }
  | { kind: "succeeded"; publicationId: PublicationId; targetAfterSnapshotId: SnapshotId; alreadyApplied: boolean }
  | { kind: "failed"; publicationId: PublicationId; failure: PublicationFailure }
  | { kind: "released"; publicationId: PublicationId }
  /** Terminal and released: nothing remains to do. */
  | { kind: "quiescent"; publicationId: PublicationId }
  /** Another writer advanced the Publication meanwhile; re-read and call again. */
  | { kind: "stale"; publicationId: PublicationId }
  /** The external operation could not complete; the status is unchanged and a later pass retries. */
  | { kind: "infrastructure_failure"; publicationId: PublicationId; stage: "prepare" | "verify" | "apply" | "release"; message: string };

/** Bounded Artifact facts for the inspection projection: never content. */
export interface PublicationArtifactFacts {
  artifactId: ArtifactId;
  mediaType: string;
  byteSize: number;
  digest: string;
  title: string | null;
}

/** The bounded, read-only projection of a Run's publication boundary for an operator-facing layer: facts and allowed actions only. */
export interface PublicationProjection {
  runId: RunId;
  runStatus: RunStatus;
  target: RunTarget;
  finalSnapshotId: SnapshotId | null;
  finalChangesetId: ChangesetId | null;
  openDecision: { decisionId: DecisionId; requestedStrategy: PublicationStrategyRequest } | null;
  publications: {
    publicationId: PublicationId;
    decisionId: DecisionId;
    status: PublicationStatus;
    requestedStrategy: PublicationStrategyRequest;
    strategy: PublicationStrategy | null;
    targetBeforeSnapshotId: SnapshotId | null;
    candidateSnapshotId: SnapshotId | null;
    targetAfterSnapshotId: SnapshotId | null;
    failure: PublicationFailure | null;
    report: PublicationArtifactFacts | null;
    evaluationIds: EvaluationId[];
    stagingCleanup: PublicationStagingCleanup;
    createdAt: Timestamp;
    endedAt: Timestamp | null;
  }[];
  /** What the operator (or recovery) may do next. */
  allowedActions: ("request_publish" | "resolve_publish" | "advance_publication")[];
}

export interface PublicationServiceDependencies {
  ctx: PersistenceContext;
  stores: Stores;
  port: PublicationWorkspacePort;
  checks: AcceptanceCheckService;
  diagnostics?: ExecutionDiagnosticSink;
}

/**
 * The content source handed to the port's `prepare`: bound to the final
 * Changeset's one diff Artifact; every read re-verifies the stored bytes
 * against the bound digest and size, outside any transaction. The holder can
 * neither look up another Artifact nor enumerate any.
 */
class VerifiedFinalChangesetContent implements ArtifactContentSource {
  readonly artifactId: ArtifactId;
  readonly mediaType: string;
  readonly digest: string;
  readonly byteSize: number;
  readonly #ctx: PersistenceContext;
  readonly #stores: Stores;

  constructor(ctx: PersistenceContext, stores: Stores, artifact: Artifact) {
    this.#ctx = ctx;
    this.#stores = stores;
    this.artifactId = artifact.id;
    this.mediaType = artifact.mediaType;
    this.digest = artifact.digest;
    this.byteSize = artifact.byteSize;
  }

  async read(): Promise<Uint8Array> {
    if (this.#ctx.tx.inTransaction) throw new Error("final Changeset content is read outside any transaction");
    const { artifact, bytes } = this.#stores.artifacts.read(this.artifactId);
    if (artifact.digest !== this.digest || artifact.byteSize !== this.byteSize) {
      throw new InvariantViolationError(`Artifact ${this.artifactId} no longer matches the bound digest and size`, { artifactId: this.artifactId });
    }
    return bytes;
  }
}

const facts = (artifact: Artifact): PublicationArtifactFacts => ({ artifactId: artifact.id, mediaType: artifact.mediaType, byteSize: artifact.byteSize, digest: artifact.digest, title: artifact.title });

export class RunPublicationService {
  constructor(private readonly deps: PublicationServiceDependencies) {}

  private get ctx(): PersistenceContext {
    return this.deps.ctx;
  }

  private get stores(): Stores {
    return this.deps.stores;
  }

  // ---------------------------------------------------------------------------
  // Request: the publish Decision
  // ---------------------------------------------------------------------------

  /**
   * Opens the Run's one `publish` Decision for the completed Run's exact
   * final result. An identical retry returns the existing open Decision; a
   * conflicting one is refused (only one open publish Decision exists per
   * Run), as is any request while a Publication is nonterminal or after one
   * succeeded.
   */
  request(input: PublicationRequestInput, options: WriteOptions = {}): { decision: Decision; replayed: boolean } {
    return this.ctx.tx.write(() => {
      const run = this.completedRun(input.runId);
      this.assertPublishable(run);
      const open = this.stores.decisions.openPublishOf(run.id);
      if (open !== null) {
        const subject = publishSubjectOf(open);
        if (canonicalJson(subject.requestedStrategy) === canonicalJson(input.requestedStrategy) && subject.finalChangesetId === run.finalChangesetId && subject.finalSnapshotId === run.finalSnapshotId) {
          return { decision: open, replayed: true };
        }
        throw new PublicationRefusedError("publish_decision_open", `Run ${run.id} already has open publish Decision ${open.id} for another request`, { runId: run.id, decisionId: open.id });
      }
      const decision = this.stores.decisions.request(
        {
          conversationId: run.conversationId,
          runId: run.id,
          kind: "publish",
          resolutionPolicy: "operator_required",
          requestedBy: { kind: "operator" },
          question: `Publish the accepted result of Run ${run.id} to its Target?`,
          options: [
            { id: PUBLISH_OPTIONS[0], label: "Publish", description: null },
            { id: PUBLISH_OPTIONS[1], label: "Cancel", description: null },
          ],
          recommendedOptionId: null,
          rationale: null,
          affects: { requirementIds: [], taskIds: [], planNodeIds: [] },
          deadlineAt: null,
          activationCondition: null,
          subject: {
            kind: "publish",
            runId: run.id,
            workspaceId: run.workspaceId,
            target: run.target,
            finalSnapshotId: run.finalSnapshotId!,
            finalChangesetId: run.finalChangesetId!,
            requestedStrategy: input.requestedStrategy,
          },
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
   * Resolves the Run's publish Decision. `cancel` resolves it and creates
   * no Publication; `publish` resolves it and creates exactly one
   * `requested` Publication in the same transaction. Identical retries
   * return the canonical existing result; a conflicting replay is refused.
   */
  resolve(input: PublicationResolveInput, options: WriteOptions = {}): PublicationResolutionOutcome {
    return this.ctx.tx.write(() => {
      const run = this.completedRun(input.runId);
      let decision: Decision;
      try {
        decision = this.stores.decisions.get(input.decisionId);
      } catch (error) {
        if (error instanceof NotFoundError) throw new PublicationRefusedError("decision_mismatch", `Decision ${input.decisionId} does not exist`, { decisionId: input.decisionId });
        throw error;
      }
      if (decision.kind !== "publish" || decision.runId !== run.id || decision.conversationId !== run.conversationId) {
        throw new PublicationRefusedError("decision_mismatch", `Decision ${input.decisionId} is not a publish Decision of Run ${run.id}`, { runId: run.id, decisionId: input.decisionId });
      }
      const subject = publishSubjectOf(decision);
      if (subject.workspaceId !== run.workspaceId || canonicalJson(subject.target) !== canonicalJson(run.target) || subject.finalSnapshotId !== run.finalSnapshotId || subject.finalChangesetId !== run.finalChangesetId) {
        throw new PublicationRefusedError("boundary_inconsistent", `the subject of Decision ${decision.id} disagrees with the completed Run ${run.id}`, { runId: run.id, decisionId: decision.id });
      }
      if (decision.status !== "open") {
        const chosen = decision.resolution?.chosenOptionId ?? null;
        if (decision.status === "resolved" && chosen === input.option) {
          if (chosen === "cancel") return { kind: "cancelled", decisionId: decision.id, replayed: true };
          const existing = this.stores.publications.byDecision(decision.id);
          if (existing === null) throw new PublicationRefusedError("boundary_inconsistent", `Decision ${decision.id} was resolved publish without its Publication`, { decisionId: decision.id });
          return { kind: "publishing", decisionId: decision.id, publicationId: existing.id, replayed: true };
        }
        throw new PublicationRefusedError("conflicting_resolution", `Decision ${decision.id} is ${decision.status}${chosen === null ? "" : ` (${chosen})`}; ${input.option} conflicts with it`, { decisionId: decision.id, chosen, requested: input.option });
      }
      if (input.option === "cancel") {
        this.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "cancel", rationale: null, artifactIds: [] }, { ...this.meta(options, decision.id), actor: options.actor ?? OPERATOR_ACTOR });
        return { kind: "cancelled", decisionId: decision.id, replayed: false };
      }
      // `publish`: revalidate the boundary, resolve, and create the one Publication atomically.
      this.assertPublishable(run);
      const meta: WriteOptions = { ...this.meta(options, decision.id), actor: options.actor ?? OPERATOR_ACTOR };
      this.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "publish", rationale: null, artifactIds: [] }, meta);
      const publication = this.stores.publications.create(
        { runId: run.id, decisionId: decision.id, changesetId: subject.finalChangesetId, requestedStrategy: subject.requestedStrategy },
        { ...meta, causationSeq: this.ctx.journal.lastSeq() },
      );
      return { kind: "publishing", decisionId: decision.id, publicationId: publication.id, replayed: false };
    });
  }

  // ---------------------------------------------------------------------------
  // Inspect (read-only)
  // ---------------------------------------------------------------------------

  /** The bounded projection of the Run's publication boundary: facts and allowed actions, no content, output, paths, receipts, or Events. */
  inspect(runId: RunId): PublicationProjection {
    const run = this.stores.runs.get(runId);
    const open = this.stores.decisions.openPublishOf(run.id);
    const publications = this.stores.publications.listByRun(run.id).map((p) => ({
      publicationId: p.id,
      decisionId: p.decisionId,
      status: p.status,
      requestedStrategy: p.requestedStrategy,
      strategy: p.strategy,
      targetBeforeSnapshotId: p.targetBeforeSnapshotId,
      candidateSnapshotId: p.candidateSnapshotId,
      targetAfterSnapshotId: p.targetAfterSnapshotId,
      failure: p.failure,
      report: p.reportArtifactId === null ? null : facts(this.stores.artifacts.get(p.reportArtifactId)),
      evaluationIds: this.stores.evaluations.publicationCriterionEvaluationsOf(p.id).map((e) => e.id).sort(),
      stagingCleanup: p.stagingCleanup,
      createdAt: p.createdAt,
      endedAt: p.endedAt,
    }));
    const active = publications.some((p) => !PUBLICATION_MACHINE.isTerminal(p.status));
    const succeeded = publications.some((p) => p.status === "succeeded");
    const cleanupDue = publications.some((p) => PUBLICATION_MACHINE.isTerminal(p.status) && p.stagingCleanup === "pending");
    const allowedActions: PublicationProjection["allowedActions"] = [];
    if (run.status === "completed" && open === null && !active && !succeeded) allowedActions.push("request_publish");
    if (open !== null) allowedActions.push("resolve_publish");
    if (active || cleanupDue) allowedActions.push("advance_publication");
    return {
      runId: run.id,
      runStatus: run.status,
      target: run.target,
      finalSnapshotId: run.finalSnapshotId,
      finalChangesetId: run.finalChangesetId,
      openDecision: open === null ? null : { decisionId: open.id, requestedStrategy: publishSubjectOf(open).requestedStrategy },
      publications,
      allowedActions,
    };
  }

  // ---------------------------------------------------------------------------
  // Advance: one durable boundary per call
  // ---------------------------------------------------------------------------

  /** Moves the Publication through its next durable boundary, always re-reading canonical state before acting. */
  async advance(publicationId: PublicationId, options: WriteOptions = {}): Promise<PublicationAdvanceOutcome> {
    if (this.ctx.tx.inTransaction) throw new Error("publication advances call the Workspace provider and never run inside a transaction");
    const publication = this.stores.publications.get(publicationId);
    switch (publication.status) {
      case "requested":
        return this.prepareStep(publication, options);
      case "prepared":
        return this.verifyStep(publication, options);
      case "verified": {
        // The durable commitment boundary: `applying` is persisted before any Target call, so a crash after it is
        // reconciled through the idempotent apply, never by guessing.
        return this.ctx.tx.write((): PublicationAdvanceOutcome => {
          const current = this.stores.publications.get(publicationId);
          if (current.status !== "verified") return { kind: "stale", publicationId };
          this.stores.publications.transition(publicationId, { to: "applying" }, this.meta(options, publicationId));
          return { kind: "applying", publicationId };
        });
      }
      case "applying":
        return this.applyStep(publication, options);
      case "succeeded":
      case "failed":
        return this.releaseStep(publication, options);
    }
  }

  /** Re-drives every nonterminal Publication and every pending cleanup from canonical rows; the recovery entry point. */
  async reconcileOutstanding(options: WriteOptions = {}): Promise<PublicationAdvanceOutcome[]> {
    const outstanding = [...this.stores.publications.listNonterminal(), ...this.stores.publications.listPendingCleanup()];
    const outcomes: PublicationAdvanceOutcome[] = [];
    for (const publication of outstanding) {
      // One Publication has at most six durable boundaries; the bound keeps a misbehaving fake from looping.
      for (let step = 0; step < 8; step += 1) {
        const outcome = await this.advance(publication.id, options);
        outcomes.push(outcome);
        if (outcome.kind === "quiescent" || outcome.kind === "infrastructure_failure" || outcome.kind === "stale") break;
        if (outcome.kind === "released") break;
      }
    }
    return outcomes;
  }

  /** Retries the staging release of every terminal Publication whose cleanup is still pending. */
  async releaseOutstanding(options: WriteOptions = {}): Promise<PublicationAdvanceOutcome[]> {
    const outcomes: PublicationAdvanceOutcome[] = [];
    for (const publication of this.stores.publications.listPendingCleanup()) {
      outcomes.push(await this.releaseStep(publication, options));
    }
    return outcomes;
  }

  // ---------------------------------------------------------------------------
  // Prepare
  // ---------------------------------------------------------------------------

  /**
   * Prepares the candidate through the port (outside every transaction; the
   * Target is not modified), then persists the prepared facts in one
   * transaction: the Target-before and candidate Snapshots and the selected
   * strategy. A deterministic refusal is a terminal failure with its
   * report; an unavailable provider leaves the Publication `requested`.
   */
  private async prepareStep(publication: Publication, options: WriteOptions): Promise<PublicationAdvanceOutcome> {
    const outcome = await this.prepareThroughPort(publication, "prepare");
    if (outcome.kind === "unavailable") return this.unavailable(publication.id, "prepare", outcome.message);
    if (outcome.kind === "refused") {
      let failure: PublicationFailure;
      if (outcome.refusal === "strategy_unsupported") {
        const refusedStrategy = outcome.strategy ?? (publication.requestedStrategy.kind === "exact" ? publication.requestedStrategy.strategy : null);
        if (refusedStrategy === null) throw new InvariantViolationError(`the port refused Publication ${publication.id} as strategy_unsupported without naming the strategy`, { publicationId: publication.id });
        failure = { kind: "strategy_unsupported", strategy: refusedStrategy };
      } else {
        failure = { kind: outcome.refusal };
      }
      return this.failTerminal(publication.id, "requested", failure, outcome.message, options);
    }
    const run = this.stores.runs.get(publication.runId);
    const base = this.stores.snapshots.get(run.baseSnapshotId!);
    if (outcome.strategy.kind === "fast_forward" && canonicalJson(outcome.targetBeforeSnapshot) !== canonicalJson(base.identity)) {
      throw new InvariantViolationError(`the port selected fast_forward although the Target does not equal the base Snapshot of Run ${run.id}`, { publicationId: publication.id });
    }
    return this.ctx.tx.write((): PublicationAdvanceOutcome => {
      const current = this.stores.publications.get(publication.id);
      if (current.status !== "requested") return { kind: "stale", publicationId: publication.id };
      const meta = this.meta(options, publication.id);
      const before = this.stores.snapshots.record({ workspaceId: run.workspaceId, runId: run.id, identity: outcome.targetBeforeSnapshot, reason: "publish_before" }, meta);
      const candidate = this.stores.snapshots.record({ workspaceId: run.workspaceId, runId: run.id, identity: outcome.candidateSnapshot, reason: "publish_candidate" }, this.chain(meta));
      this.stores.publications.transition(publication.id, { to: "prepared", strategy: outcome.strategy, targetBeforeSnapshotId: before.id, candidateSnapshotId: candidate.id }, this.chain(meta));
      return { kind: "prepared", publicationId: publication.id };
    });
  }

  /** The port's idempotent prepare over the runtime-verified final Changeset content; a thrown adapter error is `unavailable`. */
  private async prepareThroughPort(publication: Publication, stage: "prepare" | "verify"): Promise<PublicationPrepareOutcome> {
    if (this.ctx.tx.inTransaction) throw new Error("the publication Workspace port is called outside every transaction");
    const run = this.stores.runs.get(publication.runId);
    const changeset = this.stores.changesets.get(publication.changesetId);
    if (changeset.kind !== "final" || changeset.runId !== run.id) throw new InvariantViolationError(`Changeset ${changeset.id} is not the final Changeset of Run ${run.id}`, { publicationId: publication.id });
    let content: ArtifactContentSource;
    try {
      // Resolve and verify the diff bytes before the port sees anything; corrupted or missing content stops here.
      const { artifact } = this.stores.artifacts.read(changeset.diffArtifactId);
      content = new VerifiedFinalChangesetContent(this.ctx, this.stores, artifact);
    } catch (error) {
      return { kind: "unavailable", message: boundedFailureMessage(`final Changeset content unavailable: ${error instanceof Error ? error.name : "unknown error"}`) };
    }
    const request: PublicationPrepareRequest = {
      ...this.identity(publication, run),
      baseSnapshot: this.stores.snapshots.get(changeset.beforeSnapshotId).identity,
      requestedStrategy: publication.requestedStrategy,
      changeset: {
        beforeSnapshot: this.stores.snapshots.get(changeset.beforeSnapshotId).identity,
        afterSnapshot: this.stores.snapshots.get(changeset.afterSnapshotId).identity,
        diff: content,
      },
    };
    try {
      return await this.deps.port.prepare(request);
    } catch (error) {
      void stage;
      return { kind: "unavailable", message: boundedFailureMessage(error instanceof Error ? error.message : String(error)) };
    }
  }

  // ---------------------------------------------------------------------------
  // Verify
  // ---------------------------------------------------------------------------

  /**
   * Runs the exact deterministic Acceptance Criteria of the passed
   * `run_completion` Gate behind the accepted signoff on the prepared
   * candidate, through the shared check service — no Evaluator, no model
   * call, no provider message. All passing (or none applying, when the persisted
   * prepared facts are the structural validation) persists `verified`; a
   * failing criterion is the terminal `verification_failed`; an
   * infrastructure failure leaves the Publication `prepared`.
   */
  private async verifyStep(publication: Publication, options: WriteOptions): Promise<PublicationAdvanceOutcome> {
    const criteria = this.deps.checks.deterministicCriteria(publication.runId, this.acceptedCompletionCriteria(publication.runId));
    let checks = 0;
    if (criteria.length > 0) {
      // The verification workspace location is never persisted: the idempotent prepare replays it.
      const replay = await this.prepareThroughPort(publication, "verify");
      if (replay.kind === "unavailable") return this.unavailable(publication.id, "verify", replay.message);
      if (replay.kind === "refused") return this.unavailable(publication.id, "verify", `prepare replay refused (${replay.refusal}); staging may have been lost externally`);
      if (
        canonicalJson(replay.strategy) !== canonicalJson(publication.strategy) ||
        canonicalJson(replay.targetBeforeSnapshot) !== canonicalJson(this.stores.snapshots.get(publication.targetBeforeSnapshotId!).identity) ||
        canonicalJson(replay.candidateSnapshot) !== canonicalJson(this.stores.snapshots.get(publication.candidateSnapshotId!).identity)
      ) {
        return this.unavailable(publication.id, "verify", "prepare replay disagrees with the persisted prepared facts; staging may have been lost externally");
      }
      const outcome = await this.deps.checks.run(
        {
          runId: publication.runId,
          planNodeId: null,
          scope: { kind: "publication", publicationId: publication.id, verificationWorkspacePath: replay.verificationWorkspacePath },
          snapshotId: publication.candidateSnapshotId!,
          artifactIds: [],
          criteria,
        },
        this.meta(options, publication.id),
      );
      if (outcome.kind === "infrastructure_failure") return this.unavailable(publication.id, "verify", `${outcome.failure} while checking ${outcome.acceptanceCriterionId}: ${outcome.message}`);
      if (outcome.kind === "failed") {
        return this.failTerminal(publication.id, "prepared", { kind: "verification_failed", acceptanceCriterionIds: [outcome.failed.acceptanceCriterionId] }, null, options);
      }
      checks = outcome.checks.length;
    }
    return this.ctx.tx.write((): PublicationAdvanceOutcome => {
      const current = this.stores.publications.get(publication.id);
      if (current.status !== "prepared") return { kind: "stale", publicationId: publication.id };
      this.stores.publications.transition(publication.id, { to: "verified" }, this.meta(options, publication.id));
      return { kind: "verified", publicationId: publication.id, checks };
    });
  }

  /** The Acceptance Criterion ids of the passed `run_completion` Gate behind the Run's accepted signoff boundary. */
  private acceptedCompletionCriteria(runId: RunId): AcceptanceCriterionId[] {
    const accept = this.stores.signoffResolutions.listByRun(runId).find((r) => r.outcome === "accept");
    if (accept === undefined) throw new InvariantViolationError(`Run ${runId} is completed without an accept Signoff Resolution`, { runId });
    const signoffGate = this.stores.gates.get(accept.gateId);
    if (signoffGate.completionGateId === null) throw new InvariantViolationError(`Gate ${signoffGate.id} presents no run_completion Gate`, { gateId: signoffGate.id });
    return this.stores.gates.get(signoffGate.completionGateId).acceptanceCriterionIds;
  }

  // ---------------------------------------------------------------------------
  // Apply
  // ---------------------------------------------------------------------------

  /**
   * The one Target mutation: the port's idempotent atomic
   * compare-and-swap-plus-receipt, called only from `applying` (never from
   * `requested` or `prepared`), with the exact persisted candidate and
   * expected Target-before identity. `applied` (fresh or from the durable
   * receipt) records `succeeded`; a definite compare-and-swap refusal
   * records the terminal `target_changed`; an unknown result leaves
   * `applying` for reconciliation.
   */
  private async applyStep(publication: Publication, options: WriteOptions): Promise<PublicationAdvanceOutcome> {
    if (this.ctx.tx.inTransaction) throw new Error("the publication Workspace port is called outside every transaction");
    const run = this.stores.runs.get(publication.runId);
    const expected = this.stores.snapshots.get(publication.targetBeforeSnapshotId!).identity;
    const candidate = this.stores.snapshots.get(publication.candidateSnapshotId!).identity;
    let outcome;
    try {
      outcome = await this.deps.port.apply({ ...this.identity(publication, run), expectedTargetSnapshot: expected, candidateSnapshot: candidate, strategy: publication.strategy! });
    } catch (error) {
      return this.unavailable(publication.id, "apply", boundedFailureMessage(error instanceof Error ? error.message : String(error)));
    }
    if (outcome.kind === "unavailable") return this.unavailable(publication.id, "apply", outcome.message);
    if (outcome.kind === "target_changed") {
      return this.failTerminal(publication.id, "applying", { kind: "target_changed" }, `the Target no longer holds the expected state; nothing was applied`, options);
    }
    if (canonicalJson(outcome.targetSnapshot) !== canonicalJson(candidate)) {
      throw new InvariantViolationError(`the apply receipt of Publication ${publication.id} names a state other than the prepared candidate`, { publicationId: publication.id });
    }
    return this.ctx.tx.write((): PublicationAdvanceOutcome => {
      const current = this.stores.publications.get(publication.id);
      if (current.status === "succeeded") return { kind: "succeeded", publicationId: publication.id, targetAfterSnapshotId: current.targetAfterSnapshotId!, alreadyApplied: true };
      if (current.status !== "applying") return { kind: "stale", publicationId: publication.id };
      const meta = this.meta(options, publication.id);
      const report = this.report(current, "succeeded", null, null, meta);
      const next = this.stores.publications.transition(publication.id, { to: "succeeded", reportArtifactId: report.id }, this.chain(meta));
      return { kind: "succeeded", publicationId: publication.id, targetAfterSnapshotId: next.targetAfterSnapshotId!, alreadyApplied: outcome.alreadyApplied };
    });
  }

  // ---------------------------------------------------------------------------
  // Release
  // ---------------------------------------------------------------------------

  /**
   * Releases the terminal Publication's staging resources through the
   * idempotent port (outside every transaction), then records the durable
   * obligation closed. A cleanup failure is a bounded diagnostic and the
   * obligation stays pending; the Publication outcome never changes.
   */
  private async releaseStep(publication: Publication, options: WriteOptions): Promise<PublicationAdvanceOutcome> {
    if (publication.stagingCleanup === "released") return { kind: "quiescent", publicationId: publication.id };
    if (this.ctx.tx.inTransaction) throw new Error("the publication Workspace port is called outside every transaction");
    const run = this.stores.runs.get(publication.runId);
    let outcome;
    try {
      outcome = await this.deps.port.release(this.identity(publication, run));
    } catch (error) {
      outcome = { kind: "failed" as const, message: boundedFailureMessage(error instanceof Error ? error.message : String(error)) };
    }
    if (outcome.kind === "failed") {
      this.deps.diagnostics?.({ kind: "publication_staging_release_failed", publicationId: publication.id, message: boundedFailureMessage(outcome.message) });
      return { kind: "infrastructure_failure", publicationId: publication.id, stage: "release", message: boundedFailureMessage(outcome.message) };
    }
    return this.ctx.tx.write((): PublicationAdvanceOutcome => {
      const current = this.stores.publications.get(publication.id);
      if (current.stagingCleanup === "released") return { kind: "quiescent", publicationId: publication.id };
      this.stores.publications.recordStagingReleased(publication.id, this.meta(options, publication.id));
      return { kind: "released", publicationId: publication.id };
    });
  }

  // ---------------------------------------------------------------------------
  // Shared
  // ---------------------------------------------------------------------------

  private completedRun(runId: RunId): Run {
    const run = this.stores.runs.get(runId);
    if (run.status !== "completed" || run.finalSnapshotId === null || run.finalChangesetId === null || run.baseSnapshotId === null) {
      throw new PublicationRefusedError("run_not_completed", `Run ${runId} is ${run.status}; only a completed Run may be published`, { runId, status: run.status });
    }
    return run;
  }

  private assertPublishable(run: Run): void {
    const succeeded = this.stores.publications.succeededOf(run.id);
    if (succeeded !== null) throw new PublicationRefusedError("run_already_published", `Run ${run.id} was published by Publication ${succeeded.id}`, { runId: run.id, publicationId: succeeded.id });
    const active = this.stores.publications.activeOf(run.id);
    if (active !== null) throw new PublicationRefusedError("publication_active", `Run ${run.id} has nonterminal Publication ${active.id} (${active.status})`, { runId: run.id, publicationId: active.id });
  }

  private identity(publication: Publication, run: Run): PublicationWorkspaceIdentity {
    const workspace = this.stores.workspaces.get(run.workspaceId);
    return { publicationId: publication.id, runId: run.id, workspaceId: run.workspaceId, workspaceRootPath: workspace.rootPath, target: run.target };
  }

  /**
   * Records a terminal failure in one transaction: the optional bounded
   * diagnostic Artifact, the canonical publication report, and the closed
   * failure transition. The Target was not modified by this Publication.
   */
  private failTerminal(publicationId: PublicationId, expectedStatus: PublicationStatus, failure: PublicationFailure, diagnostic: string | null, options: WriteOptions): PublicationAdvanceOutcome {
    return this.ctx.tx.write((): PublicationAdvanceOutcome => {
      const current = this.stores.publications.get(publicationId);
      if (current.status !== expectedStatus) return { kind: "stale", publicationId };
      const meta = this.meta(options, publicationId);
      const report = this.report(current, "failed", failure, diagnostic, meta);
      this.stores.publications.transition(publicationId, { to: "failed", failure, reportArtifactId: report.id }, this.chain(meta));
      return { kind: "failed", publicationId, failure };
    });
  }

  /** The canonical publication-report Artifact of a terminal outcome; bounded raw diagnostics go into their own Artifact, referenced by id. */
  private report(publication: Publication, outcome: "succeeded" | "failed", failure: PublicationFailure | null, diagnostic: string | null, meta: WriteOptions): Artifact {
    const diagnosticArtifact =
      diagnostic === null
        ? null
        : this.stores.artifacts.create(
            { runId: publication.runId, mediaType: PUBLICATION_DIAGNOSTIC_MEDIA_TYPE, producer: { kind: "runtime", component: "publication" }, taskId: null, title: `publication ${publication.id} diagnostics` },
            new TextEncoder().encode(diagnostic).slice(0, PUBLICATION_DIAGNOSTIC_MAX_BYTES),
            meta,
          );
    const report: PublicationReport = {
      version: 1,
      publicationId: publication.id,
      runId: publication.runId,
      decisionId: publication.decisionId,
      changesetId: publication.changesetId,
      requestedStrategy: publication.requestedStrategy,
      strategy: publication.strategy,
      targetBeforeSnapshotId: publication.targetBeforeSnapshotId,
      candidateSnapshotId: publication.candidateSnapshotId,
      targetAfterSnapshotId: outcome === "succeeded" ? publication.candidateSnapshotId : null,
      outcome,
      failure,
      evaluationIds: this.stores.evaluations.publicationCriterionEvaluationsOf(publication.id).map((e) => e.id).sort(),
      diagnosticArtifactId: diagnosticArtifact?.id ?? null,
    };
    return this.stores.artifacts.create(
      { runId: publication.runId, mediaType: PUBLICATION_REPORT_MEDIA_TYPE, producer: { kind: "runtime", component: "publication" }, taskId: null, title: `publication report of ${publication.id}` },
      new TextEncoder().encode(canonicalPublicationReport(report)),
      { ...meta, causationSeq: this.ctx.journal.lastSeq() },
    );
  }

  private unavailable(publicationId: PublicationId, stage: "prepare" | "verify" | "apply", message: string): PublicationAdvanceOutcome {
    const bounded = boundedFailureMessage(message);
    this.deps.diagnostics?.({ kind: "publication_provider_unavailable", publicationId, stage, message: bounded });
    return { kind: "infrastructure_failure", publicationId, stage, message: bounded };
  }

  /** Advance and release Events are the runtime's; `request` and `resolve` pass the operator explicitly. */
  private meta(options: WriteOptions, correlationId: string): WriteOptions {
    return { actor: options.actor ?? RUNTIME_ACTOR, correlationId: options.correlationId ?? correlationId, causationSeq: options.causationSeq ?? null };
  }

  private chain(meta: WriteOptions): WriteOptions {
    return { ...meta, causationSeq: this.ctx.journal.lastSeq() };
  }
}
