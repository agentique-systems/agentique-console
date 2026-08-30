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
  type AgentDefinitionRevision,
  type ConversationMessage,
  type Invocation,
  type PlanExpression,
  type PlanLimits,
  type SnapshotIdentity,
} from "@agentique-console/core";
import { sha256Hex } from "../persistence/blob-store.ts";
import { DEFAULT_BUDGET, INVOCATION_ALLOCATION, openHarness, seedAgentRevision, type Harness } from "../persistence/test-support.ts";
import { MemoryContinuationPayloadStore } from "../provider/continuation-store.ts";
import { ContinuationService } from "../provider/continuation.ts";
import { ScriptedProvider } from "../provider/fake.ts";
import type { TransientOutput } from "../provider/adapter.ts";
import { AttemptExecutor, DEFAULT_EXECUTOR_CONFIG, type AttemptExecutorConfig } from "./attempt-executor.ts";
import { ResourceGovernor, type GovernorConfig } from "./governor.ts";
import { InvocationPreparationService } from "./invocation-preparation-service.ts";
import { PlanRevisionService, type PlanRevisionOutcome } from "./plan-revision-service.ts";
import { HandoffRouter } from "./handoff-routing.ts";
import { ChangesetIntegrationService } from "./integration-service.ts";
import type { CollectedChangeset, ExecutionWorkspacePort, ExecutionWorkspaceRequest, PreparedExecutionWorkspace } from "./ports/execution-workspace.ts";
import type { IntegrationApplyOutcome, IntegrationApplyRequest, IntegrationWorkspacePort } from "./ports/integration-workspace.ts";
import { createPatternRunners, type PatternRunners } from "./patterns/index.ts";
import { RunScheduler, type SchedulerConfig } from "./scheduler.ts";
import type { PreparedRunWorkspace, RunWorkspacePreparationPort, RunWorkspacePreparationRequest } from "./ports/workspace-preparation.ts";
import { RecoveryService } from "./recovery-service.ts";
import { RunCreationService, type CreatedRun, type RunCreationPolicy, type RunCreationRequest } from "./run-creation-service.ts";
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

export const TEST_POLICY: RunCreationPolicy = {
  initialOrchestratorAllocation: { costUsd: 10, tokens: 100_000, attempts: 5 },
  finalReserve: { code: { costUsd: 5, tokens: 50_000, attempts: 3 }, other: { costUsd: 0, tokens: 0, attempts: 0 } },
};

export const TEST_NODE_ALLOCATION = { costUsd: 4, tokens: 40_000, attempts: 2 };

export const TEST_GOVERNOR: GovernorConfig = { providers: { fake: { maxConcurrency: 2 } }, maxProcessConcurrency: 3, maxWorktrees: null };

export const TEST_EXECUTOR_CONFIG: AttemptExecutorConfig = { retry: { backoffBaseMs: 1_000, backoffMaxMs: 8_000 }, continuation: DEFAULT_EXECUTOR_CONFIG.continuation };

export interface RuntimeHarness extends Harness {
  workspacePreparation: FakeWorkspacePreparation;
  executionWorkspace: FakeExecutionWorkspace;
  integrationWorkspace: FakeIntegrationWorkspace;
  integration: ChangesetIntegrationService;
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
  const executor = new AttemptExecutor(h.ctx, h.stores, provider, continuations, governor, executionWorkspace, executorConfig, (chunk) => transient.push(chunk), diagnostics);
  const integration = new ChangesetIntegrationService(h.ctx, h.stores, integrationWorkspace);
  const runners = createPatternRunners({ ctx: h.ctx, stores: h.stores, executor, preparation, integration, governor, provider });
  return {
    ...h,
    workspacePreparation,
    executionWorkspace,
    integrationWorkspace,
    integration,
    handoffs: new HandoffRouter(h.stores),
    runners,
    scheduler: new RunScheduler(h.ctx, h.stores, executor, governor, runners, provider, options.scheduler),
    provider,
    payloads,
    continuations,
    governor,
    runCreation: new RunCreationService(h.ctx, h.stores, workspacePreparation, TEST_POLICY),
    planRevisions: new PlanRevisionService(h.ctx, h.stores, {
      defaults: { nodeAllocation: TEST_NODE_ALLOCATION, coordinatorWorkerBounds: { maxTasks: 8, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 } },
      limits: options.limits ?? DEFAULT_PLAN_LIMITS,
    }),
    preparation,
    executor,
    recovery: new RecoveryService(h.ctx, h.stores, governor, continuations, provider, cleanup, executorConfig),
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
  message: ConversationMessage;
}

/** Workspace, Conversation, Orchestrator and worker definitions, a created Run, and the operator's opening message. */
export function seedRuntime(h: RuntimeHarness, overrides: Partial<RunCreationRequest> = {}): RuntimeSeed {
  const workspace = h.stores.workspaces.create({ name: "demo", rootPath: `/tmp/demo-${h.ctx.ids("workspace")}`, kind: "git" });
  const conversation = h.stores.conversations.create({ workspaceId: workspace.id, title: "demo" });
  const orchestrator = seedAgentRevision(h, "orchestrator");
  const worker = seedAgentRevision(h, "worker");
  const created = h.runCreation.create({
    conversationId: conversation.id,
    kind: "code",
    target: { kind: "branch", branch: "main" },
    budget: DEFAULT_BUDGET,
    orchestratorAgentDefinitionRevisionId: orchestrator.id,
    ...overrides,
  });
  const message = h.stores.conversations.postMessage({ conversationId: conversation.id, author: "operator", content: "Add a --version flag to the CLI.", runId: created.run.id, invocationId: null });
  return { created, orchestrator, worker, message };
}

/** Starts the seeded Run: root running, Run running, first Orchestrator Invocation prepared. */
export function startRun(h: RuntimeHarness, seed: RuntimeSeed) {
  return h.runStart.start({ runId: seed.created.run.id, conversationMessageId: seed.message.id });
}

/** A seeded Run whose first Orchestrator Invocation has completed, so a plan proposal has an authorizing Invocation. */
export function seedPlanningRuntime(h: RuntimeHarness, overrides: Partial<RunCreationRequest> = {}): RuntimeSeed & { invocation: Invocation } {
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

export const COMPLETED_RESULT = { status: "completed" as const, artifactIds: [] as string[], tasks: [] as never[], evidence: [] as never[], summary: "done", openItems: [] as string[], blocker: null, runOutcome: null, routeSelection: null };

export { INVOCATION_ALLOCATION };
