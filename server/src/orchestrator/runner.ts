/**
 * OrchestratorRunner: one PERSISTENT streaming-input SDK conversation per
 * UserSession (the CLI's own architecture). Jobs still drain strictly serially
 * per session, but a job no longer spawns a query — it pushes one user message
 * into the live lane and awaits the turn's settle, detected from the output
 * stream (result message, with the SDK's session_state_changed idle signal as
 * backstop). Wake jobs coalesce while a turn is in flight; operator jobs queue
 * in order. Interrupt is query.interrupt() — the lane and its resume state
 * survive; abort is lane-fatal and reserved for close/shutdown/recycle.
 *
 * Lanes spawn lazily on the first job and respawn transparently (resume) after
 * a close or an in-process CLI death: a closed lane and a never-opened lane
 * are indistinguishable, which is what keeps crash recovery free.
 *
 * NOTE maxTurns is deliberately NOT set: in streaming mode it counts turns
 * cumulatively across the whole session run, so any cap kills a long-lived
 * lane eventually.
 */
import type { HandoffDraft, PostMessageResponse } from "@agentique-console/shared";
import { AsyncQueue } from "../async-queue.ts";
import type { Config } from "../config.ts";
import { Repo, toWireMessage, type UserSessionRow } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { RuntimeBroadcaster } from "../events/runtime.ts";
import { newId, nowIso } from "../ids.ts";
import { rotationTokenLimit } from "../model-catalog.ts";
import { evaluateCheckpointDraft } from "../handoffs/checkpoint-gate.ts";
import { badRequest, conflict, notFound } from "../api/errors.ts";
import { mapSdkMessage } from "../sdk/mapping.ts";
import type {
  ConsoleSdk,
  QueryHandle,
  SdkOptions,
  SdkUserMessageLike,
} from "../sdk/types.ts";
import type { DecisionLedger } from "./decisions.ts";
import type { InteractionService } from "./interactions.ts";
import { buildOrchestratorOptions } from "./options.ts";
import { buildOrchestratorCanUseTool, type LaneState } from "./permissions.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { HandoffDraftSchema, HANDOFF_DRAFT_JSON_SCHEMA } from "../handoffs/schema.ts";
import { sdkEnv } from "../sdk/env.ts";
import type { AgentSessionHost } from "../agent-sessions/host.ts";
import { mainPeerName } from "../agent-sessions/peer-names.ts";
import { mergeHooks } from "../sdk/hooks.ts";
import { buildCronHooks, cronDue } from "./cron-hooks.ts";
import type { TaskService } from "../tasks/service.ts";
import type { SdkHooksFragment } from "../sdk/types.ts";

type Job =
  | { kind: "operator"; text: string }
  | { kind: "answer-revival"; text: string }
  | { kind: "agent-milestone"; text: string; agentSessionId: string }
  | { kind: "cron"; text: string };

interface ActiveTurn {
  turnId: string;
  trigger: "operator" | "wake" | "answer";
  startedAt: number;
  settled: Promise<void>;
  resolve: () => void;
  outcome: {
    status: "completed" | "error" | "aborted";
    errorMessage: string | undefined;
  };
}

interface Lane {
  queue: Job[];
  draining: boolean;
  /** The persistent streaming query; null = closed (respawn on next job). */
  query: QueryHandle | null;
  /** The prompt iterable fed to query() — one push per turn. */
  input: AsyncQueue<SdkUserMessageLike> | null;
  /** Lane-scoped; abort is fatal, used only by #closeLane. */
  abort: AbortController | null;
  pump: Promise<void> | null;
  activeTurn: ActiveTurn | null;
  /** Per-lane canUseTool state, reset by #runTurn at each turn start. */
  state: LaneState;
  runtime: RuntimeBroadcaster;
  /** Mode changed mid-turn: close after settle so fresh options apply. */
  recycleAfterTurn: boolean;
  /**
   * A5: operator messages pushed into the live turn (true steering). The CLI
   * either folds them into the running turn or runs them as its own next
   * turn — the settle path mints a follow-up turn to catch that output.
   */
  steeredMidTurn: number;
  /** Exact duplicate suppression across wake turns (not reset per turn). */
  lastOperatorFacingText: string;
  /** Tool-call start times used to emit useful timeline durations. */
  toolStarts: Map<string, number>;
  /**
   * Peak context-window occupancy this provider session, from per-API-call
   * usage — NOT the result message's turn-wide `inputTokens` sum, which
   * overstates occupancy by 5-25x on a tool-heavy turn and made every seat
   * rotate after a single turn in the db-live-1 run.
   */
  contextTokens: number;
  /** Last cumulative cost/api-duration seen, for per-turn deltas. */
  lastCumulative: { costUsd: number; apiDurationMs: number };
}

/**
 * `cumulativeCostUsd`/`cumulativeApiDurationMs` restate the provider session's
 * running total on every result, so a turn's own figure is the delta since the
 * lane last saw one. Recording them raw overstated the db-live-1 ledger by 25%.
 * Mutates the lane's watermark as a side effect — call exactly once per result.
 */
function laneUsageDeltas(lane: Lane, event: { cumulativeCostUsd?: number; cumulativeApiDurationMs?: number }): { costUsd: number | null; apiDurationMs: number | null } {
  // A total BELOW the watermark means the counter restarted underneath us (a
  // genuinely fresh provider session). Take the raw value rather than clamping
  // a real turn to zero — correct under either SDK behaviour.
  if (event.cumulativeCostUsd !== undefined && event.cumulativeCostUsd < lane.lastCumulative.costUsd) {
    lane.lastCumulative.costUsd = 0;
    lane.lastCumulative.apiDurationMs = 0;
  }
  const costUsd = event.cumulativeCostUsd === undefined ? null : Math.max(0, event.cumulativeCostUsd - lane.lastCumulative.costUsd);
  const apiDurationMs = event.cumulativeApiDurationMs === undefined ? null : Math.max(0, event.cumulativeApiDurationMs - lane.lastCumulative.apiDurationMs);
  if (event.cumulativeCostUsd !== undefined) lane.lastCumulative.costUsd = event.cumulativeCostUsd;
  if (event.cumulativeApiDurationMs !== undefined) lane.lastCumulative.apiDurationMs = event.cumulativeApiDurationMs;
  return { costUsd, apiDurationMs };
}

