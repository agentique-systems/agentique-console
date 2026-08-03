import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.ts";
import { ApiError } from "../errors.ts";
import { BrowseError, listDirectories, resolveRoots } from "../../workspaces/fs-browse.ts";

export function registerFsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/fs/roots", async () => {
    const roots = await resolveRoots(ctx.config.fsRoots.map((r) => r.path));
    return {
      roots: roots.map((path) => ({
        path,
        label:
          ctx.config.fsRoots.find((r) => r.path === path)?.label ?? path,
      })),
    };
  });

  app.get<{ Querystring: { path?: string; showHidden?: string } }>(
    "/api/fs/dirs",
    async (request) => {
      const path = request.query.path;
      if (path === undefined || path === "") {
        throw new ApiError(400, "bad_request", "path is required");
      }
      const roots = await resolveRoots(ctx.config.fsRoots.map((r) => r.path));
      try {
        return await listDirectories(path, {
          roots,
          showHidden: request.query.showHidden === "1",
        });
      } catch (error) {
        if (error instanceof BrowseError) {
          throw new ApiError(error.status, "browse_error", error.message);
        }
        throw error;
      }
    },
  );
}
