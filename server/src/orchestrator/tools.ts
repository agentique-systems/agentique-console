/**
 * The console MCP server: the Orchestrator's five delegation tools, bound to
 * one UserSession. Registered in-process via createSdkMcpServer; the model
 * sees them as mcp__console__<name>. All are auto-allowed by canUseTool.
 */
import { z } from "zod";
import type { AgentSessionHost } from "../agent-sessions/host.ts";
import { ORCHESTRATOR_SEAT } from "../agent-sessions/routing.ts";
import { ApiError } from "../api/errors.ts";
import type { EventBus } from "../events/bus.ts";
import type { Repo } from "../db/repo.ts";
import type { ConsoleSdk, SdkToolResult } from "../sdk/types.ts";

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
}

export function buildConsoleMcpServer(input: ConsoleToolsInput): unknown {
  const { sdk, host, repo, bus, userSessionId } = input;

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
      "Create a new agent session: 1-4 specialist seats that collaborate on a coherent stream of work. Returns the session id. Delivery of the optional briefing is asynchronous — end your turn after delegating; you will be woken with a digest when the session settles.",
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
          .describe("First message to post into the session (routes normally)"),
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
        guarded(() =>
          host.createSession({
            userSessionId,
            title: args.title,
            mode: args.mode,
            agents: args.agents,
            ...(args.briefing === undefined ? {} : { briefing: args.briefing }),
          }),
        ),
    ),

    sdk.tool(
      "send_to_agent_session",
      "Speak into an agent session. Address a seat with `to` or @mentions in the text. Delivery is asynchronous: end your turn afterwards — you will be woken with a digest when the session goes quiet.",
      {
        agentSessionId: z.string(),
        text: z.string(),
        to: z.string().optional().describe("Seat name to address"),
      },
      async (args: { agentSessionId: string; text: string; to?: string }) =>
        guarded(() => {
          const session = owned(args.agentSessionId);
          const row = host.post({
            agentSessionId: session.id,
            speaker: { kind: "orchestrator", name: ORCHESTRATOR_SEAT },
            ...(args.to === undefined ? {} : { to: args.to }),
            text: args.text,
          });
          bus.append({
            type: "flow.delegation",
            userSessionId,
            agentSessionId: session.id,
            payload: {
              userSessionId,
              agentSessionId: session.id,
              kind: "sent",
              preview: args.text.slice(0, 140),
            },
          });
          return {
            delivered: true,
            seq: row.seq,
            note: "Delivery accepted. Turns run asynchronously — end your turn; you will be woken with a digest when the session settles.",
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

    sdk.tool(
      "approve_agent_plan",
      "Resolve a specialist's proposed plan: approve moves the session to the executing phase and tells the seat to proceed; revise sends your note back and keeps it planning.",
      {
        agentSessionId: z.string(),
        participant: z.string().describe("The seat whose plan you are resolving"),
        decision: z.enum(["approve", "revise"]),
        note: z.string().optional(),
      },
      async (args: {
        agentSessionId: string;
        participant: string;
        decision: "approve" | "revise";
        note?: string;
      }) =>
        guarded(() => {
          const session = owned(args.agentSessionId);
          if (args.decision === "approve") {
            repo.patchAgentSession(session.id, { phase: "executing" });
            bus.append({
              type: "agent_session.phase",
              userSessionId,
              agentSessionId: session.id,
              payload: { agentSessionId: session.id, phase: "executing" },
            });
            host.post({
              agentSessionId: session.id,
              speaker: { kind: "orchestrator", name: ORCHESTRATOR_SEAT },
              to: args.participant,
              text: `Plan approved — proceed.${args.note === undefined ? "" : ` ${args.note}`}`,
            });
            return { phase: "executing" };
          }
          host.post({
            agentSessionId: session.id,
            speaker: { kind: "orchestrator", name: ORCHESTRATOR_SEAT },
            to: args.participant,
            text: `Revise the plan: ${args.note ?? "see the discussion above."}`,
          });
          return { phase: "planning" };
        }),
    ),
  ];

  return sdk.createSdkMcpServer({ name: "console", version: "1.0.0", tools });
}
