/**
 * Runtime test harness: the persistence harness plus the execution services
 * over deterministic fakes — the Workspace preparation port, the
 * execution-workspace port, the scripted provider, and an in-memory
 * continuation payload store — with the harness clock driving every
 * timestamp, backoff, and deadline. No timers, no network.
 */
import {
  DEFAULT_PLAN_LIMITS,
  EMPTY_WORKSPACE_CAPABILITY_POLICY,
  type AcceptanceCriterionId,
  type AgentDefinitionRevision,
  type ConversationId,
  type ConversationMessage,
  type Invocation,
  type PlanExpression,
  type PlanLimits,
  type PublicationStrategy,
  type RequirementId,
  type RequirementRevision,
  type SnapshotIdentity,
} from "@agentique-console/core";
import { sha256Hex } from "../persistence/blob-store.ts";
import { DEFAULT_BUDGET, INVOCATION_ALLOCATION, openHarness, seedAgentRevision, seedRunCompletionGate, type Harness, type Seeded } from "../persistence/test-support.ts";
import { MemoryContinuationPayloadStore } from "../provider/continuation-store.ts";
import { ContinuationService } from "../provider/continuation.ts";
import { ScriptedProvider } from "../provider/fake.ts";
import type { TransientOutput } from "../provider/adapter.ts";
import { AcceptanceCheckService, type AcceptanceCheckConfig } from "./acceptance-checks.ts";
import { AttemptExecutor, DEFAULT_EXECUTOR_CONFIG, type AttemptExecutorConfig } from "./attempt-executor.ts";
import { BudgetIncreaseService } from "./budget-increases.ts";
import type { DecisionRequestService } from "./decision-requests.ts";
import type { AcceptanceCriterionExecutionFailure, AcceptanceCriterionExecutionOutcome, AcceptanceCriterionExecutionPort, AcceptanceCriterionExecutionRequest } from "./ports/acceptance-criterion-execution.ts";
import { ResourceGovernor, type GovernorConfig } from "./governor.ts";
import { InvocationPreparationService } from "./invocation-preparation-service.ts";
import { PlanNodeCapacity } from "./plan-node-capacity.ts";
import { PlanRevisionService, type PlanRevisionOutcome } from "./plan-revision-service.ts";
import { HandoffRouter } from "./handoff-routing.ts";
import { ChangesetIntegrationService } from "./integration-service.ts";
import type { CollectedChangeset, ExecutionWorkspacePort, ExecutionWorkspaceRequest, PreparedExecutionWorkspace } from "./ports/execution-workspace.ts";
import type { IntegrationApplyOutcome, IntegrationApplyRequest, IntegrationWorkspacePort } from "./ports/integration-workspace.ts";
import type { PublicationApplyOutcome, PublicationApplyRequest, PublicationPrepareOutcome, PublicationPrepareRequest, PublicationReleaseOutcome, PublicationReleaseRequest, PublicationWorkspacePort } from "./ports/publication-workspace.ts";
import type { RunFinalizationFailure, RunFinalizationOutcome, RunFinalizationRequest, RunFinalizationWorkspacePort } from "./ports/run-finalization-workspace.ts";
import { RunPublicationService } from "./publication.ts";
import { RunSignoffService } from "./signoff.ts";
import { createPatternRunners, type PatternRunners } from "./patterns/index.ts";
import { RunScheduler, type SchedulerConfig } from "./scheduler.ts";
import type { PreparedRunWorkspace, RunWorkspacePreparationPort, RunWorkspacePreparationRequest } from "./ports/workspace-preparation.ts";
import { RecoveryService } from "./recovery-service.ts";
import { OrchestratorInputService } from "./orchestrator-inputs.ts";
import { RequirementProposalService } from "./requirement-proposals.ts";
import { RunControlService } from "./run-control.ts";
import { RunCreationService, type CreatedRun, type RunCreationPolicy, type RunCreationRequest, type RunVerificationRequest } from "./run-creation-service.ts";
import { RunStartService } from "./run-start-service.ts";
import { WorkspaceCleanup, type ExecutionDiagnostic } from "./workspace-cleanup.ts";

/** A deterministic Workspace preparation port that records what it did and can be told to fail. */
export class FakeWorkspacePreparation implements RunWorkspacePreparationPort {
  readonly prepared: { request: RunWorkspacePreparationRequest; result: PreparedRunWorkspace }[] = [];
  readonly discarded: { request: RunWorkspacePreparationRequest; prepared: PreparedRunWorkspace }[] = [];
  failWith: Error | null = null;
  /** When set, the next preparation returns this Snapshot identity (to provoke a persistence failure after preparation). */
  nextBaseSnapshot: PreparedRunWorkspace["baseSnapshot"] | null = null;

  prepare(request: RunWorkspacePreparationRequest): PreparedRunWorkspace {
    if (this.failWith) {
      const error = this.failWith;
      this.failWith = null;
      throw error;
    }
    const baseSnapshot = this.nextBaseSnapshot ?? (request.workspace.kind === "git" ? { kind: "git" as const, commitId: "a".repeat(40), treeId: "b".repeat(40) } : { kind: "directory" as const, contentDigest: "c".repeat(64) });
    this.nextBaseSnapshot = null;
    const result = { baseSnapshot, integrationWorkspacePath: `${request.workspace.rootPath}/.agentique/runs/${request.runId}` };
    this.prepared.push({ request, result });
    return result;
  }

  discard(request: RunWorkspacePreparationRequest, prepared: PreparedRunWorkspace): void {
    this.discarded.push({ request, prepared });
  }
}

/** A deterministic git Snapshot identity derived from its inputs, so integrated states are reproducible across processes. */
export function fakeSnapshot(...parts: string[]): SnapshotIdentity {
  const digest = sha256Hex(parts.join("|"));
  return { kind: "git", commitId: digest.slice(0, 40), treeId: digest.slice(24, 64) };
}

