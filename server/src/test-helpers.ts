/** Shared test harness: the REAL composition root over an in-memory DB and a scripted fake SDK. */
import type { ConsoleEvent } from "@agentique-console/shared";
import type { AgentSessionService } from "./agent-sessions/host.ts";
import { createApp, type App, type CreateAppOptions } from "./app.ts";
import { bootApp, type BootReport } from "./boot.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDb } from "./db/client.ts";
import { Repo, type UserSessionRow } from "./db/repo.ts";
import { workspaces } from "./db/schema.ts";
import { EventBus } from "./events/bus.ts";
import { newId, nowIso } from "./ids.ts";
import type { RunCompletionService } from "./completion/service.ts";
import { DecisionLedger } from "./orchestrator/decisions.ts";
import { InteractionService } from "./orchestrator/interactions.ts";
import { OrchestratorRunner } from "./orchestrator/runner.ts";
import { fakeSdk, type FakeProgram, type FakeSdk } from "./sdk/fake.ts";
import { HandoffService } from "./handoffs/service.ts";
import type { TaskService } from "./tasks/service.ts";

export interface HarnessOptions {
  /** Deep-merged over `loadConfig({})` (which already gets a 25ms quiet window). */
  config?: { infra?: Partial<Config["infra"]>; policy?: Partial<Config["policy"]> };
  /** OS-capability injection; the harness default is explicit absence. */
  runtime?: CreateAppOptions["runtime"];
  /** The workspace row's root path; defaults to /tmp/test-workspace. */
  workspaceRoot?: string;
}

export interface Harness {
  app: App;
  db: ReturnType<typeof openDb>["db"];
  sqlite: ReturnType<typeof openDb>["sqlite"];
  bus: EventBus;
  repo: Repo;
  interactions: InteractionService;
  decisions: DecisionLedger;
  runner: OrchestratorRunner;
  host: AgentSessionService;
  completion: RunCompletionService;
  tasks: TaskService;
  handoffs: HandoffService;
  fake: FakeSdk;
  config: Config;
  workspaceId: string;
  /** Inserts an open user session row and returns its id. */
  addUserSession(mode?: "execute" | "plan_execute"): string;
}

export type DelegationHarness = Harness;

export function makeHarness(program: FakeProgram, options: HarnessOptions = {}): Harness {
  const { db, sqlite } = openDb(":memory:");
  const fake = fakeSdk(program);
  const base = loadConfig({});
  const config: Config = {
    infra: { ...base.infra, ...options.config?.infra },
    // The real window is 2s; tests would otherwise pay it on every case.
    policy: { ...base.policy, completionQuietWindowMs: 25, ...options.config?.policy },
  };
  const workspaceRoot = options.workspaceRoot ?? "/tmp/test-workspace";

  const app = createApp({
    config,
    db,
    sqlite,
    sdk: async () => fake.sdk,
    runtime: { processes: null, browsers: null, worktrees: null, ...options.runtime },
  });

  const workspaceId = newId("ws");
  db.insert(workspaces)
    .values({
      id: workspaceId,
      name: "test",
      rootPath: workspaceRoot,
      metadata: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();

  return {
    app,
    db,
    sqlite,
    bus: app.bus,
    repo: app.repo,
    interactions: app.interactions,
    decisions: app.decisions,
    runner: app.runner,
    host: app.host,
    completion: app.completion,
    tasks: app.tasks,
    handoffs: app.handoffs,
    fake,
    config,
    workspaceId,
    addUserSession(mode = "execute") {
      const row: UserSessionRow = {
        id: newId("us"),
        workspaceId,
        title: "test session",
        mode,
        phase: mode === "plan_execute" ? "planning" : "executing",
        lifecycle: "open",
        purpose: "work",
        subjectKey: null,
        sdkSessionId: null,
        sdkGeneration: 0,
        sdkTurnCount: 0,
        contextTokens: 0,
        memory: "",
        latestHandoffId: null,
        cumulativeCostUsd: 0,
        cumulativeApiDurationMs: 0,
        runState: "active",
        runBaseCommit: null,
        model: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      app.repo.insertUserSession(row);
      return row.id;
    },
  };
}

/** Same harness; the name marks tests that exercise host↔runner delegation. */
export const makeDelegationHarness = makeHarness;

/**
 * A restart: a fresh app over the same database and fake SDK, then the real
 * boot sequence — in-memory pending state is lost exactly as when the process
 * dies, and recovery runs the same path production takes. The report says what
 * boot found.
 */
export async function restartHarness(
  harness: Harness,
  options: HarnessOptions = {},
): Promise<Harness & { bootReport: BootReport }> {
  const config: Config = {
    infra: { ...harness.config.infra, ...options.config?.infra },
    policy: { ...harness.config.policy, ...options.config?.policy },
  };
  const app = createApp({
    config,
    db: harness.db,
    sqlite: harness.sqlite,
    sdk: async () => harness.fake.sdk,
    runtime: { processes: null, browsers: null, worktrees: null, ...options.runtime },
  });
  const bootReport = await bootApp(app);
  return {
    ...harness,
    app,
    config,
    bus: app.bus,
    repo: app.repo,
    interactions: app.interactions,
    decisions: app.decisions,
    runner: app.runner,
    host: app.host,
    completion: app.completion,
    tasks: app.tasks,
    handoffs: app.handoffs,
    bootReport,
  };
}

/** Runs the real boot sequence over an existing harness and returns its report. */
export async function bootHarness(harness: Harness): Promise<BootReport> {
  return bootApp(harness.app);
}

/**
 * The console-owned agent identity a spawn carried in its env (host.#spawnSeat).
 * Fake programs receive the spawn options as their first argument, so this is
 * the role discriminator — prompt-text sniffing is the legacy alternative.
 */
export function agentRoleOf(options: { env?: Record<string, string | undefined> } | undefined): {
  agentSessionId?: string; agent?: string; role?: string; pattern?: string; depth?: number;
} {
  const env = options?.env ?? {};
  return {
    ...(env.CONSOLE_AGENT_SESSION_ID !== undefined ? { agentSessionId: env.CONSOLE_AGENT_SESSION_ID } : {}),
    ...(env.CONSOLE_AGENT_NAME !== undefined ? { agent: env.CONSOLE_AGENT_NAME } : {}),
    ...(env.CONSOLE_PATTERN_ROLE !== undefined ? { role: env.CONSOLE_PATTERN_ROLE } : {}),
    ...(env.CONSOLE_PATTERN !== undefined ? { pattern: env.CONSOLE_PATTERN } : {}),
    ...(env.CONSOLE_SESSION_DEPTH !== undefined ? { depth: Number(env.CONSOLE_SESSION_DEPTH) } : {}),
  };
}

/**
 * Follows the bus from seq 1 and resolves with every event seen up to and
 * including the first one matching `predicate`. Includes transient frames.
 */
export async function collectUntil(
  bus: EventBus,
  predicate: (event: ConsoleEvent) => boolean,
  timeoutMs = 5000,
): Promise<ConsoleEvent[]> {
  const seen: ConsoleEvent[] = [];
  const source = bus.readWithSeq({ fromSeq: 1, follow: true });
  const iterator = source[Symbol.asyncIterator]();
  const timer = setTimeout(() => void iterator.return?.(), timeoutMs);
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        throw new Error(
          `collectUntil timed out; saw: ${seen.map((e) => e.type).join(", ")}`,
        );
      }
      seen.push(next.value);
      if (predicate(next.value)) return seen;
    }
  } finally {
    clearTimeout(timer);
    await iterator.return?.().catch(() => undefined);
  }
}
