import type { HandoffDraft, HandoffTrigger, Speaker } from "@agentique-console/shared";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../api/errors.ts";
import type { AgentProfile, AgentProfileRegistry } from "../agent-profiles/registry.ts";
import type { Config } from "../config.ts";
import {
  Repo,
  toWireAgentSession,
  toWireMessage,
  type AgentSessionRow,
  type MailboxDeliveryRow,
  type MessageRow,
  type ParticipantRow,
} from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { RuntimeBroadcaster } from "../events/runtime.ts";
import { newId, nowIso } from "../ids.ts";
import { mapSdkMessage } from "../sdk/mapping.ts";
import type { SqliteSessionStore } from "../sdk/session-store.ts";
import type { ConsoleSdk, QueryHandle, SdkOptions, SdkToolResult } from "../sdk/types.ts";
import { sdkEnv } from "../sdk/env.ts";
import type { ProcessManager } from "../runtime/process-manager.ts";
import type { BrowserManager } from "../runtime/browser-manager.ts";
import type { InteractionService } from "../orchestrator/interactions.ts";
import type { TaskService } from "../tasks/service.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { CheckpointClosingSchema, HandoffDraftSchema } from "../handoffs/schema.ts";
import { COORDINATOR_SEAT, seatOfSpawnName } from "./spawn-names.ts";

export const ORCHESTRATOR_SEAT = "orchestrator";
export const MAIN_RECIPIENT = "main";
const SEAT_NAME_RE = /^[A-Za-z0-9_.:-]+$/;
const RESERVED_NAMES = new Set([ORCHESTRATOR_SEAT, "operator", "system", MAIN_RECIPIENT, "coordinator"]);
const MATERIAL_CATEGORIES = new Set(["milestone", "failure", "final", "decision"]);

type Category = MailboxDeliveryRow["category"];

interface Flight { abort: AbortController; query: QueryHandle | null; }
interface Lane { chain: Promise<void>; turns: Map<string, Flight>; lastStatus: "working" | "idle" | null; }

export interface CreateAgentSessionInput {
  userSessionId: string;
  title: string;
  mode: "execute" | "plan_execute";
  agents: { name: string; profileId?: string; preset?: string; instructions?: string; model?: string; owns?: string[] }[];
  briefing?: HandoffDraft;
}

export interface AgentSessionHostDeps {
  repo: Repo;
  bus: EventBus;
  config?: Config;
  profiles?: AgentProfileRegistry;
  sdk?: () => Promise<ConsoleSdk>;
  sessionStore?: SqliteSessionStore;
  getWorkspaceRoot?: (workspaceId: string) => string;
  wake?: (userSessionId: string, agentSessionId: string, category: Category, text: string) => void;
  processes?: ProcessManager;
  browsers?: BrowserManager;
  interactions?: InteractionService;
  tasks?: TaskService;
  handoffs?: HandoffService;
}

const OUTPUT_SCHEMA = CheckpointClosingSchema;

function ok(value: unknown): SdkToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Console-managed, independently resumable participant sessions and durable mailbox. */
export class AgentSessionHost {
  readonly #deps: AgentSessionHostDeps;
  readonly #lanes = new Map<string, Lane>();
  #globalTurns = 0;
  readonly #deferredDecisions = new Map<string, string[]>();
  readonly #legacyBindings = new Map<string, { agentSessionId: string; participant: string; spawnName: string; agentId: string | null }>();

