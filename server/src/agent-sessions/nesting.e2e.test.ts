/**
 * One level of nesting, end to end: a hub coordinator spawns a child session,
 * the child's "main" resolves to that coordinator (never the runner), the
 * parent's final is withheld until every child reports, and the whole tree
 * settles into run completion. Depth is capped by GRANTING — a child's seats
 * never see the spawn tools.
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

    // The depth cap IS the granting: the child coordinator spawned without the
    // spawn tools, and its env says depth 1.
    const childCoordOptions = h.fake.captured.options.find((options) => {
      const id = agentRoleOf(options);
      return id.agentSessionId === childId && id.role === "coordinator";
    });
    expect(childCoordOptions).toBeDefined();
    expect(agentRoleOf(childCoordOptions).depth).toBe(1);
    expect(childCoordOptions?.allowedTools ?? []).not.toContain("mcp__console_agent__create_child_session");
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
