/**
 * Dependency scheduling end to end: plan_execute over the fake SDK, the boot
 * redrive's exactly-once contract, the archived-session sweep, the completion
 * gate, and the structural regression the design exists for — a scheduled
 * assignment is a task-layer row, so it can never pin a session "working".
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { HandoffDraft } from "@agentique-console/shared";
import { scheduledAssignments, tasks as tasksTable } from "../db/schema.ts";
import { initMessage, sendHandoffUse, successMessage, toolUseMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeDelegationHarness, restartHarness, type Harness } from "../test-helpers.ts";
import { consoleTaskListId } from "../tasks/service.ts";

const draft = (action: string, taskId: string | null): HandoffDraft => ({
  core: { schemaVersion: 1, taskId, status: "pending", risk: "low", action,
    state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false },
  extension: { kind: "generic", data: {} },
});

const messagesTo = (h: Harness, agentSessionId: string, recipient: string) =>
  h.repo.listMessages("agent", agentSessionId).filter((row) => row.toName === recipient && row.kind === "message");

/** Quiet harness (agents settle without sending) plus two blocked-DAG tasks and a schedule. */
function scheduledFixture() {
  const h = makeDelegationHarness(async function* () { yield initMessage(); yield successMessage(); });
  const userSessionId = h.addUserSession();
  const created = h.host.createSession({
    userSessionId, title: "plan", pattern: "plan_execute",
    agents: [{ name: "architect", profileId: "explorer" }, { name: "builder", profileId: "explorer" }],
    briefing: draft("plan the work", null),
  });
  const listId = consoleTaskListId(created.agentSessionId);
  const attribution = { workspaceId: h.workspaceId, userSessionId, agentSessionId: created.agentSessionId, agent: null };
  h.tasks.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: "t1", subject: "first", owner: "builder", attribution });
  h.tasks.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: "t2", subject: "second", owner: "builder", blockedBy: ["t1"], attribution });
  const scheduled = h.scheduler.intercept({
    agentSessionId: created.agentSessionId, sender: "architect", recipient: "builder",
    category: "assignment", handoff: draft("do t2", "t2"),
  })!;
  return { h, userSessionId, agentSessionId: created.agentSessionId, listId, assignmentId: scheduled.assignmentId };
}

