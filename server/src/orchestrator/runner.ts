/**
 * OrchestratorRunner: one SDK conversation per UserSession, one query() per
 * turn, jobs drained strictly serially per session. Wake jobs coalesce while
 * a turn is in flight; operator jobs queue in order. Interrupt aborts the
 * in-flight query (abort + interrupt + close, v1's discipline).
 */
import type { PostMessageResponse } from "@agentique-console/shared";
import type { Config } from "../config.ts";
import { Repo, toWireMessage } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { RuntimeBroadcaster } from "../events/runtime.ts";
import { newId } from "../ids.ts";
import { badRequest, conflict, notFound } from "../api/errors.ts";
import { capJson, mapSdkMessage } from "../sdk/mapping.ts";
import type { ConsoleSdk, QueryHandle, SdkOptions } from "../sdk/types.ts";
import type { SqliteSessionStore } from "../sdk/session-store.ts";
import type { InteractionService } from "./interactions.ts";
import { buildOrchestratorOptions } from "./options.ts";
import { buildOrchestratorCanUseTool, type TurnState } from "./permissions.ts";
import { composeWakePrompt, type WakeDigest } from "./prompt.ts";

type Job =
  | { kind: "operator"; text: string }
  | { kind: "wake"; agentSessionIds: Set<string> }
  | { kind: "answer-revival"; text: string };

interface Lane {
  queue: Job[];
  draining: boolean;
  abort: AbortController | null;
  query: QueryHandle | null;
}

