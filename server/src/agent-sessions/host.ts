import type { AgentSessionStatus, ConsoleEvent, GetAgentSessionResponse, HandoffDraft, Interaction, PatternId } from "@agentique-console/shared";
import fs from "node:fs";
import { InvalidInputError, ConflictError, NotFoundError } from "../errors.ts";
import type { AgentProfile, AgentProfileRegistry } from "../agent-profiles/registry.ts";
import type { Config } from "../config.ts";
import {
  Repo,
  type AgentSessionRow,
  type MailboxDeliveryRow,
  type MessageRow,
  type AgentRow,
} from "../db/repo.ts";
import { toWireAgentSession, toWireMessage } from "../api/wire.ts";
import type { ArtifactStore } from "../events/artifact-store.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";
import type { SqliteSessionStore } from "../sdk/session-store.ts";
import type { ConsoleSdk } from "../sdk/types.ts";
import type { ProcessManager } from "../runtime/process-manager.ts";
import type { BrowserManager } from "../runtime/browser-manager.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import type { DecisionLedger } from "../orchestrator/decisions.ts";
import type { InteractionService } from "../orchestrator/interactions.ts";
import type { AssignmentScheduler } from "../tasks/scheduler.ts";
import type { TaskService } from "../tasks/service.ts";
import type { HandoffService } from "../handoffs/service.ts";
import type { ReapResult } from "../completion/summary.ts";
import { CHILD_SENDER_PREFIX, CONSOLE_SENDER, MAIN_RECIPIENT, COORDINATOR_AGENT } from "./names.ts";
import type { Category } from "./final-gate.ts";
import { PromptComposer } from "./composer.ts";
import { roleOfAgent, speakerKindOf, RESERVED_NAMES, AGENT_NAME_RE } from "./topology.ts";
import { SessionRouting } from "./routing.ts";
import { WorktreeBinding } from "./worktree-binding.ts";
import { OperatorSurface } from "./operator.ts";
import { Mailroom, MATERIAL_CATEGORIES, identitySelector, simpleHandoff } from "./mailroom.ts";
import { AgentLanePool, type ActiveTurn, type AgentLane } from "./lanes.ts";
import { AgentRuntime } from "./runtime.ts";
import type { TransferInput } from "./seams.ts";
import { dispatchWorkItems, onPatternPost, sweep as patternSweep, type DispatchWorkItemsInput, type PatternContext } from "./patterns/engine.ts";
import { buildContract } from "./patterns/catalog.ts";

export { WithheldFinalError } from "./final-gate.ts";


export interface CreateAgentSessionInput {
  userSessionId: string;
  title: string;
  /**
   * Orchestration pattern; omitted = hub_and_spoke. Agent sessions have no
   * mode/phase of their own: agents always execute; operator-level plan mode
   * lives on the USER session.
   */
  pattern?: PatternId;
  /** Pattern-specific config, validated by the pattern's builder. */
  patternConfig?: Record<string, unknown>;
  /**
   * Set when a controller agent spawns this as a CHILD session. The child's
   * "main" traffic then crosses to `controllerAgent` in the parent instead of
   * waking the runner. One level only — children never get the spawn grant.
   */
  parent?: { agentSessionId: string; controllerAgent: string };
  agents: { name: string; profileId?: string; instructions?: string; model?: string; owns?: string[] }[];
  briefing?: HandoffDraft;
}

export interface AgentSessionServiceDeps {
  repo: Repo;
  bus: EventBus;
  artifacts: ArtifactStore;
  /** Required — every knob's default lives in `loadConfig`, nowhere else. */
  config: Config;
  profiles: AgentProfileRegistry;
  sdk: () => Promise<ConsoleSdk>;
  sessionStore: SqliteSessionStore;
  getWorkspaceRoot: (workspaceId: string) => string;
  wake: (userSessionId: string, agentSessionId: string, category: Category, text: string) => void;
  /** OS capabilities. `null` = absent, stated at the construction site. */
  processes: ProcessManager | null;
  browsers: BrowserManager | null;
  interactions: InteractionService;
  /**
   * What the operator has decided. Read into every agent's prompt and into
   * checkpoint reconstruction, so a decision made once is known by every agent
   * and every later generation. Required: an optional dep would let a missing
   * wire typecheck.
   */
  decisions: DecisionLedger;
  tasks: TaskService;
  handoffs: HandoffService;
  /** Lazy — the scheduler posts through this host, so it is composed after it. */
  scheduler: () => AssignmentScheduler;
  worktrees: WorktreeManager | null;
}

/** Console-managed, independently resumable participant sessions and durable mailbox. */
export class AgentSessionService {
  readonly #deps: AgentSessionServiceDeps;
  readonly #composer: PromptComposer;
  readonly #routing: SessionRouting;
  readonly #worktreeBinding: WorktreeBinding;
  readonly #operator: OperatorSurface;
  readonly #mailroom: Mailroom;
  /** Seat-lane ownership and capacity; also the LaneActivity implementation. */
  readonly #lanes: AgentLanePool;
  /** Pump/watchdog/mint/settle over pool lanes; the mailroom's Injector. */
  readonly #runtime: AgentRuntime;

