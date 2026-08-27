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
import { consumptionPending } from "../agent-sessions/attention.ts";
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
import type { CompletionCoverageReport, CompletionWaiver, CoverageExceptionKind } from "@agentique-console/shared";

/** One typed acceptance the operator submits with an accept decision. */
export interface SubmittedWaiver {
  kind: CoverageExceptionKind;
  ref: string;
  note?: string;
}

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
  orchestrationState?: { latestCompletion(userSessionId: string): { revision: number; completion: import("../orchestrator/state.ts").CompletionRecord } | null };
  /** The legacy spec oracle; optional for spec-less harnesses. */
  /**
   * The requirement graph — the completion oracle when a revision governs;
   * optional for pre-graph harnesses.
   */
  requirements?: Pick<import("../orchestrator/requirements.ts").RequirementService,
    "latestApproved" | "summarySnapshot" | "rootStatus" | "frontier" | "verificationGaps">;
  /**
   * The change-impact ledger — an OPEN impact (stale evidence or affected
   * work nobody has judged) holds the completion proposal exactly like a
   * missing completion record; optional for pre-ledger harnesses.
   */
  changeImpacts?: Pick<import("../orchestrator/change-impact.ts").ChangeImpactService, "listOpen">;
  /**
   * The workstream-link layer — a BROKEN link (producer abandoned) whose
   * consumer is still open holds the completion proposal the same way: the
   * relationship went stale and nobody has judged it. Releasing the link (with
   * why), re-pointing it at a successor, or archiving the consumer clears it;
   * optional for pre-portfolio harnesses.
   */
  workstreams?: Pick<import("../portfolio/workstreams.ts").WorkstreamService, "brokenOpen">;
  /**
   * The coverage evaluator (completion/coverage.ts, wired in createApp) — the
   * machine-checkable accounting persisted with every proposal and RECOMPUTED
   * at accept as the staleness guard. Optional for pre-graph unit harnesses;
   * unwired, proposals carry no coverage and accept keeps the legacy shape.
   */
  coverage?: (userSessionId: string) => CompletionCoverageReport | null;
  /**
   * `config.completionQuietWindowMs`. The predicate is re-evaluated when the
   * timer FIRES, not when it was scheduled, so a new turn starting inside the
   * window simply makes it false again.
   */
  quietWindowMs: number;
  /** The whole-system pause: a paused run is quiet by decree, not done — evaluate holds. */
  paused?: () => boolean;
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
      // Queued "defer" rows never earn a turn on their own; a run whose last
      // recorded words were routine updates is still complete.
      if (repo.listActiveDeliveries(agentSession.id).some(consumptionPending)) return false;
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
    // Paused: nothing is proposed, discharged or nudged; the resume hook
    // reschedules every open run.
    if (this.#deps.paused?.()) return false;
    if (!this.isComplete(userSessionId)) {
      // Not done — but if the work has nonetheless gone quiet, the operator is
      // owed whatever exists. A run may end incomplete; it may never end in
      // silence, which is exactly how the 2026-08-12 run ended.
      try { this.#deps.host().dischargeQuietDebts(userSessionId); } catch { /* a backstop must not throw */ }
      return false;
    }
    if (!this.#reconciledChangeImpacts(userSessionId)) {
      this.#nudgeForChangeImpacts(userSessionId);
      return false;
    }
    const broken = this.#deps.workstreams?.brokenOpen(userSessionId) ?? [];
    if (broken.length > 0) {
      this.#nudgeForBrokenLinks(userSessionId, broken);
      return false;
    }
    if (!this.#completionRecordSatisfiesGoverning(userSessionId)) {
      this.#nudgeForCompletionRecord(userSessionId);
      return false;
    }
    this.#propose(userSessionId);
    return true;
  }

  /**
   * No unreconciled change impact may reach sign-off: an open impact is
   * console-owned proof that a revision, falsification, or withdrawn claim
   * touched evidence or work nobody has judged yet. The judgment itself stays
   * main's/the operator's — reopening, re-verifying, steering, or an explicit
   * stands/superseded/unaffected disposition all clear it.
   */
  #reconciledChangeImpacts(userSessionId: string): boolean {
    return (this.#deps.changeImpacts?.listOpen(userSessionId) ?? []).length === 0;
  }

  /**
   * The session a completion nudge is keyed on: the OLDEST top-level session,
   * deterministically. `listAgentSessions` returns newest-first, so a bare
   * `.find(top-level)` re-anchored every nudge onto whichever workstream main
   * commissioned last — an arbitrary choice that reshuffled as the run grew.
   */
  #nudgeAnchor(userSessionId: string): import("../db/repo.ts").AgentSessionRow | undefined {
    return this.#deps.repo.listAgentSessions(userSessionId)
      .filter((row) => row.parentAgentSessionId === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  }

  /** One nudge per (session, open-impact set). */
  readonly #nudgedForImpacts = new Map<string, string>();

  #nudgeForChangeImpacts(userSessionId: string): void {
    const open = this.#deps.changeImpacts?.listOpen(userSessionId) ?? [];
    if (open.length === 0) return;
    const key = open.map((impact) => impact.id).sort().join(",");
    if (this.#nudgedForImpacts.get(userSessionId) === key) return;
    const anchor = this.#nudgeAnchor(userSessionId);
    if (!anchor) return;
    this.#nudgedForImpacts.set(userSessionId, key);
    const lines = open.slice(0, 4).map((impact) => {
      const parts: string[] = [];
      if (impact.outstanding.claims.length > 0) parts.push(`stale terminal claims: ${impact.outstanding.claims.join(", ")}`);
      if (impact.outstanding.sessions.length > 0) parts.push(`affected sessions: ${impact.outstanding.sessions.join(", ")}`);
      return `${impact.id} (${impact.sourceKind} ${impact.sourceRef} — ${parts.join("; ")})`;
    });
    if (open.length > 4) lines.push(`…and ${open.length - 4} more (read_requirements lists them)`);
    this.#deps.runner().enqueueAgentMilestone(userSessionId, anchor.id, "decision",
      `The Console sees quiet sessions, but ${open.length} change impact(s) remain unreconciled: ${lines.join("; ")}. ` +
      "Judge each item: reopen or re-verify stale claims with report_requirement, steer or archive affected sessions, " +
      "and record every other judgment with reconcile_change_impact (stands / superseded / unaffected / steered / interrupted, with why). " +
      "The run will not propose completion until every impact is reconciled.");
  }

  /** One nudge per (session, broken-link set). */
  readonly #nudgedForBrokenLinks = new Map<string, string>();

  #nudgeForBrokenLinks(userSessionId: string, broken: import("@agentique-console/shared").WorkstreamLinkWire[]): void {
    const key = broken.map((wire) => wire.id).sort().join(",");
    if (this.#nudgedForBrokenLinks.get(userSessionId) === key) return;
    const anchor = this.#nudgeAnchor(userSessionId);
    if (!anchor) return;
    this.#nudgedForBrokenLinks.set(userSessionId, key);
    const lines = broken.slice(0, 4).map((wire) =>
      `${wire.id}: "${wire.consumerTitle}" (${wire.consumerAgentSessionId}) still awaits "${wire.subject}" from abandoned producer ${wire.producerAgentSessionId}`);
    if (broken.length > 4) lines.push(`…and ${broken.length - 4} more`);
    this.#deps.runner().enqueueAgentMilestone(userSessionId, anchor.id, "decision",
      `The Console sees quiet sessions, but ${broken.length} workstream dependency link(s) are broken — their producer was archived without reporting: ${lines.join("; ")}. ` +
      "Judge each: link the consumer to a successor with link_workstreams, release the stale link with unlink_workstreams (with why), or close the consumer if its work no longer matters. " +
      "The run will not propose completion while a broken link's consumer stays open.");
  }

  /**
   * The governing document is the completion oracle: quiet ledgers are not
   * enough — main must have verified THIS revision via record_completion. A
   * live run proposed "done" for a game with no window and no renderer
   * because the heuristic stopped at "the current wave's ledger is clean".
   * A requirement revision governs when one is approved (migration 0017
   * converted every legacy governing spec into an intent revision);
   * document-less runs keep the old behavior.
   */
  #completionRecordSatisfiesGoverning(userSessionId: string): boolean {
    const governing = this.#deps.requirements?.latestApproved(userSessionId);
    if (governing === undefined) return true;
    const record = this.#deps.orchestrationState?.latestCompletion(userSessionId);
    return record !== null && record !== undefined
      && record.completion.requirementsRevision === governing.revision;
  }

  /** One nudge per (session, governing revision). */
  readonly #nudgedForRevision = new Map<string, string>();

  #nudgeForCompletionRecord(userSessionId: string): void {
    const governing = this.#deps.requirements?.latestApproved(userSessionId);
    const revision = governing?.revision;
    if (revision === undefined) return;
    const revisionKey = `requirements:${revision}`;
    if (this.#nudgedForRevision.get(userSessionId) === revisionKey) return;
    const anchor = this.#nudgeAnchor(userSessionId);
    if (!anchor) return;
    this.#nudgedForRevision.set(userSessionId, revisionKey);
    if (governing !== undefined) {
      // Name the open requirements: the nudge is actionable exactly when it
      // says WHAT is unverified, not merely that something is.
      const frontier = (this.#deps.requirements?.frontier(userSessionId) ?? []).slice(0, 6);
      const openLine = frontier.length === 0 ? ""
        : ` Open requirements: ${frontier.map((entry) => `${entry.requirementId} (${entry.statement.slice(0, 80)})`).join("; ")}.`;
      // Verification debt is named beside the open frontier — advisory, like
      // everything in this nudge; the completion oracle never gates on it.
      const gaps = (this.#deps.requirements?.verificationGaps(userSessionId) ?? []).slice(0, 6);
      const gapLine = gaps.length === 0 ? ""
        : ` Satisfied below their declared verification: ${gaps.map((gap) => `${gap.requirementId} (needs ${gap.expected}, claimed ${gap.recorded.verifiedBy})`).join("; ")}.`;
      this.#deps.runner().enqueueAgentMilestone(userSessionId, anchor.id, "decision",
        `The Console sees quiet sessions and final reports, but no completion record against requirements rev ${revision}.${openLine}${gapLine} ` +
        "Verify and report_requirement with evidence, then record_completion (with requirementsRevision) — or name the gap and keep working; the run will not propose completion until then.");
      return;
    }
  }

  /** The graph's counts/outline/root at THIS moment — persisted with the summary. */
  #requirementsSnapshot(userSessionId: string) {
    const snapshot = this.#deps.requirements?.summarySnapshot(userSessionId) ?? null;
    if (snapshot === null) return null;
    return { ...snapshot, rootStatus: this.#deps.requirements!.rootStatus(userSessionId) };
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
      requirements: this.#requirementsSnapshot(userSessionId),
      coverage: this.#deps.coverage?.(userSessionId) ?? null,
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
        coverage: document.coverage === null ? null
          : { readiness: document.coverage.readiness, exceptions: document.coverage.exceptions.length },
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
  tailSummary(userSessionId: string): { id: "tail"; status: "proposed"; verdict: RunSummaryDocument["verdict"]; note: null; createdAt: string; resolvedAt: null; document: RunSummaryDocument; waivers: CompletionWaiver[] } {
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
      requirements: this.#requirementsSnapshot(userSessionId),
      coverage: this.#deps.coverage?.(userSessionId) ?? null,
      ...(this.#deps.getWorkspaceRoot ? { getWorkspaceRoot: this.#deps.getWorkspaceRoot } : {}),
    });
    return { id: "tail", status: "proposed", verdict: document.verdict, note: null,
      createdAt: nowIso(), resolvedAt: null, document, waivers: [] };
  }

  /**
   * The latest persisted summary's scalar facts plus granted waivers — the
   * continuation checkpoint's completion reference. Null when the run never
   * reached a proposal. A read, never a build: an abandoned run's absence of
   * a summary is itself the fact.
   */
  latestSummaryFacts(userSessionId: string): { summaryId: string; status: "proposed" | "accepted" | "changes_requested"; verdict: RunSummaryDocument["verdict"]; headline: string; waivers: CompletionWaiver[] } | null {
    const row = this.#deps.db.select().from(runSummaries)
      .where(eq(runSummaries.userSessionId, userSessionId))
      .orderBy(desc(runSummaries.createdAt)).get();
    if (!row) return null;
    const document = row.document as unknown as RunSummaryDocument;
    return { summaryId: row.id, status: row.status, verdict: row.verdict,
      headline: typeof document.headline === "string" ? document.headline : "",
      waivers: row.waivers ?? [] };
  }

  getSummary(userSessionId: string, summaryId: string): { id: string; status: "proposed" | "accepted" | "changes_requested"; verdict: RunSummaryDocument["verdict"]; note: string | null; createdAt: string; resolvedAt: string | null; document: RunSummaryDocument; waivers: CompletionWaiver[] } {
    const row = this.#deps.db.select().from(runSummaries).where(eq(runSummaries.id, summaryId)).get();
    if (!row || row.userSessionId !== userSessionId) throw new NotFoundError(`no run summary ${summaryId} in session ${userSessionId}`);
    // Summaries persisted before the requirements/coverage sections existed
    // have no key at all; normalize to null so old runs keep rendering.
    const stored = row.document as unknown as RunSummaryDocument;
    const document: RunSummaryDocument = {
      ...stored,
      requirements: stored.requirements === undefined ? null : stored.requirements,
      coverage: stored.coverage === undefined ? null : stored.coverage,
    };
    return { id: row.id, status: row.status, verdict: row.verdict, note: row.note,
      createdAt: row.createdAt, resolvedAt: row.resolvedAt, document, waivers: row.waivers ?? [] };
  }

  resolve(userSessionId: string, decision: "accept" | "changes", note?: string, waivers: SubmittedWaiver[] = []): void {
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
    // The exception gate runs BEFORE any write: a refused accept (missing
    // waivers) or a superseded proposal (meaning moved) must leave no
    // half-resolved row behind. Throws ConflictError on either.
    const granted = decision === "accept" ? this.#grantWaivers(userSessionId, summary, waivers, now) : [];
    if (summary) {
      db.update(runSummaries)
        .set({ status: decision === "accept" ? "accepted" : "changes_requested",
          ...(decision === "accept" ? { waivers: granted } : {}),
          ...(note === undefined ? {} : { note }), resolvedAt: now })
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

  /**
   * The project's meaning moved while a proposal was pending — an operator
   * requirement verdict, a falsified assumption, an amendment. The proposal
   * becomes visibly superseded rather than remaining silently actionable: the
   * card resolves as changes-requested with a superseded note, the run
   * reopens, and (still being quiet) it re-proposes against fresh coverage.
   * The accept-time recompute in #grantWaivers backstops any path not wired
   * through here. Returns whether a pending proposal was withdrawn.
   */
  noteMeaningChanged(userSessionId: string, why: string): boolean {
    const session = this.#deps.repo.getUserSession(userSessionId);
    if (session?.runState !== "awaiting_signoff") return false;
    const summary = this.#deps.db.select().from(runSummaries)
      .where(and(eq(runSummaries.userSessionId, userSessionId), eq(runSummaries.status, "proposed")))
      .orderBy(desc(runSummaries.createdAt)).get();
    this.#supersede(userSessionId, summary?.id, why);
    return true;
  }

  /**
   * Accept-time exception gate. Recomputes coverage FRESH (the persisted
   * report is what the operator read; the recomputation is what they are
   * accepting) and:
   * - supersedes the proposal and throws when the governing revision moved or
   *   reconciliation state reopened under it — an old acceptance must never
   *   close a changed objective;
   * - under waiver_required, refuses (409) unless every outstanding exception
   *   has a submitted waiver — typed, per condition, never blanket;
   * - returns the granted waivers: submitted entries matched to outstanding
   *   exceptions, stamped with the exception's detail (the accepted
   *   consequence), the revision, and the policy in force at proposal.
   *   Submitted waivers matching nothing are dropped, not recorded — a waiver
   *   is scoped to a condition that actually exists.
   * Legacy summaries (no coverage) gate nothing — old rows stay acceptable.
   */
  #grantWaivers(
    userSessionId: string,
    summary: { id: string; document: Record<string, unknown> } | undefined,
    submitted: SubmittedWaiver[],
    now: string,
  ): CompletionWaiver[] {
    const stored = (summary?.document as unknown as RunSummaryDocument | undefined)?.coverage ?? null;
    if (stored === null) return [];
    const fresh = this.#deps.coverage?.(userSessionId) ?? stored;
    if (fresh === null || fresh.revision !== stored.revision
      || fresh.reconciliation.openChangeImpacts > 0 || fresh.reconciliation.brokenWorkstreamLinks > 0) {
      this.#supersede(userSessionId, summary?.id, "the project changed after this proposal (requirements revision or reconciliation state moved); a fresh proposal will follow");
      throw new ConflictError("completion proposal superseded — the project changed after it was proposed; a fresh proposal will follow");
    }
    const submittedByKey = new Map(submitted.map((waiver) => [`${waiver.kind}:${waiver.ref}`, waiver]));
    const missing = fresh.exceptions.filter((exception) => !submittedByKey.has(`${exception.kind}:${exception.ref}`));
    if (stored.policy === "waiver_required" && missing.length > 0) {
      const lines = missing.slice(0, 6).map((exception) => `${exception.kind} ${exception.ref}`);
      if (missing.length > 6) lines.push(`…and ${missing.length - 6} more`);
      throw new ConflictError(
        `accepting this run requires an explicit waiver for each outstanding exception — missing: ${lines.join("; ")} (GET the run summary for details)`,
      );
    }
    return fresh.exceptions.flatMap((exception) => {
      const match = submittedByKey.get(`${exception.kind}:${exception.ref}`);
      if (match === undefined) return [];
      return [{
        kind: exception.kind, ref: exception.ref, detail: exception.detail,
        revision: fresh.revision, policy: stored.policy, decidedBy: "operator" as const, at: now,
        ...(match.note === undefined || match.note.trim() === "" ? {} : { note: match.note.trim() }),
      }];
    });
  }

  /** Withdraw a pending proposal visibly: card resolves superseded, run reopens, coverage recomputes on the next quiet evaluation. */
  #supersede(userSessionId: string, summaryId: string | undefined, why: string): void {
    const { db, repo, bus } = this.#deps;
    const note = `superseded — ${why}`;
    if (summaryId !== undefined) {
      db.update(runSummaries)
        .set({ status: "changes_requested", note, resolvedAt: nowIso() })
        .where(eq(runSummaries.id, summaryId)).run();
    }
    repo.patchUserSession(userSessionId, { runState: "active" });
    bus.append({ type: "run.signoff.resolved", userSessionId,
      payload: { userSessionId, runId: summaryId ?? "", decision: "changes", note } });
    bus.append({ type: "run.reopened", userSessionId,
      payload: { userSessionId, runId: summaryId ?? "", reason: "superseded" } });
    bus.append({ type: "user_session.updated", userSessionId,
      payload: { userSessionId, patch: { runState: "active" } } });
    // Deliberately NO operator message is synthesized — the cause is already
    // on the record. A still-quiet run simply re-proposes with fresh coverage.
    this.schedule(userSessionId);
  }

}
