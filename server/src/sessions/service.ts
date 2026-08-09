/**
 * UserSession lifecycle: create-on-first-message (nothing persists until the
 * operator sends), listing, mode/status patches, transcript hydration.
 */
import type {
  ConsoleEvent,
  CreateUserSessionBody,
  GetUserSessionResponse,
  PatchUserSessionBody,
  UserSession,
  UserSessionListItem,
} from "@agentique-console/shared";
import { badRequest, notFound } from "../api/errors.ts";
import { Repo, toWireUserSession, type UserSessionRow } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";
import type { InteractionService } from "../orchestrator/interactions.ts";
import type { OrchestratorRunner } from "../orchestrator/runner.ts";
import { titleFromFirstMessage } from "../orchestrator/titler.ts";
import type { WorkspaceService } from "../workspaces/service.ts";

export class UserSessionService {
  readonly #repo: Repo;
  readonly #bus: EventBus;
  readonly #runner: OrchestratorRunner;
  readonly #interactions: InteractionService;
  readonly #workspaces: WorkspaceService;
  readonly #archiveAgentSessions: ((userSessionId: string) => void) | undefined;
  readonly #completion: { schedule(userSessionId: string): void } | undefined;

  constructor(deps: {
    repo: Repo;
    bus: EventBus;
    runner: OrchestratorRunner;
    interactions: InteractionService;
    workspaces: WorkspaceService;
    archiveAgentSessions?: (userSessionId: string) => void;
    completion?: { schedule(userSessionId: string): void };
  }) {
    this.#repo = deps.repo;
    this.#bus = deps.bus;
    this.#runner = deps.runner;
    this.#interactions = deps.interactions;
    this.#workspaces = deps.workspaces;
    this.#archiveAgentSessions = deps.archiveAgentSessions;
    this.#completion = deps.completion;
  }

  create(body: CreateUserSessionBody): UserSession {
    const message = body.message.trim();
    if (message === "") throw badRequest("a first message is required");
    this.#workspaces.get(body.workspaceId); // 404s on unknown workspace

    const now = nowIso();
    const row: UserSessionRow = {
      id: newId("us"),
      workspaceId: body.workspaceId,
      title: titleFromFirstMessage(message),
      mode: body.mode,
      phase: body.mode === "plan_execute" ? "planning" : "executing",
      status: "open",
      purpose: "work",
      subjectKey: null,
      sdkSessionId: null,
      sdkGeneration: 0,
      sdkTurnCount: 0,
      contextTokens: 0,
      memory: "",
      latestHandoffId: null,
      cumulativeCostUsd: 0,
      cumulativeApiDurationMs: 0,
      runState: "active",
      runBaseCommit: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#repo.insertUserSession(row);
    const session = toWireUserSession(row);
    this.#bus.append({
      type: "user_session.created",
      userSessionId: session.id,
      workspaceId: session.workspaceId,
      payload: { session },
    });
    this.#runner.postOperatorMessage(session.id, message);
    return session;
  }

  list(workspaceId: string): UserSessionListItem[] {
    // One grouped query rather than N: the sidebar renders every session.
    const pending = this.#repo.countPendingInteractions(workspaceId);
    return this.#repo.listUserSessions(workspaceId).map((row) => ({
      ...toWireUserSession(row),
      pendingInteractions: pending.get(row.id) ?? 0,
    }));
  }

  get(id: string): GetUserSessionResponse {
    const row = this.#repo.getUserSession(id);
    if (!row) throw notFound(`no user session ${id}`);
    return {
      session: toWireUserSession(row),
      pendingInteractions: this.#interactions.listPending(id),
    };
  }

  patch(id: string, patch: PatchUserSessionBody): UserSession {
    const row = this.#repo.getUserSession(id);
    if (!row) throw notFound(`no user session ${id}`);

    const changes: Partial<
      Pick<UserSessionRow, "title" | "mode" | "phase" | "status">
    > = {};
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title === "") throw badRequest("title cannot be empty");
      changes.title = title;
    }
    if (patch.status !== undefined) changes.status = patch.status;
    if (row.purpose === "profile_manager" && patch.mode !== undefined && patch.mode !== "plan_execute") {
      throw badRequest("profile Manager sessions always require plan approval");
    }
    if (patch.mode !== undefined && patch.mode !== row.mode) {
      changes.mode = patch.mode;
      // Entering plan_execute re-arms planning; leaving it ends the gate.
      changes.phase = patch.mode === "plan_execute" ? "planning" : "executing";
    }
    if (Object.keys(changes).length === 0) return toWireUserSession(row);

    this.#repo.patchUserSession(id, changes);
    this.#bus.append({
      type: "user_session.updated",
      userSessionId: id,
      payload: { sessionId: id, patch: changes },
    });
    // The lane's options are frozen at spawn: archiving shuts it down, a mode
    // change recycles it so the next message respawns with fresh options.
    if (changes.status === "archived") {
      this.#completion?.schedule(id);
      this.#archiveAgentSessions?.(id);
      void this.#runner.closeSession(id);
    } else if (changes.mode !== undefined) {
      this.#runner.recycleSession(id);
    }
    const updated = this.#repo.getUserSession(id);
    return toWireUserSession(updated ?? row);
  }

  async transcript(id: string): Promise<ConsoleEvent[]> {
    const row = this.#repo.getUserSession(id);
    if (!row) throw notFound(`no user session ${id}`);
    const events: ConsoleEvent[] = [];
    for await (const event of this.#bus.readWithSeq({ userSessionId: id })) {
      events.push(event);
    }
    return events;
  }
}
