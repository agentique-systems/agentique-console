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

  // EVERY column — strategyWhy, uncertainties, assumptions, risks, and the
  // completion record are exactly the contemporaneous context the
  // decision-quality rubric demands.
  const stateRevisions = trace.stateRevisions() as unknown as Record<string, unknown>[];
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
    // Only true COMMISSIONS (the first main assignment per session) — the old
    // query counted every steering assignment and inflated the omission rate.
    { metric: "commissions without why", value: trace.commissions().filter((commission) => commission.why === null).length, note: "rationale absent at the act (visible omission)" },
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

/**
 * The judge-readable transcript: the message rows MERGED with the acts the
 * messages table never sees — question cards WITH their answers, operator
 * decisions, main's tool calls (why/expecting included), spec and state
 * revision markers, liveness alarms. The old messages-only transcript meant
 * the question-quality judge scored runs without seeing a single question.
 */
export function exportTranscript(dbFile: string): string {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  const items: { at: string; seq: number; text: string }[] = [];
  const rows = db.prepare(
    `SELECT m.session_kind, m.seq, m.speaker_name, m.to_name, m.kind, m.text, m.created_at
     FROM messages m ORDER BY m.created_at, m.id`).all() as Record<string, unknown>[];
  for (const row of rows) {
    const to = row.to_name ? ` → ${row.to_name}` : "";
    items.push({ at: String(row.created_at), seq: 0,
      text: `### [${row.created_at}] ${row.session_kind}/${row.speaker_name}${to} (${row.kind})\n${String(row.text ?? "")}\n` });
  }
  const trace = Trace.fromSqlite(db);
  const digest = (value: unknown, max = 400): string => {
    const text = JSON.stringify(value ?? {});
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  for (const event of trace.events()) {
    const p = event.payload as Record<string, unknown>;
    let text: string | null = null;
    if (event.type === "user_session.tool.called") {
      text = `> [tool] main → ${String(p.name ?? "?")} ${digest(p.input)}`;
    } else if (event.type === "user_session.question.asked") {
      const questions = (p.questions as { question?: string; options?: { label?: string }[] }[] | undefined) ?? [];
      text = `> [question card] ${questions.map((q) => `${q.question ?? ""} (${(q.options ?? []).map((o) => o.label).join(" / ")})`).join(" | ")}`;
    } else if (event.type === "operator.decision.recorded") {
      text = `> [operator decision] ${String(p.question ?? "")} → ${String(p.answer ?? "")}`;
    } else if (event.type === "user_session.spec.updated") {
      text = `> [spec] revision ${String(p.revision)} approved${p.changeNote ? ` — ${String(p.changeNote)}` : ""}`;
    } else if (event.type === "user_session.requirements.updated") {
      text = `> [requirements] revision ${String(p.revision)} approved${p.changeNote ? ` — ${String(p.changeNote)}` : ""}`;
    } else if (event.type === "user_session.state.updated") {
      text = `> [state] rev ${String(p.revision)} (${String(p.trigger)}) sections=${digest(p.sections, 120)}${Array.isArray(p.incorporating) ? ` incorporating=${digest(p.incorporating, 160)}` : ""}`;
    } else if (event.type === "agent_session.liveness.tripped") {
      text = `> [ALARM] session ${String(p.agentSessionId ?? "")} agent ${String(p.agent ?? "")} — wedged past threshold`;
    }
    if (text !== null) items.push({ at: event.createdAt, seq: event.seq, text: `${text}\n` });
  }
  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));
  db.close();
  return ["# Run transcript", "", ...items.map((item) => item.text)].join("\n");
}

