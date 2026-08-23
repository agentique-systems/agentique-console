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
import { InvalidInputError, NotFoundError } from "../errors.ts";
import { newId } from "../ids.ts";
import { PAGE_DEFAULT_BYTES, PAGE_MAX_BYTES, pageTail } from "../paging.ts";
import type { ConsoleSdk, SdkToolResult } from "../sdk/types.ts";
import type { AssignmentScheduler } from "../tasks/scheduler.ts";
import type { TaskService } from "../tasks/service.ts";
import { flattenRequirementGraph, PATTERN_IDS, type HandoffDraft, type PatternId, type RequirementGraph } from "@agentique-console/shared";
import type { HandoffService } from "../handoffs/service.ts";
import { EvidenceRefSchema, HandoffCoreSchema, HandoffDraftSchema } from "../handoffs/schema.ts";

import { fail, guarded, ok } from "../sdk/tool-result.ts";
import type { InteractionService } from "./interactions.ts";
import type { AssumptionService } from "./assumptions.ts";
import { RequirementParseFailure, type RequirementService } from "./requirements.ts";
import type { SpecService } from "./spec.ts";
import type { CompletionRecord, OrchestrationStateService } from "./state.ts";
import type { CapabilityCatalog } from "../agent-profiles/capability-catalog.ts";
import { MCP_CATALOG } from "../agent-profiles/capability-catalog.ts";
import type { AgentProfileRegistry } from "../agent-profiles/registry.ts";

/** Same bound the agent-side read_artifact applies (provider inline-image cap). */
const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024;

/**
 * Prose length is a rendering concern, not a validity concern: hard `max()`
 * caps on rationale fields rejected 97 tool calls in one live run (~100k
 * output tokens discarded), and the retry spirals truncated the very
 * recovery instructions the successor turns depended on. Fields that feed
 * prompt digests are clipped here with a visible marker instead.
 */
