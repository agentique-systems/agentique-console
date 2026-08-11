/**
 * The console MCP server, bound to one UserSession: create_agent_session (the
 * managed-session factory) plus read/list/profile and handoff retrieval.
 * Messaging to a coordinator is `send_to_coordinator` — console-owned, route-
 * checked and journaled, like every other transfer in the system.
 */
import { z } from "zod";
import type { AgentSessionService } from "../agent-sessions/host.ts";
import { MAIN_RECIPIENT } from "../agent-sessions/names.ts";
import type { EventBus } from "../events/bus.ts";
import type { Repo } from "../db/repo.ts";
import { NotFoundError } from "../errors.ts";
import { newId } from "../ids.ts";
import { PAGE_DEFAULT_BYTES, PAGE_MAX_BYTES, pageTail } from "../paging.ts";
import type { ConsoleSdk, SdkToolResult } from "../sdk/types.ts";
import type { AssignmentScheduler } from "../tasks/scheduler.ts";
import type { TaskService } from "../tasks/service.ts";
import { PATTERN_IDS, type HandoffDraft, type PatternId } from "@agentique-console/shared";
import type { HandoffService } from "../handoffs/service.ts";
import { EvidenceRefSchema, HandoffCoreSchema, HandoffDraftSchema } from "../handoffs/schema.ts";

import { fail, guarded, ok } from "../sdk/tool-result.ts";
import { consoleTaskListId } from "../tasks/service.ts";

export interface ConsoleToolsInput {
  sdk: ConsoleSdk;
  host: AgentSessionService;
  repo: Repo;
  bus: EventBus;
  userSessionId: string;
  tasks: TaskService;
  scheduler: AssignmentScheduler;
  handoffs: HandoffService;
}

