import type { FastifyInstance } from "fastify";
import type { PauseSystemResponse, SystemPauseState } from "@agentique-console/shared";
import { z } from "zod";
import type { AppContext } from "../../context.ts";
import { InvalidInputError } from "../../errors.ts";

const PauseBody = z.object({
  mode: z.enum(["hard", "soft"]).default("hard"),
  detail: z.string().max(200).optional(),
});

/** Install-wide controls — the top bar's Pause/Resume. No session in the URL: one switch for everything. */
export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/system/pause", async (): Promise<SystemPauseState> => ctx.app.system.state());

  app.post("/api/system/pause", async (request): Promise<PauseSystemResponse> => {
    const parsed = PauseBody.safeParse(request.body ?? {});
    if (!parsed.success) throw new InvalidInputError(parsed.error.message);
    return ctx.app.system.pause(parsed.data);
  });

  app.post("/api/system/resume", async (): Promise<SystemPauseState> => ctx.app.system.resume());
}
