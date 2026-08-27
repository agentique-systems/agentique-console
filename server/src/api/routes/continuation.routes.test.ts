/**
 * The continuation product bridge over the real HTTP surface (fastify
 * inject). The live straf3 run exposed that continuation existed at the
 * service layer but was unreachable in operation: the create route's zod
 * schema omitted `projectId`, so zod silently STRIPPED it and every client
 * got a fresh project. These tests pin the whole reachable path: explicit
 * same-project creation, the run-boundary continue endpoint, and the
 * discovery listing the picker reads.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ListWorkspaceProjectsResponse, UserSession } from "@agentique-console/shared";
import { buildServer } from "../server.ts";
import { initMessage, successMessage } from "../../sdk/fake.ts";
import { makeHarness, type Harness } from "../../test-helpers.ts";

const quiet = { info() {}, warn() {}, error() {} };

function makeServer(h: Harness) {
  return buildServer({ app: h.app, config: h.config, log: quiet });
}

function approve(h: Harness, userSessionId: string, document: string): void {
  const draft = h.app.requirements.propose(userSessionId, document);
  h.app.requirements.approve(draft.id, { document, edited: false });
}

describe("continuation over HTTP", () => {
  const servers: ReturnType<typeof buildServer>[] = [];
  afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

  it("POST /api/user-sessions carries projectId through — the schema-stripping regression", async () => {
    const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
    const server = makeServer(h);
    servers.push(server);

    const first = await server.inject({
      method: "POST", url: "/api/user-sessions",
      payload: { workspaceId: h.workspaceId, mode: "execute", message: "build the tracker" },
    });
    expect(first.statusCode).toBe(201);
    const firstSession = (first.json() as { session: UserSession }).session;

    await server.inject({ method: "PATCH", url: `/api/user-sessions/${firstSession.id}`, payload: { lifecycle: "archived" } });

    const continued = await server.inject({
      method: "POST", url: "/api/user-sessions",
      payload: { workspaceId: h.workspaceId, mode: "execute", message: "keep going", projectId: firstSession.projectId },
    });
    expect(continued.statusCode).toBe(201);
    // Before the fix zod stripped projectId and this was a FRESH project.
    expect((continued.json() as { session: UserSession }).session.projectId).toBe(firstSession.projectId);
  });

  it("POST /:id/continue hands a paused run off to exactly one successor on the same project", async () => {
    const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
    const server = makeServer(h);
    servers.push(server);
    const runA = h.addUserSession();
    const projectId = h.repo.getUserSession(runA)!.projectId;
    h.app.orchestrationState.update(runA, { trigger: "commission", strategy: "land the parser first" });
    h.app.capacity.noteLimit({ status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600, limitType: "five_hour" });

    // A bad request must not archive: validation precedes the handoff.
    const bad = await server.inject({
      method: "POST", url: `/api/user-sessions/${runA}/continue`, payload: { message: "  " },
    });
    expect(bad.statusCode).toBe(400);
    expect(h.repo.getUserSession(runA)?.lifecycle).toBe("open");

    const continued = await server.inject({
      method: "POST", url: `/api/user-sessions/${runA}/continue`,
      payload: { message: "continue the unfinished work" },
    });
    expect(continued.statusCode).toBe(201);
    const successor = (continued.json() as { session: UserSession }).session;
    expect(successor.projectId).toBe(projectId);
    // The successor inherits the live pause — a new session does not imply
    // restored provider capacity.
    expect(successor.pauseReason).toBe("capacity");
    // The source is archived (handed off), not completed, and cannot execute.
    const source = h.repo.getUserSession(runA)!;
    expect(source.lifecycle).toBe("archived");
    expect(source.runState).toBe("active");

    // A retry cannot mint a second successor: the sequential gate names the open one.
    const retry = await server.inject({
      method: "POST", url: `/api/user-sessions/${runA}/continue`, payload: { message: "again" },
    });
    expect(retry.statusCode).toBe(400);
    expect(retry.body).toContain(successor.id);
    expect(h.repo.listOpenUserSessionsForProject(projectId).map((row) => row.id)).toEqual([successor.id]);
  });

  it("GET /api/workspaces/:id/projects lists continuation candidates with their facts", async () => {
    const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
    const server = makeServer(h);
    servers.push(server);
    const runA = h.addUserSession();
    const projectId = h.repo.getUserSession(runA)!.projectId;
    approve(h, runA, "## Requirements\n- It parses input files\n- It renders the report");
    h.app.orchestrationState.update(runA, { trigger: "commission", strategy: "parse before render" });
    h.app.capacity.noteLimit({ status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 });

    const paused = await server.inject({ method: "GET", url: `/api/workspaces/${h.workspaceId}/projects` });
    expect(paused.statusCode).toBe(200);
    const pausedRow = (paused.json() as ListWorkspaceProjectsResponse).find((row) => row.id === projectId)!;
    expect(pausedRow).toMatchObject({
      openSession: expect.objectContaining({ id: runA, pauseReason: "capacity" }),
      sessionCount: 1,
      hasCheckpoint: false,
      openRequirements: 2,
    });

    h.app.userSessions.patch(runA, { lifecycle: "archived" });
    const after = await server.inject({ method: "GET", url: `/api/workspaces/${h.workspaceId}/projects` });
    const afterRow = (after.json() as ListWorkspaceProjectsResponse).find((row) => row.id === projectId)!;
    expect(afterRow.openSession).toBeNull();
    // The archived row keeps its stopping reason for the picker's label.
    expect(afterRow.lastSession).toMatchObject({ id: runA, lifecycle: "archived", runState: "active", pauseReason: "capacity" });
    expect(afterRow.hasCheckpoint).toBe(true);

    const missing = await server.inject({ method: "GET", url: "/api/workspaces/ws_missing/projects" });
    expect(missing.statusCode).toBe(404);
  });
});
