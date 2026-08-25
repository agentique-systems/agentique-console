/**
 * The end-of-run report the operator actually reads.
 *
 * Assembled from facts the console owns and PERSISTED, not recomputed: the reap
 * counts are in-memory and unrecoverable a second later, and worktree diffs are
 * taken against branches that archival renames.
 *
 * The rule that governs the whole file: say what is true, and say how sure you
 * are. A confident number that is quietly wrong is worse than a number with a
 * caveat attached — which is why `cost.coverage` exists.
 */
import { execFileSync } from "node:child_process";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import type { RunSummaryDocument } from "@agentique-console/shared";
import type { ConsoleEvent } from "@agentique-console/shared";
import type { Db } from "../db/client.ts";
import type { Repo } from "../db/repo.ts";
import type { InteractionService } from "../orchestrator/interactions.ts";
import { events, handoffRecords, tasks, usageSamples } from "../db/schema.ts";

/** The one row→union cast; every read below narrows on `type` from here. */
function typed(row: Pick<typeof events.$inferSelect, "type" | "payload">): ConsoleEvent {
  return { type: row.type, payload: row.payload } as ConsoleEvent;
}

/**
 * Seats whose provider process was released. Everything an agent started —
 * a background `Bash` server, an MCP server's browser — is a child of that
 * process, so releasing the seat releases them; the Console keeps no process
 * table of its own to sweep.
 */
export interface ReapResult {
  seats: { agentSessionId: string; agent: string }[];
}

// RunSummaryDocument now lives in shared/src/api.ts (the sign-off card
// renders it); re-exported here for server-internal imports.
export type { RunSummaryDocument };

export interface BuildRunSummaryInput {
  db: Db;
  repo: Repo;
  interactions: InteractionService;
  userSessionId: string;
  seqFrom: number;
  reaped: ReapResult;
  getWorkspaceRoot?: (workspaceId: string) => string;
  /** Main's latest record_completion, when one exists. */
  completionRecord?: { revision: number; completion: import("../orchestrator/state.ts").CompletionRecord } | null;
  /**
   * The requirement graph at proposal time: status counts, the rendered
   * outline (persisted with the summary — a later amendment must not rewrite
   * an old report), and the console-derived root status. Null = pre-graph run.
   */
  requirements?: {
    revision: number;
    counts: Record<import("@agentique-console/shared").RequirementStatus, number>;
    outline: string;
    /** Satisfied leaves below their declared verification tier — journal facts, display only. */
    verificationGaps: import("@agentique-console/shared").RequirementVerificationGap[];
    /** Terminal claims the run later withdrew — journal facts, display only, never a verdict input. */
    reversals: import("@agentique-console/shared").RequirementReversal[];
    rootStatus: import("@agentique-console/shared").RequirementStatus;
  } | null;
  /**
   * The completion coverage report at proposal time — persisted COMPLETE with
   * the summary (obligations are never truncated to stay card-sized; the card
   * bounds its display). Null when no requirement graph governs.
   */
  coverage?: import("@agentique-console/shared").CompletionCoverageReport | null;
}

/** Total covered by a set of intervals, counting overlap once. */
export function unionDuration(intervals: readonly { start: number; end: number }[]): number {
  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = -Infinity;
  for (const interval of sorted) {
    const from = Math.max(interval.start, cursor);
    if (interval.end > from) {
      total += interval.end - from;
      cursor = interval.end;
    }
  }
  return total;
}