interface EvidencePacket {
  actSeq: number;
  actType: string;
  agentSessionId: string | null;
  why: string | null;
  expecting: string | null;
  specRevisionAtAct: number | null;
  stateRevisionAtAct: number | null;
  decisionsAtAct: { seq: number; question: string; answer: string }[];
  inboundEvidence: { handoffId: string; seq: number | null; trigger: string; sender: string; agentSessionId: string | null; summary: string }[];
  reviewFindings: { handoffId: string; seq: number | null; summary: string }[];
  alarmsAtAct: { seq: number; agentSessionId: string; agent: string }[];
  outstandingCommissions: { agentSessionId: string; sinceSeq: number | null }[];
}

/**
 * One packet per MAJOR act, reconstructing what was actually knowable at that
 * seq — not merely the orchestrator's self-authored state: the external
 * evidence already received (reports, review findings, alarms), the
 * commissions still outstanding, the operator decisions, and the governing
 * spec/state revisions. References + short summaries; events.jsonl expands.
 */
export function exportEvidencePackets(dbFile: string): EvidencePacket[] {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  const trace = Trace.fromSqlite(db);
  const events = trace.events();
  const decisions = trace.decisions();
  const handoffs = trace.handoffs();
  const reports = handoffs.filter((row) => row.recipient === "main" && !row.synthetic &&
    ["final", "failure", "milestone", "decision"].includes(row.trigger) && row.seq !== null);
  const reviews = handoffs.filter((row) => !row.synthetic && !["rotation", "recovery"].includes(row.trigger) &&
    (((row.extension as { kind?: string }).kind === "review") || (row.profileId ?? "").includes("review")) && row.seq !== null);
  const alarms = events.filter((event) => event.type === "agent_session.liveness.tripped");
  const commissions = trace.commissions();
  const terminalSeqOf = new Map<string, number>();
  for (const row of handoffs) {
    if (row.agentSessionId !== null && row.recipient === "main" && ["final", "failure"].includes(row.trigger) && row.seq !== null && !terminalSeqOf.has(row.agentSessionId)) {
      terminalSeqOf.set(row.agentSessionId, row.seq);
    }
  }
  // The governing document's approvals — a run uses the requirement graph or
  // the legacy spec, so both event families feed one revision-at-act series.
  const specEvents = events.filter((event) =>
    event.type === "user_session.spec.updated" || event.type === "user_session.requirements.updated");
  const stateEvents = events.filter((event) => event.type === "user_session.state.updated");
  const summaryOf = (row: (typeof handoffs)[number]): string => String((row.core as { action?: unknown }).action ?? "").slice(0, 160);

  const acts = events.filter((event) =>
    event.type === "agent_session.created" ||
    event.type === "agent_session.agent.added" ||
    event.type === "user_session.spec.updated" ||
    event.type === "user_session.requirements.updated" ||
    event.type === "run.completion.proposed" ||
    (event.type === "user_session.tool.called" &&
      ["mcp__console__interrupt_agent", "mcp__console__close_agent_session"].includes(String(event.payload.name ?? ""))));

  const packets = acts.map((act): EvidencePacket => {
    const input = (act.payload.input ?? {}) as Record<string, unknown>;
    const sessionOfAct = act.type === "agent_session.created"
      ? String((act.payload.session as { id?: unknown } | undefined)?.id ?? "") || null
      : act.type === "agent_session.agent.added" || act.type.startsWith("user_session.tool")
        ? (typeof input.agentSessionId === "string" ? input.agentSessionId : act.agentSessionId)
        : act.agentSessionId;
    const commission = commissions.find((entry) => entry.agentSessionId === sessionOfAct);
    // For a session-targeted act, its session's reports; otherwise the run's
    // recent inbound reports — what main had in hand.
    const inbound = (sessionOfAct !== null
      ? reports.filter((row) => row.agentSessionId === sessionOfAct && row.seq! < act.seq)
      : reports.filter((row) => row.seq! < act.seq)).slice(-3);
    return {
      actSeq: act.seq,
      actType: act.type === "user_session.tool.called" ? String(act.payload.name ?? act.type) : act.type,
      agentSessionId: sessionOfAct,
      why: commission?.why ?? (typeof input.reason === "string" ? input.reason : null),
      expecting: commission?.expecting ?? null,
      specRevisionAtAct: (() => {
        const last = specEvents.filter((event) => event.seq <= act.seq).at(-1);
        return last === undefined ? null : Number(last.payload.revision ?? null);
      })(),
      stateRevisionAtAct: (() => {
        const last = stateEvents.filter((event) => event.seq <= act.seq).at(-1);
        return last === undefined ? null : Number(last.payload.revision ?? null);
      })(),
      decisionsAtAct: decisions.filter((event) => event.seq <= act.seq).slice(-12)
        .map((event) => ({ seq: event.seq, question: String(event.payload.question ?? ""), answer: String(event.payload.answer ?? "") })),
      inboundEvidence: inbound.map((row) => ({ handoffId: row.id, seq: row.seq, trigger: row.trigger, sender: row.sender, agentSessionId: row.agentSessionId, summary: summaryOf(row) })),
      reviewFindings: reviews.filter((row) => row.seq! < act.seq).slice(-3)
        .map((row) => ({ handoffId: row.id, seq: row.seq, summary: summaryOf(row) })),
      alarmsAtAct: alarms.filter((event) => event.seq < act.seq).slice(-3)
        .map((event) => ({ seq: event.seq, agentSessionId: String(event.payload.agentSessionId ?? ""), agent: String(event.payload.agent ?? "") })),
      outstandingCommissions: commissions
        .filter((entry) => entry.seq !== null && entry.seq < act.seq &&
          (terminalSeqOf.get(entry.agentSessionId) === undefined || terminalSeqOf.get(entry.agentSessionId)! > act.seq))
        .map((entry) => ({ agentSessionId: entry.agentSessionId, sinceSeq: entry.seq })),
    };
  });
  db.close();
  return packets;
}