/**
 * A deterministic integration-workspace port: applies a Changeset onto the
 * current integration Snapshot by deriving the next Snapshot from both,
 * idempotently by Changeset id (a repeated apply returns the same Snapshot
 * and reports it), conflicting when told to, and recording every call so
 * tests can assert serialization, idempotence, and that nothing named the
 * Target.
 */
/** What the fake adapter observed about one apply: safe facts only, never the diff bytes. */
export interface ObservedIntegration {
  changesetId: string;
  artifactId: string;
  /** The digest the adapter computed over the bytes it read. */
  digest: string;
  byteSize: number;
  /** Whether a database transaction was open while the adapter read the content and applied it (`null` when the harness gave no probe). */
  inTransaction: boolean | null;
}

/**
 * A deterministic Integration Workspace: applies exactly the bytes it reads
 * from the request's content source, idempotent by Changeset id, with no
 * access to persistence — it receives a digest function and, from the test
 * harness, a transaction-state probe, nothing else.
 */
export class FakeIntegrationWorkspace implements IntegrationWorkspacePort {
  readonly requests: IntegrationApplyRequest[] = [];
  /** One entry per completed content read, in apply order. */
  readonly observed: ObservedIntegration[] = [];
  readonly applied = new Map<string, SnapshotIdentity>();
  /** Changeset ids whose next apply conflicts; consumed on use unless `conflictAlways` is set. */
  readonly conflictNext = new Set<string>();
  conflictAlways = new Set<string>();
  /** When set, `apply` waits for this promise before returning (to exercise "no transaction while awaiting"). */
  gate: Promise<void> | null = null;
  readonly #inFlightByRun = new Map<string, number>();
  /** The most applies ever in flight at once per Run: 1 proves serialization. */
  readonly maxConcurrentByRun = new Map<string, number>();
  /** When set, the next apply records success in the fake (as if the external application happened) and then throws (a crash before persistence). */
  crashAfterApply = false;
  /** The Snapshot each Run's Integration Workspace holds now (the last applied), what a finalization inspects. */
  readonly currentByRun = new Map<string, SnapshotIdentity>();
  /** The exact diff bytes applied into each Run's Integration Workspace, in apply order: what the base-to-final diff is made of. */
  readonly appliedDiffsByRun = new Map<string, { changesetId: string; bytes: Uint8Array }[]>();

  constructor(
    private readonly digestOf: (bytes: Uint8Array) => string,
    /** Reports whether a database transaction is open; set by the test harness, never by persistence. */
    public transactionProbe: (() => boolean) | null = null,
  ) {}

  async apply(request: IntegrationApplyRequest): Promise<IntegrationApplyOutcome> {
    this.requests.push(request);
    const inFlight = (this.#inFlightByRun.get(request.runId) ?? 0) + 1;
    this.#inFlightByRun.set(request.runId, inFlight);
    this.maxConcurrentByRun.set(request.runId, Math.max(this.maxConcurrentByRun.get(request.runId) ?? 0, inFlight));
    try {
      if (this.gate) await this.gate;
      // The content is read on every apply — an already-applied Changeset included — and refused unless it verifies.
      const openBeforeRead = this.transactionProbe?.() ?? null;
      const bytes = await request.changeset.diff.read();
      const inTransaction = openBeforeRead === null ? null : openBeforeRead || (this.transactionProbe?.() ?? false);
      const digest = this.digestOf(bytes);
      if (digest !== request.changeset.diff.digest || bytes.byteLength !== request.changeset.diff.byteSize) {
        throw new Error(`the content source of ${request.changesetId} delivered bytes that do not match its declared digest and size`);
      }
      this.observed.push({ changesetId: request.changesetId, artifactId: request.changeset.diff.artifactId, digest, byteSize: bytes.byteLength, inTransaction });
      const existing = this.applied.get(request.changesetId);
      if (existing) return { kind: "integrated", snapshot: existing, alreadyApplied: true };
      if (this.conflictAlways.has(request.changesetId) || this.conflictNext.delete(request.changesetId)) {
        return { kind: "conflict", report: `CONFLICT (content): merge conflict applying ${request.changesetId} onto ${request.currentSnapshot.kind === "git" ? request.currentSnapshot.commitId : request.currentSnapshot.contentDigest}` };
      }
      const current = request.currentSnapshot.kind === "git" ? request.currentSnapshot.commitId : request.currentSnapshot.contentDigest;
      const snapshot = bytes.byteLength === 0 ? request.currentSnapshot : fakeSnapshot(current, request.changesetId);
      this.applied.set(request.changesetId, snapshot);
      this.currentByRun.set(request.runId, snapshot);
      this.appliedDiffsByRun.set(request.runId, [...(this.appliedDiffsByRun.get(request.runId) ?? []), { changesetId: request.changesetId, bytes }]);
      if (this.crashAfterApply) {
        this.crashAfterApply = false;
        throw new Error("process died after applying the Changeset");
      }
      return { kind: "integrated", snapshot, alreadyApplied: false };
    } finally {
      this.#inFlightByRun.set(request.runId, (this.#inFlightByRun.get(request.runId) ?? 1) - 1);
    }
  }
}

/**
 * A deterministic publication Workspace port (execution-model §9.4) whose
 * external state — the Target each Workspace holds, the staging per
 * Publication, and the durable atomic-update receipts — survives process
 * lifetimes when the instance is carried into a reopened harness, exactly
 * like a real provider's refs. `prepare` is idempotent by Publication id and
 * never moves the Target; `apply` models the provider guarantee that the
 * Target compare-and-swap and the receipt are one atomic operation (a
 * scripted crash happens after both, so a retry recovers `already_applied`
 * even when the Target has since moved again); `release` is idempotent.
 */
export class FakePublicationWorkspace implements PublicationWorkspacePort {
  readonly prepares: PublicationPrepareRequest[] = [];
  readonly applies: PublicationApplyRequest[] = [];
  readonly releases: PublicationReleaseRequest[] = [];
  /** Whether a database transaction was open during each port call (`null` without a probe): must always be false. */
  readonly observedTransactions: (boolean | null)[] = [];
  /** The Snapshot each Workspace's Target holds now, keyed by Workspace and Target; initialized from the first prepare's base Snapshot. */
  readonly targets = new Map<string, SnapshotIdentity>();
  /** Durable staging per Publication: what an idempotent prepare replays. */
  readonly staged = new Map<string, { targetBefore: SnapshotIdentity; candidate: SnapshotIdentity; strategy: PublicationStrategy; verificationWorkspacePath: string }>();
  /** The durable provider-owned receipt of one atomic Target update, keyed by Publication id. */
  readonly receipts = new Map<string, { targetSnapshot: SnapshotIdentity }>();
  readonly released = new Set<string>();
  /** Every actual Target mutation, in order: "at most one" is the crash-window assertion. */
  readonly targetMutations: { publicationId: string; to: SnapshotIdentity }[] = [];
  /** Whether this provider supports `merge` for automatic selection and exact requests. */
  supportsMerge = true;
  /** Provider-named `other` strategies reported as supported. */
  readonly supportedOther = new Set<string>();
  /** Publication ids whose next candidate construction conflicts; consumed on use. */
  readonly conflictNext = new Set<string>();
  /** Infrastructure-failure scripting: the next N calls return `unavailable`/`failed` without doing anything. */
  prepareUnavailableNext = 0;
  applyUnavailableNext = 0;
  releaseFailNext = 0;
  /** When set, the next `apply` performs the atomic update-plus-receipt and then throws: a crash after the external mutation, before any result reaches the runtime. */
  crashAfterApply = false;
  transactionProbe: (() => boolean) | null = null;

