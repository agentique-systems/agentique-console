/**
 * The task ledger is console-owned: keyed on a synthetic id derived from the
 * AGENT SESSION (never a provider session, which rotation retires), so
 * rotation cannot orphan it and every agent reads the same list.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { consoleTaskListId } from "../tasks/service.ts";

const handoff = (action: string, status: "pending" | "completed") => ({ core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
  action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
  uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });

const parse = (result: { content: { type: string; text?: string }[] }) =>
  JSON.parse(result.content[0]?.text ?? "null") as { tasks?: { sdkTaskId: string; status: string; subject: string }[] };

describe("console-owned task ledger (fake SDK)", () => {
  it("keys the ledger to the agent session so rotation cannot orphan it", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "ledger", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("investigate", "pending") });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    const create = h.fake.captured.tools.find((t) => t.name === "task_create");
    const update = h.fake.captured.tools.find((t) => t.name === "task_update");
    const list = h.fake.captured.tools.find((t) => t.name === "task_list");
    expect(create && update && list).toBeTruthy();

    // `owner` is required: it names the agent that will DO the work, not the
    // one writing the row.
    await create!.handler({ taskId: "1", subject: "Agree the module interface", description: "before either writes code", owner: "scout" }, {});
    await create!.handler({ taskId: "2", subject: "Implement src/game.js", description: "", owner: "scout" }, {});
    await update!.handler({ taskId: "1", status: "completed", owner: "coordinator" }, {});

    // The key is derived from the agent session, never from a provider session.
    expect(consoleTaskListId(created.agentSessionId)).toContain(created.agentSessionId);
    const rows = parse(await list!.handler({}, {})).tasks ?? [];
    expect(rows).toHaveLength(2);

    // The agent's provider session is replaced (rotation). The console rows
    // are untouched, and the list still reads back.
    h.repo.patchAgent(created.agentSessionId, "coordinator", { sdkSessionId: null, generation: 1 });
    const after = parse(await list!.handler({}, {}));
    expect(after.tasks).toHaveLength(2);
    expect(after.tasks?.find((task) => task.sdkTaskId === "1")?.status).toBe("completed");
    expect(after.tasks?.find((task) => task.sdkTaskId === "2")?.status).toBe("pending");
  });

  /**
   * A whole live run passed `taskId: null` on every handoff, so its ledger
   * stayed `pending` from creation to the end and described nothing. The
   * console closes what it can infer — and only what it can infer.
   */
  it("closes an owner's single open unit from a terminal report that names no taskId", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "infer", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("investigate", "pending") });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    const create = h.fake.captured.tools.find((t) => t.name === "task_create")!;
    const list = h.fake.captured.tools.find((t) => t.name === "task_list")!;
    await create.handler({ taskId: "dig", subject: "Trace the collision path", description: "", owner: "scout" }, {});

    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "coordinator",
      handoff: handoff("traced it", "completed"), category: "milestone" });
    expect(parse(await list.handler({}, {})).tasks?.find((task) => task.sdkTaskId === "dig")?.status).toBe("completed");

    // Two open units and no taskId is genuinely ambiguous: the console closes
    // NEITHER rather than guessing, and they ride out as final-report caveats.
    await create.handler({ taskId: "a", subject: "One", description: "", owner: "scout" }, {});
    await create.handler({ taskId: "b", subject: "Two", description: "", owner: "scout" }, {});
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "coordinator",
      handoff: handoff("done with something", "completed"), category: "milestone" });
    const rows = parse(await list.handler({}, {})).tasks ?? [];
    expect(rows.filter((task) => task.status !== "completed").map((task) => task.sdkTaskId).sort()).toEqual(["a", "b"]);
  });
});

describe("requirement-linked ledger units", () => {
  const DOC = `## Requirements
- Auth works end to end
  - Login issues a session token
- \`npm run verify\` passes
`;

  it("links units to requirements across every write path and revives the frontier's blocked annotation", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const draft = h.app.requirements.propose(userSessionId, DOC, "initial");
    h.app.requirements.approve(draft.id, { document: DOC, edited: false });

    // Commission-time units carry the link through the lifecycle path, and
    // the session is delegated r1 so seat-side writes can link inside it.
    const created = h.host.createSession({
      userSessionId, title: "linked", agents: [{ name: "scout", profileId: "explorer" }],
      briefing: handoff("investigate", "pending"),
      requirements: ["r1"],
      tasks: [{ taskId: "base", subject: "Survey auth", owner: "scout", requirementId: "r2" }],
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    const byTaskId = (taskId: string) =>
      h.tasks.listForUserSession(userSessionId).find((task) => task.sdkTaskId === taskId);
    expect(byTaskId("base")?.requirementId).toBe("r2");

    // Seat-side create links INSIDE the delegation; outside is refused with
    // the delegated roots named.
    const create = h.fake.captured.tools.find((t) => t.name === "task_create")!;
    await create.handler({ taskId: "in", subject: "Check token", description: "", owner: "scout", requirementId: "r2" }, {});
    expect(byTaskId("in")?.requirementId).toBe("r2");
    const denied = await create.handler({ taskId: "out", subject: "Verify build", description: "", owner: "scout", requirementId: "r3" }, {}) as { isError?: boolean; content: { text?: string }[] };
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("outside this session's delegated requirements");

    // The per-delivery ledger block anchors each unit to its requirement.
    expect(h.tasks.linesForAgentSession(created.agentSessionId).join("\n")).toContain("Survey auth (scout) → r2");

    // A linked unit waiting on an incomplete dependency makes its
    // requirement BLOCKED on the frontier — the join the annotation reads.
    h.tasks.upsertFromCreate({
      sdkSessionId: consoleTaskListId(created.agentSessionId), sdkTaskId: "gate", subject: "Blocker", owner: "scout",
      attribution: { workspaceId: h.workspaceId, userSessionId, agentSessionId: created.agentSessionId, agent: null },
    });
    h.tasks.upsertFromCreate({
      sdkSessionId: consoleTaskListId(created.agentSessionId), sdkTaskId: "blocked-unit", subject: "Verify", owner: "scout",
      blockedBy: ["gate"], requirementId: "r3",
      attribution: { workspaceId: h.workspaceId, userSessionId, agentSessionId: created.agentSessionId, agent: null },
    });
    const entry = h.app.requirements.frontier(userSessionId).find((row) => row.requirementId === "r3");
    expect(entry?.annotations).toContain("blocked");
  });
});
