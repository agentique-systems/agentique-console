import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { ConfigResponse } from "@agentique-console/shared";
import type { AppContext } from "../context.ts";
import { toApiError } from "./errors.ts";
import { registerAgentProfileRoutes } from "./routes/agent-profiles.ts";
import { registerAgentSessionRoutes } from "./routes/agent-sessions.ts";
import { registerComposeRoutes } from "./routes/compose.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerFsRoutes } from "./routes/fs.ts";
import { registerSystemRoutes } from "./routes/system.ts";
import { registerTaskRoutes } from "./routes/tasks.ts";
import { registerUserSessionRoutes } from "./routes/user-sessions.ts";
import { registerWorkspaceRoutes } from "./routes/workspaces.ts";

export function buildServer(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error: unknown, _request, reply) => {
    const api = toApiError(error);
    if (api) {
      void reply
        .status(api.statusCode)
        .send({ error: { code: api.code, message: api.message } });
      return;
    }
    const fastifyError = error as {
      statusCode?: number;
      message?: string;
    };
    if (
      typeof fastifyError.statusCode === "number" &&
      fastifyError.statusCode < 500
    ) {
      void reply.status(fastifyError.statusCode).send({
        error: {
          code: "bad_request",
          message: fastifyError.message ?? "bad request",
        },
      });
      return;
    }
    ctx.log.error(error);
    void reply
      .status(500)
      .send({ error: { code: "internal", message: "internal error" } });
  });

  app.get("/api/health", async () => ({ ok: true }));

  // Server-resolved defaults the client cannot derive. Only the server knows
  // whether CONSOLE_MODEL moved the orchestrator default, and the draft view
  // has to preselect the right chip before a session exists to read it from.
  app.get(
    "/api/config",
    async (): Promise<ConfigResponse> => ({ defaultModel: ctx.config.infra.model }),
  );

  registerEventRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerFsRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);
  registerUserSessionRoutes(app, ctx);
  registerAgentSessionRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerComposeRoutes(app, ctx);
  registerAgentProfileRoutes(app, ctx);

  // The built UI rides along on this port, so the app is one process. In vite
  // dev the bundle is absent and the dev server proxies /api here instead.
  const hasWeb = existsSync(ctx.config.infra.webDir);
  if (hasWeb) {
    void app.register(fastifyStatic, {
      root: ctx.config.infra.webDir,
      wildcard: false,
    });
  }
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api") || !hasWeb) {
      return reply
        .status(404)
        .send({ error: { code: "not_found", message: "no such route" } });
    }
    // Anything else is a UI path — hand back the SPA shell.
    return reply.sendFile("index.html");
  });

  return app;
}
