/**
 * Continuation checkpoints: the run-boundary operational handoff between
 * sequential UserSessions on one project.
 *
 * A continued project already inherits its TRUTH — requirements, decisions,
 * assumptions, decision issues, change impacts are project-scoped. What dies
 * with the previous UserSession is its OPERATIONAL memory: main's recorded
 * strategy and why, the risks and uncertainties it was tracking, which
 * workstreams never reported, which couplings were still pending, which gaps
 * the operator explicitly accepted, and where unlanded work was salvaged to.
 * This service snapshots exactly that, once, when a work session is archived.
 *
 * Doctrine, matching the change-impact ledger:
 * - The CONSOLE derives every fact from durable rows (references and bounded
 *   summaries, never copies of governing meaning); the SYNTHESIS is the prior
 *   main's own last recorded working state, copied verbatim and labeled
 *   model-authored wherever it is read. Nothing here consults a model, so a
 *   checkpoint can be produced for an interrupted or abandoned run exactly as
 *   for an accepted one — synthesis is simply absent when none was recorded.
 * - Checkpoints are IMMUTABLE revisions, one per source session (unique
 *   index): retried archival, restarts, and the attach-time backstop all
 *   converge on the same row. The latest prior checkpoint — by source-session
 *   run order — is the one a continued session reads.
 * - A checkpoint is context, never governing truth: the digest labels it,
 *   binds it to the requirement revision it was written at, and warns when
 *   the project has moved since. It transfers KNOWLEDGE, never process — no
 *   provider session, AgentSession, task, or scheduled assignment is revived
 *   by anything here.
 * - Creation must never block the boundary itself: callers wrap record paths
 *   so a failed checkpoint degrades continuation to project truth instead of
 *   refusing archival or attach.
 */
import type {
  ChangeImpactWire,
  ContinuationCheckpointWire,
  ContinuationFacts,
  ContinuationSynthesis,
  DecisionIssueWire,
  Task,
  WorkstreamLinkWire,
} from "@agentique-console/shared";
import type { ContinuationCheckpointRow, ContinuationCheckpointStore } from "../db/stores/continuation-store.ts";
import type { AgentRow, AgentSessionRow, UserSessionRow } from "../db/stores/session-store.ts";
import type { OrchestrationStateRow } from "../db/stores/state-store.ts";
import type { EventBus } from "../events/bus.ts";
import { NotFoundError } from "../errors.ts";
import type { CompletionRecord } from "../orchestrator/state.ts";

/** The digest's byte budget — between the state digest (2K) and decisions (4K). */
const DIGEST_MAX_BYTES = 4 * 1024;
/** Per-list cap on recorded facts; entries are references, so 40 mirrors the decision digest's entry cap. */
const FACTS_LIST_MAX = 40;

const clip = (text: string, max = 120): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** Narrow read closures over other aggregates' facts — wired once in createApp. */
export interface ContinuationDeps {
  getUserSession(userSessionId: string): UserSessionRow | undefined;
  listUserSessionsForProject(projectId: string): UserSessionRow[];
  listAgentSessions(userSessionId: string): AgentSessionRow[];
  listAgents(agentSessionId: string): AgentRow[];
  /** THE "has this session reported?" predicate (OperatorSurface.reportedFinal) — handoff-derived, so it survives archival. */
  reportedFinal(session: AgentSessionRow): boolean;
  listTasks(userSessionId: string): Task[];
  /** The current approved requirement revision (0 = none governs). */
  governingRevision(userSessionId: string): number;
  /** Decision-ledger length — the checkpoint's second currency hint. */
  decisionCount(userSessionId: string): number;
  listOpenChangeImpacts(userSessionId: string): ChangeImpactWire[];
  listOpenDecisionIssues(userSessionId: string): DecisionIssueWire[];
  listWorkstreamLinks(userSessionId: string): WorkstreamLinkWire[];
  /** Main's latest working-state revision — the synthesis source. */
  latestState(userSessionId: string): OrchestrationStateRow | undefined;
  /** Main's latest record_completion, when one exists. */
  latestCompletion(userSessionId: string): { revision: number; completion: CompletionRecord } | null;
  /** The latest run summary's scalar facts + granted waivers (RunCompletionService.latestSummaryFacts). */
  latestSummaryFacts(userSessionId: string): {
    summaryId: string;
    status: "proposed" | "accepted" | "changes_requested";
    verdict: string;
    headline: string;
    waivers: { kind: import("@agentique-console/shared").CoverageExceptionKind; ref: string; detail: string; note?: string }[];
  } | null;
}