  constructor(private readonly digestOf: (bytes: Uint8Array) => string) {}

  targetKey(request: { workspaceId: string; target: unknown }): string {
    return `${request.workspaceId}:${JSON.stringify(request.target)}`;
  }

  /** Moves a Target externally (an operator push): what a compare-and-swap must then definitely refuse. */
  moveTarget(request: { workspaceId: string; target: unknown }, to: SnapshotIdentity): void {
    this.targets.set(this.targetKey(request), to);
  }

  currentTarget(request: { workspaceId: string; target: unknown }): SnapshotIdentity | null {
    return this.targets.get(this.targetKey(request)) ?? null;
  }

  async prepare(request: PublicationPrepareRequest): Promise<PublicationPrepareOutcome> {
    this.prepares.push(request);
    this.observedTransactions.push(this.transactionProbe?.() ?? null);
    if (this.prepareUnavailableNext > 0) {
      this.prepareUnavailableNext -= 1;
      return { kind: "unavailable", message: "the Workspace provider could not be reached" };
    }
    const existing = this.staged.get(request.publicationId);
    if (existing) return { kind: "prepared", targetBeforeSnapshot: existing.targetBefore, candidateSnapshot: existing.candidate, strategy: existing.strategy, verificationWorkspacePath: existing.verificationWorkspacePath, alreadyPrepared: true };
    // The content is read and verified on every fresh prepare; the source itself refuses inside a transaction.
    const bytes = await request.changeset.diff.read();
    if (this.digestOf(bytes) !== request.changeset.diff.digest || bytes.byteLength !== request.changeset.diff.byteSize) {
      throw new Error(`the content source of ${request.publicationId} delivered bytes that do not match its declared digest and size`);
    }
    const key = this.targetKey(request);
    if (!this.targets.has(key)) this.targets.set(key, request.baseSnapshot);
    const current = this.targets.get(key)!;
    const atBase = JSON.stringify(current) === JSON.stringify(request.baseSnapshot);
    let strategy: PublicationStrategy;
    if (request.requestedStrategy.kind === "automatic") {
      if (atBase) strategy = { kind: "fast_forward" };
      else if (this.supportsMerge) strategy = { kind: "merge" };
      else return { kind: "refused", refusal: "strategy_unsupported", strategy: { kind: "merge" }, message: "merge is not supported for this Target" };
    } else {
      strategy = request.requestedStrategy.strategy;
      if (strategy.kind === "fast_forward" && !atBase) return { kind: "refused", refusal: "fast_forward_unavailable", strategy: null, message: "the Target no longer equals the base Snapshot" };
      if (strategy.kind === "merge" && !this.supportsMerge) return { kind: "refused", refusal: "strategy_unsupported", strategy, message: "merge is not supported for this Target" };
      if (strategy.kind === "other" && !this.supportedOther.has(strategy.name)) return { kind: "refused", refusal: "strategy_unsupported", strategy, message: `strategy ${strategy.name} is not supported` };
    }
    if (this.conflictNext.delete(request.publicationId)) {
      return { kind: "refused", refusal: "candidate_conflict", strategy: null, message: `CONFLICT (content): the final Changeset does not apply cleanly onto the Target` };
    }
    const candidate = strategy.kind === "fast_forward" ? request.changeset.afterSnapshot : fakeSnapshot(JSON.stringify(current), JSON.stringify(request.changeset.afterSnapshot), "publication");
    const staged = { targetBefore: current, candidate, strategy, verificationWorkspacePath: `${request.workspaceRootPath}/.agentique/publications/${request.publicationId}` };
    this.staged.set(request.publicationId, staged);
    return { kind: "prepared", targetBeforeSnapshot: staged.targetBefore, candidateSnapshot: staged.candidate, strategy: staged.strategy, verificationWorkspacePath: staged.verificationWorkspacePath, alreadyPrepared: false };
  }