export function buildRunSummary(input: BuildRunSummaryInput): RunSummaryDocument {
  const { db, repo, userSessionId, seqFrom, reaped } = input;
  const window = db.select().from(events)
    .where(and(eq(events.userSessionId, userSessionId), gte(events.seq, seqFrom)))
    .orderBy(asc(events.seq)).all();
  // An empty window consumed nothing: seqTo must stay BELOW seqFrom, or the
  // next summary's cursor (seqTo + 1) silently skips one future seq.
  const seqTo = window.length > 0 ? (window[window.length - 1]!.seq ?? seqFrom) : seqFrom - 1;
  const first = window[0]?.createdAt;
  const last = window[window.length - 1]?.createdAt;
  const durationMs = first && last ? Math.max(0, Date.parse(last) - Date.parse(first)) : 0;

  // Dead air = wall clock minus the UNION of every turn across both lanes.
  // Summing per-lane busy time would double-count concurrency and report
  // negative idle on a parallel run.
  const turnStarts = new Map<string, number>();
  const intervals: { start: number; end: number }[] = [];
  for (const row of window) {
    const at = Date.parse(row.createdAt);
    const event = typed(row);
    if (event.type === "user_session.turn.started" || event.type === "agent_session.turn.started") {
      turnStarts.set(event.payload.turnId, at);
    } else if (event.type === "user_session.turn.settled" || event.type === "agent_session.turn.settled") {
      const start = turnStarts.get(event.payload.turnId);
      if (start !== undefined) { intervals.push({ start, end: at }); turnStarts.delete(event.payload.turnId); }
    }
  }
  const deadAirMs = Math.max(0, durationMs - unionDuration(intervals));

  const finals = repo.listAgentSessions(userSessionId)
    .map((session) => repo.latestHandoff({ userSessionId, agentSessionId: session.id, recipient: "main", excludeCheckpoints: true }))
    .filter((row): row is NonNullable<typeof row> => row !== undefined && row.trigger === "final");
  const headline = finals[0]?.core.result.summary ?? finals[0]?.core.state.summary ?? "The run reported a result.";

  const ledger = db.select().from(tasks).where(eq(tasks.userSessionId, userSessionId)).all();
  const live = ledger.filter((task) => task.status !== "deleted");
  const open = live.filter((task) => task.status !== "completed");
  const ledgerUpdatedAt = live.reduce<string | null>((latest, task) => (latest === null || task.updatedAt > latest ? task.updatedAt : latest), null);

  // Cost, with its own honesty valve. `observedTurns` counts settle events;
  // `recordedTurns` counts usage rows. When they disagree the figure is
  // labelled partial rather than reported as if complete.
  const usage = db.select().from(usageSamples).where(eq(usageSamples.userSessionId, userSessionId)).all()
    .filter((row) => !row.turnId.startsWith("checkpoint:"));
  const observedTurns = window.filter((row) => row.type === "user_session.turn.settled" || row.type === "agent_session.turn.settled").length;
  const recordedTurns = usage.length;
  const costed = usage.filter((row) => row.costUsd !== null);
  const byParticipant = [...new Set(usage.map((row) => row.participant))].map((participant) => {
    const rows = usage.filter((row) => row.participant === participant);
    const withCost = rows.filter((row) => row.costUsd !== null);
    return {
      participant,
      usd: withCost.length === 0 ? null : round(withCost.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)),
      turns: rows.length,
    };
  }).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));

  const decisions = db.select().from(events)
    .where(and(eq(events.userSessionId, userSessionId), eq(events.type, "operator.decision.recorded"), gte(events.seq, seqFrom)))
    .all()
    .map(typed)
    .flatMap((event) => event.type === "operator.decision.recorded"
      ? [{ question: event.payload.question, answer: event.payload.answer, askedBy: event.payload.askedBy }]
      : []);

  const deviations = [...collectDeviations(window, open.map((task) => task.subject)), ...unmergedBranches(repo, userSessionId)];
  const uncertainty = [...new Set([
    ...finals.flatMap((row) => row.core.uncertainty),
    ...input.interactions.listPending(userSessionId).map((row) =>
      ((row.payload as { questions?: { question: string }[] }).questions ?? []).map((q) => q.question).join(" | ")),
  ])].filter((line) => line.trim() !== "");

  // Retries are counted from the structured `*.retry.recorded` events the SDK
  // adapters emit, never by pattern-matching runtime prose.
  const retries = window.map(typed).filter(
    (event): event is Extract<ConsoleEvent, { type: "user_session.retry.recorded" | "agent_session.retry.recorded" }> =>
      event.type === "user_session.retry.recorded" || event.type === "agent_session.retry.recorded");
  const friction = {
    apiRetries: retries.filter((event) => event.payload.kind === "api_error").length,
    rateLimited: retries.filter((event) => event.payload.kind === "rate_limited").length,
    failedTurns: window.map(typed).filter((event) =>
      (event.type === "user_session.turn.settled" || event.type === "agent_session.turn.settled") && event.payload.status === "error").length,
    watchdogTrips: window.filter((row) => row.type === "agent_session.watchdog").length,
    capacityPauses: window.filter((row) => row.type === "run.capacity.paused").length,
  };

  const build = collectBuild(db, repo, userSessionId, input.getWorkspaceRoot);
  // An honestly-unmet acceptance criterion caps the verdict: the sign-off
  // card must never read "completed" over a criterion the orchestrator
  // itself recorded as not met. The requirement graph tightens this further:
  // a console-derived infeasible ROOT is its own verdict (a legitimate
  // non-success ending, not a failure to hide), and open or violated
  // requirements cap at completed_with_caveats exactly like open tasks.
  const unmetCriteria = (input.completionRecord?.completion.criteria ?? []).some((entry) => !entry.met);
  const requirementState = input.requirements ?? null;
  const openRequirements = requirementState !== null
    && (requirementState.counts.open > 0 || requirementState.counts.violated > 0);
  // Coverage exceptions cap the verdict too: "completed" must mean ready with
  // ZERO exceptions — a stale claim or an under-verified satisfied leaf is a
  // caveat even when every requirement reads terminal.
  const coverage = input.coverage ?? null;
  const coverageExceptions = coverage !== null && coverage.exceptions.length > 0;
  const verdict: RunSummaryDocument["verdict"] =
    finals.some((row) => row.core.status === "failed") ? "failed"
      : requirementState?.rootStatus === "infeasible" ? "infeasible"
        : open.length > 0 || uncertainty.length > 0 || deviations.length > 0 || unmetCriteria || openRequirements || coverageExceptions ? "completed_with_caveats"
          : "completed";

  return {
    seqFrom, seqTo, verdict, headline, durationMs, deadAirMs,
    build,
    tasks: { completed: live.length - open.length, total: live.length, open: open.map((task) => task.subject), ledgerUpdatedAt },
    cost: {
      usd: costed.length === 0 ? null : round(costed.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)),
      coverage: observedTurns === 0 ? 1 : Math.min(1, recordedTurns / observedTurns),
      recordedTurns, observedTurns,
      inputTokens: usage.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: usage.reduce((sum, row) => sum + row.outputTokens, 0),
      byParticipant,
    },
    decisions, deviations, uncertainty,
    justification: input.completionRecord ? { revision: input.completionRecord.revision, ...input.completionRecord.completion } : null,
    requirements: requirementState === null ? null
      : { revision: requirementState.revision, counts: requirementState.counts, outline: requirementState.outline,
        verificationGaps: requirementState.verificationGaps, reversals: requirementState.reversals },
    coverage,
    resources: {
      reapedSeats: reaped.seats.length,
      detail: reaped.seats.map((seat) => `${seat.agentSessionId}:${seat.agent}`),
    },
    friction,
  };
}

