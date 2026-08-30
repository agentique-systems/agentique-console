/**
 * Deterministic Acceptance Criterion execution (execution-model §5.6, §10;
 * invariant 11): the one runtime service that runs a node's deterministic
 * criteria against one exact integration Snapshot, in stable Acceptance
 * Criterion id order, stopping at the first failure, through the narrow
 * `AcceptanceCriterionExecutionPort`. It serves two callers with one
 * executor: an `evaluator_optimizer` round (scope `optimizer_round`) and a
 * `node_exit` Gate (scope `gate`); nothing else runs a command.
 *
 * Boundaries are fixed. Each command runs outside every database
 * transaction, against an isolated view of the Snapshot that the port owns
 * and disposes. Its outcome is recorded afterwards in one transaction: the
 * bounded output Artifact (media type `text/plain`, runtime producer
 * `command`, the only place raw output ever lives) and the criterion
 * Evaluation with its `command` and `snapshot` Evidence, verdict `pass` on
 * the expected exit code and `fail` on any other. A port failure (timeout,
 * abort, a view that could not be created, lost output) is an
 * infrastructure failure: it records nothing, never fabricates an
 * Evaluation, and is returned typed so a later scheduler pass retries the
 * check safely.
 *
 * Everything is idempotent from canonical rows: a criterion whose
 * Evaluation for this scope already exists is never executed again, so a
 * crash after a command ran but before its record leaves only a command to
 * rerun, and a crash after the record leaves nothing to repeat. Events,
 * outcomes, and diagnostics carry ids, exit status, digest, byte size, and
 * truncation — never output bytes.
 */
import { boundedFailureMessage, InvariantViolationError, type AcceptanceCriterion, type AcceptanceCriterionId, type ArtifactId, type Evaluation, type EvaluationInput, type Evidence, type GateId, type PlanNodeId, type RunId, type SnapshotId, type Timestamp } from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import type { AcceptanceCriterionExecutionFailure, AcceptanceCriterionExecutionPort, AcceptanceCriterionExecutionRequest } from "./ports/acceptance-criterion-execution.ts";

/** The media type of a deterministic check's captured output Artifact. */
export const COMMAND_OUTPUT_MEDIA_TYPE = "text/plain";

export interface AcceptanceCheckConfig {
  /** The most output bytes stored per check; a longer output is stored as a prefix and recorded as truncated. */
  maxOutputBytes: number;
  /** The wall-clock bound of one command, from the runtime clock; `null` for none. */
  commandTimeoutMs: number | null;
}

export const DEFAULT_ACCEPTANCE_CHECK_CONFIG: Readonly<AcceptanceCheckConfig> = Object.freeze({ maxOutputBytes: 65_536, commandTimeoutMs: 600_000 });

/** Whose deterministic criteria run: one `evaluator_optimizer` round of a node, or one `node_exit` or `run_completion` Gate. */
export type AcceptanceCheckScope = { kind: "optimizer_round"; round: number; maxRounds: number } | { kind: "gate"; gateId: GateId };

/** One set of checks to run: the node (none for a Run-level Gate), the scope, the exact Snapshot, the judged candidate, and the criteria in canonical order. */
export interface AcceptanceCheckRequest {
  runId: RunId;
  planNodeId: PlanNodeId | null;
  scope: AcceptanceCheckScope;
  /** The integration Snapshot every check verifies; recorded on every Evaluation. */
  snapshotId: SnapshotId;
  /** The candidate Artifacts, recorded as the judged Artifacts of every Evaluation. */
  artifactIds: ArtifactId[];
  /** The node's deterministic criteria; the service orders them by id. */
  criteria: AcceptanceCriterion[];
  signal?: AbortSignal;
}

/** The recorded fact of one check: safe metadata only, never output. */
export interface RecordedAcceptanceCheck {
  acceptanceCriterionId: AcceptanceCriterionId;
  evaluation: Evaluation;
  outputArtifactId: ArtifactId;
  exitCode: number;
  truncated: boolean;
  /** Whether this pass ran the command (false when the Evaluation already existed). */
  executed: boolean;
}

