/**
 * The task-dependency scheduler over the real composition root: scheduled
 * assignments are task-layer rows, never transport rows — nothing exists in
 * the journal or mailbox until dispatch.
 */
import { describe, expect, it } from "vitest";
import type { HandoffDraft } from "@agentique-console/shared";
import { InvalidInputError } from "../errors.ts";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeHarness, type Harness } from "../test-helpers.ts";
import { consoleTaskListId } from "./service.ts";

const draft = (action: string, taskId: string | null): HandoffDraft => ({
  core: { schemaVersion: 1, taskId, status: "pending", risk: "low", action,
    state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false },
  extension: { kind: "generic", data: {} },
});

function planSession(h: Harness): { userSessionId: string; agentSessionId: string; listId: string } {
  const userSessionId = h.addUserSession();
  const created = h.host.createSession({
    userSessionId, title: "plan", pattern: "plan_execute",
    agents: [{ name: "architect", profileId: "explorer" }, { name: "builder", profileId: "explorer" }, { name: "helper", profileId: "explorer" }],
    briefing: draft("plan the work", null),
  });
  return { userSessionId, agentSessionId: created.agentSessionId, listId: consoleTaskListId(created.agentSessionId) };
}

function addTask(h: Harness, s: ReturnType<typeof planSession>, taskId: string, subject: string, blockedBy: string[] = []): void {
  h.tasks.upsertFromCreate({
    sdkSessionId: s.listId, sdkTaskId: taskId, subject, owner: "builder", blockedBy,
    attribution: { workspaceId: h.workspaceId, userSessionId: s.userSessionId, agentSessionId: s.agentSessionId, agent: null },
  });
}

const messagesTo = (h: Harness, agentSessionId: string, recipient: string) =>
  h.repo.listMessages("agent", agentSessionId).filter((row) => row.toName === recipient && row.kind === "message");

