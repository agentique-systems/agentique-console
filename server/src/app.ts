/**
 * The single composition root, shared by production (`main.ts`), the HTTP
 * tests, and the verification entrypoints: the clean-break runtime over the
 * configured directories (`composeConsoleRuntime`), the host driver of the
 * one scheduler, the one event stream, the admission gate, the operator
 * services (Workspaces, Run launch), bounded diagnostics, and the HTTP
 * server over the one route table. Boot side effects live in `boot.ts`;
 * process signals in `main.ts`.
 */
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { addAllocation, ZERO_ALLOCATION, type Allocation, type Timestamp } from "@agentique-console/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./api/server.ts";
import { composeConsoleRuntime, DEFAULT_PLANNING_CONFIG, type ConsoleRuntime } from "./composition/console-runtime.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./context.ts";
import { type SseOptions } from "./api/events.ts";
import { EventStream } from "./events/stream.ts";
import type { ExecutionDiagnostic } from "./execution/workspace-cleanup.ts";
import type { RecoveryReport } from "./execution/recovery-service.ts";
import { AdmissionGate } from "./host/admission.ts";
import { RunHost, type RunHostDiagnostic } from "./host/run-host.ts";
import { RunLaunchService } from "./operator/run-launch.ts";
import { WorkspaceService } from "./operator/workspaces.ts";
import type { PersistenceDiagnostic } from "./persistence/context.ts";
import type { ClaudeSdk } from "./provider/claude-sdk.ts";
import type { PublicationHooks } from "./workspace-state/index.ts";

export interface CreateAppOptions {
  config: Config;
  /** The provider SDK: the real binding in production, a fixture in tests. */
  sdk: ClaudeSdk;
  clock?: () => Timestamp;
  log?: Logger;
  /** Test barriers of the publication port; production passes none. */
  publicationHooks?: PublicationHooks;
  /** The event stream's outbound bounds (the buffer bound, the heartbeat); tests lower them to reach backpressure deterministically. */
  events?: SseOptions;
}

export type AppDiagnostic = { at: Timestamp; source: "persistence"; diagnostic: PersistenceDiagnostic } | { at: Timestamp; source: "execution"; diagnostic: ExecutionDiagnostic } | { at: Timestamp; source: "host"; diagnostic: RunHostDiagnostic };

/** A bounded ring of the most recent diagnostics: the health view reads it; nothing decides from it. */
export class BoundedDiagnostics {
  readonly #entries: AppDiagnostic[] = [];
  #dropped = 0;

  constructor(private readonly capacity: number) {}

  push(entry: AppDiagnostic): void {
    this.#entries.push(entry);
    if (this.#entries.length > this.capacity) {
      this.#entries.splice(0, this.#entries.length - this.capacity);
      this.#dropped += 1;
    }
  }

  list(): readonly AppDiagnostic[] {
    return this.#entries;
  }

  get dropped(): number {
    return this.#dropped;
  }
}

export interface BootReport {
  recovery: RecoveryReport;
  reconstructed: { runs: number; publications: number };
}

export interface App {
  config: Config;
  runtime: ConsoleRuntime;
  host: RunHost;
  events: EventStream;
  /** The bounds `GET /api/events` subscriptions run with. */
  eventStreamOptions: SseOptions;
  admission: AdmissionGate;
  workspaces: WorkspaceService;
  launch: RunLaunchService;
  diagnostics: BoundedDiagnostics;
  log: Logger;
  server: FastifyInstance;
  startedAt: Timestamp;
  /** The startup report, once `bootApp` ran. */
  boot: BootReport | null;
  /** Releases everything the app holds (after `shutdownApp`, or for a test that never booted). */
  close(): Promise<void>;
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function mcpCatalog(config: Config): Record<string, McpServerConfig> {
  const catalog: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(config.provider.mcpServers)) catalog[name] = { type: "stdio", command: server.command, args: server.args };
  return catalog;
}

