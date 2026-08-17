import type { AgentSessionStatus, ConsoleEvent, GetAgentSessionResponse, HandoffDraft, Interaction, PatternId } from "@agentique-console/shared";
import fs from "node:fs";
import { NotFoundError } from "../errors.ts";
import type { AgentProfile, AgentProfileRegistry } from "../agent-profiles/registry.ts";
import type { Config } from "../config.ts";
import {
  Repo,
  type AgentSessionRow,
  type MessageRow,
  type AgentRow,
} from "../db/repo.ts";
import { toWireAgentSession, toWireMessage } from "../api/wire.ts";
import type { ArtifactStore } from "../events/artifact-store.ts";
import type { EventBus } from "../events/bus.ts";
import type { SqliteSessionStore } from "../sdk/session-store.ts";
import type { CapacityService } from "../capacity/service.ts";
import type { ConsoleSdk } from "../sdk/types.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import type { DecisionLedger } from "../orchestrator/decisions.ts";
import type { SpecService } from "../orchestrator/spec.ts";
import type { InteractionService } from "../orchestrator/interactions.ts";
import type { AssignmentScheduler } from "../tasks/scheduler.ts";
import type { TaskService } from "../tasks/service.ts";
import type { HandoffService } from "../handoffs/service.ts";
import type { ReapResult } from "../completion/summary.ts";
import { MAIN_RECIPIENT } from "./names.ts";
import type { Category } from "./final-gate.ts";
import { PromptComposer } from "./composer.ts";
import { roleOfAgent, speakerKindOf } from "./topology.ts";
import { SessionRouting } from "./routing.ts";
import { WorktreeBinding } from "./worktree-binding.ts";
import { OperatorSurface } from "./operator.ts";
import { Mailroom, identitySelector, simpleHandoff } from "./mailroom.ts";
import { sweepLiveness } from "./liveness.ts";
import { AgentLanePool, type ActiveTurn } from "./lanes.ts";
import { AgentRuntime } from "./runtime.ts";
import { SessionLifecycle, type CreateAgentSessionInput } from "./lifecycle.ts";
import { NestingBroker } from "./nesting.ts";
import type { TransferInput } from "./seams.ts";
import { dispatchWorkItems, onPatternPost, sweep as patternSweep, type DispatchWorkItemsInput, type PatternContext } from "./patterns/engine.ts";

export interface AgentSessionServiceDeps {
  repo: Repo;
  specs: SpecService;
  bus: EventBus;
  artifacts: ArtifactStore;
  /** Required — every knob's default lives in `loadConfig`, nowhere else. */
  config: Config;
  profiles: AgentProfileRegistry;
  sdk: () => Promise<ConsoleSdk>;
  sessionStore: SqliteSessionStore;
  getWorkspaceRoot: (workspaceId: string) => string;
  wake: (userSessionId: string, agentSessionId: string, category: Category, text: string) => void;
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
  /** Pause/resume on provider capacity and budget ceilings. */
  capacity: CapacityService;
}

