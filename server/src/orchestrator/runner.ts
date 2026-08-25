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
import { Repo, type UserSessionRow } from "../db/repo.ts";
import { toWireMessage } from "../api/wire.ts";
import type { EventBus } from "../events/bus.ts";
import { RuntimeBroadcaster } from "../events/runtime.ts";
import { newId, nowIso } from "../ids.ts";
import { recoveryAction } from "../lane-runtime/checkpoint.ts";
import { advanceUsageWatermark } from "../lane-runtime/usage.ts";
import { InvalidInputError, ConflictError, NotFoundError } from "../errors.ts";
import { mapSdkMessage } from "../sdk/mapping.ts";
import type {
  ConsoleSdk,
  QueryHandle,
  SdkUserMessageLike,
} from "../sdk/types.ts";
import { decisionPin, type DecisionLedger } from "./decisions.ts";
import type { RequirementService } from "./requirements.ts";
import type { OrchestrationStateService } from "./state.ts";
import type { InteractionService } from "./interactions.ts";
import { MAIN_DEFAULT_EFFORT, buildOrchestratorOptions } from "./options.ts";
import type { EffortLevel } from "../sdk/effort.ts";
import { buildOrchestratorCanUseTool, type LaneState } from "./permissions.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { sdkEnv } from "../sdk/env.ts";
import type { SqliteSessionStore } from "../sdk/session-store.ts";
import type { AgentSessionService } from "../agent-sessions/service.ts";
import type { CapacityService } from "../capacity/service.ts";
import { isCapacityFailure } from "../sdk/failure-classifier.ts";
import { mainPeerName } from "../agent-sessions/names.ts";
import type { TaskService } from "../tasks/service.ts";

type Job =
  | { kind: "operator"; text: string }
  | { kind: "answer-revival"; text: string }
  | { kind: "agent-milestone"; text: string; agentSessionId: string }
  | { kind: "cron"; text: string }
  /** A console-authored wake (post-pause resume note); rendered verbatim. */
  | { kind: "console-note"; text: string };

interface ActiveTurn {
  turnId: string;
  trigger: "operator" | "wake" | "answer" | "deadline";
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
   * Operator messages pushed into the live turn (true steering). The CLI
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
   * overstates occupancy on a tool-heavy turn.
   */
  contextTokens: number;
  /** Last cumulative cost/api-duration seen, for per-turn deltas. */
  lastCumulative: { costUsd: number; apiDurationMs: number };
  /**
   * The operator's whole-system pause cut this lane's turn. On resume main
   * is woken exactly once with a console note about the pause window before
   * the queue drains.
   */
  pausedMidTurn: { turnId: string; atMs: number } | null;
}

export interface OrchestratorDeps {
  repo: Repo;
  bus: EventBus;
  config: Config;
  sdk: () => Promise<ConsoleSdk>;
  interactions: InteractionService;
  getWorkspaceRoot: (workspaceId: string) => string;
  /** The console MCP server bound to one user session. */
  buildMcpServer: (userSessionId: string, sdk: ConsoleSdk) => unknown;
  /** Eager console-owned provider journal. */
  sessionStore: SqliteSessionStore;
  handoffs: HandoffService;
  /**
   * Operator decisions, injected into the lane's system prompt so main never
   * contradicts a call the operator already made — and never has to relay one.
   * Required: an optional dep would let a missing wire typecheck.
   */
  decisions: DecisionLedger;
  /** The living spec + working state, injected into every generation like decisions. */
  /** The governing document (requirement graph, legacy-spec fallback). */
  requirements: RequirementService;
  orchestrationState: OrchestrationStateService;
  /** Lazy — host and runner construct in either order inside `createApp`. */
  host: () => AgentSessionService;
  /** Console task-ledger tools for the lane. */
  tasks: TaskService;
  /** Pause/resume on provider capacity and budget ceilings. */
  capacity: CapacityService;
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
  /** Terminal: set by closeAll; no drain mints another turn after it. */
  #closed = false;
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
    if (!session) throw new NotFoundError(`no user session ${sessionId}`);
    if (session.lifecycle !== "open") {
      throw new ConflictError(`session ${sessionId} is archived`);
    }
    const trimmed = text.trim();
    if (trimmed === "") throw new InvalidInputError("message text is required");

