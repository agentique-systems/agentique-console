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
  JSON.parse(result.content[0]?.text ?? "null") as { tasks?: { taskId: string; status: string; subject: string }[] };

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
    expect(after.tasks?.find((task) => task.taskId === "1")?.status).toBe("completed");
    expect(after.tasks?.find((task) => task.taskId === "2")?.status).toBe("pending");
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
    expect(parse(await list.handler({}, {})).tasks?.find((task) => task.taskId === "dig")?.status).toBe("completed");

    // Two open units and no taskId is genuinely ambiguous: the console closes
    // NEITHER rather than guessing, and they ride out as final-report caveats.
    await create.handler({ taskId: "a", subject: "One", description: "", owner: "scout" }, {});
    await create.handler({ taskId: "b", subject: "Two", description: "", owner: "scout" }, {});
    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "coordinator",
      handoff: handoff("done with something", "completed"), category: "milestone" });
    const rows = parse(await list.handler({}, {})).tasks ?? [];
    expect(rows.filter((task) => task.status !== "completed").map((task) => task.taskId).sort()).toEqual(["a", "b"]);
  });
});

/**
 * Live-run regressions: one canonical model-facing task id, visible failure
 * for invalid references, and completion truth. A run left `b3` pending
 * forever because its terminal report named the database row id (silently
 * swallowed), and marked `a4` completed while the same report said the
 * task's promised output did not exist.
 */
