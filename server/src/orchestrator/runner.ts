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
import type { PostMessageResponse } from "@agentique-console/shared";
import { AsyncQueue } from "../async-queue.ts";
import type { Config } from "../config.ts";
import { Repo, toWireMessage } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { RuntimeBroadcaster } from "../events/runtime.ts";
import { newId, nowIso } from "../ids.ts";
import { badRequest, conflict, notFound } from "../api/errors.ts";
import { mapSdkMessage } from "../sdk/mapping.ts";
import type {
  ConsoleSdk,
  QueryHandle,
  SdkOptions,
  SdkUserMessageLike,
} from "../sdk/types.ts";
import type { InteractionService } from "./interactions.ts";
import { buildOrchestratorOptions } from "./options.ts";
import { buildOrchestratorCanUseTool, type LaneState } from "./permissions.ts";

type Job =
  | { kind: "operator"; text: string }
  | { kind: "answer-revival"; text: string }
  | { kind: "agent-milestone"; text: string; agentSessionId: string };

interface ActiveTurn {
  turnId: string;
  trigger: "operator" | "wake" | "answer";
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

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
  }

  /** Persists an operator message, dismisses pending cards, queues a turn. */
  postOperatorMessage(sessionId: string, text: string): PostMessageResponse {
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

  /** Material AgentSession reports only. Repeated reports coalesce per session. */
  enqueueAgentMilestone(userSessionId: string, agentSessionId: string, category: string, text: string): void {
    const lane = this.#lane(userSessionId);
    const prompt = `[AgentSession ${agentSessionId} ${category}]\n${text.slice(0, 8_192)}\n\nAct only if needed. Do not repeat an unchanged operator update. Use read_agent_session for additional detail only when necessary.`;
    const existing = lane.queue.find((job): job is Extract<Job, { kind: "agent-milestone" }> => job.kind === "agent-milestone" && job.agentSessionId === agentSessionId);
    if (existing) existing.text = prompt;
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
  busy(sessionId: string): boolean {
    // activeTurn covers the steer-minted follow-up turn no drain job owns.
    return (
      this.queuedJobs(sessionId) > 0 ||
      this.#lanes.get(sessionId)?.activeTurn != null
    );
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

    const prompt = job.text;
    if (prompt === "") return;

    const turnId = newId("turn");
    const trigger = job.kind === "operator" ? "operator" : job.kind === "agent-milestone" ? "wake" : "answer";
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

  /** Spawns the persistent query if the lane has none (lazy + post-death). */
  async #ensureLaneQuery(sessionId: string, lane: Lane): Promise<void> {
    if (lane.query) return;
    const { repo, bus, config, interactions } = this.#deps;
    const session = repo.getUserSession(sessionId);
    if (!session) throw notFound(`no user session ${sessionId}`);

    const sdk = await this.#deps.sdk();
    const abort = new AbortController();
    const input = new AsyncQueue<SdkUserMessageLike>();
    const options = buildOrchestratorOptions({
      workspaceRoot: this.#deps.getWorkspaceRoot(session.workspaceId),
      resume: session.sdkSessionId,
      mode: session.mode,
      phase: session.phase,
      model: config.model,
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
      contextMemory: session.memory,
    });

    const query = sdk.query({ prompt: input, options });
    lane.query = query;
    lane.input = input;
    lane.abort = abort;
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
        bus.append({
          type: "user_session.tool.result",
          userSessionId: sessionId,
          payload: {
            sessionId,
            callId: event.callId,
            output: bus.capture(event.output, { userSessionId: sessionId }),
            ...(event.isError ? { isError: true } : {}),
          },
        });
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
          const contextTokens = Math.max(session.contextTokens, event.inputTokens ?? 0);
          repo.patchUserSession(sessionId, { sdkTurnCount: session.sdkTurnCount + 1, contextTokens });
          if (session.sdkTurnCount + 1 >= this.#deps.config.contextTurnLimit || contextTokens >= this.#deps.config.contextTokenLimit) lane.recycleAfterTurn = true;
          const usage = { id: newId("usage"), userSessionId: sessionId, agentSessionId: null, participant: "orchestrator", profileId: null,
            generation: session.sdkGeneration, turnId: turn?.turnId ?? "unattributed", inputTokens: event.inputTokens ?? 0, outputTokens: event.outputTokens ?? 0,
            costUsd: event.costUsd ?? null, createdAt: nowIso() };
          repo.insertUsage(usage);
          bus.append({ type: "usage.recorded", userSessionId: sessionId, payload: { sessionId, participant: "orchestrator", generation: session.sdkGeneration,
            turnId: usage.turnId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }) } });
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
          const contextTokens = Math.max(session.contextTokens, event.inputTokens ?? 0);
          repo.patchUserSession(sessionId, { sdkTurnCount: session.sdkTurnCount + 1, contextTokens });
          const usage = { id: newId("usage"), userSessionId: sessionId, agentSessionId: null, participant: "orchestrator", profileId: null,
            generation: session.sdkGeneration, turnId: turn?.turnId ?? "unattributed", inputTokens: event.inputTokens ?? 0, outputTokens: event.outputTokens ?? 0,
            costUsd: event.costUsd ?? null, createdAt: nowIso() };
          repo.insertUsage(usage);
          bus.append({ type: "usage.recorded", userSessionId: sessionId, payload: { sessionId, participant: "orchestrator", generation: session.sdkGeneration,
            turnId: usage.turnId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }) } });
          if (session.sdkTurnCount + 1 >= this.#deps.config.contextTurnLimit || contextTokens >= this.#deps.config.contextTokenLimit) lane.recycleAfterTurn = true;
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
      case "peer-message": {
        bus.append({ type: "user_session.runtime", userSessionId: sessionId,
          payload: { sessionId, detail: `blocked out-of-band peer message from ${event.from}; managed agents must use the Console mailbox` } });
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
    if (!session || (session.sdkTurnCount < this.#deps.config.contextTurnLimit && session.contextTokens < this.#deps.config.contextTokenLimit)) return;
    if (lane.query) await this.#closeLane(lane, { interrupt: false });
    const head = this.#deps.repo.messagesHeadSeq("user", sessionId);
    const memory = this.#deps.repo.listMessages("user", sessionId, Math.max(0, head - 24))
      .map((row) => `[${row.speakerName}] ${row.text}`).join("\n").slice(-4_000);
    this.#deps.repo.patchUserSession(sessionId, { sdkSessionId: null, sdkGeneration: session.sdkGeneration + 1, sdkTurnCount: 0, contextTokens: 0, memory });
    this.#deps.bus.append({ type: "user_session.context.rotated", userSessionId: sessionId,
      payload: { sessionId, generation: session.sdkGeneration + 1, reason: session.contextTokens >= this.#deps.config.contextTokenLimit ? "token_limit" : "turn_limit", memoryChars: memory.length } });
  }
}
