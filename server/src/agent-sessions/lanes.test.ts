/**
 * The lane pool's eviction rules, pinned with stub lanes: parkLeastRecentIdle
 * victim selection (oldest live idle lane; busy or loaded lanes are immune)
 * and the global-vs-session capacity split (a binding global cap evicts from
 * the asker's OWN session first; budgets are per session, not per tree, so a
 * child session brings its own capacity).
 */
import { describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../config.ts";
import { AgentLanePool, type ActiveTurn } from "./lanes.ts";

function configWith(policy: Partial<Config["policy"]>): Config {
  const base = loadConfig({});
  return { infra: base.infra, policy: { ...base.policy, ...policy } };
}

function poolWith(policy: Partial<Config["policy"]>, over: {
  queued?: Set<string>;
} = {}) {
  const parked: string[] = [];
  const pool = new AgentLanePool({
    config: configWith(policy),
    hasQueuedWork: (agentSessionId, seat) => over.queued?.has(`${agentSessionId}:${seat}`) ?? false,
    reapRuntime: (agentSessionId, seat) => parked.push(`${agentSessionId}:${seat}`),
  });
  const live = (agentSessionId: string, seat: string, lastActiveAt: number) => {
    const lane = pool.laneOf(agentSessionId, seat);
    lane.state = "live";
    lane.lastActiveAt = lastActiveAt;
    return lane;
  };
  return { pool, parked, live };
}

const openTurn = (): ActiveTurn => ({ turnId: "turn_x", startedAt: 0, deliveries: [], sawSend: false,
  toolStarts: new Map(), lastEventAt: 0, alarmsFired: new Set(), lastNarration: "",
  watchdog: { lastKey: "", identical: 0, errorStreak: 0, tripped: null },
  awaitingOperator: null, pauseInterrupt: null });

describe("parkLeastRecentIdle victim selection", () => {
  it("evicts the least recently active live idle lane", async () => {
    const { pool, parked, live } = poolWith({ agentMaxResident: 2, agentMaxResidentPerSession: 99 });
    live("as_1", "alpha", 100);
    live("as_2", "beta", 50);
    await pool.reserveCapacity("as_3", Date.now() + 2_000);
    expect(parked).toEqual(["as_2:beta"]);
    expect(pool.laneOf("as_2", "beta").state).toBe("parked");
    expect(pool.laneOf("as_1", "alpha").state).toBe("live");
  });

  it("never evicts a lane with a turn in flight or queued work", async () => {
    const { pool, parked, live } = poolWith(
      { agentMaxResident: 3, agentMaxResidentPerSession: 99 },
      { queued: new Set(["as_2:loaded"]) },
    );
    live("as_1", "busy", 10).activeTurn = openTurn();
    live("as_2", "loaded", 20);
    live("as_3", "quiet", 30);
    await pool.reserveCapacity("as_4", Date.now() + 2_000);
    // The two older lanes are immune; the newest — but idle and empty — parks.
    expect(parked).toEqual(["as_3:quiet"]);
    expect(pool.laneOf("as_1", "busy").state).toBe("live");
    expect(pool.laneOf("as_2", "loaded").state).toBe("live");
  });

  it("throws once the deadline passes with nothing evictable", async () => {
    const { pool, live } = poolWith({ agentMaxResident: 1, agentMaxResidentPerSession: 99 });
    live("as_1", "busy", 10).activeTurn = openTurn();
    await expect(pool.reserveCapacity("as_2", Date.now() + 60)).rejects.toThrow("no resident seat capacity");
  });
});

describe("global-vs-session capacity eviction", () => {
  it("a binding global cap evicts from the asker's own session first, even over an older stranger", async () => {
    const { pool, parked, live } = poolWith({ agentMaxResident: 2, agentMaxResidentPerSession: 2 });
    live("as_a", "a1", 100);
    live("as_b", "b1", 50); // globally the oldest, but a stranger tree
    await pool.reserveCapacity("as_a", Date.now() + 2_000);
    expect(parked).toEqual(["as_a:a1"]);
    expect(pool.laneOf("as_b", "b1").state).toBe("live");
  });

  it("falls back to a global eviction when its own session has nothing to give", async () => {
    const { pool, parked, live } = poolWith({ agentMaxResident: 1, agentMaxResidentPerSession: 99 });
    live("as_b", "b1", 50);
    await pool.reserveCapacity("as_a", Date.now() + 2_000);
    expect(parked).toEqual(["as_b:b1"]);
  });

  it("a binding session cap evicts within the session only", async () => {
    const { pool, parked, live } = poolWith({ agentMaxResident: 99, agentMaxResidentPerSession: 1 });
    live("as_b", "stranger", 10); // oldest overall, different session — must survive
    live("as_a", "a1", 100);
    await pool.reserveCapacity("as_a", Date.now() + 2_000);
    expect(parked).toEqual(["as_a:a1"]);
    expect(pool.laneOf("as_b", "stranger").state).toBe("live");
  });

  it("a child session brings its OWN budget: the parent's residents do not count against it", async () => {
    // The old per-tree budget meant nesting could never add parallelism — a
    // parent at its cap starved every child. Per-session budgets are what
    // make create_child_session worth calling.
    const { pool, parked, live } = poolWith({ agentMaxResident: 99, agentMaxResidentPerSession: 2 });
    live("as_parent", "p1", 10);
    live("as_parent", "p2", 20);
    await pool.reserveCapacity("as_child", Date.now() + 2_000);
    expect(parked).toEqual([]);
    expect(pool.laneOf("as_parent", "p1").state).toBe("live");
    expect(pool.laneOf("as_parent", "p2").state).toBe("live");
  });
});
