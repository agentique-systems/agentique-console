/**
 * The production composition of the clean-break runtime (execution-model
 * §13; migration-contract §7): one SQLite database under the migration
 * contract, the file blob store, the canonical stores, the production Claude
 * adapter over the real SDK (or an injected SDK fixture), the six Workspace
 * ports over one state root, Snapshot-pinned Agent Definitions with the
 * built-ins ensured, and every execution service wired exactly as the
 * deterministic harness wires its fakes. Nothing here starts a process
 * loop, an HTTP server, or a timer: a caller (the verification entrypoint,
 * a later API) drives Runs through `advanceRun` and the operator services.
 */
import { DEFAULT_PLAN_LIMITS, EMPTY_WORKSPACE_CAPABILITY_POLICY, type AgentDefinitionRevision, type RunId, type Timestamp, type WorkspaceCapabilityPolicy } from "@agentique-console/core";
import { ensureBuiltinDefinitions, WorkspaceAgentDefinitionLoader, type BuiltinDefinitionDefaults, type BuiltinDefinitionName } from "../agents/index.ts";
import { AcceptanceCheckService, DEFAULT_ACCEPTANCE_CHECK_CONFIG, type AcceptanceCheckConfig } from "../execution/acceptance-checks.ts";
import { AttemptExecutor, DEFAULT_EXECUTOR_CONFIG, type AttemptExecutorConfig } from "../execution/attempt-executor.ts";
import { BudgetIncreaseService } from "../execution/budget-increases.ts";
import type { DecisionRequestService } from "../execution/decision-requests.ts";
import { ResourceGovernor, type GovernorConfig } from "../execution/governor.ts";
import { HandoffRouter } from "../execution/handoff-routing.ts";
import { ChangesetIntegrationService } from "../execution/integration-service.ts";
import { InvocationPreparationService } from "../execution/invocation-preparation-service.ts";
import { OrchestratorInputService } from "../execution/orchestrator-inputs.ts";
import { createPatternRunners, type PatternRunners } from "../execution/patterns/index.ts";
import { PlanNodeCapacity } from "../execution/plan-node-capacity.ts";
import { PlanRevisionService, type PlanRevisionServiceConfig } from "../execution/plan-revision-service.ts";
import { RunPublicationService } from "../execution/publication.ts";
import { RecoveryService } from "../execution/recovery-service.ts";
import { RequirementProposalService } from "../execution/requirement-proposals.ts";
import { RunControlService } from "../execution/run-control.ts";
import { DEFAULT_RUN_CREATION_POLICY, RunCreationService, type RunCreationPolicy } from "../execution/run-creation-service.ts";
import { RunStartService } from "../execution/run-start-service.ts";
import { DEFAULT_SCHEDULER_CONFIG, RunScheduler, type SchedulerConfig, type SchedulerOutcome } from "../execution/scheduler.ts";
import { RunSignoffService } from "../execution/signoff.ts";
import { WorkspaceCleanup, type ExecutionDiagnostic, type ExecutionDiagnosticSink } from "../execution/workspace-cleanup.ts";
import { FileBlobStore, sha256Hex } from "../persistence/blob-store.ts";
import { createPersistenceContext, type PersistenceContext, type PersistenceDiagnostic } from "../persistence/context.ts";
import { openDatabase, type OpenedDatabase } from "../persistence/database.ts";
import { createStores, type Stores } from "../persistence/stores/index.ts";
import type { TransientOutputSink } from "../provider/adapter.ts";
import { ClaudeAgentSdkAdapter, CLAUDE_PROVIDER, type ClaudeAdapterConfig } from "../provider/claude-adapter.ts";
import { ContinuationService } from "../provider/continuation.ts";
import { FileContinuationPayloadStore } from "../provider/continuation-store.ts";
import { createWorkspacePorts, type WorkspacePorts } from "../workspace-state/index.ts";
import type { WorkspaceStateLayout } from "../workspace-state/paths.ts";