describe("task identity, sync visibility, and completion truth", () => {
  const parseAny = (result: { content: { type: string; text?: string }[]; isError?: boolean }) =>
    JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown> & {
      taskSync?: { taskId: string; from: string; to: string; resolvedFrom?: string };
    };
  const sendArgs = (over: Record<string, unknown>) => ({
    to: "main", category: "milestone", status: "completed", risk: "low", action: "report",
    stateSummary: "what happened", evidence: [], resultSummary: null, artifacts: [],
    uncertainty: [], nextAction: null, taskId: null, requestExpandedContext: false, ...over,
  });

  async function ledgerHarness() {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "identity", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("investigate", "pending") });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    const tool = (name: string) => h.fake.captured.tools.find((t) => t.name === name)!;
    return { h, userSessionId, agentSessionId: created.agentSessionId, listId: consoleTaskListId(created.agentSessionId), tool };
  }

  it("live-run regression: a terminal report addressed by internal row id updates exactly the canonical task", async () => {
    const { h, agentSessionId, listId, tool } = await ledgerHarness();
    await tool("task_create").handler({ taskId: "b3", subject: "Latency accounting", description: "", owner: "scout" }, {});
    const rowId = h.tasks.resolveForList(listId, "b3")!.id;

    const result = parseAny(await tool("send_handoff").handler(sendArgs({
      taskId: rowId, resultSummary: "latency accounting landed with tests",
    }), {}) as { content: { type: string; text?: string }[] });
    // The legacy row id resolved EXPLICITLY: normalized, confirmed, and taught.
    expect(result.taskSync).toMatchObject({ taskId: "b3", to: "completed", resolvedFrom: rowId });
    expect(h.tasks.resolveForList(listId, "b3")?.status).toBe("completed");
    // The journaled record carries the canonical id, not the row id.
    const messages = h.repo.listMessages("agent", agentSessionId);
    const handoffId = (messages[messages.length - 1]!.payload as { handoff: { id: string } }).handoff.id;
    expect(h.handoffs.get(handoffId).core.taskId).toBe("b3");
  });

  it("an unknown task reference fails visibly at the boundary; the corrected re-send updates exactly once", async () => {
    const { h, agentSessionId, listId, tool } = await ledgerHarness();
    await tool("task_create").handler({ taskId: "b3", subject: "Latency accounting", description: "", owner: "scout" }, {});
    const before = h.repo.listMessages("agent", agentSessionId).length;

    const bad = await tool("send_handoff").handler(sendArgs({
      taskId: "task_row_xyz", resultSummary: "done",
    }), {}) as { isError?: boolean; content: { text?: string }[] };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain('task reference "task_row_xyz"');
    expect(bad.content[0]?.text).toContain("b3");
    // Nothing was journaled and nothing moved: no half-report, no half-ledger.
    expect(h.repo.listMessages("agent", agentSessionId).length).toBe(before);
    expect(h.tasks.resolveForList(listId, "b3")?.status).toBe("pending");

    const corrected = parseAny(await tool("send_handoff").handler(sendArgs({
      taskId: "b3", resultSummary: "done",
    }), {}) as { content: { type: string; text?: string }[] });
    expect(corrected.taskSync).toMatchObject({ taskId: "b3", from: "pending", to: "completed" });
    expect(h.tasks.resolveForList(listId, "b3")?.status).toBe("completed");
  });

  it("live-run regression: a completed claim with no stated deliverable cannot complete the task; honest blocked finals keep dependents parked; genuine completion releases them exactly once", async () => {
    const { h, agentSessionId, listId, tool } = await ledgerHarness();
    await tool("task_create").handler({ taskId: "a4", subject: "Measure the three candidate mechanics", description: "", owner: "scout" }, {});
    await tool("task_create").handler({ taskId: "verdict", subject: "Judge the candidates", description: "", owner: "scout", blockedBy: ["a4"] }, {});
    const assignDraft = handoff("judge the candidates", "pending");
    const scheduled = h.scheduler.intercept({
      agentSessionId, sender: "coordinator", recipient: "scout", category: "assignment",
      handoff: { ...assignDraft, core: { ...assignDraft.core, taskId: "verdict" } },
    })!;
    expect(scheduled.awaiting.map((row) => row.taskId)).toEqual(["a4"]);
    const messagesToScout = () => h.repo.listMessages("agent", agentSessionId).filter((row) => row.toName === "scout" && row.kind === "message").length;
    const dispatchesBefore = messagesToScout();

    // The a4 contradiction: "completed" while the structured result says the
    // promised output is absent. Rejected with the two honest exits named.
    const contradiction = await tool("send_handoff").handler(sendArgs({
      taskId: "a4", status: "completed", resultSummary: null,
    }), {}) as { isError?: boolean; content: { text?: string }[] };
    expect(contradiction.isError).toBe(true);
    expect(contradiction.content[0]?.text).toContain("resultSummary");
    expect(h.tasks.resolveForList(listId, "a4")?.status).toBe("pending");

    // The honest terminal report: blocked. Partial artifacts ride the report;
    // the task stays structurally open and the dependent stays parked.
    const blocked = parseAny(await tool("send_handoff").handler(sendArgs({
      taskId: "a4", status: "blocked",
      stateSummary: "harness and validation built; no candidate measured yet",
      artifacts: [{ kind: "file", ref: "docs/movement-lab.md" }],
    }), {}) as { content: { type: string; text?: string }[] });
    expect(blocked.taskSync).toMatchObject({ taskId: "a4", to: "pending" });
    expect(h.tasks.resolveForList(listId, "a4")?.status).toBe("pending");
    expect(messagesToScout()).toBe(dispatchesBefore);

    // Genuine completion states its deliverable and releases the dependent
    // exactly once; a duplicate terminal delivery is idempotent.
    parseAny(await tool("send_handoff").handler(sendArgs({
      taskId: "a4", resultSummary: "all three candidates measured; table in docs/movement-lab.md",
    }), {}) as { content: { type: string; text?: string }[] });
    expect(h.tasks.resolveForList(listId, "a4")?.status).toBe("completed");
    expect(messagesToScout()).toBe(dispatchesBefore + 1);
    const duplicate = parseAny(await tool("send_handoff").handler(sendArgs({
      taskId: "a4", resultSummary: "all three candidates measured; table in docs/movement-lab.md",
    }), {}) as { content: { type: string; text?: string }[] });
    expect(duplicate.taskSync).toMatchObject({ taskId: "a4", from: "completed", to: "completed" });
    expect(messagesToScout()).toBe(dispatchesBefore + 1);
  });

  it("an invalid reference on a console-path handoff is journaled on the report and emitted as task.sync.failed — never swallowed", async () => {
    const { h, agentSessionId, listId } = await ledgerHarness();
    h.tasks.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: "b3", subject: "Latency accounting", owner: "scout",
      attribution: { workspaceId: h.workspaceId, userSessionId: h.repo.getAgentSession(agentSessionId)!.userSessionId, agentSessionId, agent: null } });

    const failed = collectUntil(h.bus, (event) => event.type === "task.sync.failed", 5_000);
    const reportDraft = handoff("latency accounting done", "completed");
    const message = h.host.post({ agentSessionId, speaker: { kind: "agent", name: "scout" }, to: "coordinator",
      handoff: { ...reportDraft, core: { ...reportDraft.core, taskId: "task_row_xyz" } },
      category: "milestone" });
    const events = await failed;
    const sync = events.find((event) => event.type === "task.sync.failed");
    expect(sync?.payload).toMatchObject({ agentSessionId, sender: "scout", taskRef: "task_row_xyz", reason: "unknown_task_ref" });
    // The delivered report itself carries the failure — no log-reading needed.
    expect(message.text).toContain("ledger sync failed");
    expect(h.tasks.resolveForList(listId, "b3")?.status).toBe("pending");
  });

  it("task_update refuses unknown references and resolves legacy row ids to the canonical id", async () => {
    const { h, listId, tool } = await ledgerHarness();
    await tool("task_create").handler({ taskId: "b3", subject: "Latency accounting", description: "", owner: "scout" }, {});

    const bad = await tool("task_update").handler({ taskId: "ghost", status: "completed" }, {}) as { isError?: boolean; content: { text?: string }[] };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain('task reference "ghost"');
    expect(h.tasks.resolveForList(listId, "b3")?.status).toBe("pending");

    const rowId = h.tasks.resolveForList(listId, "b3")!.id;
    const viaRow = parseAny(await tool("task_update").handler({ taskId: rowId, status: "in_progress" }, {}) as { content: { type: string; text?: string }[] });
    expect(viaRow).toMatchObject({ taskId: "b3", updated: true, status: "in_progress", resolvedFrom: rowId });
  });

  it("model-facing surfaces expose only the canonical taskId", async () => {
    const { h, agentSessionId, tool } = await ledgerHarness();
    await tool("task_create").handler({ taskId: "a4", subject: "Measure candidates", description: "", owner: "scout" }, {});
    await tool("task_create").handler({ taskId: "verdict", subject: "Judge", description: "", owner: "scout", blockedBy: ["a4"] }, {});

    const rows = (parseAny(await tool("task_list").handler({}, {}) as { content: { type: string; text?: string }[] }) as unknown as { tasks: Record<string, unknown>[] }).tasks;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.taskId).toBeDefined();
      expect(row).not.toHaveProperty("id");
      expect(row).not.toHaveProperty("sdkTaskId");
      expect(row).not.toHaveProperty("sdkSessionId");
    }
    // Dependencies render in the same canonical vocabulary.
    expect(rows.find((row) => row.taskId === "verdict")?.blockedBy).toEqual(["a4"]);
    // The prompt ledger line teaches the same id.
    expect(h.tasks.linesForAgentSession(agentSessionId).join("\n")).toContain("- a4 [pending] Measure candidates (scout)");
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