    const { held } = interactions.dismissPendingForChat(sessionId, trimmed);

    const row = repo.appendMessage({
      sessionKind: "user",
      sessionId,
      speaker: { kind: "operator", name: "operator" },
      kind: "message",
      text: trimmed,
    });
    bus.append({
      type: "user_session.message.appended",
      userSessionId: sessionId,
      payload: { userSessionId: sessionId, message: toWireMessage(row) },
    });
    repo.touchUserSession(sessionId);
    // Several DISTINCT decision issues were pending, so the console applied
    // the words to none of them (a wrong guess records the operator's words
    // as the answer to a question they never read). Main reads the actual
    // message next — the annotation names what is open so main can bind the
    // answer to the right issue, once, explicitly. The stored message row
    // stays the operator's clean text.
    const heldNote = held.length === 0 ? "" :
      `\n\n[console] ${held.length} separate decision issues are awaiting the operator; this message was NOT auto-applied to any of them:\n` +
      held.map((entry) => `- ${entry.issueId ?? entry.interactionId}: ${entry.subject} (asked by ${entry.askers.join(", ")})`).join("\n") +
      `\nIf this message answers one of them, call resolve_decision_issue with that id and the operator's answer (their words, not a paraphrase). If it answers none, leave them open.`;
    const prompt = `${trimmed}${heldNote}`;
    // A message landing mid-turn steers the live turn instead of queueing
    // behind it — pushed straight into the stream, exactly like typing into
    // the CLI while it works.
    const lane = this.#lane(sessionId);
    if (lane.activeTurn && lane.input) {
      lane.steeredMidTurn += 1;
      lane.input.push(this.#userMessage(prompt, { kind: "human" }));
    } else {
      this.#enqueue(sessionId, { kind: "operator", text: prompt });
    }
    return { messageId: row.id, seq: row.seq };
  }

  /** A stale interaction was answered after a restart. */
  enqueueRevival(userSessionId: string, text: string): void {
    this.#enqueue(userSessionId, { kind: "answer-revival", text });
  }

  /**
   * Console-owned deadlines (`set_deadline`) fire on absolute time, whether
   * or not the lane is live — one scheduler, no parser, no liveness condition.
   */
  #cronTimer: NodeJS.Timeout | null = null;
  startCronFallback(): void {
    if (this.#cronTimer) return;
    this.#cronTimer = setInterval(() => this.#cronTick(new Date()), 30_000);
    this.#cronTimer.unref?.();
  }
  stopCronFallback(): void {
    if (this.#cronTimer) { clearInterval(this.#cronTimer); this.#cronTimer = null; }
  }
  #cronTick(now: Date): void {
    // A paused run's deadlines hold; firing them would mint turns that die.
    if (this.#deps.capacity.paused) return;
    for (const session of this.#deps.repo.listOpenUserSessions()) {
      for (const deadline of this.#deps.repo.listDueDeadlines(session.id, now.toISOString())) {
        this.#deps.repo.patchCron(deadline.id, { status: "deleted" });
        // createdAt/dueAt/lateness in the note settle "did the timer misfire"
        // forensically — a live run's orchestrator believed its deadlines
        // fired 20–50s after creation and no payload could prove otherwise.
        const latenessMs = now.getTime() - Date.parse(deadline.dueAt ?? deadline.createdAt);
        this.#deps.bus.append({ type: "user_session.runtime.noted", userSessionId: session.id,
          payload: { userSessionId: session.id, detail: `deadline fired: ${deadline.prompt}`,
            cronId: deadline.id, createdAt: deadline.createdAt, dueAt: deadline.dueAt, latenessMs } });
        this.#enqueue(session.id, { kind: "cron", text: `[Deadline you set has arrived — set at ${deadline.createdAt}, due ${deadline.dueAt}]\n${deadline.prompt}` });
      }
    }
  }