export type AcceptanceCheckOutcome =
  /** Every deterministic criterion passed (or none exists). */
  | { kind: "passed"; checks: RecordedAcceptanceCheck[] }
  /** The first failing criterion, in canonical order; no later criterion was run. */
  | { kind: "failed"; checks: RecordedAcceptanceCheck[]; failed: RecordedAcceptanceCheck }
  /** A check could not be carried out; nothing was recorded for it and the remaining criteria were not run. */
  | { kind: "infrastructure_failure"; checks: RecordedAcceptanceCheck[]; acceptanceCriterionId: AcceptanceCriterionId; failure: AcceptanceCriterionExecutionFailure; message: string };

export class AcceptanceCheckService {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
    private readonly port: AcceptanceCriterionExecutionPort,
    private readonly config: AcceptanceCheckConfig = DEFAULT_ACCEPTANCE_CHECK_CONFIG,
  ) {}

  /** The deterministic criteria among `ids`, in stable Acceptance Criterion id order, each validated to belong to the Run's Conversation. */
  deterministicCriteria(runId: RunId, ids: readonly AcceptanceCriterionId[]): AcceptanceCriterion[] {
    const run = this.stores.runs.get(runId);
    return [...new Set(ids)]
      .sort()
      .map((id) => this.stores.requirements.getAcceptanceCriterion(id))
      .filter((criterion) => {
        if (criterion.conversationId !== run.conversationId) throw new InvariantViolationError(`AcceptanceCriterion ${criterion.id} belongs to another Conversation`, { acceptanceCriterionId: criterion.id });
        return criterion.check.kind === "deterministic";
      });
  }

  /** The criterion Evaluations already recorded for the scope, by Acceptance Criterion id. */
  private recorded(request: AcceptanceCheckRequest): Evaluation[] {
    if (request.scope.kind === "gate") return this.stores.evaluations.gateCriterionEvaluationsOf(request.scope.gateId);
    if (request.planNodeId === null) throw new InvariantViolationError("an optimizer round belongs to its evaluator_optimizer Plan Node", { round: request.scope.round });
    return this.stores.evaluations.optimizerCriterionEvaluationsOf(request.planNodeId, request.scope.round);
  }

  /** Runs the scope's deterministic checks in canonical order, outside any transaction, recording each outcome once. */
  async run(request: AcceptanceCheckRequest, options: WriteOptions = {}): Promise<AcceptanceCheckOutcome> {
    if (this.ctx.tx.inTransaction) throw new Error("deterministic checks run outside any transaction; command execution is external");
    const run = this.stores.runs.get(request.runId);
    const snapshot = this.stores.snapshots.get(request.snapshotId);
    if (snapshot.workspaceId !== run.workspaceId) throw new InvariantViolationError(`Snapshot ${request.snapshotId} belongs to another Workspace`, { snapshotId: request.snapshotId });
    const checks: RecordedAcceptanceCheck[] = [];
    const ordered = [...request.criteria].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const criterion of ordered) {
      if (criterion.check.kind !== "deterministic") throw new InvariantViolationError(`AcceptanceCriterion ${criterion.id} is not deterministic`, { acceptanceCriterionId: criterion.id });
      const existing = this.recorded(request).find((e) => e.subject.kind === "acceptance_criterion" && e.subject.acceptanceCriterionId === criterion.id);
      const recorded = existing === undefined ? await this.execute(run, request, criterion, options) : { kind: "recorded" as const, check: recordedOf(existing, false) };
      if (recorded.kind === "failed") return { kind: "infrastructure_failure", checks, acceptanceCriterionId: criterion.id, failure: recorded.failure, message: recorded.message };
      checks.push(recorded.check);
      if (recorded.check.evaluation.verdict !== "pass") return { kind: "failed", checks, failed: recorded.check };
    }
    return { kind: "passed", checks };
  }

  private async execute(run: { id: RunId; integrationWorkspacePath: string | null }, request: AcceptanceCheckRequest, criterion: AcceptanceCriterion, options: WriteOptions): Promise<{ kind: "recorded"; check: RecordedAcceptanceCheck } | { kind: "failed"; failure: AcceptanceCriterionExecutionFailure; message: string }> {
    if (criterion.check.kind !== "deterministic") throw new Error("unreachable");
    const snapshot = this.stores.snapshots.get(request.snapshotId);
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const now = this.ctx.clock();
    const deadlineAt: Timestamp | null = this.config.commandTimeoutMs === null ? null : new Date(Date.parse(now) + this.config.commandTimeoutMs).toISOString();
    const scope = request.scope;
    const executionRequest: AcceptanceCriterionExecutionRequest = {
      runId: run.id,
      planNodeId: request.planNodeId,
      acceptanceCriterionId: criterion.id,
      round: scope.kind === "optimizer_round" ? scope.round : null,
      gateId: scope.kind === "gate" ? scope.gateId : null,
      command: criterion.check.command,
      expectedExitCode: criterion.check.expectedExitCode,
      workspace: { integrationWorkspacePath: run.integrationWorkspacePath, snapshot: snapshot.identity, isolationKey: scope.kind === "gate" ? `${run.id}/${request.planNodeId ?? "run"}/gate/${scope.gateId}/${criterion.id}` : `${run.id}/${request.planNodeId}/${scope.round}/${criterion.id}` },
      maxOutputBytes: this.config.maxOutputBytes,
      deadlineAt,
      signal: controller.signal,
    };
    let outcome;
    try {
      outcome = await this.port.execute(executionRequest);
    } catch (error) {
      return { kind: "failed", failure: "start_failed", message: boundedFailureMessage(error instanceof Error ? error.message : String(error)) };
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
    }
    if (outcome.kind === "failed") return { kind: "failed", failure: outcome.failure, message: boundedFailureMessage(outcome.message) };
    // The port bounds its output; the runtime bounds it again so the stored Artifact never exceeds the configured limit.
    const truncated = outcome.truncated || outcome.output.byteLength > this.config.maxOutputBytes;
    const output = outcome.output.byteLength > this.config.maxOutputBytes ? outcome.output.slice(0, this.config.maxOutputBytes) : outcome.output;
    const expected = criterion.check.expectedExitCode;
    const command = criterion.check.command;
    const evaluation = this.ctx.tx.write((): Evaluation => {
      // A concurrent pass may have recorded the same check meanwhile; the existing row wins and nothing is written twice.
      const again = this.recorded(request).find((e) => e.subject.kind === "acceptance_criterion" && e.subject.acceptanceCriterionId === criterion.id);
      if (again !== undefined) return again;
      const artifact = this.stores.artifacts.create(
        { runId: run.id, mediaType: COMMAND_OUTPUT_MEDIA_TYPE, producer: { kind: "runtime", component: "command" }, taskId: null, title: scope.kind === "gate" ? `check ${criterion.id} gate ${scope.gateId} of ${request.planNodeId ?? run.id}` : `check ${criterion.id} round ${scope.round} of ${request.planNodeId}` },
        output,
        options,
      );
      const evidence: Evidence[] = [{ kind: "command", command, exitCode: outcome.exitCode, outputArtifactId: artifact.id, outputTruncated: truncated }, { kind: "snapshot", snapshotId: request.snapshotId }];
      const input: EvaluationInput = {
        runId: run.id,
        planNodeId: request.planNodeId,
        gateId: scope.kind === "gate" ? scope.gateId : null,
        subject: { kind: "acceptance_criterion", acceptanceCriterionId: criterion.id },
        context: scope.kind === "gate" ? null : { kind: "optimizer_criterion", round: scope.round, maxRounds: scope.maxRounds },
        verdict: outcome.exitCode === expected ? "pass" : "fail",
        evidence,
        producedBy: { kind: "runtime" },
        artifactIds: [...request.artifactIds].sort(),
        snapshotId: request.snapshotId,
      };
      return this.stores.evaluations.record(input, options);
    });
    return { kind: "recorded", check: recordedOf(evaluation, true) };
  }
}

function recordedOf(evaluation: Evaluation, executed: boolean): RecordedAcceptanceCheck {
  if (evaluation.subject.kind !== "acceptance_criterion") throw new InvariantViolationError(`Evaluation ${evaluation.id} judges no Acceptance Criterion`, { evaluationId: evaluation.id });
  const command = evaluation.evidence.find((e): e is Extract<Evidence, { kind: "command" }> => e.kind === "command");
  if (command === undefined) throw new InvariantViolationError(`deterministic Evaluation ${evaluation.id} carries no command Evidence`, { evaluationId: evaluation.id });
  return { acceptanceCriterionId: evaluation.subject.acceptanceCriterionId, evaluation, outputArtifactId: command.outputArtifactId, exitCode: command.exitCode, truncated: command.outputTruncated === true, executed };
}
