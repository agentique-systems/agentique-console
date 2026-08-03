/**
 * AgentSessionHost (B5): the console-domain side of agent sessions. Execution
 * is native — every seat is an SDK subagent inside the UserSession's one
 * persistent query, talking via SendMessage — so this host no longer runs
 * anything. It is an OBSERVER and a registry:
 *
 * - createSession writes the metadata rows the spawn plan is built from;
 * - the SeatRegistry binds observed Agent spawns (callId → seat) so the
 *   runner can attribute forwarded traffic; deliberately in-memory — a
 *   subagent dies with the process, and so does its binding;
 * - recordDerivedMessage persists observed SendMessage speech (the one-chat-
 *   lane rule with derivation replacing routing);
 * - status / turn events derive from spawn + SubagentStop bookends.
 */
import { badRequest, notFound } from "../api/errors.ts";
import {
  Repo,
  toWireAgentSession,
  toWireMessage,
  type AgentSessionRow,
} from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";
import { resolveInstructions } from "./presets.ts";
import {
  COORDINATOR_SEAT,
  ORCHESTRATOR_SEAT,
  seatOfSpawnName,
} from "./spawn-names.ts";

const SEAT_NAME_RE = /^[A-Za-z0-9_.:-]+$/;
const RESERVED_NAMES = new Set([
  "orchestrator",
  "operator",
  "system",
  "main",
  "coordinator",
]);

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
}

export interface AgentSessionHostDeps {
  repo: Repo;
  bus: EventBus;
}

/**
 * A live native subagent bound to a seat — the coordinator binds to the
 * ORCHESTRATOR_SEAT participant (it is that seat's voice), specialists to
 * their seat names.
 */
interface SeatBinding {
  agentSessionId: string;
  participant: string;
  callId: string;
  /** The spawn name (SendMessage address) — how siblings refer to it. */
  spawnName: string;
  /** The harness-assigned subagent id; null until the launch receipt lands. */
  agentId: string | null;
}

export class AgentSessionHost {
  readonly #deps: AgentSessionHostDeps;
  /** callId → the live native subagent bound to a seat. */
  readonly #seats = new Map<string, SeatBinding>();

  constructor(deps: AgentSessionHostDeps) {
    this.#deps = deps;
  }

  // --- SeatRegistry ---------------------------------------------------------

