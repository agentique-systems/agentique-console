/**
 * AgentSessionHost: the drain loop that runs Orchestrator ↔ specialist
 * sessions (an aggressive simplification of the env layer's SessionHost).
 *
 * Per session, serialized by a promise chain: route ONE message past
 * lastRoutedSeq, dispatch every seat owed a turn (pendingTurnSeq wake
 * markers), repeat; when nothing routes and nothing is in flight, the session
 * is quiet — if results are owed to the orchestrator and its watermark is
 * behind the transcript tail, the host emits flow.result and wakes the
 * orchestrator runner. Wake conditions are derived entirely from persisted
 * rows, so a boot pass can re-evaluate them after a crash.
 */
import type { Speaker } from "@agentique-console/shared";
import { badRequest, conflict, notFound } from "../api/errors.ts";
import type { Config } from "../config.ts";
import {
  Repo,
  toWireAgentSession,
  toWireMessage,
  type AgentSessionRow,
  type MessageRow,
  type ParticipantRow,
} from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { RuntimeBroadcaster } from "../events/runtime.ts";
import { newId, nowIso } from "../ids.ts";
import { capJson, mapSdkMessage } from "../sdk/mapping.ts";
import type { ConsoleSdk, QueryHandle, SdkOptions } from "../sdk/types.ts";
import type { SqliteSessionStore } from "../sdk/session-store.ts";
import { formatMessageLine, composeSpecialistPrompt } from "./prompt.ts";
import { resolveInstructions } from "./presets.ts";
import { ORCHESTRATOR_SEAT, route } from "./routing.ts";
import {
  buildSpecialistOptions,
  parseTurnOutput,
  type TurnOutput,
} from "./turn.ts";
import type { WakeDigest } from "../orchestrator/prompt.ts";

const SEAT_NAME_RE = /^[A-Za-z0-9_.:-]+$/;
const RESERVED_NAMES = new Set(["orchestrator", "operator", "system"]);

interface TurnInFlight {
  abort: AbortController;
  query: QueryHandle | null;
}

interface Lane {
  chain: Promise<void>;
  turns: Map<string, TurnInFlight>;
  lastStatus: "working" | "idle" | null;
}

export interface CreateAgentSessionInput {
  userSessionId: string;
  title: string;
  mode: "execute" | "plan_execute";
  agents: {
    name: string;
    preset?: string;
    instructions?: string;
    model?: string;
  }[];
  briefing?: string;
}

export interface AgentSessionHostDeps {
  repo: Repo;
  bus: EventBus;
  config: Config;
  sdk: () => Promise<ConsoleSdk>;
  sessionStore: SqliteSessionStore;
  getWorkspaceRoot: (workspaceId: string) => string;
  /** Wakes the orchestrator runner for a settled session with unseen results. */
  wake: (userSessionId: string, agentSessionId: string) => void;
  /** M7: task-mirror hooks per specialist turn. */
  buildHooks?: (attribution: {
    workspaceId: string;
    userSessionId: string;
    agentSessionId: string;
    participant: string;
  }) => SdkOptions["hooks"];
  /** M8: per-seat plan capture for planning-phase turns. */
  buildSeatCanUseTool?: (seat: {
    agentSessionId: string;
    participant: string;
    lastText: () => string;
  }) => SdkOptions["canUseTool"];
  /** M7: compact task lines for wake digests. */
  taskLines?: (agentSessionId: string) => string[];
}

export class AgentSessionHost {
  readonly #deps: AgentSessionHostDeps;
  readonly #lanes = new Map<string, Lane>();
  readonly #starved = new Set<string>();
  #globalTurns = 0;

  constructor(deps: AgentSessionHostDeps) {
    this.#deps = deps;
  }

  // --- Public surface -------------------------------------------------------