const clip = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit)} …[truncated]` : value;
const clipAll = (values: string[], limit: number, maxItems: number): string[] =>
  values.slice(0, maxItems).map((value) => clip(value, limit));
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
  requirements: RequirementService;
  assumptions: AssumptionService;
  state: OrchestrationStateService;
  /** Skills + attachable-server metadata, for staffing and mint validation. */
  catalog: CapabilityCatalog;
  /** The profile registry — the mint path lives on it. */
  registry: AgentProfileRegistry;
}

export function buildConsoleMcpServer(input: ConsoleToolsInput): unknown {
  const { sdk, host, repo, bus, userSessionId, tasks, scheduler, handoffs, artifacts, interactions, specs, requirements, assumptions, state, catalog, registry } = input;

  /** Tools operate only on this UserSession's agent sessions. */
  const owned = (agentSessionId: string) => {
    const session = repo.getAgentSession(agentSessionId);
    if (!session || session.userSessionId !== userSessionId) {
      throw new NotFoundError(`no agent session ${agentSessionId} in this conversation`);
    }
    return session;
  };

  /** Every requirement reference validates against the LIVE graph before use. */
  const assertLiveRequirementIds = (ids: string[]) => {
    if (ids.length === 0) return;
    const live = new Set(requirements.derive(userSessionId).map((node) => node.id));
    const unknown = ids.filter((id) => !live.has(id));
    if (unknown.length > 0) {
      throw new InvalidInputError(`unknown requirement id(s): ${unknown.join(", ")} — read_requirements lists the current graph`);
    }
  };

  const tools = [
    sdk.tool(
      "create_agent_session",
      "Create and immediately launch a Console-managed AgentSession running an orchestration pattern over profile-bound agents (max 20). Choose the shape the WORK has — never the smallest crew out of thrift, never an inflated one for show: path known in advance, stages that each ADD information → pipeline (the agents ARE the stages; a relay that adds nothing loses quality); one deliverable judged against a rubric and revised until it passes → evaluator_optimizer (exactly 2 agents; pass patternConfig.rubric); many INDEPENDENT items of runtime-decided count, results synthesized → map_reduce (seat only the reducer; it fans out with dispatch_work_items); the same question argued independently, disagreement as signal → debate (2-8 debaters, one blind round, the Console seats the judge); decomposition unknown or evolving, a conductor should sequence → hub_and_spoke (the default), or plan_execute when the units deserve an explicit task DAG the Console dispatches on; a small crew that must hand work directly to each other → peer_to_peer, rarely. Pass the initial ledger units in `tasks` (they land before the briefing) and say WHY you are commissioning (`why`) and what evidence counts as success (`expecting`) — the session reads that as its contract. The Console owns every provider session, mailbox delivery, retry, and event.",
      {
        title: z.string().describe("Short working title for the session"),
        pattern: z.enum(PATTERN_IDS).default("hub_and_spoke")
          .describe("Orchestration pattern; the tool description says when each fits. hub_and_spoke: coordinator + specialists. pipeline: agents ARE the stages in order. evaluator_optimizer: exactly 2 (generator, evaluator). map_reduce: seat ONLY the reducer. debate: 2-8 debaters, judge auto-seated — a single BLIND round: each debater argues once and never sees the others, so agent instructions must not promise rebuttals or exchanges. peer_to_peer: bounded mesh, use rarely. plan_execute: planner + executors over a task DAG the Console dispatches on."),
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
              skills: z.array(z.string()).optional().describe("Extra skills to RECOMMEND to this seat, from list_agent_profiles' catalog — union'd with the profile's defaults, named in the seat's brief and pinned into its snapshot. Every discovered skill is visible to every seat; this decides which ones it is told to use."),
              owns: z.array(z.string()).default([]).describe("Files or directories this agent exclusively owns. Required for an agent that writes; leave empty for a read-only agent such as a reviewer — it owns no files."),
            }),
          )
          .min(1)
          .max(20),
        briefing: HandoffDraftSchema
          .describe(
            "Typed coordinator assignment: objective, current evidence, risk, uncertainty, and next action",
          ),
        allowChildSessions: z.boolean().default(false)
          .describe("Let this session's ENTRY agent spawn child sessions (depth-capped). Give it to a session that owns a workstream with its own internal decomposition; leave it off for leaf work."),
        why: z.string().optional()
          .describe("Why this session, this pattern, now — one or two sentences. Journaled with the briefing; the run review reads it."),
        expecting: z.string().optional()
          .describe("What evidence or output counts as success — or would change your plan. The session READS this as its success contract."),
        requirements: z.array(z.string().min(1)).max(12).optional()
          .describe("Requirement ids (read_requirements) this session is commissioned against — its delegated sub-scope. The Console journals the link, renders the statements into every delivery, and grants the session's entry agent scoped requirement tools (report status with evidence; decompose below these nodes). Commission against OPEN requirements."),
        tasks: z.array(z.object({
          taskId: z.string().min(1).describe("Short stable id, e.g. \"core\""),
          subject: z.string().min(1),
          description: z.string().optional(),
          owner: z.string().optional().describe("The agent that will do the work"),
          blockedBy: z.array(z.string()).optional().describe("taskIds this unit depends on"),
          requirementId: z.string().min(1).optional().describe("The requirement id this unit discharges — links the ledger to the graph. Name it when one governs."),
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
          skills?: string[];
          owns: string[];
        }[];
        briefing: HandoffDraft;
        allowChildSessions?: boolean;
        why?: string;
        expecting?: string;
        requirements?: string[];
        tasks?: { taskId: string; subject: string; description?: string; owner?: string; blockedBy?: string[]; requirementId?: string }[];
      }) =>
        guarded(() => {
          // Rationale AND the delegated sub-scope ride the briefing's
          // extension: captured AT the act, journaled with it, and read by the
          // recipient as its success contract — never a retrospective diary.
          const extras = {
            ...(args.why === undefined ? {} : { why: args.why }),
            ...(args.expecting === undefined ? {} : { expecting: args.expecting }),
            ...(args.requirements === undefined || args.requirements.length === 0 ? {} : { requirements: args.requirements }),
          };
          const briefing: HandoffDraft = Object.keys(extras).length === 0 ? args.briefing : {
            core: args.briefing.core,
            extension: { kind: args.briefing.extension?.kind ?? "coordination",
              data: { ...(args.briefing.extension?.data ?? {}), ...extras } } as HandoffDraft["extension"],
          };
          // A skill a seat cannot act on must not load (the deferred-tools
          // lesson): validate every commission-time skill against the
          // profile's granted tools before anything spawns.
          const workspaceIdForSkills = repo.getUserSession(userSessionId)?.workspaceId;
          for (const agent of args.agents) {
            if (agent.skills === undefined || agent.skills.length === 0) continue;
            const profileTools = host.profiles(workspaceIdForSkills).find((profile) => profile.id === agent.profileId)?.tools ?? [];
            const problems = catalog.validateAssignment(agent.skills, profileTools);
            if (problems.length > 0) throw new InvalidInputError(`agent "${agent.name}": ${problems.join("; ")}`);
          }
          // Delegated requirements AND task-level requirement links validate
          // BEFORE anything spawns — a session must never launch against ids
          // that do not exist.
          assertLiveRequirementIds(args.requirements ?? []);
          assertLiveRequirementIds((args.tasks ?? [])
            .map((unit) => unit.requirementId)
            .filter((id): id is string => id !== undefined));
          const created = host.createSession({
            userSessionId,
            title: args.title,
            pattern: args.pattern,
            ...(args.patternConfig ? { patternConfig: args.patternConfig } : {}),
            agents: args.agents,
            briefing,
            ...(args.allowChildSessions === true ? { allowChildSessions: true } : {}),
            ...(args.tasks === undefined ? {} : { tasks: args.tasks }),
            // The lifecycle records the delegation BEFORE the briefing
            // dispatches, so the very first delivery renders the sub-scope.
            ...(args.requirements === undefined || args.requirements.length === 0 ? {} : { requirements: args.requirements }),
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
        why: z.string().optional()
          .describe("Why this move now (redirects and commissions deserve one; routine relays may skip it)."),
        expecting: z.string().optional()
          .describe("What evidence would count as success, or change your plan."),
        requirements: z.array(z.string().min(1)).max(12).optional()
          .describe("Requirement ids this message serves (assignment or update) — journaled as the session's delegated sub-scope and rendered into the delivery. Send them to the entry agent."),
      },
      async (args: {
        agentSessionId: string; to?: string; category: "assignment" | "update";
        status: HandoffDraft["core"]["status"]; risk: HandoffDraft["core"]["risk"];
        action: string; stateSummary: string; evidence: HandoffDraft["core"]["state"]["evidence"];
        resultSummary: string | null; artifacts: HandoffDraft["core"]["result"]["artifacts"];
        uncertainty: string[]; nextAction: string | null; taskId: string | null; requestExpandedContext: boolean;
        why?: string; expecting?: string; requirements?: string[];
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
            ...(args.expecting === undefined ? {} : { expecting: args.expecting }),
            ...(args.requirements === undefined || args.requirements.length === 0 ? {} : { requirements: args.requirements }) } },
        };
        // The delegation join is recorded BEFORE the scheduler intercept, so a
        // dependency-parked assignment still journals what it serves — for
        // UPDATES too (an amendment steer widening the sub-scope). Guards
        // first: delegations are append-only, so a transfer post() would
        // reject (non-entry recipient, archived session) must not leave a
        // phantom sub-scope behind.
        const delegating = args.requirements !== undefined && args.requirements.length > 0;
        if (delegating && recipient !== entryAgent) {
          throw new InvalidInputError(
            `requirements delegate a session-wide sub-scope — send them to the entry agent (${entryAgent}), not ${recipient}`);
        }
        if (delegating && session.lifecycle === "open") {
          // Source "assignment" covers BOTH categories: the label means
          // "delegated by main mid-run" (vs. commission-time or child
          // pass-down) — the journal's CHECK deliberately keeps that
          // three-way split rather than one label per message category.
          requirements.delegate(userSessionId, args.agentSessionId, args.requirements!, "assignment");
        }
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
        requirementId: z.string().min(1).optional().describe("The requirement id (read_requirements) this unit discharges — links the ledger to the graph and feeds the frontier's blocked annotation. Name it when one governs."),
      },
      async (args: { agentSessionId: string; taskId: string; subject: string; description: string; owner: string; blockedBy: string[]; requirementId?: string }) =>
        guarded(() => {
          const session = owned(args.agentSessionId);
          if (args.requirementId !== undefined) assertLiveRequirementIds([args.requirementId]);
          tasks?.upsertFromCreate({
            sdkSessionId: consoleTaskListId(args.agentSessionId), sdkTaskId: args.taskId,
            subject: args.subject, description: args.description, owner: args.owner, blockedBy: args.blockedBy,
            ...(args.requirementId === undefined ? {} : { requirementId: args.requirementId }),
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
        requirementId: z.string().min(1).optional().describe("Link (or re-link) this unit to the requirement it discharges."),
      },
      async (args: { agentSessionId: string; taskId: string; status?: "pending" | "in_progress" | "completed" | "deleted"; owner?: string; subject?: string; description?: string; addBlockedBy?: string[]; removeBlockedBy?: string[]; requirementId?: string }) =>
        guarded(() => {
          owned(args.agentSessionId);
          if (args.requirementId !== undefined) assertLiveRequirementIds([args.requirementId]);
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

    /**
     * Main's requirement-TRACEABLE ask. Native AskUserQuestion stays for
     * batched clarification (its SDK schema cannot carry requirement ids);
     * this one records WHICH requirements a decision resolves, so the
     * decision ledger can pin scope-relevant decisions instead of aging them
     * out, and a question is traceable to the obligations it unblocked.
     */
    sdk.tool(
      "ask_operator",
      "Ask the Human Operator one decision that specific requirements hang on. Name those ids in requirementIds — the answer is recorded as a decision PINNED to them: it reaches every seat working under those requirements and never ages out of the prompt digest while they are open. Use native AskUserQuestion for batched clarification with no requirement anchor. urgency:'blocking' parks this call until they answer; 'deferred' returns now and their answer wakes you.",
      {
        question: z.string().min(1).describe("One concrete question. State the decision, not the background."),
        header: z.string().max(24).optional().describe("Two or three words for the card's eyebrow."),
        context: z.string().max(2_000).optional().describe("Why you are asking and what you already tried. Not an option."),
        options: z.array(z.object({
          label: z.string().min(1).max(60),
          description: z.string().max(300).optional(),
        })).min(2).max(4).describe("Real, mutually exclusive choices."),
        recommendation: z.string().max(400).optional().describe("Which option you recommend and why. Always give one."),
        requirementIds: z.array(z.string().min(1)).max(12).optional()
          .describe("The requirement ids this decision resolves or gates (read_requirements). The decision is pinned to them."),
        urgency: z.enum(["blocking", "deferred"]).default("blocking"),
      },
      async (args: {
        question: string; header?: string; context?: string;
        options: { label: string; description?: string }[];
        recommendation?: string; requirementIds?: string[];
        urgency: "blocking" | "deferred";
      }) => {
        try {
          assertLiveRequirementIds(args.requirementIds ?? []);
        } catch (error) {
          return fail(error);
        }
        const question = {
          question: args.question,
          ...(args.header ? { header: args.header } : {}),
          ...(args.context ? { context: args.context } : {}),
          options: args.options,
          ...(args.recommendation ? { recommendation: args.recommendation } : {}),
        };
        const pending = interactions.createOperatorQuestion({
          userSessionId,
          questions: [question],
          urgency: args.urgency,
          source: "agent",
          ...(args.recommendation ? { recommendation: args.recommendation } : {}),
          allowFreeText: true,
          ...(args.requirementIds === undefined || args.requirementIds.length === 0
            ? {} : { requirementIds: args.requirementIds }),
        });
        if (args.urgency === "deferred") {
          return ok({ queued: true, interactionId: pending.id, urgency: "deferred",
            note: "The operator can see this now; their answer will wake you. Keep working — do not poll." });
        }
        const resolved = await pending.resolution;
        if (resolved.kind === "answers") {
          return ok({ resolved: true, interactionId: pending.id, answers: resolved.answers,
            ...(resolved.freeText === undefined ? {} : { freeText: resolved.freeText }),
            ...(resolved.note === undefined ? {} : { note: resolved.note }),
            ledger: "Recorded as an operator decision, pinned to the named requirements." });
        }
        return ok({ resolved: false, interactionId: pending.id,
          reason: resolved.kind === "dismissed" ? resolved.reason : "the operator declined" });
      },
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
        // The full staffing picture, not a 4-field summary: a live run
        // staffed 34 seats without ever seeing models, permissions, turn
        // budgets, or skills — and invented phantom middle-manager seats the
        // catalog could have told it were miscast.
        return {
          availability: host.runtimeAvailability(),
          profiles: host.profiles(workspaceId).map((profile) => ({
            id: profile.id, title: profile.title, purpose: profile.purpose,
            role: profile.role ?? null,
            tools: profile.tools, permissionMode: profile.permissionMode,
            model: profile.model ?? null, maxTurns: profile.maxTurns,
            skills: profile.skills ?? [], mcpServers: Object.keys(profile.mcpServers ?? {}),
            handoffExtension: profile.handoffExtension ?? "generic",
          })),
          catalog: {
            skills: catalog.selectable().map(({ name, version, status, description, whenToUse, requiresTools, costNote }) =>
              ({ name, version, status, description, whenToUse, requiresTools, costNote })),
            mcpServers: MCP_CATALOG,
          },
          note: "Compose a variant with specialize_profile (narrow-only); assign extra skills per seat at commission time.",
        };
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
      "propose_requirements",
      "Put the REQUIREMENT GRAPH (or an amendment to it) to the operator for approval. Requirements are the run's canonical definition of done: a recursive outline of what must be TRUE of the finished work — each node one declarative, checkable statement; children compose 'all' by default, '(any of)' when one sufficient alternative establishes the parent. Write the canonical form: optional prose sections (## Context, ## Goals, ## Out of scope, ## Assumptions), then '## Requirements' as a nested list. KEEP the `rN:` id tags on lines you are keeping — dropping a tag RETIRES that requirement; a new line carries no tag and gets its id on approval. Statuses and evidence survive an amendment on unchanged statements; an edited statement resets its node to open. The operator may EDIT the outline in place; their text governs and is injected into every prompt. This call BLOCKS until they respond. Amend when reality invalidates part of it; never silently diverge.",
      {
        document: z.string().min(1).describe("The full outline. Example:\n## Requirements\n- The CLI parses every documented flag\n  - (any of) Config is loadable\n    - TOML config parses\n    - JSON config parses"),
        changeNote: z.string().min(1).describe("One line: what this revision is, or what changed and why (for amendments)."),
      },
      async (args: { document: string; changeNote: string }) => {
        const changeNote = clip(args.changeNote, 280);
        let draft: ReturnType<RequirementService["propose"]>;
        try {
          draft = requirements.propose(userSessionId, args.document, changeNote);
        } catch (error) {
          if (error instanceof RequirementParseFailure) {
            return fail(`the document is not a valid requirement outline — fix these lines and propose again:\n${error.errors.map((entry) => `- line ${entry.line}: ${entry.message}`).join("\n")}`);
          }
          return fail(error);
        }
        const nodeCount = flattenRequirementGraph(draft.graph as unknown as RequirementGraph).length;
        const { id: approvalId, resolution } = interactions.createRequirementsApproval(
          userSessionId, args.document, draft.revision, changeNote, nodeCount);
        const resolved = await resolution;
        if (resolved.kind === "decision" && resolved.approved) {
          const finalText = resolved.editedDocument?.trim() || args.document;
          let approved: ReturnType<RequirementService["approve"]>;
          try {
            approved = requirements.approve(draft.id, { document: finalText, interactionId: approvalId,
              edited: resolved.editedDocument !== undefined && resolved.editedDocument.trim() !== args.document.trim() });
          } catch (error) {
            requirements.reject(draft.id);
            return fail(error);
          }
          // An AMENDMENT lands while sessions may be mid-assignment against
          // the old revision. The next delivery re-anchors each of them, but
          // whether one needs steering NOW is main's materiality call — hand
          // it the list to make that call against.
          const running = approved.revision.revision > 1
            ? host.listForUserSession(userSessionId).filter((s) => s.status !== "archived")
              .map((s) => ({ agentSessionId: s.id, title: s.title, status: s.status }))
            : [];
          return ok({ approved: true, revision: approved.revision.revision,
            edited: approved.revision.origin === "operator_edited",
            document: approved.revision.document,
            added: approved.added, retired: approved.retired,
            note: (approved.revision.origin === "operator_edited"
              ? "The operator EDITED the requirements before approving — the canonical text above (ids minted) is theirs and governs. Read it fully."
              : "Approved as proposed. The canonical text above (ids minted) now governs the run.")
              + " Reference these ids in commissions (requirements), the ledger (requirementId), and report_requirement.",
            ...(running.length === 0 ? {} : { runningSessions: running,
              amendmentNote: "These sessions were briefed under an earlier revision. They learn of the change at their next delivery; judge materiality per session — steer with send_to_coordinator (category \"update\"), interrupt_agent for urgent redirects, or let immaterial ones finish." }) });
        }
        requirements.reject(draft.id);
        const note = resolved.kind === "decision" ? (resolved.note ?? "") : resolved.kind === "dismissed" ? resolved.reason : "";
        return ok({ approved: false, note, next: "Revise the requirements to address their words and propose again — or ask a sharper question first." });
      },
    ),

    sdk.tool(
      "read_requirements",
      "Read the governing requirements: the live outline with console-derived statuses ([·] open, [✓] satisfied, [✗] violated, [⊘] infeasible), verification tiers and evidence counts, plus the open-requirements frontier. Pass scopeId to read ONE subtree in full — the way to pull detail the injected digest collapsed. The root read includes the operator's approved intent prose. For a run still governed by a legacy markdown spec this returns that text with legacy: true.",
      {
        scopeId: z.string().min(1).optional().describe("Read only this requirement's subtree, in full."),
        cursor: z.string().optional(),
        maxBytes: z.number().int().min(1).max(PAGE_MAX_BYTES).default(PAGE_DEFAULT_BYTES),
      },
      async (args: { scopeId?: string; cursor?: string; maxBytes: number }) =>
        guarded(() => {
          const approved = requirements.latestApproved(userSessionId);
          if (approved === undefined) {
            const legacy = specs.latestApproved(userSessionId);
            if (!legacy) return { requirements: null, note: "no approved requirements yet — propose them with propose_requirements" };
            return { legacy: true, revision: legacy.revision, changeNote: legacy.changeNote,
              document: pageTail(legacy.document, args.cursor, args.maxBytes),
              note: "This run is governed by a legacy markdown spec. A requirement graph can supersede it via propose_requirements." };
          }
          if (args.scopeId !== undefined) {
            return { revision: approved.revision, scopeId: args.scopeId,
              document: pageTail(requirements.statusOutlineFor(userSessionId, args.scopeId), args.cursor, args.maxBytes) };
          }
          const intent = requirements.intentDocument(userSessionId);
          return { revision: approved.revision, changeNote: approved.changeNote,
            ...(intent === null ? {} : { intent }),
            document: pageTail(requirements.statusOutlineFor(userSessionId), args.cursor, args.maxBytes),
            frontier: requirements.frontier(userSessionId) };
        }),
    ),

    sdk.tool(
      "report_requirement",
      "Record a requirement STATUS with evidence. Statuses are semantic claims, never scores: satisfied (the statement holds — evidence required), violated (something broke it — evidence required), infeasible (cannot be achieved with available capability or authority — evidence required; route the consequence to the operator or a scope amendment), open (reopen a stale claim). Report LEAVES only — parents and the root derive mechanically from their children, and the operator remains the completion gate. verifiedBy is 'independent' only when the evidence comes from a different seat/profile than the one that did the work. Quantitative measurements belong INSIDE evidence refs, never as numbers ranking anything.",
      {
        requirementId: z.string().min(1).describe("A requirement id from read_requirements, e.g. \"r3\""),
        status: z.enum(["satisfied", "violated", "infeasible", "open"]),
        evidence: z.array(EvidenceRefSchema).default([]).describe("What proves the claim: files, artifacts, tasks, commands, urls. Required for satisfied/violated/infeasible."),
        verifiedBy: z.enum(["self", "independent"]).default("self")
          .describe("'independent' only when a different agent/profile than the implementer produced the evidence (a reviewer's verdict, a fresh verification)."),
        note: z.string().optional().describe("One line of context (why infeasible, what reopened it)."),
      },
      async (args: { requirementId: string; status: "satisfied" | "violated" | "infeasible" | "open";
        evidence: { kind: "file" | "journal" | "artifact" | "task" | "command" | "url"; ref: string; label?: string }[];
        verifiedBy: "self" | "independent"; note?: string }) =>
        guarded(() => {
          const wire = requirements.reportStatus({
            userSessionId, requirementId: args.requirementId, to: args.status,
            evidence: args.evidence, verifiedBy: args.verifiedBy, actor: "main",
            ...(args.note === undefined ? {} : { note: clip(args.note, 280) }),
          });
          return { requirementId: wire.id, status: wire.status, derivedRoot: requirements.rootStatus(userSessionId),
            note: "Recorded. Parents derive mechanically; the sign-off card renders the tree with this claim and its evidence." };
        }),
    ),

    sdk.tool(
      "decompose_requirement",
      "Refine a requirement by adding child requirements BELOW it — how a committed obligation is discharged, stated as smaller checkable statements. Decomposition needs no operator approval (it refines representation, never meaning) and is journaled and attributed. The LINE: editing a statement, retiring a requirement, or adding a new top-level obligation changes what counts as success — those are scope amendments and go through propose_requirements.",
      {
        parentId: z.string().min(1).describe("The requirement being refined"),
        children: z.array(z.object({
          statement: z.string().min(1).describe("One declarative, checkable statement"),
          composition: z.enum(["all", "any"]).default("all"),
        })).min(1).max(8),
        why: z.string().optional().describe("Why this refinement — journaled."),
      },
      async (args: { parentId: string; children: { statement: string; composition: "all" | "any" }[]; why?: string }) =>
        guarded(() => {
          const added = requirements.decompose({
            userSessionId, parentId: args.parentId, children: args.children, actor: "main",
          });
          return { parentId: args.parentId, added,
            note: "Children added as refinement nodes (open). The parent's status now derives from them." };
        }),
    ),

    /**
     * The premise surface: durable, id-bearing assumptions linked to the
     * requirements that rest on them — the alternative to a default nobody
     * wrote down. Recording is un-gated; falsification decorates and wakes,
     * never rewrites status.
     */
    sdk.tool(
      "record_assumption",
      "Record an assumption the work proceeds on — a default you took where the operator was not asked, a belief a requirement rests on. Name the requirement ids that rest on it (requirementIds): a later falsification then FLAGS their claims and wakes you. Recording needs no approval — it is what makes the premise visible and falsifiable instead of silently invented. A boundary the operator imposed on the WORK belongs in the requirements (propose_requirements); a resolved question is a decision, not an assumption.",
      {
        text: z.string().min(1).describe("One declarative premise, e.g. \"WoW-like means real-time combat, not turn-based\"."),
        requirementIds: z.array(z.string().min(1)).max(12).optional()
          .describe("Requirements that rest on this premise (rests_on links)."),
        interactionId: z.string().optional().describe("The ask that raised it, when one exists."),
      },
      async (args: { text: string; requirementIds?: string[]; interactionId?: string }) =>
        guarded(() => {
          assertLiveRequirementIds(args.requirementIds ?? []);
          const wire = assumptions.record({
            userSessionId, text: args.text, source: "main", actor: "main",
            ...(args.interactionId === undefined ? {} : { interactionId: args.interactionId }),
            ...(args.requirementIds === undefined ? {} : { requirementIds: args.requirementIds }),
          });
          return { assumptionId: wire.id, requirementIds: wire.requirementIds,
            note: "Recorded. Seats working under the linked requirements see it; resolve_assumption closes it with provenance." };
        }),
    ),

    sdk.tool(
      "resolve_assumption",
      "Resolve a recorded assumption: confirmed (evidence or an operator answer establishes it), falsified (reality contradicts it — the Console flags dependent terminal claims and wakes you; judge them yourself), or retired (it stopped mattering). confirmed/falsified need provenance: evidence refs, or the interactionId of the operator answer that settled it. An assumption that should now GOVERN success is an amendment (propose_requirements), never an automatic promotion.",
      {
        assumptionId: z.string().min(1).describe("An id from record_assumption, e.g. \"a2\"."),
        outcome: z.enum(["confirmed", "falsified", "retired"]),
        note: z.string().optional(),
        evidence: z.array(EvidenceRefSchema).default([]),
        interactionId: z.string().optional().describe("The operator answer that settled it, when that is the provenance."),
      },
      async (args: { assumptionId: string; outcome: "confirmed" | "falsified" | "retired"; note?: string;
        evidence: { kind: "file" | "journal" | "artifact" | "task" | "command" | "url"; ref: string; label?: string }[];
        interactionId?: string }) =>
        guarded(() => {
          const wire = assumptions.resolve({
            userSessionId, assumptionId: args.assumptionId, outcome: args.outcome, actor: "main",
            ...(args.note === undefined ? {} : { note: args.note }),
            evidence: args.evidence,
            ...(args.interactionId === undefined ? {} : { interactionId: args.interactionId }),
          });
          return { assumptionId: wire.id, status: wire.status, requirementIds: wire.requirementIds };
        }),
    ),

    sdk.tool(
      "link_requirements",
      "Record a relationship between requirements: depends_on (fromId cannot be satisfied before toId is — feeds the frontier's blocked annotation and flags fromId's claim if toId later moves; acyclic), or conflicts_with (the two cannot both be satisfied as written — symmetric; recorded for the operator to see, resolved by an amendment or their decision). Links never change derived statuses — the tree alone derives.",
      {
        fromId: z.string().min(1),
        kind: z.enum(["depends_on", "conflicts_with"]),
        toId: z.string().min(1),
        note: z.string().optional().describe("Why, in one line."),
      },
      async (args: { fromId: string; kind: "depends_on" | "conflicts_with"; toId: string; note?: string }) =>
        guarded(() => {
          const result = requirements.link({
            userSessionId, fromId: args.fromId, kind: args.kind, toId: args.toId, actor: "main",
            ...(args.note === undefined ? {} : { note: args.note }),
          });
          return { ...result, fromId: args.fromId, kind: args.kind, toId: args.toId,
            ...(result.recorded ? {} : { note: "already recorded — links are idempotent" }) };
        }),
    ),

    sdk.tool(
      "unlink_requirements",
      "Retire a recorded relationship that no longer holds (a resolved conflict, a dependency an amendment removed).",
      {
        fromId: z.string().min(1),
        kind: z.enum(["depends_on", "conflicts_with", "rests_on"]),
        toId: z.string().min(1),
      },
      async (args: { fromId: string; kind: "depends_on" | "conflicts_with" | "rests_on"; toId: string }) =>
        guarded(() => {
          requirements.unlink({ userSessionId, fromId: args.fromId, kind: args.kind, toId: args.toId, actor: "main" });
          return { retired: true, fromId: args.fromId, kind: args.kind, toId: args.toId };
        }),
    ),

    sdk.tool(
      "update_orchestration_state",
      "Revise YOUR working state — the durable memory your next generation reads: current strategy (and why), open uncertainties, standing assumptions, live risks. Any section you pass REPLACES that section wholly; omitted sections persist. A load-bearing assumption that specific REQUIREMENTS rest on belongs in record_assumption (id-linked, falsifiable-with-consequence); this scratchpad is for strategy-level notes. Update on material events — commissioning, an alarm you acted on, a discovery that changes the plan, a direction change, before declaring done — never as per-turn ceremony. When you work around a coordination structure the patterns cannot express, note it with the tag 'pattern-friction:'.",
      {
        trigger: z.enum(["commission", "discovery", "alarm", "direction_change", "operator"])
          .describe("What occasioned this update."),
        strategy: z.string().optional().describe("Current approach, one or two sentences."),
        strategyWhy: z.string().optional().describe("Why this strategy over its live alternatives."),
        uncertainties: z.array(z.string()).optional().describe("Open CONSEQUENTIAL uncertainties (whose answers would change the build). At most 8 survive."),
        assumptions: z.array(z.string()).optional().describe("Load-bearing assumptions the plan rests on. At most 8 survive."),
        risks: z.array(z.string()).optional().describe("Live risks that currently matter. At most 8 survive."),
        note: z.string().optional().describe("What occasioned THIS update, one line."),
        incorporating: z.array(z.string().min(1)).max(8).optional()
          .describe("When this update incorporates specific returned results or evidence, name them (handoff / agent-session / artifact ids). Optional — skip when the update isn't about a returned result."),
      },
      async (args: { trigger: "commission" | "discovery" | "alarm" | "direction_change" | "operator";
        strategy?: string; strategyWhy?: string; uncertainties?: string[]; assumptions?: string[]; risks?: string[]; note?: string;
        incorporating?: string[] }) =>
        guarded(() => {
          // These sections feed a size-capped prompt digest: clip, never reject.
          const row = state.update(userSessionId, { ...args,
            ...(args.strategy === undefined ? {} : { strategy: clip(args.strategy, 500) }),
            ...(args.strategyWhy === undefined ? {} : { strategyWhy: clip(args.strategyWhy, 500) }),
            ...(args.uncertainties === undefined ? {} : { uncertainties: clipAll(args.uncertainties, 200, 8) }),
            ...(args.assumptions === undefined ? {} : { assumptions: clipAll(args.assumptions, 200, 8) }),
            ...(args.risks === undefined ? {} : { risks: clipAll(args.risks, 200, 8) }),
            ...(args.note === undefined ? {} : { note: clip(args.note, 280) }) });
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
      "Record the completion justification when you believe the run is done: each requirement mapped to its EVIDENCE (met or honestly not), known gaps, and deliberate non-goals. With a governing requirement graph, criteria are REQUIREMENT IDS verified against the current revision; a legacy-spec run keeps freeform criterion strings. The sign-off card shows this beside the console's own facts (git diff, ledger, requirement tree, uncertainty) — an absent record renders as a visible omission. Not a gate: recording it does not complete the run; the operator does.",
      {
        criteria: z.array(z.object({
          requirement: z.string().optional().describe("A requirement id from read_requirements (required when a requirement graph governs)"),
          criterion: z.string().optional().describe("Freeform criterion text (legacy-spec runs only)"),
          met: z.boolean(),
          evidence: z.array(EvidenceRefSchema).default([]).describe("What proves it: artifacts, files, journal refs, commands"),
        })).min(1).describe("At most 12 survive. Each entry names either a requirement id or a criterion string."),
        knownGaps: z.array(z.string()).default([]).describe("What is not done or not verified, and you know it. At most 8 survive."),
        nonGoals: z.array(z.string()).default([]).describe("Deliberately out of scope (incl. declined opportunities). At most 8 survive."),
        requirementsRevision: z.number().int().min(1).optional()
          .describe("The approved REQUIREMENTS revision verified against. REQUIRED when a requirement graph governs — the completion predicate matches it against the current approved revision."),
        specRevision: z.number().int().min(1).optional()
          .describe("Legacy-spec runs only: the approved spec revision verified against."),
        note: z.string().optional(),
      },
      async (args: { criteria: { requirement?: string; criterion?: string; met: boolean; evidence?: { kind: "file" | "journal" | "artifact" | "task" | "command" | "url"; ref: string; label?: string }[] }[];
        knownGaps: string[]; nonGoals: string[]; requirementsRevision?: number; specRevision?: number; note?: string }) =>
        guarded(() => {
          // Fail loudly on a stale or missing revision — a record against a
          // superseded document would silently never satisfy the completion
          // predicate.
          const governing = requirements.latestApproved(userSessionId);
          if (governing !== undefined) {
            if (args.requirementsRevision === undefined) {
              throw new InvalidInputError(`a requirement graph governs (approved rev ${governing.revision}); pass requirementsRevision after verifying against it`);
            }
            if (args.requirementsRevision !== governing.revision) {
              throw new InvalidInputError(`requirementsRevision ${args.requirementsRevision} is not the current approved revision ${governing.revision}; re-verify against the current requirements`);
            }
            const live = new Map(requirements.derive(userSessionId).map((node) => [node.id, node]));
            for (const entry of args.criteria) {
              if (entry.requirement === undefined) {
                throw new InvalidInputError("a requirement graph governs — every criteria entry must name a requirement id (read_requirements lists them)");
              }
              if (!live.has(entry.requirement)) {
                throw new InvalidInputError(`unknown or retired requirement "${entry.requirement}" — read_requirements lists the live graph`);
              }
            }
          } else {
            const approved = specs.latestApproved(userSessionId);
            if (approved !== undefined) {
              if (args.specRevision === undefined) {
                throw new InvalidInputError(`a spec exists (approved rev ${approved.revision}); pass specRevision after verifying the criteria against it`);
              }
              if (args.specRevision !== approved.revision) {
                throw new InvalidInputError(`specRevision ${args.specRevision} is not the current approved revision ${approved.revision}; re-verify against the current spec`);
              }
            }
          }
          const statements = governing === undefined
            ? new Map<string, string>()
            : new Map(requirements.derive(userSessionId).map((node) => [node.id, node.statement]));
          const row = state.recordCompletion(userSessionId,
            { criteria: args.criteria.slice(0, 12).map((entry) => ({
                ...(entry.requirement === undefined ? {} : { requirement: entry.requirement,
                  // The statement joins server-side so the sign-off card shows
                  // text, not ids — and shows the statement AS VERIFIED.
                  statement: clip(statements.get(entry.requirement) ?? "", 200) }),
                ...(entry.criterion === undefined ? {} : { criterion: clip(entry.criterion, 200) }),
                met: entry.met, evidence: entry.evidence ?? [] })),
              knownGaps: clipAll(args.knownGaps ?? [], 200, 8), nonGoals: clipAll(args.nonGoals ?? [], 200, 8),
              ...(args.requirementsRevision === undefined ? {} : { requirementsRevision: args.requirementsRevision }),
              ...(args.specRevision === undefined ? {} : { specRevision: args.specRevision }) },
            args.note === undefined ? undefined : clip(args.note, 280));
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
      "specialize_profile",
      "Mint a run-scoped profile VARIANT from a trusted base, then seat it like any profile. Narrow-only by construction: tools must be a subset of the base's, permissionMode may only stay or drop, instructions are ADDITIVE, MCP servers attach by catalog name only (never a command), skills come from the catalog. Use it when the fixed profiles miscast a role — a cheaper implementer for mechanical work, an implementer with the browser for visual verification, a reviewer scoped to one subsystem. Journaled; no operator approval needed because a mint grants strictly less than the per-seat overrides you already hold.",
      {
        id: z.string().regex(/^[a-z][a-z0-9-]*$/).describe("New profile id, e.g. 'render-implementer'"),
        baseProfileId: z.string().min(1).describe("A trusted base from list_agent_profiles"),
        title: z.string().optional(),
        purpose: z.string().optional(),
        instructionsAppend: z.string().optional().describe("Appended to the base instructions as a Specialization section"),
        tools: z.array(z.string()).optional().describe("Subset of the base's tools; omit to keep them all"),
        permissionMode: z.enum(["default", "plan", "bypassPermissions"]).optional().describe("Same or lower than the base's"),
        model: z.string().optional(),
        skills: z.array(z.string()).optional().describe("From the catalog; validated against the mint's tools"),
        attachServers: z.array(z.string()).optional().describe("Attachable console-catalog MCP servers, by name (e.g. 'browser')"),
        maxTurns: z.number().int().min(1).max(100).optional(),
        why: z.string().optional().describe("Why this variant — journaled with the mint"),
      },
      async (args: { id: string; baseProfileId: string; title?: string; purpose?: string; instructionsAppend?: string;
        tools?: string[]; permissionMode?: "default" | "plan" | "bypassPermissions"; model?: string;
        skills?: string[]; attachServers?: string[]; maxTurns?: number; why?: string }) =>
        guarded(() => {
          const workspaceId = repo.getUserSession(userSessionId)?.workspaceId;
          const minted = registry.mint({ ...args, userSessionId, ...(workspaceId === undefined ? {} : { workspaceId }) });
          if (args.skills !== undefined && args.skills.length > 0) {
            const problems = catalog.validateAssignment(args.skills, minted.tools);
            if (problems.length > 0) throw new InvalidInputError(problems.join("; "));
          }
          return { profileId: minted.id, base: args.baseProfileId, tools: minted.tools,
            permissionMode: minted.permissionMode, skills: minted.skills ?? [],
            mcpServers: Object.keys(minted.mcpServers ?? {}), maxTurns: minted.maxTurns,
            note: "Seat it via create_agent_session or add_agent like any profile id." };
        }),
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
        skills: z.array(z.string()).optional().describe("Extra skills for this seat, from the catalog — pinned into its snapshot."),
        why: z.string().optional()
          .describe("Why this seat now — the emergent need the roster did not anticipate. Journaled with the addition; the entry agent and the run review read it."),
      },
      async (args: { agentSessionId: string; name: string; profileId: string; instructions?: string; model?: string; owns: string[]; skills?: string[]; why?: string }) =>
        guarded(() => {
          const session = owned(args.agentSessionId);
          if (args.skills !== undefined && args.skills.length > 0) {
            const profileTools = host.profiles(repo.getUserSession(session.userSessionId)?.workspaceId)
              .find((profile) => profile.id === args.profileId)?.tools ?? [];
            const problems = catalog.validateAssignment(args.skills, profileTools);
            if (problems.length > 0) throw new InvalidInputError(problems.join("; "));
          }
          const added = host.addAgent(args.agentSessionId, {
            name: args.name, profileId: args.profileId,
            ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
            ...(args.model === undefined ? {} : { model: args.model }),
            owns: args.owns,
            ...(args.skills === undefined ? {} : { skills: args.skills }),
            ...(args.why === undefined ? {} : { why: args.why }),
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
        reason: z.string().min(1).describe("Why — journaled; a child's controller reads it"),
      },
      async (args: { agentSessionId: string; reason: string }) =>
        guarded(() => {
          owned(args.agentSessionId);
          const closed = host.closeSession(args.agentSessionId, clip(args.reason, 280));
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
        reason: z.string().min(1).describe("Why — journaled and shown to the agent's successor turn"),
      },
      async (args: { agentSessionId: string; agent: string; reason: string }) =>
        guarded(() => {
          owned(args.agentSessionId);
          // The successor turn reads this reason; clipping generously beats
          // the observed alternative (four rejected attempts in 11 seconds,
          // each retry hand-shortening the recovery instruction).
          host.interruptAgent(args.agentSessionId, args.agent, `main: ${clip(args.reason, 1_000)}`);
          return { interrupted: true, agent: args.agent,
            note: "The turn was stopped and its deliveries cancelled; queued deliveries (including anything you post now) deliver next. The seat's work so far is preserved by the failure path." };
        }),
    ),

  ];

  return sdk.createSdkMcpServer({ name: "console", version: "1.0.0", tools, alwaysLoad: true });
}
