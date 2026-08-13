/**
 * Post-run trace export over a console.db — read-only, no server required.
 * Revived from the deleted scripts/report-run.ts (b4df386~1) as a library,
 * updated to the current schema, and extended to emit the judge's inputs:
 * a structured run.json and a human/judge-readable transcript.md.
 *
 * CLI:  npx tsx server/evals/orchestration/live/export-trace.ts <console.db> [outDir]
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Trace } from "../trace.ts";

export interface RunExport {
  dbFile: string;
  span: { first: string | null; last: string | null; events: number };
  spend: Record<string, unknown>[];
  totals: { input: number | null; output: number | null; cost: number | null };
  turnLatency: { agent: string; n: number; p50: number | null; p90: number | null; max: number | null }[];
  deliveries: Record<string, unknown>[];
  denials: Record<string, unknown>[];
  watchdog: Record<string, unknown>[];
  turnOutcomes: Record<string, unknown>[];
  terminations: Record<string, unknown>[];
  rotations: Record<string, unknown>[];
  checkpointGate: Record<string, unknown>[];
  handoffs: { count: number; p50: number | null; p90: number | null; max: number | null; withReferenceWarnings: number; byTrigger: Record<string, unknown>[] };
  questions: { asked: number; answered: number; dismissed: number; medianBlockedMs: number | null };
  sessions: Record<string, unknown>[];
  /** Orchestration-state history + commission rationale, once those land. */
  stateRevisions: Record<string, unknown>[];
  frictionTags: string[];
  healthScorecard: { metric: string; value: number; note: string }[];
  parallelism: { maxConcurrentAgentTurns: number; totalOverlapMs: number };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
}

