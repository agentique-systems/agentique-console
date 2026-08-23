/**
 * Trace: one typed read API over the journaled SQLite database, shared by both
 * evaluation tiers. Tier A hands it the harness's in-memory handle
 * (`Trace.fromSqlite(h.sqlite)`); Tier B opens an exported console.db file
 * read-only (`Trace.fromFile(path)`). Everything a checker or metric needs
 * comes from the journal — never from in-process state — so a check that
 * passes here is a check the live tier can run unchanged.
 */
import Database from "better-sqlite3";

export interface Ev {
  seq: number;
  type: string;
  workspaceId: string | null;
  userSessionId: string | null;
  agentSessionId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type EvPredicate = (event: Ev) => boolean;

export interface ToolCall {
  lane: "main" | "agent";
  agent: string | null;
  callId: string;
  name: string;
  input: unknown;
  calledSeq: number;
  calledAt: string;
  completedSeq: number | null;
  completedAt: string | null;
  isError: boolean;
}

export interface QuestionExchange {
  asked: Ev;
  answered: Ev | null;
  /** Wall-clock from asked to answered; null while unanswered. */
  blockedMs: number | null;
  dismissed: boolean;
}

export interface AgentSessionRow {
  id: string;
  userSessionId: string;
  title: string;
  lifecycle: string;
  pattern: string;
  parentAgentSessionId: string | null;
  createdAt: string;
  agents: { name: string; role: string; profileId: string | null; model: string | null }[];
}

export interface HandoffRow {
  id: string;
  agentSessionId: string | null;
  sender: string;
  recipient: string;
  /** The sender seat's profile at send time (null for main/console senders). */
  profileId: string | null;
  trigger: string;
  synthetic: boolean;
  core: Record<string, unknown>;
  extension: Record<string, unknown>;
  bytes: number;
  createdAt: string;
  /** Seq of the handoff.created event — the honest ordering key (createdAt ties within a millisecond). Null when the event was never journaled. */
  seq: number | null;
}

/** One commission: the FIRST main→session assignment handoff — the creation briefing. Later steering never overwrites it. */
export interface CommissionRow {
  agentSessionId: string;
  handoffId: string;
  seq: number | null;
  action: string;
  why: string | null;
  expecting: string | null;
  createdAt: string;
}

export interface RevisionTraceRow {
  id: string;
  revision: number;
  document: string;
  changeNote: string | null;
  status: string;
  origin: string;
  interactionId: string | null;
  createdAt: string;
  approvedAt: string | null;
}

export interface StateRevisionTraceRow {
  id: string;
  revision: number;
  trigger: string;
  strategy: string;
  strategyWhy: string;
  uncertainties: string[];
  assumptions: string[];
  risks: string[];
  note: string | null;
  completion: Record<string, unknown> | null;
  createdAt: string;
}

export interface TaskRow {
  id: string;
  subject: string;
  status: string;
  owner: string | null;
  agentSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UsageSummary {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  perParticipant: Record<string, { turns: number; costUsd: number; outputTokens: number; errors: number }>;
  turnDurationsMs: number[];
}

export interface ParallelismSummary {
  /** Peak number of agent turns open at once (from turn.started/settled interleaving). */
  maxConcurrentAgentTurns: number;
  /** Total wall-clock during which two or more agent turns overlapped. */
  totalOverlapMs: number;
}

function asBool(value: unknown): boolean {
  return value === true || value === 1;
}

export class Trace {
  #db: Database.Database;
  #userSessionId: string | null;
  #events: Ev[] | null = null;

  private constructor(db: Database.Database, userSessionId: string | null) {
    this.#db = db;
    this.#userSessionId = userSessionId;
  }

  /** Wrap a live handle (the test harness's in-memory database). */
  static fromSqlite(db: Database.Database, userSessionId?: string): Trace {
    return new Trace(db, userSessionId ?? null);
  }

  /** Open an exported console.db read-only (the live tier). */
  static fromFile(path: string, userSessionId?: string): Trace {
    return new Trace(new Database(path, { readonly: true, fileMustExist: true }), userSessionId ?? null);
  }

  #all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.#db.prepare(sql).all(...params) as T[];
  }