  async apply(request: PublicationApplyRequest): Promise<PublicationApplyOutcome> {
    this.applies.push(request);
    this.observedTransactions.push(this.transactionProbe?.() ?? null);
    // The durable receipt decides replays first: even when the Target has since moved again, the recorded resulting identity is returned.
    const receipt = this.receipts.get(request.publicationId);
    if (receipt) return { kind: "applied", targetSnapshot: receipt.targetSnapshot, alreadyApplied: true };
    if (this.applyUnavailableNext > 0) {
      this.applyUnavailableNext -= 1;
      return { kind: "unavailable", message: "the Target update result is unknown" };
    }
    const key = this.targetKey(request);
    const current = this.targets.get(key) ?? request.expectedTargetSnapshot;
    if (JSON.stringify(current) !== JSON.stringify(request.expectedTargetSnapshot)) {
      return { kind: "target_changed", currentTargetSnapshot: current };
    }
    // One atomic provider operation: the Target ref and the receipt ref move together; there is no unguarded force update.
    this.targets.set(key, request.candidateSnapshot);
    this.receipts.set(request.publicationId, { targetSnapshot: request.candidateSnapshot });
    this.targetMutations.push({ publicationId: request.publicationId, to: request.candidateSnapshot });
    if (this.crashAfterApply) {
      this.crashAfterApply = false;
      throw new Error("process died after the atomic Target update and receipt");
    }
    return { kind: "applied", targetSnapshot: request.candidateSnapshot, alreadyApplied: false };
  }

  async release(request: PublicationReleaseRequest): Promise<PublicationReleaseOutcome> {
    this.releases.push(request);
    this.observedTransactions.push(this.transactionProbe?.() ?? null);
    if (this.releaseFailNext > 0) {
      this.releaseFailNext -= 1;
      return { kind: "failed", message: "staging release failed" };
    }
    // Idempotent: releasing staging that was never created (or is already gone) is released.
    this.staged.delete(request.publicationId);
    this.released.add(request.publicationId);
    return { kind: "released" };
  }
}

/** What the fake finalization port observed about one inspection: safe facts only, never the diff bytes. */
export interface ObservedFinalization {
  runId: string;
  /** Whether a database transaction was open while the Integration Workspace was inspected (`null` without a probe). */
  inTransaction: boolean | null;
  outcome: "inspected" | "failed";
  byteSize: number;
}

/**
 * A deterministic Run finalization port over the fake Integration Workspace:
 * reports the Snapshot that Workspace holds now (the last applied one, or the
 * base when nothing was applied; a drift a test injected otherwise), whether
 * it is clean, and the exact base-to-final diff — the applied diffs in apply
 * order — and records every call. It receives no persistence: only the
 * request and, from the harness, a transaction-state probe.
 */
export class FakeRunFinalizationWorkspace implements RunFinalizationWorkspacePort {
  readonly requests: RunFinalizationRequest[] = [];
  readonly observed: ObservedFinalization[] = [];
  /** Per Run, a Snapshot the Integration Workspace drifted to outside the runtime (a stray write); the next inspection reports it. */
  readonly driftedTo = new Map<string, SnapshotIdentity>();
  /** Runs whose Integration Workspace holds uncommitted changes. */
  readonly dirtyRuns = new Set<string>();
  /** When set, the next inspection reports this infrastructure failure. */
  failNext: RunFinalizationFailure | null = null;
  /** When set, the next inspection throws (an adapter crash). */
  throwNext: Error | null = null;

  constructor(
    private readonly integration: FakeIntegrationWorkspace,
    public transactionProbe: (() => boolean) | null = null,
  ) {}

  async inspect(request: RunFinalizationRequest): Promise<RunFinalizationOutcome> {
    this.requests.push(request);
    const inTransaction = this.transactionProbe?.() ?? null;
    if (this.throwNext) {
      const error = this.throwNext;
      this.throwNext = null;
      throw error;
    }
    if (this.failNext) {
      const failure = this.failNext;
      this.failNext = null;
      this.observed.push({ runId: request.runId, inTransaction, outcome: "failed", byteSize: 0 });
      return { kind: "failed", failure, message: `${failure} while inspecting the Integration Workspace` };
    }
    const currentSnapshot = this.driftedTo.get(request.runId) ?? this.integration.currentByRun.get(request.runId) ?? request.baseSnapshot;
    const parts = (this.integration.appliedDiffsByRun.get(request.runId) ?? []).map((d) => d.bytes);
    const diff = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      diff.set(part, offset);
      offset += part.byteLength;
    }
    this.observed.push({ runId: request.runId, inTransaction, outcome: "inspected", byteSize: diff.byteLength });
    return { kind: "inspected", currentSnapshot, diff, workspace: { clean: !this.dirtyRuns.has(request.runId) } };
  }
}

/** A deterministic execution-workspace port: one worktree per writing Invocation created from the Run's current integration Snapshot, an explicit (empty by default) Changeset, recorded calls. */
export class FakeExecutionWorkspace implements ExecutionWorkspacePort {
  readonly prepared: { request: ExecutionWorkspaceRequest; result: PreparedExecutionWorkspace }[] = [];
  readonly discarded: ExecutionWorkspaceRequest[] = [];
  readonly collected: ExecutionWorkspaceRequest[] = [];
  readonly released: ExecutionWorkspaceRequest[] = [];
  failWith: Error | null = null;
  /** When set, every `release` throws it until cleared (a failing or crashed external cleanup). */
  failReleaseWith: Error | null = null;
  /** The next collected Changeset; `null` makes the port report none (a validation violation for a writing Invocation). */
  nextChangeset: CollectedChangeset | null | undefined = undefined;
  #counter = 0;