describe("AssignmentScheduler", () => {
  it("schedules a blocked assignment with zero transport rows, then dispatches on completion", async () => {
    const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
    const s = planSession(h);
    addTask(h, s, "a", "first");
    addTask(h, s, "b", "second", ["a"]);

    const result = h.scheduler.intercept({ agentSessionId: s.agentSessionId, sender: "architect", recipient: "builder", category: "assignment", handoff: draft("do b", "b") });
    expect(result).not.toBeNull();
    expect(result!.awaiting).toEqual([{ taskId: "a", subject: "first", status: "pending" }]);

    // The structural guarantee: no journal row, no mailbox row, until dispatch.
    expect(messagesTo(h, s.agentSessionId, "builder")).toHaveLength(0);
    expect(h.repo.listUnackedDeliveries(s.agentSessionId, "builder")).toHaveLength(0);
    const wired = h.tasks.listForUserSession(s.userSessionId).find((task) => task.sdkTaskId === "b");
    expect(wired?.ready).toBe(false);
    expect(wired?.scheduledAssignment).toMatchObject({ id: result!.assignmentId, sender: "architect", recipient: "builder" });

    h.tasks.markCompleted(s.listId, "a");

    const sent = messagesTo(h, s.agentSessionId, "builder");
    expect(sent).toHaveLength(1);
    const record = h.repo.latestHandoff({ userSessionId: s.userSessionId, agentSessionId: s.agentSessionId, recipient: "builder" });
    expect(record?.sender).toBe("architect");
    expect(record?.core.state.summary).toContain("Console: dispatched from the schedule");
    expect(record?.core.state.summary).toContain("do b");
    // Ledger sync fired at the true start of work.
    expect(h.tasks.listForUserSession(s.userSessionId).find((task) => task.sdkTaskId === "b")?.status).toBe("in_progress");
    const events = await collectUntil(h.bus, (event) => event.type === "task.assignment.dispatched");
    const scheduled = events.find((event) => event.type === "task.assignment.scheduled");
    expect(scheduled?.payload).toMatchObject({ assignment: { id: result!.assignmentId, status: "scheduled" } });
    expect(events.at(-1)?.payload).toMatchObject({ assignment: { id: result!.assignmentId, status: "dispatched" } });
  });

  it("dispatches released dependents FIFO by assignment creation", async () => {
    const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
    const s = planSession(h);
    addTask(h, s, "a", "first");
    addTask(h, s, "b", "second", ["a"]);
    addTask(h, s, "c", "third", ["a"]);

    const first = h.scheduler.intercept({ agentSessionId: s.agentSessionId, sender: "architect", recipient: "builder", category: "assignment", handoff: draft("do b", "b") });
    const second = h.scheduler.intercept({ agentSessionId: s.agentSessionId, sender: "architect", recipient: "builder", category: "assignment", handoff: draft("do c", "c") });
    expect(first && second).toBeTruthy();

    h.tasks.markCompleted(s.listId, "a");
    const sent = messagesTo(h, s.agentSessionId, "builder");
    expect(sent).toHaveLength(2);
    expect(sent[0]!.seq).toBeLessThan(sent[1]!.seq);
    expect(sent[0]!.text).toContain("do b");
    expect(sent[1]!.text).toContain("do c");
  });

  it("re-sending the same taskId supersedes the live row (re-target)", async () => {
    const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
    const s = planSession(h);
    addTask(h, s, "a", "first");
    addTask(h, s, "b", "second", ["a"]);

    const toBuilder = h.scheduler.intercept({ agentSessionId: s.agentSessionId, sender: "architect", recipient: "builder", category: "assignment", handoff: draft("do b", "b") })!;
    const toHelper = h.scheduler.intercept({ agentSessionId: s.agentSessionId, sender: "architect", recipient: "helper", category: "assignment", handoff: draft("do b differently", "b") })!;
    expect(toHelper.assignmentId).not.toBe(toBuilder.assignmentId);

    const events = await collectUntil(h.bus, (event) => event.type === "task.assignment.canceled");
    expect(events.at(-1)?.payload).toMatchObject({ assignment: { id: toBuilder.assignmentId, status: "canceled", statusReason: "replaced" } });

    h.tasks.markCompleted(s.listId, "a");
    expect(messagesTo(h, s.agentSessionId, "builder")).toHaveLength(0);
    expect(messagesTo(h, s.agentSessionId, "helper")).toHaveLength(1);
  });

  it("removeBlockedBy releases the assignment and the projection cannot resurrect the edge", async () => {
    const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
    const s = planSession(h);
    addTask(h, s, "a", "first");
    addTask(h, s, "b", "second", ["a"]);
    h.scheduler.intercept({ agentSessionId: s.agentSessionId, sender: "architect", recipient: "builder", category: "assignment", handoff: draft("do b", "b") });

    h.tasks.applyUpdate({ sdkSessionId: s.listId, sdkTaskId: "b", patch: { removeBlockedBy: ["a"] } });

    // Released without "a" ever completing.
    expect(messagesTo(h, s.agentSessionId, "builder")).toHaveLength(1);
    expect(h.tasks.listDependencies(h.workspaceId)).toHaveLength(0);
    // A later write to the ex-blocker re-runs projection sync; the edge stays dead.
    h.tasks.applyUpdate({ sdkSessionId: s.listId, sdkTaskId: "a", patch: { subject: "first, renamed" } });
    expect(h.tasks.listDependencies(h.workspaceId)).toHaveLength(0);
    expect(h.tasks.listForUserSession(s.userSessionId).find((task) => task.sdkTaskId === "b")?.blockedBy).toEqual([]);
  });

  it("a deleted blocker leaves dependents scheduled and notices the assigner once", async () => {
    const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
    const s = planSession(h);
    addTask(h, s, "a", "first");
    addTask(h, s, "b", "second", ["a"]);
    const scheduled = h.scheduler.intercept({ agentSessionId: s.agentSessionId, sender: "architect", recipient: "builder", category: "assignment", handoff: draft("do b", "b") })!;

    h.tasks.applyUpdate({ sdkSessionId: s.listId, sdkTaskId: "a", patch: { status: "deleted" } });

    // Complete-only: deletion does not satisfy the dependency.
    expect(messagesTo(h, s.agentSessionId, "builder")).toHaveLength(0);
    const notices = messagesTo(h, s.agentSessionId, "architect").filter((row) => row.speakerName === "console");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("Dependency deleted");

    // Boot re-notices dedupe-safe: still exactly one.
    expect(h.scheduler.boot()).toBe(0);
    expect(messagesTo(h, s.agentSessionId, "architect").filter((row) => row.speakerName === "console")).toHaveLength(1);
    expect(h.tasks.listForUserSession(s.userSessionId).find((task) => task.sdkTaskId === "b")?.scheduledAssignment?.id).toBe(scheduled.assignmentId);
  });

  it("a main-assigned schedule notices main and wakes it on a deleted blocker", async () => {
    const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
    const s = planSession(h);
    addTask(h, s, "a", "first");
    addTask(h, s, "b", "second", ["a"]);
    h.scheduler.intercept({ agentSessionId: s.agentSessionId, sender: "main", recipient: "architect", category: "assignment", handoff: draft("do b", "b") });

    const woke = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned");
    h.tasks.applyUpdate({ sdkSessionId: s.listId, sdkTaskId: "a", patch: { status: "deleted" } });
    await woke;
    const notices = messagesTo(h, s.agentSessionId, "main").filter((row) => row.speakerName === "console");
    expect(notices).toHaveLength(1);
  });

  it("out-of-band completion cancels the schedule and notices the assigner", async () => {
    const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
    const s = planSession(h);
    addTask(h, s, "a", "first");
    addTask(h, s, "b", "second", ["a"]);
    const scheduled = h.scheduler.intercept({ agentSessionId: s.agentSessionId, sender: "architect", recipient: "builder", category: "assignment", handoff: draft("do b", "b") })!;

    // The executor did the work anyway; the pending dispatch must not fire later.
    h.tasks.markCompleted(s.listId, "b");
    const events = await collectUntil(h.bus, (event) => event.type === "task.assignment.canceled");
    expect(events.at(-1)?.payload).toMatchObject({ assignment: { id: scheduled.assignmentId, statusReason: "task_completed" } });

    h.tasks.markCompleted(s.listId, "a");
    expect(messagesTo(h, s.agentSessionId, "builder")).toHaveLength(0);
    const notices = messagesTo(h, s.agentSessionId, "architect").filter((row) => row.speakerName === "console");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("canceled");
  });

  it("rejects self- and cross-session dependencies", async () => {
    const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
    const s1 = planSession(h);
    const s2 = planSession(h);
    addTask(h, s1, "a", "first");
    addTask(h, s2, "x", "other-session task");
    const a = h.tasks.resolveForList(s1.listId, "a")!;
    const x = h.tasks.resolveForList(s2.listId, "x")!;

    expect(() => h.tasks.addDependency(a.id, a.id)).toThrow(InvalidInputError);
    expect(() => h.tasks.addDependency(a.id, x.id)).toThrow(/cross sessions/);
  });

  it("forward-referenced blockedBy binds when the blocker is created", async () => {
    const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
    const s = planSession(h);
    addTask(h, s, "b", "second", ["c"]);
    // The ref is dangling: no edge yet, so the task reads ready.
    expect(h.tasks.resolveForList(s.listId, "b")?.ready).toBe(true);

    addTask(h, s, "c", "third");
    const bound = h.tasks.resolveForList(s.listId, "b")!;
    expect(bound.ready).toBe(false);
    expect(bound.dependencyIds).toEqual([h.tasks.resolveForList(s.listId, "c")!.id]);

    h.scheduler.intercept({ agentSessionId: s.agentSessionId, sender: "architect", recipient: "builder", category: "assignment", handoff: draft("do b", "b") });
    expect(messagesTo(h, s.agentSessionId, "builder")).toHaveLength(0);
    h.tasks.markCompleted(s.listId, "c");
    expect(messagesTo(h, s.agentSessionId, "builder")).toHaveLength(1);
  });

  it("does not intercept unblocked, in-progress, or task-less assignments", async () => {
    const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
    const s = planSession(h);
    addTask(h, s, "a", "first");

    expect(h.scheduler.intercept({ agentSessionId: s.agentSessionId, sender: "architect", recipient: "builder", category: "assignment", handoff: draft("no task", null) })).toBeNull();
    expect(h.scheduler.intercept({ agentSessionId: s.agentSessionId, sender: "architect", recipient: "builder", category: "assignment", handoff: draft("ready task", "a") })).toBeNull();
    h.tasks.applyUpdate({ sdkSessionId: s.listId, sdkTaskId: "a", patch: { status: "in_progress" } });
    expect(h.scheduler.intercept({ agentSessionId: s.agentSessionId, sender: "architect", recipient: "builder", category: "assignment", handoff: draft("already running", "a") })).toBeNull();
  });
});