  createSession(input: CreateAgentSessionInput): {
    agentSessionId: string;
    participants: string[];
  } {
    const { repo, bus } = this.#deps;
    const userSession = repo.getUserSession(input.userSessionId);
    if (!userSession) throw notFound(`no user session ${input.userSessionId}`);
    if (input.agents.length < 1 || input.agents.length > 4) {
      throw badRequest("an agent session seats 1 to 4 specialists");
    }
    const names = new Set<string>();
    for (const agent of input.agents) {
      if (!SEAT_NAME_RE.test(agent.name)) {
        throw badRequest(`invalid seat name "${agent.name}"`);
      }
      if (RESERVED_NAMES.has(agent.name.toLowerCase())) {
        throw badRequest(`"${agent.name}" is a reserved name`);
      }
      if (names.has(agent.name)) {
        throw badRequest(`duplicate seat name "${agent.name}"`);
      }
      names.add(agent.name);
    }
    const title = input.title.trim();
    if (title === "") throw badRequest("a session title is required");

    const now = nowIso();
    const row: AgentSessionRow = {
      id: newId("as"),
      userSessionId: input.userSessionId,
      title,
      mode: input.mode,
      phase: input.mode === "plan_execute" ? "planning" : "executing",
      status: "open",
      hopLimit: this.#deps.config.hopLimit,
      hopCount: 0,
      lastRoutedSeq: 0,
      owedToOrchestrator: false,
      createdAt: now,
      updatedAt: now,
    };
    repo.insertAgentSession(row);
    repo.insertParticipant({
      agentSessionId: row.id,
      name: ORCHESTRATOR_SEAT,
      role: "orchestrator",
      preset: null,
      instructions: "",
      model: null,
      sdkSessionId: null,
      lastSeenSeq: 0,
      pendingTurnSeq: 0,
      ord: 0,
      createdAt: now,
    });
    const specialists: string[] = [];
    input.agents.forEach((agent, index) => {
      const instructions = resolveInstructions(agent.preset, agent.instructions);
      repo.insertParticipant({
        agentSessionId: row.id,
        name: agent.name,
        role: "agent",
        preset: agent.preset ?? null,
        instructions,
        model: agent.model ?? null,
        sdkSessionId: null,
        lastSeenSeq: 0,
        pendingTurnSeq: 0,
        ord: index + 1,
        createdAt: now,
      });
      specialists.push(agent.name);
    });

    bus.append({
      type: "agent_session.created",
      userSessionId: input.userSessionId,
      agentSessionId: row.id,
      payload: {
        session: toWireAgentSession(row, specialists, false),
        participants: specialists,
      },
    });
    bus.append({
      type: "flow.delegation",
      userSessionId: input.userSessionId,
      agentSessionId: row.id,
      payload: {
        userSessionId: input.userSessionId,
        agentSessionId: row.id,
        kind: "created",
        preview: title,
      },
    });

    if (input.briefing !== undefined && input.briefing.trim() !== "") {
      this.post({
        agentSessionId: row.id,
        speaker: { kind: "orchestrator", name: ORCHESTRATOR_SEAT },
        text: input.briefing.trim(),
      });
    }
    return { agentSessionId: row.id, participants: specialists };
  }

  /** Appends a message and schedules the drain. Orchestrator speech resets hops. */
  post(input: {
    agentSessionId: string;
    speaker: Speaker;
    to?: string;
    text: string;
    kind?: "message" | "notice" | "plan";
  }): MessageRow {
    const { repo, bus } = this.#deps;
    const session = repo.getAgentSession(input.agentSessionId);
    if (!session) throw notFound(`no agent session ${input.agentSessionId}`);
    if (session.status !== "open") {
      throw conflict(`agent session ${input.agentSessionId} is archived`);
    }
    const row = repo.appendMessage({
      sessionKind: "agent",
      sessionId: session.id,
      speaker: input.speaker,
      ...(input.to === undefined ? {} : { to: input.to }),
      kind: input.kind ?? "message",
      text: input.text,
    });
    bus.append({
      type: "agent_session.message",
      userSessionId: session.userSessionId,
      agentSessionId: session.id,
      payload: { agentSessionId: session.id, message: toWireMessage(row) },
    });
    if (input.speaker.kind === "orchestrator") {
      repo.patchAgentSession(session.id, { hopCount: 0 });
    }
    this.#schedule(session.id);
    return row;
  }