  /**
   * Wakes that are NOT a deadline say so. A live run's orchestrator read
   * milestone wakes arriving seconds after set_deadline as its deadlines
   * firing early, concluded the timer was broken, and re-armed a storm of
   * one-shot wakes ($44.67 of self-polling).
   */
  #pendingDeadlinesLine(sessionId: string): string {
    let pending;
    try { pending = this.#deps.repo.listPendingDeadlines(sessionId, new Date().toISOString()); } catch { return ""; }
    if (pending.length === 0) return "";
    const now = Date.now();
    const lines = pending.map((row) =>
      `"${row.prompt.slice(0, 60)}" fires in ~${Math.max(0, Math.round((Date.parse(row.dueAt ?? "") - now) / 1000))}s`);
    return `\n[This wake is NOT one of your deadlines. Still pending: ${lines.join("; ")}.]`;
  }

  /** Material AgentSession reports only. Repeated reports coalesce per session. */
  enqueueAgentMilestone(userSessionId: string, agentSessionId: string, category: string, text: string): void {
    const lane = this.#lane(userSessionId);
    const prompt = `[AgentSession ${agentSessionId} ${category}]\n${text.slice(0, 8_192)}`;
    const existing = lane.queue.find((job): job is Extract<Job, { kind: "agent-milestone" }> => job.kind === "agent-milestone" && job.agentSessionId === agentSessionId);
    // APPEND, never overwrite: two reports arriving before the drain would
    // otherwise lose the first. Losing a milestone is strictly worse than a
    // longer prompt.
    if (existing) existing.text = `${existing.text}\n\n${prompt}`;
    else lane.queue.push({ kind: "agent-milestone", agentSessionId, text: prompt });
    if (!lane.draining) void this.#drain(userSessionId);
  }

