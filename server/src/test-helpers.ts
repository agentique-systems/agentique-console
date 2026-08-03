/** Shared test harness: in-memory DB + bus + runner over a scripted fake SDK. */
import type { ConsoleEvent } from "@agentique-console/shared";
import {
  AgentSessionHost,
  type AgentSessionHostDeps,
} from "./agent-sessions/host.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDb } from "./db/client.ts";
import { Repo, type UserSessionRow } from "./db/repo.ts";
import { workspaces } from "./db/schema.ts";
import { EventBus } from "./events/bus.ts";
import { newId, nowIso } from "./ids.ts";
import { InteractionService } from "./orchestrator/interactions.ts";
import {
  OrchestratorRunner,
  type OrchestratorDeps,
} from "./orchestrator/runner.ts";
import { buildConsoleMcpServer } from "./orchestrator/tools.ts";
import { fakeSdk, type FakeProgram, type FakeSdk } from "./sdk/fake.ts";
import { TaskService } from "./tasks/service.ts";

export interface Harness {
  db: ReturnType<typeof openDb>["db"];
  sqlite: ReturnType<typeof openDb>["sqlite"];
  bus: EventBus;
  repo: Repo;
  interactions: InteractionService;
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
  const interactions = new InteractionService(db, bus);
  const fake = fakeSdk(program);
  const config = loadConfig({});

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
    getWorkspaceRoot: () => "/tmp/test-workspace",
    ...overrides,
  });

  return {
    db,
    sqlite,
    bus,
    repo,
    interactions,
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
        sdkSessionId: null,
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

function wire(
  base: Harness,
  options: { hostOverrides?: Partial<AgentSessionHostDeps> },
): { host: AgentSessionHost; runner: OrchestratorRunner } {
  const host = new AgentSessionHost({
    repo: base.repo,
    bus: base.bus,
    ...options.hostOverrides,
  });
  const runner = new OrchestratorRunner({
    repo: base.repo,
    bus: base.bus,
    config: base.config,
    sdk: async () => base.fake.sdk,
    interactions: base.interactions,
    getWorkspaceRoot: () => "/tmp/test-workspace",
    // Mirror main.ts: SubagentStop releases the seat binding, so programs can
    // fire it (fireHook) and exercise the production release path.
    buildHooks: () => ({
      SubagentStop: [
        {
          hooks: [
            async (input: unknown) => {
              const agentId = (input as { agent_id?: unknown }).agent_id;
              if (typeof agentId === "string") host.releaseAgent(agentId);
              return {};
            },
          ],
        },
      ],
    }),
    buildMcpServer: (userSessionId, sdk) =>
      buildConsoleMcpServer({
        sdk,
        host,
        repo: base.repo,
        bus: base.bus,
        userSessionId,
        tasks: new TaskService(base.db, base.bus),
      }),
    seats: {
      spawn: (callId, spawnName, agentSessionId, subagentType) =>
        host.observeAgentSpawn(callId, spawnName, agentSessionId, subagentType),
      launch: (callId, agentId) => host.confirmAgentLaunch(callId, agentId),
      seatOf: (callId) => host.seatOf(callId),
      seatOfAddress: (to) => host.seatOfSpawnAddress(to),
      recordMessage: (input) => host.recordDerivedMessage(input),
    },
  });
  return { host, runner };
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
