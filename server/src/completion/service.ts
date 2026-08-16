/**
 * When is a run done, and who says so.
 *
 * The predicate below spans both lanes plus the interactions table, which is
 * why it lives in its own service: `host.#refreshStatus` and
 * `runner.#settleTurn` are hot, single-lane, and already do enough. They call
 * this; they do not contain it.
 */
import type { EventBus } from "../events/bus.ts";
import type { Repo } from "../db/repo.ts";
import type { AgentSessionService } from "../agent-sessions/service.ts";
import type { OrchestratorRunner } from "../orchestrator/runner.ts";
import type { InteractionService } from "../orchestrator/interactions.ts";
import type { AssignmentScheduler } from "../tasks/scheduler.ts";
import { newId, nowIso } from "../ids.ts";
import { buildRunSummary, type RunSummaryDocument } from "./summary.ts";
import { runSummaries } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import { and, desc, eq } from "drizzle-orm";
import { ConflictError, NotFoundError } from "../errors.ts";

export interface RunCompletionDeps {
  db: Db;
  repo: Repo;
  bus: EventBus;
  interactions: InteractionService;
  scheduler: AssignmentScheduler;
  host: () => AgentSessionService;
  runner: () => OrchestratorRunner;
  getWorkspaceRoot: (workspaceId: string) => string;
  /** Main's record_completion source; optional so unit harnesses stay small. */
  orchestrationState?: { latestCompletion(userSessionId: string): { revision: number; completion: { criteria: { criterion: string; met: boolean; evidence: { kind: string; ref: string }[] }[]; knownGaps: string[]; nonGoals: string[]; specRevision?: number } } | null };
  /** The approved spec — the completion oracle; optional for spec-less harnesses. */
  specs?: { latestApproved(userSessionId: string): { revision: number } | undefined };
  /**
   * `config.completionQuietWindowMs`. The predicate is re-evaluated when the
   * timer FIRES, not when it was scheduled, so a new turn starting inside the
   * window simply makes it false again.
   */
  quietWindowMs: number;
}