  /**
   * A console-authored wake: a fact the Console established (a falsified
   * assumption, a dependency that moved under satisfied work) that main must
   * judge. Coalesces with an identical pending note — repeated sweeps of the
   * same fact earn one wake, not a queue of them.
   */
  postConsoleNote(userSessionId: string, text: string): void {
    const lane = this.#lane(userSessionId);
    if (lane.queue.some((job) => job.kind === "console-note" && job.text === text)) return;
    lane.queue.push({ kind: "console-note", text });
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
    this.#closed = true;
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
   * an operator card does NOT count as working — `AskUserQuestion` awaits its
   * resolution, and waiting on a human is not "in progress".
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
          { kind: "user", userSessionId: sessionId },
          "orchestrator",
          { userSessionId: sessionId },
        ),
        recycleAfterTurn: false,
        steeredMidTurn: 0,
        lastOperatorFacingText: "",
        toolStarts: new Map(),
        contextTokens: 0,
        lastCumulative: { costUsd: 0, apiDurationMs: 0 },
        pausedMidTurn: null,
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
        // Shutdown: no new turn may mint once closeAll has run — a turn
        // started here would settle its journal writes into a database the
        // caller is already free to close.
        if (this.#closed) break;
        // Capacity pause: jobs stay queued, no turn is minted, nothing is
        // coalesced away. `resumeQueued()` re-enters this loop on resume.
        if (this.#deps.capacity.paused) break;
        const job = lane.queue.shift();
        if (!job) break;
        await this.#runTurn(sessionId, lane, job);
      }
    } finally {
      lane.draining = false;
    }
  }

  /**
   * Post-resume kick: every session with queued jobs starts draining again.
   * A lane the pause cut mid-turn first gets ONE console note describing the
   * window, so main re-reads its own last message instead of guessing.
   */
  resumeQueued(): void {
    for (const [sessionId, lane] of this.#lanes) {
      const paused = lane.pausedMidTurn;
      if (paused !== null) {
        lane.pausedMidTurn = null;
        const at = new Date(paused.atMs).toISOString();
        const minutes = Math.max(1, Math.round((Date.now() - paused.atMs) / 60_000));
        lane.queue.unshift({ kind: "console-note",
          text: `[Console: the operator paused the whole system at ${at} and resumed at ${nowIso()} (~${minutes} min). Your turn ${paused.turnId} was interrupted mid-response. Nothing was cancelled: seats that were mid-turn continue their in-progress work with worktrees intact, and ${lane.queue.length} queued wake(s) follow this one. Re-read your last message and continue; check session_activity before assuming any seat's state.]` });
      }
      if (lane.queue.length > 0 && !lane.draining) void this.#drain(sessionId);
    }
  }

  /**
   * The operator's whole-system pause, main side: interrupt every lane's
   * in-flight turn. The turn settles `aborted` through the normal path; the
   * lane and its queue survive, and `resumeQueued` wakes it once about the
   * pause. Returns how many turns were cut.
   */
  interruptAllForPause(_reason: string): number {
    let count = 0;
    for (const [sessionId, lane] of this.#lanes) {
      if (!lane.query || !lane.activeTurn || lane.pausedMidTurn !== null) continue;
      lane.pausedMidTurn = { turnId: lane.activeTurn.turnId, atMs: Date.now() };
      this.#deps.bus.append({ type: "user_session.runtime.noted", userSessionId: sessionId,
        payload: { userSessionId: sessionId, detail: "paused by the operator mid-turn — the turn settles now; main is woken once on resume" } });
      void lane.query.interrupt?.().catch(() => undefined);
      count += 1;
    }
    return count;
  }

  async #runTurn(sessionId: string, lane: Lane, job: Job): Promise<void> {
    const { repo, bus } = this.#deps;
    const session = repo.getUserSession(sessionId);
    if (!session || session.lifecycle !== "open") return;

    // The standing instruction goes on ONCE, at drain, rather than being
    // baked into each milestone — several appended reports would otherwise
    // repeat it verbatim and teach the model to skim.
    if (job.text === "") return;
    // The capacity warning rides EVERY prompt kind: an operator wrap-up
    // request needs it most of all (the straf3 run got 2 minutes' notice).
    const capacityLine = this.#deps.capacity.warningLine();
    const warning = capacityLine === null ? "" : `\n${capacityLine}`;
    const prompt = job.kind === "agent-milestone"
      ? `${job.text}${this.#pendingDeadlinesLine(sessionId)}${warning}\n\nAct only if needed. Do not repeat an unchanged operator update. Use read_agent_session for additional detail only when necessary.`
      : `${job.text}${warning}`;

    const turnId = newId("turn");
    // "deadline" is distinct from "wake" so forensics (and the model itself)
    // can tell a deadline fire from a report wake — a live run misread
    // milestone wakes as early deadline fires and re-armed a wake storm.
    const trigger = job.kind === "operator" ? "operator" : job.kind === "cron" ? "deadline" : job.kind === "agent-milestone" || job.kind === "console-note" ? "wake" : "answer";
    bus.append({
      type: "user_session.turn.started",
      userSessionId: sessionId,
      payload: { userSessionId: sessionId, turnId, trigger },
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
      await this.#ensureLaneQuery(sessionId, lane);
      // A pause pressed while the lane was spawning: nothing has reached the
      // CLI, so the job goes back to the head of the queue unduplicated and
      // the turn settles as never started.
      if (this.#deps.capacity.paused) {
        lane.queue.unshift(job);
        turn.outcome = { status: "aborted", errorMessage: "paused before the turn started" };
        this.#settleTurn(sessionId, lane);
        return;
      }
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
   * The model this session's orchestrator lane runs on. The session's own
   * choice wins; a session that recorded none tracks the configured default.
   * Agents do not read this — they resolve their model from their profile.
   */
  #modelFor(session: Pick<UserSessionRow, "model">): string {
    return session.model ?? this.#deps.config.infra.model;
  }

  /** The operator's install-wide override wins; otherwise main runs at its own default. */
  #effortFor(): EffortLevel {
    return this.#deps.config.infra.effort ?? MAIN_DEFAULT_EFFORT;
  }

  /** Spawns the persistent query if the lane has none (lazy + post-death). */
  async #ensureLaneQuery(sessionId: string, lane: Lane): Promise<void> {
    if (lane.query) return;
    const { repo, bus, config, interactions } = this.#deps;
    const session = repo.getUserSession(sessionId);
    if (!session) throw new NotFoundError(`no user session ${sessionId}`);

    const sdk = await this.#deps.sdk();
    const abort = new AbortController();
    const input = new AsyncQueue<SdkUserMessageLike>();
    const options = buildOrchestratorOptions({
      workspaceRoot: this.#deps.getWorkspaceRoot(session.workspaceId),
      resume: session.sdkSessionId,
      mode: session.mode,
      phase: session.phase,
      model: this.#modelFor(session),
      effort: this.#effortFor(),
      abortController: abort,
      canUseTool: buildOrchestratorCanUseTool({
        userSessionId: sessionId,
        repo,
        bus,
        interactions,
        laneState: lane.state,
        requirements: this.#deps.requirements,
      }),
      mcpServer: this.#deps.buildMcpServer?.(sessionId, sdk),
      sessionStore: this.#deps.sessionStore,
      contextMemory: session.latestHandoffId
        ? JSON.stringify(this.#deps.handoffs.get(session.latestHandoffId), null, 2)
        : session.memory,
      decisionDigest: this.#deps.decisions.digest(sessionId, {
        // Main pins against the whole live graph: a decision stays in the
        // prompt while any requirement it names is still unsatisfied.
        pinned: decisionPin(this.#deps.requirements.derive(sessionId)),
      }),
      specDigest: this.#deps.requirements.digest(sessionId),
      stateDigest: this.#deps.orchestrationState.digest(sessionId),
      autonomy: session.autonomy,
      peerName: mainPeerName(config.policy.peerNamePrefix, sessionId),
      skillsPluginDir: config.infra.skillsPluginDir,
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
    // the provider session and is persisted with it.
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
      // In-process lane death. The resume id survives in the DB, so the next
      // job respawns transparently.
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
    // The abort/close above ends the stream, so the pump is now bounded:
    // await it FULLY. Returning while a settle is still writing lets the
    // caller (shutdownApp → main.ts/tests) close SQLite under an in-flight
    // journal append.
    if (lane.pump) await lane.pump.catch(() => undefined);
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
        userSessionId: sessionId,
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

    // Steered input the CLI may answer as its own next turn needs a turn
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
        payload: { userSessionId: sessionId, turnId: followId, trigger: "operator" },
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
      type: "user_session.message.appended",
      userSessionId: sessionId,
      payload: { userSessionId: sessionId, message: toWireMessage(row) },
    });
  }

  #applyEvent(
    sessionId: string,
    lane: Lane,
    event: ReturnType<typeof mapSdkMessage>[number],
  ): void {
    const { repo, bus } = this.#deps;
    if ("parentCallId" in event && event.parentCallId !== undefined) {
      bus.append({ type: "user_session.runtime.noted", userSessionId: sessionId, payload: { userSessionId: sessionId, detail: `blocked unowned native subagent event (${event.kind})` } });
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
        if (!turn) { bus.append({ type: "user_session.runtime.noted", userSessionId: sessionId, payload: { userSessionId: sessionId, detail: "ignored late stream delta after turn settlement" } }); return; }
        const active = turn;
        lane.runtime.set("responding");
        bus.broadcast({
          type: "stream.delta",
          userSessionId: sessionId,
          payload: {
            scope: { kind: "user", userSessionId: sessionId },
            speaker: "orchestrator",
            turnId: active.turnId,
            text: event.text,
          },
        });
        return;
      }
      case "reasoning-delta": {
        if (!turn) { bus.append({ type: "user_session.runtime.noted", userSessionId: sessionId, payload: { userSessionId: sessionId, detail: "ignored late reasoning delta after turn settlement" } }); return; }
        const active = turn;
        lane.runtime.set("thinking");
        bus.broadcast({
          type: "stream.reasoning",
          userSessionId: sessionId,
          payload: {
            scope: { kind: "user", userSessionId: sessionId },
            speaker: "orchestrator",
            turnId: active.turnId,
            text: event.text,
          },
        });
        return;
      }
      case "notice": {
        lane.runtime.note(event.text);
        bus.append({ type: "user_session.runtime.noted", userSessionId: sessionId, payload: { userSessionId: sessionId, detail: event.text } });
        return;
      }
      case "retry": {
        // Alongside the notice prose, never instead of it: the transcript keeps
        // the human-readable line, counters read this one.
        bus.append({ type: "user_session.retry.recorded", userSessionId: sessionId,
          payload: { userSessionId: sessionId, agent: "orchestrator", kind: event.classification,
            ...(event.attempt === undefined ? {} : { attempt: event.attempt }), retryInMs: event.delayMs, detail: event.detail } });
        return;
      }
      case "limit": {
        // Also journaled as a retry row so `friction.rateLimited` can never
        // again read 0 in a run a limit killed.
        if (event.status !== "allowed") {
          bus.append({ type: "user_session.retry.recorded", userSessionId: sessionId,
            payload: { userSessionId: sessionId, agent: "orchestrator", kind: "rate_limited", retryInMs: 0,
              detail: `limit ${event.status}${event.limitType === undefined ? "" : ` (${event.limitType})`}${event.utilization === undefined ? "" : ` at ${Math.round(event.utilization * 100)}%`}` } });
        }
        this.#deps.capacity.noteLimit(event);
        return;
      }
      case "message": {
        const active = turn;
        lane.state.lastAssistantText = event.text;
        const normalized = event.text.trim().replace(/\s+/g, " ");
        if (active?.trigger === "wake" && normalized !== "" && normalized === lane.lastOperatorFacingText) {
          bus.append({ type: "user_session.runtime.noted", userSessionId: sessionId, payload: { userSessionId: sessionId, detail: "suppressed an exact duplicate orchestrator message" } });
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
          type: "user_session.message.appended",
          userSessionId: sessionId,
          payload: { userSessionId: sessionId, message: toWireMessage(row) },
        });
        return;
      }
      case "tool.call": {
        const active = turn;
        lane.toolStarts.set(event.callId, Date.now());
        lane.runtime.set("tool", event.name);
        bus.append({
          type: "user_session.tool.called",
          userSessionId: sessionId,
          payload: {
            userSessionId: sessionId,
            turnId: active?.turnId ?? "unattributed",
            callId: event.callId,
            name: event.name,
            input: bus.captureSized(event.input, { userSessionId: sessionId }).value,
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
          type: "user_session.tool.completed",
          userSessionId: sessionId,
          payload: {
            userSessionId: sessionId,
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
          const { costUsd, apiDurationMs } = advanceUsageWatermark(lane.lastCumulative, event);
          // One patch: turn count, context, and the advanced cumulative
          // baseline (persisted with the provider session it belongs to, so
          // the next process to resume it inherits the watermark).
          repo.patchUserSession(sessionId, { sdkTurnCount: session.sdkTurnCount + 1, contextTokens,
            cumulativeCostUsd: lane.lastCumulative.costUsd, cumulativeApiDurationMs: lane.lastCumulative.apiDurationMs });
          const usage = { id: newId("usage"), userSessionId: sessionId, agentSessionId: null, participant: "orchestrator", profileId: null,
            generation: session.sdkGeneration, turnId: turn?.turnId ?? "unattributed", inputTokens: event.inputTokens ?? 0,
            uncachedInputTokens: event.uncachedInputTokens ?? 0, cacheCreationInputTokens: event.cacheCreationInputTokens ?? 0, cacheReadInputTokens: event.cacheReadInputTokens ?? 0, outputTokens: event.outputTokens ?? 0,
            costUsd, model: event.modelId ?? this.#modelFor(session), effort: this.#effortFor(),
            trigger: turn?.trigger ?? null, durationMs: turn ? Date.now() - turn.startedAt : null, apiDurationMs, sdkDurationMs: event.sdkDurationMs ?? null, status: "completed", stopReason: event.stopReason ?? null, createdAt: nowIso() };
          repo.insertUsage(usage);
          this.#deps.capacity.checkBudget(sessionId);
          bus.append({ type: "usage.recorded", userSessionId: sessionId, payload: { userSessionId: sessionId, agent: "orchestrator", generation: session.sdkGeneration,
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
        // A capacity-prose failure without a structured limit event still
        // pauses the run instead of letting the next queued job hot-spin.
        if (isCapacityFailure(event.message)) this.#deps.capacity.noteCapacityFailure(event.message);
        const session = repo.getUserSession(sessionId);
        if (session) {
          const contextTokens = Math.max(session.contextTokens, lane.contextTokens);
          const { costUsd, apiDurationMs } = advanceUsageWatermark(lane.lastCumulative, event);
          // One patch: turn count, context, and the advanced cumulative
          // baseline (persisted with the provider session it belongs to, so
          // the next process to resume it inherits the watermark).
          repo.patchUserSession(sessionId, { sdkTurnCount: session.sdkTurnCount + 1, contextTokens,
            cumulativeCostUsd: lane.lastCumulative.costUsd, cumulativeApiDurationMs: lane.lastCumulative.apiDurationMs });
          const usage = { id: newId("usage"), userSessionId: sessionId, agentSessionId: null, participant: "orchestrator", profileId: null,
            generation: session.sdkGeneration, turnId: turn?.turnId ?? "unattributed", inputTokens: event.inputTokens ?? 0,
            uncachedInputTokens: event.uncachedInputTokens ?? 0, cacheCreationInputTokens: event.cacheCreationInputTokens ?? 0, cacheReadInputTokens: event.cacheReadInputTokens ?? 0, outputTokens: event.outputTokens ?? 0,
            costUsd, model: event.modelId ?? this.#modelFor(session), effort: this.#effortFor(),
            trigger: turn?.trigger ?? null, durationMs: turn ? Date.now() - turn.startedAt : null, apiDurationMs, sdkDurationMs: event.sdkDurationMs ?? null, status: event.aborted ? "aborted" : "error", stopReason: event.stopReason ?? null, createdAt: nowIso() };
          repo.insertUsage(usage);
          this.#deps.capacity.checkBudget(sessionId);
          bus.append({ type: "usage.recorded", userSessionId: sessionId, payload: { userSessionId: sessionId, agent: "orchestrator", generation: session.sdkGeneration,
            turnId: usage.turnId, inputTokens: usage.inputTokens, uncachedInputTokens: usage.uncachedInputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens, cacheReadInputTokens: usage.cacheReadInputTokens,
            outputTokens: usage.outputTokens, ...(costUsd === null ? {} : { costUsd }), model: usage.model ?? undefined, effort: usage.effort ?? undefined,
            trigger: turn?.trigger, durationMs: usage.durationMs ?? undefined, apiDurationMs: usage.apiDurationMs ?? undefined, sdkDurationMs: usage.sdkDurationMs ?? undefined,
            status: event.aborted ? "aborted" : "error", stopReason: usage.stopReason ?? undefined } });
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

}
