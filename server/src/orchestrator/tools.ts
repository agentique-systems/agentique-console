/**
 * The console MCP server, bound to one UserSession: create_agent_session (the
 * managed-session factory), durable messaging, read/list, profiles, and the
 * single Console-owned task board. It never returns native Agent spawn plans.
 */
import { z } from "zod";
import { MAIN_RECIPIENT, ORCHESTRATOR_SEAT, type AgentSessionHost } from "../agent-sessions/host.ts";
import { ApiError } from "../api/errors.ts";
import type { EventBus } from "../events/bus.ts";
import type { Repo } from "../db/repo.ts";
import { newId } from "../ids.ts";
import type { ConsoleSdk, SdkToolResult } from "../sdk/types.ts";
import type { TaskService } from "../tasks/service.ts";
import type { HandoffDraft } from "@agentique-console/shared";
import type { HandoffService } from "../handoffs/service.ts";
import { HandoffDraftSchema, HandoffReferenceSchema } from "../handoffs/schema.ts";

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
    return fail(error instanceof Error ? error.message : String(error));
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
  handoffs: HandoffService;
}

export function buildConsoleMcpServer(input: ConsoleToolsInput): unknown {
  const { sdk, host, repo, bus, userSessionId, tasks, handoffs } = input;

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
      "Create and immediately launch a Console-managed AgentSession with one coordinator and 1-4 profile-bound specialists. The Console owns every provider session, mailbox delivery, retry, and event; never call Agent yourself.",
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
              profileId: z.string().describe("A profile id returned by list_agent_profiles"),
              instructions: z
                .string()
                .optional()
                .describe(
                  "Ad-hoc brief (required when no preset; appended to the preset otherwise)",
                ),
              model: z.string().optional().describe("Model override"),
              owns: z.array(z.string()).min(1).describe("Explicit files, directories, component, or review scope this seat exclusively owns"),
            }),
          )
          .min(1)
          .max(4),
        briefing: HandoffDraftSchema
          .optional()
          .describe(
            "Typed coordinator assignment: objective, current evidence, risk, uncertainty, and next action",
          ),
        briefingReference: HandoffReferenceSchema.optional().describe(
          "Reference an existing canonical handoff instead of authoring another briefing",
        ),
      },
      async (args: {
        title: string;
        mode: "execute" | "plan_execute";
        agents: {
          name: string;
          profileId: string;
          instructions?: string;
          model?: string;
          owns: string[];
        }[];
        briefing?: HandoffDraft;
        briefingReference?: {
          handoffId: string;
          purpose: "assignment_context" | "dependency_result" | "review_input" | "final_result" | "scope_change";
          expectedAction: string;
        };
      }) =>
        guarded(() => {
          if ((args.briefing === undefined) === (args.briefingReference === undefined)) {
            throw new ApiError(400, "bad_request", "provide exactly one of briefing or briefingReference");
          }
          const { agentSessionId, participants } = host.createSession({
            userSessionId,
            title: args.title,
            mode: args.mode,
            agents: args.agents,
            ...(args.briefing ? { briefing: args.briefing } : {}),
            ...(args.briefingReference ? { briefingReference: args.briefingReference } : {}),
          });
          return {
            agentSessionId,
            participants,
            coordinator: ORCHESTRATOR_SEAT,
            status: "launched",
          };
        }),
    ),

    sdk.tool(
      "send_agent_message",
      "Send a focused assignment or response from main to an AgentSession coordinator. Direct specialist messaging is intentionally forbidden.",
      { agentSessionId: z.string(), handoff: HandoffDraftSchema, category: z.enum(["assignment", "update"]).default("assignment"), dedupeKey: z.string().optional() },
      async (args: { agentSessionId: string; handoff: HandoffDraft; category: "assignment" | "update"; dedupeKey?: string }) => guarded(() => {
        owned(args.agentSessionId);
        const message = host.post({ agentSessionId: args.agentSessionId, speaker: { kind: "orchestrator", name: MAIN_RECIPIENT }, to: ORCHESTRATOR_SEAT, handoff: args.handoff, category: args.category, ...(args.dedupeKey ? { dedupeKey: args.dedupeKey } : {}) });
        return { delivered: true, messageSeq: message.seq, handoffId: (message.payload?.handoff as { id?: string } | undefined)?.id };
      }),
    ),

    sdk.tool(
      "read_handoff",
      "Retrieve one lossless handoff section using bounded cursor pagination.",
      { handoffId: z.string(), section: z.enum(["core", "extension"]).default("core"), cursor: z.string().optional(), maxBytes: z.number().int().min(1).max(32 * 1024).default(8 * 1024) },
      async (args: { handoffId: string; section: "core" | "extension"; cursor?: string; maxBytes: number }) => guarded(() => handoffs.read(args.handoffId, args.section, args.cursor, args.maxBytes)),
    ),

    sdk.tool(
      "report_handoff_discrepancy",
      "Record a handoff claim contradicted by authoritative repository, task, journal, or artifact evidence.",
      { handoffId: z.string(), claim: z.string().min(1), evidence: z.string().min(1) },
      async (args: { handoffId: string; claim: string; evidence: string }) => guarded(() => {
        handoffs.reportDiscrepancy(args.handoffId, "main", args.claim, args.evidence); return { recorded: true };
      }),
    ),

    sdk.tool(
      "list_agent_profiles",
      "List the validated custom and built-in profiles available for managed AgentSessions.",
      {},
      async () => guarded(() => ({ availability: host.runtimeAvailability(), profiles: host.profiles().map(({ id, title, purpose, tools, runtime, sandboxRequired }) => ({ id, title, purpose, tools, runtime, sandboxRequired })) })),
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
                  validateDependencies: true,
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