export interface ConsoleRuntimeConfig {
  /** The SQLite file of the canonical database (created and migrated under the migration contract). */
  databaseFile: string;
  /** The directory of the Artifact blob store. */
  blobRoot: string;
  /** The directory of provider continuation payloads; `ttlMs` bounds how long a payload stays resumable (`null`: unbounded). */
  continuations: { root: string; ttlMs: number | null };
  /** The Workspace state root: shadow repositories, integration checkouts, worktrees, check views, publication staging. */
  stateRoot: string;
  /** The production provider adapter's configuration; `sdk` is the real binding or an injected fixture. */
  provider: ClaudeAdapterConfig;
  /** The defaults of the built-in and Workspace-file Agent Definitions. */
  agents: BuiltinDefinitionDefaults;
  /** The compiler defaults and limits of Execution Plan revisions. */
  planning?: PlanRevisionServiceConfig;
  runCreation?: RunCreationPolicy;
  governor?: GovernorConfig;
  executor?: AttemptExecutorConfig;
  scheduler?: SchedulerConfig;
  checks?: AcceptanceCheckConfig;
  /** The console-wide Workspace capability policy applied to every Invocation (empty by default). */
  workspacePolicy?: WorkspaceCapabilityPolicy;
  clock?: () => Timestamp;
  /** Persistence diagnostics (blob cleanup, rollback hooks); logged to stderr when omitted. */
  persistenceDiagnostics?: (diagnostic: PersistenceDiagnostic) => void;
  /** Execution diagnostics (Workspace release, publication reports); collected on the runtime when omitted. */
  diagnostics?: ExecutionDiagnosticSink;
  /** Transient provider output; dropped when omitted. */
  output?: TransientOutputSink;
}

export const DEFAULT_CONSOLE_GOVERNOR: Readonly<GovernorConfig> = Object.freeze({ providers: { [CLAUDE_PROVIDER]: { maxConcurrency: 4 } }, maxProcessConcurrency: 6, maxWorktrees: null });

export const DEFAULT_PLANNING_CONFIG: Readonly<PlanRevisionServiceConfig> = Object.freeze({
  defaults: { nodeAllocation: { costUsd: 4, tokens: 400_000, attempts: 4 }, coordinatorWorkerBounds: { maxTasks: 12, maxConcurrentWorkers: 3, maxCoordinatorInvocations: 6 } },
  limits: DEFAULT_PLAN_LIMITS,
});

export interface ConsoleRuntime {
  config: ConsoleRuntimeConfig;
  database: OpenedDatabase;
  ctx: PersistenceContext;
  stores: Stores;
  provider: ClaudeAgentSdkAdapter;
  layout: WorkspaceStateLayout;
  workspace: WorkspacePorts;
  agents: { builtins: Record<BuiltinDefinitionName, AgentDefinitionRevision>; loader: WorkspaceAgentDefinitionLoader };
  continuations: ContinuationService;
  governor: ResourceGovernor;
  preparation: InvocationPreparationService;
  executor: AttemptExecutor;
  integration: ChangesetIntegrationService;
  checks: AcceptanceCheckService;
  capacity: PlanNodeCapacity;
  runners: PatternRunners;
  scheduler: RunScheduler;
  runCreation: RunCreationService;
  runStart: RunStartService;
  planRevisions: PlanRevisionService;
  recovery: RecoveryService;
  runControl: RunControlService;
  budgetIncreases: BudgetIncreaseService;
  decisionRequests: DecisionRequestService;
  signoff: RunSignoffService;
  publication: RunPublicationService;
  requirementProposals: RequirementProposalService;
  orchestratorInputs: OrchestratorInputService;
  handoffs: HandoffRouter;
  cleanup: WorkspaceCleanup;
  /** Every execution diagnostic reported so far (when no sink was configured). */
  diagnostics: ExecutionDiagnostic[];
  close(): void;
}