  /**
   * The runner observed an Agent tool call: bind it to a seat. Fail-closed —
   * the spawn prompt must name an owned agent session (as_… id) AND the spawn
   * name must reverse to one of its seats (or the coordinator). Anything
   * unresolvable stays unbound and its traffic is dropped.
   */
  observeAgentSpawn(
    callId: string,
    spawnName: string,
    agentSessionId: string,
    subagentType = "",
  ): void {
    const { repo, bus } = this.#deps;
    const session = repo.getAgentSession(agentSessionId);
    if (!session || session.status !== "open") return;
    const seats = this.#specialists(agentSessionId).map((p) => p.name);
    const seat = seatOfSpawnName(spawnName, agentSessionId, seats);
    if (seat === null) return;
    const participant = seat === COORDINATOR_SEAT ? ORCHESTRATOR_SEAT : seat;
    // B4: approval IS the execute-variant spawn — a planning-phase session
    // seeing a specialist spawned WITHOUT the "-planning" type flips to
    // executing (the SDK's own consent pattern: fresh agent, approved prompt).
    if (
      session.phase === "planning" &&
      participant !== ORCHESTRATOR_SEAT &&
      subagentType !== "" &&
      !subagentType.endsWith("-planning")
    ) {
      repo.patchAgentSession(agentSessionId, { phase: "executing" });
      bus.append({
        type: "agent_session.phase",
        userSessionId: session.userSessionId,
        agentSessionId,
        payload: { agentSessionId, phase: "executing" },
      });
    }
    this.#seats.set(callId, {
      agentSessionId,
      participant,
      callId,
      spawnName,
      agentId: null,
    });
    bus.append({
      type: "agent_session.turn.started",
      userSessionId: session.userSessionId,
      agentSessionId,
      payload: { agentSessionId, participant, turnId: callId },
    });
    this.#emitDerivedStatus(agentSessionId);
  }

  /** The Agent tool's launch receipt arrived: learn the subagent id. */
  confirmAgentLaunch(callId: string, agentId: string): void {
    const binding = this.#seats.get(callId);
    if (binding) binding.agentId = agentId;
  }

  /** SubagentStop: the seat's agent finished. */
  releaseAgent(agentId: string): void {
    for (const [callId, binding] of this.#seats) {
      if (binding.agentId !== agentId) continue;
      this.#seats.delete(callId);
      const session = this.#deps.repo.getAgentSession(binding.agentSessionId);
      if (session) {
        this.#deps.bus.append({
          type: "agent_session.turn.settled",
          userSessionId: session.userSessionId,
          agentSessionId: binding.agentSessionId,
          payload: {
            agentSessionId: binding.agentSessionId,
            participant: binding.participant,
            turnId: binding.callId,
            status: "completed",
          },
        });
      }
      this.#emitDerivedStatus(binding.agentSessionId);
      return;
    }
  }

  /** The seat bound to a spawn call id (attribution for forwarded traffic). */
  seatOf(callId: string): { agentSessionId: string; participant: string } | null {
    const binding = this.#seats.get(callId);
    if (!binding) return null;
    return {
      agentSessionId: binding.agentSessionId,
      participant: binding.participant,
    };
  }

  /** The seat a SendMessage `to` address resolves to, if any. */
  seatOfSpawnAddress(
    to: string,
  ): { agentSessionId: string; participant: string; callId: string } | null {
    for (const binding of this.#seats.values()) {
      if (binding.spawnName === to) {
        return {
          agentSessionId: binding.agentSessionId,
          participant: binding.participant,
          callId: binding.callId,
        };
      }
    }
    return null;
  }

  /** True when the session's coordinator (orchestrator-seat agent) is live. */
  hasCoordinator(agentSessionId: string): boolean {
    for (const binding of this.#seats.values()) {
      if (
        binding.agentSessionId === agentSessionId &&
        binding.participant === ORCHESTRATOR_SEAT
      ) {
        return true;
      }
    }
    return false;
  }

  // --- Derived transcript ---------------------------------------------------

  /**
   * Persist an observed SendMessage as transcript speech. In a planning-phase
   * session, a specialist's message to the coordinator IS its plan.
   */
  recordDerivedMessage(input: {
    agentSessionId: string;
    speaker: { kind: "orchestrator" | "agent"; name: string };
    to?: string;
    text: string;
  }): void {
    const { repo, bus } = this.#deps;
    const session = repo.getAgentSession(input.agentSessionId);
    if (!session || session.status !== "open") return;
    const isPlan =
      session.phase === "planning" &&
      input.speaker.kind === "agent" &&
      input.to === ORCHESTRATOR_SEAT;
    const row = repo.appendMessage({
      sessionKind: "agent",
      sessionId: input.agentSessionId,
      speaker: input.speaker,
      ...(input.to === undefined ? {} : { to: input.to }),
      kind: isPlan ? "plan" : "message",
      text: input.text,
    });
    if (isPlan) {
      bus.append({
        type: "agent_session.plan.captured",
        userSessionId: session.userSessionId,
        agentSessionId: input.agentSessionId,
        payload: {
          agentSessionId: input.agentSessionId,
          participant: input.speaker.name,
          plan: input.text,
        },
      });
    }
    bus.append({
      type: "agent_session.message",
      userSessionId: session.userSessionId,
      agentSessionId: input.agentSessionId,
      payload: {
        agentSessionId: input.agentSessionId,
        message: toWireMessage(row),
      },
    });
  }

  // --- Console-domain CRUD --------------------------------------------------

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
      lastSeenSeq: 0,
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
        lastSeenSeq: 0,
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
    return { agentSessionId: row.id, participants: specialists };
  }

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

  // --- Helpers --------------------------------------------------------------

  #specialists(id: string) {
    return this.#deps.repo
      .listParticipants(id)
      .filter((p) => p.role === "agent");
  }

  /** Live-seat derivation: working while any bound agent is alive. */
  #liveSeats(agentSessionId: string): number {
    let live = 0;
    for (const binding of this.#seats.values()) {
      if (binding.agentSessionId === agentSessionId) live += 1;
    }
    return live;
  }

  #statusOf(row: AgentSessionRow): "working" | "idle" | "archived" {
    if (row.status === "archived") return "archived";
    return this.#liveSeats(row.id) > 0 ? "working" : "idle";
  }

  #emitDerivedStatus(agentSessionId: string): void {
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (!session || session.status !== "open") return;
    this.#deps.bus.append({
      type: "agent_session.status",
      userSessionId: session.userSessionId,
      agentSessionId,
      payload: {
        agentSessionId,
        status: this.#liveSeats(agentSessionId) > 0 ? "working" : "idle",
        owedToOrchestrator: false,
      },
    });
  }
}