export function exportRunToDir(dbFile: string, outDir: string): { runJson: string; transcriptMd: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const runJson = path.join(outDir, "run.json");
  const transcriptMd = path.join(outDir, "transcript.md");
  fs.writeFileSync(runJson, `${JSON.stringify(exportRun(dbFile), null, 2)}\n`);
  fs.writeFileSync(transcriptMd, exportTranscript(dbFile));

  // The decision-time evidence layer: the full seq-ordered spine plus every
  // append-only revision/decision series, and per-act evidence packets — so a
  // judge (or a human) can reconstruct any major act's contemporaneous
  // context without opening the database.
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  const trace = Trace.fromSqlite(db);
  const spine = trace.events().map((event) => JSON.stringify(event)).join("\n");
  fs.writeFileSync(path.join(outDir, "events.jsonl"), `${spine}\n`);
  fs.writeFileSync(path.join(outDir, "state-revisions.json"), `${JSON.stringify(trace.stateRevisions(), null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "spec-revisions.json"), `${JSON.stringify(trace.specRevisions(), null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "requirement-revisions.json"), `${JSON.stringify(trace.requirementRevisions(), null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "decisions.json"), `${JSON.stringify(trace.decisions().map((event) => ({ seq: event.seq, ...event.payload })), null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "questions.json"), `${JSON.stringify(trace.questions().map((exchange) => ({
    askedSeq: exchange.asked.seq,
    questions: exchange.asked.payload.questions ?? [],
    askedBy: exchange.asked.payload.agent ?? "main",
    answeredSeq: exchange.answered?.seq ?? null,
    answer: exchange.answered?.payload ?? null,
    blockedMs: exchange.blockedMs,
    dismissed: exchange.dismissed,
  })), null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "tool-calls.json"), `${JSON.stringify(trace.toolCalls().map((call) => ({
    ...call, input: JSON.stringify(call.input ?? {}).slice(0, 2_000),
  })), null, 2)}\n`);
  db.close();
  const evidenceDir = path.join(outDir, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "packets.json"), `${JSON.stringify(exportEvidencePackets(dbFile), null, 2)}\n`);
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