  /** Read for the orchestrator: advances its watermark (cancels stale wakes). */
  readSession(input: {
    agentSessionId: string;
    afterSeq?: number;
    limit?: number;
  }): {
    status: "working" | "idle" | "archived";
    phase: "planning" | "executing";
    participants: { name: string; preset: string | null; model: string | null }[];
    messages: ReturnType<typeof toWireMessage>[];
  } {
    const { repo } = this.#deps;
    const session = repo.getAgentSession(input.agentSessionId);
    if (!session) throw notFound(`no agent session ${input.agentSessionId}`);
    const orchestrator = repo.getParticipant(session.id, ORCHESTRATOR_SEAT);
    const after = input.afterSeq ?? orchestrator?.lastSeenSeq ?? 0;
    let rows = repo.listMessages("agent", session.id, after);
    if (input.limit !== undefined && rows.length > input.limit) {
      rows = rows.slice(-input.limit);
    }
    const head = repo.messagesHeadSeq("agent", session.id);
    if (orchestrator && orchestrator.lastSeenSeq < head) {
      repo.patchParticipant(session.id, ORCHESTRATOR_SEAT, {
        lastSeenSeq: head,
      });
    }
    return {
      status: this.#statusOf(session),
      phase: session.phase,
      participants: repo
        .listParticipants(session.id)
        .filter((p) => p.role === "agent")
        .map((p) => ({ name: p.name, preset: p.preset, model: p.model })),
      messages: rows.map(toWireMessage),
    };
  }

  listForUserSession(userSessionId: string): {
    id: string;
    title: string;
    mode: "execute" | "plan_execute";
    phase: "planning" | "executing";
    status: "working" | "idle" | "archived";
    participants: string[];
    unseenCount: number;
    updatedAt: string;
  }[] {
    const { repo } = this.#deps;
    return repo.listAgentSessions(userSessionId).map((row) => {
      const orchestrator = repo.getParticipant(row.id, ORCHESTRATOR_SEAT);
      const head = repo.messagesHeadSeq("agent", row.id);
      return {
        id: row.id,
        title: row.title,
        mode: row.mode,
        phase: row.phase,
        status: this.#statusOf(row),
        participants: this.#specialists(row.id).map((p) => p.name),
        unseenCount: Math.max(0, head - (orchestrator?.lastSeenSeq ?? 0)),
        updatedAt: row.updatedAt,
      };
    });
  }

  wireSession(row: AgentSessionRow) {
    return toWireAgentSession(
      row,
      this.#specialists(row.id).map((p) => p.name),
      this.#statusOf(row) === "working",
    );
  }

  interrupt(agentSessionId: string): void {
    const lane = this.#lanes.get(agentSessionId);
    if (!lane) return;
    for (const turn of lane.turns.values()) {
      turn.abort.abort();
      void turn.query?.interrupt?.().catch(() => undefined);
    }
  }

  /** Wake digests for the orchestrator; advances its watermark per session. */
  buildWakeDigests(
    userSessionId: string,
    agentSessionIds: ReadonlySet<string>,
  ): WakeDigest[] {
    const { repo } = this.#deps;
    const digests: WakeDigest[] = [];
    for (const id of agentSessionIds) {
      const session = repo.getAgentSession(id);
      if (!session || session.userSessionId !== userSessionId) continue;
      const orchestrator = repo.getParticipant(id, ORCHESTRATOR_SEAT);
      const rows = repo.listMessages("agent", id, orchestrator?.lastSeenSeq ?? 0);
      if (rows.length === 0) continue;
      const head = repo.messagesHeadSeq("agent", id);
      repo.patchParticipant(id, ORCHESTRATOR_SEAT, { lastSeenSeq: head });
      digests.push({
        agentSessionId: id,
        title: session.title,
        lines: rows.map(formatMessageLine),
        taskLines: this.#deps.taskLines?.(id) ?? [],
      });
    }
    return digests;
  }

  /** Boot pass: re-evaluate every open session's drain from persisted rows. */
  boot(): void {
    for (const row of this.#deps.repo.listOpenAgentSessions()) {
      this.#schedule(row.id);
    }
  }

  // --- Drain loop -----------------------------------------------------------

