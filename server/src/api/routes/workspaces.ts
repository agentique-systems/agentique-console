import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.ts";
import { InvalidInputError } from "../../errors.ts";

const CreateBody = z.object({
  name: z.string(),
  rootPath: z.string(),
  create: z.boolean().optional(),
});

const PatchBody = z.object({
  name: z.string().optional(),
});

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  const service = ctx.app.workspaces;

  app.get("/api/workspaces", async () => service.list());

  app.post("/api/workspaces", async (request, reply) => {
    const parsed = CreateBody.safeParse(request.body);
    if (!parsed.success) throw new InvalidInputError(parsed.error.message);
    const workspace = await service.create(parsed.data);
    return reply.status(201).send(workspace);
  });

  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id",
    async (request) => service.get(request.params.id),
  );

  app.patch<{ Params: { id: string } }>(
    "/api/workspaces/:id",
    async (request) => {
      const parsed = PatchBody.safeParse(request.body);
      if (!parsed.success) throw new InvalidInputError(parsed.error.message);
      return service.patch(request.params.id, parsed.data);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/session-tree",
    async (request) => ctx.app.userSessions.sessionTree(request.params.id),
  );

  // Continuation discovery: the workspace's projects with the facts needed to
  // pick one to continue (last session, open session + pause, checkpoint
  // existence, open requirement count).
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/projects",
    async (request) => ctx.app.userSessions.listProjects(request.params.id),
  );
}
