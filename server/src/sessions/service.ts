/**
 * UserSession lifecycle: create-on-first-message (nothing persists until the
 * operator sends), listing, mode/status patches, transcript hydration.
 */
import type {
  AgentSession,
  ConsoleEvent,
  CreateUserSessionBody,
  GetUserSessionResponse,
  PatchUserSessionBody,
  PostMessageResponse,
  RunSignoffBody,
  SessionTreeResponse,
  UserSession,
  UserSessionListItem,
} from "@agentique-console/shared";
import { InvalidInputError, NotFoundError } from "../errors.ts";
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
  readonly #archiveAgentSessions: (userSessionId: string) => void;
  readonly #completion: {
    schedule(userSessionId: string): void;
    resolve(userSessionId: string, decision: "accept" | "changes", note?: string): void;
  };
  readonly #wireAgentSessions: (userSessionId: string) => AgentSession[];
  readonly #postManagerMessage: (userSessionId: string, text: string) => PostMessageResponse;

  constructor(deps: {
    repo: Repo;
    bus: EventBus;
    runner: OrchestratorRunner;
    interactions: InteractionService;
    workspaces: WorkspaceService;
    archiveAgentSessions: (userSessionId: string) => void;
    completion: {
      schedule(userSessionId: string): void;
      resolve(userSessionId: string, decision: "accept" | "changes", note?: string): void;
    };
    wireAgentSessions: (userSessionId: string) => AgentSession[];
    postManagerMessage: (userSessionId: string, text: string) => PostMessageResponse;
  }) {
    this.#repo = deps.repo;
    this.#bus = deps.bus;
    this.#runner = deps.runner;
    this.#interactions = deps.interactions;
    this.#workspaces = deps.workspaces;
    this.#archiveAgentSessions = deps.archiveAgentSessions;
    this.#completion = deps.completion;
    this.#wireAgentSessions = deps.wireAgentSessions;
    this.#postManagerMessage = deps.postManagerMessage;
  }

  create(body: CreateUserSessionBody): UserSession {
    const message = body.message.trim();
    if (message === "") throw new InvalidInputError("a first message is required");
    this.#workspaces.get(body.workspaceId); // 404s on unknown workspace

    const now = nowIso();
    const row: UserSessionRow = {
      id: newId("us"),
      workspaceId: body.workspaceId,
      title: titleFromFirstMessage(message),
      mode: body.mode,
      phase: body.mode === "plan_execute" ? "planning" : "executing",
      lifecycle: "open",
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
      // Null is a real value here, not a placeholder: it means "track the
      // configured default", which is what the profile-manager session wants.
      model: body.model ?? null,
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
    if (!row) throw new NotFoundError(`no user session ${id}`);
    return {
      session: toWireUserSession(row),
      pendingInteractions: this.#interactions.listPending(id),
    };
  }

  patch(id: string, patch: PatchUserSessionBody): UserSession {
    const row = this.#repo.getUserSession(id);
    if (!row) throw new NotFoundError(`no user session ${id}`);

    const changes: Partial<
      Pick<UserSessionRow, "title" | "mode" | "phase" | "lifecycle" | "model">
    > = {};
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title === "") throw new InvalidInputError("title cannot be empty");
      changes.title = title;
    }
    if (patch.lifecycle !== undefined) changes.lifecycle = patch.lifecycle;
    if (row.purpose === "profile_manager" && patch.mode !== undefined && patch.mode !== "plan_execute") {
      throw new InvalidInputError("profile Manager sessions always require plan approval");
    }
    if (patch.mode !== undefined && patch.mode !== row.mode) {
      changes.mode = patch.mode;
      // Entering plan_execute re-arms planning; leaving it ends the gate.
      changes.phase = patch.mode === "plan_execute" ? "planning" : "executing";
    }
    if (patch.model !== undefined && patch.model !== row.model) {
      changes.model = patch.model;
    }
    if (Object.keys(changes).length === 0) return toWireUserSession(row);

    this.#repo.patchUserSession(id, changes);
    this.#bus.append({
      type: "user_session.updated",
      userSessionId: id,
      payload: { userSessionId: id, patch: changes },
    });
    // The lane's options are frozen at spawn: archiving shuts it down, and a
    // mode or model change recycles it so the next message respawns with fresh
    // options. A turn already in flight finishes on what it started with.
    if (changes.lifecycle === "archived") {
      this.#completion.schedule(id);
      this.#archiveAgentSessions(id);
      void this.#runner.closeSession(id);
    } else if (changes.mode !== undefined || changes.model !== undefined) {
      this.#runner.recycleSession(id);
    }
    const updated = this.#repo.getUserSession(id);
    return toWireUserSession(updated ?? row);
  }

  /** Every session in a workspace with its agent sessions — the sidebar's tree. */
  sessionTree(workspaceId: string): SessionTreeResponse {
    this.#workspaces.get(workspaceId); // 404s on unknown workspace
    return this.#repo.listUserSessions(workspaceId).map((row) => ({
      session: toWireUserSession(row),
      agentSessions: this.#wireAgentSessions(row.id),
    }));
  }

  /**
   * An operator chat message. A profile-manager session routes to its own
   * service (which re-arms planning); everything else goes to the runner.
   */
  postMessage(id: string, text: string): PostMessageResponse {
    const row = this.#repo.getUserSession(id);
    return row?.purpose === "profile_manager"
      ? this.#postManagerMessage(id, text)
      : this.#runner.postOperatorMessage(id, text);
  }

  /**
   * The operator's verdict on a proposed run completion. Conflicts (no pending
   * proposal) surface from the completion service; the fresh session row is
   * the response.
   */
  signoff(id: string, body: RunSignoffBody): UserSession {
    this.#completion.resolve(id, body.decision, body.note);
    return this.get(id).session;
  }

  /**
   * A stale plan approval still ends the planning gate — the same transition
   * the live approval path makes inside `canUseTool`.
   */
  beginExecuting(id: string): void {
    this.#repo.patchUserSession(id, { phase: "executing" });
    this.#bus.append({
      type: "user_session.updated",
      userSessionId: id,
      payload: { userSessionId: id, patch: { phase: "executing" } },
    });
  }

  async transcript(id: string): Promise<ConsoleEvent[]> {
    const row = this.#repo.getUserSession(id);
    if (!row) throw new NotFoundError(`no user session ${id}`);
    const events: ConsoleEvent[] = [];
    for await (const event of this.#bus.readWithSeq({ userSessionId: id })) {
      events.push(event);
    }
    return events;
  }
}
