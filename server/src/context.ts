import type { Config } from "./config.ts";
import type { Db } from "./db/client.ts";
import type { EventBus } from "./events/bus.ts";
import type { InteractionService } from "./orchestrator/interactions.ts";
import type { OrchestratorRunner } from "./orchestrator/runner.ts";
import type { UserSessionService } from "./sessions/service.ts";
import type { WorkspaceService } from "./workspaces/service.ts";

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Everything the HTTP layer needs. Later milestones extend this with
 * services (agent-session host, tasks).
 */
export interface AppContext {
  config: Config;
  db: Db;
  bus: EventBus;
  log: Logger;
  workspaces: WorkspaceService;
  userSessions: UserSessionService;
  runner: OrchestratorRunner;
  interactions: InteractionService;
}