/**
 * What the run did not do as asked — assembled from console-owned facts only.
 * No model pass: a generated list of "things the operator wanted" would read
 * as authoritative and be unverifiable, which is the wrong trade in a document
 * whose whole job is to be trustworthy.
 */
function collectDeviations(window: readonly (typeof events.$inferSelect)[], openTasks: readonly string[]): string[] {
  const out: string[] = [];
  for (const row of window) {
    const event = typed(row);
    if (event.type === "handoff.final.caveats") {
      for (const caveat of event.payload.caveats) out.push(caveat);
    }
    if (event.type === "agent_session.closeout.forced") {
      out.push("A coordinator went idle without reporting; the Console closed the loop from the journal.");
    }
    if (event.type === "handoff.final.blocked") {
      out.push("A final report was withheld while operator questions were open.");
    }
  }
  for (const subject of openTasks) out.push(`Ledger unit never completed: ${subject}`);
  return [...new Set(out)];
}

/**
 * "What was built", best source first. Records WHICH source it used, because
 * a file list from a handoff is a model's claim and a git diff is a fact.
 *
 * The fact: `git diff --numstat <run_base_commit>` — the working tree against
 * the commit captured when the run's first agent session was created. Diffing
 * against the WORKING TREE (not HEAD) is deliberate: an agent running without a
 * worktree writes directly and commits nothing, and its files must still
 * count.
 */