export class ContinuationCheckpointService {
  readonly #store: ContinuationCheckpointStore;
  readonly #bus: EventBus;
  #deps: ContinuationDeps | null = null;

  constructor(store: ContinuationCheckpointStore, bus: EventBus) {
    this.#store = store;
    this.#bus = bus;
  }

  /** Wired once in createApp — the builder reads other aggregates' facts. */
  setDeps(deps: ContinuationDeps): void {
    this.#deps = deps;
  }

  #requireDeps(): ContinuationDeps {
    if (this.#deps === null) throw new Error("ContinuationCheckpointService deps not wired — call setDeps in createApp");
    return this.#deps;
  }

  /**
   * Record the checkpoint for one source session at its run boundary.
   * Idempotent: the unique source index returns the existing row on a retry,
   * a restart replay, or the attach-time backstop racing an eager record.
   * Declines (null) for non-work sessions and for a session with nothing to
   * hand off — no synthesis, no completion, and empty facts would only add a
   * hollow block to the successor's prompt.
   */
  record(sourceUserSessionId: string): ContinuationCheckpointWire | null {
    const deps = this.#requireDeps();
    const session = deps.getUserSession(sourceUserSessionId);
    if (!session || session.purpose !== "work") return null;

    const synthesis = this.#synthesisOf(sourceUserSessionId);
    const facts = this.#factsOf(sourceUserSessionId);
    const empty = synthesis === null && facts.completion === null
      && facts.waivers.length === 0 && facts.knownGaps.length === 0 && facts.nonGoals.length === 0
      && facts.unfinishedWorkstreams.length === 0 && facts.pendingWorkstreamLinks.length === 0
      && facts.openChangeImpacts.length === 0 && facts.openDecisionIssues.length === 0
      && facts.salvage.length === 0;
    if (empty) return null;

