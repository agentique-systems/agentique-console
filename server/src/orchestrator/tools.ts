/**
 * The console MCP server, bound to one UserSession: create_agent_session (the
 * managed-session factory) plus read/list/profile and handoff retrieval.
 * Messaging is the native SendMessage tool (middleware-governed) and tasks are
 * the native task tools (hook-mirrored); neither lives here anymore.
 */
import { z } from "zod";
import { MAIN_RECIPIENT, ORCHESTRATOR_SEAT, type AgentSessionHost } from "../agent-sessions/host.ts";
import { ApiError } from "../api/errors.ts";
import type { EventBus } from "../events/bus.ts";
import type { Repo } from "../db/repo.ts";
import { newId } from "../ids.ts";
import { pageTail } from "../paging.ts";
import type { ConsoleSdk, SdkToolResult } from "../sdk/types.ts";
import type { TaskService } from "../tasks/service.ts";
import type { HandoffDraft } from "@agentique-console/shared";
import type { HandoffService } from "../handoffs/service.ts";
import { HandoffDraftSchema } from "../handoffs/schema.ts";

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
      "Create and immediately launch a Console-managed AgentSession with one coordinator and 1-20 profile-bound specialists. The Console owns every provider session, mailbox delivery, retry, and event; never call Agent yourself.",
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
          .max(20),
        briefing: HandoffDraftSchema
          .describe(
            "Typed coordinator assignment: objective, current evidence, risk, uncertainty, and next action",
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
        briefing: HandoffDraft;
      }) =>
        guarded(() => {
          const { agentSessionId, participants } = host.createSession({
            userSessionId,
            title: args.title,
            mode: args.mode,
            agents: args.agents,
            briefing: args.briefing,
          });
          const coordinator = repo.getParticipant(agentSessionId, ORCHESTRATOR_SEAT);
          return {
            agentSessionId,
            participants,
            coordinator: ORCHESTRATOR_SEAT,
            coordinatorAddress: coordinator?.peerName ?? ORCHESTRATOR_SEAT,
            status: "launched",
          };
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
      async () => guarded(() => {
        const workspaceId = repo.getUserSession(userSessionId)?.workspaceId;
        return { availability: host.runtimeAvailability(), profiles: host.profiles(workspaceId).map(({ id, title, purpose, tools, runtime, sandboxRequired }) => ({ id, title, purpose, tools, runtime, sandboxRequired })) };
      }),
    ),

    sdk.tool(
      "read_agent_session",
      "Read an agent session's transcript (defaults to what you have not seen yet). Reading marks it seen. Returns the newest window (default 8KiB) of the serialized messages plus cursors — retrieval is paged; never assume one call returned everything. Use afterSeq/limit to narrow before paging.",
      {
        agentSessionId: z.string(),
        afterSeq: z.number().int().optional(),
        limit: z.number().int().optional(),
        cursor: z.string().optional(),
        maxBytes: z.number().int().min(1).max(32 * 1024).default(8 * 1024),
      },
      async (args: {
        agentSessionId: string;
        afterSeq?: number;
        limit?: number;
        cursor?: string;
        maxBytes: number;
      }) =>
        guarded(() => {
          owned(args.agentSessionId);
          const full = host.readSession({ agentSessionId: args.agentSessionId,
            ...(args.afterSeq === undefined ? {} : { afterSeq: args.afterSeq }),
            ...(args.limit === undefined ? {} : { limit: args.limit }) });
          const { messages, ...meta } = full as { messages: unknown[] } & Record<string, unknown>;
          return { ...meta, messageCount: messages.length,
            transcript: pageTail(JSON.stringify(messages, null, 2), args.cursor, args.maxBytes) };
        }),
    ),

    sdk.tool(
      "list_agent_sessions",
      "List this conversation's agent sessions with status and unseen message counts.",
      {},
      async () => guarded(() => ({ sessions: host.listForUserSession(userSessionId) })),
    ),

  ];

  return sdk.createSdkMcpServer({ name: "console", version: "1.0.0", tools, alwaysLoad: true });
}