/**
 * Console-managed, independently resumable participant sessions and durable
 * mailbox. A facade: the constructor assembles the agent-sessions modules and
 * closes their cycles (mailroom↔runtime, mailroom↔nesting, operator↔nesting,
 * nesting↔lifecycle) with typed closures — modules never import this file.
 * Beyond that wiring it keeps only pure delegation, the small read models,
 * and the runtime's settle-hook policies (carry/escalate/budget-notice).
 */
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
  /** Session creation and teardown; the boot redrive. */
  readonly #lifecycle: SessionLifecycle;
  /** Child-boundary traffic; the mailroom's BoundaryBroker. */
  readonly #nesting: NestingBroker;

  constructor(deps: AgentSessionServiceDeps) {
    this.#deps = deps;
    this.#routing = new SessionRouting({ repo: deps.repo });
    this.#lanes = new AgentLanePool({
      config: deps.config,
      hasQueuedWork: (agentSessionId, seat) => deps.repo.listUnackedDeliveries(agentSessionId, seat).length > 0,
      // Closing the lane closes the seat's CLI subprocess, and everything the
      // agent started is a child of it: a background Bash server, an MCP
      // server's browser. The Console owns no capability, so it sweeps none.
      reapRuntime: (agentSessionId, seatName, reason) => {
        const session = deps.repo.getAgentSession(agentSessionId);
        if (!session) return;
        deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId,
          payload: { agentSessionId, agent: seatName, detail: `agent parked (${reason}); provider session retained` } });
      },
    });
    this.#worktreeBinding = new WorktreeBinding({
      repo: deps.repo, bus: deps.bus, artifacts: deps.artifacts, config: deps.config,
      worktrees: deps.worktrees, getWorkspaceRoot: deps.getWorkspaceRoot,
      escalationTarget: (session, agentName) => this.#routing.escalationTarget(session, agentName),
      isReviewRole: (session, agentName) => this.#routing.isReviewRole(session, agentName),
      // Landing removes the seat's worktree directory; doing that under a
      // live turn yanks the cwd out from under a running build.
      laneBusy: (agentSessionId, agent) => {
        const lane = this.#lanes.peek(agentSessionId, agent);
        return lane !== undefined && lane.activeTurn !== null;
      },
      // Live process = its cwd inode must survive the landing.
      laneLive: (agentSessionId, agent) => {
        const lane = this.#lanes.peek(agentSessionId, agent);
        return lane !== undefined && (lane.state === "live" || lane.state === "waking" || lane.state === "rotating");
      },
      transfer: (input) => this.post(input),
      simpleHandoff,
    });
    this.#composer = new PromptComposer({
      repo: deps.repo, bus: deps.bus, config: deps.config, handoffs: deps.handoffs,
      decisions: deps.decisions, specs: deps.specs, tasks: deps.tasks, interactions: deps.interactions,
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
      maybeReleaseParentFinal: (parent) => this.#nesting.maybeReleaseParentFinal(parent),
      recordFailure: (agentSessionId, error) => this.#recordFailure(agentSessionId, error),
      paused: () => deps.capacity.paused,
      sweepTasks: [() => {
        // The quiet-time stall lives here — it can trip while every lane is
        // quiet, which is exactly when it matters.
        for (const session of this.#deps.repo.listOpenAgentSessions()) {
          try { patternSweep(this.#patternCtx(), session); } catch (error) { this.#recordFailure(session.id, error); }
        }
      }, () => {
        // The liveness alarms cover the opposite case: a turn that IS in
        // flight and dead — the one dimension every completed-action guard
        // (watchdogs, stall, reaping) is structurally blind to.
        for (const session of this.#deps.repo.listOpenAgentSessions()) {
          try {
            sweepLiveness({ config: this.#deps.config, lanes: this.#lanes, bus: this.#deps.bus,
              transfer: (input) => this.post(input), simpleHandoff }, session);
          } catch (error) { this.#recordFailure(session.id, error); }
        }
      }, () => {
        // The autonomy sweep: deferred asks auto-proceed on their
        // recommendation; stale blocking asks escalate to main.
        try {
          deps.interactions.sweepStaleAsks({
            deferredAutoProceedMs: deps.config.policy.deferredAutoProceedMs,
            blockingAskEscalateMs: deps.config.policy.blockingAskEscalateMs,
            autonomyOf: (userSessionId) => deps.repo.getUserSession(userSessionId)?.autonomy ?? "standard",
            escalate: (row) => {
              if (row.agentSessionId === null) return;
              deps.wake(row.userSessionId, row.agentSessionId, "failure",
                `Blocking operator question ${row.id} from ${row.agent ?? "an agent"} has been unanswered for over ` +
                `${Math.round(deps.config.policy.blockingAskEscalateMs / 60_000)} minutes. ` +
                "Re-route independent work around it, and decide whether an investigation can answer it instead of the operator.");
            },
          });
        } catch { /* the sweep must never take the tick down */ }
      }],
    });
    this.#runtime = new AgentRuntime({
      repo: deps.repo, bus: deps.bus, config: deps.config,
      sdk: deps.sdk, sessionStore: deps.sessionStore, getWorkspaceRoot: deps.getWorkspaceRoot,
      artifacts: deps.artifacts, tasks: deps.tasks, handoffs: deps.handoffs, specs: deps.specs,
      worktrees: deps.worktrees,
      scheduler: deps.scheduler, capacity: deps.capacity,
      lanes: this.#lanes, worktree: this.#worktreeBinding, routing: this.#routing, composer: this.#composer,
      transfer: (input) => this.post(input),
      askOperator: (session, seat, args) => this.#operator.askOperator(session, seat, args),
      createChildSession: (session, controller, input) => this.#lifecycle.createSession({
        userSessionId: session.userSessionId, title: input.title,
        pattern: input.pattern as PatternId,
        ...(input.patternConfig ? { patternConfig: input.patternConfig } : {}),
        parent: { agentSessionId: session.id, controllerAgent: controller.name },
        agents: input.agents, briefing: input.briefing,
      }),
      abandonChildSession: (session, controller, childAgentSessionId, reason) =>
        this.#nesting.abandonChildSession(session.id, controller.name, childAgentSessionId, reason),
      dispatchWorkItems: (dispatcherAgent, input) => this.dispatchWorkItems(dispatcherAgent, input),
      markWorking: (agentSessionId) => this.#operator.setStatus(agentSessionId, "working"),
      hooks: {
        patchDelivery: (session, delivery, status) => this.#mailroom.patchDelivery(session, delivery, status),
        deliver: (agentSessionId, recipient) => this.#mailroom.deliver(agentSessionId, recipient),
        escalateFailure: (session, seatName, seat, turn, reason) => this.#escalateFailure(session, seatName, seat, turn, reason),
        carryReport: (session, seatName, turn) => this.#carryReport(session, seatName, turn),
        turnBudgetNotice: (session, seat, turn, spentTurns) => this.#turnBudgetNotice(session, seat, turn, spentTurns),
        refreshStatus: (agentSessionId) => this.#operator.refreshStatus(agentSessionId),
        recordFailure: (agentSessionId, error) => this.#recordFailure(agentSessionId, error),
      },
    });
    this.#nesting = new NestingBroker({
      repo: deps.repo, bus: deps.bus, handoffs: deps.handoffs,
      routing: this.#routing,
      transfer: (input) => this.post(input),
      simpleHandoff,
      patchDelivery: (session, delivery, status) => this.#mailroom.patchDelivery(session, delivery, status),
      finalWithheld: (session) => this.#operator.finalWithheld(session),
      sessionStatus: (row) => this.#operator.statusOf(row),
      archiveSession: (session) => this.#lifecycle.archiveOne(session),
      recordFailure: (agentSessionId, error) => this.#recordFailure(agentSessionId, error),
    });
    this.#mailroom = new Mailroom({
      repo: deps.repo, bus: deps.bus, config: deps.config, interactions: deps.interactions,
      decisions: deps.decisions, tasks: deps.tasks, handoffs: deps.handoffs, scheduler: deps.scheduler,
      wake: deps.wake,
      capacityPaused: () => deps.capacity.paused,
      routing: this.#routing, worktree: this.#worktreeBinding, composer: this.#composer,
      lanes: this.#lanes,
      selector: identitySelector,
      ensureLive: (agentSessionId, seat) => this.ensureSeatLive(agentSessionId, seat),
      injector: this.#runtime,
      sessionStatus: (row) => this.#operator.statusOf(row),
      boundary: this.#nesting,
      onPatternPost: (session, hop) => onPatternPost(this.#patternCtx(), session, hop),
      recordFailure: (agentSessionId, error) => this.#recordFailure(agentSessionId, error),
    });
    this.#lifecycle = new SessionLifecycle({
      repo: deps.repo, bus: deps.bus, config: deps.config, profiles: deps.profiles,
      getWorkspaceRoot: deps.getWorkspaceRoot,
      worktrees: deps.worktrees,
      routing: this.#routing, lanes: this.#lanes, worktree: this.#worktreeBinding,
      transfer: (input) => this.post(input),
      simpleHandoff,
      tasks: deps.tasks,
      snapshotProfile: (profile) => this.#runtime.snapshotProfile(profile),
      patchDelivery: (session, delivery, status) => this.#mailroom.patchDelivery(session, delivery, status),
      deliver: (agentSessionId, recipient) => this.#mailroom.deliver(agentSessionId, recipient),
      redriveChildBoundary: (session, delivery) => this.#nesting.redriveChildBoundary(session, delivery),
      forgetOperator: (agentSessionId) => this.#operator.forget(agentSessionId),
      recordFailure: (agentSessionId, error) => this.#recordFailure(agentSessionId, error),
    });
  }

  createSession(input: CreateAgentSessionInput): { agentSessionId: string; agents: string[]; entryAgent: string; coordinatorName?: string } {
    return this.#lifecycle.createSession(input);
  }

  /** The agent main steers: the contract entry role's first agent. */
  entryAgent(agentSessionId: string): string {
    return this.#lifecycle.entryAgent(agentSessionId);
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

  /**
   * LIVE state, not the journal: per-seat lane posture, the in-flight tool
   * call with its age, last-stream-event age, queued deliveries, last
   * handoff, pattern-state facts. `read_agent_session` shows what agents
   * SAID; this shows what they are DOING — the roguelike orchestrator
   * misdiagnosed a 14-minute hang as "mid-flight and progressing" because
   * only the human UI carried this data.
   */
  activity(agentSessionId: string) {
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (!session) throw new NotFoundError(`no agent session ${agentSessionId}`);
    const now = Date.now();
    const snapshots = new Map(this.#lanes.laneSnapshots(agentSessionId).map((snapshot) => [snapshot.agent, snapshot]));
    const patternState = this.#deps.repo.getPatternState(agentSessionId);
    return {
      agentSessionId,
      pattern: session.pattern,
      status: this.#operator.statusOf(session),
      patternState: patternState === undefined ? null : {
        tripped: patternState.tripped ?? null,
        handoffCount: patternState.handoffCount,
        lastProgressAt: patternState.lastProgressAt ?? null,
      },
      agents: this.#deps.repo.listAgents(agentSessionId).map((seat) => {
        const lane = snapshots.get(seat.name);
        const turn = lane?.turn ?? null;
        const lastHandoffRow = seat.latestHandoffId === null ? undefined : this.#deps.repo.getHandoff(seat.latestHandoffId);
        return {
          name: seat.name,
          role: seat.role,
          profileId: seat.profileId,
          model: seat.model,
          generation: seat.generation,
          contextTokens: Math.max(seat.contextTokens, lane?.contextTokens ?? 0),
          laneState: lane?.state ?? "unspawned",
          queuedDeliveries: this.#deps.repo.listUnackedDeliveries(agentSessionId, seat.name).length,
          lastHandoff: lastHandoffRow === undefined ? null : {
            status: (lastHandoffRow.core as { status?: string }).status ?? "unknown",
            action: String((lastHandoffRow.core as { action?: string }).action ?? "").slice(0, 160),
            ageMs: now - Date.parse(lastHandoffRow.createdAt),
          },
          turn: turn === null ? null : {
            turnId: turn.turnId,
            ageMs: now - turn.startedAt,
            lastEventAgeMs: now - turn.lastEventAt,
            awaitingOperator: turn.awaitingOperator,
            inFlight: turn.inFlight.map((call) => ({
              name: call.name, inputPreview: call.inputPreview, elapsedMs: now - call.startedAt,
            })),
          },
        };
      }),
    };
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

  /** Post-capacity-resume kick: every queued delivery starts moving again. */
  resumeQueuedDeliveries(): void {
    const seen = new Set<string>();
    for (const row of this.#deps.repo.listQueuedDeliveries()) {
      const key = `${row.agentSessionId}/${row.recipient}`;
      if (seen.has(key)) continue;
      seen.add(key);
      void this.#mailroom.deliver(row.agentSessionId, row.recipient)
        .catch((error) => this.#recordFailure(row.agentSessionId, error));
    }
  }

  /** The session detail view: wire session + per-agent run stats + messages. */
  detail(agentSessionId: string): GetAgentSessionResponse {
    const row = this.#deps.repo.getAgentSession(agentSessionId);
    if (!row) throw new NotFoundError(`no agent session ${agentSessionId}`);
    // The agents-row columns are per-generation watermarks; the lifetime
    // truth lives in usage samples (see aggregateUsageByParticipant).
    const totals = this.#deps.repo.aggregateUsageByParticipant(row.id);
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
        totalCostUsd: totals.get(agent.name)?.costUsd ?? 0,
        totalTurns: totals.get(agent.name)?.turns ?? 0,
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
    this.#lifecycle.interrupt(agentSessionId);
  }

  /**
   * The operator's whole-system pause: interrupt every seat's in-flight turn
   * without cancelling its deliveries (`AgentRuntime.interruptAllForPause`).
   * Returns how many turns were cut.
   */
  interruptAllForPause(reason: string): number {
    return this.#runtime.interruptAllForPause(reason);
  }

  /** Scoped stop: abort one specialist's in-flight turn (`AgentRuntime.interruptAgent`). */
  interruptAgent(agentSessionId: string, agent: string, reason: string): void {
    this.#runtime.interruptAgent(agentSessionId, agent, reason);
  }

  /** Mid-run roster growth (`SessionLifecycle.addAgent`); patterns with fixed rosters refuse. */
  addAgent(agentSessionId: string, input: { name: string; profileId: string; instructions?: string; model?: string; owns?: string[]; skills?: string[]; why?: string }): { agent: string; role: string } {
    return this.#lifecycle.addAgent(agentSessionId, input);
  }

  /**
   * Main-side branch termination — "terminate unproductive branches" as a
   * first-class act. Also closes a run-liveness hole: `isComplete` requires
   * every OPEN session to report, so an unproductive session whose final seat
   * never will blocked completion forever (main's only remedy was archiving
   * the whole conversation). A child is abandoned THROUGH the nesting broker
   * so its controller receives the journaled failure and the parent's
   * withheld final releases; a top-level session takes the one teardown path
   * (worktree branches archive — abandoned work never lands, never vanishes).
   */
  closeSession(agentSessionId: string, reason: string): { archived: true; openTasks: string[] } {
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (!session) throw new NotFoundError(`no agent session ${agentSessionId}`);
    if (session.lifecycle !== "open") throw new NotFoundError(`agent session ${agentSessionId} is already archived`);
    const openTasks = this.#deps.tasks.linesForAgentSession(agentSessionId)
      .filter((line) => !line.startsWith("- [completed]"));
    this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId,
      payload: { agentSessionId, agent: MAIN_RECIPIENT, detail: `session closed by main: ${reason}` } });
    if (session.parentAgentSessionId !== null) {
      this.#nesting.abandonChildSession(session.parentAgentSessionId, MAIN_RECIPIENT, agentSessionId, reason);
    } else {
      // Closing a parent must not orphan its children mid-work: each open
      // child is abandoned (journaled, archived, salvage-preserved) first.
      for (const child of this.#deps.repo.listChildSessions(agentSessionId).filter((row) => row.lifecycle === "open")) {
        try { this.#nesting.abandonChildSession(agentSessionId, MAIN_RECIPIENT, child.id, `parent session closed: ${reason}`); }
        catch (error) { this.#recordFailure(agentSessionId, error); }
      }
      this.#lifecycle.archiveOne(session);
    }
    return { archived: true, openTasks };
  }

  async closeAll(): Promise<void> {
    await this.#lifecycle.closeAll();
  }

  /** Runtime-resource release without archival (`SessionLifecycle.reapForUserSession`). */
  reapForUserSession(userSessionId: string): ReapResult {
    return this.#lifecycle.reapForUserSession(userSessionId);
  }

  archiveForUserSession(userSessionId: string): void {
    this.#lifecycle.archiveForUserSession(userSessionId);
  }

  /** Boot sweep: orphaned children can never report (`NestingBroker.archiveOrphanChildren`). */
  archiveOrphanChildren(): number {
    return this.#nesting.archiveOrphanChildren();
  }

  /** The wedged-child escape hatch (`NestingBroker.abandonChildSession`). */
  abandonChildSession(parentAgentSessionId: string, controllerAgent: string, childAgentSessionId: string, reason: string): void {
    this.#nesting.abandonChildSession(parentAgentSessionId, controllerAgent, childAgentSessionId, reason);
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
      deliverNow: (agentSessionId, recipient) => void this.#mailroom.deliver(agentSessionId, recipient).catch((error) => this.#recordFailure(agentSessionId, error)),
      hasActivity: (agentSessionId) => this.#lanes.namesWithActiveTurn(agentSessionId).length > 0,
      sessionReported: (session) => this.#operator.statusOf(session) === "reported",
      profile: (id, workspaceId) => this.#lifecycle.profile(id, workspaceId),
      snapshotProfile: (profile) => this.#runtime.snapshotProfile(profile),
      agent: (agentSessionId, name, role, profile, extra, model, ownership, ord, createdAt) =>
        this.#lifecycle.agentRow(agentSessionId, name, role, profile, extra, model, ownership, ord, createdAt),
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

  /** Boot redrive: wake queued deliveries, replay child-boundary rows (`SessionLifecycle.boot`). */
  boot(): void {
    this.#lifecycle.boot();
  }

  profiles(workspaceId?: string): AgentProfile[] { return this.#deps.profiles?.list(workspaceId) ?? []; }
  /** What this host can actually do, for the profile listing main reads. */
  runtimeAvailability(): { git: boolean; chrome: boolean } {
    return { git: this.#deps.worktrees !== null, chrome: fs.existsSync("/usr/bin/google-chrome") };
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
    const reported = this.#deps.repo.hasTerminalReportSince(session.id, seatName, assignmentSeq);
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
      // The reconstructed draft is console-authored too: without the
      // consoleSynthesized flag it (a) read as an agent's own report to every
      // excludeSynthetic scan and (b) got the seat's branch DELETED as if the
      // agent had judged its own work failed.
      draft = reconstructed
        ? { core: { ...reconstructed.core, status: "failed", risk: "high", action: "Turn failed",
            state: { ...reconstructed.core.state,
              summary: `${reason}\n\nState the Console can vouch for:\n${reconstructed.core.state.summary}${salvaged === "" ? "" : `\n\nUnsent work from ${seatName}'s last output (unverified — it never passed through a handoff):\n${salvaged.slice(0, 8_000)}`}` },
            nextAction: "Inspect the failure and retry or reassign." },
            extension: { kind: reconstructed.extension?.kind ?? "generic",
              data: { ...(reconstructed.extension?.data ?? {}), consoleSynthesized: true } } }
        : simpleHandoff("Turn failed", "failed", reason, "Inspect the failure and retry or reassign.");
    } catch {
      draft = simpleHandoff("Turn failed", "failed", reason, "Inspect the failure and retry or reassign.");
    }
    // One escalation per dead turn: the settle path already gates on
    // "gave up", and the dedupe absorbs any replay of the same turn's death
    // through a second code path.
    this.post({ agentSessionId: session.id, speaker: { kind: speakerKindOf(seat), name: seatName }, to: target,
      handoff: draft, category: "failure", turnId: turn.turnId, dedupeKey: `turn-failure:${turn.turnId}` });
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
  /** The one "has this session reported?" predicate; run completion reads it too. */
  reportedFinal(row: AgentSessionRow): boolean { return this.#operator.reportedFinal(row); }
  /** Run completion's backstop: close the operator loop on any quiet session. */
  dischargeQuietDebts(userSessionId: string): void { this.#operator.dischargeQuietDebts(userSessionId); }
  #recordFailure(id: string, error: unknown): void {
    const session = this.#deps.repo.getAgentSession(id); if (!session) return;
    const text = error instanceof Error ? error.message : String(error);
    this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: id, payload: { agentSessionId: id, agent: "system", detail: `scheduler failure: ${text}` } });
  }
}
