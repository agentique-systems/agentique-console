/**
 * The HTTP server over the one route table (core `API_ROUTES`): every route
 * registered from the contract with its handler, one error envelope, the
 * standard 404 for anything else under `/api` (legacy paths included, with
 * no redirect and no hint), bounded bodies, and the built web application
 * served beside the API when present.
 */
import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import { API_BODY_MAX_BYTES, API_ROUTES, STANDARD_NOT_FOUND, type ApiRouteName } from "@agentique-console/core";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { ApiError, toApiError } from "./errors.ts";
import { handleEvents } from "./events.ts";
import { routeHandlers } from "./routes/index.ts";

/** Every route the server registered, as `METHOD path`: what the contract test compares against the route table. */
export interface RegisteredRoutes {
  registeredRoutes: string[];
}

export function buildServer(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: API_BODY_MAX_BYTES });
  const registered: string[] = [];
  app.decorate("registeredRoutes", registered);
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) if (method !== "HEAD") registered.push(`${method} ${route.url}`);
  });

  // The serialized response bound (core `API_RESPONSE_MAX_BYTES`): a JSON body that would exceed it is refused as `payload_too_large`,
  // never truncated — the aggregate routes keep their nested histories windowed and counted so this stays a last resort.
  app.addHook("onSend", async (_request, reply, payload) => {
    if (typeof payload !== "string" || reply.statusCode >= 400) return payload;
    const type = String(reply.getHeader("content-type") ?? "");
    if (!type.includes("application/json")) return payload;
    const bytes = Buffer.byteLength(payload);
    if (bytes <= ctx.app.limits.responseMaxBytes) return payload;
    void reply.status(413);
    return JSON.stringify(new ApiError("payload_too_large", `the response (${bytes} bytes) exceeds the bound of ${ctx.app.limits.responseMaxBytes} bytes; page the collection`, { field: "response" }).body());
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    const api = toApiError(error);
    if (api) {
      void reply.status(api.status).send(api.body());
      return;
    }
    const fastifyError = error as { code?: string; statusCode?: number; message?: string };
    if (fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE" || fastifyError.statusCode === 413) {
      void reply.status(413).send(new ApiError("payload_too_large", "the request body exceeds the bound").body());
      return;
    }
    if (typeof fastifyError.statusCode === "number" && fastifyError.statusCode < 500) {
      void reply.status(400).send(new ApiError("bad_request", fastifyError.message ?? "bad request").body());
      return;
    }
    ctx.log.error(error);
    void reply.status(500).send(new ApiError("internal", "internal error").body());
  });

  for (const name of Object.keys(API_ROUTES) as ApiRouteName[]) {
    const route = API_ROUTES[name];
    if (name === "events") {
      app.get(route.path, (request, reply) => handleEvents(request, reply, ctx));
      continue;
    }
    const handler = routeHandlers[name];
    app.route({
      method: route.method,
      url: route.path,
      handler: async (request, reply) => {
        const result = await handler({ params: request.params as Record<string, string>, query: request.query as Record<string, unknown>, body: request.body, raw: request, reply }, ctx);
        // A byte route already sent its reply.
        if (result === reply || reply.sent) return reply;
        return result;
      },
    });
  }

  // The built web application rides on this port; in development the vite server proxies /api here instead.
  const hasWeb = existsSync(ctx.app.config.webDir);
  if (hasWeb) void app.register(fastifyStatic, { root: ctx.app.config.webDir, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api") || !hasWeb) return reply.status(404).send(STANDARD_NOT_FOUND);
    return reply.sendFile("index.html");
  });

  return app;
}
