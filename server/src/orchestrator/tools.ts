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
import { effectiveNativeTools } from "../sdk/native-capability-policy.ts";
import { MAIN_TOOL_NAMES } from "./grants.ts";
import { renderDecisionIssue, type DecisionIssueService } from "./decision-issues.ts";
import type { InteractionService } from "./interactions.ts";
import type { AssumptionService } from "./assumptions.ts";
import type { ChangeImpactService } from "./change-impact.ts";
import type { WorkstreamService } from "../portfolio/workstreams.ts";
import { RequirementParseFailure, type RequirementService } from "./requirements.ts";
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
  decisionIssues: DecisionIssueService;
  requirements: RequirementService;
  assumptions: AssumptionService;
  changeImpacts: ChangeImpactService;
  workstreams: WorkstreamService;
  state: OrchestrationStateService;
  /** Skills + attachable-server metadata, for staffing and mint validation. */
  catalog: CapabilityCatalog;
  /** The profile registry — the mint path lives on it. */
  registry: AgentProfileRegistry;
}

export function buildConsoleMcpServer(input: ConsoleToolsInput): unknown {
  const { sdk, host, repo, bus, userSessionId, tasks, scheduler, handoffs, artifacts, interactions, decisionIssues, requirements, assumptions, changeImpacts, workstreams, state, catalog, registry } = input;

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
      "Create and immediately launch a Console-managed AgentSession running an orchestration pattern over profile-bound agents. Choose the shape the WORK has: hub_and_spoke — a coordinator sequences specialists (the default); pipeline — stages that each ADD information; evaluator_optimizer — a deliverable revised against a rubric; map_reduce — independent items fanned out, synthesized; debate — one blind round of independent argument; peer_to_peer — a direct-handoff mesh, rarely; plan_execute — an explicit task DAG. The orchestration-patterns skill carries sizing, briefing craft, and failure modes. Pass the initial ledger units in `tasks`, WHY you are commissioning (`why`), and what evidence counts as success (`expecting`).",
      {
        title: z.string().describe("Short working title for the session"),
        pattern: z.enum(PATTERN_IDS).default("hub_and_spoke")
          .describe("debate is a single BLIND round — agent instructions must not promise rebuttals or exchanges."),
        patternConfig: z.record(z.string(), z.unknown()).optional()
          .describe("Pattern config: evaluator_optimizer {rubric, maxRounds, generatorAgent}; map_reduce {maxMappers}; debate {rubric, judgeProfileId, judgeModel}; peer_to_peer {closerAgent, maxHandoffs}; plan_execute {plannerAgent}."),
        agents: z
          .array(
            z.object({
              name: z.string().describe("Agent name, e.g. 'scout'"),
              profileId: z.string().describe("A profile id returned by list_agent_profiles"),
              instructions: z.string().optional().describe("Agent brief appended to the profile instructions"),
              model: z.string().optional().describe("Model override"),
              skills: z.array(z.string()).optional().describe("Extra skills to RECOMMEND to this seat, union'd with the profile's defaults."),
              owns: z.array(z.string()).default([]).describe("Exclusive write scope. Required for a writing agent. One project-wide rule: a scope any open workstream owns is rejected unless every claimant declares it shared."),
              sharedOwns: z.array(z.object({ scope: z.string().min(1), why: z.string().min(1) })).optional()
                .describe("Scopes deliberately co-owned with another workstream, each with a why; EVERY claimant must declare the share."),
            }),
          )
          .min(1)
          .max(20),
        briefing: HandoffDraftSchema
          .describe("The entry assignment: objective, evidence, risk, uncertainty, next action"),
        allowChildSessions: z.boolean().default(false)
          .describe("Let the ENTRY agent spawn child sessions, for a workstream with its own decomposition."),
        budgetUsd: z.number().positive().optional()
          .describe("Spend ceiling in USD (session plus children); crossing it makes the session wrap up and escalates to you."),
        why: z.string().optional()
          .describe("Why this session, this pattern, now. Journaled; the run review reads it."),
        expecting: z.string().optional()
          .describe("What evidence counts as success or would change your plan — the session's success contract."),
        requirements: z.array(z.string().min(1)).max(12).optional()
          .describe("Requirement ids this session answers for — its delegated sub-scope; the entry agent gets scoped reporting tools. Delegate OPEN requirements."),
        dependsOn: z.array(z.object({
          agentSessionId: z.string().min(1).describe("The producer workstream."),
          subject: z.string().min(1).describe("What it awaits, one line."),
        })).max(8).optional()
          .describe("Dependencies on other workstreams, declared at commission: this session cannot safely complete until each producer delivers its subject. Use link_workstreams for links discovered later."),
        tasks: z.array(z.object({
          taskId: z.string().min(1).describe("Short stable id, e.g. \"core\""),
          subject: z.string().min(1),
          description: z.string().optional(),
          owner: z.string().optional().describe("The agent that will do the work"),
          blockedBy: z.array(z.string()).optional().describe("taskIds this unit depends on"),
          requirementId: z.string().min(1).optional().describe("The requirement this unit discharges."),
        })).max(20).optional()
          .describe("Ledger units created WITH the session — the briefing's taskId resolves."),
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
          sharedOwns?: { scope: string; why: string }[];
        }[];
        briefing: HandoffDraft;
        allowChildSessions?: boolean;
        budgetUsd?: number;
        why?: string;
        expecting?: string;
        requirements?: string[];
        dependsOn?: { agentSessionId: string; subject: string }[];
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
            const skillProfile = host.profiles(workspaceIdForSkills).find((profile) => profile.id === agent.profileId);
            const problems = catalog.validateAssignment(agent.skills,
              skillProfile === undefined ? [] : effectiveNativeTools(skillProfile, "seat"));
            if (problems.length > 0) throw new InvalidInputError(`agent "${agent.name}": ${problems.join("; ")}`);
          }
          // Delegated requirements AND task-level requirement links validate
          // BEFORE anything spawns — a session must never launch against ids
          // that do not exist.
          assertLiveRequirementIds(args.requirements ?? []);
          assertLiveRequirementIds((args.tasks ?? [])
            .map((unit) => unit.requirementId)
            .filter((id): id is string => id !== undefined));
          // Declared dependencies validate BEFORE anything spawns: each
          // producer must exist in this conversation and must not already be
          // abandoned — a session must never launch waiting on nothing.
          for (const dep of args.dependsOn ?? []) {
            const producer = owned(dep.agentSessionId);
            if (producer.lifecycle !== "open" && !host.reportedFinal(producer)) {
              throw new InvalidInputError(`dependsOn producer ${dep.agentSessionId} was archived without reporting — it will never produce; name the successor session instead`);
            }
          }
          const created = host.createSession({
            userSessionId,
            title: args.title,
            pattern: args.pattern,
            ...(args.patternConfig ? { patternConfig: args.patternConfig } : {}),
            agents: args.agents,
            briefing,
            ...(args.allowChildSessions === true ? { allowChildSessions: true } : {}),
            ...(args.budgetUsd === undefined ? {} : { budgetUsd: args.budgetUsd }),
            ...(args.tasks === undefined ? {} : { tasks: args.tasks }),
            // The lifecycle records the delegation BEFORE the briefing
            // dispatches, so the very first delivery renders the sub-scope.
            ...(args.requirements === undefined || args.requirements.length === 0 ? {} : { requirements: args.requirements }),
          });
          // Commission-time dependency links land right after creation, so
          // the very first delivery renders them to the new session's seats.
          const declaredLinks = (args.dependsOn ?? []).map((dep) => workstreams.link({
            userSessionId, consumerAgentSessionId: created.agentSessionId,
            producerAgentSessionId: dep.agentSessionId, subject: dep.subject, createdBy: "main",
          }));
          return {
            agentSessionId: created.agentSessionId,
            agents: created.agents,
            pattern: args.pattern,
            ...(declaredLinks.length === 0 ? {} : {
              dependsOn: declaredLinks.map((wire) => ({ linkId: wire.id, producerAgentSessionId: wire.producerAgentSessionId, subject: wire.subject, status: wire.status })),
            }),
            // Steer it with `send_to_coordinator`, not with a peer address:
            // the native mesh is gone and a peer name is only live while the
            // agent's process is. The tool reaches this session's entry agent.
            entryAgent: created.entryAgent,
            ...(created.coordinatorName ? { coordinator: created.coordinatorName } : {}),
            status: "launched",
            // Soft traceability: never a rejection — exploration before
            // decomposition is legitimate — but the omission is visible.
            ...((args.requirements === undefined || args.requirements.length === 0) && requirements.latestApproved(userSessionId) !== undefined
              ? { scopeNote: `Commissioned without requirement ids while requirements rev ${requirements.latestApproved(userSessionId)!.revision} governs — this session renders as unscoped. Pass \`requirements\` to delegate a sub-scope and grant scoped reporting tools.` }
              : {}),
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
      "Send a typed handoff to an AgentSession's entry agent — how you steer a running session after its briefing. The fields ARE the handoff; the Console builds, journals and carries the envelope. " +
      "Set `to` to reach ANY agent directly with a category:\"update\" steering message — assignments still enter only through the entry agent.",
      {
        agentSessionId: z.string().min(1),
        to: z.string().min(1).optional()
          .describe("Recipient agent name. Omit for the entry agent. Non-entry recipients accept \"update\" only."),
        category: z.enum(["assignment", "update"])
          .describe("\"assignment\" is new work owed back; \"update\" is steering for work already assigned."),
        status: HandoffCoreSchema.shape.status,
        risk: HandoffCoreSchema.shape.risk.default("medium"),
        action: z.string().min(1).describe("The request, in one line."),
        stateSummary: z.string().min(1).describe("What is true now — the substance, not a description of it."),
        evidence: z.array(EvidenceRefSchema).default([]).describe("Pointers backing the state."),
        resultSummary: z.string().nullable().default(null)
          .describe("Anything already produced that the session should build on."),
        artifacts: z.array(EvidenceRefSchema).default([]).describe("Outputs handed over, distinct from evidence."),
        uncertainty: z.array(z.string()).default([]).describe("What you could not verify."),
        nextAction: z.string().nullable().default(null).describe("The exact next step, or null."),
        taskId: z.string().nullable().default(null)
          .describe("The ledger taskId this assignment covers."),
        requestExpandedContext: z.boolean().default(false),
        why: z.string().optional().describe("Why this move now."),
        expecting: z.string().optional()
          .describe("What evidence would count as success, or change your plan."),
        requirements: z.array(z.string().min(1)).max(12).optional()
          .describe("Requirement ids this message serves — journaled as the delegated sub-scope; entry agent only."),
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
     * Main's ledger, console-owned and keyed to the AgentSession — never a
     * provider session id.
     */
    sdk.tool(
      "task_create",
      "Add a unit of work to the ledger; open units are reported to the operator alongside any final. Declare dependencies as blockedBy — the Console dispatches assignments on that DAG.",
      {
        agentSessionId: z.string().min(1).describe("The session doing the work."),
        taskId: z.string().min(1).describe("Short stable id, e.g. \"1\"."),
        subject: z.string().min(1),
        description: z.string().default(""),
        owner: z.string().min(1).describe("The agent that will DO this work — not you."),
        blockedBy: z.array(z.string()).default([]).describe("taskIds this depends on; forward references fine."),
        requirementId: z.string().min(1).optional().describe("The requirement this unit discharges."),
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
      "Update a ledger entry. Completing a task dispatches any assignments scheduled behind it; removeBlockedBy drops a dependency that no longer holds.",
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
      "Read the ledger for this conversation. Authoritative and shared with every agent.",
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
      "Wake yourself later, for things the Console cannot notify you about. You do NOT need it for agent reports — they wake you automatically.",
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
      "Ask the Human Operator one decision that specific requirements hang on; the answer records as a decision PINNED to those ids — it reaches every seat under them and never ages out while they are open. Native AskUserQuestion covers batched clarification with no requirement anchor. 'blocking' parks this call until they answer; 'deferred' returns now and the answer wakes you.",
      {
        question: z.string().min(1).describe("One concrete question. State the decision, not the background."),
        header: z.string().max(24).optional().describe("Card eyebrow, two or three words."),
        context: z.string().max(2_000).optional().describe("Why you are asking and what you already tried."),
        options: z.array(z.object({
          label: z.string().min(1).max(60),
          description: z.string().max(300).optional(),
        })).min(2).max(4).describe("Real, mutually exclusive choices."),
        recommendation: z.string().max(400).optional().describe("Your recommended option and why. Always give one."),
        requirementIds: z.array(z.string().min(1)).max(12).optional()
          .describe("The requirement ids this decision resolves or gates."),
        urgency: z.enum(["blocking", "deferred"]).default("blocking"),
        issueKey: z.string().min(1).max(64).optional()
          .describe("Stable key naming the underlying human decision; asks sharing a key become ONE issue, resolved by one answer. Check list_decision_issues first."),
      },
      async (args: {
        question: string; header?: string; context?: string;
        options: { label: string; description?: string }[];
        recommendation?: string; requirementIds?: string[];
        urgency: "blocking" | "deferred"; issueKey?: string;
      }) => {
        try {
          assertLiveRequirementIds(args.requirementIds ?? []);
        } catch (error) {
          return fail(error);
        }
        let issue: { id: string; created: boolean };
        try {
          const opened = decisionIssues.openForAsk({
            userSessionId,
            issueKey: args.issueKey,
            subject: args.question,
            requirementIds: args.requirementIds ?? [],
            createdBy: "main",
          });
          issue = { id: opened.issue.id, created: !opened.attachedToExisting };
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
          issue,
        });
        const attachNote = issue.created ? "" :
          ` This question joined open decision issue ${issue.id} — one operator answer resolves every attached ask.`;
        if (args.urgency === "deferred") {
          return ok({ queued: true, interactionId: pending.id, issueId: issue.id, urgency: "deferred",
            note: `The operator can see this now; their answer will wake you. Keep working — do not poll.${attachNote}` });
        }
        const resolved = await pending.resolution;
        if (resolved.kind === "answers") {
          return ok({ resolved: true, interactionId: pending.id, issueId: issue.id, answers: resolved.answers,
            ...(resolved.freeText === undefined ? {} : { freeText: resolved.freeText }),
            ...(resolved.note === undefined ? {} : { note: resolved.note }),
            ledger: "Recorded as an operator decision, pinned to the named requirements." });
        }
        return ok({ resolved: false, interactionId: pending.id, issueId: issue.id,
          reason: resolved.kind === "dismissed" ? resolved.reason : "the operator declined" });
      },
    ),

    /**
     * The decision-issue registry, main's side: read it, bind a chat answer
     * to exactly one issue, and merge duplicates it discovers. Human
     * resolution stays operator authority — resolve_decision_issue RELAYS the
     * operator's words with main-bound provenance; it is never main's own
     * judgment.
     */
    sdk.tool(
      "list_decision_issues",
      "List the project's decision issues — unresolved human choices with keys, askers, competing recommendations, and blocking weight, ordered by structural consequence. 'provisional' = proceeded on an asker's recommendation; the operator still owes the answer.",
      { status: z.enum(["open", "all"]).default("open") },
      async (args: { status: "open" | "all" }) =>
        guarded(() => ({
          issues: (args.status === "open"
            ? decisionIssues.listOpenForProject(userSessionId)
            : decisionIssues.listForProject(userSessionId)
          ).map((issue) => renderDecisionIssue(issue)),
        })),
    ),

    sdk.tool(
      "resolve_decision_issue",
      "Bind the operator's chat answer to ONE decision issue (the console holds open issues rather than guessing which a message meant). Pass their words, not a paraphrase — recorded as THEIR decision, it resolves every participating ask and wakes the askers. On a resolved issue it records a revision: history kept, seats notified. Never invent an answer they did not give.",
      {
        issueId: z.string().min(1).describe("The issue id (di_…) from the held-questions note or list_decision_issues."),
        answer: z.string().min(1).describe("The operator's answer, in their words."),
        note: z.string().optional(),
      },
      async (args: { issueId: string; answer: string; note?: string }) =>
        guarded(() => {
          const bound = interactions.bindIssueResolution({
            userSessionId, issueId: args.issueId, answer: args.answer,
            ...(args.note === undefined ? {} : { note: args.note }), via: "main",
          });
          return {
            ...bound,
            note: bound.outcome === "superseded"
              ? "Recorded as a revision — the earlier answer stays in the history; affected seats are being notified. If this changes committed requirements, propose the amendment through the normal requirement machinery."
              : bound.outcome === "unchanged"
                ? "The issue already carries exactly this answer — nothing changed."
                : "Recorded as the operator's decision; every participating ask is resolved and its asker woken.",
          };
        }),
    ),

    sdk.tool(
      "merge_decision_issues",
      "Merge two OPEN decision issues that are one human choice: the source's asks move to the target; one answer then resolves them all. Prefer leaving different choices split — a wrong merge applies one answer to a question the operator never read.",
      {
        fromIssueId: z.string().min(1),
        intoIssueId: z.string().min(1),
        why: z.string().min(1).describe("Why these are one human choice."),
      },
      async (args: { fromIssueId: string; intoIssueId: string; why: string }) =>
        guarded(() => {
          const merged = decisionIssues.merge({ userSessionId, ...args });
          return { merged: true, intoIssueId: merged.id, askCount: interactions.listAsksForIssue(merged.id).length };
        }),
    ),

    sdk.tool(
      "read_handoff",
      "Retrieve one lossless handoff section with cursor pagination.",
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
      "Read an agent session's transcript — the newest window plus cursors; paged, never assume one call returned everything. Narrow with afterSeq/limit first.",
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
      "List this conversation's agent sessions — the portfolio view: status, unseen counts, each open session's ownership scopes (shared claims marked with their why), and its workstream links with derived status. Broken dependencies surface under `attention`.",
      {},
      async () => guarded(() => {
        const links = workstreams.list(userSessionId).filter((wire) => wire.status !== "released");
        const sessions = host.listForUserSession(userSessionId).map((session) => {
          const dependsOn = links.filter((wire) => wire.consumerAgentSessionId === session.id)
            .map((wire) => ({ linkId: wire.id, producerAgentSessionId: wire.producerAgentSessionId, subject: wire.subject, status: wire.status }));
          const consumers = links.filter((wire) => wire.producerAgentSessionId === session.id)
            .map((wire) => ({ linkId: wire.id, consumerAgentSessionId: wire.consumerAgentSessionId, subject: wire.subject, status: wire.status }));
          const owns: string[] = [];
          if (session.status !== "archived") {
            for (const seat of repo.listAgents(session.id)) {
              const sharedWhys = new Map(seat.sharedOwnership.map((entry) => [entry.scope, entry.why]));
              for (const scope of seat.ownership) {
                owns.push(sharedWhys.has(scope) ? `${scope} (shared: ${sharedWhys.get(scope)!})` : scope);
              }
            }
          }
          return {
            ...session,
            ...(owns.length === 0 ? {} : { owns: owns.slice(0, 12), ...(owns.length > 12 ? { ownsElided: owns.length - 12 } : {}) }),
            ...(dependsOn.length === 0 ? {} : { dependsOn }),
            ...(consumers.length === 0 ? {} : { consumers }),
          };
        });
        const broken = links.filter((wire) => wire.status === "broken");
        return {
          sessions,
          ...(broken.length === 0 ? {} : {
            attention: {
              brokenDependencies: broken.map((wire) => ({
                linkId: wire.id, consumerAgentSessionId: wire.consumerAgentSessionId,
                producerAgentSessionId: wire.producerAgentSessionId, subject: wire.subject,
              })),
              note: "These consumers await a producer that was archived without reporting. Link a successor with link_workstreams or release the link with unlink_workstreams (with why).",
            },
          }),
        };
      }),
    ),

    sdk.tool(
      "session_activity",
      "LIVE state of a session's agents — what they are DOING now: lane posture, turn age, in-flight tool call with elapsed time, queued deliveries, context tokens, last handoff. Diagnose before intervening; list_agent_sessions cannot tell healthy work from a wedged call.",
      { agentSessionId: z.string().min(1) },
      async (args: { agentSessionId: string }) =>
        guarded(() => {
          owned(args.agentSessionId);
          return host.activity(args.agentSessionId);
        }),
    ),

    sdk.tool(
      "propose_requirements",
      "Put the REQUIREMENT GRAPH (or an amendment to it) to the operator for approval. STAGE the commitment: coarse vision-plus-top-level first, one subtree at a time with scopeId as you commission, intent:true for prose-only changes — the requirements-mechanics skill carries the grammar and staging discipline. KEEP the `rN:` id tags on lines you are keeping — dropping a tag RETIRES that requirement. The operator may EDIT the outline; their text governs. BLOCKS until they respond. Amend when reality invalidates part of it; never silently diverge.",
      {
        document: z.string().min(1).describe("The outline. Full: prose + ## Requirements. Subtree (scopeId set): ONLY that subtree's children under '## Requirements'. Intent (intent:true): prose + an empty '## Requirements'."),
        changeNote: z.string().min(1).describe("One line: what this revision is, or what changed and why."),
        scopeId: z.string().min(1).optional().describe("Amend only the subtree under this committed requirement id."),
        intent: z.boolean().optional().describe("Amend the intent prose alone."),
      },
      async (args: { document: string; changeNote: string; scopeId?: string; intent?: boolean }) => {
        const changeNote = clip(args.changeNote, 280);
        const kindOpts = {
          ...(args.scopeId === undefined ? {} : { scopeId: args.scopeId }),
          ...(args.intent === undefined ? {} : { intent: args.intent }),
        };
        let draft: ReturnType<RequirementService["propose"]>;
        try {
          draft = requirements.propose(userSessionId, args.document, changeNote, kindOpts);
        } catch (error) {
          if (error instanceof RequirementParseFailure) {
            return fail(`the document is not a valid requirement outline — fix these lines and propose again:\n${error.errors.map((entry) => `- line ${entry.line}: ${entry.message}`).join("\n")}`);
          }
          return fail(error);
        }
        const nodeCount = flattenRequirementGraph(draft.graph as unknown as RequirementGraph).length;
        // The card gets the SCOPE and a server-computed change summary — the
        // operator approves a small view in context, never a wall of nodes.
        const scope = draft.scopeId === null ? undefined : {
          scopeId: draft.scopeId,
          statement: requirements.derive(userSessionId).find((node) => node.id === draft.scopeId)?.statement ?? "",
          ancestors: requirements.ancestorPath(userSessionId, draft.scopeId),
        };
        const summary = requirements.previewChanges(userSessionId, args.document, kindOpts) ?? undefined;
        const { id: approvalId, resolution } = interactions.createRequirementsApproval(
          userSessionId, args.document, draft.revision, changeNote, nodeCount,
          { kind: draft.kind, ...(scope === undefined ? {} : { scope }), ...(summary === undefined ? {} : { summary }) });
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
          // it the list, with the sessions the CHANGE actually touches marked
          // (the transitive closure over changed/retired ids, descendants and
          // depends_on — console facts). When the change touched prior
          // evidence or active work, the Console persisted it as a change
          // impact; that record, not this tool result, is what holds the
          // affected set in attention until each item is reconciled.
          const touched = approved.impact !== null
            ? new Set(approved.impact.affected.sessions.map((entry) => entry.agentSessionId))
            : new Set(requirements.sessionsAffectedByChange(
              userSessionId, [...approved.changed, ...approved.retired]));
          const running = approved.revision.revision > 1
            ? host.listForUserSession(userSessionId).filter((s) => s.status !== "archived")
              .map((s) => ({ agentSessionId: s.id, title: s.title, status: s.status,
                ...(touched.has(s.id) ? { affectedByThisChange: true } : {}) }))
            : [];
          return ok({ approved: true, revision: approved.revision.revision,
            edited: approved.revision.origin === "operator_edited",
            document: approved.revision.document,
            added: approved.added, retired: approved.retired, changed: approved.changed,
            note: (approved.revision.origin === "operator_edited"
              ? "The operator EDITED the requirements before approving — the canonical text above (ids minted) is theirs and governs. Read it fully."
              : "Approved as proposed. The canonical text above (ids minted) now governs the run.")
              + " Reference these ids in commissions (requirements), the ledger (requirementId), and report_requirement.",
            ...(approved.impact === null ? {} : { changeImpact: {
              id: approved.impact.id,
              suspectClaims: approved.impact.affected.suspectClaims.map((claim) => ({ requirementId: claim.requirementId, status: claim.status, actor: claim.actor })),
              affectedSessions: approved.impact.affected.sessions.map((entry) => entry.agentSessionId),
              affectedTasks: approved.impact.affected.tasks.map((task) => task.taskId),
              note: "This amendment touched prior evidence or active work; the Console recorded the transitive affected set durably. Suspect claims clear when reopened or re-verified via report_requirement; sessions clear when archived; record every other judgment (stands / superseded / unaffected / steered / interrupted) with reconcile_change_impact. Completion holds while the impact is open.",
            } }),
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
      "Read the governing requirements: the live outline with console-derived statuses, verification tiers and evidence counts, plus the open-requirements frontier. Pass scopeId to read ONE subtree in full. The root read includes the operator's approved intent prose.",
      {
        scopeId: z.string().min(1).optional().describe("Read only this requirement's subtree, in full."),
        cursor: z.string().optional(),
        maxBytes: z.number().int().min(1).max(PAGE_MAX_BYTES).default(PAGE_DEFAULT_BYTES),
      },
      async (args: { scopeId?: string; cursor?: string; maxBytes: number }) =>
        guarded(() => {
          const approved = requirements.latestApproved(userSessionId);
          if (approved === undefined) {
            return { requirements: null, note: "no approved requirements yet — propose them with propose_requirements" };
          }
          if (args.scopeId !== undefined) {
            return { revision: approved.revision, scopeId: args.scopeId,
              document: pageTail(requirements.statusOutlineFor(userSessionId, args.scopeId), args.cursor, args.maxBytes) };
          }
          const intent = requirements.intentDocument(userSessionId);
          const openImpacts = changeImpacts.listOpen(userSessionId).map((impact) => ({
            id: impact.id, sourceKind: impact.sourceKind, sourceRef: impact.sourceRef,
            atRevision: impact.atRevision, note: impact.note,
            outstanding: impact.outstanding,
          }));
          return { revision: approved.revision, changeNote: approved.changeNote,
            ...(intent === null ? {} : { intent }),
            document: pageTail(requirements.statusOutlineFor(userSessionId), args.cursor, args.maxBytes),
            frontier: requirements.frontier(userSessionId),
            verificationGaps: requirements.verificationGaps(userSessionId),
            ...(openImpacts.length === 0 ? {} : { openChangeImpacts: openImpacts,
              openChangeImpactsNote: "Unreconciled change impacts — stale evidence or affected work awaiting your judgment; reconcile_change_impact records it. Completion holds while any is open." }) };
        }),
    ),

    sdk.tool(
      "reconcile_change_impact",
      "Record your judgment on a change impact — the Console-computed blast radius of an amendment, falsified assumption, or withdrawn claim (read_requirements lists open ones; an open impact holds completion). Suspect claims: reopen or re-verify via report_requirement (clears mechanically), or record stands/superseded here. Affected sessions: steer, interrupt, or archive (archival clears), or record unaffected/superseded here.",
      {
        impactId: z.string().min(1).describe("A change impact id (chg_…)."),
        items: z.array(z.object({
          kind: z.enum(["claim", "session"]),
          id: z.string().min(1).describe("Requirement id (claim) or agent session id (session)."),
          disposition: z.enum(["stands", "superseded", "unaffected", "steered", "interrupted"]),
          note: z.string().min(1).describe("Why — journaled."),
        })).min(1).max(40),
      },
      async (args: { impactId: string; items: { kind: "claim" | "session"; id: string; disposition: string; note: string }[] }) =>
        guarded(() => {
          const wire = changeImpacts.reconcile({
            userSessionId, impactId: args.impactId, actor: "main",
            items: args.items.map((item) => ({ ...item, note: clip(item.note, 280) })),
          });
          return { impactId: wire.id, status: wire.status, outstanding: wire.outstanding,
            note: wire.status === "reconciled"
              ? "Reconciled — every affected item is dispositioned or mechanically cleared."
              : "Recorded. Items still outstanding are listed; the impact stays open (and holds completion) until each is dispositioned or clears mechanically." };
        }),
    ),

    sdk.tool(
      "link_workstreams",
      "Declare a workstream dependency: the consumer session cannot safely complete until the producer delivers the named subject. Status is console-derived — pending while the producer works, satisfied when it reports, BROKEN if it is archived unreported (a broken link with an open consumer holds completion). Links are visibility and change-impact routing, never scheduling.",
      {
        consumerAgentSessionId: z.string().min(1).describe("The depending workstream."),
        producerAgentSessionId: z.string().min(1).describe("The producing workstream; already-reported is fine (born satisfied), abandoned is rejected."),
        subject: z.string().min(1).describe("The interface/artifact crossing the boundary, one line."),
        note: z.string().optional().describe("Optional context — journaled."),
      },
      async (args: { consumerAgentSessionId: string; producerAgentSessionId: string; subject: string; note?: string }) =>
        guarded(() => {
          const wire = workstreams.link({
            userSessionId,
            consumerAgentSessionId: args.consumerAgentSessionId,
            producerAgentSessionId: args.producerAgentSessionId,
            subject: clip(args.subject, 280),
            createdBy: "main",
            ...(args.note === undefined ? {} : { note: clip(args.note, 280) }),
          });
          return { linkId: wire.id, status: wire.status,
            consumer: { agentSessionId: wire.consumerAgentSessionId, title: wire.consumerTitle },
            producer: { agentSessionId: wire.producerAgentSessionId, title: wire.producerTitle },
            subject: wire.subject,
            note: "Recorded durably. Both sessions see the link on their deliveries; list_agent_sessions shows it with live status." };
        }),
    ),

    sdk.tool(
      "unlink_workstreams",
      "Release a workstream dependency link with a judgment note (superseded, re-pointed, no longer holds). The row stays as history; releasing a broken link is how it stops holding completion.",
      {
        linkId: z.string().min(1).describe("A wl_… id from list_agent_sessions."),
        note: z.string().min(1).describe("Why it no longer stands — journaled."),
      },
      async (args: { linkId: string; note: string }) =>
        guarded(() => {
          const wire = workstreams.release({ userSessionId, linkId: args.linkId, by: "main", note: clip(args.note, 280) });
          return { linkId: wire.id, status: wire.status, releaseNote: wire.releaseNote };
        }),
    ),

    sdk.tool(
      "report_requirement",
      "Record a requirement STATUS with evidence. Statuses are semantic claims, never scores: satisfied / violated / infeasible require evidence; open reopens a stale claim; infeasible routes its consequence to the operator or an amendment. Report LEAVES only — parents derive. The Console records who stood behind each claim: yours records as self-verification; independent tiers need a write-isolated reviewer seat reporting. Measurements go INSIDE evidence refs, never as ranking numbers.",
      {
        requirementId: z.string().min(1).describe("A requirement id from read_requirements, e.g. \"r3\""),
        status: z.enum(["satisfied", "violated", "infeasible", "open"]),
        evidence: z.array(EvidenceRefSchema).default([]).describe("What proves the claim. Required for satisfied/violated/infeasible."),
        note: z.string().optional().describe("One line of context."),
      },
      async (args: { requirementId: string; status: "satisfied" | "violated" | "infeasible" | "open";
        evidence: { kind: "file" | "journal" | "artifact" | "task" | "command" | "url"; ref: string; label?: string }[];
        note?: string }) =>
        guarded(() => {
          const wire = requirements.reportStatus({
            userSessionId, requirementId: args.requirementId, to: args.status,
            evidence: args.evidence, claimant: { kind: "main" },
            ...(args.note === undefined ? {} : { note: clip(args.note, 280) }),
          });
          return { requirementId: wire.id, status: wire.status, derivedRoot: requirements.rootStatus(userSessionId),
            note: "Recorded. Parents derive mechanically; the sign-off card renders the tree with this claim and its evidence." };
        }),
    ),

    sdk.tool(
      "decompose_requirement",
      "Refine a requirement by adding child requirements BELOW it — smaller checkable statements for how the obligation is discharged; no operator approval, journaled. Editing statements, retiring nodes, or new top-level obligations change what counts as success — those go through propose_requirements.",
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
      "Record an assumption the work proceeds on, naming the requirement ids that rest on it — a later falsification FLAGS their claims and wakes you. No approval needed. Not for operator-imposed boundaries (requirements) or resolved questions (decisions).",
      {
        text: z.string().min(1).describe("One declarative premise."),
        requirementIds: z.array(z.string().min(1)).max(12).optional()
          .describe("Requirements that rest on this premise."),
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
      "Resolve a recorded assumption: confirmed, falsified (dependent terminal claims are flagged and you wake; judge them yourself), or retired. confirmed/falsified need provenance: evidence refs or the settling answer's interactionId. An assumption that should now GOVERN success is an amendment.",
      {
        assumptionId: z.string().min(1).describe("An id from record_assumption, e.g. \"a2\"."),
        outcome: z.enum(["confirmed", "falsified", "retired"]),
        note: z.string().optional(),
        evidence: z.array(EvidenceRefSchema).default([]),
        interactionId: z.string().optional().describe("The operator answer that settled it."),
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
      "Record a relationship: depends_on (fromId needs toId first; acyclic; feeds the frontier), or conflicts_with (both cannot hold as written — resolved by amendment or operator decision). Links never change derived statuses.",
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
      "Revise YOUR working state — the durable memory your next generation reads. Sections you pass REPLACE wholly; omitted sections persist. A premise specific REQUIREMENTS rest on belongs in record_assumption. When you work around a coordination structure the patterns cannot express, tag it 'pattern-friction:'.",
      {
        trigger: z.enum(["commission", "discovery", "alarm", "direction_change", "operator"])
          .describe("What occasioned this update."),
        strategy: z.string().optional().describe("Current approach, one or two sentences."),
        strategyWhy: z.string().optional().describe("Why this strategy."),
        uncertainties: z.array(z.string()).optional().describe("Open CONSEQUENTIAL uncertainties. Max 8."),
        assumptions: z.array(z.string()).optional().describe("Load-bearing assumptions. Max 8."),
        risks: z.array(z.string()).optional().describe("Live risks. Max 8."),
        note: z.string().optional().describe("What occasioned this update, one line."),
        incorporating: z.array(z.string().min(1)).max(8).optional()
          .describe("Results or evidence this update incorporates, by id."),
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
      "Record the completion justification when you believe the run is done: each requirement mapped to its EVIDENCE (met or honestly not), known gaps, deliberate non-goals — the wrap-up-and-landing skill carries the ladder and sequence. Criteria are REQUIREMENT IDS verified against the current revision (freeform criterion strings only when no requirements govern). Not a gate: the operator completes the run.",
      {
        criteria: z.array(z.object({
          requirement: z.string().optional().describe("A requirement id (required when a graph governs)"),
          criterion: z.string().optional().describe("Freeform criterion text (no-requirements runs only)"),
          met: z.boolean(),
          evidence: z.array(EvidenceRefSchema).default([]).describe("What proves it"),
        })).min(1).describe("At most 12 survive. Each entry names either a requirement id or a criterion string."),
        knownGaps: z.array(z.string()).default([]).describe("What is not done or not verified. At most 8 survive."),
        nonGoals: z.array(z.string()).default([]).describe("Deliberately out of scope. At most 8 survive."),
        requirementsRevision: z.number().int().min(1).optional()
          .describe("The approved revision verified against. REQUIRED when a graph governs."),
        note: z.string().optional(),
      },
      async (args: { criteria: { requirement?: string; criterion?: string; met: boolean; evidence?: { kind: "file" | "journal" | "artifact" | "task" | "command" | "url"; ref: string; label?: string }[] }[];
        knownGaps: string[]; nonGoals: string[]; requirementsRevision?: number; note?: string }) =>
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
              ...(args.requirementsRevision === undefined ? {} : { requirementsRevision: args.requirementsRevision }) },
            args.note === undefined ? undefined : clip(args.note, 280));
          return { revision: row.revision, recorded: true };
        }),
    ),

    sdk.tool(
      "read_artifact",
      "Read an artifact by id — a worktree diff, screenshot, note, or captured payload. Artifacts are the EVIDENCE behind reports; read them before deciding on the work they describe. Images return viewable.",
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
      "Mint a run-scoped profile VARIANT from a trusted base. Narrow-only by construction: tools a subset of the base's, permissionMode same or lower, instructions ADDITIVE, MCP servers by catalog name only, skills from the catalog. Use it when the fixed profiles miscast a role. Journaled; no approval needed (narrow-only).",
      {
        id: z.string().regex(/^[a-z][a-z0-9-]*$/).describe("New profile id, e.g. 'render-implementer'"),
        baseProfileId: z.string().min(1).describe("A trusted base from list_agent_profiles"),
        title: z.string().optional(),
        purpose: z.string().optional(),
        instructionsAppend: z.string().optional().describe("Appended to the base instructions"),
        tools: z.array(z.string()).optional().describe("Subset of the base's tools; omit to keep them all"),
        permissionMode: z.enum(["default", "plan", "bypassPermissions"]).optional().describe("Same or lower than the base's"),
        model: z.string().optional(),
        skills: z.array(z.string()).optional().describe("From the catalog"),
        attachServers: z.array(z.string()).optional().describe("Attachable catalog MCP servers, by name"),
        maxTurns: z.number().int().min(1).max(100).optional(),
        why: z.string().optional().describe("Why this variant — journaled"),
      },
      async (args: { id: string; baseProfileId: string; title?: string; purpose?: string; instructionsAppend?: string;
        tools?: string[]; permissionMode?: "default" | "plan" | "bypassPermissions"; model?: string;
        skills?: string[]; attachServers?: string[]; maxTurns?: number; why?: string }) =>
        guarded(() => {
          const workspaceId = repo.getUserSession(userSessionId)?.workspaceId;
          const minted = registry.mint({ ...args, userSessionId, ...(workspaceId === undefined ? {} : { workspaceId }) });
          if (args.skills !== undefined && args.skills.length > 0) {
            const problems = catalog.validateAssignment(args.skills, effectiveNativeTools(minted, "seat"));
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
      "Add ONE agent to an open session mid-run — an emergent need the original roster did not anticipate. Open multi-seat roles only (hub specialists, plan_execute executors, peer_to_peer peers); fixed-roster patterns refuse. The entry agent is told immediately; assign the new seat work through it.",
      {
        agentSessionId: z.string().min(1),
        name: z.string().min(1).describe("Agent name, e.g. 'auditor'"),
        profileId: z.string().min(1).describe("A profile id from list_agent_profiles"),
        instructions: z.string().optional().describe("Brief appended to the profile instructions"),
        model: z.string().optional(),
        owns: z.array(z.string()).default([]).describe("Exclusive write scope; required for a writing profile. Same project-wide rule as creation."),
        sharedOwns: z.array(z.object({ scope: z.string().min(1), why: z.string().min(1) })).optional()
          .describe("Scopes co-owned with another workstream, each with a why."),
        skills: z.array(z.string()).optional().describe("Extra skills, from the catalog"),
        why: z.string().optional().describe("Why this seat now — journaled."),
      },
      async (args: { agentSessionId: string; name: string; profileId: string; instructions?: string; model?: string; owns: string[]; sharedOwns?: { scope: string; why: string }[]; skills?: string[]; why?: string }) =>
        guarded(() => {
          const session = owned(args.agentSessionId);
          if (args.skills !== undefined && args.skills.length > 0) {
            const skillProfile = host.profiles(repo.getUserSession(session.userSessionId)?.workspaceId)
              .find((profile) => profile.id === args.profileId);
            const problems = catalog.validateAssignment(args.skills,
              skillProfile === undefined ? [] : effectiveNativeTools(skillProfile, "seat"));
            if (problems.length > 0) throw new InvalidInputError(problems.join("; "));
          }
          const added = host.addAgent(args.agentSessionId, {
            name: args.name, profileId: args.profileId,
            ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
            ...(args.model === undefined ? {} : { model: args.model }),
            owns: args.owns,
            ...(args.sharedOwns === undefined ? {} : { sharedOwns: args.sharedOwns }),
            ...(args.skills === undefined ? {} : { skills: args.skills }),
            ...(args.why === undefined ? {} : { why: args.why }),
          });
          return { ...added, status: "seated",
            note: "The entry agent has been told. Route assignments through it; you can steer the new seat directly with send_to_coordinator's `to` (update-only)." };
        }),
    ),

    sdk.tool(
      "close_agent_session",
      "Terminate a whole session that is no longer productive. Lanes close, pending deliveries cancel, unlanded worktree branches ARCHIVE (nothing merges, nothing is destroyed), and the session stops blocking run completion. Returns the still-open ledger units so you can re-own them in a successor.",
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
      "Stop ONE agent's in-flight turn. The turn dies; the agent, its lane and its inbox survive. Delivered rows do NOT redeliver; QUEUED deliveries deliver next — post a correction right after and it arrives with them. Uncommitted work is preserved by the failure path.",
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

  // Registration self-check: `MAIN_TOOL_NAMES` (orchestrator/grants.ts) is
  // the single source of truth main's allow-list is derived from, so a tool
  // registered here without a grants entry — or granted without being
  // registered — throws at lane spawn instead of drifting silently.
  const registered = new Set(tools.map((tool) => (tool as { name?: string }).name ?? ""));
  const declared = new Set<string>(MAIN_TOOL_NAMES);
  const drift = [
    ...[...registered].filter((name) => !declared.has(name)).map((name) => `registered but not in MAIN_TOOL_NAMES: ${name}`),
    ...[...declared].filter((name) => !registered.has(name)).map((name) => `in MAIN_TOOL_NAMES but never registered: ${name}`),
  ];
  if (drift.length > 0) throw new Error(`console tool registration drift — ${drift.join("; ")}`);

  return sdk.createSdkMcpServer({ name: "console", version: "1.0.0", tools, alwaysLoad: true });
}