export class RunCompletionService {
  readonly #deps: RunCompletionDeps;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: RunCompletionDeps) {
    this.#deps = deps;
  }

  /** Debounced re-evaluation. Safe to call from anywhere, as often as you like. */
  schedule(userSessionId: string): void {
    const existing = this.#timers.get(userSessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#timers.delete(userSessionId);
      try { this.evaluate(userSessionId); } catch { /* never let a sweep kill the process */ }
    }, this.#deps.quietWindowMs);
    timer.unref?.();
    this.#timers.set(userSessionId, timer);
  }

  stop(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  /**
   * Every clause is a fact the CONSOLE owns. Nothing here depends on a model
   * maintaining state honestly.
   */
  isComplete(userSessionId: string): boolean {
    const { repo, interactions } = this.#deps;
    const session = repo.getUserSession(userSessionId);
    if (!session) return false;
    if (session.runState !== "active" || session.lifecycle !== "open") return false;
    // Guards legacy non-"work" rows (the retired profile-manager lane); those
    // conversations were tools, not runs, and never "complete".
    if (session.purpose !== "work") return false;

    const agentSessions = repo.listAgentSessions(userSessionId).filter((row) => row.lifecycle === "open");
    // Never fire on a chat-only session that delegated nothing.
    if (agentSessions.length === 0) return false;

    const host = this.#deps.host();
    for (const agentSession of agentSessions) {
      if (host.statusOf(agentSession) !== "reported") return false;
      if (repo.listActiveDeliveries(agentSession.id).length > 0) return false;
    }

    // An open question means the run is waiting on the operator, not finished.
    if (interactions.listPending(userSessionId).length > 0) return false;

    // A scheduled assignment is committed future work: the run is not done
    // while any wait behind incomplete dependencies in an open session.
    if (this.#deps.scheduler.countScheduled(userSessionId) > 0) return false;

    const runner = this.#deps.runner();
    if (runner.queuedJobs(userSessionId) > 0) return false;
    if (!runner.laneIdle(userSessionId)) return false;

    // Somebody TOP-LEVEL must actually have reported. Idle is not done, and a
    // child's "final" never reaches the literal main lane — it crossed into
    // its parent as a milestone — so children cannot satisfy this clause and
    // must not be consulted for it. `host.reportedFinal` is the SAME predicate
    // the status derivation, the operator-debt discharge and the stall sweep
    // read: they disagreed once, and the run hung in `active` forever.
    return repo.listAgentSessions(userSessionId).some((agentSession) =>
      agentSession.parentAgentSessionId === null && host.reportedFinal(agentSession));
  }

  /**
   * Fires at most one proposal per active→awaiting_signoff transition —
   * `isComplete` requires `runState === "active"` and `#propose` leaves it
   * `awaiting_signoff` synchronously, so the run state IS the arming latch.
   */
  evaluate(userSessionId: string): boolean {
    if (!this.isComplete(userSessionId)) {
      // Not done — but if the work has nonetheless gone quiet, the operator is
      // owed whatever exists. A run may end incomplete; it may never end in
      // silence, which is exactly how the 2026-08-12 run ended.
      try { this.#deps.host().dischargeQuietDebts(userSessionId); } catch { /* a backstop must not throw */ }
      return false;
    }
    if (!this.#completionRecordSatisfiesSpec(userSessionId)) {
      this.#nudgeForCompletionRecord(userSessionId);
      return false;
    }
    this.#propose(userSessionId);
    return true;
  }

  /**
   * The spec is the completion oracle: with an approved spec, quiet ledgers
   * are not enough — main must have verified THIS revision's acceptance
   * criteria via record_completion. A live run proposed "done" for a game
   * with no window and no renderer because the heuristic stopped at "the
   * current wave's ledger is clean". Spec-less runs keep the old behavior.
   */
  #completionRecordSatisfiesSpec(userSessionId: string): boolean {
    const approved = this.#deps.specs?.latestApproved(userSessionId);
    if (approved === undefined) return true;
    const record = this.#deps.orchestrationState?.latestCompletion(userSessionId);
    return record !== null && record !== undefined
      && record.completion.specRevision === approved.revision;
  }

  /** One nudge per (session, spec revision): verify-and-record, or keep working. */
  readonly #nudgedForRevision = new Map<string, number>();

  #nudgeForCompletionRecord(userSessionId: string): void {
    const approved = this.#deps.specs?.latestApproved(userSessionId);
    if (approved === undefined) return;
    if (this.#nudgedForRevision.get(userSessionId) === approved.revision) return;
    const anchor = this.#deps.repo.listAgentSessions(userSessionId)
      .find((row) => row.parentAgentSessionId === null);
    if (!anchor) return;
    this.#nudgedForRevision.set(userSessionId, approved.revision);
    this.#deps.runner().enqueueAgentMilestone(userSessionId, anchor.id, "decision",
      `The Console sees quiet sessions and final reports, but no completion record against spec rev ${approved.revision}. ` +
      "Verify the spec's acceptance criteria and call record_completion (with specRevision), or name the gap and keep working — the run will not propose completion until then.");
  }

  #propose(userSessionId: string): void {
    const { db, repo, bus } = this.#deps;
    const session = repo.getUserSession(userSessionId);
    if (!session) return;

    // Reap BEFORE building the summary so the counts are real, and so a
    // proposal never leaves a dev server running while the operator reads it.
    const reaped = this.#deps.host().reapForUserSession(userSessionId);

    const previous = db.select().from(runSummaries)
      .where(eq(runSummaries.userSessionId, userSessionId))
      .orderBy(desc(runSummaries.createdAt)).get();
    const seqFrom = previous ? previous.seqTo + 1 : 0;
    const document = buildRunSummary({
      db, repo, userSessionId, seqFrom, reaped,
      interactions: this.#deps.interactions,
      completionRecord: this.#deps.orchestrationState?.latestCompletion(userSessionId) ?? null,
      ...(this.#deps.getWorkspaceRoot ? { getWorkspaceRoot: this.#deps.getWorkspaceRoot } : {}),
    });

    const id = newId("run");
    db.insert(runSummaries).values({
      id, userSessionId, seqFrom, seqTo: document.seqTo, verdict: document.verdict,
      document: document as unknown as Record<string, unknown>,
      status: "proposed", note: null, createdAt: nowIso(), resolvedAt: null,
    }).run();
    repo.patchUserSession(userSessionId, { runState: "awaiting_signoff" });

    bus.append({
      type: "run.completion.proposed",
      userSessionId,
      payload: {
        userSessionId, runId: id, summaryId: id,
        headline: document.headline, verdict: document.verdict,
        filesChanged: document.build.filesChanged,
        tasks: { completed: document.tasks.completed, total: document.tasks.total },
        durationMs: document.durationMs,
        deadAirMs: document.deadAirMs,
        costUsd: document.cost.usd,
        costCoverage: document.cost.coverage,
        openUncertainty: document.uncertainty.length,
        reaped: { seats: reaped.seats.length },
      },
    });
    bus.append({
      type: "user_session.updated",
      userSessionId,
      payload: { userSessionId, patch: { runState: "awaiting_signoff" } },
    });
  }

  /**
   * The operator's verdict.
   *
   * Accept ends the run; request-changes reopens it. `status` stays `open`
   * either way — completion is not archival, and a completed run in the
   * sidebar should read "done", not "hidden".
   */
  /**
   * The full persisted document behind a sign-off card's scalars — the
   * justification, deviations, and uncertainty LIST the proposal event's
   * stats deliberately omit.
   */
  /**
   * The unsummarized tail — everything after the last persisted summary —
   * built on demand and never persisted, so the end of a run is ALWAYS
   * readable. A live run died with its last 6,900 events unsummarized
   * because summaries were only ever built inside a completion proposal.
   */
  tailSummary(userSessionId: string): { id: "tail"; status: "proposed"; verdict: RunSummaryDocument["verdict"]; note: null; createdAt: string; resolvedAt: null; document: RunSummaryDocument } {
    const { db, repo } = this.#deps;
    if (!repo.getUserSession(userSessionId)) throw new NotFoundError(`no user session ${userSessionId}`);
    const previous = db.select().from(runSummaries)
      .where(eq(runSummaries.userSessionId, userSessionId))
      .orderBy(desc(runSummaries.createdAt)).get();
    const document = buildRunSummary({
      db, repo, userSessionId, seqFrom: previous ? previous.seqTo + 1 : 0,
      reaped: { seats: [] },
      interactions: this.#deps.interactions,
      completionRecord: this.#deps.orchestrationState?.latestCompletion(userSessionId) ?? null,
      ...(this.#deps.getWorkspaceRoot ? { getWorkspaceRoot: this.#deps.getWorkspaceRoot } : {}),
    });
    return { id: "tail", status: "proposed", verdict: document.verdict, note: null,
      createdAt: nowIso(), resolvedAt: null, document };
  }

  getSummary(userSessionId: string, summaryId: string): { id: string; status: "proposed" | "accepted" | "changes_requested"; verdict: RunSummaryDocument["verdict"]; note: string | null; createdAt: string; resolvedAt: string | null; document: RunSummaryDocument } {
    const row = this.#deps.db.select().from(runSummaries).where(eq(runSummaries.id, summaryId)).get();
    if (!row || row.userSessionId !== userSessionId) throw new NotFoundError(`no run summary ${summaryId} in session ${userSessionId}`);
    return { id: row.id, status: row.status, verdict: row.verdict, note: row.note,
      createdAt: row.createdAt, resolvedAt: row.resolvedAt, document: row.document as unknown as RunSummaryDocument };
  }

  resolve(userSessionId: string, decision: "accept" | "changes", note?: string): void {
    const { db, repo, bus } = this.#deps;
    const session = repo.getUserSession(userSessionId);
    if (!session) throw new NotFoundError(`no user session ${userSessionId}`);
    if (session.runState !== "awaiting_signoff") {
      throw new ConflictError(`run is ${session.runState}, not awaiting sign-off`);
    }
    const summary = db.select().from(runSummaries)
      .where(and(eq(runSummaries.userSessionId, userSessionId), eq(runSummaries.status, "proposed")))
      .orderBy(desc(runSummaries.createdAt)).get();
    const now = nowIso();
    if (summary) {
      db.update(runSummaries)
        .set({ status: decision === "accept" ? "accepted" : "changes_requested", ...(note === undefined ? {} : { note }), resolvedAt: now })
        .where(eq(runSummaries.id, summary.id)).run();
    }

    if (decision === "accept") {
      repo.patchUserSession(userSessionId, { runState: "completed" });
      bus.append({ type: "run.signoff.resolved", userSessionId,
        payload: { userSessionId, runId: summary?.id ?? "", decision: "accept", ...(note === undefined ? {} : { note }) } });
      bus.append({ type: "user_session.updated", userSessionId,
        payload: { userSessionId, patch: { runState: "completed" } } });
      // The agent sessions are done; their rows say so, and the lane stops
      // holding a CLI subprocess for a run nobody is working on.
      this.#deps.host().archiveForUserSession(userSessionId);
      void this.#deps.runner().closeSession(userSessionId).catch(() => undefined);
      return;
    }

    // Reopened. Agents respawn lazily over their retained provider sessions;
    // any killed dev server is genuinely gone — an agent that must restart its
    // server on a change request is honest.
    repo.patchUserSession(userSessionId, { runState: "active" });
    bus.append({ type: "run.signoff.resolved", userSessionId,
      payload: { userSessionId, runId: summary?.id ?? "", decision: "changes", ...(note === undefined ? {} : { note }) } });
    bus.append({ type: "run.reopened", userSessionId,
      payload: { userSessionId, runId: summary?.id ?? "", reason: "changes_requested" } });
    bus.append({ type: "user_session.updated", userSessionId,
      payload: { userSessionId, patch: { runState: "active" } } });
    // A note is a real operator message: it steers a live lane and reaches the
    // orchestrator the same way anything else the operator types does. An empty
    // note synthesizes nothing — the UI focuses the composer instead.
    if (note !== undefined && note.trim() !== "") {
      this.#deps.runner().postOperatorMessage(userSessionId, note.trim());
    }
  }

  /**
   * Chat while a sign-off card is open IS a change request. Without this the
   * operator types "actually add X", the orchestrator answers, and the card
   * sits there still claiming the run is done.
   */
  noteOperatorMessage(userSessionId: string): boolean {
    const session = this.#deps.repo.getUserSession(userSessionId);
    if (session?.runState !== "awaiting_signoff") return false;
    this.resolve(userSessionId, "changes");
    return true;
  }

}