  /**
   * The full seq-ordered event spine (scoped to the trace's user session when
   * one was given — agent-session events join through their session row).
   */
  events(type?: string | RegExp, where?: (payload: Record<string, unknown>, event: Ev) => boolean): Ev[] {
    if (this.#events === null) {
      const rows = this.#userSessionId === null
        ? this.#all("SELECT seq, type, workspace_id, user_session_id, agent_session_id, payload, created_at FROM events ORDER BY seq")
        : this.#all(
            `SELECT e.seq, e.type, e.workspace_id, e.user_session_id, e.agent_session_id, e.payload, e.created_at
             FROM events e
             LEFT JOIN agent_sessions s ON s.id = e.agent_session_id
             WHERE e.user_session_id = ? OR s.user_session_id = ?
             ORDER BY e.seq`,
            this.#userSessionId,
            this.#userSessionId,
          );
      this.#events = rows.map((row) => ({
        seq: row.seq as number,
        type: row.type as string,
        workspaceId: (row.workspace_id as string | null) ?? null,
        userSessionId: (row.user_session_id as string | null) ?? null,
        agentSessionId: (row.agent_session_id as string | null) ?? null,
        payload: typeof row.payload === "string" ? (JSON.parse(row.payload as string) as Record<string, unknown>) : ((row.payload ?? {}) as Record<string, unknown>),
        createdAt: row.created_at as string,
      }));
    }
    let selected = this.#events;
    if (type !== undefined) {
      selected = selected.filter((event) => (typeof type === "string" ? event.type === type : type.test(event.type)));
    }
    if (where !== undefined) selected = selected.filter((event) => where(event.payload, event));
    return selected;
  }

  first(type?: string | RegExp, where?: (payload: Record<string, unknown>, event: Ev) => boolean): Ev | undefined {
    return this.events(type, where)[0];
  }

  count(type?: string | RegExp, where?: (payload: Record<string, unknown>, event: Ev) => boolean): number {
    return this.events(type, where).length;
  }

  /** True when the first event matching `a` precedes the first matching `b`. */
  before(a: EvPredicate, b: EvPredicate): boolean {
    const eventA = this.events().find(a);
    const eventB = this.events().find(b);
    if (eventA === undefined || eventB === undefined) return false;
    return eventA.seq < eventB.seq;
  }

  /** Events strictly between the first match of `a` and the first later match of `b`. */
  between(a: EvPredicate, b: EvPredicate): Ev[] {
    const all = this.events();
    const start = all.find(a);
    if (start === undefined) return [];
    const end = all.find((event) => event.seq > start.seq && b(event));
    return all.filter((event) => event.seq > start.seq && (end === undefined || event.seq < end.seq));
  }

  /** Wall-clock ms from the first match of `from` to the first later match of `to`. */
  latencyMs(from: EvPredicate, to: EvPredicate): number | null {
    const all = this.events();
    const start = all.find(from);
    if (start === undefined) return null;
    const end = all.find((event) => event.seq >= start.seq && to(event));
    if (end === undefined) return null;
    return Date.parse(end.createdAt) - Date.parse(start.createdAt);
  }

  /** The `n` events immediately following the first match of `after`. */
  eventsWithin(after: EvPredicate, n: number): Ev[] {
    const all = this.events();
    const start = all.find(after);
    if (start === undefined) return [];
    return all.filter((event) => event.seq > start.seq).slice(0, n);
  }

  /** tool.called joined to tool.completed, both lanes. */
  toolCalls(lane?: "main" | "agent", name?: string): ToolCall[] {
    const calls: ToolCall[] = [];
    const completions = new Map<string, Ev>();
    for (const event of this.events(/^(user_session|agent_session)\.tool\.completed$/)) {
      const callId = event.payload.callId;
      if (typeof callId === "string") completions.set(callId, event);
    }
    for (const event of this.events(/^(user_session|agent_session)\.tool\.called$/)) {
      const callLane: "main" | "agent" = event.type.startsWith("user_session") ? "main" : "agent";
      if (lane !== undefined && callLane !== lane) continue;
      const callName = String(event.payload.name ?? "");
      if (name !== undefined && callName !== name) continue;
      const callId = String(event.payload.callId ?? "");
      const completed = completions.get(callId) ?? null;
      calls.push({
        lane: callLane,
        agent: typeof event.payload.agent === "string" ? event.payload.agent : null,
        callId,
        name: callName,
        input: event.payload.input,
        calledSeq: event.seq,
        calledAt: event.createdAt,
        completedSeq: completed?.seq ?? null,
        completedAt: completed?.createdAt ?? null,
        isError: completed !== null && asBool((completed.payload as { isError?: unknown }).isError),
      });
    }
    return calls;
  }

  questions(): QuestionExchange[] {
    const answered = this.events("user_session.question.answered");
    return this.events("user_session.question.asked").map((asked) => {
      const match = answered.find(
        (event) => event.seq > asked.seq && event.payload.interactionId === asked.payload.interactionId,
      ) ?? null;
      return {
        asked,
        answered: match,
        blockedMs: match === null ? null : Date.parse(match.createdAt) - Date.parse(asked.createdAt),
        dismissed: match !== null && asBool((match.payload as { dismissed?: unknown }).dismissed),
      };
    });
  }

  agentSessions(): AgentSessionRow[] {
    const sessions = this.#userSessionId === null
      ? this.#all("SELECT id, user_session_id, title, lifecycle, pattern, parent_agent_session_id, created_at FROM agent_sessions ORDER BY created_at")
      : this.#all("SELECT id, user_session_id, title, lifecycle, pattern, parent_agent_session_id, created_at FROM agent_sessions WHERE user_session_id = ? ORDER BY created_at", this.#userSessionId);
    return sessions.map((row) => ({
      id: row.id as string,
      userSessionId: row.user_session_id as string,
      title: row.title as string,
      lifecycle: row.lifecycle as string,
      pattern: row.pattern as string,
      parentAgentSessionId: (row.parent_agent_session_id as string | null) ?? null,
      createdAt: row.created_at as string,
      agents: this.#all(
        "SELECT name, role, profile_id, model FROM agents WHERE agent_session_id = ? ORDER BY ord",
        row.id,
      ).map((agent) => ({
        name: agent.name as string,
        role: agent.role as string,
        profileId: (agent.profile_id as string | null) ?? null,
        model: (agent.model as string | null) ?? null,
      })),
    }));
  }

  handoffs(filter?: (row: HandoffRow) => boolean): HandoffRow[] {
    const rows = this.#userSessionId === null
      ? this.#all("SELECT id, agent_session_id, sender, recipient, profile_id, trigger, synthetic, core, extension, bytes, created_at FROM handoff_records ORDER BY created_at, rowid")
      : this.#all("SELECT id, agent_session_id, sender, recipient, profile_id, trigger, synthetic, core, extension, bytes, created_at FROM handoff_records WHERE user_session_id = ? ORDER BY created_at, rowid", this.#userSessionId);
    const seqs = this.#handoffSeqs();
    const mapped = rows.map((row) => ({
      id: row.id as string,
      agentSessionId: (row.agent_session_id as string | null) ?? null,
      sender: row.sender as string,
      recipient: row.recipient as string,
      profileId: (row.profile_id as string | null) ?? null,
      trigger: row.trigger as string,
      synthetic: asBool(row.synthetic),
      core: typeof row.core === "string" ? (JSON.parse(row.core as string) as Record<string, unknown>) : ((row.core ?? {}) as Record<string, unknown>),
      extension: typeof row.extension === "string" ? (JSON.parse(row.extension as string) as Record<string, unknown>) : ((row.extension ?? {}) as Record<string, unknown>),
      bytes: row.bytes as number,
      createdAt: row.created_at as string,
      seq: seqs.get(row.id as string) ?? null,
    }));
    return filter === undefined ? mapped : mapped.filter(filter);
  }

  #handoffSeqCache: Map<string, number> | null = null;

  /** handoff id → seq of its handoff.created event. */
  #handoffSeqs(): Map<string, number> {
    if (this.#handoffSeqCache === null) {
      this.#handoffSeqCache = new Map();
      for (const event of this.events("handoff.created")) {
        const id = (event.payload as { handoff?: { id?: unknown } }).handoff?.id;
        if (typeof id === "string" && !this.#handoffSeqCache.has(id)) this.#handoffSeqCache.set(id, event.seq);
      }
    }
    return this.#handoffSeqCache;
  }

  /**
   * One row per commissioned session: the FIRST main→session assignment
   * handoff — by construction the creation briefing. why/expecting come from
   * THAT handoff, so later steering can never overwrite a commission's
   * rationale in the read-model.
   */
  commissions(): CommissionRow[] {
    const seen = new Set<string>();
    const rows: CommissionRow[] = [];
    for (const handoff of this.handoffs((row) =>
      row.sender === "main" && row.trigger === "assignment" && row.agentSessionId !== null && !row.synthetic)) {
      if (seen.has(handoff.agentSessionId!)) continue;
      seen.add(handoff.agentSessionId!);
      const data = ((handoff.extension as { data?: Record<string, unknown> }).data ?? {}) as { why?: unknown; expecting?: unknown };
      rows.push({
        agentSessionId: handoff.agentSessionId!,
        handoffId: handoff.id,
        seq: handoff.seq,
        action: String((handoff.core as { action?: unknown }).action ?? ""),
        why: typeof data.why === "string" && data.why !== "" ? data.why : null,
        expecting: typeof data.expecting === "string" && data.expecting !== "" ? data.expecting : null,
        createdAt: handoff.createdAt,
      });
    }
    return rows;
  }

  /** agent_session.result.returned events for ONE session — its returned results. */
  resultsOf(agentSessionId: string): Ev[] {
    return this.events("agent_session.result.returned", (_payload, event) => event.agentSessionId === agentSessionId);
  }

  /** Requirement revisions — the canonical spec's committed-structure history. */
  requirementRevisions(): RevisionTraceRow[] {
    if (!this.#tableExists("requirement_revisions")) return [];
    const rows = this.#userSessionId === null
      ? this.#all("SELECT id, revision, document, change_note, status, origin, interaction_id, created_at, approved_at FROM requirement_revisions ORDER BY revision")
      : this.#all("SELECT id, revision, document, change_note, status, origin, interaction_id, created_at, approved_at FROM requirement_revisions WHERE user_session_id = ? ORDER BY revision", this.#userSessionId);
    return rows.map((row) => ({
      id: row.id as string,
      revision: row.revision as number,
      document: row.document as string,
      changeNote: (row.change_note as string | null) ?? null,
      status: row.status as string,
      origin: row.origin as string,
      interactionId: (row.interaction_id as string | null) ?? null,
      createdAt: row.created_at as string,
      approvedAt: (row.approved_at as string | null) ?? null,
    }));
  }

  /** ALL columns — strategyWhy, uncertainties, assumptions, risks, completion included; the decision-time evidence layer reads these. */
  stateRevisions(): StateRevisionTraceRow[] {
    if (!this.#tableExists("orchestration_state_revisions")) return [];
    const rows = this.#userSessionId === null
      ? this.#all("SELECT id, revision, trigger, strategy, strategy_why, uncertainties, assumptions, risks, note, completion, created_at FROM orchestration_state_revisions ORDER BY revision")
      : this.#all("SELECT id, revision, trigger, strategy, strategy_why, uncertainties, assumptions, risks, note, completion, created_at FROM orchestration_state_revisions WHERE user_session_id = ? ORDER BY revision", this.#userSessionId);
    const json = <T>(value: unknown, fallback: T): T => {
      if (typeof value !== "string") return (value as T | null) ?? fallback;
      try { return JSON.parse(value) as T; } catch { return fallback; }
    };
    return rows.map((row) => ({
      id: row.id as string,
      revision: row.revision as number,
      trigger: row.trigger as string,
      strategy: (row.strategy as string | null) ?? "",
      strategyWhy: (row.strategy_why as string | null) ?? "",
      uncertainties: json<string[]>(row.uncertainties, []),
      assumptions: json<string[]>(row.assumptions, []),
      risks: json<string[]>(row.risks, []),
      note: (row.note as string | null) ?? null,
      completion: json<Record<string, unknown> | null>(row.completion, null),
      createdAt: row.created_at as string,
    }));
  }

  #tableExists(name: string): boolean {
    return this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  }

  tasks(): TaskRow[] {
    const rows = this.#userSessionId === null
      ? this.#all("SELECT id, subject, status, owner, agent_session_id, created_at, updated_at FROM tasks ORDER BY created_at")
      : this.#all("SELECT id, subject, status, owner, agent_session_id, created_at, updated_at FROM tasks WHERE user_session_id = ? ORDER BY created_at", this.#userSessionId);
    return rows.map((row) => ({
      id: row.id as string,
      subject: row.subject as string,
      status: row.status as string,
      owner: (row.owner as string | null) ?? null,
      agentSessionId: (row.agent_session_id as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }));
  }

  interactions(): { id: string; kind: string; status: string; participant: string | null; payload: Record<string, unknown>; response: Record<string, unknown> | null }[] {
    const rows = this.#userSessionId === null
      ? this.#all("SELECT id, kind, status, participant, payload, response FROM interactions ORDER BY created_at")
      : this.#all("SELECT id, kind, status, participant, payload, response FROM interactions WHERE user_session_id = ? ORDER BY created_at", this.#userSessionId);
    return rows.map((row) => ({
      id: row.id as string,
      kind: row.kind as string,
      status: row.status as string,
      participant: (row.participant as string | null) ?? null,
      payload: typeof row.payload === "string" ? (JSON.parse(row.payload as string) as Record<string, unknown>) : {},
      response: typeof row.response === "string" ? (JSON.parse(row.response as string) as Record<string, unknown>) : null,
    }));
  }

  usage(): UsageSummary {
    const rows = this.#userSessionId === null
      ? this.#all("SELECT participant, cost_usd, input_tokens, output_tokens, duration_ms, status FROM usage_samples")
      : this.#all("SELECT participant, cost_usd, input_tokens, output_tokens, duration_ms, status FROM usage_samples WHERE user_session_id = ?", this.#userSessionId);
    const summary: UsageSummary = { costUsd: 0, inputTokens: 0, outputTokens: 0, perParticipant: {}, turnDurationsMs: [] };
    for (const row of rows) {
      const participant = row.participant as string;
      const per = (summary.perParticipant[participant] ??= { turns: 0, costUsd: 0, outputTokens: 0, errors: 0 });
      per.turns += 1;
      per.costUsd += (row.cost_usd as number | null) ?? 0;
      per.outputTokens += (row.output_tokens as number | null) ?? 0;
      if (row.status !== "completed") per.errors += 1;
      summary.costUsd += (row.cost_usd as number | null) ?? 0;
      summary.inputTokens += (row.input_tokens as number | null) ?? 0;
      summary.outputTokens += (row.output_tokens as number | null) ?? 0;
      if (typeof row.duration_ms === "number") summary.turnDurationsMs.push(row.duration_ms);
    }
    return summary;
  }

  /**
   * Concurrency profile of agent work ACROSS SESSIONS, from turn
   * started/settled interleaving. Within-session overlap (a coordinator's
   * turn still open while its specialist starts) is deliberately not counted —
   * "parallel work" means independent workstreams running at once.
   */
  parallelism(): ParallelismSummary {
    const bySeq = this.events(/^agent_session\.turn\.(started|settled)$/);
    const openTurnsPerSession = new Map<string, Set<string>>();
    const turnSession = new Map<string, string>();
    let max = 0;
    let overlapMs = 0;
    let overlapStart: number | null = null;
    for (const event of bySeq) {
      const turnId = String(event.payload.turnId ?? "");
      const sessionId = event.agentSessionId ?? "?";
      const at = Date.parse(event.createdAt);
      if (event.type.endsWith("started")) {
        turnSession.set(turnId, sessionId);
        const open = openTurnsPerSession.get(sessionId) ?? new Set<string>();
        open.add(turnId);
        openTurnsPerSession.set(sessionId, open);
      } else {
        const owner = turnSession.get(turnId);
        if (owner === undefined) continue;
        turnSession.delete(turnId);
        const open = openTurnsPerSession.get(owner);
        open?.delete(turnId);
        if (open !== undefined && open.size === 0) openTurnsPerSession.delete(owner);
      }
      const activeSessions = openTurnsPerSession.size;
      max = Math.max(max, activeSessions);
      if (activeSessions >= 2 && overlapStart === null) overlapStart = at;
      if (activeSessions < 2 && overlapStart !== null) {
        overlapMs += at - overlapStart;
        overlapStart = null;
      }
    }
    return { maxConcurrentAgentTurns: max, totalOverlapMs: overlapMs };
  }

  decisions(): Ev[] {
    return this.events("operator.decision.recorded");
  }

  close(): void {
    this.#db.close();
  }
}
