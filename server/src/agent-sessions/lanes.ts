/**
 * The agent lane pool: seat-lane ownership, resident-capacity accounting and
 * eviction, parking, hard close, and idle timers — plus the read-only
 * LaneActivity facts other modules consume. Runtime code still mutates the
 * lanes it gets from the pool; the pool owns their lifecycle. Domain touches
 * (unacked-delivery checks, process/browser reaping, the session tree) arrive
 * as injected callbacks — the pool never imports a manager or the repo.
 */
import type { AsyncQueue } from "../async-queue.ts";
import type { Config } from "../config.ts";
import type { MailboxDeliveryRow } from "../db/repo.ts";
import type { QueryHandle, SdkUserMessageLike } from "../sdk/types.ts";
import type { LaneActivity, OperatorWait, OperatorWaitRef } from "./seams.ts";

/** The in-flight turn; null between turns. */
export interface ActiveTurn {
  turnId: string;
  startedAt: number;
  deliveries: MailboxDeliveryRow[];
  sawSend: boolean;
  toolStarts: Map<string, number>;
  /**
   * The agent's most recent narration; harvested into the synthetic failure
   * handoff when a turn dies.
   */
  lastNarration: string;
  watchdog: { lastKey: string; identical: number; errorStreak: number; tripped: string | null };
  /**
   * Set while this turn is parked inside `ask_operator`. A blocking ask
   * holds `activeTurn`, so without this the agent looks busy forever. Its
   * own controller, so the wait can be cut without killing the lane.
   */
  awaitingOperator: OperatorWait | null;
}

/**
 * An agent's persistent peer session. One streaming-input query per live
 * agent; the process registers the agent's peer name and binds its inbox
 * socket, so an agent is natively addressable exactly while its lane is live.
 * Parked lanes keep only the resume handle — the journal owns anything
 * undelivered.
 */
export interface AgentLane {
  state: "unspawned" | "waking" | "live" | "rotating" | "parked";
  input: AsyncQueue<SdkUserMessageLike> | null;
  query: QueryHandle | null;
  abort: AbortController | null;
  pump: Promise<void> | null;
  /** Resolves when the current spawn is accepting input. */
  ready: Promise<void> | null;
  activeTurn: ActiveTurn | null;
  /** Console pushes awaiting attribution to the next minted turn. */
  pendingDeliveries: MailboxDeliveryRow[];
  /** deliveryId → failed-turn redelivery attempts, capped so retries end. */
  redeliveryAttempts: Map<string, number>;
  /**
   * Peak context-window occupancy observed this provider session, from
   * per-assistant-message usage. This is the rotation signal — NOT the result
   * message's `inputTokens`, which sums every API round-trip in the turn and
   * so overstates occupancy by 5-25x on a tool-heavy turn.
   */
  contextTokens: number;
  /** Last cumulative cost/api-duration seen, for per-turn deltas. */
  lastCumulative: { costUsd: number; apiDurationMs: number };
  /** Set while rotating/recycling; senders await it before ensureLive. */
  rotationGate: Promise<void> | null;
  releaseRotation: (() => void) | null;
  idleTimer: NodeJS.Timeout | null;
  /** Cumulative settled turns since the last assignment delivery. */
  assignmentTurns: number;
  /** The turn-budget notice fired for the current assignment (latch). */
  turnBudgetNotified: boolean;
  lastActiveAt: number;
  lastStatus: "working" | "idle" | null;
}

export interface AgentLanePoolDeps {
  config: Config;
  /** Unacked-deliveries check — an evictable lane must have nothing pending. */
  hasQueuedWork: (agentSessionId: string, seat: string) => boolean;
  /** Kill the seat's processes/browsers and journal the park notice. */
  reapRuntime: (agentSessionId: string, seat: string, reason: string) => void;
  /** Session ids sharing one resident budget: the root and its children. */
  sessionTree: (agentSessionId: string) => ReadonlySet<string>;
}

export class AgentLanePool implements LaneActivity {
  readonly #deps: AgentLanePoolDeps;
  /** agentSessionId → agent name → its persistent lane. */
  readonly #seats = new Map<string, Map<string, AgentLane>>();
  /** Waiters for a resident-capacity slot, resolved oldest-first on park/close. */
  readonly #capacityWaiters: (() => void)[] = [];

  constructor(deps: AgentLanePoolDeps) { this.#deps = deps; }

  laneOf(agentSessionId: string, seat: string): AgentLane {
    let lanes = this.#seats.get(agentSessionId);
    if (!lanes) { lanes = new Map(); this.#seats.set(agentSessionId, lanes); }
    let lane = lanes.get(seat);
    if (!lane) {
      lane = { state: "unspawned", input: null, query: null, abort: null, pump: null, ready: null,
        activeTurn: null, pendingDeliveries: [], redeliveryAttempts: new Map(), contextTokens: 0,
        lastCumulative: { costUsd: 0, apiDurationMs: 0 }, rotationGate: null, releaseRotation: null,
        idleTimer: null, assignmentTurns: 0, turnBudgetNotified: false, lastActiveAt: 0, lastStatus: null };
      lanes.set(seat, lane);
    }
    return lane;
  }

  /** The lane if it exists — never creates one (unlike `laneOf`). */
  peek(agentSessionId: string, seat: string): AgentLane | undefined {
    return this.#seats.get(agentSessionId)?.get(seat);
  }

  #resident(): number {
    let count = 0;
    for (const lanes of this.#seats.values()) {
      for (const lane of lanes.values()) if (lane.state === "live" || lane.state === "waking" || lane.state === "rotating") count += 1;
    }
    return count;
  }

  #residentIn(sessionIds: ReadonlySet<string>): number {
    let count = 0;
    for (const [sessionId, lanes] of this.#seats) {
      if (!sessionIds.has(sessionId)) continue;
      for (const lane of lanes.values()) if (lane.state === "live" || lane.state === "waking" || lane.state === "rotating") count += 1;
    }
    return count;
  }

