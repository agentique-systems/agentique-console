import { describe, expect, it } from "vitest";
import { openDb } from "../db/client.ts";
import { EventBus } from "../events/bus.ts";
import { buildTaskHooks } from "./hooks.ts";
import { TaskService, type TaskAttribution } from "./service.ts";

const ATTR: TaskAttribution = {
  workspaceId: "ws_1",
  userSessionId: "us_1",
  agentSessionId: "as_1",
  participant: "scout",
};

function makeHooks() {
  const { db } = openDb(":memory:");
  const bus = new EventBus(db);
  const tasks = new TaskService(db, bus);
  const hooks = buildTaskHooks(tasks, ATTR) as unknown as Record<
    string,
    { matcher?: string; hooks: ((input: unknown) => Promise<unknown>)[] }[]
  >;
  const fire = (event: string, input: unknown) =>
    hooks[event]![0]!.hooks[0]!(input);
  return { tasks, bus, fire };
}

describe("task hooks", () => {
  it("mirrors TaskCreated and TaskCompleted", async () => {
    const { tasks, bus, fire } = makeHooks();
    await fire("TaskCreated", {
      session_id: "sdk-1",
      task_id: "1",
      task_subject: "Investigate the parser",
      task_description: "find the entry point",
    });
    let [task] = tasks.listForUserSession("us_1");
    expect(task).toMatchObject({
      sdkTaskId: "1",
      subject: "Investigate the parser",
      status: "pending",
      owner: "scout",
      agentSessionId: "as_1",
    });

    await fire("TaskCompleted", { session_id: "sdk-1", task_id: "1" });
    [task] = tasks.listForUserSession("us_1");
    expect(task?.status).toBe("completed");
    expect(bus.headSeq()).toBe(2); // task.created + task.updated
  });

  it("mirrors TaskCreate/TaskUpdate tool traffic with deps and owner", async () => {
    const { tasks, fire } = makeHooks();
    await fire("PostToolUse", {
      session_id: "sdk-1",
      tool_name: "TaskCreate",
      tool_input: {
        subject: "Build it",
        description: "the build task",
        activeForm: "Building it",
      },
      tool_response: { task: { id: "7", subject: "Build it" } },
    });
    await fire("PostToolUse", {
      session_id: "sdk-1",
      tool_name: "TaskUpdate",
      tool_input: {
        taskId: "7",
        status: "in_progress",
        owner: "coder",
        addBlockedBy: ["6"],
        metadata: { lane: "backend" },
      },
      tool_response: {
        success: true,
        taskId: "7",
        updatedFields: ["status", "owner", "blockedBy", "metadata"],
      },
    });
    const [task] = tasks.listForUserSession("us_1");
    expect(task).toMatchObject({
      sdkTaskId: "7",
      status: "in_progress",
      owner: "coder",
      blockedBy: ["6"],
      metadata: { lane: "backend" },
      activeForm: "Building it",
    });
  });

  it("is idempotent across TaskCreated and PostToolUse(TaskCreate) races", async () => {
    const { tasks, fire } = makeHooks();
    await fire("TaskCreated", {
      session_id: "sdk-1",
      task_id: "3",
      task_subject: "Once",
    });
    await fire("PostToolUse", {
      session_id: "sdk-1",
      tool_name: "TaskCreate",
      tool_input: { subject: "Once", description: "full detail" },
      tool_response: { task: { id: "3", subject: "Once" } },
    });
    const list = tasks.listForUserSession("us_1");
    expect(list).toHaveLength(1);
    expect(list[0]?.description).toBe("full detail");
  });

  it("repairs drift from TaskList output", async () => {
    const { tasks, fire } = makeHooks();
    await fire("PostToolUse", {
      session_id: "sdk-1",
      tool_name: "TaskList",
      tool_response: {
        tasks: [
          { id: "9", subject: "Discovered", status: "in_progress", owner: "scout" },
        ],
      },
    });
    const [task] = tasks.listForUserSession("us_1");
    expect(task).toMatchObject({
      sdkTaskId: "9",
      subject: "Discovered",
      status: "in_progress",
    });
  });

  it("never throws on malformed input", async () => {
    const { fire } = makeHooks();
    await expect(fire("TaskCreated", null)).resolves.toEqual({});
    await expect(
      fire("PostToolUse", { tool_name: "TaskUpdate", tool_input: 42 }),
    ).resolves.toEqual({});
  });

  it("formats wake-digest task lines", async () => {
    const { tasks, fire } = makeHooks();
    await fire("TaskCreated", {
      session_id: "sdk-1",
      task_id: "1",
      task_subject: "Alpha",
    });
    expect(tasks.linesForAgentSession("as_1")).toEqual([
      "- [pending] Alpha (scout)",
    ]);
    expect(tasks.linesForAgentSession("as_other")).toEqual([]);
  });
});