export interface OrchestratorDeps {
  repo: Repo;
  bus: EventBus;
  config: Config;
  sdk: () => Promise<ConsoleSdk>;
  interactions: InteractionService;
  getWorkspaceRoot: (workspaceId: string) => string;
  /** M6: the console MCP server bound to one user session. */
  buildMcpServer?: (userSessionId: string, sdk: ConsoleSdk) => unknown;
  /** Eager console-owned provider journal. */
  sessionStore?: unknown;
  handoffs: HandoffService;
  /**
   * Operator decisions, injected into the lane's system prompt so main never
   * contradicts a call the operator already made — and never has to relay one.
   * Required: as an optional dep it was once wired in tests and forgotten in
   * main.ts, which switched the ledger off in production while every test
   * passed.
   */
  decisions: DecisionLedger;
  /** Lazy — the host is constructed after the runner; it backs the lane's
   * SendMessage middleware (main identity) and peer-inbound resolution. */
  host?: () => AgentSessionHost;
  /** Native task-tool mirroring for the lane. */
  tasks?: TaskService;
}

/** Bounded grace for a closing lane's pump before the hard abort. */
const CLOSE_GRACE_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class OrchestratorRunner {
  readonly #deps: OrchestratorDeps;
  readonly #lanes = new Map<string, Lane>();
  /** Notified after every turn settle; the completion predicate re-evaluates. */
  #onSettled: ((userSessionId: string) => void) | undefined;
  /** Notified before an operator message is processed; reopens a signed-off run. */
  #onOperatorMessage: ((userSessionId: string) => void) | undefined;

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
  }

  /** Persists an operator message, dismisses pending cards, queues a turn. */
  postOperatorMessage(sessionId: string, text: string): PostMessageResponse {
    // Chat while a sign-off card is open IS a change request. Without this the
    // operator types "actually add X", the orchestrator answers, and the card
    // sits there still claiming the run is done.
    this.#onOperatorMessage?.(sessionId);
    const { repo, bus, interactions } = this.#deps;
    const session = repo.getUserSession(sessionId);
    if (!session) throw notFound(`no user session ${sessionId}`);
    if (session.status !== "open") {
      throw conflict(`session ${sessionId} is archived`);
    }
    const trimmed = text.trim();
    if (trimmed === "") throw badRequest("message text is required");

    interactions.dismissPendingForChat(sessionId, trimmed);

    const row = repo.appendMessage({
      sessionKind: "user",
      sessionId,
      speaker: { kind: "operator", name: "operator" },
      kind: "message",
      text: trimmed,
    });
    bus.append({
      type: "user_session.message",
      userSessionId: sessionId,
      payload: { sessionId, message: toWireMessage(row) },
    });
    repo.touchUserSession(sessionId);
    // A5: a message landing mid-turn steers the live turn instead of queueing
    // behind it — pushed straight into the stream, exactly like typing into
    // the CLI while it works.
    const lane = this.#lane(sessionId);
    if (lane.activeTurn && lane.input) {
      lane.steeredMidTurn += 1;
      lane.input.push(this.#userMessage(trimmed, { kind: "human" }));
    } else {
      this.#enqueue(sessionId, { kind: "operator", text: trimmed });
    }
    return { messageId: row.id, seq: row.seq };
  }

  /** M8: a stale interaction was answered after a restart. */
  enqueueRevival(userSessionId: string, text: string): void {
    this.#enqueue(userSessionId, { kind: "answer-revival", text });
  }

  /**
   * Fallback scheduler for mirrored crons. The CLI fires its own jobs while
   * the lane process lives; a closed lane (parked, recycled, restarted) has
   * no scheduler, so the console re-fires due crons from the mirror — only
   * when the lane is closed, which is what prevents double-firing.
   */
  #cronTimer: NodeJS.Timeout | null = null;
  #cronFired = new Map<string, string>();
  startCronFallback(): void {
    if (this.#cronTimer) return;
    this.#cronTimer = setInterval(() => this.#cronTick(new Date()), 30_000);
    this.#cronTimer.unref?.();
  }
  stopCronFallback(): void {
    if (this.#cronTimer) { clearInterval(this.#cronTimer); this.#cronTimer = null; }
  }
  #cronTick(now: Date): void {
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}T${now.getHours()}:${now.getMinutes()}`;
    for (const session of this.#deps.repo.listOpenUserSessions()) {
      // Console-owned deadlines fire whether or not the lane is live — that is
      // the whole reason for owning them, and the minute-resolution cron
      // matcher below is too coarse for a check-in timer anyway.
      for (const deadline of this.#deps.repo.listDueDeadlines(session.id, now.toISOString())) {
        this.#deps.repo.patchCron(deadline.id, { status: "deleted" });
        this.#deps.bus.append({ type: "user_session.runtime", userSessionId: session.id,
          payload: { sessionId: session.id, detail: `deadline fired: ${deadline.prompt}` } });
        this.#enqueue(session.id, { kind: "cron", text: `[Deadline you set has arrived]\n${deadline.prompt}` });
      }
      const lane = this.#lanes.get(session.id);
      if (lane?.query) continue; // the CLI's own scheduler owns a live lane
      for (const cron of this.#deps.repo.listCrons(session.id)) {
        if (this.#cronFired.get(cron.id) === minute || !cronDue(cron.schedule, now)) continue;
        this.#cronFired.set(cron.id, minute);
        this.#deps.bus.append({ type: "user_session.runtime", userSessionId: session.id,
          payload: { sessionId: session.id, detail: `cron fallback fired ${cron.sdkCronId} (${cron.schedule})` } });
        this.#enqueue(session.id, { kind: "cron", text: `[Scheduled task ${cron.sdkCronId} fired (${cron.schedule})]\n${cron.prompt}` });
        if (cron.oneShot) this.#deps.repo.patchCron(cron.id, { status: "deleted" });
      }
    }
    if (this.#cronFired.size > 256) this.#cronFired.clear();
  }

  /** Material AgentSession reports only. Repeated reports coalesce per session. */
  enqueueAgentMilestone(userSessionId: string, agentSessionId: string, category: string, text: string): void {
    const lane = this.#lane(userSessionId);
    const prompt = `[AgentSession ${agentSessionId} ${category}]\n${text.slice(0, 8_192)}`;
    const existing = lane.queue.find((job): job is Extract<Job, { kind: "agent-milestone" }> => job.kind === "agent-milestone" && job.agentSessionId === agentSessionId);
    // APPEND, never overwrite. `existing.text = prompt` looked like coalescing
    // and was actually data loss: two reports arriving before the coordinator
    // drained meant the first one silently vanished. Losing a milestone is
    // strictly worse than a longer prompt.
    if (existing) existing.text = `${existing.text}\n\n${prompt}`;
    else lane.queue.push({ kind: "agent-milestone", agentSessionId, text: prompt });
    if (!lane.draining) void this.#drain(userSessionId);
  }

  /**
   * Interrupts the in-flight turn. The lane survives: the CLI aborts the turn
   * and emits an interrupted result, which settles it through the normal path.
   */
  interrupt(sessionId: string): void {
    const lane = this.#lanes.get(sessionId);
    if (!lane?.query || !lane.activeTurn) return;
    void lane.query.interrupt?.().catch(() => undefined);
  }

  /** Archive: interrupt anything in flight and shut the lane down. */
  async closeSession(sessionId: string): Promise<void> {
    const lane = this.#lanes.get(sessionId);
    if (!lane) return;
    await this.#closeLane(lane, { interrupt: true });
  }

  /**
   * Options are frozen at lane spawn (mode/phase shape the system prompt and
   * permission mode), so a mode change closes the lane once idle; the next
   * message respawns it with fresh options over the same resume id.
   */
  recycleSession(sessionId: string): void {
    const lane = this.#lanes.get(sessionId);
    if (!lane?.query) return;
    if (lane.activeTurn) {
      lane.recycleAfterTurn = true;
      return;
    }
    void this.#closeLane(lane, { interrupt: false });
  }

  /** Shutdown: no CLI subprocess may outlive the server. */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.#lanes.values()].map((lane) =>
        this.#closeLane(lane, { interrupt: true }),
      ),
    );
  }

  queuedJobs(sessionId: string): number {
    const lane = this.#lanes.get(sessionId);
    if (!lane) return 0;
    return lane.queue.length + (lane.draining ? 1 : 0);
  }

  /** True while a turn is in flight or queued. */
  onSettled(handler: (userSessionId: string) => void): void {
    if (this.#onSettled) throw new Error("onSettled is already registered — wire callbacks once, in createApp");
    this.#onSettled = handler;
  }

  onOperatorMessage(handler: (userSessionId: string) => void): void {
    if (this.#onOperatorMessage) throw new Error("onOperatorMessage is already registered — wire callbacks once, in createApp");
    this.#onOperatorMessage = handler;
  }

  busy(sessionId: string): boolean {
    // activeTurn covers the steer-minted follow-up turn no drain job owns.
    return (
      this.queuedJobs(sessionId) > 0 ||
      this.#lanes.get(sessionId)?.activeTurn != null
    );
  }

  /**
   * Like `busy()` inverted, except a turn parked inside `canUseTool` waiting on
   * an operator card does NOT count as working.
   *
   * This distinction is the whole reason the method exists. db-live-2's last
   * turn never settled because `AskUserQuestion` awaits its resolution forever
   * — so `busy()` was true, the spinner ran, and nothing could tell "finished"
   * from "in progress". The run had not gone quiet; it had gone interrogative.
   */
  laneIdle(sessionId: string): boolean {
    const lane = this.#lanes.get(sessionId);
    if (!lane) return true;
    if (lane.queue.length > 0 || lane.draining) return false;
    return lane.activeTurn === null || this.#deps.interactions.listPending(sessionId).length > 0;
  }

  #lane(sessionId: string): Lane {
    let lane = this.#lanes.get(sessionId);
    if (!lane) {
      lane = {
        queue: [],
        draining: false,
        query: null,
        input: null,
        abort: null,
        pump: null,
        activeTurn: null,
        state: { lastAssistantText: "" },
        runtime: new RuntimeBroadcaster(
          this.#deps.bus,
          { kind: "user", sessionId },
          "orchestrator",
          { userSessionId: sessionId },
        ),
        recycleAfterTurn: false,
        steeredMidTurn: 0,
        lastOperatorFacingText: "",
        toolStarts: new Map(),
        contextTokens: 0,
        lastCumulative: { costUsd: 0, apiDurationMs: 0 },
      };
      this.#lanes.set(sessionId, lane);
    }
    return lane;
  }

  #enqueue(sessionId: string, job: Job): void {
    const lane = this.#lane(sessionId);
    lane.queue.push(job);
    if (!lane.draining) void this.#drain(sessionId);
  }

  async #drain(sessionId: string): Promise<void> {
    const lane = this.#lane(sessionId);
    lane.draining = true;
    try {
      for (;;) {
        const job = lane.queue.shift();
        if (!job) break;
        await this.#runTurn(sessionId, lane, job);
      }
    } finally {
      lane.draining = false;
    }
  }

  async #runTurn(sessionId: string, lane: Lane, job: Job): Promise<void> {
    const { repo, bus } = this.#deps;
    const session = repo.getUserSession(sessionId);
    if (!session || session.status !== "open") return;

    // The standing instruction goes on ONCE, at drain, rather than being
    // baked into each milestone — several appended reports would otherwise
    // repeat it verbatim and teach the model to skim.
    const prompt = job.kind === "agent-milestone"
      ? `${job.text}\n\nAct only if needed. Do not repeat an unchanged operator update. Use read_agent_session for additional detail only when necessary.`
      : job.text;
    if (prompt === "") return;

    const turnId = newId("turn");
    const trigger = job.kind === "operator" ? "operator" : job.kind === "agent-milestone" || job.kind === "cron" ? "wake" : "answer";
    bus.append({
      type: "user_session.turn.started",
      userSessionId: sessionId,
      payload: { sessionId, turnId, trigger },
    });

    lane.state.lastAssistantText = "";
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const turn: ActiveTurn = {
      turnId,
      trigger,
      startedAt: Date.now(),
      settled,
      resolve: resolveSettled,
      outcome: { status: "completed", errorMessage: undefined },
    };
    lane.activeTurn = turn;

    try {
      await this.#rotateContextIfNeeded(sessionId, lane);
      await this.#ensureLaneQuery(sessionId, lane);
      lane.runtime.set("thinking");
      // Push synchronously after ensure — no await in between, so the input
      // queue cannot have been closed under us.
      (lane.input as AsyncQueue<SdkUserMessageLike>).push(
        this.#userMessage(
          prompt,
          job.kind === "operator" ? { kind: "human" } : undefined,
        ),
      );
    } catch (error) {
      turn.outcome = {
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      console.error(`orchestrator lane spawn failed (${sessionId}):`, error);
      this.#settleTurn(sessionId, lane);
      return;
    }

    await turn.settled;

    if (lane.recycleAfterTurn) {
      lane.recycleAfterTurn = false;
      await this.#closeLane(lane, { interrupt: false });
    }
  }

  /**
   * A turn the CLI started on its own (a peer message draining into the idle
   * lane): give it console bookends so the timeline pairs started/settled.
   * Nobody awaits its settle — result/turn-idle events close it normally.
   */
  #mintExogenousTurn(sessionId: string, lane: Lane): void {
    const turnId = newId("turn");
    this.#deps.bus.append({ type: "user_session.turn.started", userSessionId: sessionId,
      payload: { sessionId, turnId, trigger: "wake" } });
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    lane.activeTurn = { turnId, trigger: "wake", startedAt: Date.now(), settled, resolve: resolveSettled,
      outcome: { status: "completed", errorMessage: undefined } };
    lane.runtime.set("thinking");
  }

  /**
   * The model this session's orchestrator lane runs on. The session's own
   * choice wins; a session that recorded none (the profile manager, and every
   * row written before the column existed) tracks the configured default.
   * Seats do not read this — they resolve their model from their profile.
   */
  #modelFor(session: Pick<UserSessionRow, "model">): string {
    return session.model ?? this.#deps.config.model;
  }

  /** Spawns the persistent query if the lane has none (lazy + post-death). */
  async #ensureLaneQuery(sessionId: string, lane: Lane): Promise<void> {
    if (lane.query) return;
    const { repo, bus, config, interactions } = this.#deps;
    const session = repo.getUserSession(sessionId);
    if (!session) throw notFound(`no user session ${sessionId}`);

    const sdk = await this.#deps.sdk();
    const abort = new AbortController();
    const input = new AsyncQueue<SdkUserMessageLike>();
    const host = this.#deps.host?.();
    const fragments: SdkHooksFragment[] = [];
    if (host && session.purpose !== "profile_manager") {
      // Main reaches its coordinator, and its ledger, through the console tool
      // surface — the same single path every seat uses. No send middleware, no
      // peer carry, and no native task mirror keyed to a provider session that
      // dies at every rotation.
      fragments.push(buildCronHooks({ repo, bus, userSessionId: sessionId }));
    }
    const options = buildOrchestratorOptions({
      workspaceRoot: this.#deps.getWorkspaceRoot(session.workspaceId),
      resume: session.sdkSessionId,
      mode: session.mode,
      phase: session.phase,
      model: this.#modelFor(session),
      effort: config.effort,
      abortController: abort,
      canUseTool: buildOrchestratorCanUseTool({
        userSessionId: sessionId,
        repo,
        bus,
        interactions,
        laneState: lane.state,
      }),
      mcpServer: this.#deps.buildMcpServer?.(sessionId, sdk),
      sessionStore: this.#deps.sessionStore,
      contextMemory: session.latestHandoffId
        ? JSON.stringify(this.#deps.handoffs.get(session.latestHandoffId), null, 2)
        : session.memory,
      decisionDigest: this.#deps.decisions.digest(sessionId),
      purpose: session.purpose,
      peerName: mainPeerName(config.peerNamePrefix, sessionId),
      ...(fragments.length > 0 ? { hooks: mergeHooks(fragments) as SdkOptions["hooks"] } : {}),
    });

    const query = sdk.query({ prompt: input, options });
    lane.query = query;
    lane.input = input;
    lane.abort = abort;
    // Occupancy is re-reported by the first assistant message of any new
    // process, so it always restarts at zero.
    lane.contextTokens = 0;
    // Cost and api-duration do NOT: `resume: session.sdkSessionId` above keeps
    // the same provider session, and the SDK's cumulative totals continue
    // across the process that started them. The baseline therefore belongs to
    // the provider session and is persisted with it — zeroing it here billed a
    // whole session-to-date to one turn (db-live-1: $4.4875 for 55 seconds).
    lane.lastCumulative = session.sdkSessionId === null
      ? { costUsd: 0, apiDurationMs: 0 }
      : { costUsd: session.cumulativeCostUsd, apiDurationMs: session.cumulativeApiDurationMs };
    lane.pump = this.#pumpOutput(sessionId, lane, query);
  }

  /** The one for-await over the lane's output; lives as long as the query. */
  async #pumpOutput(
    sessionId: string,
    lane: Lane,
    query: QueryHandle,
  ): Promise<void> {
    try {
      for await (const sdkMessage of query) {
        for (const event of mapSdkMessage(sdkMessage)) {
          this.#applyEvent(sessionId, lane, event);
        }
      }
      // Clean stream end (close, recycle, or the CLI exiting quietly). An
      // open turn cannot complete anymore.
      if (lane.activeTurn) {
        lane.activeTurn.outcome = {
          status: "aborted",
          errorMessage: "the conversation stream ended",
        };
        this.#settleTurn(sessionId, lane);
      }
    } catch (error) {
      // In-process lane death — new failure mode vs. process-per-turn. The
      // resume id survives in the DB, so the next job respawns transparently.
      console.error(`orchestrator lane died (${sessionId}):`, error);
      if (lane.activeTurn) {
        lane.activeTurn.outcome = {
          status: lane.abort?.signal.aborted ? "aborted" : "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        this.#settleTurn(sessionId, lane);
      }
      this.#notice(
        sessionId,
        "The orchestrator's session process died — send your message again to retry.",
      );
    } finally {
      lane.input?.close();
      query.close?.();
      if (lane.query === query) {
        lane.query = null;
        lane.input = null;
        lane.pump = null;
        lane.abort = null;
      }
      lane.runtime.idle();
    }
  }

  async #closeLane(
    lane: Lane,
    opts: { interrupt: boolean },
  ): Promise<void> {
    const query = lane.query;
    if (!query) return;
    if (opts.interrupt && lane.activeTurn) {
      try {
        await query.interrupt?.();
      } catch {
        // The stream may already be dead; the abort below covers it.
      }
    }
    lane.input?.close();
    if (lane.pump) await Promise.race([lane.pump, sleep(CLOSE_GRACE_MS)]);
    lane.abort?.abort();
    query.close?.();
    lane.query = null;
    lane.input = null;
    lane.pump = null;
    lane.abort = null;
  }

  #userMessage(
    text: string,
    origin: { kind: "human" } | undefined,
  ): SdkUserMessageLike {
    return {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      shouldQuery: true,
      uuid: crypto.randomUUID(),
      timestamp: nowIso(),
      // Operator input is human; console-synthesized pushes (wake digests,
      // revivals) carry no origin — never mis-stamp them human.
      ...(origin === undefined ? {} : { origin }),
    };
  }

  #settleTurn(sessionId: string, lane: Lane): void {
    // Fired FIRST so every return path below still schedules a re-evaluation.
    // Reading stale state here is harmless: the completion predicate is
    // debounced and re-runs when its timer fires, not when it was scheduled.
    this.#onSettled?.(sessionId);
    const turn = lane.activeTurn;
    if (!turn) return;
    lane.activeTurn = null;
    const { repo, bus } = this.#deps;
    lane.runtime.idle();
    repo.touchUserSession(sessionId);
    bus.append({
      type: "user_session.turn.settled",
      userSessionId: sessionId,
      payload: {
        sessionId,
        turnId: turn.turnId,
        status: turn.outcome.status,
        durationMs: Date.now() - turn.startedAt,
        ...(turn.outcome.errorMessage === undefined
          ? {}
          : { errorMessage: turn.outcome.errorMessage }),
        queuedJobs: lane.queue.length,
      },
    });
    turn.resolve();

    // A5: steered input the CLI may answer as its own next turn needs a turn
    // to land in. If it was instead folded into the turn that just settled,
    // the session_state_changed idle backstop settles this one immediately.
    // A dead lane mints nothing — the steer died with it, and the death
    // notice tells the operator to resend.
    if (lane.steeredMidTurn > 0 && lane.query) {
      lane.steeredMidTurn = 0;
      lane.state.lastAssistantText = "";
      const followId = newId("turn");
      bus.append({
        type: "user_session.turn.started",
        userSessionId: sessionId,
        payload: { sessionId, turnId: followId, trigger: "operator" },
      });
      let resolveFollow: () => void = () => undefined;
      const settled = new Promise<void>((resolve) => {
        resolveFollow = resolve;
      });
      lane.activeTurn = {
        turnId: followId,
        trigger: "operator",
        startedAt: Date.now(),
        settled,
        resolve: resolveFollow,
        outcome: { status: "completed", errorMessage: undefined },
      };
      lane.runtime.set("thinking");
    }
  }

  #notice(sessionId: string, text: string): void {
    const { repo, bus } = this.#deps;
    const row = repo.appendMessage({
      sessionKind: "user",
      sessionId,
      speaker: { kind: "system", name: "system" },
      kind: "notice",
      text,
    });
    bus.append({
      type: "user_session.message",
      userSessionId: sessionId,
      payload: { sessionId, message: toWireMessage(row) },
    });
  }

  #applyEvent(
    sessionId: string,
    lane: Lane,
    event: ReturnType<typeof mapSdkMessage>[number],
  ): void {
    const { repo, bus } = this.#deps;
    if ("parentCallId" in event && event.parentCallId !== undefined) {
      bus.append({ type: "user_session.runtime", userSessionId: sessionId, payload: { sessionId, detail: `blocked unowned native subagent event (${event.kind})` } });
      return;
    }
    const turn = lane.activeTurn;
    switch (event.kind) {
      case "resume": {
        const session = repo.getUserSession(sessionId);
        if (session && session.sdkSessionId !== event.resumeId) {
          repo.patchUserSession(sessionId, { sdkSessionId: event.resumeId });
        }
        return;
      }
      case "delta": {
        if (!turn) { bus.append({ type: "user_session.runtime", userSessionId: sessionId, payload: { sessionId, detail: "ignored late stream delta after turn settlement" } }); return; }
        const active = turn;
        lane.runtime.set("responding");
        bus.broadcast({
          type: "stream.delta",
          userSessionId: sessionId,
          payload: {
            scope: { kind: "user", sessionId },
            speaker: "orchestrator",
            turnId: active.turnId,
            text: event.text,
          },
        });
        return;
      }
      case "reasoning-delta": {
        if (!turn) { bus.append({ type: "user_session.runtime", userSessionId: sessionId, payload: { sessionId, detail: "ignored late reasoning delta after turn settlement" } }); return; }
        const active = turn;
        lane.runtime.set("thinking");
        bus.broadcast({
          type: "stream.reasoning",
          userSessionId: sessionId,
          payload: {
            scope: { kind: "user", sessionId },
            speaker: "orchestrator",
            turnId: active.turnId,
            text: event.text,
          },
        });
        return;
      }
      case "notice": {
        lane.runtime.note(event.text);
        bus.append({ type: "user_session.runtime", userSessionId: sessionId, payload: { sessionId, detail: event.text } });
        return;
      }
      case "message": {
        const active = turn;
        lane.state.lastAssistantText = event.text;
        const normalized = event.text.trim().replace(/\s+/g, " ");
        if (active?.trigger === "wake" && normalized !== "" && normalized === lane.lastOperatorFacingText) {
          bus.append({ type: "user_session.runtime", userSessionId: sessionId, payload: { sessionId, detail: "suppressed an exact duplicate orchestrator message" } });
          return;
        }
        lane.lastOperatorFacingText = normalized;
        const row = repo.appendMessage({
          sessionKind: "user",
          sessionId,
          speaker: { kind: "orchestrator", name: "orchestrator" },
          kind: "message",
          text: event.text,
          ...(active ? { turnId: active.turnId } : {}),
        });
        bus.append({
          type: "user_session.message",
          userSessionId: sessionId,
          payload: { sessionId, message: toWireMessage(row) },
        });
        return;
      }
      case "tool.call": {
        const active = turn;
        lane.toolStarts.set(event.callId, Date.now());
        lane.runtime.set("tool", event.name);
        bus.append({
          type: "user_session.tool.call",
          userSessionId: sessionId,
          payload: {
            sessionId,
            turnId: active?.turnId ?? "unattributed",
            callId: event.callId,
            name: event.name,
            input: bus.capture(event.input, { userSessionId: sessionId }),
          },
        });
        return;
      }
      case "tool.result": {
        lane.runtime.set("thinking");
        const captured = bus.captureSized(event.output, { userSessionId: sessionId });
        const toolStartedAt = lane.toolStarts.get(event.callId);
        lane.toolStarts.delete(event.callId);
        bus.append({
          type: "user_session.tool.result",
          userSessionId: sessionId,
          payload: {
            sessionId,
            callId: event.callId,
            turnId: turn?.turnId,
            output: captured.value,
            bytes: captured.bytes,
            ...(toolStartedAt === undefined ? {} : { durationMs: Date.now() - toolStartedAt }),
            ...(event.isError ? { isError: true } : {}),
          },
        });
        return;
      }
      case "context": {
        lane.contextTokens = Math.max(lane.contextTokens, event.occupancyTokens);
        return;
      }
      case "result": {
        const session = repo.getUserSession(sessionId);
        if (
          event.resumeId !== undefined &&
          session &&
          session.sdkSessionId !== event.resumeId
        ) {
          repo.patchUserSession(sessionId, { sdkSessionId: event.resumeId });
        }
        if (session) {
          const contextTokens = Math.max(session.contextTokens, lane.contextTokens);
          if (session.sdkTurnCount + 1 >= this.#deps.config.contextTurnLimit || contextTokens >= rotationTokenLimit(this.#deps.config.contextTokenLimit, this.#modelFor(session))) lane.recycleAfterTurn = true;
          const { costUsd, apiDurationMs } = laneUsageDeltas(lane, event);
          // One patch: turn count, context, and the advanced cumulative
          // baseline (persisted with the provider session it belongs to, so
          // the next process to resume it inherits the watermark).
          repo.patchUserSession(sessionId, { sdkTurnCount: session.sdkTurnCount + 1, contextTokens,
            cumulativeCostUsd: lane.lastCumulative.costUsd, cumulativeApiDurationMs: lane.lastCumulative.apiDurationMs });
          const usage = { id: newId("usage"), userSessionId: sessionId, agentSessionId: null, participant: "orchestrator", profileId: null,
            generation: session.sdkGeneration, turnId: turn?.turnId ?? "unattributed", inputTokens: event.inputTokens ?? 0,
            uncachedInputTokens: event.uncachedInputTokens ?? 0, cacheCreationInputTokens: event.cacheCreationInputTokens ?? 0, cacheReadInputTokens: event.cacheReadInputTokens ?? 0, outputTokens: event.outputTokens ?? 0,
            costUsd, model: event.modelId ?? this.#modelFor(session), effort: this.#deps.config.effort ?? null,
            trigger: turn?.trigger ?? null, durationMs: turn ? Date.now() - turn.startedAt : null, apiDurationMs, sdkDurationMs: event.sdkDurationMs ?? null, status: "completed", stopReason: event.stopReason ?? null, createdAt: nowIso() };
          repo.insertUsage(usage);
          bus.append({ type: "usage.recorded", userSessionId: sessionId, payload: { sessionId, participant: "orchestrator", generation: session.sdkGeneration,
            turnId: usage.turnId, inputTokens: usage.inputTokens, uncachedInputTokens: usage.uncachedInputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens, cacheReadInputTokens: usage.cacheReadInputTokens,
            outputTokens: usage.outputTokens, ...(costUsd === null ? {} : { costUsd }), model: usage.model ?? undefined, effort: usage.effort ?? undefined,
            trigger: turn?.trigger, durationMs: usage.durationMs ?? undefined, apiDurationMs: usage.apiDurationMs ?? undefined, sdkDurationMs: usage.sdkDurationMs ?? undefined,
            status: "completed", stopReason: usage.stopReason ?? undefined } });
        }
        this.#settleTurn(sessionId, lane);
        return;
      }
      case "error": {
        if (turn) {
          turn.outcome.status = event.aborted ? "aborted" : "error";
          turn.outcome.errorMessage = event.message;
        }
        const session = repo.getUserSession(sessionId);
        if (session) {
          const contextTokens = Math.max(session.contextTokens, lane.contextTokens);
          const { costUsd, apiDurationMs } = laneUsageDeltas(lane, event);
          // One patch: turn count, context, and the advanced cumulative
          // baseline (persisted with the provider session it belongs to, so
          // the next process to resume it inherits the watermark).
          repo.patchUserSession(sessionId, { sdkTurnCount: session.sdkTurnCount + 1, contextTokens,
            cumulativeCostUsd: lane.lastCumulative.costUsd, cumulativeApiDurationMs: lane.lastCumulative.apiDurationMs });
          const usage = { id: newId("usage"), userSessionId: sessionId, agentSessionId: null, participant: "orchestrator", profileId: null,
            generation: session.sdkGeneration, turnId: turn?.turnId ?? "unattributed", inputTokens: event.inputTokens ?? 0,
            uncachedInputTokens: event.uncachedInputTokens ?? 0, cacheCreationInputTokens: event.cacheCreationInputTokens ?? 0, cacheReadInputTokens: event.cacheReadInputTokens ?? 0, outputTokens: event.outputTokens ?? 0,
            costUsd, model: event.modelId ?? this.#modelFor(session), effort: this.#deps.config.effort ?? null,
            trigger: turn?.trigger ?? null, durationMs: turn ? Date.now() - turn.startedAt : null, apiDurationMs, sdkDurationMs: event.sdkDurationMs ?? null, status: event.aborted ? "aborted" : "error", stopReason: event.stopReason ?? null, createdAt: nowIso() };
          repo.insertUsage(usage);
          bus.append({ type: "usage.recorded", userSessionId: sessionId, payload: { sessionId, participant: "orchestrator", generation: session.sdkGeneration,
            turnId: usage.turnId, inputTokens: usage.inputTokens, uncachedInputTokens: usage.uncachedInputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens, cacheReadInputTokens: usage.cacheReadInputTokens,
            outputTokens: usage.outputTokens, ...(costUsd === null ? {} : { costUsd }), model: usage.model ?? undefined, effort: usage.effort ?? undefined,
            trigger: turn?.trigger, durationMs: usage.durationMs ?? undefined, apiDurationMs: usage.apiDurationMs ?? undefined, sdkDurationMs: usage.sdkDurationMs ?? undefined,
            status: event.aborted ? "aborted" : "error", stopReason: usage.stopReason ?? undefined } });
          if (session.sdkTurnCount + 1 >= this.#deps.config.contextTurnLimit || contextTokens >= rotationTokenLimit(this.#deps.config.contextTokenLimit, this.#modelFor(session))) lane.recycleAfterTurn = true;
        }
        this.#settleTurn(sessionId, lane);
        return;
      }
      case "turn-idle": {
        // Authoritative turn-over backstop: settles a turn whose result was
        // lost or coalesced; a no-op when the result already settled it.
        this.#settleTurn(sessionId, lane);
        return;
      }
      // Inbound native peer traffic no longer exists: every delivery is
      // console-carried and journalled on the sender side, so arrival needs no
      // backstop. Kept as a no-op guard in case a stray frame appears.
      case "peer-message": {
        return;
      }
      case "task-terminal": {
        // A coordinator (or other background task) died without reporting —
        // silence here would read as "still working".
        this.#notice(
          sessionId,
          `A background task ${event.status}: ${event.summary}`,
        );
        return;
      }
    }
  }

  async #rotateContextIfNeeded(sessionId: string, lane: Lane): Promise<void> {
    const session = this.#deps.repo.getUserSession(sessionId);
    if (!session) return;
    const tokenLimit = rotationTokenLimit(this.#deps.config.contextTokenLimit, this.#modelFor(session));
    const hard = session.sdkTurnCount >= this.#deps.config.contextTurnLimit || session.contextTokens >= tokenLimit;
    const soft = session.sdkTurnCount >= Math.ceil(this.#deps.config.contextTurnLimit * 0.8) || session.contextTokens >= Math.ceil(tokenLimit * 0.75);
    if (!soft) return;
    const threshold = hard ? "hard" as const : "soft" as const;
    if (lane.query) await this.#closeLane(lane, { interrupt: false });
    const started = Date.now();
    let { draft, failure } = await this.#checkpointQuery(session, "");
    // Deterministic quality gate with one feedback retry (mirrors the seat
    // rotation path): soft thresholds defer on a gate-failing pair, hard
    // thresholds accept the better draft and journal it.
    if (draft) {
      const gate = (candidate: HandoffDraft) => evaluateCheckpointDraft({ draft: candidate,
        referenceWarnings: this.#deps.handoffs.referenceWarnings(sessionId, [...candidate.core.state.evidence, ...candidate.core.result.artifacts]),
        taskResolves: candidate.core.taskId == null ? null : this.#deps.repo.hasDurableReference("task", candidate.core.taskId) });
      const initialFailures = gate(draft);
      if (initialFailures.length > 0) {
        this.#deps.bus.append({ type: "handoff.checkpoint.retried", userSessionId: sessionId,
          payload: { participant: "orchestrator", threshold, failures: initialFailures, accepted: "none" } });
        const retry = await this.#checkpointQuery(session,
          `\n\nA previous checkpoint attempt failed these deterministic checks — fix each one:\n- ${initialFailures.join("\n- ")}`);
        const retryFailures = retry.draft ? gate(retry.draft) : null;
        if (retry.draft && retryFailures !== null && retryFailures.length === 0) {
          draft = retry.draft;
          this.#deps.bus.append({ type: "handoff.checkpoint.retried", userSessionId: sessionId,
            payload: { participant: "orchestrator", threshold, failures: [], accepted: "retry" } });
        } else if (!hard) {
          this.#deps.bus.append({ type: "handoff.checkpoint.failed", userSessionId: sessionId,
            payload: { participant: "orchestrator", reason: "checkpoint failed the quality gate", threshold, degraded: false,
              checkFailures: retryFailures ?? initialFailures } });
          return;
        } else {
          const useRetry = retry.draft !== null && retryFailures !== null && retryFailures.length <= initialFailures.length;
          draft = useRetry ? retry.draft : draft;
          this.#deps.bus.append({ type: "handoff.checkpoint.retried", userSessionId: sessionId,
            payload: { participant: "orchestrator", threshold, failures: useRetry ? retryFailures ?? [] : initialFailures, accepted: useRetry ? "retry" : "initial" } });
        }
      }
    }
    let degraded = false;
    if (!draft) {
      if (!hard) {
        this.#deps.bus.append({ type: "handoff.checkpoint.failed", userSessionId: sessionId,
          payload: { participant: "orchestrator", reason: failure ?? "checkpoint produced no valid handoff", threshold, degraded: false } });
        return;
      }
      degraded = true;
      const latest = this.#deps.repo.latestHandoff({ userSessionId: sessionId });
      draft = latest ? { core: { ...latest.core, action: `Recovery checkpoint: ${latest.core.action}`, status: "needs_verification", risk: "high", requestExpandedContext: true }, extension: latest.extension }
        : { core: { schemaVersion: 1, taskId: null, status: "needs_verification", risk: "high", action: "Recover orchestrator context",
          state: { summary: "The checkpoint query failed. Reconstruct from operator messages, task ledger, repository, provider journal, and AgentSession handoffs.", evidence: [] },
          result: { summary: null, artifacts: [] }, uncertainty: [failure ?? "no valid checkpoint output"], nextAction: "Verify authoritative state before acting.", requestExpandedContext: true },
          extension: { kind: "coordination", data: {} } };
      this.#deps.bus.append({ type: "handoff.checkpoint.failed", userSessionId: sessionId,
        payload: { participant: "orchestrator", reason: failure ?? "checkpoint produced no valid handoff", threshold, degraded: true } });
    }
    // Operator decisions ride the checkpoint into the successor generation.
    // Without this a rotation silently forgets what the operator decided, and
    // the next generation is free to contradict them.
    const decisionLines = this.#deps.decisions.lines(sessionId, { max: 12 });
    const prepared = this.#deps.handoffs.prepare({ draft, userSessionId: sessionId, agentSessionId: null,
      sender: "orchestrator", recipient: "orchestrator", profileId: "main", generation: session.sdkGeneration,
      trigger: degraded ? "recovery" : "rotation", parentHandoffId: session.latestHandoffId, checkpoint: true,
      ...(decisionLines.length > 0 ? { extensionDefaults: { operatorDecisions: decisionLines } } : {}) });
    this.#deps.repo.insertCheckpointHandoff(prepared.row);
    this.#deps.handoffs.committed(prepared.record);
    // Rotation retires the provider session, so its cumulative baseline retires
    // with it — the successor genuinely starts from zero.
    this.#deps.repo.patchUserSession(sessionId, { sdkSessionId: null, sdkGeneration: session.sdkGeneration + 1, sdkTurnCount: 0, contextTokens: 0, latestHandoffId: prepared.row.id, cumulativeCostUsd: 0, cumulativeApiDurationMs: 0 });
    this.#deps.bus.append({ type: "user_session.context.rotated", userSessionId: sessionId,
      payload: { sessionId, generation: session.sdkGeneration + 1,
        reason: session.contextTokens >= Math.ceil(tokenLimit * 0.75) ? "token_limit" : "turn_limit", memoryChars: 0,
        handoffId: prepared.row.id, threshold, checkpointBytes: prepared.row.bytes, degraded } });
    this.#deps.bus.append({ type: "user_session.runtime", userSessionId: sessionId,
      payload: { sessionId, detail: `checkpoint ${prepared.row.id} completed in ${Date.now() - started}ms` } });
  }

  /** One tool-free checkpoint query against the lane's current context. */
  async #checkpointQuery(session: { sdkSessionId: string | null; workspaceId: string; model: string | null }, promptSuffix: string): Promise<{ draft: HandoffDraft | null; failure: string | null }> {
    let draft: HandoffDraft | null = null;
    let failure: string | null = null;
    if (!session.sdkSessionId) return { draft, failure };
    const sdk = await this.#deps.sdk();
    const abort = new AbortController();
    // The checkpoint runs on the same model as the lane it is checkpointing.
    const model = this.#modelFor(session);
    const query = sdk.query({ prompt: `Create a lossless rotation checkpoint for the next orchestrator context. Preserve operator intent, decisions, delegated work, verified evidence pointers, uncertainty, and exact next actions. Do not perform work or call tools.${promptSuffix}`, options: {
      cwd: this.#deps.getWorkspaceRoot(session.workspaceId), systemPrompt: { type: "preset", preset: "claude_code", append: "Checkpoint faithfully. Repository files, task ledger, artifacts, and provider journal are authoritative; do not invent corrections." },
      settingSources: [], includePartialMessages: false, permissionMode: "plan", allowedTools: [],
      disallowedTools: ["Agent", "SendMessage", "Task", "Bash", "Edit", "Write", "WebSearch", "WebFetch"],
      outputFormat: { type: "json_schema", schema: HANDOFF_DRAFT_JSON_SCHEMA }, maxTurns: 2,
      sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
        filesystem: { allowManagedReadPathsOnly: true, allowRead: [this.#deps.getWorkspaceRoot(session.workspaceId)], allowWrite: [] } },
      env: sdkEnv(), abortController: abort, persistSession: true,
      ...(this.#deps.sessionStore === undefined ? {} : { sessionStore: this.#deps.sessionStore as SdkOptions["sessionStore"], sessionStoreFlush: "eager" as const }),
      resume: session.sdkSessionId, ...(model ? { model } : {}),
      ...(this.#deps.config.effort ? { effort: this.#deps.config.effort as SdkOptions["effort"] } : {}),
    } });
    try {
      for await (const raw of query) for (const event of mapSdkMessage(raw)) {
        if (event.kind === "result") {
          const parsed = HandoffDraftSchema.safeParse(event.output);
          if (parsed.success) draft = parsed.data;
        } else if (event.kind === "error") failure = event.message;
      }
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    finally { query.close?.(); }
    return { draft, failure };
  }
}
