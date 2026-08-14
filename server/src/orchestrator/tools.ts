/**
 * The console MCP server, bound to one UserSession: create_agent_session (the
 * managed-session factory) plus read/list/profile and handoff retrieval.
 * Messaging to a coordinator is `send_to_coordinator` — console-owned, route-
 * checked and journaled, like every other transfer in the system.
 */
import { z } from "zod";
import type { AgentSessionService } from "../agent-sessions/service.ts";
import { MAIN_RECIPIENT } from "../agent-sessions/names.ts";
import type { ArtifactStore } from "../events/artifact-store.ts";
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
import type { InteractionService } from "./interactions.ts";
import type { SpecService } from "./spec.ts";
import type { CompletionRecord, OrchestrationStateService } from "./state.ts";

/** Same bound the agent-side read_artifact applies (provider inline-image cap). */
const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024;
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
  artifacts: ArtifactStore;
  interactions: InteractionService;
  specs: SpecService;
  state: OrchestrationStateService;
}

export function buildConsoleMcpServer(input: ConsoleToolsInput): unknown {
  const { sdk, host, repo, bus, userSessionId, tasks, scheduler, handoffs, artifacts, interactions, specs, state } = input;

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
        why: z.string().max(280).optional()
          .describe("Why this session, this pattern, now — one or two sentences. Journaled with the briefing; the run review reads it."),
        expecting: z.string().max(280).optional()
          .describe("What evidence or output counts as success — or would change your plan. The session READS this as its success contract."),
        tasks: z.array(z.object({
          taskId: z.string().min(1).describe("Short stable id, e.g. \"core\""),
          subject: z.string().min(1),
          description: z.string().optional(),
          owner: z.string().optional().describe("The agent that will do the work"),
          blockedBy: z.array(z.string()).optional().describe("taskIds this unit depends on"),
        })).max(20).optional()
          .describe("Ledger units created WITH the session, BEFORE its briefing dispatches — so the briefing's taskId resolves and the entry assignment starts its unit. This replaces calling task_create afterwards for the initial breakdown."),
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
        why?: string;
        expecting?: string;
        tasks?: { taskId: string; subject: string; description?: string; owner?: string; blockedBy?: string[] }[];
      }) =>
        guarded(() => {
          // Rationale rides the briefing's extension: captured AT the act,
          // journaled with it, and read by the recipient as its success
          // contract — never a retrospective diary.
          const briefing: HandoffDraft = args.why === undefined && args.expecting === undefined ? args.briefing : {
            core: args.briefing.core,
            extension: { kind: args.briefing.extension?.kind ?? "coordination",
              data: { ...(args.briefing.extension?.data ?? {}),
                ...(args.why === undefined ? {} : { why: args.why }),
                ...(args.expecting === undefined ? {} : { expecting: args.expecting }) } } as HandoffDraft["extension"],
          };
          const created = host.createSession({
            userSessionId,
            title: args.title,
            pattern: args.pattern,
            ...(args.patternConfig ? { patternConfig: args.patternConfig } : {}),
            agents: args.agents,
            briefing,
            ...(args.tasks === undefined ? {} : { tasks: args.tasks }),
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
      "Set `to` to reach ANY agent in the session directly with a category:\"update\" steering message (a correction, a discovery, a binding redirect) — assignments still enter only through the entry agent. " +
      "An assignment whose taskId still has incomplete dependencies is SCHEDULED, not delivered — {scheduled:true} comes back and the Console dispatches it when the dependencies complete; never re-send it.",
      {
        agentSessionId: z.string().min(1),
        to: z.string().min(1).optional()
          .describe("Recipient agent name (session_activity lists them). Omit for the entry agent. Non-entry recipients accept category \"update\" only."),
        category: z.enum(["assignment", "update"])
          .describe("\"assignment\" is new work the session owes you back; \"update\" is steering or context for work already assigned."),
        status: HandoffCoreSchema.shape.status,
        risk: HandoffCoreSchema.shape.risk.default("medium"),
        action: z.string().min(1).describe("The request, in one line."),
        stateSummary: z.string().min(1).describe("What is true now — the substance, not a description of it."),
        evidence: z.array(EvidenceRefSchema).default([]).describe("Pointers backing the state: files, artifacts, tasks, commands, urls."),
        resultSummary: z.string().nullable().default(null)
          .describe("Anything already produced that the session should build on, and where it is."),
        artifacts: z.array(EvidenceRefSchema).default([]).describe("Outputs you are handing over, distinct from the evidence backing them."),
        uncertainty: z.array(z.string()).default([]).describe("What you could not verify. State it rather than omitting it."),
        nextAction: z.string().nullable().default(null).describe("The exact next step for the recipient, or null when nothing is owed."),
        taskId: z.string().nullable().default(null)
          .describe("The ledger taskId this assignment covers. The Console starts that entry on delivery and holds the assignment until its dependencies complete."),
        requestExpandedContext: z.boolean().default(false),
        why: z.string().max(280).optional()
          .describe("Why this move now (redirects and commissions deserve one; routine relays may skip it)."),
        expecting: z.string().max(280).optional()
          .describe("What evidence would count as success, or change your plan."),
      },
      async (args: {
        agentSessionId: string; to?: string; category: "assignment" | "update";
        status: HandoffDraft["core"]["status"]; risk: HandoffDraft["core"]["risk"];
        action: string; stateSummary: string; evidence: HandoffDraft["core"]["state"]["evidence"];
        resultSummary: string | null; artifacts: HandoffDraft["core"]["result"]["artifacts"];
        uncertainty: string[]; nextAction: string | null; taskId: string | null; requestExpandedContext: boolean;
        why?: string; expecting?: string;
      }) => guarded(() => {
        const session = owned(args.agentSessionId);
        const entryAgent = host.entryAgent(args.agentSessionId);
        const recipient = args.to ?? entryAgent;
        const handoff: HandoffDraft = {
          core: {
            schemaVersion: 1, taskId: args.taskId, status: args.status, risk: args.risk, action: args.action,
            state: { summary: args.stateSummary, evidence: args.evidence },
            result: { summary: args.resultSummary, artifacts: args.artifacts },
            uncertainty: args.uncertainty, nextAction: args.nextAction,
            requestExpandedContext: args.requestExpandedContext,
          },
          extension: { kind: "coordination", data: {
            ...(args.why === undefined ? {} : { why: args.why }),
            ...(args.expecting === undefined ? {} : { expecting: args.expecting }) } },
        };
        // An archived session skips the intercept so post() raises its
        // Conflict instead of recording a schedule nobody can dispatch.
        // Only ENTRY traffic can be scheduled: a dependency-parked assignment
        // dispatches to its stored recipient later, and the front door is the
        // only recipient every pattern accepts assignments through.
        if (session.lifecycle === "open" && recipient === entryAgent) {
          const scheduled = scheduler.intercept({
            agentSessionId: args.agentSessionId, sender: MAIN_RECIPIENT, recipient,
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
          to: recipient,
          handoff,
          category: args.category,
        });
        return { delivered: true, messageSeq: message.seq, to: recipient, category: args.category };
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
        return { availability: host.runtimeAvailability(), profiles: host.profiles(workspaceId).map(({ id, title, purpose, tools }) => ({ id, title, purpose, tools })) };
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

    sdk.tool(
      "session_activity",
      "LIVE state of a session's agents — what they are DOING right now, not what they said: lane posture, the current turn's age, the in-flight tool call with its name/input-preview/elapsed time, last-stream-event age, queued deliveries, context tokens, last handoff, and pattern-state facts. Use this to diagnose before intervening: 'working' in list_agent_sessions covers both healthy work and a wedged call; this tool tells them apart.",
      { agentSessionId: z.string().min(1) },
      async (args: { agentSessionId: string }) =>
        guarded(() => {
          owned(args.agentSessionId);
          return host.activity(args.agentSessionId);
        }),
    ),

    sdk.tool(
      "propose_spec",
      "Put a SPECIFICATION (or an amendment to it) to the operator for approval. The spec is the shared definition of done-well: goals, constraints, the decisions that need making (with your recommendations), acceptance criteria a reviewer can check, standing uncertainties/assumptions, and the crew you propose. The operator reads it, may EDIT it in place, and approves or rejects; the approved text is injected into your prompt, every agent's prompt, and every rotation — reviews check work against it. This call BLOCKS until they respond. Amend with a new propose_spec when reality invalidates part of it; never silently diverge. Proportionality is your judgment — a toy request may not need one.",
      {
        document: z.string().min(1).describe("The full spec text (markdown). Include '## Open uncertainties', '## Assumptions', and '## Out of scope' sections so reviews can target them."),
        changeNote: z.string().min(1).max(280).describe("One line: what this revision is, or what changed and why (for amendments)."),
      },
      async (args: { document: string; changeNote: string }) => {
        const draft = specs.propose(userSessionId, args.document, args.changeNote);
        const { id: approvalId, resolution } = interactions.createSpecApproval(userSessionId, args.document, draft.revision, args.changeNote);
        const resolved = await resolution;
        if (resolved.kind === "decision" && resolved.approved) {
          const finalText = resolved.editedDocument?.trim() || args.document;
          const approved = specs.approve(draft.id, { document: finalText, interactionId: approvalId,
            edited: resolved.editedDocument !== undefined && resolved.editedDocument.trim() !== args.document.trim() });
          // An AMENDMENT lands while sessions may be mid-assignment against
          // the old revision. The next delivery re-anchors each of them, but
          // whether one needs steering NOW is main's materiality call — hand
          // it the list to make that call against.
          const running = approved.revision > 1
            ? host.listForUserSession(userSessionId).filter((s) => s.status !== "archived")
              .map((s) => ({ agentSessionId: s.id, title: s.title, status: s.status }))
            : [];
          return ok({ approved: true, revision: approved.revision, edited: approved.origin === "operator_edited",
            document: finalText,
            note: approved.origin === "operator_edited"
              ? "The operator EDITED the spec before approving — the text above is theirs and governs. Read it fully."
              : "Approved as proposed. This revision now governs the run.",
            ...(running.length === 0 ? {} : { runningSessions: running,
              amendmentNote: "These sessions were briefed under an earlier revision. They learn of the change at their next delivery; judge materiality per session — steer with send_to_coordinator (category \"update\"), interrupt_agent for urgent redirects, or let immaterial ones finish." }) });
        }
        specs.reject(draft.id);
        const note = resolved.kind === "decision" ? (resolved.note ?? "") : resolved.kind === "dismissed" ? resolved.reason : "";
        return ok({ approved: false, note, next: "Revise the spec to address their words and propose again — or ask a sharper question first." });
      },
    ),

    sdk.tool(
      "read_spec",
      "Read the governing specification (latest approved revision by default, or a named one). The injected digest is byte-capped; this returns the full text, paged.",
      {
        revision: z.number().int().optional(),
        cursor: z.string().optional(),
        maxBytes: z.number().int().min(1).max(PAGE_MAX_BYTES).default(PAGE_DEFAULT_BYTES),
      },
      async (args: { revision?: number; cursor?: string; maxBytes: number }) =>
        guarded(() => {
          const row = args.revision === undefined
            ? specs.latestApproved(userSessionId)
            : specs.listForUserSession(userSessionId).find((entry) => entry.revision === args.revision);
          if (!row) return { spec: null, note: "no approved specification yet — propose one with propose_spec" };
          return { revision: row.revision, status: row.status, changeNote: row.changeNote,
            document: pageTail(row.document, args.cursor, args.maxBytes) };
        }),
    ),

    sdk.tool(
      "update_orchestration_state",
      "Revise YOUR working state — the durable memory your next generation reads: current strategy (and why), open uncertainties, standing assumptions, live risks. Any section you pass REPLACES that section wholly; omitted sections persist. Update on material events — commissioning, an alarm you acted on, a discovery that changes the plan, a direction change, before declaring done — never as per-turn ceremony. When you work around a coordination structure the patterns cannot express, note it with the tag 'pattern-friction:'.",
      {
        trigger: z.enum(["commission", "discovery", "alarm", "direction_change", "operator"])
          .describe("What occasioned this update."),
        strategy: z.string().max(500).optional().describe("Current approach, one or two sentences."),
        strategyWhy: z.string().max(500).optional().describe("Why this strategy over its live alternatives."),
        uncertainties: z.array(z.string().max(200)).max(8).optional().describe("Open CONSEQUENTIAL uncertainties (whose answers would change the build)."),
        assumptions: z.array(z.string().max(200)).max(8).optional().describe("Load-bearing assumptions the plan rests on."),
        risks: z.array(z.string().max(200)).max(8).optional().describe("Live risks that currently matter."),
        note: z.string().max(280).optional().describe("What occasioned THIS update, one line."),
        incorporating: z.array(z.string().min(1)).max(8).optional()
          .describe("When this update incorporates specific returned results or evidence, name them (handoff / agent-session / artifact ids). Optional — skip when the update isn't about a returned result."),
      },
      async (args: { trigger: "commission" | "discovery" | "alarm" | "direction_change" | "operator";
        strategy?: string; strategyWhy?: string; uncertainties?: string[]; assumptions?: string[]; risks?: string[]; note?: string;
        incorporating?: string[] }) =>
        guarded(() => {
          const row = state.update(userSessionId, args);
          // The full merged document, not just the revision: section-replace
          // means the writer otherwise cannot confirm what its next
          // generation will actually read until that generation spawns.
          return { revision: row.revision,
            state: { trigger: row.trigger, strategy: row.strategy, strategyWhy: row.strategyWhy,
              uncertainties: row.uncertainties, assumptions: row.assumptions, risks: row.risks, note: row.note },
            note: "Recorded. This is the full merged state your next generation reads — keep it true." };
        }),
    ),

    sdk.tool(
      "record_completion",
      "Record the completion justification when you believe the run is done: each acceptance criterion mapped to its EVIDENCE (met or honestly not), known gaps, and deliberate non-goals. The sign-off card shows this beside the console's own facts (git diff, ledger, uncertainty) — an absent record renders as a visible omission. Not a gate: recording it does not complete the run; the operator does.",
      {
        criteria: z.array(z.object({
          criterion: z.string().max(200).describe("An acceptance criterion, ideally quoting the spec"),
          met: z.boolean(),
          evidence: z.array(EvidenceRefSchema).default([]).describe("What proves it: artifacts, files, journal refs, commands"),
        })).min(1).max(12),
        knownGaps: z.array(z.string().max(200)).max(8).default([]).describe("What is not done or not verified, and you know it"),
        nonGoals: z.array(z.string().max(200)).max(8).default([]).describe("Deliberately out of scope (incl. declined opportunities)"),
        note: z.string().max(280).optional(),
      },
      async (args: { criteria: CompletionRecord["criteria"]; knownGaps: string[]; nonGoals: string[]; note?: string }) =>
        guarded(() => {
          const row = state.recordCompletion(userSessionId,
            { criteria: args.criteria, knownGaps: args.knownGaps, nonGoals: args.nonGoals }, args.note);
          return { revision: row.revision, recorded: true };
        }),
    ),

    sdk.tool(
      "read_artifact",
      "Read an artifact by id — a landed or archived worktree diff, a screenshot, a note, a captured payload. Artifacts are the EVIDENCE behind reports (worktree events, salvage pointers, handoff refs carry the ids); read them before deciding on the work they describe. Images return as viewable content.",
      { artifactId: z.string().min(1), cursor: z.string().optional(), maxBytes: z.number().int().min(1).max(PAGE_MAX_BYTES).default(PAGE_DEFAULT_BYTES) },
      async (args: { artifactId: string; cursor?: string; maxBytes: number }) => {
        const artifact = artifacts.get(args.artifactId);
        if (!artifact) return fail(`no artifact ${args.artifactId}`);
        if (artifact.mediaType.startsWith("image/")) {
          // MCP's ImageContent is {type,data,mimeType}; strip the console's
          // `;base64` storage suffix only here, at the boundary.
          const mimeType = artifact.mediaType.replace(/;base64$/, "");
          if (artifact.content.length > MAX_IMAGE_BASE64_CHARS) {
            return ok({ artifactId: artifact.id, mediaType: artifact.mediaType, bytes: artifact.bytes,
              error: `image is ${Math.round(artifact.bytes / 1024)}KiB, over the provider limit for inline images.` });
          }
          return { content: [{ type: "image" as const, data: artifact.content, mimeType }] };
        }
        return ok({ artifactId: artifact.id, mediaType: artifact.mediaType, bytes: artifact.bytes,
          content: pageTail(artifact.content, args.cursor, args.maxBytes) });
      },
    ),

    sdk.tool(
      "add_agent",
      "Add ONE agent to an open session mid-run — an emergent need the original roster did not anticipate (a security pass, a second perspective, more capacity). Works for open multi-seat roles only: hub specialists, plan_execute executors, peer_to_peer peers. Fixed-roster patterns (pipeline, debate, evaluator, map_reduce) refuse — spawn a follow-up session for those. The entry agent is told immediately; assign the new seat work through it.",
      {
        agentSessionId: z.string().min(1),
        name: z.string().min(1).describe("Agent name, e.g. 'auditor'"),
        profileId: z.string().min(1).describe("A profile id from list_agent_profiles"),
        instructions: z.string().optional().describe("Brief appended to the profile instructions"),
        model: z.string().optional(),
        owns: z.array(z.string()).default([]).describe("Exclusive write scope; required for a writing profile"),
      },
      async (args: { agentSessionId: string; name: string; profileId: string; instructions?: string; model?: string; owns: string[] }) =>
        guarded(() => {
          owned(args.agentSessionId);
          const added = host.addAgent(args.agentSessionId, {
            name: args.name, profileId: args.profileId,
            ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
            ...(args.model === undefined ? {} : { model: args.model }),
            owns: args.owns,
          });
          return { ...added, status: "seated",
            note: "The entry agent has been told. Route assignments through it; you can steer the new seat directly with send_to_coordinator's `to` (update-only)." };
        }),
    ),

    sdk.tool(
      "close_agent_session",
      "Terminate a whole session that is no longer productive (superseded strategy, wedged past saving, obsoleted by a discovery). Lanes close, pending deliveries cancel, unlanded worktree branches ARCHIVE (nothing merges, nothing is destroyed), and the session stops blocking run completion. A child session's controller is told via a journaled failure. Returns the session's still-open ledger units so you can re-own them in a successor session. Prefer close+create over deforming a running session past its briefing.",
      {
        agentSessionId: z.string().min(1),
        reason: z.string().min(1).max(280).describe("Why — journaled; a child's controller reads it"),
      },
      async (args: { agentSessionId: string; reason: string }) =>
        guarded(() => {
          owned(args.agentSessionId);
          const closed = host.closeSession(args.agentSessionId, args.reason);
          return { ...closed,
            note: "Worktree branches were archived, not merged; the journal stays readable via read_handoff. Re-own the open units in a successor session if the work still matters." };
        }),
    ),

    sdk.tool(
      "interrupt_agent",
      "Stop ONE agent's in-flight turn (a wedged tool call, a runaway loop, work a discovery just invalidated). The turn dies; the agent, its lane and its inbox survive. The interrupted turn's delivered rows are cancelled — they do NOT redeliver — while QUEUED deliveries deliver next, so a correction you post right after the interrupt arrives with them. The seat's uncommitted work is preserved (archived branch + diff artifact) by the failure path. No-op error if the agent has no turn in flight.",
      {
        agentSessionId: z.string().min(1),
        agent: z.string().min(1).describe("The agent name shown by session_activity"),
        reason: z.string().min(1).max(280).describe("Why — journaled and shown to the agent's successor turn"),
      },
      async (args: { agentSessionId: string; agent: string; reason: string }) =>
        guarded(() => {
          owned(args.agentSessionId);
          host.interruptAgent(args.agentSessionId, args.agent, `main: ${args.reason}`);
          return { interrupted: true, agent: args.agent,
            note: "The turn was stopped and its deliveries cancelled; queued deliveries (including anything you post now) deliver next. The seat's work so far is preserved by the failure path." };
        }),
    ),

  ];

  return sdk.createSdkMcpServer({ name: "console", version: "1.0.0", tools, alwaysLoad: true });
}