  constructor(deps: AgentSessionHostDeps) { this.#deps = deps; }

  createSession(input: CreateAgentSessionInput): { agentSessionId: string; participants: string[] } {
    const { repo, bus } = this.#deps;
    const user = repo.getUserSession(input.userSessionId);
    if (!user) throw notFound(`no user session ${input.userSessionId}`);
    if (input.agents.length < 1 || input.agents.length > 4) throw badRequest("an agent session seats 1 to 4 specialists");
    const names = new Set<string>();
    for (const agent of input.agents) {
      if (!SEAT_NAME_RE.test(agent.name) || RESERVED_NAMES.has(agent.name.toLowerCase())) throw badRequest(`invalid or reserved seat name \"${agent.name}\"`);
      if (names.has(agent.name)) throw badRequest(`duplicate seat name \"${agent.name}\"`);
      names.add(agent.name);
    }
    const ownedScopes = new Map<string, string>();
    for (const agent of input.agents) {
      const profileId = agent.profileId ?? agent.preset ?? "explorer";
      if (profileId.includes("reviewer")) continue;
      for (const scope of agent.owns ?? []) {
        const normalized = scope.trim(); if (!normalized) continue;
        const owner = ownedScopes.get(normalized);
        if (owner) throw badRequest(`ownership scope \"${normalized}\" is assigned to both ${owner} and ${agent.name}`);
        ownedScopes.set(normalized, agent.name);
      }
    }
    const title = input.title.trim();
    if (!title) throw badRequest("a session title is required");
    const parent = repo.getUserSession(input.userSessionId);
    if (!parent) throw badRequest("unknown user session");
    const now = nowIso();
    const row: AgentSessionRow = {
      id: newId("as"), userSessionId: input.userSessionId, title, mode: input.mode,
      phase: input.mode === "plan_execute" ? "planning" : "executing", status: "open", createdAt: now, updatedAt: now,
    };
    repo.insertAgentSession(row);
    const coordinator = this.#snapshotProfile(this.#profile("coordinator", parent.workspaceId));
    repo.insertParticipant(this.#participant(row.id, ORCHESTRATOR_SEAT, "orchestrator", coordinator, "", undefined, [], 0, now));
    input.agents.forEach((agent, index) => {
      const profile = this.#snapshotProfile(this.#profile(agent.profileId ?? agent.preset ?? "explorer", parent.workspaceId));
      repo.insertParticipant(this.#participant(row.id, agent.name, "agent", profile, agent.instructions ?? "", agent.model, agent.owns ?? [], index + 1, now));
    });
    const specialists = input.agents.map((agent) => agent.name);
    bus.append({ type: "agent_session.created", userSessionId: row.userSessionId, agentSessionId: row.id,
      payload: { session: toWireAgentSession(row, specialists, false), participants: specialists } });
    bus.append({ type: "flow.delegation", userSessionId: row.userSessionId, agentSessionId: row.id,
      payload: { userSessionId: row.userSessionId, agentSessionId: row.id, kind: "created", preview: title } });
    if (input.briefing) this.post({ agentSessionId: row.id, speaker: { kind: "orchestrator", name: MAIN_RECIPIENT }, to: ORCHESTRATOR_SEAT, handoff: input.briefing, category: "assignment" });
    return { agentSessionId: row.id, participants: specialists };
  }

  post(input: { agentSessionId: string; speaker: Speaker; to: string; handoff: HandoffDraft; category?: Category; dedupeKey?: string; deferWake?: boolean; turnId?: string }): MessageRow {
    const { repo, bus } = this.#deps;
    const session = repo.getAgentSession(input.agentSessionId);
    if (!session) throw notFound(`no agent session ${input.agentSessionId}`);
    if (session.status !== "open") throw conflict(`agent session ${input.agentSessionId} is archived`);
    if (!this.#deps.handoffs) throw new Error("handoff service unavailable");
    this.#assertRoute(session.id, input.speaker.name, input.to);
    const category = input.category ?? "update";
    if (input.dedupeKey) {
      const prior = repo.findDeliveryByDedupe(session.id, input.speaker.name, input.to, input.dedupeKey);
      const priorMessage = prior ? repo.getMessageById(prior.messageId) : undefined;
      if (priorMessage) return priorMessage;
    }
    if (input.speaker.name === ORCHESTRATOR_SEAT && input.to === MAIN_RECIPIENT && category === "final" && this.#deps.tasks) {
      const incomplete = this.#deps.tasks.listForUserSession(session.userSessionId).filter((task) => task.agentSessionId === session.id && task.status !== "completed" && task.status !== "deleted");
      if (incomplete.length > 0) throw badRequest(`cannot report final while ${incomplete.length} task(s) remain incomplete: ${incomplete.map((task) => task.subject).join(", ")}`);
    }
    if (input.speaker.name === ORCHESTRATOR_SEAT && input.to === MAIN_RECIPIENT && category === "final") {
      const activeSpecialists = [...(this.#lanes.get(session.id)?.turns.keys() ?? [])].filter((name) => name !== ORCHESTRATOR_SEAT);
      const pendingInternal = repo.listActiveDeliveries(session.id).filter((delivery) => delivery.recipient !== MAIN_RECIPIENT);
      if (activeSpecialists.length > 0 || pendingInternal.length > 0) throw badRequest(`cannot report final while AgentSession work is active (${activeSpecialists.length} running, ${pendingInternal.length} queued/delivered)`);
    }
    const senderSeat = input.speaker.name === MAIN_RECIPIENT ? undefined : repo.getParticipant(session.id, input.speaker.name);
    const prepared = this.#deps.handoffs.prepare({
      draft: input.handoff, userSessionId: session.userSessionId, agentSessionId: session.id,
      sender: input.speaker.name, recipient: input.to,
      profileId: input.speaker.name === MAIN_RECIPIENT ? "main" : senderSeat?.profileId ?? null,
      extensionKind: input.speaker.name === MAIN_RECIPIENT ? "coordination" : (senderSeat?.profileSnapshot as AgentProfile | undefined)?.handoffExtension,
      generation: input.speaker.name === MAIN_RECIPIENT ? (repo.getUserSession(session.userSessionId)?.sdkGeneration ?? 0) : senderSeat?.generation ?? 0,
      turnId: input.turnId, trigger: category as HandoffTrigger,
      parentHandoffId: category === "assignment" ? null : (senderSeat?.latestHandoffId ?? (input.speaker.name === MAIN_RECIPIENT ? repo.getUserSession(session.userSessionId)?.latestHandoffId : null)),
    });
    const text = prepared.text;
    const { message, delivery } = repo.appendHandoffMailbox({
      sessionKind: "agent", sessionId: session.id, userSessionId: session.userSessionId,
      agentSessionId: session.id, speaker: input.speaker, to: input.to, recipient: input.to,
      kind: category === "decision" && session.phase === "planning" ? "plan" : "message",
      text, category, handoff: prepared.row, summary: prepared.summary,
      ...(input.turnId ? { turnId: input.turnId } : {}), ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    });
    this.#deps.handoffs.committed(prepared.record);
    bus.append({ type: "agent_session.message", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, message: toWireMessage(message) } });
    bus.append({ type: "agent_session.mailbox", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, deliveryId: delivery.id, messageSeq: message.seq, sender: input.speaker.name, recipient: input.to, category, status: "queued" } });
    if (input.to === MAIN_RECIPIENT) {
      this.#patchDelivery(session, delivery, "acknowledged");
      if (category === "decision" && input.deferWake === true) {
        const pending = this.#deferredDecisions.get(session.id) ?? [];
        if (!pending.includes(text)) pending.push(text);
        this.#deferredDecisions.set(session.id, pending);
      } else if (MATERIAL_CATEGORIES.has(category)) {
        const deferred = this.#deferredDecisions.get(session.id) ?? [];
        this.#deferredDecisions.delete(session.id);
        const wakeText = deferred.length === 0 ? text : `${text}\n\nBatched nonblocking operator decisions:\n${deferred.map((decision, index) => `${index + 1}. ${decision}`).join("\n")}`;
        bus.append({ type: "flow.result", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { userSessionId: session.userSessionId, agentSessionId: session.id, digestPreview: text.slice(0, 140) } });
        this.#deps.wake?.(session.userSessionId, session.id, category, wakeText);
      }
    } else {
      repo.patchParticipant(session.id, input.to, { pendingTurnSeq: message.seq });
      this.#schedule(session.id);
    }
    return message;
  }

  readSession(input: { agentSessionId: string; afterSeq?: number; limit?: number }) {
    const session = this.#deps.repo.getAgentSession(input.agentSessionId);
    if (!session) throw notFound(`no agent session ${input.agentSessionId}`);
    let rows = this.#deps.repo.listMessages("agent", session.id, input.afterSeq ?? 0);
    if (input.limit !== undefined) rows = rows.slice(-input.limit);
    return { status: this.#statusOf(session), phase: session.phase,
      participants: this.#specialists(session.id).map((p) => ({ name: p.name, preset: p.profileId, profileId: p.profileId, model: p.model })),
      messages: rows.map(toWireMessage) };
  }

  listForUserSession(userSessionId: string) {
    return this.#deps.repo.listAgentSessions(userSessionId).map((row) => ({
      id: row.id, title: row.title, mode: row.mode, phase: row.phase, status: this.#statusOf(row),
      participants: this.#specialists(row.id).map((p) => p.name),
      unseenCount: this.#deps.repo.listQueuedDeliveries(row.id).filter((d) => d.recipient === MAIN_RECIPIENT).length,
      updatedAt: row.updatedAt,
    }));
  }

  wireSession(row: AgentSessionRow) { return toWireAgentSession(row, this.#specialists(row.id).map((p) => p.name), this.#statusOf(row) === "working"); }

  interrupt(agentSessionId: string): void {
    for (const turn of this.#lanes.get(agentSessionId)?.turns.values() ?? []) {
      turn.abort.abort(); void turn.query?.interrupt?.().catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const lane of this.#lanes.values()) for (const turn of lane.turns.values()) {
      turn.abort.abort();
      if (turn.query?.interrupt) pending.push(turn.query.interrupt().catch(() => undefined));
      turn.query?.close?.();
    }
    await Promise.all(pending);
  }

  archiveForUserSession(userSessionId: string): void {
    for (const session of this.#deps.repo.listAgentSessions(userSessionId)) {
      if (session.status !== "open") continue;
      this.interrupt(session.id);
      this.#deps.processes?.stopSession(session.id);
      void this.#deps.browsers?.closeSession(session.id);
      for (const delivery of this.#deps.repo.listActiveDeliveries(session.id)) this.#patchDelivery(session, delivery, "cancelled");
      this.#deps.repo.patchAgentSession(session.id, { status: "archived" });
      this.#deps.bus.append({ type: "agent_session.status", userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, status: "archived", owedToOrchestrator: false } });
    }
  }

  boot(): void {
    for (const delivery of this.#deps.repo.listQueuedDeliveries()) this.#schedule(delivery.agentSessionId);
  }

  profiles(workspaceId?: string): AgentProfile[] { return this.#deps.profiles?.list(workspaceId) ?? []; }
  runtimeAvailability(): { sandbox: boolean; chrome: boolean } {
    return { sandbox: fs.existsSync("/usr/bin/bwrap") || fs.existsSync("/usr/local/bin/bwrap"), chrome: fs.existsSync("/usr/bin/google-chrome") };
  }

  /** Legacy observation seam retained only for importing/closing old native runs. */
  observeAgentSpawn(callId: string, spawnName: string, agentSessionId: string, subagentType = ""): void {
    const session = this.#deps.repo.getAgentSession(agentSessionId); if (!session) return;
    const seat = seatOfSpawnName(spawnName, agentSessionId, this.#specialists(agentSessionId).map((p) => p.name));
    if (seat === null) return;
    const participant = seat === COORDINATOR_SEAT ? ORCHESTRATOR_SEAT : seat;
    if (session.phase === "planning" && participant !== ORCHESTRATOR_SEAT && subagentType && !subagentType.endsWith("-planning")) {
      this.#deps.repo.patchAgentSession(agentSessionId, { phase: "executing" });
      this.#deps.bus.append({ type: "agent_session.phase", userSessionId: session.userSessionId, agentSessionId, payload: { agentSessionId, phase: "executing" } });
    }
    this.#legacyBindings.set(callId, { agentSessionId, participant, spawnName, agentId: null });
    this.#deps.bus.append({ type: "agent_session.turn.started", userSessionId: session.userSessionId, agentSessionId, payload: { agentSessionId, participant, turnId: callId } });
  }
  confirmAgentLaunch(callId: string, agentId: string): void { const binding = this.#legacyBindings.get(callId); if (binding) binding.agentId = agentId; }
  seatOf(callId: string): { agentSessionId: string; participant: string } | null { const b = this.#legacyBindings.get(callId); return b ? { agentSessionId: b.agentSessionId, participant: b.participant } : null; }
  seatOfSpawnAddress(to: string): { agentSessionId: string; participant: string; callId: string } | null { for (const [callId, b] of this.#legacyBindings) if (b.spawnName === to) return { agentSessionId: b.agentSessionId, participant: b.participant, callId }; return null; }
  hasCoordinator(agentSessionId: string): boolean { return [...this.#legacyBindings.values()].some((b) => b.agentSessionId === agentSessionId && b.participant === ORCHESTRATOR_SEAT); }
  releaseAgent(agentId: string): void { for (const [callId, b] of this.#legacyBindings) if (b.agentId === agentId) { this.#releaseLegacy(callId, b, "completed"); return; } }
  releaseSpawnCall(callId: string): void { const b = this.#legacyBindings.get(callId); if (b) this.#releaseLegacy(callId, b, "aborted"); }
  recordDerivedMessage(input: { agentSessionId: string; speaker: { kind: "orchestrator" | "agent"; name: string }; to?: string; text: string }): void {
    const session = this.#deps.repo.getAgentSession(input.agentSessionId); if (!session) return;
    const isPlan = session.phase === "planning" && input.speaker.kind === "agent" && input.to === ORCHESTRATOR_SEAT;
    const row = this.#deps.repo.appendMessage({ sessionKind: "agent", sessionId: session.id, speaker: input.speaker, ...(input.to ? { to: input.to } : {}), kind: isPlan ? "plan" : "message", text: input.text });
    this.#deps.bus.append({ type: "agent_session.message", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { agentSessionId: session.id, message: toWireMessage(row) } });
    if (isPlan) this.#deps.bus.append({ type: "agent_session.plan.captured", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { agentSessionId: session.id, participant: input.speaker.name, plan: input.text } });
  }

  #releaseLegacy(callId: string, binding: { agentSessionId: string; participant: string }, status: "completed" | "aborted"): void {
    this.#legacyBindings.delete(callId); const session = this.#deps.repo.getAgentSession(binding.agentSessionId); if (!session) return;
    this.#deps.bus.append({ type: "agent_session.turn.settled", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { agentSessionId: session.id, participant: binding.participant, turnId: callId, status } });
  }

  #participant(agentSessionId: string, name: string, role: "orchestrator" | "agent", profile: AgentProfile, extra: string, model: string | undefined, ownership: string[], ord: number, createdAt: string): ParticipantRow {
    const instructions = [profile.instructions, extra.trim()].filter(Boolean).join("\n\nAssigned role context:\n");
    return { agentSessionId, name, role, preset: profile.id, instructions, model: model ?? profile.model ?? null,
      profileId: profile.id, profileSnapshot: profile, ownership, sdkSessionId: null, generation: 0, turnCount: 0,
      contextTokens: 0, memory: "", latestHandoffId: null, checkpointReady: true, pendingTurnSeq: 0, lastSeenSeq: 0, ord, createdAt };
  }

  #profile(id: string, workspaceId?: string): AgentProfile {
    if (this.#deps.profiles) return this.#deps.profiles.get(id, workspaceId);
    return { id, title: id, purpose: id, instructions: `You are the ${id} specialist.`, tools: ["Read", "Glob", "Grep"], permissionMode: "default", maxTurns: 30, sandboxRequired: true, runtime: { shell: false, browser: false, screenshots: false } };
  }

  #assertRoute(agentSessionId: string, sender: string, recipient: string): void {
    const specialists = new Set(this.#specialists(agentSessionId).map((p) => p.name));
    const valid = sender === MAIN_RECIPIENT
      ? recipient === ORCHESTRATOR_SEAT
      : sender === ORCHESTRATOR_SEAT
        ? recipient === MAIN_RECIPIENT || specialists.has(recipient)
        : specialists.has(sender) && recipient === ORCHESTRATOR_SEAT;
    if (!valid) throw badRequest(`route ${sender} → ${recipient} is not allowed; communication is main ↔ coordinator ↔ specialist`);
  }

  #lane(id: string): Lane {
    let lane = this.#lanes.get(id);
    if (!lane) { lane = { chain: Promise.resolve(), turns: new Map(), lastStatus: null }; this.#lanes.set(id, lane); }
    return lane;
  }

  #schedule(id: string): void {
    if (!this.#deps.sdk || !this.#deps.config) return;
    const lane = this.#lane(id);
    lane.chain = lane.chain.then(() => this.#drain(id)).catch((error) => this.#recordHostFailure(id, error));
  }

  async #drain(id: string): Promise<void> {
    const config = this.#deps.config;
    if (!config) return;
    const session = this.#deps.repo.getAgentSession(id);
    if (!session || session.status !== "open") return;
    const lane = this.#lane(id);
    const queued = this.#deps.repo.listQueuedDeliveries(id);
    for (const recipient of new Set(queued.map((d) => d.recipient))) {
      if (recipient === MAIN_RECIPIENT || lane.turns.has(recipient)) continue;
      if (lane.turns.size >= config.perAgentSessionTurns || this.#globalTurns >= config.globalAgentTurns) break;
      this.#startTurn(session, recipient);
    }
    this.#setStatus(id, lane.turns.size > 0 || queued.some((d) => d.recipient !== MAIN_RECIPIENT) ? "working" : "idle");
  }

  #startTurn(session: AgentSessionRow, participant: string): void {
    const seat = this.#deps.repo.getParticipant(session.id, participant);
    if (!seat) return;
    const deliveries = this.#deps.repo.listQueuedDeliveries(session.id).filter((d) => d.recipient === participant);
    if (deliveries.length === 0) return;
    const abort = new AbortController();
    const flight: Flight = { abort, query: null };
    const lane = this.#lane(session.id);
    lane.turns.set(participant, flight); this.#globalTurns += 1;
    const turnId = newId("turn");
    for (const delivery of deliveries) this.#patchDelivery(session, delivery, "delivered");
    this.#deps.bus.append({ type: "agent_session.turn.started", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, participant, turnId } });
    void this.#runTurn(session, seat, deliveries, turnId, flight).finally(() => {
      lane.turns.delete(participant); this.#globalTurns -= 1; this.#schedule(session.id);
      for (const other of this.#lanes.keys()) if (other !== session.id) this.#schedule(other);
    });
  }

  async #runTurn(session: AgentSessionRow, seat: ParticipantRow, deliveries: MailboxDeliveryRow[], turnId: string, flight: Flight): Promise<void> {
    const { repo, bus } = this.#deps;
    const runtime = new RuntimeBroadcaster(bus, { kind: "agent", sessionId: session.id }, seat.name,
      { userSessionId: session.userSessionId, agentSessionId: session.id });
    let status: "completed" | "error" | "aborted" = "completed";
    let errorMessage: string | undefined;
    let output: Record<string, unknown> = {};
    const sentThisTurn = new Set<string>();
    const startedAt = Date.now();
    const toolStarts = new Map<string, number>();
    let latestSeat = seat;
    try {
      const sdk = await this.#deps.sdk?.();
      if (!sdk) throw new Error("SDK unavailable");
      latestSeat = await this.#rotateIfNeeded(session, seat, sdk, flight);
      const user = repo.getUserSession(session.userSessionId);
      if (!user || !this.#deps.getWorkspaceRoot) throw new Error("workspace unavailable");
      const profile = latestSeat.profileSnapshot as AgentProfile;
      const mcp = this.#buildParticipantMcp(sdk, session, latestSeat, flight.abort.signal, sentThisTurn);
      const messages = deliveries.map((delivery) => repo.getMessageById(delivery.messageId)).filter((row): row is MessageRow => row !== undefined);
      const prompt = this.#composePrompt(session, latestSeat, messages);
      const options: SdkOptions = {
        cwd: this.#deps.getWorkspaceRoot(user.workspaceId),
        systemPrompt: { type: "preset", preset: "claude_code", append: `${latestSeat.instructions}${this.#checkpointContext(latestSeat)}\n\nUse mcp__console_agent__send_message for all communication. Never use native SendMessage or Agent tools.` },
        settingSources: [], includePartialMessages: true,
        permissionMode: session.phase === "planning" ? "plan" : profile.permissionMode,
        ...(profile.permissionMode === "bypassPermissions" && session.phase !== "planning" ? { allowDangerouslySkipPermissions: true } : {}),
        allowedTools: [...profile.tools, ...this.#runtimeToolNames(profile, latestSeat.name)],
        disallowedTools: ["Agent", "SendMessage", "Task", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"],
        outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA }, maxTurns: profile.maxTurns,
        sandbox: { enabled: true, failIfUnavailable: profile.sandboxRequired, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
          filesystem: { allowManagedReadPathsOnly: true, allowRead: [this.#deps.getWorkspaceRoot(user.workspaceId)], allowWrite: [this.#deps.getWorkspaceRoot(user.workspaceId)] } },
        env: sdkEnv(), abortController: flight.abort, persistSession: true,
        sessionStore: this.#deps.sessionStore as never, sessionStoreFlush: "eager",
        mcpServers: { console_agent: mcp as never },
        ...(latestSeat.model ? { model: latestSeat.model } : {}),
        ...((profile.pluginPath && profile.source === "workspace") ? { plugins: [{ type: "local" as const, path: profile.pluginPath }] } : {}),
        ...((profile.skills?.length ?? 0) > 0 ? { skills: profile.skills } : {}),
        ...((profile.effort ?? this.#deps.config?.effort) ? { effort: (profile.effort ?? this.#deps.config?.effort) as SdkOptions["effort"] } : {}),
        ...(latestSeat.sdkSessionId ? { resume: latestSeat.sdkSessionId } : {}),
      };
      runtime.set("thinking");
      const query = sdk.query({ prompt, options }); flight.query = query;
      try {
        for await (const raw of query) {
          for (const event of mapSdkMessage(raw)) {
            if ("parentCallId" in event && event.parentCallId) continue;
            if (event.kind === "resume") repo.patchParticipant(session.id, seat.name, { sdkSessionId: event.resumeId });
            else if (event.kind === "delta") { runtime.set("responding"); bus.broadcast({ type: "stream.delta", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { scope: { kind: "agent", sessionId: session.id }, speaker: seat.name, turnId, text: event.text } }); }
            else if (event.kind === "reasoning-delta") { runtime.set("thinking"); bus.broadcast({ type: "stream.reasoning", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { scope: { kind: "agent", sessionId: session.id }, speaker: seat.name, turnId, text: event.text } }); }
            else if (event.kind === "message") this.#recordNarration(session, seat.name, event.text, turnId);
            else if (event.kind === "notice") { runtime.note(event.text); bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { agentSessionId: session.id, participant: seat.name, turnId, detail: event.text } }); }
            else if (event.kind === "tool.call") { toolStarts.set(event.callId, Date.now()); runtime.set("tool", event.name); bus.append({ type: "agent_session.tool.call", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { sessionId: session.id, participant: seat.name, turnId, callId: event.callId, name: event.name, input: bus.capture(event.input, { userSessionId: session.userSessionId, agentSessionId: session.id }) } }); }
            else if (event.kind === "tool.result") {
              const captured = bus.captureSized(event.output, { userSessionId: session.userSessionId, agentSessionId: session.id });
              const toolStartedAt = toolStarts.get(event.callId); toolStarts.delete(event.callId);
              runtime.set("thinking"); bus.append({ type: "agent_session.tool.result", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { sessionId: session.id, participant: seat.name, turnId, callId: event.callId, output: captured.value, bytes: captured.bytes, ...(toolStartedAt === undefined ? {} : { durationMs: Date.now() - toolStartedAt }), ...(event.isError ? { isError: true } : {}) } });
            }
            else if (event.kind === "result") {
              output = event.output && typeof event.output === "object" ? event.output as Record<string, unknown> : {};
              repo.patchParticipant(session.id, seat.name, { ...(event.resumeId ? { sdkSessionId: event.resumeId } : {}), contextTokens: Math.max(latestSeat.contextTokens, event.inputTokens ?? 0) });
              this.#recordUsage(session, latestSeat, turnId, event, "completed", Date.now() - startedAt);
            }
            else if (event.kind === "error") { status = event.aborted ? "aborted" : "error"; errorMessage = event.message; this.#recordUsage(session, latestSeat, turnId, event, status, Date.now() - startedAt); }
          }
        }
      } finally { flight.query = null; query.close?.(); }
      for (const delivery of deliveries) this.#patchDelivery(session, delivery, "acknowledged");
      repo.patchParticipant(session.id, seat.name, { turnCount: latestSeat.turnCount + 1,
        checkpointReady: output?.checkpointReadiness !== "defer" });
      const closing = HandoffDraftSchema.safeParse(output?.handoff);
      if (status === "completed" && closing.success) {
        const to = typeof output.to === "string" ? output.to : (seat.name === ORCHESTRATOR_SEAT ? MAIN_RECIPIENT : ORCHESTRATOR_SEAT);
        const category = typeof output.category === "string" && ["assignment", "update", "milestone", "failure", "final", "decision"].includes(output.category) ? output.category as Category : "update";
        const key = `${to}\u0000${JSON.stringify(closing.data)}`;
        if (!sentThisTurn.has(key)) this.post({ agentSessionId: session.id, speaker: { kind: seat.role === "orchestrator" ? "orchestrator" : "agent", name: seat.name }, to, handoff: closing.data, category, turnId });
      }
    } catch (error) {
      status = flight.abort.signal.aborted ? "aborted" : "error";
      errorMessage = error instanceof Error ? error.message : String(error);
      if (status === "error" && repo.getAgentSession(session.id)?.status === "open") {
        const target = seat.name === ORCHESTRATOR_SEAT ? MAIN_RECIPIENT : ORCHESTRATOR_SEAT;
        this.post({ agentSessionId: session.id, speaker: { kind: seat.role === "orchestrator" ? "orchestrator" : "agent", name: seat.name }, to: target,
          handoff: this.#simpleHandoff("Turn failed", "failed", `Provider turn failed: ${errorMessage}`, "Inspect the failure and retry or reassign."), category: "failure", turnId });
      }
    } finally {
      if (status !== "completed") for (const delivery of deliveries) this.#patchDelivery(session, delivery, "cancelled");
      runtime.idle();
      bus.append({ type: "agent_session.turn.settled", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, participant: seat.name, turnId, status, durationMs: Date.now() - startedAt, ...(errorMessage ? { errorMessage } : {}) } });
    }
  }

  #buildParticipantMcp(sdk: ConsoleSdk, session: AgentSessionRow, seat: ParticipantRow, signal: AbortSignal, sentThisTurn: Set<string>): unknown {
    const tool = sdk.tool("send_message", "Persist and deliver one typed, evidence-bearing handoff through the Console mailbox. Specialists may address only orchestrator; coordinators may address specialists or main.", {
      to: z.string(), handoff: HandoffDraftSchema, category: z.enum(["assignment", "update", "milestone", "failure", "final", "decision"]).default("update"), dedupeKey: z.string().optional(),
    }, async (args: { to: string; handoff: HandoffDraft; category: Category; dedupeKey?: string }) => {
      try {
        const message = this.post({ agentSessionId: session.id, speaker: { kind: seat.role === "orchestrator" ? "orchestrator" : "agent", name: seat.name }, to: args.to, handoff: args.handoff, category: args.category, ...(args.dedupeKey ? { dedupeKey: args.dedupeKey } : {}) });
        sentThisTurn.add(`${args.to}\u0000${JSON.stringify(args.handoff)}`);
        return ok({ delivered: true, messageSeq: message.seq, handoffId: (message.payload?.handoff as { id?: string } | undefined)?.id });
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    });
    const profile = seat.profileSnapshot as AgentProfile;
    const tools: unknown[] = [tool];
    if (this.#deps.handoffs) {
      tools.push(
        sdk.tool("read_handoff", "Retrieve a lossless handoff section with cursor pagination. Use only when the compact envelope is insufficient.", {
          handoffId: z.string(), section: z.enum(["core", "extension"]).default("core"), cursor: z.string().optional(), maxBytes: z.number().int().min(1).max(32 * 1024).default(8 * 1024),
        }, async (args: { handoffId: string; section: "core" | "extension"; cursor?: string; maxBytes: number }) => ok(this.#deps.handoffs?.read(args.handoffId, args.section, args.cursor, args.maxBytes))),
        sdk.tool("report_handoff_discrepancy", "Report a handoff claim contradicted by the repository, task ledger, journal, or artifact. The original evidence stays authoritative.", {
          handoffId: z.string(), claim: z.string().min(1), evidence: z.string().min(1),
        }, async (args: { handoffId: string; claim: string; evidence: string }) => {
          this.#deps.handoffs?.reportDiscrepancy(args.handoffId, seat.name, args.claim, args.evidence); return ok({ recorded: true });
        }),
      );
    }
    const user = this.#deps.repo.getUserSession(session.userSessionId);
    const workspaceRoot = user && this.#deps.getWorkspaceRoot ? this.#deps.getWorkspaceRoot(user.workspaceId) : "";
    if (profile.runtime.shell && this.#deps.processes) {
      const scope = { workspaceRoot, userSessionId: session.userSessionId, agentSessionId: session.id, participant: seat.name };
      const processOwner = `${session.id}:${seat.name}`;
      tools.push(
        sdk.tool("process_start", "Start a Console-owned long-running process. Pass an executable and argv separately; cwd must remain in the workspace.", { command: z.string(), args: z.array(z.string()).default([]), cwd: z.string().default(".") }, async (args: { command: string; args: string[]; cwd: string }) => ok(this.#deps.processes?.start(scope, args.command, args.args, args.cwd))),
        sdk.tool("process_read", "Read new process output, optionally waiting once for a state change. Use waitMs instead of polling.", { processId: z.string(), afterSeq: z.number().int().default(0), waitMs: z.number().int().min(0).max(60_000).default(0) }, async (args: { processId: string; afterSeq: number; waitMs: number }) => ok(await this.#deps.processes?.read(processOwner, args.processId, args.afterSeq, args.waitMs))),
        sdk.tool("process_stop", "Stop a process owned by this participant.", { processId: z.string() }, async (args: { processId: string }) => { this.#deps.processes?.stop(processOwner, args.processId); return ok({ stopped: true }); }),
      );
    }
    if (profile.runtime.browser && this.#deps.browsers) {
      const key = `${session.id}:${seat.name}`;
      tools.push(
        sdk.tool("browser_open", "Open a URL in the participant's managed local Chrome page.", { url: z.string() }, async (args: { url: string }) => ok(await this.#deps.browsers?.open(key, args.url))),
        sdk.tool("browser_snapshot", "Inspect current URL, title, and rendered body text.", {}, async () => ok(await this.#deps.browsers?.snapshot(key))),
        sdk.tool("browser_click", "Click a locator (CSS or Playwright text locator syntax).", { selector: z.string() }, async (args: { selector: string }) => { await this.#deps.browsers?.click(key, args.selector); return ok({ clicked: true }); }),
        sdk.tool("browser_fill", "Fill an input located by CSS or Playwright locator syntax.", { selector: z.string(), value: z.string() }, async (args: { selector: string; value: string }) => { await this.#deps.browsers?.fill(key, args.selector, args.value); return ok({ filled: true }); }),
        sdk.tool("browser_console", "Read browser console and page errors.", {}, async () => ok(await this.#deps.browsers?.consoleMessages(key))),
      );
      if (profile.runtime.screenshots) {
        tools.push(sdk.tool("browser_screenshot", "Capture a full-page screenshot as a durable Console artifact.", {}, async () => ok(await this.#deps.browsers?.screenshot(key, { userSessionId: session.userSessionId, agentSessionId: session.id }))));
      }
    }
    if (seat.name === ORCHESTRATOR_SEAT && this.#deps.interactions) {
      tools.push(sdk.tool("request_decision", "Escalate a decision that belongs to the Human Operator. Blocking requests render immediately and wait for an answer. Nonblocking requests are coalesced into the next main-agent milestone.", {
        question: z.string().min(1), header: z.string().max(24).optional(),
        options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(2).max(4),
        blocking: z.boolean().default(true), recommendation: z.string().optional(),
      }, async (args: { question: string; header?: string; options: { label: string; description?: string }[]; blocking: boolean; recommendation?: string }) => {
        const text = `${args.question}\n${args.recommendation ? `Recommendation: ${args.recommendation}\n` : ""}${args.options.map((option) => `- ${option.label}: ${option.description ?? ""}`).join("\n")}`;
        if (!args.blocking) {
          this.post({ agentSessionId: session.id, speaker: { kind: "orchestrator", name: seat.name }, to: MAIN_RECIPIENT,
            handoff: this.#simpleHandoff("Operator decision requested", "blocked", text, "Main should decide or ask the operator."),
            category: "decision", dedupeKey: args.question, deferWake: true });
          return ok({ queued: true });
        }
        const pending = this.#deps.interactions?.createQuestion(session.userSessionId, [{ question: args.question, ...(args.header ? { header: args.header } : {}), options: args.options }], `agent:${session.id}:${seat.name}:${newId("turn")}`, signal);
        if (!pending) throw new Error("interaction service unavailable");
        const resolution = await pending.resolution;
        return ok(resolution);
      }));
    }
    if (seat.name === ORCHESTRATOR_SEAT && this.#deps.tasks && user) {
      const listId = `console:${session.id}:${ORCHESTRATOR_SEAT}`;
      tools.push(
        sdk.tool("task_create", "Create one authoritative task for a coherent unit and assign an explicit specialist owner.", { subject: z.string(), description: z.string().default(""), owner: z.string() }, async (args: { subject: string; description: string; owner: string }) => {
          const taskId = newId("task"); this.#deps.tasks?.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: taskId, subject: args.subject, description: args.description,
            attribution: { workspaceId: user.workspaceId, userSessionId: session.userSessionId, agentSessionId: session.id, participant: args.owner } }); return ok({ taskId });
        }),
        sdk.tool("task_update", "Update status or ownership in the authoritative Console task ledger.", { taskId: z.string(), status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(), owner: z.string().optional(), description: z.string().optional() }, async (args: { taskId: string; status?: "pending" | "in_progress" | "completed" | "deleted"; owner?: string; description?: string }) => {
          this.#deps.tasks?.applyUpdate({ sdkSessionId: listId, sdkTaskId: args.taskId, patch: { ...(args.status ? { status: args.status } : {}), ...(args.owner ? { owner: args.owner } : {}), ...(args.description ? { description: args.description } : {}) } }); return ok({ updated: true });
        }),
        sdk.tool("task_list", "List the AgentSession's authoritative Console tasks.", {}, async () => ok({ tasks: this.#deps.tasks?.listForUserSession(session.userSessionId).filter((task) => task.agentSessionId === session.id && task.status !== "deleted") ?? [] })),
      );
    }
    return sdk.createSdkMcpServer({ name: "console_agent", version: "2", tools });
  }

  #runtimeToolNames(profile: AgentProfile, participant: string): string[] {
    return ["mcp__console_agent__send_message", "mcp__console_agent__read_handoff", "mcp__console_agent__report_handoff_discrepancy",
      ...(profile.runtime.shell ? ["mcp__console_agent__process_start", "mcp__console_agent__process_read", "mcp__console_agent__process_stop"] : []),
      ...(profile.runtime.browser ? ["mcp__console_agent__browser_open", "mcp__console_agent__browser_snapshot", "mcp__console_agent__browser_click", "mcp__console_agent__browser_fill", "mcp__console_agent__browser_console"] : []),
      ...(profile.runtime.browser && profile.runtime.screenshots ? ["mcp__console_agent__browser_screenshot"] : []),
      ...(participant === ORCHESTRATOR_SEAT ? ["mcp__console_agent__request_decision"] : []),
      ...(participant === ORCHESTRATOR_SEAT ? ["mcp__console_agent__task_create", "mcp__console_agent__task_update", "mcp__console_agent__task_list"] : []),
    ];
  }

  #snapshotProfile(profile: AgentProfile): AgentProfile {
    if (profile.source !== "workspace" || !profile.pluginPath || !profile.revision || !this.#deps.config) return profile;
    const parent = path.join(this.#deps.config.dataDir, "profile-snapshots");
    const target = path.join(parent, profile.revision);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(parent, { recursive: true });
      const temp = path.join(parent, `.${profile.revision}-${newId("artifact")}`);
      try { fs.cpSync(profile.pluginPath, temp, { recursive: true, dereference: true }); fs.renameSync(temp, target); }
      catch (error) { if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true }); if (!fs.existsSync(target)) throw error; }
    }
    return { ...profile, pluginPath: target };
  }

  #composePrompt(session: AgentSessionRow, seat: ParticipantRow, rows: MessageRow[]): string {
    const roster = this.#deps.repo.listParticipants(session.id).map((p) => `${p.name} (${p.profileId}; owns: ${p.ownership.join(", ") || "coordination"})`).join("; ");
    const messages = rows.map((row) => {
      const id = (row.payload?.handoff as { id?: string } | undefined)?.id;
      if (!id || !this.#deps.handoffs) return `[${row.speakerName} → ${row.toName} | ${row.createdAt}] ${row.text}`;
      const handoff = this.#deps.handoffs.get(id);
      const expanded = handoff.core.risk === "high" || handoff.core.status === "needs_verification" || handoff.core.requestExpandedContext;
      this.#deps.bus.append({ type: "handoff.consumed", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { handoffId: id, participant: seat.name, mode: expanded ? "expanded" : "compact" } });
      return `[${row.speakerName} → ${row.toName} | ${row.createdAt}] Handoff ${id}\nCORE:\n${JSON.stringify(handoff.core, null, 2)}\nEVIDENCE MANIFEST: ${JSON.stringify([...handoff.core.state.evidence, ...handoff.core.result.artifacts])}${expanded ? `\nPROFILE EXTENSION:\n${JSON.stringify(handoff.extension, null, 2)}` : `\nExtension ${handoff.extension.kind} is available with read_handoff.`}`;
    }).join("\n\n");
    return `AgentSession ${session.id}: ${session.title}\nYou are ${seat.name}. Participants: ${roster}.\n\nOnly the following addressed handoffs are new:\n${messages}\n\nTreat handoff claims as historical context; verify risky claims against repository/task/journal evidence during normal work. Act without restating the envelope. Use typed send_message for every transfer. Finish with one structured closing output; set checkpointReadiness=defer only while state is genuinely unstable.`;
  }

  #simpleHandoff(action: string, status: HandoffDraft["core"]["status"], summary: string, nextAction: string | null): HandoffDraft {
    return { core: { schemaVersion: 1, taskId: null, status, risk: status === "failed" || status === "blocked" ? "high" : "medium",
      action, state: { summary, evidence: [] }, result: { summary: null, artifacts: [] }, uncertainty: [], nextAction,
      requestExpandedContext: status === "failed" }, extension: { kind: "generic", data: {} } };
  }

  async #rotateIfNeeded(session: AgentSessionRow, seat: ParticipantRow, sdk: ConsoleSdk, flight: Flight): Promise<ParticipantRow> {
    const config = this.#deps.config;
    if (!config || !this.#deps.handoffs) return seat;
    const hard = seat.turnCount >= config.contextTurnLimit || seat.contextTokens >= config.contextTokenLimit;
    const soft = seat.turnCount >= Math.ceil(config.contextTurnLimit * 0.8) || seat.contextTokens >= Math.ceil(config.contextTokenLimit * 0.75);
    if (!soft || (!hard && !seat.checkpointReady)) return seat;
    const threshold = hard ? "hard" as const : "soft" as const;
    let draft: HandoffDraft | null = null;
    let failure: string | null = null;
    const started = Date.now();
    if (seat.sdkSessionId) {
      const checkpointAbort = new AbortController();
      const profile = seat.profileSnapshot as AgentProfile;
      const user = this.#deps.repo.getUserSession(session.userSessionId);
      if (user && this.#deps.getWorkspaceRoot) {
        const query = sdk.query({ prompt: "Create a lossless rotation checkpoint for your successor context. Capture only durable task state, verified evidence pointers, results, uncertainty, and the exact next action. Do not perform work or call tools.", options: {
          cwd: this.#deps.getWorkspaceRoot(user.workspaceId), systemPrompt: { type: "preset", preset: "claude_code", append: "You are checkpointing your own context. Report faithfully; do not correct or embellish uncertain state." },
          settingSources: [], includePartialMessages: false, permissionMode: "plan", allowedTools: [],
          disallowedTools: ["Agent", "SendMessage", "Task", "Bash", "Edit", "Write", "WebSearch", "WebFetch"],
          outputFormat: { type: "json_schema", schema: CheckpointClosingSchema.properties.handoff }, maxTurns: 2,
          sandbox: { enabled: true, failIfUnavailable: profile.sandboxRequired, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
            filesystem: { allowManagedReadPathsOnly: true, allowRead: [this.#deps.getWorkspaceRoot(user.workspaceId)], allowWrite: [] } },
          env: sdkEnv(), abortController: checkpointAbort, persistSession: true, sessionStore: this.#deps.sessionStore as never,
          sessionStoreFlush: "eager", resume: seat.sdkSessionId, ...(seat.model ? { model: seat.model } : {}),
          ...((profile.effort ?? config.effort) ? { effort: (profile.effort ?? config.effort) as SdkOptions["effort"] } : {}),
        } });
        flight.query = query;
        try {
          for await (const raw of query) for (const event of mapSdkMessage(raw)) {
            if (event.kind === "result") {
              const parsed = HandoffDraftSchema.safeParse(event.output);
              if (parsed.success) draft = parsed.data;
              this.#recordUsage(session, seat, `checkpoint:${newId("turn")}`, event);
            } else if (event.kind === "error") failure = event.message;
          }
        } catch (error) { failure = error instanceof Error ? error.message : String(error); }
        finally { flight.query = null; query.close?.(); }
      }
    }
    let degraded = false;
    if (!draft) {
      if (!hard) {
        this.#deps.bus.append({ type: "handoff.checkpoint.failed", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { participant: seat.name, reason: failure ?? "checkpoint produced no valid handoff", threshold, degraded: false } });
        return seat;
      }
      degraded = true;
      const latest = this.#deps.repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, participant: seat.name });
      draft = latest ? { core: { ...latest.core, action: `Recovery checkpoint: ${latest.core.action}`, status: "needs_verification", risk: "high", requestExpandedContext: true }, extension: latest.extension }
        : this.#simpleHandoff("Recover interrupted context", "needs_verification", "No valid model checkpoint was available. Reconstruct state from the task ledger, repository, provider journal, and incoming assignment.", "Verify authoritative state before continuing.");
      this.#deps.bus.append({ type: "handoff.checkpoint.failed", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { participant: seat.name, reason: failure ?? "checkpoint produced no valid handoff", threshold, degraded: true } });
    }
    const prepared = this.#deps.handoffs.prepare({ draft, userSessionId: session.userSessionId, agentSessionId: session.id,
      sender: seat.name, recipient: seat.name, profileId: seat.profileId, generation: seat.generation,
      extensionKind: (seat.profileSnapshot as AgentProfile).handoffExtension,
      trigger: degraded ? "recovery" : "rotation", parentHandoffId: seat.latestHandoffId, checkpoint: true });
    this.#deps.repo.insertCheckpointHandoff(prepared.row);
    this.#deps.handoffs.committed(prepared.record);
    this.#deps.repo.patchParticipant(session.id, seat.name, { sdkSessionId: null, generation: seat.generation + 1, turnCount: 0, contextTokens: 0, latestHandoffId: prepared.row.id, checkpointReady: true });
    const fresh = this.#deps.repo.getParticipant(session.id, seat.name) ?? seat;
    this.#deps.bus.append({ type: "agent_session.context.rotated", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, participant: seat.name, generation: seat.generation + 1,
        reason: seat.contextTokens >= Math.ceil(config.contextTokenLimit * 0.75) ? "token_limit" : "turn_limit", memoryChars: 0,
        handoffId: prepared.row.id, threshold, checkpointBytes: prepared.row.bytes, degraded } });
    this.#deps.bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, participant: seat.name, detail: `checkpoint ${prepared.row.id} completed in ${Date.now() - started}ms` } });
    return fresh;
  }

  #checkpointContext(seat: ParticipantRow): string {
    if (seat.latestHandoffId && this.#deps.handoffs) {
      const handoff = this.#deps.handoffs.get(seat.latestHandoffId);
      return `\n\n## Rotation checkpoint ${handoff.metadata.id}\n${JSON.stringify({ core: handoff.core, extension: handoff.extension }, null, 2)}`;
    }
    return seat.memory ? `\n\n## Read-only legacy context memory\n${seat.memory}` : "";
  }

  #recordNarration(session: AgentSessionRow, participant: string, text: string, turnId: string): void {
    const row = this.#deps.repo.appendMessage({ sessionKind: "agent", sessionId: session.id, speaker: { kind: participant === ORCHESTRATOR_SEAT ? "orchestrator" : "agent", name: participant }, kind: "notice", text, turnId, payload: { channel: "model_output" } });
    this.#deps.bus.append({ type: "agent_session.message", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { agentSessionId: session.id, message: toWireMessage(row) } });
  }

  #recordUsage(session: AgentSessionRow, seat: ParticipantRow, turnId: string, usageEvent: { inputTokens?: number; uncachedInputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; outputTokens?: number; costUsd?: number; modelId?: string; apiDurationMs?: number; sdkDurationMs?: number; stopReason?: string }, status: "completed" | "error" | "aborted" = "completed", durationMs?: number): void {
    const usage = { id: newId("usage"), userSessionId: session.userSessionId, agentSessionId: session.id, participant: seat.name, profileId: seat.profileId,
      generation: seat.generation, turnId, inputTokens: usageEvent.inputTokens ?? 0, uncachedInputTokens: usageEvent.uncachedInputTokens ?? 0,
      cacheCreationInputTokens: usageEvent.cacheCreationInputTokens ?? 0, cacheReadInputTokens: usageEvent.cacheReadInputTokens ?? 0,
      outputTokens: usageEvent.outputTokens ?? 0, costUsd: usageEvent.costUsd ?? null,
      model: usageEvent.modelId ?? seat.model, effort: (seat.profileSnapshot as AgentProfile).effort ?? this.#deps.config?.effort ?? null,
      trigger: "delivery", durationMs: durationMs ?? null, apiDurationMs: usageEvent.apiDurationMs ?? null, sdkDurationMs: usageEvent.sdkDurationMs ?? null, status, stopReason: usageEvent.stopReason ?? null, createdAt: nowIso() };
    this.#deps.repo.insertUsage(usage);
    this.#deps.bus.append({ type: "usage.recorded", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { sessionId: session.id, participant: seat.name, profileId: seat.profileId, generation: seat.generation, turnId,
        inputTokens: usage.inputTokens, uncachedInputTokens: usage.uncachedInputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens, outputTokens: usage.outputTokens, ...(usageEvent.costUsd === undefined ? {} : { costUsd: usageEvent.costUsd }),
        model: usage.model ?? undefined, effort: usage.effort ?? undefined, trigger: "delivery", durationMs: usage.durationMs ?? undefined,
        apiDurationMs: usage.apiDurationMs ?? undefined, sdkDurationMs: usage.sdkDurationMs ?? undefined, status, stopReason: usage.stopReason ?? undefined } });
  }

  #patchDelivery(session: AgentSessionRow, delivery: MailboxDeliveryRow, status: "delivered" | "acknowledged" | "cancelled"): void {
    const now = nowIso();
    this.#deps.repo.patchDelivery(delivery.id, { status, ...(status === "delivered" ? { deliveredAt: now } : {}), ...(status === "acknowledged" ? { acknowledgedAt: now, deliveredAt: delivery.deliveredAt ?? now } : {}) });
    const message = this.#deps.repo.getMessageById(delivery.messageId);
    this.#deps.bus.append({ type: "agent_session.mailbox", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, deliveryId: delivery.id, messageSeq: message?.seq ?? 0, sender: delivery.sender, recipient: delivery.recipient, category: delivery.category, status } });
  }

  #specialists(id: string): ParticipantRow[] { return this.#deps.repo.listParticipants(id).filter((p) => p.role === "agent"); }
  #statusOf(row: AgentSessionRow): "working" | "idle" | "archived" {
    if (row.status === "archived") return "archived";
    return (this.#lanes.get(row.id)?.turns.size ?? 0) > 0 || this.#deps.repo.listQueuedDeliveries(row.id).some((d) => d.recipient !== MAIN_RECIPIENT) ? "working" : "idle";
  }
  #setStatus(id: string, status: "working" | "idle"): void {
    const lane = this.#lane(id); if (lane.lastStatus === status) return;
    if (lane.lastStatus === null && status === "idle") { lane.lastStatus = status; return; }
    lane.lastStatus = status; const session = this.#deps.repo.getAgentSession(id); if (!session) return;
    this.#deps.bus.append({ type: "agent_session.status", userSessionId: session.userSessionId, agentSessionId: id, payload: { agentSessionId: id, status, owedToOrchestrator: false } });
  }
  #recordHostFailure(id: string, error: unknown): void {
    const session = this.#deps.repo.getAgentSession(id); if (!session) return;
    const text = error instanceof Error ? error.message : String(error);
    this.#deps.bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: id, payload: { agentSessionId: id, participant: "system", detail: `scheduler failure: ${text}` } });
  }
}
