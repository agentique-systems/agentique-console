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
import type { Db } from "../db/client.ts";
import type { Repo } from "../db/repo.ts";
import type { InteractionService } from "../orchestrator/interactions.ts";
import { events, handoffRecords, tasks, usageSamples } from "../db/schema.ts";

export interface ReapResult {
  processes: { agentSessionId: string; participant: string; processId: string; pid: number | undefined }[];
  browsers: number;
  /** Processes the ledger shows as started-but-never-exited: real leaks. */
  leakedBefore: number;
}

export interface RunSummaryDocument {
  seqFrom: number;
  seqTo: number;
  verdict: "completed" | "completed_with_caveats" | "failed";
  headline: string;
  durationMs: number;
  /** Wall clock minus the UNION of every turn interval across both lanes. */
  deadAirMs: number;
  build: { filesChanged: number; files: string[]; source: "git" | "handoff" | "none" };
  tasks: { completed: number; total: number; open: string[]; ledgerUpdatedAt: string | null };
  cost: {
    usd: number | null;
    /** recordedTurns / observedTurns. Below 0.9 the figure is labelled partial. */
    coverage: number;
    recordedTurns: number;
    observedTurns: number;
    inputTokens: number;
    outputTokens: number;
    byParticipant: { participant: string; usd: number | null; turns: number }[];
  };
  decisions: { question: string; answer: string; askedBy: string }[];
  /** Console-owned facts about what the run did not do as asked. */
  deviations: string[];
  uncertainty: string[];
  resources: {
    reapedProcesses: number;
    reapedBrowsers: number;
    leakedBefore: number;
    detail: string[];
  };
  friction: { apiRetries: number; rateLimited: number; failedTurns: number; watchdogTrips: number };
}

export interface BuildRunSummaryInput {
  db: Db;
  repo: Repo;
  interactions: InteractionService;
  userSessionId: string;
  seqFrom: number;
  reaped: ReapResult;
  getWorkspaceRoot?: (workspaceId: string) => string;
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
    const payload = row.payload as { turnId?: string };
    if (row.type.endsWith("turn.started") && payload.turnId) turnStarts.set(payload.turnId, at);
    if (row.type.endsWith("turn.settled") && payload.turnId) {
      const start = turnStarts.get(payload.turnId);
      if (start !== undefined) { intervals.push({ start, end: at }); turnStarts.delete(payload.turnId); }
    }
  }
  const deadAirMs = Math.max(0, durationMs - unionDuration(intervals));

  const finals = repo.listAgentSessions(userSessionId)
    .map((session) => repo.latestHandoff({ userSessionId, agentSessionId: session.id, participant: "main", excludeCheckpoints: true }))
    .filter((row): row is NonNullable<typeof row> => row !== undefined && row.trigger === "final");
  const headline = finals[0]?.core.result.summary ?? finals[0]?.core.state.summary ?? "The run reported a result.";

  const ledger = db.select().from(tasks).where(eq(tasks.userSessionId, userSessionId)).all();
  const live = ledger.filter((task) => task.status !== "deleted");
  const open = live.filter((task) => task.status !== "completed");
  const ledgerUpdatedAt = live.reduce<string | null>((latest, task) => (latest === null || task.updatedAt > latest ? task.updatedAt : latest), null);

  // Cost, with its own honesty valve. `observedTurns` counts settle events;
  // `recordedTurns` counts usage rows. When they disagree the figure is
  // labelled partial rather than reported as if complete — db-live-2's ledger
  // was missing three of fourteen turns and said nothing about it.
  const usage = db.select().from(usageSamples).where(eq(usageSamples.userSessionId, userSessionId)).all()
    .filter((row) => !row.turnId.startsWith("checkpoint:"));
  const observedTurns = window.filter((row) => row.type.endsWith("turn.settled")).length;
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
    .map((row) => row.payload as { question: string; answer: string; askedBy: string })
    .map((payload) => ({ question: payload.question, answer: payload.answer, askedBy: payload.askedBy }));

  const deviations = collectDeviations(window, open.map((task) => task.subject));
  const uncertainty = [...new Set([
    ...finals.flatMap((row) => row.core.uncertainty),
    ...input.interactions.listPending(userSessionId).map((row) =>
      ((row.payload as { questions?: { question: string }[] }).questions ?? []).map((q) => q.question).join(" | ")),
  ])].filter((line) => line.trim() !== "");

  const friction = {
    apiRetries: window.filter((row) => row.type.endsWith("runtime") && /api error/i.test(String((row.payload as { detail?: string }).detail ?? ""))).length,
    rateLimited: window.filter((row) => row.type.endsWith("runtime") && /rate limit/i.test(String((row.payload as { detail?: string }).detail ?? ""))).length,
    failedTurns: window.filter((row) => row.type.endsWith("turn.settled") && (row.payload as { status?: string }).status === "error").length,
    watchdogTrips: window.filter((row) => row.type === "agent_session.watchdog").length,
  };

  const build = collectBuild(db, repo, userSessionId, input.getWorkspaceRoot);
  const verdict: RunSummaryDocument["verdict"] =
    finals.some((row) => row.core.status === "failed") ? "failed"
      : open.length > 0 || uncertainty.length > 0 || deviations.length > 0 ? "completed_with_caveats"
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
    resources: {
      reapedProcesses: reaped.processes.length,
      reapedBrowsers: reaped.browsers,
      leakedBefore: reaped.leakedBefore,
      detail: reaped.processes.map((process) => `${process.agentSessionId}:${process.participant} ${process.processId}${process.pid === undefined ? "" : ` (pid ${process.pid})`}`),
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
    if (row.type === "handoff.final.caveats") {
      for (const caveat of (row.payload as { caveats?: string[] }).caveats ?? []) out.push(caveat);
    }
    if (row.type === "agent_session.unreported") {
      out.push("A coordinator went idle without reporting; the Console closed the loop from the journal.");
    }
    if (row.type === "handoff.final.blocked") {
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
 * against the WORKING TREE (not HEAD) is deliberate: a seat running without a
 * worktree writes directly and commits nothing, and its files must still
 * count.
 */
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
      const git = (args: string[]): string =>
        execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 }).trim();
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
