/**
 * Post-run analysis over a console.db — read-only, no server required.
 *
 *   npx tsx server/scripts/report-run.ts [/path/to/console.db]
 *
 * Prints what a live run needs answered afterwards: who spent what, how long
 * turns took, how fast the mesh delivered, what was denied, what the watchdog
 * and checkpoint gates did, and how handoffs sized and were consumed. All
 * queries are against the authoritative tables + event spine; nothing writes.
 */
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";

const dbFile = process.argv[2] ?? path.join(os.homedir(), ".agentique-console", "console.db");
const db = new Database(dbFile, { readonly: true, fileMustExist: true });

function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
}

function ms(value: number | null): string {
  if (value === null) return "–";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 120_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function num(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString("en-US");
}

function heading(title: string): void {
  console.log(`\n## ${title}\n`);
}

function table(rows: Record<string, unknown>[], columns: string[]): void {
  if (rows.length === 0) { console.log("  (none)"); return; }
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => String(row[column] ?? "").length)));
  console.log("  " + columns.map((column, i) => column.padEnd(widths[i]!)).join("  "));
  for (const row of rows) console.log("  " + columns.map((column, i) => String(row[column] ?? "").padEnd(widths[i]!)).join("  "));
}

console.log(`# Agentique Console run report`);
console.log(`db: ${dbFile}`);
const span = all<{ first: string | null; last: string | null; count: number }>(
  "select min(created_at) as first, max(created_at) as last, count(*) as count from events")[0];
console.log(`events: ${num(span?.count)} (${span?.first ?? "–"} → ${span?.last ?? "–"})`);

// ── Spend ────────────────────────────────────────────────────────────────────
heading("Spend by participant (usage_samples)");
const spend = all<{ participant: string; profile: string | null; model: string | null; turns: number;
  input: number; uncached: number; cacheCreate: number; cacheRead: number; output: number; cost: number | null; errors: number }>(
  `select participant, profile_id as profile, model,
     count(*) as turns, sum(input_tokens) as input, sum(uncached_input_tokens) as uncached,
     sum(cache_creation_input_tokens) as cacheCreate, sum(cache_read_input_tokens) as cacheRead,
     sum(output_tokens) as output, sum(cost_usd) as cost,
     sum(case when status != 'completed' then 1 else 0 end) as errors
   from usage_samples group by participant, profile_id, model order by sum(output_tokens) desc`);
table(spend.map((row) => ({ participant: row.participant, profile: row.profile ?? "–", model: row.model ?? "–",
  turns: row.turns, input: num(row.input), uncached: num(row.uncached), cacheRead: num(row.cacheRead),
  output: num(row.output), cost: row.cost === null ? "–" : `$${row.cost.toFixed(4)}`, errors: row.errors })),
  ["participant", "profile", "model", "turns", "input", "uncached", "cacheRead", "output", "cost", "errors"]);
const totals = all<{ input: number; output: number; cost: number | null }>(
  "select sum(input_tokens) as input, sum(output_tokens) as output, sum(cost_usd) as cost from usage_samples")[0];
console.log(`\n  TOTAL input ${num(totals?.input)} · output ${num(totals?.output)} · cost ${totals?.cost == null ? "–" : `$${totals.cost.toFixed(4)}`}`);

// ── Turn latency ─────────────────────────────────────────────────────────────
heading("Turn latency (usage_samples.duration_ms)");
for (const row of all<{ participant: string }>("select distinct participant from usage_samples order by participant")) {
  const durations = all<{ d: number }>(
    "select duration_ms as d from usage_samples where participant = ? and duration_ms is not null order by duration_ms", row.participant)
    .map((entry) => entry.d);
  if (durations.length === 0) continue;
  console.log(`  ${row.participant.padEnd(20)} n=${String(durations.length).padEnd(5)} p50=${ms(percentile(durations, 50))} p90=${ms(percentile(durations, 90))} max=${ms(durations[durations.length - 1] ?? null)}`);
}

// ── Delivery latency ─────────────────────────────────────────────────────────
heading("Mesh deliveries (mailbox_deliveries)");
const deliveryStatus = all<{ transport: string; status: string; count: number }>(
  "select transport, status, count(*) as count from mailbox_deliveries group by transport, status order by transport, status");