describe("assignment scheduling e2e (fake SDK)", () => {
  it("plan_execute: a blocked assignment schedules, dispatches on completion, and the plan finals", async () => {
    let h: Harness;
    const invocations = new Map<string, number>();
    let finalSent = false;
    // eslint-disable-next-line prefer-const
    h = makeDelegationHarness(async function* (options) {
      const identity = agentRoleOf(options);
      const seat = identity.agent ?? "main";
      const invocation = (invocations.get(seat) ?? 0) + 1;
      invocations.set(seat, invocation);
      yield initMessage();
      if (identity.role === "planner") {
        if (invocation === 1) {
          yield toolUseMessage("c1", "mcp__console_agent__task_create", { taskId: "t1", subject: "build the core", description: "", owner: "builder", blockedBy: [] });
          yield toolUseMessage("c2", "mcp__console_agent__task_create", { taskId: "t2", subject: "polish on top", description: "", owner: "builder", blockedBy: ["t1"] });
          yield sendHandoffUse("a1", "builder", { action: "build the core", status: "pending", category: "assignment", taskId: "t1" });
          // Blocked behind t1: the console schedules it and answers {scheduled:true}.
          yield sendHandoffUse("a2", "builder", { action: "polish on top", status: "pending", category: "assignment", taskId: "t2" });
        } else if (!finalSent && h!.tasks.listForUserSession(h!.repo.listOpenWorkSessions()[0]!.id).every((task) => task.status === "completed")) {
          finalSent = true;
          yield sendHandoffUse("fin", "main", { action: "plan complete", stateSummary: "both tasks done", status: "completed", category: "final" });
        }
      } else if (identity.role === "executor") {
        const taskId = invocation === 1 ? "t1" : "t2";
        yield sendHandoffUse(`done-${taskId}`, "architect", { action: `${taskId} done`, stateSummary: `${taskId} finished`, status: "completed", category: "milestone", taskId });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 15_000);
    const created = h.host.createSession({ userSessionId, title: "widget", pattern: "plan_execute",
      agents: [{ name: "architect", profileId: "explorer" }, { name: "builder", profileId: "explorer" }],
      briefing: draft("build then polish", null) });
    const events = await done;

    // The schedule → dispatch lifecycle happened, in that order.
    const lifecycle = events.filter((event) => event.type.startsWith("task.assignment.")).map((event) => event.type);
    expect(lifecycle).toEqual(["task.assignment.scheduled", "task.assignment.dispatched"]);
    // The planner was told, structurally, not to re-send.
    const scheduledResult = events.find((event) =>
      event.type === "agent_session.tool.completed" && JSON.stringify(event.payload).includes("assignmentId"));
    expect(JSON.stringify(scheduledResult?.payload)).toContain("scheduled");
    // Both assignments reached the builder — the second only after t1 completed.
    expect(messagesTo(h, created.agentSessionId, "builder")).toHaveLength(2);
    const statuses = h.tasks.listForUserSession(userSessionId).map((task) => task.status);
    expect(statuses).toEqual(["completed", "completed"]);
    const row = h.repo.getAgentSession(created.agentSessionId);
    expect(row && h.host.statusOf(row)).toBe("reported");
  });

  it("boot redrive dispatches exactly once across crash windows", async () => {
    const { h, agentSessionId, listId, assignmentId } = scheduledFixture();
    // The blocker completed and the process died before the scheduler acted:
    // write the transition directly, bypassing the live onChange hook.
    h.db.update(tasksTable).set({ status: "completed" }).where(and(eq(tasksTable.sdkSessionId, listId), eq(tasksTable.sdkTaskId, "t1"))).run();

    const r1 = await restartHarness(h);
    expect(r1.bootReport.scheduledAssignmentsRedriven).toBe(1);
    expect(messagesTo(r1, agentSessionId, "builder")).toHaveLength(1);
    expect(r1.db.select().from(scheduledAssignments).where(eq(scheduledAssignments.id, assignmentId)).get()?.status).toBe("dispatched");

    // Crash BETWEEN post and mark: the row reads scheduled, the message exists.
    r1.db.update(scheduledAssignments).set({ status: "scheduled", statusReason: null, dispatchedMessageId: null })
      .where(eq(scheduledAssignments.id, assignmentId)).run();
    const r2 = await restartHarness(r1);
    expect(r2.bootReport.scheduledAssignmentsRedriven).toBe(1);
    // The post-level dedupe (`sched:<id>`) absorbed the replay: still ONE message.
    expect(messagesTo(r2, agentSessionId, "builder")).toHaveLength(1);
    expect(r2.db.select().from(scheduledAssignments).where(eq(scheduledAssignments.id, assignmentId)).get()?.status).toBe("dispatched");
  });

  it("boot cancels rows whose session archived while down", async () => {
    const { h, userSessionId, assignmentId } = scheduledFixture();
    h.host.archiveForUserSession(userSessionId);
    const r = await restartHarness(h);
    expect(r.bootReport.scheduledAssignmentsRedriven).toBe(0);
    const row = r.db.select().from(scheduledAssignments).where(eq(scheduledAssignments.id, assignmentId)).get();
    expect(row).toMatchObject({ status: "canceled", statusReason: "session_archived" });
    expect(r.scheduler.countScheduled(userSessionId)).toBe(0);
  });

  it("the completion gate holds while an assignment is scheduled and releases on cancel", async () => {
    let finalSent = false;
    const invocations = new Map<string, number>();
    const h = makeDelegationHarness(async function* (options) {
      const identity = agentRoleOf(options);
      const seat = identity.agent ?? "main";
      const invocation = (invocations.get(seat) ?? 0) + 1;
      invocations.set(seat, invocation);
      yield initMessage();
      if (identity.role === "planner" && invocation === 1) {
        yield sendHandoffUse("a1", "builder", { action: "do the work", status: "pending", category: "assignment" });
      } else if (identity.role === "planner" && !finalSent) {
        finalSent = true;
        yield sendHandoffUse("fin", "main", { action: "done", stateSummary: "done", status: "completed", category: "final" });
      } else if (identity.role === "executor") {
        yield sendHandoffUse("rep", "architect", { action: "work done", stateSummary: "done", status: "completed", category: "milestone" });
      }
      yield successMessage();
    }, { config: { policy: { completionQuietWindowMs: 60_000 } } });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 15_000);
    const created = h.host.createSession({ userSessionId, title: "gate", pattern: "plan_execute",
      agents: [{ name: "architect", profileId: "explorer" }, { name: "builder", profileId: "explorer" }],
      briefing: draft("do it", null) });
    await done;
    await expect.poll(() => h.completion.isComplete(userSessionId), { timeout: 10_000 }).toBe(true);

    // A live scheduled row for an OPEN session blocks completion...
    const now = new Date().toISOString();
    h.db.insert(scheduledAssignments).values({
      id: "sched_gate", workspaceId: h.workspaceId, userSessionId, agentSessionId: created.agentSessionId,
      taskId: "task_gate", sender: "architect", recipient: "builder", category: "assignment",
      handoff: draft("late work", null), status: "scheduled", statusReason: null,
      dispatchedMessageId: null, createdAt: now, updatedAt: now,
    }).run();
    expect(h.completion.isComplete(userSessionId)).toBe(false);

    // ...and cancel releases it (self-cancel: no notice, so no new delivery).
    h.scheduler.cancel("sched_gate", { actor: "architect" });
    expect(h.completion.isComplete(userSessionId)).toBe(true);
  });

  it("regression: a scheduled assignment never reads as a working session", async () => {
    const { h, agentSessionId, userSessionId } = scheduledFixture();
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    await expect.poll(() => {
      const row = h.repo.getAgentSession(agentSessionId);
      return row ? h.host.statusOf(row) : "gone";
    }, { timeout: 10_000 }).toBe("idle");
    // The wedge the old transport hold produced is structurally dead: the row
    // is still live, and nothing in the transport knows about it.
    expect(h.scheduler.countScheduled(userSessionId)).toBe(1);
    expect(h.repo.listUnackedDeliveries(agentSessionId, "builder")).toHaveLength(0);
  });
});
