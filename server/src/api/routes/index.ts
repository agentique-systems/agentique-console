/**
 * Every route of the contract has exactly one handler here; the type
 * requires a handler per `ApiRouteName`, so an operation added to
 * `core/src/api.ts` without a handler does not compile, and the route test
 * proves the reverse (nothing served outside the contract).
 */
import { conversationRoutes } from "./conversations.ts";
import { recordRoutes } from "./records.ts";
import { runRoutes } from "./runs.ts";
import type { RouteHandlers } from "./support.ts";
import { systemRoutes } from "./system.ts";
import { workspaceRoutes } from "./workspaces.ts";

/** The event stream is registered separately: it hijacks the reply and streams. */
export type RestRouteHandlers = Omit<RouteHandlers, "events">;

export const routeHandlers: RestRouteHandlers = {
  ...systemRoutes,
  ...workspaceRoutes,
  ...conversationRoutes,
  ...runRoutes,
  ...recordRoutes,
};

export type { RouteHandler, RouteHandlers, RouteRequest } from "./support.ts";
