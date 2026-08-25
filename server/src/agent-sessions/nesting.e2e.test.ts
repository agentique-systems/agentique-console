/**
 * Nesting end to end: a hub coordinator spawns a child session, the child's
 * "main" resolves to that coordinator (never the runner), the parent's final
 * is withheld until every child reports, and the whole tree settles into run
 * completion. Depth is capped by GRANTING — a controller BELOW
 * `maxSessionDepth` receives the spawn tools (so a depth-1 coordinator can
 * nest again under the default cap of 2); a session AT the cap never sees
 * them.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage, toolUseMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness, agentRoleOf } from "../test-helpers.ts";

const briefing = (action: string) => ({
  core: { schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false },
  extension: { kind: "generic" as const, data: {} },
});

describe("nesting e2e (fake SDK)", () => {
  it("spawns a child, withholds the parent final, crosses the boundary, and completes the run", async () => {
    let parentCoordTurns = 0;
    let childCoordTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const id = agentRoleOf(options);
      yield initMessage();
      if (id.role === "coordinator" && id.depth === 0) {
        parentCoordTurns += 1;
        if (parentCoordTurns === 1) {
          yield toolUseMessage("spawn", "mcp__console_agent__create_child_session", {
            pattern: "hub_and_spoke", title: "recon", agents: [{ name: "scout", profileId: "explorer", owns: [] }],
            briefing: briefing("scout the area") });
          // Premature final: the child is open, so this must be WITHHELD.
          yield sendHandoffUse("early-final", "main", { action: "done already?", status: "completed", category: "final" });
        } else if (parentCoordTurns === 2) {
          yield sendHandoffUse("real-final", "main", { action: "all done", stateSummary: "child recon complete: clear", status: "completed", category: "final" });
        }
      } else if (id.role === "coordinator" && id.depth === 1) {
        childCoordTurns += 1;
        yield childCoordTurns === 1
          ? sendHandoffUse("c-assign", "scout", { action: "look around", status: "pending", category: "assignment" })
          : sendHandoffUse("c-final", "main", { action: "recon done", stateSummary: "area clear", status: "completed", category: "final" });
      } else if (id.role === "specialist" && id.depth === 1) {
        yield sendHandoffUse("s-report", "coordinator", { action: "clear", status: "completed", category: "milestone" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 20_000);
    const created = h.host.createSession({ userSessionId, title: "mission", agents: [{ name: "aux", profileId: "explorer" }], briefing: briefing("run the mission") });
    const events = await done;

    // Parentage and depth are rows, not inference.
    const spawned = events.find((event) => event.type === "agent_session.child.spawned");
    expect(spawned?.payload).toMatchObject({ agentSessionId: created.agentSessionId, pattern: "hub_and_spoke", byAgent: "coordinator" });
    const childId = (spawned?.payload as { childAgentSessionId: string }).childAgentSessionId;
    const child = h.repo.getAgentSession(childId);
    expect(child).toMatchObject({ parentAgentSessionId: created.agentSessionId, parentControllerAgent: "coordinator", depth: 1 });

    // The depth cap IS the granting: with CONSOLE_MAX_SESSION_DEPTH's default
    // of 2, a depth-1 controller may still spawn (its child would be depth 2);
    // its env says depth 1.
    const childCoordOptions = h.fake.captured.options.find((options) => {
      const id = agentRoleOf(options);
      return id.agentSessionId === childId && id.role === "coordinator";
    });
    expect(childCoordOptions).toBeDefined();
    expect(agentRoleOf(childCoordOptions).depth).toBe(1);
    expect(childCoordOptions?.allowedTools ?? []).toContain("mcp__console_agent__create_child_session");
    const parentCoordOptions = h.fake.captured.options.find((options) => {
      const id = agentRoleOf(options);
      return id.agentSessionId === created.agentSessionId && id.role === "coordinator";
    });
    expect(parentCoordOptions?.allowedTools ?? []).toContain("mcp__console_agent__create_child_session");

    // The premature final was withheld naming the child hold.
    const withheld = events.find((event) => event.type === "agent_session.tool.completed"
      && JSON.stringify(event.payload).includes("child session(s) of this session have not reported"));
    expect(withheld).toBeDefined();

    // The child's final crossed as a boundary MILESTONE from child:<id> to the
    // controller — and the runner was never woken for it (no child flow.result).
    const parentRows = h.repo.listMessages("agent", created.agentSessionId).filter((row) => row.kind === "message");
    const boundary = parentRows.find((row) => row.speakerName === `child:${childId}`);
    expect(boundary?.toName).toBe("coordinator");
    expect((boundary?.payload?.handoff as { stateSummary?: string } | undefined)?.stateSummary).toContain(`Child session "recon"`);
    expect(events.filter((event) => event.type === "agent_session.result.returned" && event.payload.agentSessionId === childId)).toHaveLength(0);
    expect(events.find((event) => event.type === "agent_session.child.reported")?.payload)
      .toMatchObject({ agentSessionId: created.agentSessionId, childAgentSessionId: childId, status: "completed" });

    // The hold released with a console decision, the real final landed, and
    // the whole tree settled into completion.
    expect(parentRows.some((row) => ((row.payload?.handoff as { action?: string } | undefined)?.action ?? "").includes("All child sessions have reported"))).toBe(true);
    const parent = h.repo.getAgentSession(created.agentSessionId);
    expect(parent && h.host.statusOf(parent)).toBe("reported");
    expect(child && h.host.statusOf(child!)).toBe("reported");
  });

  it("abandon_child_session archives the child and closes the wait with a failure", async () => {
    let parentCoordTurns = 0;
    let childIdSeen: string | undefined;
    let releaseAbandon: (() => void) | undefined;
    const childReady = new Promise<void>((resolve) => { releaseAbandon = resolve; });
    const h = makeDelegationHarness(async function* (options) {
      const id = agentRoleOf(options);
      yield initMessage();
      if (id.role === "coordinator" && id.depth === 0) {
        parentCoordTurns += 1;
        if (parentCoordTurns === 1) {
          yield toolUseMessage("spawn", "mcp__console_agent__create_child_session", {
            pattern: "pipeline", title: "doomed", agents: [{ name: "a", profileId: "explorer", owns: [] }, { name: "b", profileId: "explorer", owns: [] }],
            briefing: briefing("never finishes") });
          await childReady;
          yield toolUseMessage("drop", "mcp__console_agent__abandon_child_session", {
            childAgentSessionId: childIdSeen, reason: "the sub-problem dissolved" });
        }
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    void (async () => {
      for await (const event of h.bus.readWithSeq({ fromSeq: 1, follow: true })) {
        if (event.type === "agent_session.child.spawned") {
          childIdSeen = (event.payload as { childAgentSessionId: string }).childAgentSessionId;
          releaseAbandon?.();
          return;
        }
      }
    })();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.child.reported"
      && (event.payload as { status?: string }).status === "failed", 15_000);
    const created = h.host.createSession({ userSessionId, title: "mission", agents: [{ name: "aux", profileId: "explorer" }], briefing: briefing("go") });
    await done;
    expect(h.repo.getAgentSession(childIdSeen!)?.lifecycle).toBe("archived");
    const parentRows = h.repo.listMessages("agent", created.agentSessionId).filter((row) => row.kind === "message");
    const notice = parentRows.find((row) => ((row.payload?.handoff as { action?: string } | undefined)?.action ?? "").includes("abandoned"));
    expect(notice?.speakerName).toBe(`child:${childIdSeen}`);
    expect(notice?.toName).toBe("coordinator");
  });

  it("nests to the configured depth: a grandchild works, reports, stays inspectable, and the run completes", async () => {
    const turns = { d0: 0, d1: 0, d2: 0 };
    const h = makeDelegationHarness(async function* (options) {
      const id = agentRoleOf(options);
      yield initMessage();
      if (id.role === "coordinator" && id.depth === 0) {
        turns.d0 += 1;
        yield turns.d0 === 1
          ? toolUseMessage("spawn-child", "mcp__console_agent__create_child_session", {
              pattern: "hub_and_spoke", title: "child", agents: [{ name: "c-aux", profileId: "explorer", owns: [] }],
              briefing: briefing("run the child workstream") })
          : sendHandoffUse("root-final", "main", { action: "mission done", stateSummary: "root result", status: "completed", category: "final" });
      } else if (id.role === "coordinator" && id.depth === 1) {
        turns.d1 += 1;
        yield turns.d1 === 1
          ? toolUseMessage("spawn-grandchild", "mcp__console_agent__create_child_session", {
              pattern: "hub_and_spoke", title: "grandchild", agents: [{ name: "g-aux", profileId: "explorer", owns: [] }],
              briefing: briefing("run the grandchild workstream") })
          : sendHandoffUse("child-final", "main", { action: "child done", stateSummary: "child result", status: "completed", category: "final" });
      } else if (id.role === "coordinator" && id.depth === 2) {
        turns.d2 += 1;
        yield sendHandoffUse("grandchild-final", "main", { action: "grandchild done", stateSummary: "leaf result", status: "completed", category: "final" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 30_000);
    const created = h.host.createSession({ userSessionId, title: "mission",
      agents: [{ name: "aux", profileId: "explorer" }], briefing: briefing("run the mission") });
    const events = await done;

    // Parentage and depth are rows: root 0 → child 1 → grandchild 2.
    const spawns = events.filter((event) => event.type === "agent_session.child.spawned");
    const childId = (spawns.find((event) => (event.payload as { agentSessionId: string }).agentSessionId === created.agentSessionId)
      ?.payload as { childAgentSessionId: string }).childAgentSessionId;
    const grandchildId = (spawns.find((event) => (event.payload as { agentSessionId: string }).agentSessionId === childId)
      ?.payload as { childAgentSessionId: string }).childAgentSessionId;
    expect(h.repo.getAgentSession(childId)).toMatchObject({ parentAgentSessionId: created.agentSessionId, depth: 1 });
    expect(h.repo.getAgentSession(grandchildId)).toMatchObject({
      parentAgentSessionId: childId, parentControllerAgent: "coordinator", depth: 2 });

    // The depth cap IS the granting: below the cap the spawn tools exist, AT it they never do.
    const coordOptions = (agentSessionId: string) => h.fake.captured.options.find((options) => {
      const id = agentRoleOf(options);
      return id.agentSessionId === agentSessionId && id.role === "coordinator";
    });
    expect(coordOptions(childId)?.allowedTools ?? []).toContain("mcp__console_agent__create_child_session");
    expect(coordOptions(grandchildId)?.allowedTools ?? []).not.toContain("mcp__console_agent__create_child_session");

    // The timeline gives every depth a lane, parented on the ACTUAL parent.
    const { lanes, items } = h.app.timeline.page(userSessionId);
    const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
    expect(laneById.get(`agent-session:${childId}`)?.parentId).toBe(`agent-session:${created.agentSessionId}`);
    expect(laneById.get(`agent-session:${grandchildId}`)?.parentId).toBe(`agent-session:${childId}`);
    const laneIds = new Set(lanes.map((lane) => lane.id));
    for (const item of items) expect(laneIds.has(item.laneId), `item ${item.id} → lane ${item.laneId}`).toBe(true);

    // The wire and main's portfolio agree with the rows: pre-order, real
    // depth, and the settled tree reads `reported` — not a grey "idle".
    const wire = h.host.wireSessionsForUserSession(userSessionId);
    expect(wire.map((session) => session.id)).toEqual([created.agentSessionId, childId, grandchildId]);
    expect(wire.map((session) => session.depth)).toEqual([0, 1, 2]);
    expect(wire.map((session) => session.activity)).toEqual(["reported", "reported", "reported"]);
    const portfolio = h.host.listForUserSession(userSessionId);
    expect(portfolio.map((session) => session.id)).toEqual([created.agentSessionId, childId, grandchildId]);
    expect(portfolio[1]).toMatchObject({ parentAgentSessionId: created.agentSessionId, depth: 1 });
    expect(portfolio[2]).toMatchObject({ parentAgentSessionId: childId, depth: 2 });
  });

  it("enforces the depth cap on creation with the cap named, and closing cascades the whole subtree", async () => {
    const h = makeDelegationHarness(async function* () { yield initMessage(); yield successMessage(); });
    const userSessionId = h.addUserSession();
    const seat = (name: string) => [{ name, profileId: "explorer" as const }];
    const root = h.host.createSession({ userSessionId, title: "root", agents: seat("r-aux") });
    const child = h.host.createSession({ userSessionId, title: "child", agents: seat("c-aux"),
      parent: { agentSessionId: root.agentSessionId, controllerAgent: "coordinator" } });
    const grand = h.host.createSession({ userSessionId, title: "grandchild", agents: seat("g-aux"),
      parent: { agentSessionId: child.agentSessionId, controllerAgent: "coordinator" } });
    expect(h.repo.getAgentSession(grand.agentSessionId)?.depth).toBe(2);

    // Depth maxSessionDepth is the LAST legal level; one deeper is rejected naming the cap.
    expect(() => h.host.createSession({ userSessionId, title: "too deep", agents: seat("x-aux"),
      parent: { agentSessionId: grand.agentSessionId, controllerAgent: "coordinator" } }))
      .toThrow(/capped at depth 2/);

    // Closing a MID-TIER session takes its subtree, not its parent.
    h.host.closeSession(child.agentSessionId, "no longer needed");
    expect(h.repo.getAgentSession(child.agentSessionId)?.lifecycle).toBe("archived");
    expect(h.repo.getAgentSession(grand.agentSessionId)?.lifecycle).toBe("archived");
    expect(h.repo.getAgentSession(root.agentSessionId)?.lifecycle).toBe("open");

    // Closing a ROOT archives everything under it — a stranded open
    // grandchild would block run completion until the next boot.
    const root2 = h.host.createSession({ userSessionId, title: "root2", agents: seat("r2-aux") });
    const child2 = h.host.createSession({ userSessionId, title: "child2", agents: seat("c2-aux"),
      parent: { agentSessionId: root2.agentSessionId, controllerAgent: "coordinator" } });
    const grand2 = h.host.createSession({ userSessionId, title: "grandchild2", agents: seat("g2-aux"),
      parent: { agentSessionId: child2.agentSessionId, controllerAgent: "coordinator" } });
    h.host.closeSession(root2.agentSessionId, "wrap up");
    for (const id of [root2.agentSessionId, child2.agentSessionId, grand2.agentSessionId]) {
      expect(h.repo.getAgentSession(id)?.lifecycle).toBe("archived");
    }
  });

  it("the boot orphan sweep archives a stranded subtree in one pass", async () => {
    const h = makeDelegationHarness(async function* () { yield initMessage(); yield successMessage(); });
    const userSessionId = h.addUserSession();
    const seat = (name: string) => [{ name, profileId: "explorer" as const }];
    const root = h.host.createSession({ userSessionId, title: "root", agents: seat("r-aux") });
    const child = h.host.createSession({ userSessionId, title: "child", agents: seat("c-aux"),
      parent: { agentSessionId: root.agentSessionId, controllerAgent: "coordinator" } });
    const grand = h.host.createSession({ userSessionId, title: "grandchild", agents: seat("g-aux"),
      parent: { agentSessionId: child.agentSessionId, controllerAgent: "coordinator" } });
    // The root vanishes across a "restart" without the cascade having run.
    h.repo.patchAgentSession(root.agentSessionId, { lifecycle: "archived" });
    expect(h.host.archiveOrphanChildren()).toBe(2);
    expect(h.repo.getAgentSession(child.agentSessionId)?.lifecycle).toBe("archived");
    expect(h.repo.getAgentSession(grand.agentSessionId)?.lifecycle).toBe("archived");
  });

  it("boot archives children whose parent is gone", async () => {
    let coordTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const id = agentRoleOf(options);
      yield initMessage();
      if (id.role === "coordinator" && id.depth === 0 && coordTurns === 0) {
        coordTurns += 1;
        yield toolUseMessage("spawn", "mcp__console_agent__create_child_session", {
          pattern: "hub_and_spoke", title: "stray", agents: [{ name: "scout", profileId: "explorer", owns: [] }],
          briefing: briefing("wander") });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const spawned = collectUntil(h.bus, (event) => event.type === "agent_session.child.spawned", 15_000);
    const created = h.host.createSession({ userSessionId, title: "mission", agents: [{ name: "aux", profileId: "explorer" }], briefing: briefing("go") });
    const events = await spawned;
    const childId = (events.at(-1)?.payload as { childAgentSessionId: string }).childAgentSessionId;
    // The parent vanishes across a "restart"; the sweep reaps the stray child.
    h.repo.patchAgentSession(created.agentSessionId, { lifecycle: "archived" });
    expect(h.host.archiveOrphanChildren()).toBe(1);
    expect(h.repo.getAgentSession(childId)?.lifecycle).toBe("archived");
  });
});