  prepare(request: ExecutionWorkspaceRequest): PreparedExecutionWorkspace {
    if (this.failWith) {
      const error = this.failWith;
      this.failWith = null;
      throw error;
    }
    this.#counter += 1;
    const result: PreparedExecutionWorkspace = request.writes
      ? { worktreePath: `${request.integrationWorkspacePath ?? "/tmp"}/worktrees/${request.invocationId}`, startingSnapshot: request.integrationSnapshot ?? ({ kind: "git", commitId: this.#counter.toString(16).padStart(40, "0"), treeId: "b".repeat(40) } as SnapshotIdentity) }
      : { worktreePath: request.integrationWorkspacePath, startingSnapshot: null };
    this.prepared.push({ request, result });
    return result;
  }

  discard(request: ExecutionWorkspaceRequest): void {
    this.discarded.push(request);
  }

  async collectChangeset(request: ExecutionWorkspaceRequest): Promise<CollectedChangeset | null> {
    this.collected.push(request);
    if (this.nextChangeset !== undefined) {
      const next = this.nextChangeset;
      this.nextChangeset = undefined;
      return next;
    }
    return { afterSnapshot: { kind: "git", commitId: "e".repeat(40), treeId: "f".repeat(40) }, diff: new Uint8Array(), empty: true };
  }

  release(request: ExecutionWorkspaceRequest): void {
    if (this.failReleaseWith) throw this.failReleaseWith;
    this.released.push(request);
  }
}

/** One scripted answer of the fake check port for a criterion (by Acceptance Criterion id, or by command text). */
export type FakeCheckStep =
  | { kind: "exit"; exitCode: number; output?: string; truncated?: boolean }
  /** Resolves only when the test releases `key` (or the runtime aborts); then `then` applies. */
  | { kind: "delay"; key: string; then: FakeCheckStep }
  | { kind: "fail"; failure: AcceptanceCriterionExecutionFailure; message?: string }
  /** Waits for the request's deadline or abort signal and reports a timeout. */
  | { kind: "hang" }
  | { kind: "throw"; error: Error };

/** What the fake port observed about one execution: safe facts only. */
export interface ObservedCheck {
  acceptanceCriterionId: string;
  command: string;
  round: number | null;
  gateId: string | null;
  publicationId: string | null;
  /** The isolated view the command ran in; never the Integration Workspace or the Target. */
  viewPath: string;
  isolationKey: string;
  snapshot: SnapshotIdentity;
  maxOutputBytes: number;
  /** Whether a database transaction was open while the command ran (`null` without a probe). */
  inTransaction: boolean | null;
  outcome: "exited" | "failed";
  /** Whether a stale view under the same key was discarded before this execution. */
  discardedStale: boolean;
}

/**
 * A deterministic Acceptance Criterion execution port: answers each request
 * from a script keyed by criterion id (then by command), models the isolated
 * view of the Snapshot (prepared, written to, disposed), bounded output,
 * deadline and abort, infrastructure failures, and stale-view disposal
 * across a process restart; it receives no persistence and reads nothing but
 * the request.
 */
export class FakeAcceptanceCriterionExecution implements AcceptanceCriterionExecutionPort {
  readonly requests: AcceptanceCriterionExecutionRequest[] = [];
  readonly observed: ObservedCheck[] = [];
  /** Isolated views by isolation key that were prepared and not yet disposed (a "stale" view after a simulated crash). */
  readonly liveViews = new Map<string, string>();
  readonly disposed: string[] = [];
  /** Every write the "command" performed, by the path it wrote to: proves isolation. */
  readonly writes: { path: string; isolationKey: string }[] = [];
  readonly #script = new Map<string, FakeCheckStep[]>();
  readonly #released = new Map<string, () => void>();
  /** The answer when nothing is scripted for a criterion. */
  defaultStep: FakeCheckStep = { kind: "exit", exitCode: 0, output: "ok\n" };
  /** When set, a view whose disposal would run is left live instead (a crash before cleanup). */
  crashBeforeDispose = false;
  #counter = 0;

  constructor(public transactionProbe: (() => boolean) | null = null) {}

  /** Queues answers for a criterion id or a command text, consumed in order. */
  script(key: string, ...steps: FakeCheckStep[]): this {
    this.#script.set(key, [...(this.#script.get(key) ?? []), ...steps]);
    return this;
  }

  release(key: string): void {
    const release = this.#released.get(key);
    if (!release) throw new Error(`no delayed check is waiting on ${key}`);
    this.#released.delete(key);
    release();
  }

  get delayedKeys(): string[] {
    return [...this.#released.keys()].sort();
  }

  async execute(request: AcceptanceCriterionExecutionRequest): Promise<AcceptanceCriterionExecutionOutcome> {
    this.requests.push(request);
    const step = this.#script.get(request.acceptanceCriterionId)?.shift() ?? this.#script.get(request.command)?.shift() ?? this.defaultStep;
    // A stale view under the same key (a previous process died mid-check) is discarded; a fresh, disposable view holds exactly the Snapshot.
    const discardedStale = this.liveViews.has(request.workspace.isolationKey);
    if (discardedStale) this.disposed.push(this.liveViews.get(request.workspace.isolationKey)!);
    this.#counter += 1;
    const viewPath = `${request.workspace.integrationWorkspacePath ?? "/tmp"}/.verification/${request.workspace.isolationKey.replaceAll("/", "_")}-${this.#counter}`;
    this.liveViews.set(request.workspace.isolationKey, viewPath);
    const inTransaction = this.transactionProbe?.() ?? null;
    const record = (outcome: "exited" | "failed") => this.observed.push({ acceptanceCriterionId: request.acceptanceCriterionId, command: request.command, round: request.round, gateId: request.gateId, publicationId: request.publicationId, viewPath, isolationKey: request.workspace.isolationKey, snapshot: request.workspace.snapshot, maxOutputBytes: request.maxOutputBytes, inTransaction, outcome, discardedStale });
    const dispose = () => {
      if (this.crashBeforeDispose) return;
      this.liveViews.delete(request.workspace.isolationKey);
      this.disposed.push(viewPath);
    };
    try {
      const outcome = await this.#run(step, request, viewPath);
      record(outcome.kind);
      return outcome;
    } finally {
      dispose();
    }
  }

  async #run(step: FakeCheckStep, request: AcceptanceCriterionExecutionRequest, viewPath: string): Promise<AcceptanceCriterionExecutionOutcome> {
    switch (step.kind) {
      case "delay":
        await new Promise<void>((resolve) => {
          this.#released.set(step.key, resolve);
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        this.#released.delete(step.key);
        if (request.signal.aborted) return { kind: "failed", failure: "aborted", message: "aborted by the runtime" };
        return this.#run(step.then, request, viewPath);
      case "hang":
        if (!request.signal.aborted) await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { kind: "failed", failure: request.signal.aborted ? "aborted" : "timed_out", message: "the command did not finish" };
      case "throw":
        throw step.error;
      case "fail":
        return { kind: "failed", failure: step.failure, message: step.message ?? step.failure };
      case "exit": {
        // The command "writes" into its isolated view only; the Integration Workspace path is never touched.
        this.writes.push({ path: `${viewPath}/scratch`, isolationKey: request.workspace.isolationKey });
        const full = new TextEncoder().encode(step.output ?? `exit ${step.exitCode}\n`);
        const truncated = step.truncated === true || full.byteLength > request.maxOutputBytes;
        const output = full.byteLength > request.maxOutputBytes ? full.slice(0, request.maxOutputBytes) : full;
        return { kind: "exited", exitCode: step.exitCode, output, truncated };
      }
    }
  }
}

export const TEST_POLICY: RunCreationPolicy = {
  initialOrchestratorAllocation: { costUsd: 10, tokens: 100_000, attempts: 5 },
  finalReserve: { code: { costUsd: 5, tokens: 50_000, attempts: 3 }, other: { costUsd: 0, tokens: 0, attempts: 0 } },
  maxNodeGateCycles: 3,
  maxRunCompletionCycles: 3,
};

export const TEST_NODE_ALLOCATION = { costUsd: 4, tokens: 40_000, attempts: 2 };

export const TEST_GOVERNOR: GovernorConfig = { providers: { fake: { maxConcurrency: 2 } }, maxProcessConcurrency: 3, maxWorktrees: null };

export const TEST_EXECUTOR_CONFIG: AttemptExecutorConfig = { retry: { backoffBaseMs: 1_000, backoffMaxMs: 8_000 }, continuation: DEFAULT_EXECUTOR_CONFIG.continuation };

export const TEST_ACCEPTANCE_CHECKS: AcceptanceCheckConfig = { maxOutputBytes: 4_096, commandTimeoutMs: 60_000 };

export interface RuntimeHarness extends Harness {
  workspacePreparation: FakeWorkspacePreparation;
  executionWorkspace: FakeExecutionWorkspace;
  integrationWorkspace: FakeIntegrationWorkspace;
  integration: ChangesetIntegrationService;
  finalizationWorkspace: FakeRunFinalizationWorkspace;
  /** Reservable Plan Node capacity (execution-model §7.6): the one operation every node-funded path funds its next child through. */
  capacity: PlanNodeCapacity;
  /** The operator-only Budget Increase boundary (execution-model §7.6): `request`, `resolve`, `inspect`. */
  budgetIncreases: BudgetIncreaseService;
  /** Agent-requested Decisions (execution-model §8.2): the operator resolution boundary and the policy resolution the scheduler drives. */
  decisionRequests: DecisionRequestService;
  /** The Orchestrator's Requirement proposals and the operator's approval/edit/rejection boundary (execution-model §8.1). */
  requirementProposals: RequirementProposalService;
  /** Operator steering: messages queued as typed inputs of the Orchestrator's next turn (execution-model §4.6). */
  orchestratorInputs: OrchestratorInputService;
  /** The operator signoff boundary (execution-model §10 `operator_signoff`). */
  signoff: RunSignoffService;
  publicationWorkspace: FakePublicationWorkspace;
  /** The publication boundary (execution-model §9.4): the only runtime code that may modify a Run's Target. */
  publication: RunPublicationService;
  criterionExecution: FakeAcceptanceCriterionExecution;
  checks: AcceptanceCheckService;
  handoffs: HandoffRouter;
  runners: PatternRunners;
  scheduler: RunScheduler;
  provider: ScriptedProvider;
  payloads: MemoryContinuationPayloadStore;
  continuations: ContinuationService;
  governor: ResourceGovernor;
  runCreation: RunCreationService;
  planRevisions: PlanRevisionService;
  preparation: InvocationPreparationService;
  executor: AttemptExecutor;
  recovery: RecoveryService;
  /** The operator Run-control boundary (execution-model §14): `cancel`, `pause`, `resume`. */
  runControl: RunControlService;
  runStart: RunStartService;
  cleanup: WorkspaceCleanup;
  /** Every transient output chunk the executor forwarded. */
  transient: TransientOutput[];
  /** Every bounded diagnostic the execution boundary reported, in order. */
  executionDiagnostics: ExecutionDiagnostic[];
}

export interface RuntimeHarnessOptions {
  limits?: PlanLimits;
  governor?: GovernorConfig;
  executor?: AttemptExecutorConfig;
  supportsContinuation?: boolean;
  scheduler?: SchedulerConfig;
  /** Reuse an already opened persistence harness (simulating a restarted process over the same database). */
  base?: Harness;
  payloads?: MemoryContinuationPayloadStore;
  /** Reuse the fake Integration Workspace of an earlier harness (the external Workspace survives a process). */
  integrationWorkspace?: FakeIntegrationWorkspace;
  /** Reuse the fake check port of an earlier harness (its isolated views survive a process, stale ones included). */
  criterionExecution?: FakeAcceptanceCriterionExecution;
  /** Reuse the fake finalization port of an earlier harness (its injected drift survives a process). */
  finalizationWorkspace?: FakeRunFinalizationWorkspace;
  /** Reuse the fake publication Workspace of an earlier harness (Targets, staging, and receipts survive a process). */
  publicationWorkspace?: FakePublicationWorkspace;
  checks?: AcceptanceCheckConfig;
}

export function openRuntimeHarness(options: RuntimeHarnessOptions = {}): RuntimeHarness {
  const h = options.base ?? openHarness();
  const workspacePreparation = new FakeWorkspacePreparation();
  const executionWorkspace = new FakeExecutionWorkspace();
  const integrationWorkspace = options.integrationWorkspace ?? new FakeIntegrationWorkspace(sha256Hex);
  integrationWorkspace.transactionProbe = () => h.ctx.tx.inTransaction;
  const provider = new ScriptedProvider({ clock: h.ctx.clock, inTransaction: () => h.ctx.tx.inTransaction, supportsContinuation: options.supportsContinuation ?? true });
  const payloads = options.payloads ?? new MemoryContinuationPayloadStore(sha256Hex);
  const continuations = new ContinuationService(h.stores.continuations, payloads, { ttlMs: null, clock: h.ctx.clock });
  const governor = new ResourceGovernor(h.stores.leases, options.governor ?? TEST_GOVERNOR, h.ctx.clock);
  const executorConfig = options.executor ?? TEST_EXECUTOR_CONFIG;
  const preparation = new InvocationPreparationService(h.ctx, h.stores, executionWorkspace, { workspacePolicy: EMPTY_WORKSPACE_CAPABILITY_POLICY });
  const transient: TransientOutput[] = [];
  const executionDiagnostics: ExecutionDiagnostic[] = [];
  const diagnostics = (d: ExecutionDiagnostic) => executionDiagnostics.push(d);
  const cleanup = new WorkspaceCleanup(h.ctx, h.stores, executionWorkspace, diagnostics);
  const planRevisions = new PlanRevisionService(h.ctx, h.stores, {
    defaults: { nodeAllocation: TEST_NODE_ALLOCATION, coordinatorWorkerBounds: { maxTasks: 8, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 } },
    limits: options.limits ?? DEFAULT_PLAN_LIMITS,
  });
  const executor = new AttemptExecutor(h.ctx, h.stores, provider, continuations, governor, executionWorkspace, executorConfig, (chunk) => transient.push(chunk), diagnostics, { planRevisions });
  const integration = new ChangesetIntegrationService(h.ctx, h.stores, integrationWorkspace);
  const criterionExecution = options.criterionExecution ?? new FakeAcceptanceCriterionExecution();
  criterionExecution.transactionProbe = () => h.ctx.tx.inTransaction;
  const checks = new AcceptanceCheckService(h.ctx, h.stores, criterionExecution, options.checks ?? TEST_ACCEPTANCE_CHECKS);
  const capacity = new PlanNodeCapacity(h.ctx, h.stores);
  const runners = createPatternRunners({ ctx: h.ctx, stores: h.stores, executor, preparation, integration, checks, capacity, governor, provider });
  const finalizationWorkspace = options.finalizationWorkspace ?? new FakeRunFinalizationWorkspace(integrationWorkspace);
  finalizationWorkspace.transactionProbe = () => h.ctx.tx.inTransaction;
  const publicationWorkspace = options.publicationWorkspace ?? new FakePublicationWorkspace(sha256Hex);
  publicationWorkspace.transactionProbe = () => h.ctx.tx.inTransaction;
  return {
    ...h,
    workspacePreparation,
    executionWorkspace,
    integrationWorkspace,
    integration,
    finalizationWorkspace,
    capacity,
    budgetIncreases: new BudgetIncreaseService({ ctx: h.ctx, stores: h.stores }),
    decisionRequests: runners.decisionRequests,
    requirementProposals: new RequirementProposalService(h.ctx, h.stores),
    orchestratorInputs: new OrchestratorInputService(h.ctx, h.stores),
    signoff: new RunSignoffService({ ctx: h.ctx, stores: h.stores, preparation, capacity, finalization: finalizationWorkspace }),
    publicationWorkspace,
    publication: new RunPublicationService({ ctx: h.ctx, stores: h.stores, port: publicationWorkspace, checks, diagnostics }),
    criterionExecution,
    checks,
    handoffs: new HandoffRouter(h.stores),
    runners,
    scheduler: new RunScheduler(h.ctx, h.stores, executor, governor, runners, provider, options.scheduler),
    provider,
    payloads,
    continuations,
    governor,
    runCreation: new RunCreationService(h.ctx, h.stores, workspacePreparation, TEST_POLICY),
    planRevisions,
    preparation,
    executor,
    recovery: new RecoveryService(h.ctx, h.stores, governor, continuations, provider, cleanup, executorConfig),
    runControl: new RunControlService({ ctx: h.ctx, stores: h.stores, executor }),
    runStart: new RunStartService(h.ctx, h.stores, preparation),
    cleanup,
    transient,
    executionDiagnostics,
  };
}

export interface RuntimeSeed {
  created: CreatedRun;
  orchestrator: AgentDefinitionRevision;
  worker: AgentDefinitionRevision;
  /** The read-only Gate Evaluator revision the Run's verification policy names. */
  evaluator: AgentDefinitionRevision;
  message: ConversationMessage;
  /** The Conversation's initial Requirement revision (one leaf) and the deterministic completion criterion the Run declares on it. */
  completion: { revision: RequirementRevision; requirementId: RequirementId; criterionId: AcceptanceCriterionId };
}

/** The persistence-harness view of a runtime seed, for the persistence fixtures that build Gates and Completion Requests. */
export function asSeeded(seed: RuntimeSeed): Seeded {
  const run = seed.created.run;
  return { workspace: { id: run.workspaceId } as never, conversation: { id: run.conversationId } as never, run, definition: seed.orchestrator, evaluator: seed.evaluator, root: seed.created.root };
}

/** An open `run_completion` Gate (with its `verifying` Completion Request) of a runtime-seeded Run; see `seedRunCompletionGate`. */
export function seedRunCompletionGateFor(h: RuntimeHarness, seed: RuntimeSeed, overrides: Parameters<typeof seedRunCompletionGate>[2] = {}) {
  return seedRunCompletionGate(h, asSeeded(seed), overrides);
}

/** A one-leaf Requirement revision with one deterministic criterion: what a coding Run must declare for its run_completion Gate at creation. */
export function seedCompletionCriterion(h: Pick<Harness, "ctx" | "stores">, conversationId: ConversationId, command = "npm test"): RuntimeSeed["completion"] {
  const requirementId = h.ctx.ids("requirement");
  const revision = h.stores.requirements.createRevision({ conversationId, approvedByDecisionId: null, tree: [{ id: requirementId, parentId: null, composition: null, statement: "The change builds and its tests pass", position: 0, acceptanceCriterionIds: [] }] });
  const criterion = h.stores.requirements.createAcceptanceCriterion({ conversationId, requirementId, requirementRevisionId: revision.id, taskId: null, check: { kind: "deterministic", command, expectedExitCode: 0 } });
  return { revision, requirementId, criterionId: criterion.id };
}

/**
 * Workspace, Conversation, Orchestrator, worker, and Gate Evaluator definitions, the Conversation's initial Requirement
 * revision with the deterministic completion criterion a coding Run declares, a created Run whose verification policy
 * names the Evaluator and that criterion, and the operator's opening message.
 */
/** Run creation overrides for a seed: the verification policy is merged over the seed's defaults; `completionCommands` adds further deterministic completion criteria on the seeded leaf. */
export type RuntimeSeedOverrides = Omit<Partial<RunCreationRequest>, "verificationPolicy"> & { verificationPolicy?: Partial<RunVerificationRequest>; completionCommands?: string[] };

export function seedRuntime(h: RuntimeHarness, overrides: RuntimeSeedOverrides = {}): RuntimeSeed {
  const workspace = h.stores.workspaces.create({ name: "demo", rootPath: `/tmp/demo-${h.ctx.ids("workspace")}`, kind: "git" });
  const conversation = h.stores.conversations.create({ workspaceId: workspace.id, title: "demo" });
  const orchestrator = seedAgentRevision(h, "orchestrator");
  const worker = seedAgentRevision(h, "worker");
  const evaluator = seedReadOnlyWorker(h, "evaluator");
  const completion = seedCompletionCriterion(h, conversation.id);
  const { verificationPolicy, completionCommands, ...rest } = overrides;
  const extraCriterionIds = (completionCommands ?? []).map(
    (command) => h.stores.requirements.createAcceptanceCriterion({ conversationId: conversation.id, requirementId: completion.requirementId, requirementRevisionId: completion.revision.id, taskId: null, check: { kind: "deterministic", command, expectedExitCode: 0 } }).id,
  );
  const created = h.runCreation.create({
    conversationId: conversation.id,
    kind: "code",
    target: { kind: "branch", branch: "main" },
    budget: DEFAULT_BUDGET,
    orchestratorAgentDefinitionRevisionId: orchestrator.id,
    verificationPolicy: { evaluatorAgentDefinitionRevisionId: evaluator.id, runCompletionAcceptanceCriterionIds: [completion.criterionId, ...extraCriterionIds].sort(), ...verificationPolicy },
    ...rest,
  });
  const message = h.stores.conversations.postMessage({ conversationId: conversation.id, author: "operator", content: "Add a --version flag to the CLI.", runId: created.run.id, invocationId: null });
  return { created, orchestrator, worker, evaluator, message, completion };
}

/** Starts the seeded Run: root running, Run running, first Orchestrator Invocation prepared. */
export function startRun(h: RuntimeHarness, seed: RuntimeSeed) {
  return h.runStart.start({ runId: seed.created.run.id, conversationMessageId: seed.message.id });
}

/** A seeded Run whose first Orchestrator Invocation has completed, so a plan proposal has an authorizing Invocation. */
export function seedPlanningRuntime(h: RuntimeHarness, overrides: RuntimeSeedOverrides = {}): RuntimeSeed & { invocation: Invocation } {
  const seed = seedRuntime(h, overrides);
  const started = startRun(h, seed);
  return { ...seed, invocation: started.prepared.invocation };
}

export function propose(h: RuntimeHarness, seed: RuntimeSeed & { invocation: Invocation }, expressions: PlanExpression[], options: { correlationId?: string; causationSeq?: number } = {}): PlanRevisionOutcome {
  return h.planRevisions.propose({
    runId: seed.created.run.id,
    proposedByInvocationId: seed.invocation.id,
    source: { version: 1, expressions },
    correlationId: options.correlationId ?? null,
    causationSeq: options.causationSeq ?? null,
  });
}

export function accepted(outcome: PlanRevisionOutcome): Extract<PlanRevisionOutcome, { accepted: true }> {
  if (!outcome.accepted) throw new Error(`rejected: ${outcome.reasons.map((r) => `${r.code}: ${r.message}`).join("; ")}`);
  return outcome;
}

export function rejected(outcome: PlanRevisionOutcome): Extract<PlanRevisionOutcome, { accepted: false }> {
  if (outcome.accepted) throw new Error("expected a rejection");
  return outcome;
}

/** A worker revision that declares only the read tool: its Invocations are read-only and produce no Changeset. */
export function seedReadOnlyWorker(h: RuntimeHarness, name = "reader"): AgentDefinitionRevision {
  const definition = h.stores.agents.ensureDefinition(name);
  return h.stores.agents.appendRevision(definition.id, {
    provenance: { kind: "builtin" },
    modelPolicy: { model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8 },
    instructions: `You are the ${name}.`,
    capabilities: { tools: ["read"], mcpServers: [] },
    toolPolicy: { read: "allowed" },
    defaultLimits: { allocation: INVOCATION_ALLOCATION, maxWallClockMs: 600_000 },
  });
}

/** Proposes a plan from the seeded Orchestrator Invocation and returns the accepted graph's non-root nodes in membership order. */
export function planNodes(h: RuntimeHarness, seed: RuntimeSeed & { invocation: Invocation }, expressions: PlanExpression[]) {
  const outcome = accepted(propose(h, seed, expressions));
  return { outcome, nodes: outcome.graph.nodes.slice(1), revisionNumber: outcome.revision.number };
}

export const COMPLETED_RESULT = { status: "completed" as const, artifactIds: [] as string[], tasks: [] as never[], evidence: [] as never[], summary: "done", openItems: [] as string[], blocker: null, runOutcome: null, routeSelection: null, evaluation: null, finalReport: null };

export { INVOCATION_ALLOCATION };
