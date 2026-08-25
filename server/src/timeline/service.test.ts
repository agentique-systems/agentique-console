/**
 * The timeline's hierarchy contract: if the runtime can create a valid
 * AgentSession at depth N, the timeline must give it (and its seats) a lane,
 * parent that lane on the ACTUAL parent's lane, and order the whole forest
 * deterministically — never by DB return order. The regression this pins:
 * lanes were built from roots + direct children only, so a depth-2 session's
 * events pointed at lanes that did not exist and the deepest work silently
 * vanished from the review surface.
 */
import { describe, expect, it } from "vitest";
import type { AgentRow, AgentSessionRow } from "../db/repo.ts";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { makeHarness, type Harness } from "../test-helpers.ts";
import { newId, nowIso } from "../ids.ts";

async function* trivialProgram() {
  yield initMessage();
  yield successMessage();
}

function addSession(h: Harness, userSessionId: string, title: string,
  opts: { parent?: AgentSessionRow; createdAt?: string; lifecycle?: "open" | "archived" } = {}): AgentSessionRow {
  const at = opts.createdAt ?? nowIso();
  const row: AgentSessionRow = {
    id: newId("as"), userSessionId, title, lifecycle: opts.lifecycle ?? "open",
    pattern: "hub_and_spoke", topology: {}, parentAgentSessionId: opts.parent?.id ?? null,
    parentControllerAgent: opts.parent === undefined ? null : "coordinator",
    depth: opts.parent === undefined ? 0 : opts.parent.depth + 1,
    allowChildSessions: false, budgetUsd: null, createdAt: at, updatedAt: at,
  };
  h.repo.insertAgentSession(row);
  return row;
}

function addAgent(h: Harness, agentSessionId: string, name: string, ord: number): AgentRow {
  const row: AgentRow = {
    agentSessionId, name, role: "specialist", instructions: "x", model: null,
    profileId: "explorer", profileSnapshot: {}, ownership: [], sharedOwnership: [],
    sdkSessionId: null, lastActiveAt: null, generation: 0, turnCount: 0,
    contextTokens: 0, latestHandoffId: null, cumulativeCostUsd: 0,
    cumulativeApiDurationMs: 0, lastDecisionAt: null, worktreePath: null,
    worktreeBaseCommit: null, worktreeBranch: null, salvageBranch: null,
    salvageArtifactId: null, ord, createdAt: nowIso(),
  };
  h.repo.insertAgent(row);
  return row;
}

/**
 * main ── A ── A1 ── A1a   (depth 2 — legal under the default cap)
 *        │     └ A2
 *        └ B ── B1
 * Inserted DELIBERATELY out of creation order to prove ordering is derived,
 * not inherited from the query.
 */
function buildForest(h: Harness, userSessionId: string) {
  const b = addSession(h, userSessionId, "B", { createdAt: "2026-08-01T10:04:00.000Z" });
  const a = addSession(h, userSessionId, "A", { createdAt: "2026-08-01T10:00:00.000Z" });
  const a1 = addSession(h, userSessionId, "A1", { parent: a, createdAt: "2026-08-01T10:01:00.000Z" });
  const b1 = addSession(h, userSessionId, "B1", { parent: b, createdAt: "2026-08-01T10:05:00.000Z" });
  const a1a = addSession(h, userSessionId, "A1a", { parent: a1, createdAt: "2026-08-01T10:02:00.000Z" });
  const a2 = addSession(h, userSessionId, "A2", { parent: a, createdAt: "2026-08-01T10:03:00.000Z", lifecycle: "archived" });
  addAgent(h, a1a.id, "leaf-scout", 1);
  return { a, a1, a1a, a2, b, b1 };
}

describe("timeline hierarchy lanes", () => {
  it("emits a lane for every session at every depth, parented on the actual parent's lane", () => {
    const h = makeHarness(trivialProgram);
    const userSessionId = h.addUserSession();
    const f = buildForest(h, userSessionId);

    const { lanes } = h.app.timeline.page(userSessionId);
    const laneById = new Map(lanes.map((lane) => [lane.id, lane]));

    for (const session of [f.a, f.a1, f.a1a, f.a2, f.b, f.b1]) {
      const lane = laneById.get(`agent-session:${session.id}`);
      expect(lane, `lane for ${session.title}`).toBeDefined();
      expect(lane!.parentId).toBe(session.parentAgentSessionId === null
        ? null : `agent-session:${session.parentAgentSessionId}`);
    }
    // The grandchild's SEAT gets a lane under the grandchild's session lane.
    const seatLane = laneById.get(`agent:${f.a1a.id}:leaf-scout`);
    expect(seatLane).toBeDefined();
    expect(seatLane!.parentId).toBe(`agent-session:${f.a1a.id}`);
  });

  it("orders lanes depth-first pre-order by creation, whatever order the DB returns", () => {
    const h = makeHarness(trivialProgram);
    const userSessionId = h.addUserSession();
    const f = buildForest(h, userSessionId);

    const sessionLanes = h.app.timeline.page(userSessionId).lanes
      .filter((lane) => lane.kind === "agent_session");
    expect(sessionLanes.map((lane) => lane.label)).toEqual(["A", "A1", "A1a", "A2", "B", "B1"]);
    // `order` is the same sequence — consumers sorting by it agree.
    expect([...sessionLanes].sort((x, y) => x.order - y.order).map((lane) => lane.label))
      .toEqual(["A", "A1", "A1a", "A2", "B", "B1"]);
    // Two reads produce the identical arrangement.
    expect(h.app.timeline.page(userSessionId).lanes).toEqual(h.app.timeline.page(userSessionId).lanes);
    void f;
  });

  it("never emits an item whose lane does not exist — grandchild events included", () => {
    const h = makeHarness(trivialProgram);
    const userSessionId = h.addUserSession();
    const f = buildForest(h, userSessionId);

    h.bus.append({ type: "agent_session.turn.started", userSessionId, agentSessionId: f.a1a.id,
      payload: { agentSessionId: f.a1a.id, agent: "leaf-scout", turnId: "turn_g1" } });
    h.bus.append({ type: "agent_session.turn.settled", userSessionId, agentSessionId: f.a1a.id,
      payload: { agentSessionId: f.a1a.id, agent: "leaf-scout", turnId: "turn_g1", status: "completed", durationMs: 5 } });

    const { lanes, items } = h.app.timeline.page(userSessionId);
    const laneIds = new Set(lanes.map((lane) => lane.id));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(laneIds.has(item.laneId), `item ${item.id} references lane ${item.laneId}`).toBe(true);
    }
    const turn = items.find((item) => item.id === "agent-turn:turn_g1");
    expect(turn?.laneId).toBe(`agent:${f.a1a.id}:leaf-scout`);
    expect(turn?.status).toBe("completed");
  });
});