export function buildConsoleMcpServer(input: ConsoleToolsInput): unknown {
  const { sdk, host, repo, bus, userSessionId, tasks, scheduler, handoffs } = input;

  /** Tools operate only on this UserSession's agent sessions. */
  const owned = (agentSessionId: string) => {
    const session = repo.getAgentSession(agentSessionId);
    if (!session || session.userSessionId !== userSessionId) {
      throw new NotFoundError(`no agent session ${agentSessionId} in this conversation`);
    }
    return session;
  };

  const tools = [
    sdk.tool(
      "create_agent_session",
      "Create and immediately launch a Console-managed AgentSession running an orchestration pattern over profile-bound agents. Default pattern hub_and_spoke = one coordinator + 1-20 specialists; pipeline = the agents ARE the stages in order; evaluator_optimizer = exactly 2 agents (generator, evaluator) cycling until accept or the round cap. The Console owns every provider session, mailbox delivery, retry, and event; never call Agent yourself.",
      {
        title: z.string().describe("Short working title for the session"),
        pattern: z.enum(PATTERN_IDS).default("hub_and_spoke")
          .describe("Orchestration pattern; the delegation brief's decision tree says when each fits. hub_and_spoke: coordinator + specialists. pipeline: agents ARE the stages in order. evaluator_optimizer: exactly 2 (generator, evaluator). map_reduce: seat ONLY the reducer. debate: 2-8 debaters, judge auto-seated — a single BLIND round: each debater argues once and never sees the others, so agent instructions must not promise rebuttals or exchanges. peer_to_peer: bounded mesh, use rarely. plan_execute: planner + executors over a task DAG the Console dispatches on."),
        patternConfig: z.record(z.string(), z.unknown()).optional()
          .describe("Pattern-specific config. evaluator_optimizer: {rubric, maxRounds?, generatorAgent?, requireDistinctModels?}. map_reduce: {maxMappers?}. debate: {rubric?, judgeProfileId?, judgeModel?}. peer_to_peer: {closerAgent?, maxHandoffs?, oscillationWindow?}. plan_execute: {plannerAgent?}."),
        agents: z
          .array(
            z.object({
              name: z
                .string()
                .describe("Agent name, e.g. 'scout' — addressable via @name"),
              profileId: z.string().describe("A profile id returned by list_agent_profiles"),
              instructions: z
                .string()
                .optional()
                .describe(
                  "Agent brief appended to the profile instructions",
                ),
              model: z.string().optional().describe("Model override"),
              owns: z.array(z.string()).default([]).describe("Files or directories this agent exclusively owns. Required for an agent that writes; leave empty for a read-only agent such as a reviewer — it owns no files."),
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
        pattern: PatternId;
        patternConfig?: Record<string, unknown>;
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
          const created = host.createSession({
            userSessionId,
            title: args.title,
            pattern: args.pattern,
            ...(args.patternConfig ? { patternConfig: args.patternConfig } : {}),
            agents: args.agents,
            briefing: args.briefing,
          });
          return {
            agentSessionId: created.agentSessionId,
            agents: created.agents,
            pattern: args.pattern,
            // Steer it with `send_to_coordinator`, not with a peer address:
            // the native mesh is gone and a peer name is only live while the
            // agent's process is. The tool reaches this session's entry agent.
            entryAgent: created.entryAgent,
            ...(created.coordinatorName ? { coordinator: created.coordinatorName } : {}),
            status: "launched",
          };
        }),
    ),

    /**
     * Main's ONLY journaled path to a coordinator after the initial briefing.
     * Routing is free here: `#assertRoute` already permits exactly
     * main → coordinator and nothing else. Delivery goes through
     * `#deliverConsole`, which spawns a parked agent — so a coordinator whose
     * process has died is not an unreachable one.
     */
    sdk.tool(
      "send_to_coordinator",
      "Send a typed handoff to an AgentSession's entry agent — its coordinator in a hub session, the first stage of a pipeline, the generator of an evaluator loop. This is how you steer a running session after its briefing: assign more work, redirect, or relay an operator decision. The fields ARE the handoff; the Console builds, journals and carries the envelope. " +
      "An assignment whose taskId still has incomplete dependencies is SCHEDULED, not delivered — {scheduled:true} comes back and the Console dispatches it when the dependencies complete; never re-send it.",
      {
        agentSessionId: z.string().min(1),
        category: z.enum(["assignment", "update"]).default("update"),
        status: HandoffCoreSchema.shape.status,
        risk: HandoffCoreSchema.shape.risk.default("medium"),
        action: z.string().min(1).describe("The request, in one line."),
        stateSummary: z.string().min(1).describe("What is true now — the substance, not a description of it."),
        evidence: z.array(EvidenceRefSchema).default([]),
        resultSummary: z.string().nullable().default(null),
        artifacts: z.array(EvidenceRefSchema).default([]),
        uncertainty: z.array(z.string()).default([]),
        nextAction: z.string().nullable().default(null),
        taskId: z.string().nullable().default(null),
        requestExpandedContext: z.boolean().default(false),
      },
      async (args: {
        agentSessionId: string; category: "assignment" | "update";
        status: HandoffDraft["core"]["status"]; risk: HandoffDraft["core"]["risk"];
        action: string; stateSummary: string; evidence: HandoffDraft["core"]["state"]["evidence"];
        resultSummary: string | null; artifacts: HandoffDraft["core"]["result"]["artifacts"];
        uncertainty: string[]; nextAction: string | null; taskId: string | null; requestExpandedContext: boolean;
      }) => guarded(() => {
        const session = owned(args.agentSessionId);
        const entryAgent = host.entryAgent(args.agentSessionId);
        const handoff: HandoffDraft = {
          core: {
            schemaVersion: 1, taskId: args.taskId, status: args.status, risk: args.risk, action: args.action,
            state: { summary: args.stateSummary, evidence: args.evidence },
            result: { summary: args.resultSummary, artifacts: args.artifacts },
            uncertainty: args.uncertainty, nextAction: args.nextAction,
            requestExpandedContext: args.requestExpandedContext,
          },
          extension: { kind: "coordination", data: {} },
        };
        // An archived session skips the intercept so post() raises its
        // Conflict instead of recording a schedule nobody can dispatch.
        if (session.lifecycle === "open") {
          const scheduled = scheduler.intercept({
            agentSessionId: args.agentSessionId, sender: MAIN_RECIPIENT, recipient: entryAgent,
            category: args.category, handoff,
          });
          if (scheduled) {
            return { delivered: false, scheduled: true, assignmentId: scheduled.assignmentId, awaiting: scheduled.awaiting,
              note: "This assignment is recorded and will dispatch the moment its dependencies complete. Do not re-send it; re-sending the same taskId only re-targets the recipient." };
          }
        }
        const message = host.post({
          agentSessionId: args.agentSessionId,
          speaker: { kind: "orchestrator", name: "main" },
          to: entryAgent,
          handoff,
          category: args.category,
        });
        return { delivered: true, messageSeq: message.seq, to: entryAgent, category: args.category };
      }),
    ),

    /**
     * Main's ledger, console-owned and keyed to the AgentSession — never the
     * provider session id, which changes at every rotation.
     */
    sdk.tool(
      "task_create",
      "Add a unit of work to the ledger. Track every unit you delegate; the Console reports open units to the operator alongside any final report. Declare dependencies as blockedBy here — the Console dispatches assignments on that DAG.",
      {
        agentSessionId: z.string().min(1).describe("The session that will do the work."),
        taskId: z.string().min(1).describe("Short stable id you choose, e.g. \"1\" or \"interface\"."),
        subject: z.string().min(1),
        description: z.string().default(""),
        owner: z.string().min(1).describe("The agent that will DO this work — not you."),
        blockedBy: z.array(z.string()).default([]).describe("taskIds this task depends on. Forward references are fine — the edge attaches when the blocker is created."),
      },
      async (args: { agentSessionId: string; taskId: string; subject: string; description: string; owner: string; blockedBy: string[] }) =>
        guarded(() => {
          const session = owned(args.agentSessionId);
          tasks?.upsertFromCreate({
            sdkSessionId: consoleTaskListId(args.agentSessionId), sdkTaskId: args.taskId,
            subject: args.subject, description: args.description, owner: args.owner, blockedBy: args.blockedBy,
            attribution: { workspaceId: repo.getUserSession(userSessionId)?.workspaceId ?? "", userSessionId, agentSessionId: session.id, agent: null },
          });
          return { taskId: args.taskId, created: true, owner: args.owner };
        }),
    ),

    sdk.tool(
      "task_update",
      "Update a ledger entry. Keep statuses honest: in_progress when started, completed only when verified — completing a task dispatches any assignments scheduled behind it. removeBlockedBy drops a dependency that no longer holds.",
      {
        agentSessionId: z.string().min(1),
        taskId: z.string().min(1),
        status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(),
        owner: z.string().optional(),
        subject: z.string().optional(),
        description: z.string().optional(),
        addBlockedBy: z.array(z.string()).optional(),
        removeBlockedBy: z.array(z.string()).optional(),
      },
      async (args: { agentSessionId: string; taskId: string; status?: "pending" | "in_progress" | "completed" | "deleted"; owner?: string; subject?: string; description?: string; addBlockedBy?: string[]; removeBlockedBy?: string[] }) =>
        guarded(() => {
          owned(args.agentSessionId);
          const { agentSessionId, taskId, ...patch } = args;
          tasks?.applyUpdate({ sdkSessionId: consoleTaskListId(agentSessionId), sdkTaskId: taskId, patch });
          return { taskId, updated: true };
        }),
    ),

    sdk.tool(
      "task_list",
      "Read the ledger for this conversation. Authoritative, shared with every agent, and it survives context rotation.",
      { agentSessionId: z.string().optional() },
      async (args: { agentSessionId?: string }) =>
        guarded(() => ({
          tasks: (tasks?.listForUserSession(userSessionId) ?? [])
            .filter((task) => args.agentSessionId === undefined || task.agentSessionId === args.agentSessionId),
        })),
    ),

    /**
     * Console-owned wakeup: native `ScheduleWakeup` would wake a console-owned
     * lane with no mailbox row, no handoff and no turn attribution.
     */
    sdk.tool(
      "set_deadline",
      "Wake yourself later. Use it when you are waiting on something the Console cannot notify you about; you do NOT need it for agent reports, which wake you automatically.",
      {
        delaySeconds: z.number().int().min(30).max(86_400),
        reason: z.string().min(1).describe("What you want to check when it fires. You will be handed this text."),
      },
      async (args: { delaySeconds: number; reason: string }) => guarded(() => {
        const id = newId("cron");
        const dueAt = new Date(Date.now() + args.delaySeconds * 1000).toISOString();
        repo.insertCron({
          id, userSessionId, sdkCronId: id, schedule: `@once ${dueAt}`,
          prompt: args.reason, oneShot: true, dueAt, status: "active",
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        return { deadlineId: id, dueAt, reason: args.reason };
      }),
    ),

    sdk.tool(
      "read_handoff",
      "Retrieve one lossless handoff section using bounded cursor pagination.",
      { handoffId: z.string(), section: z.enum(["core", "extension"]).default("core"), cursor: z.string().optional(), maxBytes: z.number().int().min(1).max(PAGE_MAX_BYTES).default(PAGE_DEFAULT_BYTES) },
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
      "Read an agent session's transcript. Returns the newest window (default 8KiB) of the serialized messages plus cursors — retrieval is paged; never assume one call returned everything. Use afterSeq/limit to narrow before paging.",
      {
        agentSessionId: z.string(),
        afterSeq: z.number().int().optional(),
        limit: z.number().int().optional(),
        cursor: z.string().optional(),
        maxBytes: z.number().int().min(1).max(PAGE_MAX_BYTES).default(PAGE_DEFAULT_BYTES),
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
