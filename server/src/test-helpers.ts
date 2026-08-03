/** Shared test harness: in-memory DB + bus + runner over a scripted fake SDK. */
import type { ConsoleEvent } from "@agentique-console/shared";
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
import { fakeSdk, type FakeProgram, type FakeSdk } from "./sdk/fake.ts";
import { SqliteSessionStore } from "./sdk/session-store.ts";

export interface Harness {
  db: ReturnType<typeof openDb>["db"];
  sqlite: ReturnType<typeof openDb>["sqlite"];
  bus: EventBus;
  repo: Repo;
  interactions: InteractionService;
  sessionStore: SqliteSessionStore;
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
  const sessionStore = new SqliteSessionStore(db);
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
    sessionStore,
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
    sessionStore,
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