  #lane(id: string): Lane {
    let lane = this.#lanes.get(id);
    if (!lane) {
      lane = { chain: Promise.resolve(), turns: new Map(), lastStatus: null };
      this.#lanes.set(id, lane);
    }
    return lane;
  }

  #schedule(id: string): void {
    const lane = this.#lane(id);
    lane.chain = lane.chain
      .then(() => this.#drain(id))
      .catch((error) => {
        console.error(`agent session drain failed (${id}):`, error);
      });
  }

  async #drain(id: string): Promise<void> {
    const { repo, bus, config } = this.#deps;
    for (let guard = 0; guard < 200; guard += 1) {
      const session = repo.getAgentSession(id);
      if (!session || session.status !== "open") return;
      const lane = this.#lane(id);
      const specialists = this.#specialists(id);
      let progressed = false;

      // 1. Route ONE message past the watermark (notices are never routed).
      const unrouted = repo
        .listMessages("agent", id, session.lastRoutedSeq)
        .filter((m) => m.kind !== "notice");
      const message = unrouted[0];
      if (message) {
        let decisions = route(
          {
            speaker: { kind: message.speakerKind, name: message.speakerName },
            ...(message.toName === null ? {} : { to: message.toName }),
            text: message.text,
          },
          specialists.map((p) => p.name),
        );
        let hopCount = session.hopCount;
        const seatsDecided = decisions.filter(
          (d) => d.recipient !== ORCHESTRATOR_SEAT,
        );
        if (message.speakerKind === "agent" && seatsDecided.length > 0) {
          if (hopCount + 1 > session.hopLimit) {
            this.#notice(
              session,
              `hop limit (${session.hopLimit}) reached — returning the floor to the orchestrator`,
            );
            decisions = [{ recipient: ORCHESTRATOR_SEAT, reason: "default" }];
          } else {
            hopCount += 1;
          }
        }
        if (decisions.length === 0) {
          this.#notice(
            session,
            "unaddressed message — address a seat with @name or `to`",
          );
        }
        for (const decision of decisions) {
          if (decision.recipient === ORCHESTRATOR_SEAT) {
            repo.patchAgentSession(id, { owedToOrchestrator: true });
          } else {
            const seat = repo.getParticipant(id, decision.recipient);
            if (seat) {
              repo.patchParticipant(id, decision.recipient, {
                pendingTurnSeq: Math.max(seat.pendingTurnSeq, message.seq),
              });
            }
          }
        }
        repo.patchAgentSession(id, { lastRoutedSeq: message.seq, hopCount });
        bus.append({
          type: "agent_session.routed",
          userSessionId: session.userSessionId,
          agentSessionId: id,
          payload: {
            agentSessionId: id,
            messageSeq: message.seq,
            decisions,
            hopCount,
          },
        });
        progressed = true;
      }

      // 2. Dispatch every seat owed a turn, under the caps.
      for (const seat of this.#specialists(id)) {
        if (seat.pendingTurnSeq === 0 || lane.turns.has(seat.name)) continue;
        if (lane.turns.size >= config.perSessionTurnCap) break;
        if (this.#globalTurns >= config.globalTurnCap) {
          this.#starved.add(id);
          break;
        }
        this.#startTurn(id, seat.name);
        progressed = true;
      }

      if (progressed) continue;

      // 3. Quiet check.
      const anyPending = this.#specialists(id).some(
        (p) => p.pendingTurnSeq > 0,
      );
      if (!message && lane.turns.size === 0 && !anyPending) {
        this.#setStatus(id, "idle");
        const fresh = repo.getAgentSession(id);
        if (fresh?.owedToOrchestrator) {
          repo.patchAgentSession(id, { owedToOrchestrator: false });
          const orchestrator = repo.getParticipant(id, ORCHESTRATOR_SEAT);
          const head = repo.messagesHeadSeq("agent", id);
          if (orchestrator && orchestrator.lastSeenSeq < head) {
            const tail = repo.listMessages("agent", id, head - 1)[0];
            bus.append({
              type: "flow.result",
              userSessionId: fresh.userSessionId,
              agentSessionId: id,
              payload: {
                userSessionId: fresh.userSessionId,
                agentSessionId: id,
                digestPreview: (tail?.text ?? "").slice(0, 140),
              },
            });
            this.#deps.wake(fresh.userSessionId, id);
          }
        }
      } else if (lane.turns.size > 0) {
        this.#setStatus(id, "working");
      }
      return;
    }
    console.error(`agent session drain guard tripped (${id})`);
  }

  #startTurn(id: string, seatName: string): void {
    const { repo, bus } = this.#deps;
    const lane = this.#lane(id);
    const session = repo.getAgentSession(id);
    const seat = repo.getParticipant(id, seatName);
    if (!session || !seat) return;

    // Stamp the watermark and clear the wake marker in one patch BEFORE any
    // await — a message landing mid-turn re-arms pendingTurnSeq for the next.
    const promptRows = repo
      .listMessages("agent", id, seat.lastSeenSeq)
      .filter((m) => m.speakerName !== seatName);
    const head = repo.messagesHeadSeq("agent", id);
    repo.patchParticipant(id, seatName, {
      lastSeenSeq: head,
      pendingTurnSeq: 0,
    });

    const abort = new AbortController();
    const flight: TurnInFlight = { abort, query: null };
    lane.turns.set(seatName, flight);
    this.#globalTurns += 1;
    const turnId = newId("turn");
    bus.append({
      type: "agent_session.turn.started",
      userSessionId: session.userSessionId,
      agentSessionId: id,
      payload: { agentSessionId: id, participant: seatName, turnId },
    });
    this.#setStatus(id, "working");

    void this.#runTurn(session, seat, promptRows, turnId, flight).finally(() => {
      lane.turns.delete(seatName);
      this.#globalTurns -= 1;
      this.#schedule(id);
      for (const starvedId of [...this.#starved]) {
        this.#starved.delete(starvedId);
        if (starvedId !== id) this.#schedule(starvedId);
      }
    });
  }

  async #runTurn(
    session: AgentSessionRow,
    seat: ParticipantRow,
    promptRows: MessageRow[],
    turnId: string,
    flight: TurnInFlight,
  ): Promise<void> {
    const { repo, bus, config } = this.#deps;
    const id = session.id;
    const runtime = new RuntimeBroadcaster(
      bus,
      { kind: "agent", sessionId: id },
      seat.name,
      { userSessionId: session.userSessionId, agentSessionId: id },
    );
    const outcome = {
      status: "completed" as "completed" | "error" | "aborted",
      errorMessage: undefined as string | undefined,
    };
    let turnOutput: TurnOutput | null = null;
    let lastText = "";

    try {
      const sdk = await this.#deps.sdk();
      const userSession = repo.getUserSession(session.userSessionId);
      if (!userSession) throw new Error("user session vanished");
      const lane = this.#lane(id);
      const prompt = composeSpecialistPrompt({
        seatName: seat.name,
        sessionTitle: session.title,
        seats: repo.listParticipants(id).map((p) => ({
          name: p.name,
          role: p.role,
          description:
            p.role === "orchestrator"
              ? "runs this session on behalf of the operator"
              : (p.preset ?? p.instructions.split("\n")[0] ?? "").slice(0, 80),
        })),
        messages: promptRows,
        hopRemaining: Math.max(0, session.hopLimit - session.hopCount),
        speaking: [...lane.turns.keys()].filter((name) => name !== seat.name),
      });
      const options = buildSpecialistOptions({
        workspaceRoot: this.#deps.getWorkspaceRoot(userSession.workspaceId),
        instructions: seat.instructions,
        resume: seat.sdkSessionId,
        phase: session.phase,
        model: seat.model ?? config.model,
        effort: config.effort,
        abortController: flight.abort,
        sessionStore: this.#deps.sessionStore,
        hooks: this.#deps.buildHooks?.({
          workspaceId: userSession.workspaceId,
          userSessionId: session.userSessionId,
          agentSessionId: id,
          participant: seat.name,
        }),
        canUseTool: this.#deps.buildSeatCanUseTool?.({
          agentSessionId: id,
          participant: seat.name,
          lastText: () => lastText,
        }),
      });

      runtime.set("thinking");
      const query = sdk.query({ prompt, options });
      flight.query = query;
      try {
        for await (const sdkMessage of query) {
          for (const event of mapSdkMessage(sdkMessage)) {
            switch (event.kind) {
              case "resume":
                if (seat.sdkSessionId !== event.resumeId) {
                  repo.patchParticipant(id, seat.name, {
                    sdkSessionId: event.resumeId,
                  });
                }
                break;
              case "delta":
                runtime.set("responding");
                bus.broadcast({
                  type: "stream.delta",
                  userSessionId: session.userSessionId,
                  agentSessionId: id,
                  payload: {
                    scope: { kind: "agent", sessionId: id },
                    speaker: seat.name,
                    turnId,
                    text: event.text,
                  },
                });
                break;
              case "reasoning-delta":
                runtime.set("thinking");
                bus.broadcast({
                  type: "stream.reasoning",
                  userSessionId: session.userSessionId,
                  agentSessionId: id,
                  payload: {
                    scope: { kind: "agent", sessionId: id },
                    speaker: seat.name,
                    turnId,
                    text: event.text,
                  },
                });
                break;
              case "notice":
                runtime.note(event.text);
                break;
              case "message":
                // Narration streams via the overlay; only the structured
                // closing message is persisted (one chat lane).
                lastText = event.text;
                break;
              case "tool.call":
                runtime.set("tool", event.name);
                bus.append({
                  type: "agent_session.tool.call",
                  userSessionId: session.userSessionId,
                  agentSessionId: id,
                  payload: {
                    sessionId: id,
                    participant: seat.name,
                    turnId,
                    callId: event.callId,
                    name: event.name,
                    input: capJson(event.input),
                  },
                });
                break;
              case "tool.result":
                runtime.set("thinking");
                bus.append({
                  type: "agent_session.tool.result",
                  userSessionId: session.userSessionId,
                  agentSessionId: id,
                  payload: {
                    sessionId: id,
                    participant: seat.name,
                    callId: event.callId,
                    output: capJson(event.output),
                    ...(event.isError ? { isError: true } : {}),
                  },
                });
                break;
              case "result":
                turnOutput = parseTurnOutput(event.output);
                if (
                  event.resumeId !== undefined &&
                  event.resumeId !== seat.sdkSessionId
                ) {
                  repo.patchParticipant(id, seat.name, {
                    sdkSessionId: event.resumeId,
                  });
                }
                break;
              case "error":
                outcome.status = event.aborted ? "aborted" : "error";
                outcome.errorMessage = event.message;
                break;
            }
          }
        }
      } finally {
        flight.query = null;
        query.close?.();
      }
    } catch (error) {
      outcome.status = flight.abort.signal.aborted ? "aborted" : "error";
      outcome.errorMessage =
        error instanceof Error ? error.message : String(error);
    } finally {
      runtime.idle();
      bus.append({
        type: "agent_session.turn.settled",
        userSessionId: session.userSessionId,
        agentSessionId: id,
        payload: {
          agentSessionId: id,
          participant: seat.name,
          turnId,
          status: outcome.status,
          ...(outcome.errorMessage === undefined
            ? {}
            : { errorMessage: outcome.errorMessage }),
        },
      });
      const fresh = repo.getAgentSession(id);
      if (fresh && fresh.status === "open") {
        if (outcome.status === "completed" && turnOutput?.message != null) {
          this.post({
            agentSessionId: id,
            speaker: { kind: "agent", name: seat.name },
            ...(turnOutput.to === null ? {} : { to: turnOutput.to }),
            text: turnOutput.message,
          });
        } else if (outcome.status === "error") {
          // The orchestrator must hear about failures, not just silence.
          this.#notice(
            fresh,
            `${seat.name}'s turn failed: ${outcome.errorMessage ?? "unknown error"}`,
          );
          repo.patchAgentSession(id, { owedToOrchestrator: true });
        }
      }
    }
  }

  // --- Helpers --------------------------------------------------------------

  #specialists(id: string): ParticipantRow[] {
    return this.#deps.repo
      .listParticipants(id)
      .filter((p) => p.role === "agent");
  }

  #statusOf(row: AgentSessionRow): "working" | "idle" | "archived" {
    if (row.status === "archived") return "archived";
    const lane = this.#lanes.get(row.id);
    const inFlight = (lane?.turns.size ?? 0) > 0;
    const pending = this.#specialists(row.id).some((p) => p.pendingTurnSeq > 0);
    return inFlight || pending ? "working" : "idle";
  }

  #setStatus(id: string, status: "working" | "idle"): void {
    const lane = this.#lane(id);
    if (lane.lastStatus === status) return;
    lane.lastStatus = status;
    const session = this.#deps.repo.getAgentSession(id);
    if (!session) return;
    this.#deps.bus.append({
      type: "agent_session.status",
      userSessionId: session.userSessionId,
      agentSessionId: id,
      payload: {
        agentSessionId: id,
        status,
        owedToOrchestrator: session.owedToOrchestrator,
      },
    });
  }

  #notice(session: AgentSessionRow, text: string): void {
    const { repo, bus } = this.#deps;
    const row = repo.appendMessage({
      sessionKind: "agent",
      sessionId: session.id,
      speaker: { kind: "system", name: "system" },
      kind: "notice",
      text,
    });
    bus.append({
      type: "agent_session.message",
      userSessionId: session.userSessionId,
      agentSessionId: session.id,
      payload: { agentSessionId: session.id, message: toWireMessage(row) },
    });
  }
}
