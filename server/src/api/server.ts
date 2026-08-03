import Fastify, { type FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { ApiError } from "./errors.ts";
import { registerEventRoutes } from "./routes/events.ts";

export function buildServer(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof ApiError) {
      void reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
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

  registerEventRoutes(app, ctx);
  for (const register of ctx.extraRoutes) register(app, ctx);

  return app;
}
