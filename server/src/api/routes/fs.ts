import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.ts";
import { InvalidInputError } from "../../errors.ts";
import { browseDirectories, rootsView } from "../../workspaces/fs-browse.ts";

export function registerFsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/fs/roots", async () => rootsView(ctx.config.infra.fsRoots));

  app.get<{ Querystring: { path?: string; showHidden?: string } }>(
    "/api/fs/dirs",
    async (request) => {
      const path = request.query.path;
      if (path === undefined || path === "") {
        throw new InvalidInputError("path is required");
      }
      return browseDirectories(
        ctx.config.infra.fsRoots.map((root) => root.path),
        path,
        request.query.showHidden === "1",
      );
    },
  );
}
