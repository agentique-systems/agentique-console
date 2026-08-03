/**
 * The console MCP server, bound to one UserSession: create_agent_session (the
 * spawn-plan factory), read/list, and the coordinator's task board. Execution
 * and messaging are native (Agent + SendMessage); these tools only register
 * metadata and read derived state.
 */
import { z } from "zod";
import type { AgentSessionHost } from "../agent-sessions/host.ts";
import {
  COORDINATOR_SEAT,
  ORCHESTRATOR_SEAT,
  spawnNameOf,
} from "../agent-sessions/spawn-names.ts";
import { SESSION_ORCHESTRATOR_AGENT } from "./options.ts";
import { ApiError } from "../api/errors.ts";
import type { EventBus } from "../events/bus.ts";
import type { Repo } from "../db/repo.ts";
import { newId } from "../ids.ts";
import type { ConsoleSdk, SdkToolResult } from "../sdk/types.ts";
import type { TaskService } from "../tasks/service.ts";

/**
 * Console-owned tasks are keyed by a synthetic SDK-session id: the
 * sub-orchestrator is a subagent with no SDK session of its own, and the
 * synthetic key keeps its list disjoint from every hook-mirrored one.
 */
export function consoleTaskListId(agentSessionId: string): string {
  return `console:${agentSessionId}:${ORCHESTRATOR_SEAT}`;
}

function ok(value: unknown): SdkToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): SdkToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function guarded(
  run: () => unknown | Promise<unknown>,
): Promise<SdkToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    if (error instanceof ApiError) return fail(error.message);
    throw error;
  }
}

export interface ConsoleToolsInput {
  sdk: ConsoleSdk;
  host: AgentSessionHost;
  repo: Repo;
  bus: EventBus;
  userSessionId: string;
  /** A2: console-owned task tools (absent until wired in main/tests). */
  tasks?: TaskService;
}

