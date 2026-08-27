/**
 * The per-session orchestrator model, at the service layer: stored on create,
 * changed on patch, and — the part that is easy to get wrong — recycling the
 * lane so the change actually takes effect. The lane's options are frozen at
 * spawn, so a patch that skips the recycle updates the row and changes nothing
 * the operator can observe.
 */
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../events/artifact-store.ts";
import { EventBus } from "../events/bus.ts";
import { InteractionService } from "../orchestrator/interactions.ts";
import type { OrchestratorRunner } from "../orchestrator/runner.ts";
import { openDb } from "../db/client.ts";
import { Repo } from "../db/repo.ts";
import { workspaces } from "../db/schema.ts";
import { newId, nowIso } from "../ids.ts";
import { UserSessionService } from "./service.ts";
import { DecisionIssueStore } from "../db/stores/decision-issue-store.ts";
import { DecisionIssueService } from "../orchestrator/decision-issues.ts";
import { InteractionStore } from "../db/stores/interaction-store.ts";
import { ProjectStore } from "../db/stores/project-store.ts";

function makeService() {
  const { db, sqlite } = openDb(":memory:");
  const bus = new EventBus(db, new ArtifactStore(db));
  const repo = new Repo(db, sqlite);
  const interactionStore = new InteractionStore(db);
  const interactions = new InteractionService(interactionStore, bus);
  const decisionIssues = new DecisionIssueService(new DecisionIssueStore(db), interactionStore, bus, (userSessionId) => {
    const row = repo.getUserSession(userSessionId);
    if (!row) throw new Error(`no user session ${userSessionId}`);
    return row.projectId;
  });

  const workspaceId = newId("ws");
  db.insert(workspaces)
    .values({ id: workspaceId, name: "test", rootPath: "/tmp/test-workspace", metadata: {}, createdAt: nowIso(), updatedAt: nowIso() })
    .run();

  const runner = {
    postOperatorMessage: vi.fn(() => ({ messageId: "m_1", seq: 1 })),
    recycleSession: vi.fn(),
    closeSession: vi.fn(async () => undefined),
  };

  const sessions = new UserSessionService({
    repo,
    projects: new ProjectStore(db),
    bus,
    runner: runner as unknown as OrchestratorRunner,
    interactions,
    decisionIssues,
    workspaces: { get: () => undefined } as never,
    archiveAgentSessions: vi.fn(),
    completion: { schedule: vi.fn(), resolve: vi.fn() },
    continuation: { record: vi.fn(() => null), ensureForProject: vi.fn(), latestForSession: vi.fn(() => null), latestForProject: vi.fn(() => null) },
    wireAgentSessions: () => [],
    pauseSnapshot: () => ({ paused: false, reason: null, since: null, until: null }),
    openRequirementCount: () => 0,
  });

  return { sessions, repo, runner, workspaceId, db };
}

describe("UserSessionService model", () => {
  it("stores the chosen model on create", () => {
    const { sessions, repo, workspaceId } = makeService();
    const session = sessions.create({ workspaceId, mode: "execute", message: "go", model: "claude-fable-5" });

    expect(session.model).toBe("claude-fable-5");
    expect(repo.getUserSession(session.id)?.model).toBe("claude-fable-5");
  });

  it("omitting the model records null, which tracks the configured default", () => {
    const { sessions, repo, workspaceId } = makeService();
    const session = sessions.create({ workspaceId, mode: "execute", message: "go" });

    expect(session.model).toBeNull();
    expect(repo.getUserSession(session.id)?.model).toBeNull();
  });

  it("a model patch recycles the lane so the next turn respawns on it", () => {
    const { sessions, runner, workspaceId } = makeService();
    const session = sessions.create({ workspaceId, mode: "execute", message: "go" });
    runner.recycleSession.mockClear();

    const patched = sessions.patch(session.id, { model: "claude-sonnet-5" });

    expect(patched.model).toBe("claude-sonnet-5");
    expect(runner.recycleSession).toHaveBeenCalledWith(session.id);
  });

  it("re-picking the model already in force is a no-op — no needless recycle", () => {
    const { sessions, runner, workspaceId } = makeService();
    const session = sessions.create({ workspaceId, mode: "execute", message: "go", model: "claude-opus-5" });
    runner.recycleSession.mockClear();

    sessions.patch(session.id, { model: "claude-opus-5" });

    expect(runner.recycleSession).not.toHaveBeenCalled();
  });

  it("archiving still shuts the lane down rather than recycling it", () => {
    const { sessions, runner, workspaceId } = makeService();
    const session = sessions.create({ workspaceId, mode: "execute", message: "go" });
    runner.recycleSession.mockClear();

    sessions.patch(session.id, { lifecycle: "archived" });

    expect(runner.closeSession).toHaveBeenCalledWith(session.id);
    expect(runner.recycleSession).not.toHaveBeenCalled();
  });
});

describe("UserSessionService project attachment", () => {
  it("mints a fresh project by default — no surprise inheritance", () => {
    const { sessions, repo, workspaceId } = makeService();
    const a = sessions.create({ workspaceId, mode: "execute", message: "go" });
    const b = sessions.create({ workspaceId, mode: "execute", message: "go" });
    const projectA = repo.getUserSession(a.id)!.projectId;
    const projectB = repo.getUserSession(b.id)!.projectId;
    expect(projectA).toBeTruthy();
    expect(projectB).toBeTruthy();
    expect(projectA).not.toBe(projectB);
  });

  it("continuation is sequential: rejected while the project has an open session", () => {
    const { sessions, repo, workspaceId } = makeService();
    const first = sessions.create({ workspaceId, mode: "execute", message: "go" });
    const projectId = repo.getUserSession(first.id)!.projectId;
    expect(() => sessions.create({ workspaceId, mode: "execute", message: "again", projectId }))
      .toThrow(/continuation is sequential/);

    // Archive the first session; the same project can then be continued.
    sessions.patch(first.id, { lifecycle: "archived" });
    const second = sessions.create({ workspaceId, mode: "execute", message: "again", projectId });
    expect(second.projectId).toBe(projectId);
  });

  it("rejects an unknown project and a project from another workspace", () => {
    const { sessions, workspaceId, db } = makeService();
    expect(() => sessions.create({ workspaceId, mode: "execute", message: "go", projectId: "proj_missing" }))
      .toThrow(/no project/);
    const otherWorkspace = newId("ws");
    db.insert(workspaces)
      .values({ id: otherWorkspace, name: "other", rootPath: "/tmp/test-workspace-2", metadata: {}, createdAt: nowIso(), updatedAt: nowIso() })
      .run();
    const other = sessions.create({ workspaceId: otherWorkspace, mode: "execute", message: "go" });
    expect(() => sessions.create({ workspaceId, mode: "execute", message: "go", projectId: other.projectId }))
      .toThrow(/different workspace/);
  });
});