/** Composes the application graph over the configuration; opens the database (a legacy database is refused here). */
export function createApp(options: CreateAppOptions): App {
  const { config } = options;
  const log = options.log ?? silent;
  const clock = options.clock ?? (() => new Date().toISOString() as Timestamp);
  const diagnostics = new BoundedDiagnostics(config.driver.diagnosticsRetained);
  const workerAllocation: Allocation = config.defaults.nodeAllocation;
  const runtime = composeConsoleRuntime({
    databaseFile: config.databaseFile,
    blobRoot: config.blobRoot,
    continuations: { root: config.continuationRoot, ttlMs: config.provider.continuationTtlMs },
    stateRoot: config.stateRoot,
    provider: { sdk: options.sdk, continuation: config.provider.continuation, mcpServers: mcpCatalog(config), fallbackWorkingDirectory: config.dataDir },
    agents: { model: config.provider.model, effort: config.provider.effort, maxContextOccupancy: 0.8, allocation: workerAllocation, orchestratorAllocation: config.defaults.orchestratorAllocation, maxWallClockMs: config.defaults.maxWallClockMs },
    planning: { ...DEFAULT_PLANNING_CONFIG, defaults: { ...DEFAULT_PLANNING_CONFIG.defaults, nodeAllocation: config.defaults.nodeAllocation } },
    runCreation: {
      initialOrchestratorAllocation: config.defaults.orchestratorAllocation,
      // The final reserve of a coding Run funds the completion work: the final synthesis (one Orchestrator allocation) and, with the
      // reviewer as the default Evaluator, one Evaluator allocation — the completion engine's own rule.
      finalReserve: { code: addAllocation(config.defaults.orchestratorAllocation, config.defaults.evaluator === "reviewer" ? workerAllocation : ZERO_ALLOCATION), other: ZERO_ALLOCATION },
      maxNodeGateCycles: 3,
      maxRunCompletionCycles: 3,
    },
    governor: { providers: { claude: { maxConcurrency: config.governor.providerMaxConcurrency } }, maxProcessConcurrency: config.governor.processMaxAttempts, maxWorktrees: config.governor.maxWorktrees },
    checks: { maxOutputBytes: config.checks.maxOutputBytes, commandTimeoutMs: config.checks.commandTimeoutMs },
    clock,
    persistenceDiagnostics: (diagnostic) => {
      diagnostics.push({ at: clock(), source: "persistence", diagnostic });
      log.warn(`[persistence] ${diagnostic.kind}`);
    },
    diagnostics: (diagnostic) => {
      diagnostics.push({ at: clock(), source: "execution", diagnostic });
      log.warn(`[execution] ${diagnostic.kind}`);
    },
    output: (chunk) => events.publishOutput(chunk),
    ...(options.publicationHooks === undefined ? {} : { publicationHooks: options.publicationHooks }),
  });
  const events = new EventStream(runtime.ctx, runtime.stores.invocations, runtime.stores.runs);
  const admission = new AdmissionGate();
  const host = new RunHost(
    { scheduler: runtime.scheduler, publication: runtime.publication, governor: runtime.governor, runs: runtime.stores.runs, publications: runtime.stores.publications, clock },
    {
      maxConcurrentRuns: config.driver.maxConcurrentRuns,
      onDiagnostic: (diagnostic) => {
        diagnostics.push({ at: clock(), source: "host", diagnostic });
        if (diagnostic.kind === "pass_failed") log.warn(`[host] pass failed for ${diagnostic.runId}: ${diagnostic.message}`);
      },
    },
  );
  const workspaces = new WorkspaceService(runtime.stores.workspaces, config.fsRoots.map((root) => root.path));
  const launch = new RunLaunchService(runtime, { budget: config.defaults.budget, orchestratorAllocation: config.defaults.orchestratorAllocation, completionCheck: config.defaults.completionCheck, evaluator: config.defaults.evaluator, runKind: config.defaults.runKind });
  const app: App = {
    config,
    runtime,
    host,
    events,
    eventStreamOptions: options.events ?? {},
    admission,
    workspaces,
    launch,
    diagnostics,
    log,
    server: undefined as unknown as FastifyInstance,
    startedAt: clock(),
    boot: null,
    close: async () => {
      events.close();
      await app.server.close().catch(() => undefined);
      runtime.close();
    },
  };
  app.server = buildServer({ app, log });
  return app;
}
