/**
 * UserSession lifecycle: create-on-first-message (nothing persists until the
 * operator sends), listing, mode/status patches, transcript hydration.
 */
import type {
  AgentSession,
  ConsoleEvent,
  ContinueUserSessionBody,
  CreateUserSessionBody,
  GetUserSessionResponse,
  PatchUserSessionBody,
  PostMessageResponse,
  ProjectContinuationItem,
  RunSignoffBody,
  SessionTreeResponse,
  SystemPauseState,
  UserSession,
  UserSessionListItem,
} from "@agentique-console/shared";
import { InvalidInputError, NotFoundError } from "../errors.ts";
import { Repo, type UserSessionRow } from "../db/repo.ts";
import type { ProjectStore } from "../db/stores/project-store.ts";
import type { ContinuationCheckpointService } from "../continuation/service.ts";
import { toWireMessage, toWireUserSession } from "../api/wire.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";
import type { DecisionIssueService } from "../orchestrator/decision-issues.ts";
import type { InteractionService } from "../orchestrator/interactions.ts";
import type { OrchestratorRunner } from "../orchestrator/runner.ts";
import { titleFromFirstMessage } from "../orchestrator/titler.ts";
import type { WorkspaceService } from "../workspaces/service.ts";

export class UserSessionService {
  readonly #repo: Repo;
  readonly #projects: ProjectStore;
  readonly #bus: EventBus;
  readonly #runner: OrchestratorRunner;
  readonly #interactions: InteractionService;
  readonly #decisionIssues: DecisionIssueService;
  readonly #workspaces: WorkspaceService;
  readonly #archiveAgentSessions: (userSessionId: string) => void;
  readonly #completion: {
    schedule(userSessionId: string): void;
    resolve(userSessionId: string, decision: "accept" | "changes", note?: string, waivers?: import("../completion/service.ts").SubmittedWaiver[]): void;
  };
  readonly #continuation: Pick<ContinuationCheckpointService, "record" | "ensureForProject" | "latestForSession" | "latestForProject">;
  readonly #wireAgentSessions: (userSessionId: string) => AgentSession[];
  /** The live whole-system pause — a session created mid-pause inherits its stamp. */
  readonly #pauseSnapshot: () => SystemPauseState;
  /** Open requirement frontier size for one session's project — discovery's "unresolved work" count. */
  readonly #openRequirementCount: (userSessionId: string) => number;

  constructor(deps: {
    repo: Repo;
    projects: ProjectStore;
    bus: EventBus;
    runner: OrchestratorRunner;
    interactions: InteractionService;
    decisionIssues: DecisionIssueService;
    workspaces: WorkspaceService;
    archiveAgentSessions: (userSessionId: string) => void;
    completion: {
      schedule(userSessionId: string): void;
      resolve(userSessionId: string, decision: "accept" | "changes", note?: string, waivers?: import("../completion/service.ts").SubmittedWaiver[]): void;
    };
    continuation: Pick<ContinuationCheckpointService, "record" | "ensureForProject" | "latestForSession" | "latestForProject">;
    wireAgentSessions: (userSessionId: string) => AgentSession[];
    pauseSnapshot: () => SystemPauseState;
    openRequirementCount: (userSessionId: string) => number;
  }) {
    this.#repo = deps.repo;
    this.#projects = deps.projects;
    this.#bus = deps.bus;
    this.#runner = deps.runner;
    this.#interactions = deps.interactions;
    this.#decisionIssues = deps.decisionIssues;
    this.#workspaces = deps.workspaces;
    this.#archiveAgentSessions = deps.archiveAgentSessions;
    this.#completion = deps.completion;
    this.#continuation = deps.continuation;
    this.#wireAgentSessions = deps.wireAgentSessions;
    this.#pauseSnapshot = deps.pauseSnapshot;
    this.#openRequirementCount = deps.openRequirementCount;
  }

  create(body: CreateUserSessionBody): UserSession {
    const message = body.message.trim();
    if (message === "") throw new InvalidInputError("a first message is required");
    this.#workspaces.get(body.workspaceId); // 404s on unknown workspace
    const projectId = this.#resolveProject(body);

    // A session born under a whole-system pause inherits its stamp: the pause
    // columns are the RESTART persistence (capacity.armFromBoot scans open
    // sessions), and a continuation handoff can archive the only stamped row —
    // without this a restart would forget the pause and spin on a spent quota.
    // A capacity/budget pause does NOT block creation itself: the first
    // message queues and redelivers on resume, exactly like steering.
    const pause = this.#pauseSnapshot();
    const now = nowIso();
    const row: UserSessionRow = {
      id: newId("us"),
      workspaceId: body.workspaceId,
      projectId,
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
      pausedUntil: pause.paused ? pause.until : null,
      pauseReason: pause.paused ? pause.reason : null,
      budgetUsd: null, autonomy: "standard" as const,
      // Null is a real value here, not a placeholder: it means "track the
      // configured default".
      model: body.model ?? null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.#repo.insertUserSession(row);
    } catch (error) {
      // The durable form of the sequential invariant: the partial unique index
      // on open sessions per project (user_sessions_open_project — SQLite
      // reports the violation by column). The check in #resolveProject answers
      // first in every ordinary path; this maps the constraint's last word to
      // the same actionable error instead of a raw SQLITE_CONSTRAINT.
      if (error instanceof Error && error.message.includes("user_sessions.project_id")) {
        const open = this.#repo.listOpenUserSessionsForProject(projectId)[0];
        throw new InvalidInputError(
          `project ${projectId} already has an open session${open === undefined ? "" : ` (${open.id})`} — continuation is sequential; archive it first`,
        );
      }
      throw error;
    }
    const session = toWireUserSession(row);
    this.#bus.append({
      type: "user_session.created",
      userSessionId: session.id,
      workspaceId: session.workspaceId,
      payload: { session },
    });
    if (body.projectId !== undefined) this.#noteContinuation(session.id);
    this.#runner.postOperatorMessage(session.id, message);
    return session;
  }

  /**
   * The operator-facing trace that knowledge crossed the run boundary: a
   * transcript notice naming the prior run and its checkpoint. The checkpoint
   * itself reaches the orchestrator through its prompt digest — this is
   * display. Best-effort: a continued session without a checkpoint (empty
   * prior run, failed generation) simply continues from project truth.
   */
  #noteContinuation(userSessionId: string): void {
    try {
      const checkpoint = this.#continuation.latestForSession(userSessionId);
      if (checkpoint === null) return;
      const from = checkpoint.sourceTitle === null ? checkpoint.sourceUserSessionId : `"${checkpoint.sourceTitle}"`;
      const row = this.#repo.appendMessage({
        sessionKind: "user",
        sessionId: userSessionId,
        speaker: { kind: "system", name: "system" },
        kind: "notice",
        text: `Continuing this project from the previous run ${from}. Its continuation checkpoint (${checkpoint.id}, requirements rev ${checkpoint.atRevision}) is in the orchestrator's context: prior strategy, unfinished workstreams, and accepted gaps carry over as advisory context — no prior agents or tasks resume.`,
      });
      this.#bus.append({
        type: "user_session.message.appended",
        userSessionId,
        payload: { userSessionId, message: toWireMessage(row) },
      });
    } catch {
      // Continuation must survive a display failure.
    }
  }

  /**
   * The project a new session attaches to. Default: a fresh project — no
   * surprise inheritance. Continuation is explicit and SEQUENTIAL: one open
   * session per project, so the requirement graph never has two writers.
   */
  #resolveProject(body: CreateUserSessionBody): string {
    if (body.projectId === undefined) {
      // Fresh-project authority boundary: the exact first operator message is
      // the governing objective. A continuation's first message is direction
      // within the existing project and must never replace it.
      return this.#projects.insert({ workspaceId: body.workspaceId, objectiveDocument: body.message.trim() }).id;
    }
    const project = this.#projects.get(body.projectId);
    if (!project) throw new NotFoundError(`no project ${body.projectId}`);
    if (project.workspaceId !== body.workspaceId) {
      throw new InvalidInputError(`project ${body.projectId} belongs to a different workspace`);
    }
    const open = this.#repo.listOpenUserSessionsForProject(body.projectId);
    if (open.length > 0) {
      throw new InvalidInputError(
        `project ${body.projectId} already has an open session (${open[0]!.id}) — continuation is sequential; archive it first`,
      );
    }
    // The attach-time backstop: if the latest archived run predates
    // checkpoints or its archive-time record was interrupted, build it now
    // from durable rows. A failure here degrades continuation to project
    // truth — it must never block attaching.
    try {
      this.#continuation.ensureForProject(body.projectId);
    } catch (error) {
      console.warn(`continuation checkpoint backstop failed for project ${body.projectId}:`, error);
    }
    return body.projectId;
  }

  /**
   * The explicit run-boundary handoff: continue the source session's PROJECT
   * in a fresh UserSession. An open source (quota-paused, idle, awaiting
   * sign-off) is archived first through the SAME transition as the archive
   * button — its continuation checkpoint records, its agents stop, and its
   * lane closes, so it can never execute again — then exactly one successor
   * is created on the same project. Knowledge transfer only: `runState` is
   * untouched (an interrupted run stays honestly incomplete), no AgentSession
   * or task reactivates, and the provider conversation is not resumed.
   *
   * Recovery and retries converge: a crash after the archive leaves a clean
   * "archived predecessor, no successor" state this same call completes from;
   * a duplicate call finds the successor open and is rejected by the
   * sequential-continuation gate, naming it.
   */
  continueFrom(sourceUserSessionId: string, body: ContinueUserSessionBody): UserSession {
    const source = this.#repo.getUserSession(sourceUserSessionId);
    if (!source) throw new NotFoundError(`no user session ${sourceUserSessionId}`);
    if (source.purpose !== "work") {
      throw new InvalidInputError(`session ${sourceUserSessionId} is not a work session`);
    }
    // Validate BEFORE the handoff transition: a bad message must not archive.
    if (body.message.trim() === "") throw new InvalidInputError("a first message is required");
    if (source.lifecycle === "open") {
      this.patch(sourceUserSessionId, { lifecycle: "archived" });
    }
    const model = body.model ?? source.model ?? undefined;
    const session = this.create({
      workspaceId: source.workspaceId,
      mode: body.mode ?? source.mode,
      message: body.message,
      projectId: source.projectId,
      ...(model === undefined ? {} : { model }),
    });
    this.#noteHandoff(sourceUserSessionId, session);
    return session;
  }

  /** The predecessor's transcript trace: where its project went. Display only, best-effort. */
  #noteHandoff(sourceUserSessionId: string, successor: UserSession): void {
    try {
      const row = this.#repo.appendMessage({
        sessionKind: "user",
        sessionId: sourceUserSessionId,
        speaker: { kind: "system", name: "system" },
        kind: "notice",
        text: `Handed off: this project continues in a fresh session${successor.title === null ? "" : ` "${successor.title}"`} (${successor.id}). This session stays archived as the historical record of its run.`,
      });
      this.#bus.append({
        type: "user_session.message.appended",
        userSessionId: sourceUserSessionId,
        payload: { userSessionId: sourceUserSessionId, message: toWireMessage(row) },
      });
    } catch {
      // The handoff must survive a display failure.
    }
  }

  /**
   * Continuation discovery: every project in the workspace that has carried
   * work sessions, with the facts an operator needs to pick a continuation
   * target — which session it left off in, whether one is still open (and
   * paused why), whether a checkpoint exists, and how much requirement
   * frontier remains. Facts only: status WORDS are derived client-side, so
   * there is no second status vocabulary to drift.
   */
  listProjects(workspaceId: string): ProjectContinuationItem[] {
    this.#workspaces.get(workspaceId); // 404s on unknown workspace
    const items = this.#projects.listByWorkspace(workspaceId).flatMap((project) => {
      const sessions = this.#repo.listUserSessionsForProject(project.id)
        .filter((row) => row.purpose === "work");
      const last = sessions[sessions.length - 1];
      if (last === undefined) return [];
      const open = sessions.find((row) => row.lifecycle === "open");
      const intentLine = (project.intentDocument ?? "")
        .split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find((line) => line !== "") ?? null;
      const objectiveLine = (project.objectiveDocument ?? "")
        .split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find((line) => line !== "") ?? null;
      const item: ProjectContinuationItem = {
        id: project.id,
        name: last.title,
        intentPreview: intentLine === null ? null : intentLine.length <= 160 ? intentLine : `${intentLine.slice(0, 159)}…`,
        objectivePreview: objectiveLine === null ? null : objectiveLine.length <= 160 ? objectiveLine : `${objectiveLine.slice(0, 159)}…`,
        openSession: open === undefined ? null
          : { id: open.id, title: open.title, pauseReason: open.pauseReason },
        lastSession: {
          id: last.id, title: last.title, lifecycle: last.lifecycle, runState: last.runState,
          pauseReason: last.pauseReason, updatedAt: last.updatedAt,
        },
        sessionCount: sessions.length,
        hasCheckpoint: this.#continuation.latestForProject(project.id) !== null,
        openRequirements: this.#openRequirementCount(last.id),
        createdAt: project.createdAt,
      };
      return [item];
    });
    // Most recently touched first — the picker's "where was I" order.
    return items.sort((a, b) => (a.lastSession!.updatedAt < b.lastSession!.updatedAt ? 1 : -1));
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
      // Open project-level issues ride the session read: the transcript's
      // question cards look their shared-issue context up here, and a
      // continued project surfaces its predecessors' unresolved choices.
      openDecisionIssues: this.#decisionIssues.listOpenForProject(id),
    };
  }

  patch(id: string, patch: PatchUserSessionBody): UserSession {
    const row = this.#repo.getUserSession(id);
    if (!row) throw new NotFoundError(`no user session ${id}`);

    const changes: Partial<
      Pick<UserSessionRow, "title" | "mode" | "phase" | "lifecycle" | "model" | "budgetUsd" | "autonomy">
    > = {};
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title === "") throw new InvalidInputError("title cannot be empty");
      changes.title = title;
    }
    if (patch.lifecycle !== undefined) changes.lifecycle = patch.lifecycle;
    if (patch.mode !== undefined && patch.mode !== row.mode) {
      changes.mode = patch.mode;
      // Entering plan_execute re-arms planning; leaving it ends the gate.
      changes.phase = patch.mode === "plan_execute" ? "planning" : "executing";
    }
    if (patch.model !== undefined && patch.model !== row.model) {
      changes.model = patch.model;
    }
    // Neither recycles the lane: the budget acts at the next usage row, and
    // autonomy is read by the governance sweep + the next generation's prompt.
    if (patch.budgetUsd !== undefined) changes.budgetUsd = patch.budgetUsd;
    if (patch.autonomy !== undefined) changes.autonomy = patch.autonomy;
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
      // The run boundary: snapshot the continuation checkpoint BEFORE agent
      // sessions archive, while workstream-link statuses still read as they
      // stood. Idempotent per source session; a failure degrades the next
      // run's context and must never block archival.
      try {
        this.#continuation.record(id);
      } catch (error) {
        console.warn(`continuation checkpoint record failed for session ${id}:`, error);
      }
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

  /** An operator chat message, delivered to the orchestrator lane. */
  postMessage(id: string, text: string): PostMessageResponse {
    return this.#runner.postOperatorMessage(id, text);
  }

  /**
   * The operator's verdict on a proposed run completion. Conflicts (no pending
   * proposal) surface from the completion service; the fresh session row is
   * the response.
   */
  signoff(id: string, body: RunSignoffBody): UserSession {
    this.#completion.resolve(id, body.decision, body.note, body.waivers ?? []);
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
