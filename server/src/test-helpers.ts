/** Shared test harness: in-memory DB + bus + runner over a scripted fake SDK. */
import type { ConsoleEvent } from "@agentique-console/shared";
import type {
  AgentSessionHost,
  AgentSessionHostDeps,
} from "./agent-sessions/host.ts";
import { createApp, type App } from "./app.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDb } from "./db/client.ts";
import { Repo, type UserSessionRow } from "./db/repo.ts";
import { workspaces } from "./db/schema.ts";
import { EventBus } from "./events/bus.ts";
import { newId, nowIso } from "./ids.ts";
import type { RunCompletionService } from "./completion/service.ts";
import { ContractService } from "./contracts/service.ts";
import { DecisionLedger } from "./orchestrator/decisions.ts";
import { InteractionService } from "./orchestrator/interactions.ts";
import {
  OrchestratorRunner,
  type OrchestratorDeps,
} from "./orchestrator/runner.ts";
import { fakeSdk, type FakeProgram, type FakeSdk } from "./sdk/fake.ts";
import { AgentProfileRegistry } from "./agent-profiles/registry.ts";
import { HandoffService } from "./handoffs/service.ts";
import type { TaskService } from "./tasks/service.ts";

export interface Harness {
  db: ReturnType<typeof openDb>["db"];
  sqlite: ReturnType<typeof openDb>["sqlite"];
  bus: EventBus;
  repo: Repo;
  interactions: InteractionService;
  decisions: DecisionLedger;
  contracts: ContractService;
  runner: OrchestratorRunner;
  fake: FakeSdk;
  config: Config;
  workspaceId: string;
  /** Inserts an open user session row and returns its id. */
  addUserSession(mode?: "execute" | "plan_execute"): string;
}

export function makeHarness(
  program: FakeProgram,
  overrides: Partial<OrchestratorDeps> = {},
): Harness {
  const { db, sqlite } = openDb(":memory:");
  const bus = new EventBus(db);
  const repo = new Repo(db, sqlite);
  const decisions = new DecisionLedger(db);
  const contracts = new ContractService(db, bus);
  const interactions = new InteractionService(db, bus);
  const fake = fakeSdk(program);
  const config = loadConfig({});
  const handoffs = new HandoffService({ repo, bus, getWorkspaceRoot: () => "/tmp/test-workspace" });

  const workspaceId = newId("ws");
  db.insert(workspaces)
    .values({
      id: workspaceId,
      name: "test",
      rootPath: "/tmp/test-workspace",
      metadata: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();

  const runner = new OrchestratorRunner({
    repo,
    bus,
    config,
    sdk: async () => fake.sdk,
    interactions,
    decisions,
    handoffs,
    getWorkspaceRoot: () => "/tmp/test-workspace",
    ...overrides,
  });

  return {
    db,
    sqlite,
    bus,
    repo,
    interactions,
    decisions,
    contracts,
    runner,
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
        status: "open",
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
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      repo.insertUserSession(row);
      return row.id;
    },
  };
}

export interface DelegationHarness extends Harness {
  host: AgentSessionHost;
  completion: RunCompletionService;
  tasks: TaskService;
  handoffs: HandoffService;
}

/**
 * The full wiring (main.ts in miniature): runner with the console MCP server,
 * host waking the runner.
 */
export function makeDelegationHarness(
  program: FakeProgram,
  options: {
    hostOverrides?: Partial<AgentSessionHostDeps>;
  } = {},
): DelegationHarness {
  const base = makeHarness(program);
  return { ...base, ...wire(base, options) };
}

/**
 * A restart: fresh host and runner over the same database and fake SDK. Any
 * turn the old pair had in flight is gone, exactly as it would be after the
 * process died — which is what recovery has to cope with.
 */
export function restartHarness(
  harness: DelegationHarness,
  options: { hostOverrides?: Partial<AgentSessionHostDeps> } = {},
): DelegationHarness {
  return { ...harness, ...wire(harness, options) };
}

/**
 * The REAL composition root over the test doubles: a fresh call is a process
 * restart (in-memory pending state is lost, exactly as in production), and any
 * service wired in `createApp` is wired here by construction.
 */
function wire(
  base: Harness,
  options: { hostOverrides?: Partial<AgentSessionHostDeps> },
): App {
  return createApp({
    config: base.config,
    db: base.db,
    bus: base.bus,
    repo: base.repo,
    sdk: async () => base.fake.sdk,
    getWorkspaceRoot: () => "/tmp/test-workspace",
    profiles: new AgentProfileRegistry("/tmp/agentique-console-test-profiles-missing.json"),
    // The real window is 2s; tests would otherwise pay it on every case.
    quietWindowMs: 25,
    ...(options.hostOverrides ? { hostOverrides: options.hostOverrides } : {}),
  });
}

/**
 * The console-owned seat identity a spawn carried in its env (host.#spawnSeat).
 * Fake programs receive the spawn options as their first argument, so this is
 * the role discriminator — prompt-text sniffing is the legacy alternative.
 */
export function seatRoleOf(options: { env?: Record<string, string | undefined> } | undefined): {
  agentSessionId?: string; seat?: string; role?: string; pattern?: string; depth?: number;
} {
  const env = options?.env ?? {};
  return {
    ...(env.CONSOLE_AGENT_SESSION_ID !== undefined ? { agentSessionId: env.CONSOLE_AGENT_SESSION_ID } : {}),
    ...(env.CONSOLE_SEAT_NAME !== undefined ? { seat: env.CONSOLE_SEAT_NAME } : {}),
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