table(deliveryStatus, ["transport", "status", "count"]);
for (const transport of ["peer", "console"]) {
  const carried = all<{ carry: number; ack: number | null }>(
    `select (julianday(delivered_at) - julianday(created_at)) * 86400000 as carry,
       (julianday(acknowledged_at) - julianday(created_at)) * 86400000 as ack
     from mailbox_deliveries where transport = ? and delivered_at is not null order by carry`, transport);
  if (carried.length === 0) continue;
  const carries = carried.map((row) => row.carry).sort((a, b) => a - b);
  const acks = carried.map((row) => row.ack).filter((value): value is number => value !== null).sort((a, b) => a - b);
  console.log(`  ${transport.padEnd(8)} created→delivered p50=${ms(percentile(carries, 50))} p90=${ms(percentile(carries, 90))}` +
    `  created→acknowledged p50=${ms(percentile(acks, 50))} p90=${ms(percentile(acks, 90))} (n=${carries.length})`);
}

// ── Governance denials ───────────────────────────────────────────────────────
heading("Tool denials (governance.tool.denied)");
table(all(
  `select json_extract(payload, '$.toolName') as tool, json_extract(payload, '$.kind') as kind, count(*) as count
   from events where type = 'governance.tool.denied' group by 1, 2 order by count desc`), ["tool", "kind", "count"]);

// ── Watchdog + failures ──────────────────────────────────────────────────────
heading("Watchdog trips (agent_session.watchdog)");
table(all(
  `select json_extract(payload, '$.participant') as participant, json_extract(payload, '$.kind') as kind,
     json_extract(payload, '$.toolName') as tool, count(*) as count
   from events where type = 'agent_session.watchdog' group by 1, 2, 3 order by count desc`),
  ["participant", "kind", "tool", "count"]);
heading("Turn outcomes (turn.settled)");
table(all(
  `select type, json_extract(payload, '$.status') as status, count(*) as count
   from events where type in ('user_session.turn.settled', 'agent_session.turn.settled')
   group by 1, 2 order by type, count desc`), ["type", "status", "count"]);

// ── Pattern progression forensics ────────────────────────────────────────────
heading("Termination trips (agent_session.termination.tripped)");
table(all(
  `select json_extract(payload, '$.rule') as rule, json_extract(payload, '$.detail') as detail, count(*) as count
   from events where type = 'agent_session.termination.tripped' group by 1, 2 order by count desc`), ["rule", "detail", "count"]);
heading("Joins completed (agent_session.join.completed)");
table(all(
  `select json_extract(payload, '$.joinId') as joinId, json_extract(payload, '$.of') as expected,
     json_extract(payload, '$.failed') as failed, count(*) as count
   from events where type = 'agent_session.join.completed' group by 1, 2, 3`), ["joinId", "expected", "failed", "count"]);

// ── Rotation + checkpoint gate ───────────────────────────────────────────────
heading("Context rotations");
table(all(
  `select type, json_extract(payload, '$.participant') as participant,
     json_extract(payload, '$.degraded') as degraded, count(*) as count
   from events where type in ('user_session.context.rotated', 'agent_session.context.rotated')
   group by 1, 2, 3`), ["type", "participant", "degraded", "count"]);
heading("Checkpoint gate (handoff.checkpoint.*)");
table(all(
  `select type, json_extract(payload, '$.participant') as participant, json_extract(payload, '$.accepted') as accepted,
     json_extract(payload, '$.degraded') as degraded, count(*) as count
   from events where type like 'handoff.checkpoint.%' group by 1, 2, 3, 4`),
  ["type", "participant", "accepted", "degraded", "count"]);

// ── Handoffs ─────────────────────────────────────────────────────────────────
heading("Handoff records");
const handoffBytes = all<{ b: number }>("select bytes as b from handoff_records order by bytes").map((row) => row.b);
const overflow = all<{ count: number }>("select count(*) as count from handoff_records where overflow = 1")[0];
const warned = all<{ count: number }>("select count(*) as count from handoff_records where reference_warnings != '[]'")[0];
console.log(`  n=${handoffBytes.length} bytes p50=${num(percentile(handoffBytes, 50))} p90=${num(percentile(handoffBytes, 90))} max=${num(handoffBytes[handoffBytes.length - 1] ?? null)}`);
console.log(`  overflow=${num(overflow?.count)} withReferenceWarnings=${num(warned?.count)}`);
table(all("select trigger, count(*) as count from handoff_records group by trigger order by count desc"), ["trigger", "count"]);
heading("Handoff consumption (handoff.consumed)");
table(all(
  `select json_extract(payload, '$.mode') as mode, count(*) as count
   from events where type = 'handoff.consumed' group by 1`), ["mode", "count"]);