    const { row, inserted } = this.#store.insert({
      projectId: session.projectId,
      sourceUserSessionId,
      atRevision: deps.governingRevision(sourceUserSessionId),
      decisionCount: deps.decisionCount(sourceUserSessionId),
      runState: session.runState,
      synthesis,
      facts,
    });
    if (inserted) {
      this.#bus.append({
        type: "project.continuation.recorded",
        userSessionId: sourceUserSessionId,
        payload: {
          userSessionId: sourceUserSessionId,
          projectId: session.projectId,
          checkpointId: row.id,
          atRevision: row.atRevision,
          runState: row.runState,
          hasSynthesis: row.synthesis !== null,
          counts: {
            unfinishedWorkstreams: facts.unfinishedWorkstreams.length,
            openChangeImpacts: facts.openChangeImpacts.length,
            openDecisionIssues: facts.openDecisionIssues.length,
            waivers: facts.waivers.length,
          },
        },
      });
    }
    return this.#toWire(row);
  }

  /**
   * The attach-time backstop: before a new session continues a project, make
   * sure its most recent archived work session has a checkpoint. Covers a
   * crash between the archive patch and the eager record, and every archive
   * that predates checkpoints — project truth is frozen while no session is
   * open, so a late build reads the same durable facts an eager one did.
   * Only the LATEST predecessor is backfilled: older gaps stay historical.
   */
  ensureForProject(projectId: string): void {
    const deps = this.#requireDeps();
    const archived = deps.listUserSessionsForProject(projectId)
      .filter((row) => row.lifecycle === "archived" && row.purpose === "work");
    const latest = archived[archived.length - 1];
    if (latest === undefined) return;
    if (this.#store.getBySource(latest.id) !== undefined) return;
    this.record(latest.id);
  }

  /**
   * The checkpoint a session inherits: the latest one in its project sourced
   * from a DIFFERENT session, in source-session run order (a lazily
   * backfilled row may be INSERTED after a successor's, so insertion order
   * would misorder history). Null on a fresh project — and null is rendered
   * as an EMPTY digest, never a placeholder block.
   */
  latestForSession(userSessionId: string): ContinuationCheckpointWire | null {
    const deps = this.#requireDeps();
    const session = deps.getUserSession(userSessionId);
    if (!session) return null;
    const rows = this.#rowsInRunOrder(session.projectId)
      .filter((row) => row.sourceUserSessionId !== userSessionId);
    const latest = rows[rows.length - 1];
    return latest === undefined ? null : this.#toWire(latest);
  }

  /** Every checkpoint in the session's project, run-ordered — the read tool's history listing. */
  listForSession(userSessionId: string): ContinuationCheckpointWire[] {
    const deps = this.#requireDeps();
    const session = deps.getUserSession(userSessionId);
    if (!session) throw new NotFoundError(`no user session ${userSessionId}`);
    return this.#rowsInRunOrder(session.projectId).map((row) => this.#toWire(row));
  }

  /** One checkpoint by id, project-checked like every other project aggregate read. */
  get(userSessionId: string, checkpointId: string): ContinuationCheckpointWire {
    const deps = this.#requireDeps();
    const session = deps.getUserSession(userSessionId);
    const row = this.#store.get(checkpointId);
    if (!session || !row || row.projectId !== session.projectId) {
      throw new NotFoundError(`no continuation checkpoint ${checkpointId} in this project`);
    }
    return this.#toWire(row);
  }

  /**
   * The bounded prompt block a continued session's orchestrator reads. Empty
   * when the project has no prior checkpoint (prompt-cache byte-stability
   * rule). Sections render in priority order — unresolved debt first,
   * strategy, risks, portfolio, accepted gaps, references last — and drop
   * from the bottom when the byte budget runs out; everything dropped stays
   * one read_continuation call away.
   */
  digest(userSessionId: string): string {
    const wire = this.latestForSession(userSessionId);
    if (wire === null) return "";
    const currentRevision = this.#requireDeps().governingRevision(userSessionId);

    const ended = wire.runState === "completed" ? "accepted at sign-off"
      : wire.runState === "awaiting_signoff" ? "archived while awaiting sign-off"
      : "archived before completion";
    const title = wire.sourceTitle === null ? wire.sourceUserSessionId : `"${wire.sourceTitle}"`;
    const header =
      `## Prior-run continuation checkpoint (from ${title}, ${ended}, requirements rev ${wire.atRevision})\n` +
      "Operational context from this project's previous run. The strategy and risks are the PREVIOUS main's model-authored working state — not operator-approved meaning and not governing truth. " +
      "Current requirements, decisions, and reconciliation state outrank everything here; reconcile before relying on it, revise freely, and commission fresh sessions for any work you continue — nothing from the prior run resumes on its own. " +
      "read_continuation returns the full checkpoint." +
      (currentRevision > wire.atRevision
        ? `\nSTALE: written at requirements rev ${wire.atRevision}; rev ${currentRevision} now governs — parts of this may no longer apply.`
        : "");

    const facts = wire.facts;
    const sections: string[] = [];
    if (facts.openChangeImpacts.length > 0) {
      sections.push("Unreconciled change impacts (prior evidence may be stale; read_requirements lists them):\n"
        + facts.openChangeImpacts.map((impact) =>
          `- ${impact.id} (${impact.sourceKind} ${impact.sourceRef}) — suspect claims: ${impact.suspectClaims.join(", ")}`).join("\n"));
    }
    if (facts.openDecisionIssues.length > 0) {
      sections.push("Open decision issues (list_decision_issues has detail):\n"
        + facts.openDecisionIssues.map((issue) => `- ${issue.id}: ${issue.subject}`).join("\n"));
    }
    if (wire.synthesis !== null) {
      const s = wire.synthesis;
      const lines = [
        ...(s.strategy ? [`Strategy then: ${s.strategy}${s.strategyWhy ? ` — ${s.strategyWhy}` : ""}`] : []),
        ...s.risks.map((item) => `Risk: ${item}`),
        ...s.uncertainties.map((item) => `Uncertain: ${item}`),
        ...s.assumptions.map((item) => `Working assumption: ${item}`),
      ];
      if (lines.length > 0) sections.push(lines.join("\n"));
    }
    if (facts.unfinishedWorkstreams.length > 0) {
      sections.push("Unfinished workstreams (their AgentSessions are archived and will NOT resume — recommission or drop deliberately):\n"
        + facts.unfinishedWorkstreams.map((ws) =>
          `- "${ws.title}" (${ws.agentSessionId}) — no final report${ws.openTasks > 0 ? `; ${ws.openTasks} open ledger task(s)` : ""}`).join("\n"));
    }
    if (facts.pendingWorkstreamLinks.length > 0) {
      sections.push("Undelivered workstream couplings at the boundary:\n"
        + facts.pendingWorkstreamLinks.map((link) =>
          `- "${link.consumerTitle}" awaited "${link.subject}" from "${link.producerTitle}" [${link.status}]`).join("\n"));
    }
    const accepted = [
      ...facts.waivers.map((waiver) => `- waived at sign-off: ${waiver.kind} ${waiver.ref}${waiver.note ? ` (${waiver.note})` : ""}`),
      ...facts.knownGaps.map((gap) => `- known gap: ${gap}`),
      ...facts.nonGoals.map((nonGoal) => `- non-goal: ${nonGoal}`),
    ];
    if (accepted.length > 0) {
      sections.push("Accepted gaps and non-goals from the prior run (accepted THEN — decide whether they still stand, not silently permanent):\n"
        + accepted.join("\n"));
    }
    if (facts.salvage.length > 0) {
      sections.push("Salvaged unlanded work (branches/diff artifacts preserved at archival):\n"
        + facts.salvage.map((entry) =>
          `- ${entry.agent} (${entry.agentSessionId})${entry.branch === null ? "" : ` branch ${entry.branch}`}${entry.artifactId === null ? "" : ` artifact ${entry.artifactId}`}`).join("\n"));
    }
    if (facts.completion !== null) {
      sections.push(`Prior completion: ${facts.completion.status} (${facts.completion.verdict}) — ${facts.completion.headline} [summary ${facts.completion.summaryId}]`);
    }

    let body = header;
    let dropped = 0;
    const marker = "\n…(truncated — read_continuation has the rest)";
    for (const section of sections) {
      const candidate = `${body}\n\n${section}`;
      if (Buffer.byteLength(candidate + marker, "utf8") > DIGEST_MAX_BYTES) { dropped += 1; continue; }
      body = candidate;
    }
    return dropped > 0 ? body + marker : body;
  }

  /** The synthesis snapshot: the source main's latest merged working state, verbatim. */
  #synthesisOf(sourceUserSessionId: string): ContinuationSynthesis | null {
    const state = this.#requireDeps().latestState(sourceUserSessionId);
    if (state === undefined) return null;
    const empty = state.strategy === "" && state.uncertainties.length === 0
      && state.assumptions.length === 0 && state.risks.length === 0;
    if (empty) return null;
    return {
      stateRevision: state.revision,
      strategy: state.strategy,
      strategyWhy: state.strategyWhy,
      uncertainties: state.uncertainties,
      assumptions: state.assumptions,
      risks: state.risks,
    };
  }

  /**
   * Console-derived facts, all from durable rows — computed identically at an
   * eager (archive-time) and a lazy (attach-time) record:
   * - unfinished = top-level AgentSessions without a final report (handoff-
   *   derived, unaffected by archival), with their open ledger-task counts;
   * - couplings = live workstream links not satisfied;
   * - impacts = only those held open by STANDING suspect claims (session
   *   items die with the run's archival and are deliberately not carried);
   * - issues/waivers/gaps/salvage by reference, clipped for row size.
   */
  #factsOf(sourceUserSessionId: string): ContinuationFacts {
    const deps = this.#requireDeps();
    const tasks = deps.listTasks(sourceUserSessionId);
    const openTaskCount = new Map<string, number>();
    for (const task of tasks) {
      if (task.status !== "pending" && task.status !== "in_progress") continue;
      if (task.agentSessionId === null) continue;
      openTaskCount.set(task.agentSessionId, (openTaskCount.get(task.agentSessionId) ?? 0) + 1);
    }

    const agentSessions = deps.listAgentSessions(sourceUserSessionId);
    const unfinished = agentSessions
      .filter((session) => session.parentAgentSessionId === null && !deps.reportedFinal(session))
      .map((session) => ({
        agentSessionId: session.id,
        title: clip(session.title),
        openTasks: openTaskCount.get(session.id) ?? 0,
      }));

    const salvage = agentSessions.flatMap((session) =>
      deps.listAgents(session.id)
        .filter((agent) => agent.salvageBranch !== null || agent.salvageArtifactId !== null)
        .map((agent) => ({
          agentSessionId: session.id,
          agent: agent.name,
          branch: agent.salvageBranch,
          artifactId: agent.salvageArtifactId,
        })));

    const pendingLinks = deps.listWorkstreamLinks(sourceUserSessionId)
      .filter((link) => link.status === "pending" || link.status === "broken")
      .map((link) => ({
        linkId: link.id,
        subject: clip(link.subject),
        consumerTitle: clip(link.consumerTitle),
        producerTitle: clip(link.producerTitle),
        status: link.status,
      }));

    const openImpacts = deps.listOpenChangeImpacts(sourceUserSessionId)
      .filter((impact) => impact.outstanding.claims.length > 0)
      .map((impact) => ({
        id: impact.id,
        sourceKind: impact.sourceKind,
        sourceRef: impact.sourceRef,
        suspectClaims: impact.outstanding.claims,
      }));

    const openIssues = deps.listOpenDecisionIssues(sourceUserSessionId)
      .map((issue) => ({ id: issue.id, subject: clip(issue.subject) }));

    const summary = deps.latestSummaryFacts(sourceUserSessionId);
    const completionRecord = deps.latestCompletion(sourceUserSessionId);

    return {
      completion: summary === null ? null : {
        summaryId: summary.summaryId, status: summary.status,
        verdict: summary.verdict, headline: clip(summary.headline, 200),
      },
      waivers: (summary?.waivers ?? []).slice(0, FACTS_LIST_MAX)
        .map((waiver) => ({ kind: waiver.kind, ref: waiver.ref, detail: clip(waiver.detail, 200),
          ...(waiver.note === undefined ? {} : { note: clip(waiver.note, 200) }) })),
      knownGaps: (completionRecord?.completion.knownGaps ?? []).slice(0, FACTS_LIST_MAX),
      nonGoals: (completionRecord?.completion.nonGoals ?? []).slice(0, FACTS_LIST_MAX),
      unfinishedWorkstreams: unfinished.slice(0, FACTS_LIST_MAX),
      pendingWorkstreamLinks: pendingLinks.slice(0, FACTS_LIST_MAX),
      openChangeImpacts: openImpacts.slice(0, FACTS_LIST_MAX),
      openDecisionIssues: openIssues.slice(0, FACTS_LIST_MAX),
      salvage: salvage.slice(0, FACTS_LIST_MAX),
    };
  }

  /** Rows ordered by their SOURCE SESSION's creation — the project's run order. */
  #rowsInRunOrder(projectId: string): ContinuationCheckpointRow[] {
    const deps = this.#requireDeps();
    const order = new Map(deps.listUserSessionsForProject(projectId).map((row, index) => [row.id, index]));
    return this.#store.listByProject(projectId)
      .sort((a, b) => (order.get(a.sourceUserSessionId) ?? -1) - (order.get(b.sourceUserSessionId) ?? -1));
  }

  #toWire(row: ContinuationCheckpointRow): ContinuationCheckpointWire {
    const source = this.#requireDeps().getUserSession(row.sourceUserSessionId);
    return {
      id: row.id,
      projectId: row.projectId,
      sourceUserSessionId: row.sourceUserSessionId,
      sourceTitle: source?.title ?? null,
      runState: row.runState,
      atRevision: row.atRevision,
      decisionCount: row.decisionCount,
      synthesis: row.synthesis,
      facts: row.facts,
      createdAt: row.createdAt,
    };
  }
}