export function buildConsoleMcpServer(input: ConsoleToolsInput): unknown {
  const { sdk, host, repo, bus, userSessionId, tasks } = input;

  /** Tools operate only on this UserSession's agent sessions. */
  const owned = (agentSessionId: string) => {
    const session = repo.getAgentSession(agentSessionId);
    if (!session || session.userSessionId !== userSessionId) {
      throw new ApiError(
        404,
        "not_found",
        `no agent session ${agentSessionId} in this conversation`,
      );
    }
    return session;
  };

  const tools = [
    sdk.tool(
      "create_agent_session",
      "Register a new agent session (1-4 specialist seats) and get its SPAWN PLAN: the exact Agent-tool calls to make, in order. Spawn every entry verbatim (name, subagent_type, prompt), specialists first, coordinator LAST, all with run_in_background true. The agents talk via SendMessage; the coordinator reports to you.",
      {
        title: z.string().describe("Short working title for the session"),
        mode: z
          .enum(["execute", "plan_execute"])
          .describe(
            "plan_execute makes seats plan first and route the plan to you for approval",
          ),
        agents: z
          .array(
            z.object({
              name: z
                .string()
                .describe("Seat name, e.g. 'scout' — addressable via @name"),
              preset: z
                .enum(["explorer", "implementer", "reviewer", "researcher"])
                .optional()
                .describe("Built-in brief to use"),
              instructions: z
                .string()
                .optional()
                .describe(
                  "Ad-hoc brief (required when no preset; appended to the preset otherwise)",
                ),
              model: z.string().optional().describe("Model override"),
            }),
          )
          .min(1)
          .max(4),
        briefing: z
          .string()
          .optional()
          .describe(
            "The coordinator's mission: what the session must deliver and any constraints (embedded into its spawn prompt)",
          ),
      },
      async (args: {
        title: string;
        mode: "execute" | "plan_execute";
        agents: {
          name: string;
          preset?: "explorer" | "implementer" | "reviewer" | "researcher";
          instructions?: string;
          model?: string;
        }[];
        briefing?: string;
      }) =>
        guarded(() => {
          const { agentSessionId, participants } = host.createSession({
            userSessionId,
            title: args.title,
            mode: args.mode,
            agents: args.agents,
          });
          const planning = args.mode === "plan_execute";
          const coordinatorName = spawnNameOf(agentSessionId, COORDINATOR_SEAT);
          const seatNames = participants.map((seat) =>
            spawnNameOf(agentSessionId, seat),
          );
          const rosterLine = `Agent session ${agentSessionId} "${args.title}". Coordinator: ${coordinatorName}. Seats: ${seatNames.join(", ")}.`;
          const spawns = [
            ...args.agents.map((agent, index) => ({
              name: seatNames[index] as string,
              subagent_type: `${agent.preset ?? "adhoc"}${planning ? "-planning" : ""}`,
              ...(agent.model === undefined ? {} : { model: agent.model }),
              prompt: [
                `You are seat "${agent.name}" (spawn name ${seatNames[index]}) in ${rosterLine}`,
                ...(agent.instructions === undefined
                  ? []
                  : [`Your brief: ${agent.instructions}`]),
                planning
                  ? "Draft your part of the plan and SendMessage it to the coordinator, then stop."
                  : "Await your coordinator's brief via SendMessage; report results to it by name.",
              ].join("\n"),
            })),
            {
              name: coordinatorName,
              subagent_type: SESSION_ORCHESTRATOR_AGENT,
              prompt: [
                `You coordinate ${rosterLine}`,
                planning
                  ? "This session is in its PLANNING phase: collect each seat's plan, then send the assembled plan to main for approval. Do not let seats execute until main approves."
                  : "Brief the seats now and drive the session to completion.",
                ...(args.briefing === undefined
                  ? []
                  : [`Mission from the Orchestrator: ${args.briefing}`]),
              ].join("\n"),
            },
          ];
          return {
            agentSessionId,
            spawns,
            note: "Spawn each entry with ONE Agent tool call, in this order (coordinator last). Copy ALL THREE fields as the Agent tool's parameters: `name` (REQUIRED — without it agents cannot SendMessage each other), `subagent_type`, and `prompt`, plus run_in_background: true.",
          };
        }),
    ),

    sdk.tool(
      "read_agent_session",
      "Read an agent session's transcript (defaults to what you have not seen yet). Reading marks it seen.",
      {
        agentSessionId: z.string(),
        afterSeq: z.number().int().optional(),
        limit: z.number().int().optional(),
      },
      async (args: {
        agentSessionId: string;
        afterSeq?: number;
        limit?: number;
      }) =>
        guarded(() => {
          owned(args.agentSessionId);
          return host.readSession(args);
        }),
    ),

    sdk.tool(
      "list_agent_sessions",
      "List this conversation's agent sessions with status and unseen message counts.",
      {},
      async () => guarded(() => ({ sessions: host.listForUserSession(userSessionId) })),
    ),

    ...(tasks === undefined
      ? []
      : [
          sdk.tool(
            "task_create",
            "Create a task on this agent session's board. Use one task per coherent unit of work; set the owner to the seat doing it.",
            {
              agentSessionId: z.string(),
              subject: z.string(),
              description: z.string().optional(),
              owner: z.string().optional().describe("Seat name doing the work"),
            },
            async (args: {
              agentSessionId: string;
              subject: string;
              description?: string;
              owner?: string;
            }) =>
              guarded(() => {
                const session = owned(args.agentSessionId);
                const userSession = repo.getUserSession(userSessionId);
                if (!userSession) {
                  throw new ApiError(404, "not_found", "no user session");
                }
                const sdkTaskId = newId("task");
                tasks.upsertFromCreate({
                  sdkSessionId: consoleTaskListId(session.id),
                  sdkTaskId,
                  subject: args.subject,
                  ...(args.description === undefined
                    ? {}
                    : { description: args.description }),
                  attribution: {
                    workspaceId: userSession.workspaceId,
                    userSessionId,
                    agentSessionId: session.id,
                    participant: args.owner ?? ORCHESTRATOR_SEAT,
                  },
                });
                return { taskId: sdkTaskId };
              }),
          ),

          sdk.tool(
            "task_update",
            "Update a task on this agent session's board: status, owner, subject, description, or dependencies.",
            {
              agentSessionId: z.string(),
              taskId: z.string(),
              status: z
                .enum(["pending", "in_progress", "completed", "deleted"])
                .optional(),
              owner: z.string().optional(),
              subject: z.string().optional(),
              description: z.string().optional(),
              addBlockedBy: z.array(z.string()).optional(),
            },
            async (args: {
              agentSessionId: string;
              taskId: string;
              status?: "pending" | "in_progress" | "completed" | "deleted";
              owner?: string;
              subject?: string;
              description?: string;
              addBlockedBy?: string[];
            }) =>
              guarded(() => {
                const session = owned(args.agentSessionId);
                tasks.applyUpdate({
                  sdkSessionId: consoleTaskListId(session.id),
                  sdkTaskId: args.taskId,
                  patch: {
                    ...(args.status === undefined ? {} : { status: args.status }),
                    ...(args.owner === undefined ? {} : { owner: args.owner }),
                    ...(args.subject === undefined
                      ? {}
                      : { subject: args.subject }),
                    ...(args.description === undefined
                      ? {}
                      : { description: args.description }),
                    ...(args.addBlockedBy === undefined
                      ? {}
                      : { addBlockedBy: args.addBlockedBy }),
                  },
                });
                return { updated: args.taskId };
              }),
          ),

          sdk.tool(
            "task_list",
            "List this conversation's tasks (optionally scoped to one agent session) with status, owner, and dependencies.",
            { agentSessionId: z.string().optional() },
            async (args: { agentSessionId?: string }) =>
              guarded(() => {
                if (args.agentSessionId !== undefined) owned(args.agentSessionId);
                const rows = tasks
                  .listForUserSession(userSessionId)
                  .filter(
                    (task) =>
                      args.agentSessionId === undefined ||
                      task.agentSessionId === args.agentSessionId,
                  )
                  .filter((task) => task.status !== "deleted");
                return { tasks: rows };
              }),
          ),
        ]),
  ];

  return sdk.createSdkMcpServer({ name: "console", version: "1.0.0", tools });
}