  /** Resident CLI processes are the scarce resource, not concurrent turns. */
  async reserveCapacity(agentSessionId: string, until: number): Promise<void> {
    const config = this.#deps.config;
    if (!config) return;
    for (;;) {
      const tree = this.#deps.sessionTree(agentSessionId);
      const globalFull = this.#resident() >= config.policy.agentMaxResident;
      // A parent and its children SHARE a budget: nesting must not multiply
      // the footprint, and a tree self-throttles before it thrashes strangers.
      const treeFull = this.#residentIn(tree) >= config.policy.agentMaxResidentPerTree;
      if (!globalFull && !treeFull) return;
      // Evict only where it frees the BINDING constraint: when the global cap
      // binds, try our own tree first.
      const scope = globalFull ? undefined : tree;
      if (scope === undefined && this.#parkLeastRecentIdle(tree)) continue;
      if (this.#parkLeastRecentIdle(scope)) continue;
      if (Date.now() >= until) throw new Error("no resident seat capacity");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(1_000, Math.max(50, until - Date.now())));
        timer.unref?.();
        this.#capacityWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  #parkLeastRecentIdle(within?: ReadonlySet<string>): boolean {
    let victim: { sessionId: string; seat: string; lane: AgentLane } | null = null;
    for (const [sessionId, lanes] of this.#seats) {
      if (within !== undefined && !within.has(sessionId)) continue;
      for (const [seat, lane] of lanes) {
        if (lane.state !== "live" || lane.activeTurn !== null) continue;
        if (this.#deps.hasQueuedWork(sessionId, seat)) continue;
        if (!victim || lane.lastActiveAt < victim.lane.lastActiveAt) victim = { sessionId, seat, lane };
      }
    }
    if (!victim) return false;
    this.#park(victim.sessionId, victim.seat, victim.lane, "capacity");
    return true;
  }

  /**
   * Close the process (name and socket unregister); keep the resume handle.
   * Runtime the agent still holds dies with the lane: a parked agent is not
   * coming back imminently, so its dev servers and Chrome are pure leak.
   */
  #park(agentSessionId: string, seatName: string, lane: AgentLane, reason: string): void {
    lane.state = "parked";
    lane.input?.close(); lane.input = null;
    const query = lane.query; lane.query = null;
    query?.close?.();
    lane.abort = null;
    this.#deps.reapRuntime(agentSessionId, seatName, reason);
    this.signalCapacity();
  }

  armIdleTimer(agentSessionId: string, seatName: string, lane: AgentLane): void {
    const config = this.#deps.config;
    if (!config) return;
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    lane.idleTimer = setTimeout(() => {
      lane.idleTimer = null;
      if (lane.state !== "live" || lane.activeTurn !== null) return;
      if (this.#deps.hasQueuedWork(agentSessionId, seatName)) return;
      this.#park(agentSessionId, seatName, lane, "idle");
    }, config.policy.agentIdleReapMs);
    lane.idleTimer.unref?.();
  }

  #closeHard(lane: AgentLane): void {
    lane.input?.close();
    lane.abort?.abort();
    void lane.query?.interrupt?.().catch(() => undefined);
    lane.query?.close?.();
    if (lane.idleTimer) { clearTimeout(lane.idleTimer); lane.idleTimer = null; }
    lane.state = "parked";
    this.signalCapacity();
  }

  /** Whole-session stop (archive/shutdown): every lane closes hard. */
  closeAllForSession(agentSessionId: string): void {
    for (const lane of this.#seats.get(agentSessionId)?.values() ?? []) this.#closeHard(lane);
  }

  async closeAll(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const lanes of this.#seats.values()) for (const lane of lanes.values()) {
      this.#closeHard(lane);
      if (lane.pump) pending.push(lane.pump.catch(() => undefined));
    }
    await Promise.all(pending);
  }

  /** Session cleanup on archive — the lifecycle's `#forget` calls this. */
  forget(agentSessionId: string): void {
    this.#seats.delete(agentSessionId);
  }

  signalCapacity(): void {
    this.#capacityWaiters.shift()?.();
  }

  // ── LaneActivity — the read-only facts other modules consume ─────────────

  hasBusyTurnExcludingOperatorWaits(agentSessionId: string): boolean {
    const lanes = this.#seats.get(agentSessionId);
    return [...(lanes?.values() ?? [])].some((lane) => lane.activeTurn !== null && lane.activeTurn.awaitingOperator === null);
  }

  operatorWaits(): OperatorWaitRef[] {
    const waits: OperatorWaitRef[] = [];
    for (const lanes of this.#seats.values()) for (const lane of lanes.values()) {
      const asking = lane.activeTurn?.awaitingOperator;
      if (asking) waits.push({ interactionId: asking.interactionId, since: asking.since, release: () => asking.abort.abort() });
    }
    return waits;
  }

  bindOperatorWait(agentSessionId: string, agent: string, wait: OperatorWait): () => void {
    const turn = this.laneOf(agentSessionId, agent).activeTurn;
    if (turn) turn.awaitingOperator = wait;
    return () => { if (turn) turn.awaitingOperator = null; };
  }

  hasLane(agentSessionId: string, agent: string): boolean {
    return this.#seats.get(agentSessionId)?.get(agent) !== undefined;
  }

  namesWithActiveTurn(agentSessionId: string): string[] {
    const lanes = this.#seats.get(agentSessionId);
    return [...(lanes?.entries() ?? [])].filter(([, lane]) => lane.activeTurn !== null).map(([name]) => name);
  }
}
