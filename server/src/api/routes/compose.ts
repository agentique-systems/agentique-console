import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.ts";
import { IMPROVE_MAX_CHARS, improveMessage } from "../../compose/improve.ts";
import { badRequest } from "../errors.ts";

const ImproveBody = z.object({ text: z.string() });

export function registerComposeRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  // Unscoped by design: a draft belongs to no session until it is sent.
  app.post("/api/compose/improve", async (request) => {
    const parsed = ImproveBody.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    const text = parsed.data.text.trim();
    if (text === "") throw badRequest("text is required");
    if (text.length > IMPROVE_MAX_CHARS) {
      throw badRequest(`text must be at most ${IMPROVE_MAX_CHARS} characters`);
    }
    const sdk = await ctx.app.sdk();
    return { text: await improveMessage(sdk, ctx.config, text) };
  });
}