/**
 * Seat work that never reached the workspace. A deliverable stranded on an
 * unmerged branch under the Console's data dir is invisible to the operator —
 * one whole run's output sat there while its workspace read as empty — so the
 * sign-off card names the branch rather than letting it disappear quietly.
 */
function unmergedBranches(repo: Repo, userSessionId: string): string[] {
  const seats = repo.listAgentSessions(userSessionId)
    .filter((session) => session.lifecycle === "open")
    .flatMap((session) => repo.listAgents(session.id));
  return [
    ...seats
      .filter((seat) => seat.worktreeBranch !== null && seat.worktreePath !== null)
      .map((seat) => `${seat.name}'s work is still on unmerged branch ${seat.worktreeBranch} — it is not in the workspace`),
    // A discarded seat has its worktree columns nulled, so without this the
    // archived branch (infra failure / merge conflict) vanishes from sign-off.
    ...seats
      .filter((seat) => seat.worktreePath === null && seat.salvageBranch !== null)
      .map((seat) => `${seat.name}'s failed-turn work is archived on branch ${seat.salvageBranch}${seat.salvageArtifactId ? ` (diff artifact ${seat.salvageArtifactId})` : ""} — it is not in the workspace`),
  ];
}

function collectBuild(
  db: Db,
  repo: Repo,
  userSessionId: string,
  getWorkspaceRoot?: (workspaceId: string) => string,
): RunSummaryDocument["build"] {
  const session = repo.getUserSession(userSessionId);
  if (session?.runBaseCommit && getWorkspaceRoot) {
    try {
      const root = getWorkspaceRoot(session.workspaceId);
      // 64MB, not the 1MB default: `ls-files --others` over a workspace whose
      // .gitignore misses a build dir (a live Rust run committed none of
      // target/) exceeds 1MB and ENOBUFS here killed the whole run summary.
      const git = (args: string[]): string =>
        execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }).trim();
      const numstat = git(["diff", "--numstat", session.runBaseCommit]);
      // A run's most common product is NEW files, which `git diff` does not
      // list until something commits them — count the untracked ones too.
      const untracked = git(["ls-files", "--others", "--exclude-standard"]);
      const files = [...new Set([
        ...(numstat === "" ? [] : numstat.split("\n")).map((line) => line.split("\t")[2]),
        ...(untracked === "" ? [] : untracked.split("\n")),
      ])].filter((file): file is string => file !== undefined && file !== "");
      if (files.length > 0) return { filesChanged: files.length, files: [...files].sort(), source: "git" };
    } catch { /* not a repo, base gone, git missing — fall to the model's claim */ }
  }
  const agentSessionIds = repo.listAgentSessions(userSessionId).map((row) => row.id);
  if (agentSessionIds.length > 0) {
    const records = db.select().from(handoffRecords)
      .where(inArray(handoffRecords.agentSessionId, agentSessionIds)).all();
    const files = new Set<string>();
    for (const record of records) {
      const data = record.extension.data as { changedPaths?: string[] };
      for (const path of data.changedPaths ?? []) files.add(path);
      for (const artifact of record.core.result.artifacts) if (artifact.kind === "file") files.add(artifact.ref);
      for (const evidence of record.core.state.evidence) if (evidence.kind === "file") files.add(evidence.ref);
    }
    if (files.size > 0) return { filesChanged: files.size, files: [...files].sort(), source: "handoff" };
  }
  return { filesChanged: 0, files: [], source: "none" };
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;