export function exportRun(dbFile: string): RunExport {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  const all = <T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] =>
    db.prepare(sql).all(...params) as T[];
  const one = (sql: string): number => (all<{ n: number }>(sql)[0]?.n ?? 0);
  const tableExists = (name: string): boolean =>
    all<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?", name)[0]!.n > 0;

  const span = all<{ first: string | null; last: string | null; count: number }>(
    "SELECT min(created_at) AS first, max(created_at) AS last, count(*) AS count FROM events")[0]!;

  const spend = all(
    `SELECT participant AS agent, profile_id AS profile, model,
       count(*) AS turns, sum(input_tokens) AS input, sum(uncached_input_tokens) AS uncached,
       sum(cache_read_input_tokens) AS cacheRead, sum(output_tokens) AS output, sum(cost_usd) AS cost,
       sum(CASE WHEN status != 'completed' THEN 1 ELSE 0 END) AS errors
     FROM usage_samples GROUP BY participant, profile_id, model ORDER BY sum(output_tokens) DESC`);

  const totals = all<{ input: number | null; output: number | null; cost: number | null }>(
    "SELECT sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cost_usd) AS cost FROM usage_samples")[0]!;

  const turnLatency = all<{ agent: string }>("SELECT DISTINCT participant AS agent FROM usage_samples ORDER BY participant")
    .map((row) => {
      const durations = all<{ d: number }>(
        "SELECT duration_ms AS d FROM usage_samples WHERE participant = ? AND duration_ms IS NOT NULL ORDER BY duration_ms",
        row.agent,
      ).map((entry) => entry.d);
      return {
        agent: row.agent,
        n: durations.length,
        p50: percentile(durations, 50),
        p90: percentile(durations, 90),
        max: durations[durations.length - 1] ?? null,
      };
    })
    .filter((row) => row.n > 0);

  const deliveries = all(
    "SELECT category, status, count(*) AS count FROM mailbox_deliveries GROUP BY category, status ORDER BY category, status");

  const denials = all(
    `SELECT json_extract(payload, '$.toolName') AS tool, json_extract(payload, '$.kind') AS kind, count(*) AS count
     FROM events WHERE type = 'tool.denied' GROUP BY 1, 2 ORDER BY count DESC`);

  const watchdog = all(
    `SELECT json_extract(payload, '$.agent') AS agent, json_extract(payload, '$.kind') AS kind,
       json_extract(payload, '$.toolName') AS tool, count(*) AS count
     FROM events WHERE type = 'agent_session.watchdog.tripped' GROUP BY 1, 2, 3 ORDER BY count DESC`);

  const turnOutcomes = all(
    `SELECT type, json_extract(payload, '$.status') AS status, count(*) AS count
     FROM events WHERE type IN ('user_session.turn.settled', 'agent_session.turn.settled')
     GROUP BY 1, 2 ORDER BY type, count DESC`);

  const terminations = all(
    `SELECT json_extract(payload, '$.rule') AS rule, json_extract(payload, '$.detail') AS detail, count(*) AS count
     FROM events WHERE type = 'agent_session.termination.tripped' GROUP BY 1, 2 ORDER BY count DESC`);

  const rotations = all(
    `SELECT type, json_extract(payload, '$.agent') AS agent,
       json_extract(payload, '$.degraded') AS degraded, count(*) AS count
     FROM events WHERE type IN ('user_session.context.rotated', 'agent_session.context.rotated')
     GROUP BY 1, 2, 3`);

  const checkpointGate = all(
    `SELECT type, json_extract(payload, '$.agent') AS agent, json_extract(payload, '$.degraded') AS degraded, count(*) AS count
     FROM events WHERE type LIKE 'handoff.checkpoint.%' GROUP BY 1, 2, 3`);

  const handoffBytes = all<{ b: number }>("SELECT bytes AS b FROM handoff_records ORDER BY bytes").map((row) => row.b);
  const handoffs = {
    count: handoffBytes.length,
    p50: percentile(handoffBytes, 50),
    p90: percentile(handoffBytes, 90),
    max: handoffBytes[handoffBytes.length - 1] ?? null,
    withReferenceWarnings: one("SELECT count(*) AS n FROM handoff_records WHERE reference_warnings != '[]'"),
    byTrigger: all("SELECT trigger, count(*) AS count FROM handoff_records GROUP BY trigger ORDER BY count DESC"),
  };

  const trace = Trace.fromSqlite(db);
  const exchanges = trace.questions();
  const blocked = exchanges.map((entry) => entry.blockedMs).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const questions = {
    asked: exchanges.length,
    answered: exchanges.filter((entry) => entry.answered !== null && !entry.dismissed).length,
    dismissed: exchanges.filter((entry) => entry.dismissed).length,
    medianBlockedMs: percentile(blocked, 50),
  };

  const sessions = all(
    `SELECT s.id, s.title, s.pattern, s.lifecycle, s.parent_agent_session_id AS parent, s.created_at,
       (SELECT count(*) FROM agents a WHERE a.agent_session_id = s.id) AS seats
     FROM agent_sessions s ORDER BY s.created_at`);

  const stateRevisions = tableExists("orchestration_state_revisions")
    ? all("SELECT revision, trigger, strategy, note, created_at FROM orchestration_state_revisions ORDER BY revision")
    : [];
  const frictionTags = stateRevisions
    .map((row) => String(row.note ?? ""))
    .filter((note) => note.includes("pattern-friction:"));

  const healthScorecard = [
    { metric: "transfers", value: one(`SELECT count(*) AS n FROM events WHERE type = 'agent_session.tool.called' AND json_extract(payload, '$.name') LIKE '%send_handoff'`), note: "send_handoff calls" },
    { metric: "context rotations", value: one("SELECT count(*) AS n FROM events WHERE type = 'agent_session.context.rotated'"), note: "spurious rotation is the usual cause of repeated work" },
    { metric: "checkpoints failed", value: one("SELECT count(*) AS n FROM events WHERE type = 'handoff.checkpoint.failed'"), note: "successor inherited a reconstruction, not its own state" },
    { metric: "reports to operator", value: one("SELECT count(*) AS n FROM mailbox_deliveries WHERE recipient = 'main'"), note: "zero means the run finished in silence" },
    { metric: "operator debts discharged", value: one("SELECT count(*) AS n FROM events WHERE type = 'agent_session.closeout.forced'"), note: "non-zero means a coordinator left the operator uninformed" },
    { metric: "liveness alarms", value: one("SELECT count(*) AS n FROM events WHERE type = 'agent_session.liveness.tripped'"), note: "wedged in-flight work the console had to flag" },
    { metric: "commissions without why", value: one(`SELECT count(*) AS n FROM handoff_records WHERE sender = 'main' AND trigger = 'assignment' AND json_extract(extension, '$.data.why') IS NULL`), note: "rationale absent at the act (visible omission)" },
  ];

  const parallelism = trace.parallelism();

  db.close();
  return {
    dbFile,
    span: { first: span.first, last: span.last, events: span.count },
    spend, totals, turnLatency, deliveries, denials, watchdog, turnOutcomes,
    terminations, rotations, checkpointGate, handoffs, questions, sessions,
    stateRevisions, frictionTags, healthScorecard, parallelism,
  };
}

/** The judge-readable transcript: every message row plus handoff summaries, in order. */
export function exportTranscript(dbFile: string): string {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  const rows = db.prepare(
    `SELECT m.session_kind, m.session_id, m.seq, m.speaker_kind, m.speaker_name, m.to_name, m.kind, m.text, m.created_at
     FROM messages m ORDER BY m.created_at, m.id`).all() as Record<string, unknown>[];
  const lines: string[] = ["# Run transcript", ""];
  for (const row of rows) {
    const to = row.to_name ? ` → ${row.to_name}` : "";
    lines.push(`### [${row.created_at}] ${row.session_kind}/${row.speaker_name}${to} (${row.kind})`);
    lines.push(String(row.text ?? ""));
    lines.push("");
  }
  db.close();
  return lines.join("\n");
}

export function exportRunToDir(dbFile: string, outDir: string): { runJson: string; transcriptMd: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const runJson = path.join(outDir, "run.json");
  const transcriptMd = path.join(outDir, "transcript.md");
  fs.writeFileSync(runJson, `${JSON.stringify(exportRun(dbFile), null, 2)}\n`);
  fs.writeFileSync(transcriptMd, exportTranscript(dbFile));
  return { runJson, transcriptMd };
}

const invokedDirectly = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const dbFile = process.argv[2];
  if (!dbFile) throw new Error("usage: export-trace.ts <console.db> [outDir]");
  const outDir = process.argv[3] ?? path.join(path.dirname(dbFile), "export");
  const files = exportRunToDir(dbFile, outDir);
  console.log(`wrote ${files.runJson}\nwrote ${files.transcriptMd}`);
}
