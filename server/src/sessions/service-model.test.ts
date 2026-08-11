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

function makeService() {
  const { db, sqlite } = openDb(":memory:");
  const bus = new EventBus(db, new ArtifactStore(db));
  const repo = new Repo(db, sqlite);
  const interactions = new InteractionService(db, bus);

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
    bus,
    runner: runner as unknown as OrchestratorRunner,
    interactions,
    workspaces: { get: () => undefined } as never,
  });

  return { sessions, repo, runner, workspaceId };
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
