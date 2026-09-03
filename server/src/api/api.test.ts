/**
 * The HTTP contract (migration-contract §5, §9): every route of
 * `core/src/api.ts` is served by the production server and nothing else is;
 * every legacy route returns the standard 404 body with no redirect and no
 * hint; bodies are strict and bounded; ids are validated at the boundary;
 * membership is enforced; mutations are refused while the process does not
 * admit work; signoff and publication are separate operations; no request
 * field names an actor; and Artifact content is served through the bounded
 * content and download routes only.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_BODY_MAX_BYTES, API_ROUTE_NAMES, API_ROUTES, STANDARD_NOT_FOUND, apiPath, routeParamNames, type ApiErrorBody, type ConfigResponse, type HealthResponse, type WorkspaceResponse } from "@agentique-console/core";
import { gitSync } from "../workspace-state/git.ts";
import type { RegisteredRoutes } from "./server.ts";
import { openTestApp, removeAppDirectory, type TestApp } from "./test-support.ts";

const LEGACY_ROUTES: [string, string][] = [
  ["GET", "/api/stats"],
  ["GET", "/api/system/pause"],
  ["POST", "/api/system/pause"],
  ["POST", "/api/system/resume"],
  ["GET", "/api/workspaces/ws_000000000000000000000000/projects"],
  ["GET", "/api/workspaces/ws_000000000000000000000000/session-tree"],
  ["GET", "/api/workspaces/ws_000000000000000000000000/tasks"],
  ["GET", "/api/workspaces/ws_000000000000000000000000/agent-profiles"],
  ["POST", "/api/workspaces/ws_000000000000000000000000/agent-profiles/x/trust"],
  ["GET", "/api/user-sessions"],
  ["POST", "/api/user-sessions"],
  ["GET", "/api/user-sessions/us_1"],
  ["POST", "/api/user-sessions/us_1/continue"],
  ["POST", "/api/user-sessions/us_1/messages"],
  ["POST", "/api/user-sessions/us_1/interactions/int_1"],
  ["GET", "/api/user-sessions/us_1/decision-issues"],
  ["POST", "/api/user-sessions/us_1/signoff"],
  ["GET", "/api/user-sessions/us_1/run-summaries/s"],
  ["GET", "/api/user-sessions/us_1/transcript"],
  ["GET", "/api/user-sessions/us_1/agent-sessions"],
  ["GET", "/api/user-sessions/us_1/tasks"],
  ["GET", "/api/user-sessions/us_1/requirements"],
  ["POST", "/api/user-sessions/us_1/requirements/r/status"],
  ["POST", "/api/user-sessions/us_1/assumptions/a/resolve"],
  ["GET", "/api/user-sessions/us_1/orchestration"],
  ["GET", "/api/user-sessions/us_1/timeline"],
  ["POST", "/api/user-sessions/us_1/interrupt"],
  ["POST", "/api/user-sessions/us_1/resume-capacity"],
  ["GET", "/api/agent-sessions/as_1"],
  ["GET", "/api/agent-sessions/as_1/transcript"],
  ["GET", "/api/agent-sessions/as_1/activity"],
  ["POST", "/api/agent-sessions/as_1/agents/main/interrupt"],
  ["POST", "/api/scheduled-assignments/sched_1/cancel"],
  ["POST", "/api/compose/improve"],
  ["POST", "/api/decisions/dec_000000000000000000000000/answer"],
  ["POST", "/api/requirements/req_000000000000000000000000/status"],
  ["POST", "/api/runs/run_000000000000000000000000/gates/operator-signoff"],
  ["POST", "/api/plan-nodes/pn_000000000000000000000000/cancel"],
];

describe("the API contract", () => {
  let t: TestApp;
  let workspace: WorkspaceResponse;
  beforeAll(async () => {
    t = await openTestApp();
    const repo = path.join(t.dir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    gitSync(["init", "--quiet", "--initial-branch=main"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
    gitSync(["add", "-A"], { cwd: repo });
    gitSync(["commit", "--quiet", "--no-verify", "-m", "init"], { cwd: repo, identity: true });
    const created = await t.call<WorkspaceResponse>("createWorkspace", { body: { rootPath: repo } });
    expect(created.status).toBe(201);
    workspace = created.body;
  });
  afterAll(async () => {
    await t.close();
    removeAppDirectory(t.dir);
  });

  it("serves every route of the contract and nothing outside it; every legacy route is the standard 404", async () => {
    const served = new Set((t.app.server as unknown as RegisteredRoutes).registeredRoutes.filter((r) => r.includes(" /api")));
    const contract = new Set(Object.values(API_ROUTES).map((r) => `${r.method} ${r.path}`));
    for (const name of API_ROUTE_NAMES) expect(served.has(`${API_ROUTES[name].method} ${API_ROUTES[name].path}`), `${name} is not served`).toBe(true);
    for (const route of served) expect(contract.has(route), `${route} is served but not in the contract`).toBe(true);
    expect(served.size).toBe(contract.size);
    for (const [method, url] of LEGACY_ROUTES) {
      const response = await t.raw(method as never, url, method === "POST" ? {} : undefined);
      expect(response.status, `${method} ${url}`).toBe(404);
      expect(response.body, `${method} ${url}`).toEqual(STANDARD_NOT_FOUND);
      expect(response.headers.location).toBeUndefined();
    }
    // Unknown routes under /api answer the same body; nothing names a replacement.
    const unknown = await t.raw("GET", "/api/nothing-here");
    expect(unknown.body).toEqual(STANDARD_NOT_FOUND);
    expect(JSON.stringify(unknown.body)).not.toMatch(/conversations|runs|instead|moved/);
  });

  it("answers health and safe configuration without a credential, a key, or a filesystem path", async () => {
    const health = await t.call<HealthResponse>("health");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, admission: "ready", database: { disposition: "initialized", schemaVersion: 1 } });
    expect(health.body.recovery).toMatchObject({ blobsComplete: true, interruptedAttempts: 0 });
    const config = await t.call<ConfigResponse>("config");
    expect(config.status).toBe(200);
    expect(config.body.defaults.completionCheck).toEqual({ command: "node -e process.exit(0)", expectedExitCode: 0 });
    expect(config.body.workspaceKinds.map((k) => [k.kind, k.publicationStrategies])).toEqual([["git", ["fast_forward", "merge"]], ["directory", []]]);
    const text = JSON.stringify(config.body);
    expect(text).not.toMatch(/sk-ant|ANTHROPIC|api_key|storageKey|\\\\|C:\\|\/tmp\//);
    expect(text).not.toContain(t.dir);
    const capacity = await t.call("capacity");
    expect(capacity.status).toBe(200);
    expect(capacity.body).toMatchObject({ process: { active: 0 }, activeLeases: [] });
  });

  it("validates ids, strict bodies, unknown fields, and size at the boundary, and never accepts an actor from a request", async () => {
    expect((await t.call("getRun", { params: { runId: "not-an-id" } })).status).toBe(400);
    expect((await t.call("getRun", { params: { runId: "run_000000000000000000000000" } })).status).toBe(404);
    // An unknown field is a bad request; a request cannot name who it is.
    const conversation = await t.call<{ conversation: { id: string } }>("createConversation", { body: { workspaceId: workspace.workspace.id, title: "t" } });
    expect(conversation.status).toBe(201);
    const forged = await t.call<ApiErrorBody>("postConversationMessage", { params: { conversationId: conversation.body.conversation.id }, body: { content: "hello", actor: { kind: "runtime" } } });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("bad_request");
    const forgedRun = await t.call<ApiErrorBody>("createRun", { params: { conversationId: conversation.body.conversation.id }, body: { goal: "x", producer: { kind: "runtime" } } });
    expect(forgedRun.status).toBe(400);
    // Bounded bodies.
    const oversized = await t.raw("POST", apiPath("postConversationMessage", { conversationId: conversation.body.conversation.id }), { content: "x".repeat(API_BODY_MAX_BYTES + 10) });
    expect(oversized.status).toBe(413);
    expect((oversized.body as ApiErrorBody).error.code).toBe("payload_too_large");
    const malformed = await t.app.server.inject({ method: "POST", url: apiPath("createConversation"), payload: "{not json", headers: { "content-type": "application/json" } });
    expect(malformed.statusCode).toBe(400);
    // Pagination is bounded and deterministic.
    expect((await t.call("listWorkspaces", { query: { limit: 5000 } })).status).toBe(400);
    const page = await t.call<{ items: unknown[]; nextCursor: string | null }>("listWorkspaces", { query: { limit: 1 } });
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).toBeNull();
  });

  it("enforces membership on nested routes and refuses every path outside the browse roots", async () => {
    const outside = await t.call<ApiErrorBody>("createWorkspace", { body: { rootPath: path.resolve(t.dir, "..", "elsewhere-" + Date.now()), create: true } });
    expect(outside.status).toBe(403);
    expect(outside.body.error.code).toBe("forbidden");
    const dirs = await t.call<ApiErrorBody>("fsDirs", { query: { path: path.resolve(t.dir, "..") } });
    expect(dirs.status).toBe(403);
    const traversal = await t.call<ApiErrorBody>("fsDirs", { query: { path: path.join(t.dir, "..", "..") } });
    expect(traversal.status).toBe(403);
    // A Decision route under another Run: not found, never acted on.
    const foreign = await t.call<ApiErrorBody>("resolveBudgetIncrease", { params: { runId: "run_000000000000000000000000", decisionId: "dec_000000000000000000000000" }, body: { option: "approve" } });
    expect([404, 409]).toContain(foreign.status);
    expect(foreign.body.error.details).not.toMatchObject({ path: expect.anything() });
  });

  it("refuses every mutation while the process does not admit work, and keeps serving reads", async () => {
    t.app.admission.set("recovery_incomplete");
    try {
      const refused = await t.call<ApiErrorBody>("createConversation", { body: { workspaceId: workspace.workspace.id } });
      expect(refused.status).toBe(503);
      expect(refused.body.error).toMatchObject({ code: "unavailable", details: { admission: "recovery_incomplete" } });
      expect((await t.call("listWorkspaces")).status).toBe(200);
      expect((await t.call<HealthResponse>("health")).body).toMatchObject({ ok: false, admission: "recovery_incomplete" });
    } finally {
      t.app.admission.set("ready");
    }
  });

  it("names every route parameter consistently with the ids it validates", () => {
    for (const name of API_ROUTE_NAMES) {
      for (const param of routeParamNames(API_ROUTES[name].path)) expect(param, `${name} ${param}`).toMatch(/Id$/);
    }
  });
});
