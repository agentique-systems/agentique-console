import type { FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import type { Db } from "./db/client.ts";
import type { EventBus } from "./events/bus.ts";

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export type RouteRegistrar = (app: FastifyInstance, ctx: AppContext) => void;

/**
 * Everything the HTTP layer needs. Later milestones extend this with
 * services (workspaces, orchestrator runner, agent-session host, tasks).
 */
export interface AppContext {
  config: Config;
  db: Db;
  bus: EventBus;
  log: Logger;
  /** Route modules registered by later milestones. */
  extraRoutes: RouteRegistrar[];
}