/** Composes the runtime over the configured directories and database; the built-in Agent Definitions are ensured on open. */
export function composeConsoleRuntime(config: ConsoleRuntimeConfig): ConsoleRuntime {
  const database = openDatabase(config.databaseFile);
  try {
    const blobs = new FileBlobStore(config.blobRoot);
    const ctx = createPersistenceContext(database, blobs, { ...(config.clock === undefined ? {} : { clock: config.clock }), ...(config.persistenceDiagnostics === undefined ? {} : { diagnostics: config.persistenceDiagnostics }) });
    const stores = createStores(ctx, { planLimits: (config.planning ?? DEFAULT_PLANNING_CONFIG).limits });
    const diagnostics: ExecutionDiagnostic[] = [];
    const sink: ExecutionDiagnosticSink = config.diagnostics ?? ((d) => diagnostics.push(d));
    const output: TransientOutputSink = config.output ?? (() => {});
    const provider = new ClaudeAgentSdkAdapter(config.provider);
    const layout: WorkspaceStateLayout = { stateRoot: config.stateRoot };
    const workspace = createWorkspacePorts(layout);
    const builtins = ensureBuiltinDefinitions(stores, config.agents);
    const loader = new WorkspaceAgentDefinitionLoader(ctx, stores, layout, config.agents);
    const payloads = new FileContinuationPayloadStore(config.continuations.root, sha256Hex);
    const continuations = new ContinuationService(stores.continuations, payloads, { ttlMs: config.continuations.ttlMs, clock: ctx.clock });
    const governor = new ResourceGovernor(stores.leases, config.governor ?? DEFAULT_CONSOLE_GOVERNOR, ctx.clock);
    const executorConfig = config.executor ?? DEFAULT_EXECUTOR_CONFIG;
    const preparation = new InvocationPreparationService(ctx, stores, workspace.execution, { workspacePolicy: config.workspacePolicy ?? EMPTY_WORKSPACE_CAPABILITY_POLICY });
    const cleanup = new WorkspaceCleanup(ctx, stores, workspace.execution, sink);
    const planRevisions = new PlanRevisionService(ctx, stores, config.planning ?? DEFAULT_PLANNING_CONFIG);
    const executor = new AttemptExecutor(ctx, stores, provider, continuations, governor, workspace.execution, executorConfig, output, sink, { planRevisions });
    const integration = new ChangesetIntegrationService(ctx, stores, workspace.integration);
    const checks = new AcceptanceCheckService(ctx, stores, workspace.checks, config.checks ?? DEFAULT_ACCEPTANCE_CHECK_CONFIG);
    const capacity = new PlanNodeCapacity(ctx, stores);
    const runners = createPatternRunners({ ctx, stores, executor, preparation, integration, checks, capacity, governor, provider });
    return {
      config,
      database,
      ctx,
      stores,
      provider,
      layout,
      workspace,
      agents: { builtins, loader },
      continuations,
      governor,
      preparation,
      executor,
      integration,
      checks,
      capacity,
      runners,
      scheduler: new RunScheduler(ctx, stores, executor, governor, runners, provider, config.scheduler ?? DEFAULT_SCHEDULER_CONFIG),
      runCreation: new RunCreationService(ctx, stores, workspace.preparation, config.runCreation ?? DEFAULT_RUN_CREATION_POLICY),
      runStart: new RunStartService(ctx, stores, preparation),
      planRevisions,
      recovery: new RecoveryService(ctx, stores, governor, continuations, provider, cleanup, executorConfig),
      runControl: new RunControlService({ ctx, stores, executor }),
      budgetIncreases: new BudgetIncreaseService({ ctx, stores }),
      decisionRequests: runners.decisionRequests,
      signoff: new RunSignoffService({ ctx, stores, preparation, capacity, finalization: workspace.finalization }),
      publication: new RunPublicationService({ ctx, stores, port: workspace.publication, checks, diagnostics: sink }),
      requirementProposals: new RequirementProposalService(ctx, stores),
      orchestratorInputs: new OrchestratorInputService(ctx, stores),
      handoffs: new HandoffRouter(stores),
      cleanup,
      diagnostics,
      close: () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export interface AdvanceOptions {
  /** Stop once this holds (checked before every pass). */
  until?: () => boolean;
  /** The bound on scheduler passes. */
  maxPasses?: number;
  /** Waits for a scheduled resumption time (a retry backoff, a Decision deadline); the real clock by default. */
  sleep?: (ms: number) => Promise<void>;
  /** Observes every pass. */
  onPass?: (pass: SchedulerOutcome) => void;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Drives one Run through repeated scheduler passes until `until` holds, the
 * Run ends, a pass performs nothing and waits on nothing timed (an operator
 * Decision, budget, or signoff), or `maxPasses` elapse. A pass that waits
 * for a resumption time sleeps until then. Returns every pass in order.
 */
export async function advanceRunUntil(runtime: Pick<ConsoleRuntime, "scheduler" | "ctx">, runId: RunId, options: AdvanceOptions = {}): Promise<SchedulerOutcome[]> {
  const passes: SchedulerOutcome[] = [];
  const sleep = options.sleep ?? realSleep;
  for (let i = 0; i < (options.maxPasses ?? 200); i += 1) {
    if (options.until?.() === true) break;
    const pass = await runtime.scheduler.advanceRun(runId);
    passes.push(pass);
    options.onPass?.(pass);
    if (pass.failure !== null) throw new Error(`scheduler pass failed: ${pass.failure.message}`);
    if (pass.stop === "run_terminal" || pass.stop === "infrastructure_failure") break;
    if (pass.actions.length === 0) {
      if (pass.stop === "waiting" && pass.wakeAt !== null) {
        await sleep(Math.max(1, Date.parse(pass.wakeAt) - Date.parse(runtime.ctx.clock())));
        continue;
      }
      break;
    }
  }
  return passes;
}
