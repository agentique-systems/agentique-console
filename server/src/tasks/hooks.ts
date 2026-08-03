/**
 * Task-mirror hooks, attached to every orchestrator and specialist turn.
 * TaskCreated/TaskCompleted catch lifecycle; PostToolUse on the task tools
 * carries both tool_input and tool_response, so state reconstruction needs no
 * PreToolUse pairing. Callbacks never throw — a mirror failure logs and the
 * turn continues.
 */
import type { SdkOptions } from "../sdk/types.ts";
import type { TaskAttribution, TaskService } from "./service.ts";

type HookCallback = (input: unknown) => Promise<Record<string, never>>;

function safe(handler: (input: Record<string, unknown>) => void): HookCallback {
  return async (input: unknown) => {
    try {
      handler((input ?? {}) as Record<string, unknown>);
    } catch (error) {
      console.error("task hook failed:", error);
    }
    return {};
  };
}

export function buildTaskHooks(
  tasks: TaskService,
  attribution: TaskAttribution,
): SdkOptions["hooks"] {
  const onTaskCreated = safe((input) => {
    const sdkSessionId = input.session_id;
    const taskId = input.task_id;
    if (typeof sdkSessionId !== "string" || typeof taskId !== "string") return;
    tasks.upsertFromCreate({
      sdkSessionId,
      sdkTaskId: taskId,
      subject: typeof input.task_subject === "string" ? input.task_subject : "",
      ...(typeof input.task_description === "string"
        ? { description: input.task_description }
        : {}),
      attribution,
    });
  });

  const onTaskCompleted = safe((input) => {
    const sdkSessionId = input.session_id;
    const taskId = input.task_id;
    if (typeof sdkSessionId !== "string" || typeof taskId !== "string") return;
    tasks.markCompleted(sdkSessionId, taskId);
  });

  const onTaskToolUse = safe((input) => {
    const sdkSessionId = input.session_id;
    if (typeof sdkSessionId !== "string") return;
    const toolName = input.tool_name;
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const toolResponse = (input.tool_response ?? {}) as Record<string, unknown>;

    switch (toolName) {
      case "TaskCreate": {
        const task = toolResponse.task as { id?: string } | undefined;
        if (typeof task?.id !== "string") return;
        tasks.upsertFromCreate({
          sdkSessionId,
          sdkTaskId: task.id,
          subject: typeof toolInput.subject === "string" ? toolInput.subject : "",
          ...(typeof toolInput.description === "string"
            ? { description: toolInput.description }
            : {}),
          ...(typeof toolInput.activeForm === "string"
            ? { activeForm: toolInput.activeForm }
            : {}),
          ...(toolInput.metadata !== undefined
            ? { metadata: toolInput.metadata as Record<string, unknown> }
            : {}),
          attribution,
        });
        return;
      }
      case "TaskUpdate": {
        if (typeof toolInput.taskId !== "string") return;
        if (toolResponse.success === false) return;
        tasks.applyUpdate({
          sdkSessionId,
          sdkTaskId: toolInput.taskId,
          patch: {
            ...(typeof toolInput.subject === "string"
              ? { subject: toolInput.subject }
              : {}),
            ...(typeof toolInput.description === "string"
              ? { description: toolInput.description }
              : {}),
            ...(typeof toolInput.activeForm === "string"
              ? { activeForm: toolInput.activeForm }
              : {}),
            ...(typeof toolInput.status === "string"
              ? {
                  status: toolInput.status as
                    | "pending"
                    | "in_progress"
                    | "completed"
                    | "deleted",
                }
              : {}),
            ...(typeof toolInput.owner === "string"
              ? { owner: toolInput.owner }
              : {}),
            ...(Array.isArray(toolInput.addBlocks)
              ? { addBlocks: toolInput.addBlocks as string[] }
              : {}),
            ...(Array.isArray(toolInput.addBlockedBy)
              ? { addBlockedBy: toolInput.addBlockedBy as string[] }
              : {}),
            ...(toolInput.metadata !== undefined
              ? { metadata: toolInput.metadata as Record<string, unknown> }
              : {}),
          },
          ...(Array.isArray(toolResponse.updatedFields)
            ? { updatedFields: toolResponse.updatedFields as string[] }
            : {}),
        });
        return;
      }
      case "TaskList": {
        const listed = toolResponse.tasks;
        if (Array.isArray(listed)) {
          tasks.reconcileFromList(
            sdkSessionId,
            listed as Parameters<TaskService["reconcileFromList"]>[1],
            attribution,
          );
        }
        return;
      }
      case "TaskGet": {
        const task = toolResponse.task as
          | {
              id?: string;
              subject?: string;
              status?: "pending" | "in_progress" | "completed";
              blockedBy?: string[];
            }
          | null
          | undefined;
        if (task && typeof task.id === "string") {
          tasks.reconcileFromList(
            sdkSessionId,
            [
              {
                id: task.id,
                subject: task.subject ?? "",
                status: task.status ?? "pending",
                ...(task.blockedBy === undefined
                  ? {}
                  : { blockedBy: task.blockedBy }),
              },
            ],
            attribution,
          );
        }
        return;
      }
      default:
        return;
    }
  });

  return {
    TaskCreated: [{ hooks: [onTaskCreated] }],
    TaskCompleted: [{ hooks: [onTaskCompleted] }],
    PostToolUse: [
      {
        matcher: "TaskCreate|TaskUpdate|TaskGet|TaskList",
        hooks: [onTaskToolUse],
      },
    ],
  } as SdkOptions["hooks"];
}