  constructor(deps: AgentSessionServiceDeps) {
    this.#deps = deps;
    this.#routing = new SessionRouting({ repo: deps.repo });
    this.#lanes = new AgentLanePool({
      config: deps.config,
      hasQueuedWork: (agentSessionId, seat) => deps.repo.listUnackedDeliveries(agentSessionId, seat).length > 0,
      reapRuntime: (agentSessionId, seatName, reason) => {
        const killed = deps.processes?.stopAgent(agentSessionId, seatName) ?? [];
        void deps.browsers?.closeAgent(`${agentSessionId}:${seatName}`).catch(() => undefined);
        const session = deps.repo.getAgentSession(agentSessionId);
        if (session) {
          // Name what was reaped.
          const reaped = killed.length === 0 ? "" : `; reaped ${killed.length} process(es): ${killed.map((p) => `${p.processId}${p.pid === undefined ? "" : ` (pid ${p.pid})`}`).join(", ")}`;
          deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId,
            payload: { agentSessionId, agent: seatName, detail: `agent parked (${reason}); provider session retained${reaped}` } });
        }
      },
      sessionTree: (agentSessionId) => {
        const row = deps.repo.getAgentSession(agentSessionId);
        const rootId = row?.parentAgentSessionId ?? agentSessionId;
        const ids = new Set([rootId]);
        for (const child of deps.repo.listChildSessions(rootId)) ids.add(child.id);
        return ids;
      },
    });
    this.#worktreeBinding = new WorktreeBinding({
      repo: deps.repo, bus: deps.bus, artifacts: deps.artifacts, config: deps.config,
      worktrees: deps.worktrees, getWorkspaceRoot: deps.getWorkspaceRoot,
      escalationTarget: (session, agentName) => this.#routing.escalationTarget(session, agentName),
      transfer: (input) => this.post(input),
      simpleHandoff,
    });
    this.#composer = new PromptComposer({
      repo: deps.repo, bus: deps.bus, config: deps.config, handoffs: deps.handoffs,
      decisions: deps.decisions, tasks: deps.tasks, interactions: deps.interactions,
      worktrees: deps.worktrees,
      laneState: (agentSessionId, agent) => {
        const lane = this.#lanes.peek(agentSessionId, agent);
        return lane ? { activeTurn: lane.activeTurn !== null, live: lane.state === "live" } : null;
      },
    });
    this.#operator = new OperatorSurface({
      repo: deps.repo, bus: deps.bus, config: deps.config, interactions: deps.interactions,
      routing: this.#routing,
      lanes: this.#lanes,
      transfer: (input) => this.post(input),
      simpleHandoff,
      deliver: (agentSessionId, recipient) => this.#mailroom.deliver(agentSessionId, recipient),
      maybeReleaseParentFinal: (parent) => this.#maybeReleaseParentFinal(parent),
      recordFailure: (agentSessionId, error) => this.#recordHostFailure(agentSessionId, error),
      sweepTasks: [() => {
        // The quiet-time stall lives here — it can trip while every lane is
        // quiet, which is exactly when it matters.
        for (const session of this.#deps.repo.listOpenAgentSessions()) {
          try { patternSweep(this.#patternCtx(), session); } catch (error) { this.#recordHostFailure(session.id, error); }
        }
      }],
    });
    this.#runtime = new AgentRuntime({
      repo: deps.repo, bus: deps.bus, config: deps.config,
      sdk: deps.sdk, sessionStore: deps.sessionStore, getWorkspaceRoot: deps.getWorkspaceRoot,
      artifacts: deps.artifacts, tasks: deps.tasks, handoffs: deps.handoffs,
      processes: deps.processes, browsers: deps.browsers, worktrees: deps.worktrees,
      scheduler: deps.scheduler,
      lanes: this.#lanes, worktree: this.#worktreeBinding, routing: this.#routing, composer: this.#composer,
      transfer: (input) => this.post(input),
      askOperator: (session, seat, args) => this.#operator.askOperator(session, seat, args),
      createChildSession: (session, controller, input) => this.createSession({
        userSessionId: session.userSessionId, title: input.title,
        pattern: input.pattern as PatternId,
        ...(input.patternConfig ? { patternConfig: input.patternConfig } : {}),
        parent: { agentSessionId: session.id, controllerAgent: controller.name },
        agents: input.agents, briefing: input.briefing,
      }),
      abandonChildSession: (session, controller, childAgentSessionId, reason) =>
        this.abandonChildSession(session.id, controller.name, childAgentSessionId, reason),
      dispatchWorkItems: (dispatcherAgent, input) => this.dispatchWorkItems(dispatcherAgent, input),
      markWorking: (agentSessionId) => this.#operator.setStatus(agentSessionId, "working"),
      hooks: {
        patchDelivery: (session, delivery, status) => this.#mailroom.patchDelivery(session, delivery, status),
        deliver: (agentSessionId, recipient) => this.#mailroom.deliver(agentSessionId, recipient),
        escalateFailure: (session, seatName, seat, turn, reason) => this.#escalateFailure(session, seatName, seat, turn, reason),
        carryReport: (session, seatName, turn) => this.#carryReport(session, seatName, turn),
        turnBudgetNotice: (session, seat, turn, spentTurns) => this.#turnBudgetNotice(session, seat, turn, spentTurns),
        refreshStatus: (agentSessionId) => this.#operator.refreshStatus(agentSessionId),
        recordFailure: (agentSessionId, error) => this.#recordHostFailure(agentSessionId, error),
      },
    });
    this.#mailroom = new Mailroom({
      repo: deps.repo, bus: deps.bus, config: deps.config, interactions: deps.interactions,
      decisions: deps.decisions, tasks: deps.tasks, handoffs: deps.handoffs, scheduler: deps.scheduler,
      wake: deps.wake,
      routing: this.#routing, worktree: this.#worktreeBinding, composer: this.#composer,
      lanes: this.#lanes,
      selector: identitySelector,
      ensureLive: (agentSessionId, seat) => this.ensureSeatLive(agentSessionId, seat),
      injector: this.#runtime,
      sessionStatus: (row) => this.#operator.statusOf(row),
      boundary: {
        crossBoundary: (child, message, draft, category) => this.#crossBoundary(child, message, draft, category),
        maybeReleaseParentFinal: (parent) => this.#maybeReleaseParentFinal(parent),
      },
      onPatternPost: (session, hop) => onPatternPost(this.#patternCtx(), session, hop),
      recordFailure: (agentSessionId, error) => this.#recordHostFailure(agentSessionId, error),
    });
  }

  createSession(input: CreateAgentSessionInput): { agentSessionId: string; agents: string[]; entryAgent: string; coordinatorName?: string } {
    const { repo, bus } = this.#deps;
    const user = repo.getUserSession(input.userSessionId);
    if (!user) throw new NotFoundError(`no user session ${input.userSessionId}`);
    // The pattern builder owns roster bounds, role assignment, prompts and
    // wiring; the host only executes what comes out.
    const build = buildContract(input.pattern ?? "hub_and_spoke", {
      agents: input.agents, config: input.patternConfig,
      resolveProfile: (id) => this.#profile(id, user.workspaceId),
    });
    let parentRow: AgentSessionRow | null = null;
    if (input.parent) {
      parentRow = repo.getAgentSession(input.parent.agentSessionId) ?? null;
      if (!parentRow || parentRow.lifecycle !== "open") throw new InvalidInputError(`parent session ${input.parent.agentSessionId} is not open`);
      if (parentRow.parentAgentSessionId !== null) throw new InvalidInputError("a child session cannot spawn children of its own — one level of nesting only");
      if (parentRow.userSessionId !== input.userSessionId) throw new InvalidInputError("a child session belongs to its parent's run");
      const openChildren = repo.listChildSessions(parentRow.id).filter((child) => child.lifecycle === "open");
      if (openChildren.length >= this.#deps.config.policy.maxChildSessionsPerParent) {
        throw new InvalidInputError(`parent already has ${openChildren.length} open child session(s); finish or abandon one first (cap ${this.#deps.config.policy.maxChildSessionsPerParent})`);
      }
    }
    const names = new Set<string>();
    for (const agent of input.agents) {
      if (!AGENT_NAME_RE.test(agent.name) || RESERVED_NAMES.has(agent.name.toLowerCase()) || agent.name.toLowerCase().startsWith(CHILD_SENDER_PREFIX)) throw new InvalidInputError(`invalid or reserved agent name \"${agent.name}\"`);
      if (names.has(agent.name)) throw new InvalidInputError(`duplicate agent name \"${agent.name}\"`);
      names.add(agent.name);
    }
    // Ownership is mandatory for an agent that WRITES, and optional for one
    // that does not. Deliberately NOT symmetric: a read-only agent may still
    // declare a scope, because `owns` doubles as the assignment/review
    // boundary for agents that never write.
    for (const agent of input.agents) {
      const profile = this.#profile(agent.profileId ?? "explorer", user.workspaceId);
      const writes = profile.tools.includes("Edit") || profile.tools.includes("Write");
      if (writes && (agent.owns ?? []).filter((scope) => scope.trim() !== "").length === 0) {
        throw new InvalidInputError(`agent "${agent.name}" (${profile.id}) writes files, so it must declare what it owns`);
      }
    }
    const ownedScopes = new Map<string, string>();
    if (parentRow) {
      // Cross-tree disjointness: parent-tree agents and this child's agents
      // all merge worktrees into ONE workspace, so their write scopes must not
      // collide any more than sibling agents' may.
      const treeSessions = [parentRow, ...repo.listChildSessions(parentRow.id).filter((child) => child.lifecycle === "open")];
      for (const treeSession of treeSessions) {
        for (const seat of repo.listAgents(treeSession.id)) {
          if ((seat.profileSnapshot as AgentProfile | undefined)?.exemptFromOwnership === true) continue;
          for (const scope of seat.ownership) {
            const normalized = scope.trim(); if (!normalized) continue;
            ownedScopes.set(normalized, `${seat.name} (in ${treeSession.id})`);
          }
        }
      }
    }
    for (const agent of input.agents) {
      if (this.#profile(agent.profileId ?? "explorer", user.workspaceId).exemptFromOwnership) continue;
      for (const scope of agent.owns ?? []) {
        const normalized = scope.trim(); if (!normalized) continue;
        const owner = ownedScopes.get(normalized);
        if (owner) throw new InvalidInputError(`ownership scope \"${normalized}\" is assigned to both ${owner} and ${agent.name}`);
        ownedScopes.set(normalized, agent.name);
      }
    }
    // Worktree isolation needs a repository; ensured at session creation, not
    // lazily at agent spawn.
    this.#worktreeBinding.ensureWorkspaceRepo(user.workspaceId, input.userSessionId);
    const title = input.title.trim();
    if (!title) throw new InvalidInputError("a session title is required");
    const parent = repo.getUserSession(input.userSessionId);
    if (!parent) throw new InvalidInputError("unknown user session");
    // The run's baseline for "what was built": HEAD at the first delegation.
    // The Run Summary diffs the working tree against this.
    if (parent.runBaseCommit === null && this.#deps.worktrees && this.#deps.getWorkspaceRoot) {
      try {
        const root = this.#deps.getWorkspaceRoot(user.workspaceId);
        repo.patchUserSession(input.userSessionId, { runBaseCommit: this.#deps.worktrees.headCommit(root) });
      } catch { /* not a repo — the summary falls back to handoff claims */ }
    }
    const now = nowIso();
    const contract = build.contract;
    const row: AgentSessionRow = {
      id: newId("as"), userSessionId: input.userSessionId, title,
      lifecycle: "open", createdAt: now, updatedAt: now,
      pattern: contract.pattern, topology: contract as unknown as Record<string, unknown>,
      parentAgentSessionId: parentRow?.id ?? null,
      parentControllerAgent: parentRow ? input.parent!.controllerAgent : null,
      depth: parentRow ? 1 : 0,
    };
    repo.insertAgentSession(row);
    if (parentRow) {
      bus.append({ type: "agent_session.child.spawned", userSessionId: row.userSessionId, agentSessionId: parentRow.id,
        payload: { agentSessionId: parentRow.id, childAgentSessionId: row.id, pattern: row.pattern,
          byAgent: input.parent!.controllerAgent, title } });
    }
    for (const plan of build.agents) {
      const profile = this.#runtime.snapshotProfile(this.#profile(plan.profileId, parent.workspaceId));
      repo.insertAgent(this.#agentRow(row.id, plan.name, plan.role, profile, plan.instructions ?? "", plan.model, plan.owns, plan.ord, now));
    }
    const specialists = input.agents.map((agent) => agent.name);
    bus.append({ type: "agent_session.created", userSessionId: row.userSessionId, agentSessionId: row.id,
      payload: { session: toWireAgentSession(row, specialists, false), agents: specialists } });
    bus.append({ type: "agent_session.delegation.sent", userSessionId: row.userSessionId, agentSessionId: row.id,
      payload: { userSessionId: row.userSessionId, agentSessionId: row.id, kind: "created", preview: title } });
    const entry = this.#routing.contractOf(row).contract.entry;
    const entrySeats = this.#routing.agentsOfRole(row.id, entry.role);
    if (input.briefing) {
      for (const seat of entry.broadcast ? entrySeats : entrySeats.slice(0, 1)) {
        this.post({ agentSessionId: row.id, speaker: { kind: "orchestrator", name: MAIN_RECIPIENT }, to: seat.name, handoff: input.briefing, category: "assignment" });
      }
    }
    return { agentSessionId: row.id, agents: specialists, entryAgent: entrySeats[0]?.name ?? COORDINATOR_AGENT,
      ...(build.coordinatorName !== undefined ? { coordinatorName: build.coordinatorName } : {}) };
  }

  /** The agent main steers: the contract entry role's first agent. */
  entryAgent(agentSessionId: string): string {
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (!session) throw new NotFoundError(`no agent session ${agentSessionId}`);
    const entry = this.#routing.contractOf(session).contract.entry;
    return this.#routing.agentsOfRole(agentSessionId, entry.role)[0]?.name ?? COORDINATOR_AGENT;
  }

  /** The ONE transfer path — `Mailroom.post`; kept public as the facade every service and tool posts through. */
  post(input: TransferInput): MessageRow {
    return this.#mailroom.post(input);
  }

  readSession(input: { agentSessionId: string; afterSeq?: number; limit?: number }) {
    const session = this.#deps.repo.getAgentSession(input.agentSessionId);
    if (!session) throw new NotFoundError(`no agent session ${input.agentSessionId}`);
    let rows = this.#deps.repo.listMessages("agent", session.id, input.afterSeq ?? 0);
    if (input.limit !== undefined) rows = rows.slice(-input.limit);
    return { status: this.#operator.statusOf(session),
      agents: this.#specialists(session.id).map((p) => ({ name: p.name, profileId: p.profileId, model: p.model })),
      messages: rows.map(toWireMessage) };
  }

  listForUserSession(userSessionId: string) {
    return this.#deps.repo.listAgentSessions(userSessionId).map((row) => ({
      id: row.id, title: row.title, status: this.#operator.statusOf(row),
      agents: this.#specialists(row.id).map((p) => p.name),
      unseenCount: this.#deps.repo.listQueuedDeliveries(row.id).filter((d) => d.recipient === MAIN_RECIPIENT).length,
      updatedAt: row.updatedAt,
    }));
  }

  wireSession(row: AgentSessionRow) { return toWireAgentSession(row, this.#specialists(row.id).map((p) => p.name), this.#operator.statusOf(row) === "working"); }

  wireSessionsForUserSession(userSessionId: string) {
    return this.#deps.repo.listAgentSessions(userSessionId).map((row) => this.wireSession(row));
  }

  /** The session detail view: wire session + per-agent run stats + messages. */
  detail(agentSessionId: string): GetAgentSessionResponse {
    const row = this.#deps.repo.getAgentSession(agentSessionId);
    if (!row) throw new NotFoundError(`no agent session ${agentSessionId}`);
    return {
      session: this.wireSession(row),
      runs: this.#deps.repo.listAgents(row.id).map((agent) => ({
        agent: agent.name,
        profileId: agent.profileId,
        profile: agent.profileSnapshot,
        ownership: agent.ownership,
        generation: agent.generation,
        turnCount: agent.turnCount,
        contextTokens: agent.contextTokens,
        providerSessionId: agent.sdkSessionId,
      })),
      messages: this.#deps.repo.listMessages("agent", row.id).map(toWireMessage),
    };
  }

  async transcript(agentSessionId: string): Promise<ConsoleEvent[]> {
    const row = this.#deps.repo.getAgentSession(agentSessionId);
    if (!row) throw new NotFoundError(`no agent session ${agentSessionId}`);
    const events: ConsoleEvent[] = [];
    for await (const event of this.#deps.bus.readWithSeq({ agentSessionId: row.id })) {
      events.push(event);
    }
    return events;
  }

  /** Whole-session stop (archive/shutdown): every lane closes hard. */
  interrupt(agentSessionId: string): void {
    this.#lanes.closeAllForSession(agentSessionId);
  }

  /** Scoped stop: abort one specialist's in-flight turn (`AgentRuntime.interruptAgent`). */
  interruptAgent(agentSessionId: string, agent: string, reason: string): void {
    this.#runtime.interruptAgent(agentSessionId, agent, reason);
  }

  async closeAll(): Promise<void> {
    await this.#lanes.closeAll();
  }

  /**
   * Release every runtime resource this run holds, WITHOUT archiving anything
   * and WITHOUT touching worktrees. It stops short of archival because the
   * operator may ask for changes: agents respawn lazily over their retained
   * provider sessions, and a worktree destroyed here could not be merged
   * afterwards. Returns what it killed, so the summary can state it.
   */
  reapForUserSession(userSessionId: string): ReapResult {
    const processes: ReapResult["processes"] = [];
    let browsers = 0;
    for (const session of this.#deps.repo.listAgentSessions(userSessionId)) {
      if (session.lifecycle !== "open") continue;
      for (const seat of this.#deps.repo.listAgents(session.id)) {
        for (const killed of this.#deps.processes?.stopAgent(session.id, seat.name) ?? []) {
          processes.push({ agentSessionId: session.id, agent: seat.name, processId: killed.processId, pid: killed.pid });
        }
        void this.#deps.browsers?.closeAgent(`${session.id}:${seat.name}`)
          .then((closed) => { if (closed) browsers += 1; })
          .catch(() => undefined);
      }
    }
    // Processes the JOURNAL says are still running: started with no matching
    // exit. Counted separately from what we just killed, because a non-zero
    // figure here means something outlived its own bookkeeping.
    const started = new Map<string, string>();
    for (const event of this.#deps.repo.listProcessEvents(userSessionId)) {
      if (event.type === "agent_session.process.started") started.set(event.processId, event.processId);
      if (event.type === "agent_session.process.exited") started.delete(event.processId);
    }
    return { processes, browsers, leakedBefore: started.size };
  }

  archiveForUserSession(userSessionId: string): void {
    this.reapForUserSession(userSessionId);
    // Children first (they sort newer), so a child's cancelled deliveries can
    // never race its parent's teardown. Children share the userSessionId, so
    // the flat list covers the whole tree by construction.
    const open = this.#deps.repo.listAgentSessions(userSessionId)
      .filter((session) => session.lifecycle === "open")
      .sort((a, b) => b.depth - a.depth);
    for (const session of open) this.#archiveOne(session);
  }

  #archiveOne(session: AgentSessionRow): void {
    this.interrupt(session.id);
    this.#deps.processes?.stopSession(session.id);
    void this.#deps.browsers?.closeSession(session.id);
    this.#worktreeBinding.removeForSession(session);
    for (const delivery of this.#deps.repo.listActiveDeliveries(session.id)) this.#mailroom.patchDelivery(session, delivery, "cancelled");
    this.#deps.repo.patchAgentSession(session.id, { lifecycle: "archived" });
    this.#forget(session.id);
    this.#deps.bus.append({ type: "agent_session.status.changed", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, status: "archived" } });
  }

  /** The ONE cleanup point for every per-session in-memory structure. */
  #forget(agentSessionId: string): void {
    this.#lanes.forget(agentSessionId);
    this.#operator.forget(agentSessionId);
    this.#routing.forget(agentSessionId);
  }

  /**
   * Boot sweep: children whose parent is archived or gone can never report to
   * anyone.
   */
  archiveOrphanChildren(): number {
    let archived = 0;
    for (const session of this.#deps.repo.listOpenAgentSessions()) {
      if (session.parentAgentSessionId === null) continue;
      const parent = this.#deps.repo.getAgentSession(session.parentAgentSessionId);
      if (parent && parent.lifecycle === "open") continue;
      this.#archiveOne(session);
      archived += 1;
      this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: "system", detail: "archived: parent session is no longer open" } });
    }
    return archived;
  }

  /**
   * The escape hatch for a wedged child: archive it and hand the parent's
   * controller a console failure so the tree can still conclude.
   */
  abandonChildSession(parentAgentSessionId: string, controllerAgent: string, childAgentSessionId: string, reason: string): void {
    const child = this.#deps.repo.getAgentSession(childAgentSessionId);
    if (!child || child.parentAgentSessionId !== parentAgentSessionId) {
      throw new InvalidInputError(`${childAgentSessionId} is not a child of this session`);
    }
    if (child.lifecycle === "open") this.#archiveOne(child);
    const parent = this.#deps.repo.getAgentSession(parentAgentSessionId);
    if (!parent || parent.lifecycle !== "open") return;
    try {
      this.post({ agentSessionId: parent.id, speaker: { kind: "agent", name: `${CHILD_SENDER_PREFIX}${child.id}` },
        to: child.parentControllerAgent ?? controllerAgent, category: "failure", dedupeKey: `child-abandoned:${child.id}`,
        handoff: simpleHandoff(`Child session "${child.title}" abandoned`, "failed",
          `Abandoned by ${controllerAgent}: ${reason}. Whatever the child journaled is retrievable with read_handoff; nothing further will arrive from it.`,
          "Account for the abandoned work in your plan and your final report.") });
    } catch (error) { this.#recordHostFailure(parent.id, error); }
    this.#deps.bus.append({ type: "agent_session.child.reported", userSessionId: child.userSessionId, agentSessionId: parentAgentSessionId,
      payload: { agentSessionId: parentAgentSessionId, childAgentSessionId: child.id, status: "failed", handoffId: "" } });
    if (parent) this.#maybeReleaseParentFinal(parent);
  }

  onStatusChanged(handler: (userSessionId: string) => void): void {
    this.#operator.onStatusChanged(handler);
  }

  startGovernanceSweep(intervalMs?: number): void {
    if (intervalMs === undefined) this.#operator.startGovernanceSweep();
    else this.#operator.startGovernanceSweep(intervalMs);
  }

  stopGovernanceSweep(): void {
    this.#operator.stopGovernanceSweep();
  }

  deliverOperatorAnswer(interaction: Interaction): void {
    this.#operator.deliverOperatorAnswer(interaction);
  }


  /** The bound context patterns/engine.ts runs over. */
  #patternCtx(): PatternContext {
    return {
      deps: { repo: this.#deps.repo, bus: this.#deps.bus, config: this.#deps.config },
      contract: (session) => this.#routing.contractOf(session).contract,
      completionSeat: (session, which) => this.#routing.completionAgent(session, which),
      post: (input) => this.post(input),
      simpleHandoff,
      deliverNow: (agentSessionId, recipient) => void this.#mailroom.deliver(agentSessionId, recipient).catch((error) => this.#recordHostFailure(agentSessionId, error)),
      hasActivity: (agentSessionId) => this.#lanes.namesWithActiveTurn(agentSessionId).length > 0,
      sessionReported: (session) => this.#operator.statusOf(session) === "reported",
      profile: (id, workspaceId) => this.#profile(id, workspaceId),
      snapshotProfile: (profile) => this.#runtime.snapshotProfile(profile),
      agent: (agentSessionId, name, role, profile, extra, model, ownership, ord, createdAt) =>
        this.#agentRow(agentSessionId, name, role, profile, extra, model, ownership, ord, createdAt),
    };
  }

  /** map_reduce fan-out; the machinery lives in patterns/engine.ts. */
  dispatchWorkItems(dispatcherAgent: string, input: DispatchWorkItemsInput): { joinId: string; agents: string[] } {
    const session = this.#deps.repo.getAgentSession(input.agentSessionId);
    if (!session) throw new NotFoundError(`no agent session ${input.agentSessionId}`);
    const dispatcher = this.#deps.repo.getAgent(session.id, dispatcherAgent);
    if (!dispatcher) throw new NotFoundError(`no agent ${dispatcherAgent} in ${input.agentSessionId}`);
    return dispatchWorkItems(this.#patternCtx(), session, dispatcher, input);
  }

  onBlockingQuestionsCleared(userSessionId: string, agentSessionId: string): void {
    this.#operator.onBlockingQuestionsCleared(userSessionId, agentSessionId);
  }

  /**
   * A child's material report crosses into its parent as a journaled handoff
   * to the parent's controller — verbatim core and extension, a state-summary
   * preamble naming the child, and the child final downgraded to a parent
   * MILESTONE (a child finishing is a milestone of the parent's work; keeping
   * `isFinalToMain` false on the boundary keeps the parent's final gate
   * honest). Uncertainty was already classified child-side, so the boundary
   * hop never re-promotes it. Idempotent by dedupe key across restarts.
   */
  #crossBoundary(child: AgentSessionRow, message: MessageRow, draft: HandoffDraft, category: Category): void {
    const parent = child.parentAgentSessionId === null ? undefined : this.#deps.repo.getAgentSession(child.parentAgentSessionId);
    if (!parent || parent.lifecycle !== "open" || child.parentControllerAgent === null) return;
    const mapped: Category = category === "final" ? "milestone" : category === "failure" ? "failure" : "update";
    const handoffId = (message.payload?.handoff as { id?: string } | undefined)?.id ?? message.id;
    const boundaryDraft: HandoffDraft = {
      core: { ...draft.core, state: { ...draft.core.state,
        summary: `Child session "${child.title}" (${child.id}) reports:\n${draft.core.state.summary}` } },
      extension: draft.extension,
    };
    try {
      this.post({ agentSessionId: parent.id, speaker: { kind: "agent", name: `${CHILD_SENDER_PREFIX}${child.id}` },
        to: child.parentControllerAgent, handoff: boundaryDraft, category: mapped, dedupeKey: `child:${handoffId}` });
      if (category === "final" || category === "failure") {
        this.#deps.bus.append({ type: "agent_session.child.reported", userSessionId: parent.userSessionId, agentSessionId: parent.id,
          payload: { agentSessionId: parent.id, childAgentSessionId: child.id,
            status: category === "final" ? "completed" : "failed", handoffId } });
      }
    } catch (error) { this.#recordHostFailure(child.id, error); }
  }

  /** The child-hold counterpart of onBlockingQuestionsCleared. */
  #maybeReleaseParentFinal(parent: AgentSessionRow): void {
    if (!this.#operator.finalWithheld(parent)) return;
    const unsettled = this.#deps.repo.listChildSessions(parent.id)
      .filter((child) => child.lifecycle === "open" && this.#operator.statusOf(child) !== "reported");
    if (unsettled.length > 0) return;
    const finalSeat = this.#routing.completionAgent(parent, "finalFrom");
    try {
      this.post({ agentSessionId: parent.id, speaker: { kind: "system", name: CONSOLE_SENDER }, to: finalSeat,
        handoff: simpleHandoff("All child sessions have reported", "in_progress",
          "Every child session's final has crossed into this session. The withheld final may be sent now.",
          "Compile and send your final report."),
        category: "decision", dedupeKey: `children-clear:${parent.id}` });
    } catch { /* best effort — the next final attempt re-evaluates the gate */ }
  }

  /** Boot replay of a crash between a child's journal write and its boundary ack. */
  #redriveChildBoundary(session: AgentSessionRow, delivery: MailboxDeliveryRow): void {
    try {
      const message = this.#deps.repo.getMessageById(delivery.messageId);
      const summary = message?.payload?.handoff as { id?: string } | undefined;
      if (!message) return;
      if (summary?.id && this.#deps.handoffs && MATERIAL_CATEGORIES.has(delivery.category)) {
        const record = this.#deps.handoffs.get(summary.id);
        this.#crossBoundary(session, message, { core: record.core, extension: record.extension }, delivery.category);
      }
      this.#mailroom.patchDelivery(session, delivery, "acknowledged");
      const parent = session.parentAgentSessionId === null ? undefined : this.#deps.repo.getAgentSession(session.parentAgentSessionId);
      if (parent && parent.lifecycle === "open") this.#maybeReleaseParentFinal(parent);
    } catch (error) { this.#recordHostFailure(session.id, error); }
  }

  boot(): void {
    const wakes = new Set<string>();
    for (const delivery of this.#deps.repo.listQueuedDeliveries()) {
      if (delivery.recipient === MAIN_RECIPIENT) {
        const session = this.#deps.repo.getAgentSession(delivery.agentSessionId);
        if (session && session.lifecycle === "open" && session.parentAgentSessionId !== null) this.#redriveChildBoundary(session, delivery);
        continue;
      }
      wakes.add(`${delivery.agentSessionId} ${delivery.recipient}`);
    }
    for (const key of wakes) {
      const [agentSessionId, recipient] = key.split(" ") as [string, string];
      void this.#mailroom.deliver(agentSessionId, recipient).catch((error) => this.#recordHostFailure(agentSessionId, error));
    }
  }

  profiles(workspaceId?: string): AgentProfile[] { return this.#deps.profiles?.list(workspaceId) ?? []; }
  runtimeAvailability(): { sandbox: boolean; chrome: boolean } {
    return { sandbox: fs.existsSync("/usr/bin/bwrap") || fs.existsSync("/usr/local/bin/bwrap"), chrome: fs.existsSync("/usr/bin/google-chrome") };
  }

  #agentRow(agentSessionId: string, name: string, role: string, profile: AgentProfile, extra: string, model: string | undefined, ownership: string[], ord: number, createdAt: string): AgentRow {
    const instructions = [profile.instructions, extra.trim()].filter(Boolean).join("\n\nAssigned role context:\n");
    return { agentSessionId, name, role, instructions, model: model ?? profile.model ?? null,
      profileId: profile.id, profileSnapshot: profile, ownership, sdkSessionId: null, lastActiveAt: null,
      generation: 0, turnCount: 0,
      contextTokens: 0, latestHandoffId: null,
      cumulativeCostUsd: 0, cumulativeApiDurationMs: 0, lastDecisionAt: null,
      worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null,
      ord, createdAt };
  }

  #profile(id: string, workspaceId?: string): AgentProfile {
    if (this.#deps.profiles) return this.#deps.profiles.get(id, workspaceId);
    return { id, title: id, purpose: id, instructions: `You are the ${id} specialist.`, tools: ["Read", "Glob", "Grep"], permissionMode: "default", exemptFromOwnership: false, maxTurns: 30, sandboxRequired: true, runtime: { shell: false, browser: false, screenshots: false, network: [] } };
  }

  /**
   * When an agent completes a turn without sending, while its current
   * assignment still lacks a terminal report from it, the Console carries the
   * turn's final text to its collector as a completed report — in EVERY
   * pattern (specialist→coordinator, stage→next stage, debater→judge,
   * mapper→reducer). An explicit send supersedes this (`sawSend`); an agent
   * with an open operator question keeps its silence — the answer's delivery
   * gives it another turn to report from. Coordinator-role agents are exempt:
   * they legitimately settle many quiet turns mid-orchestration, and their
   * own silence is the operator-debt discharge's job.
   */
  #carryReport(session: AgentSessionRow, seatName: string, turn: ActiveTurn): void {
    const seat = this.#deps.repo.getAgent(session.id, seatName);
    if (!seat || seat.role === "coordinator") return;
    const text = turn.lastNarration.trim();
    if (text === "") return;
    const assignment = this.#deps.repo.latestAssignmentDelivery(session.id, seatName);
    if (!assignment) return;
    const assignmentSeq = this.#deps.repo.getMessageById(assignment.messageId)?.seq ?? 0;
    const reported = this.#deps.repo.listMessages("agent", session.id).some((row) =>
      row.speakerName === seatName && row.seq > assignmentSeq
      && ["completed", "failed"].includes((row.payload?.handoff as { status?: string } | undefined)?.status ?? ""));
    if (reported) return;
    const collector = this.#routing.relayCollector(session, roleOfAgent(seat), seatName);
    if (collector === null) return;
    if (this.#deps.interactions.listUnresolvedForAgentSession(session.id).some((row) => row.agent === seatName)) return;
    this.post({ agentSessionId: session.id, speaker: { kind: "agent", name: seatName }, to: collector,
      handoff: simpleHandoff(`Report relayed by the Console from ${seatName}'s settled turn (the agent ended it without send_handoff)`, "completed", text, null),
      category: "update", turnId: turn.turnId });
  }

  /**
   * A dead turn must hand its successor real state: `#reconstructCheckpoint`
   * assembles what the console owns (ownership, task ledger, worktree diff,
   * current assignment, last report), with the error and any salvaged
   * narration spliced on top.
   */
  #escalateFailure(session: AgentSessionRow, seatName: string, seat: AgentRow | undefined, turn: ActiveTurn, reason: string): void {
    const target = this.#routing.escalationTarget(session, seatName);
    const salvaged = turn.lastNarration.trim();
    let draft: HandoffDraft;
    try {
      const reconstructed = seat ? this.#composer.reconstructCheckpoint(session, seat) : null;
      draft = reconstructed
        ? { core: { ...reconstructed.core, status: "failed", risk: "high", action: "Turn failed",
            state: { ...reconstructed.core.state,
              summary: `${reason}\n\nState the Console can vouch for:\n${reconstructed.core.state.summary}${salvaged === "" ? "" : `\n\nUnsent work from ${seatName}'s last output (unverified — it never passed through a handoff):\n${salvaged.slice(0, 8_000)}`}` },
            nextAction: "Inspect the failure and retry or reassign." },
            ...(reconstructed.extension ? { extension: reconstructed.extension } : {}) }
        : simpleHandoff("Turn failed", "failed", reason, "Inspect the failure and retry or reassign.");
    } catch {
      draft = simpleHandoff("Turn failed", "failed", reason, "Inspect the failure and retry or reassign.");
    }
    this.post({ agentSessionId: session.id, speaker: { kind: speakerKindOf(seat), name: seatName }, to: target,
      handoff: draft, category: "failure", turnId: turn.turnId });
  }

  /** The once-per-assignment budget notice; the runtime owns the latch. */
  #turnBudgetNotice(session: AgentSessionRow, seat: AgentRow, turn: ActiveTurn, spentTurns: number): void {
    const profile = seat.profileSnapshot as AgentProfile;
    const target = this.#routing.escalationTarget(session, seat.name);
    this.post({ agentSessionId: session.id, speaker: { kind: speakerKindOf(seat), name: seat.name }, to: target,
      handoff: simpleHandoff("Turn budget exhausted", "blocked",
        `${seat.name} has spent ${spentTurns} turns on the current assignment (budget ${profile.maxTurns}).`,
        "Refocus, reassign, or explicitly continue the work."), category: "failure", turnId: turn.turnId });
  }

  // ── Persistent agent lanes ───────────────────────────────────────────────

  /** Spawn or unpark an agent so its peer session accepts input (`AgentRuntime.ensureSeatLive`). */
  async ensureSeatLive(agentSessionId: string, seat: string, deadline?: number): Promise<void> {
    return this.#runtime.ensureSeatLive(agentSessionId, seat, deadline);
  }

  #specialists(id: string): AgentRow[] { return this.#deps.repo.listAgents(id).filter((p) => p.role !== "coordinator"); }
  statusOf(row: AgentSessionRow): AgentSessionStatus { return this.#operator.statusOf(row); }
  #recordHostFailure(id: string, error: unknown): void {
    const session = this.#deps.repo.getAgentSession(id); if (!session) return;
    const text = error instanceof Error ? error.message : String(error);
    this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: id, payload: { agentSessionId: id, agent: "system", detail: `scheduler failure: ${text}` } });
  }
}