export interface OrchestratorDeps {
  repo: Repo;
  bus: EventBus;
  config: Config;
  sdk: () => Promise<ConsoleSdk>;
  sessionStore: SqliteSessionStore;
  interactions: InteractionService;
  getWorkspaceRoot: (workspaceId: string) => string;
  /** M7: task-mirror hooks per turn. */
  buildHooks?: (attribution: {
    workspaceId: string;
    userSessionId: string;
  }) => SdkOptions["hooks"];
  /** M6: the console MCP server bound to one user session. */
  buildMcpServer?: (userSessionId: string, sdk: ConsoleSdk) => unknown;
  /** M6: digest composer for wake turns (advances orchestrator watermarks). */
  buildWakeDigests?: (
    userSessionId: string,
    agentSessionIds: ReadonlySet<string>,
  ) => WakeDigest[];
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
    this.#enqueue(sessionId, { kind: "operator", text: trimmed });
    return { messageId: row.id, seq: row.seq };
  }

  /** An AgentSession settled with results owed — wake the orchestrator. */
  enqueueWake(userSessionId: string, agentSessionId: string): void {
    const lane = this.#lane(userSessionId);
    const pending = lane.queue.find(
      (job): job is Extract<Job, { kind: "wake" }> => job.kind === "wake",
    );
    if (pending) {
      pending.agentSessionIds.add(agentSessionId);
      return;
    }
    this.#enqueue(userSessionId, {
      kind: "wake",
      agentSessionIds: new Set([agentSessionId]),
    });
  }

  /** M8: a stale interaction was answered after a restart. */
  enqueueRevival(userSessionId: string, text: string): void {
    this.#enqueue(userSessionId, { kind: "answer-revival", text });
  }

  interrupt(sessionId: string): void {
    const lane = this.#lanes.get(sessionId);
    if (!lane) return;
    lane.abort?.abort();
    void lane.query?.interrupt?.().catch(() => undefined);
  }

  queuedJobs(sessionId: string): number {
    const lane = this.#lanes.get(sessionId);
    if (!lane) return 0;
    return lane.queue.length + (lane.draining ? 1 : 0);
  }

  /** True while a turn is in flight or queued. */
  busy(sessionId: string): boolean {
    return this.queuedJobs(sessionId) > 0;
  }

  #lane(sessionId: string): Lane {
    let lane = this.#lanes.get(sessionId);
    if (!lane) {
      lane = { queue: [], draining: false, abort: null, query: null };
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
        await this.#turn(sessionId, lane, job);
      }
    } finally {
      lane.draining = false;
    }
  }

  async #turn(sessionId: string, lane: Lane, job: Job): Promise<void> {
    const { repo, bus, config, interactions, sessionStore } = this.#deps;
    const session = repo.getUserSession(sessionId);
    if (!session || session.status !== "open") return;

    const prompt =
      job.kind === "operator"
        ? job.text
        : job.kind === "wake"
          ? composeWakePrompt(
              this.#deps.buildWakeDigests?.(sessionId, job.agentSessionIds) ??
                [],
            )
          : job.text;
    // A wake whose digests were already consumed (read_agent_session raced
    // it) has nothing to say — skip the turn entirely.
    if (prompt === "") return;

    const turnId = newId("turn");
    const trigger =
      job.kind === "operator"
        ? "operator"
        : job.kind === "wake"
          ? "wake"
          : "answer";
    bus.append({
      type: "user_session.turn.started",
      userSessionId: sessionId,
      payload: { sessionId, turnId, trigger },
    });

    const abort = new AbortController();
    lane.abort = abort;
    const runtime = new RuntimeBroadcaster(
      bus,
      { kind: "user", sessionId },
      "orchestrator",
      { userSessionId: sessionId },
    );
    const turnState: TurnState = { lastAssistantText: "" };
    const outcome = { status: "completed" as "completed" | "error" | "aborted", errorMessage: undefined as string | undefined };

    try {
      const sdk = await this.#deps.sdk();
      const options = buildOrchestratorOptions({
        workspaceRoot: this.#deps.getWorkspaceRoot(session.workspaceId),
        resume: session.sdkSessionId,
        mode: session.mode,
        phase: session.phase,
        model: config.model,
        abortController: abort,
        canUseTool: buildOrchestratorCanUseTool({
          userSessionId: sessionId,
          repo,
          bus,
          interactions,
          turnState,
        }),
        hooks: this.#deps.buildHooks?.({
          workspaceId: session.workspaceId,
          userSessionId: sessionId,
        }),
        sessionStore: sessionStore,
        mcpServer: this.#deps.buildMcpServer?.(sessionId, sdk),
      });

      runtime.set("thinking");
      const query = sdk.query({ prompt, options });
      lane.query = query;
      try {
        for await (const sdkMessage of query) {
          for (const event of mapSdkMessage(sdkMessage)) {
            this.#applyEvent(sessionId, turnId, event, turnState, runtime, outcome);
          }
        }
      } finally {
        lane.query = null;
        query.close?.();
      }
    } catch (error) {
      outcome.status = abort.signal.aborted ? "aborted" : "error";
      outcome.errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`orchestrator turn failed (${sessionId}):`, error);
    } finally {
      lane.abort = null;
      runtime.idle();
      repo.touchUserSession(sessionId);
      bus.append({
        type: "user_session.turn.settled",
        userSessionId: sessionId,
        payload: {
          sessionId,
          turnId,
          status: outcome.status,
          ...(outcome.errorMessage === undefined
            ? {}
            : { errorMessage: outcome.errorMessage }),
          queuedJobs: lane.queue.length,
        },
      });
    }
  }

  #applyEvent(
    sessionId: string,
    turnId: string,
    event: ReturnType<typeof mapSdkMessage>[number],
    turnState: TurnState,
    runtime: RuntimeBroadcaster,
    outcome: { status: "completed" | "error" | "aborted"; errorMessage: string | undefined },
  ): void {
    const { repo, bus } = this.#deps;
    switch (event.kind) {
      case "resume": {
        const session = repo.getUserSession(sessionId);
        if (session && session.sdkSessionId !== event.resumeId) {
          repo.patchUserSession(sessionId, { sdkSessionId: event.resumeId });
        }
        return;
      }
      case "delta": {
        runtime.set("responding");
        bus.broadcast({
          type: "stream.delta",
          userSessionId: sessionId,
          payload: {
            scope: { kind: "user", sessionId },
            speaker: "orchestrator",
            turnId,
            text: event.text,
          },
        });
        return;
      }
      case "reasoning-delta": {
        runtime.set("thinking");
        bus.broadcast({
          type: "stream.reasoning",
          userSessionId: sessionId,
          payload: {
            scope: { kind: "user", sessionId },
            speaker: "orchestrator",
            turnId,
            text: event.text,
          },
        });
        return;
      }
      case "message": {
        turnState.lastAssistantText = event.text;
        const row = repo.appendMessage({
          sessionKind: "user",
          sessionId,
          speaker: { kind: "orchestrator", name: "orchestrator" },
          kind: "message",
          text: event.text,
          turnId,
        });
        bus.append({
          type: "user_session.message",
          userSessionId: sessionId,
          payload: { sessionId, message: toWireMessage(row) },
        });
        return;
      }
      case "tool.call": {
        runtime.set("tool", event.name);
        bus.append({
          type: "user_session.tool.call",
          userSessionId: sessionId,
          payload: {
            sessionId,
            turnId,
            callId: event.callId,
            name: event.name,
            input: capJson(event.input),
          },
        });
        return;
      }
      case "tool.result": {
        runtime.set("thinking");
        bus.append({
          type: "user_session.tool.result",
          userSessionId: sessionId,
          payload: {
            sessionId,
            callId: event.callId,
            output: capJson(event.output),
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
        return;
      }
      case "error": {
        outcome.status = event.aborted ? "aborted" : "error";
        outcome.errorMessage = event.message;
        return;
      }
    }
  }
}