heading("Handoff discrepancies (handoff.discrepancy)");
table(all(
  `select json_extract(payload, '$.participant') as participant, json_extract(payload, '$.claim') as claim
   from events where type = 'handoff.discrepancy' limit 20`), ["participant", "claim"]);

// ── Provider friction ────────────────────────────────────────────────────────
heading("Provider friction (runtime notices)");
table(all(
  `select case
       when json_extract(payload, '$.detail') like 'rate limited%' then 'rate_limited'
       when json_extract(payload, '$.detail') like 'API error%' then 'api_error_retry'
       when json_extract(payload, '$.detail') like 'wake for delivery failed%' then 'wake_failure'
       when json_extract(payload, '$.detail') like 'native carry failed%' then 'carry_failure'
       when json_extract(payload, '$.detail') like 'scheduler failure%' then 'scheduler_failure'
       when json_extract(payload, '$.detail') like 'seat parked%' then 'seat_parked'
       when json_extract(payload, '$.detail') like 'steered mid-turn%' then 'steered_mid_turn'
       else null end as kind,
     count(*) as count
   from events where type in ('user_session.runtime', 'agent_session.runtime')
   group by 1 having kind is not null order by count desc`), ["kind", "count"]);

// ── Health scorecard ─────────────────────────────────────────────────────────
// The ratios a run must be judged on. Every one of these was a silent failure
// in db-live-1: 59% of sends denied, 13/13 checkpoints failed, 13 spurious
// rotations, zero reports to the operator, and a cost figure 25% too high —
// none of it visible without forensics. A run summary should make them obvious.
heading("Health scorecard");

const one = <T = number>(sql: string): T => (all<Record<string, T>>(sql)[0]?.n ?? 0 as T);
const sends = one(`select count(*) as n from events where type = 'agent_session.tool.call'
  and json_extract(payload, '$.name') in ('SendMessage', 'mcp__console_agent__send_handoff')`);
const rotations = one(`select count(*) as n from events where type = 'agent_session.context.rotated'`);
const cpFailed = one(`select count(*) as n from events where type = 'handoff.checkpoint.failed'`);
const toMain = one(`select count(*) as n from mailbox_deliveries where recipient = 'main'`);
const unreported = one(`select count(*) as n from events where type = 'agent_session.unreported'`);
const toolSearch = one(`select count(*) as n from events where type in ('agent_session.tool.call','user_session.tool.call')
  and json_extract(payload, '$.name') = 'ToolSearch'`);
const cliSessions = one(`select count(distinct session_id) as n from provider_entries_v2`);

table([
  { metric: "transfers", value: num(sends), note: "send_handoff calls (plus legacy SendMessage on old runs)" },
  // The four LEGACY rows that used to sit here (peer-carried deliveries,
  // envelope denials, delivered degraded, envelopes repaired) are gone. They
  // are structurally zero on any post-consolidation run, and a scorecard whose
  // value is that every row means something cannot afford rows that never do.
  { metric: "context rotations", value: num(rotations), note: "spurious rotation is the usual cause of repeated work" },
  { metric: "checkpoints failed", value: num(cpFailed), note: "successor inherited a reconstruction, not its own state" },
  { metric: "reports to operator", value: num(toMain), note: "zero means the run finished in silence" },
  { metric: "operator debts discharged", value: num(unreported), note: "non-zero means a coordinator left the operator uninformed" },
  { metric: "ToolSearch calls", value: num(toolSearch), note: "tool rediscovery; should be ~0 with alwaysLoad" },
  { metric: "CLI sessions", value: num(cliSessions), note: "cold prompt-cache starts — one per participant is ideal" },
], ["metric", "value", "note"]);

// Cost is recorded per turn as a delta of the SDK's cumulative figure. If a
// row still looks cumulative the ledger is over-reporting, as db-live-1's was.
const costRows = all<{ participant: string; recorded: number; largest: number; turns: number }>(
  `select participant, sum(cost_usd) as recorded, max(cost_usd) as largest, count(*) as turns
   from usage_samples where cost_usd is not null group by participant order by recorded desc`);
if (costRows.length > 0) {
  heading("Cost (per-turn deltas)");
  table(costRows.map((row) => ({
    participant: row.participant,
    total: `$${row.recorded.toFixed(2)}`,
    turns: num(row.turns),
    largest_turn: `$${row.largest.toFixed(2)}`,
  })), ["participant", "total", "turns", "largest_turn"]);
  console.log(`\nTotal: $${costRows.reduce((sum, row) => sum + row.recorded, 0).toFixed(2)}`);
}

db.close();
