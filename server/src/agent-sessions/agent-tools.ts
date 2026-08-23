/**
 * The console_agent MCP tool definitions for an agent. Pure definitions over
 * a narrow context: everything service-private the handlers touch (post, the
 * operator ask, lane turn state) arrives as a bound callback, so nothing here
 * reaches back into the service.
 */
import { z } from "zod";
import { PATTERN_IDS, type HandoffDraft, type InteractionUrgency, type Speaker } from "@agentique-console/shared";
import type { AgentProfile } from "../agent-profiles/registry.ts";
import type { Config } from "../config.ts";
import type { AgentSessionRow, MessageRow, AgentRow, Repo, UserSessionRow } from "../db/repo.ts";
import type { ArtifactStore } from "../events/artifact-store.ts";
import type { EventBus } from "../events/bus.ts";
import type { ConsoleSdk, SdkToolResult } from "../sdk/types.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import type { TaskService } from "../tasks/service.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { EvidenceRefSchema, HandoffCoreSchema, HandoffDraftSchema } from "../handoffs/schema.ts";
import { consoleTaskListId } from "../tasks/service.ts";
import { PAGE_DEFAULT_BYTES, PAGE_MAX_BYTES, pageTail } from "../paging.ts";
import { speakerKindOf } from "./topology.ts";
import { MAIN_RECIPIENT } from "./names.ts";
import { WithheldFinalError, type Category } from "./final-gate.ts";
import type { AgentToolName } from "./grants.ts";

/**
 * Provider ceiling for an inline base64 image (~5MB). A full-page screenshot at
 * a large viewport can exceed it, and an oversize image fails the whole tool
 * result rather than degrading — so `read_artifact` returns a text explanation
 * instead, which the agent can act on.
 */
const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024;

export interface AskOperatorArgs {
  question: string;
  header?: string;
  context?: string;
  options: { label: string; description?: string }[];
  recommendation?: string;
  urgency: InteractionUrgency;
  allowFreeText: boolean;
  /** Requirement ids (inside the delegation) this decision resolves or gates. */
  requirementIds?: string[];
}

/** The flat, provider-validated parameter surface of `send_handoff`. */
interface SendHandoffArgs {
  to: string;
  category: Category;
  status: HandoffDraft["core"]["status"];
  risk: HandoffDraft["core"]["risk"];
  action: string;
  stateSummary: string;
  evidence: HandoffDraft["core"]["state"]["evidence"];
  resultSummary: string | null;
  artifacts: HandoffDraft["core"]["result"]["artifacts"];
  uncertainty: string[];
  nextAction: string | null;
  taskId: string | null;
  requestExpandedContext: boolean;
  dedupeKey?: string;
}

import { fail, ok } from "../sdk/tool-result.ts";
import type { RequirementService } from "../orchestrator/requirements.ts";

/** The slice of the service's deps the tool handlers read. */
export interface AgentToolsDeps {
  repo: Repo;
  bus: EventBus;
  artifacts: ArtifactStore;
  config?: Config;
  tasks?: TaskService;
  handoffs?: HandoffService;
  /** The governing requirements (legacy-spec fallback inside; absent in some unit harnesses). */
  requirements?: RequirementService;
  worktrees: WorktreeManager | null;
}

export interface AgentToolsContext {
  sdk: ConsoleSdk;
  deps: AgentToolsDeps;
  session: AgentSessionRow;
  agent: AgentRow;
  profile: AgentProfile;
  user: UserSessionRow | undefined;
  workspaceRoot: string;
  /** From grants.ts — the same set the spawn allow-list is built from. */
  granted: ReadonlySet<AgentToolName>;
  /** `candidate` if the contract has an edge to it, else this agent's escalation target. */
  legalRecipient(candidate: string): string;
  // Service-private operations, bound as closures so nothing becomes public.
  post(input: { agentSessionId: string; speaker: Speaker; to: string; handoff: HandoffDraft; category?: Category; dedupeKey?: string; turnId?: string }): MessageRow;
  /**
   * The scheduler's intercept, route-checked: a blocked assignment becomes a
   * durable scheduled row instead of a delivery. null = deliver normally.
   */
  interceptAssignment(input: { to: string; category: Category; handoff: HandoffDraft }): {
    assignmentId: string;
    awaiting: { taskId: string; subject: string; status: string }[];
  } | null;
  cancelAssignment(assignmentId: string): unknown;
  askOperator(args: AskOperatorArgs): Promise<SdkToolResult>;
  /** The agent's in-flight turn id, if a turn is open right now. */
  currentTurnId(): string | undefined;
  /** Mark the agent's in-flight turn as having sent a handoff. */
  markSawSend(): void;
  agentWorkState(agent: AgentRow): string;
  dispatchWorkItems(input: { agentSessionId: string; items: { assignment: string; name?: string; owns?: string[] }[]; profileId?: string; instructions?: string; model?: string }): { joinId: string; agents: string[] };
  createChildSession(input: { pattern: string; title: string; patternConfig?: Record<string, unknown>; agents: { name: string; profileId: string; instructions?: string; model?: string; owns: string[] }[]; briefing: HandoffDraft; requirements?: string[] }): { agentSessionId: string; agents: string[]; entryAgent: string };
  abandonChildSession(childAgentSessionId: string, reason: string): void;
}

// Messaging IS this server: `send_handoff` is the one transfer path (there is
// no native SendMessage wire), alongside handoff retrieval, the shared ledger,
// operator asks, contracts, and the console-owned runtime tools.
export function buildAgentTools(ctx: AgentToolsContext): unknown[] {
  const { sdk, deps, session, agent, profile, user, workspaceRoot } = ctx;
  const tools: unknown[] = [];
  // The disciplined transfer path: its parameters ARE the handoff core, so
  // the provider enforces the shape and there is nothing to hand-serialize.
  // Console-carried, so there is no peer ref handshake to lose.
  tools.push(sdk.tool("send_handoff",
    "Send a typed handoff to another participant. This is the preferred way to transfer anything — assignments, progress, findings, failures, final results. Fill the fields; the console builds and journals the envelope. Your plain text output reaches no one. " +
    "An assignment whose taskId still has incomplete dependencies is SCHEDULED, not delivered: you get {scheduled:true} back and the Console dispatches it the moment the dependencies complete — never re-send it.",
    {
      to: z.string().min(1).describe("Recipient's bare agent name, or \"main\" to reach the Orchestrator."),
      // No default. A defaulted category once turned an ACCEPT verdict into an
      // `update`: main never woke and the run ended in silence. State it.
      category: z.enum(["assignment", "update", "milestone", "failure", "final", "decision"])
        .describe("What this transfer IS, and it decides who is woken. \"final\" is the report that ends this session's obligation to the operator — send it when your work is concluded. \"failure\" concludes it unsuccessfully. \"milestone\", \"decision\" and \"failure\" wake the Orchestrator; \"update\" and \"assignment\" do not."),
      status: HandoffCoreSchema.shape.status,
      risk: HandoffCoreSchema.shape.risk.default("medium"),
      action: z.string().min(1).describe("The request or the work this handoff is about, in one line."),
      stateSummary: z.string().min(1).describe("What is true now — the substance. Write the findings themselves, not a description of having found them."),
      evidence: z.array(EvidenceRefSchema).default([]).describe("Pointers backing the state: files, artifacts, tasks, commands, urls."),
      // Undescribed, these three went unfilled on every handoff of a whole live
      // run — leaving the recipient with no pointer to the deliverable and the
      // task ledger with nothing to key on.
      resultSummary: z.string().nullable().default(null)
        .describe("The DELIVERABLE itself — what the recipient is meant to consume, and where it is. `stateSummary` is the situation; this is the output. Null only when the work produced nothing to hand over."),
      artifacts: z.array(EvidenceRefSchema).default([])
        .describe("What you PRODUCED — files written, artifacts stored, branches. Distinct from `evidence`, which is what backs your claims about them."),
      uncertainty: z.array(z.string()).default([]).describe("What you could not verify. Say so plainly rather than omitting it."),
      nextAction: z.string().nullable().default(null).describe("The exact next step for the recipient, or null when nothing is owed."),
      taskId: z.string().nullable().default(null)
        .describe("The ledger taskId this handoff is about, from task_list. The Console moves that entry on it: an assignment starts it, a terminal report closes it. Omit only when the work is not a ledger unit."),
      requestExpandedContext: z.boolean().default(false),
      dedupeKey: z.string().optional(),
    },
    async (args: SendHandoffArgs) => {
      const draft: HandoffDraft = { core: {
        schemaVersion: 1, taskId: args.taskId, status: args.status, risk: args.risk, action: args.action,
        state: { summary: args.stateSummary, evidence: args.evidence },
        result: { summary: args.resultSummary, artifacts: args.artifacts },
        uncertainty: args.uncertainty, nextAction: args.nextAction, requestExpandedContext: args.requestExpandedContext,
      }, extension: { kind: profile.handoffExtension ?? "generic", data: {} } };
      // `post()` throws for a forbidden route (a genuine agent mistake → tool
      // error) and for a withheld final (a Console-imposed HOLD → a structured
      // NON-error: error results feed the error-streak watchdog, and the turn
      // must stay alive for the release). A scheduled assignment is the same
      // kind of structured non-error: the Console accepted the transfer.
      let message: MessageRow;
      try {
        const scheduled = ctx.interceptAssignment({ to: args.to, category: args.category, handoff: draft });
        if (scheduled) {
          ctx.markSawSend();
          return ok({ delivered: false, scheduled: true, assignmentId: scheduled.assignmentId, awaiting: scheduled.awaiting,
            note: "This assignment is recorded and will dispatch the moment its dependencies complete. Do not re-send it; re-sending the same taskId only re-targets the recipient." });
        }
        const turnId = ctx.currentTurnId();
        message = ctx.post({ agentSessionId: session.id, speaker: { kind: speakerKindOf(agent), name: agent.name },
          to: args.to, handoff: draft, category: args.category, ...(args.dedupeKey ? { dedupeKey: args.dedupeKey } : {}),
          ...(turnId ? { turnId } : {}) });
      } catch (error) {
        if (error instanceof WithheldFinalError) {
          return ok({ delivered: false, withheld: true, blockers: error.blockers, guidance: error.message });
        }
        return fail(error);
      }
      ctx.markSawSend();
      return ok({ delivered: true, messageSeq: message.seq, to: args.to, category: args.category });
    }));
  // Console-owned ledger, keyed on a synthetic id derived from the agent
  // session, so it survives context rotation and is shared by every agent —
  // the native Task* tools are per-provider-session.
  if (deps.tasks && user) {
    const listId = consoleTaskListId(session.id);
    const attribution = { workspaceId: user.workspaceId, userSessionId: session.userSessionId, agentSessionId: session.id, agent: agent.name };
    tools.push(sdk.tool("task_list", "Read the AgentSession's task ledger. Authoritative and shared by every agent; it survives context rotation.", {},
      async () => ok({ tasks: deps.tasks?.listForUserSession(session.userSessionId).filter((task) => task.agentSessionId === session.id) ?? [] })));
    if (ctx.granted.has("task_create")) {
      tools.push(
        sdk.tool("task_create", "Add a unit of work to the ledger. Track every unit you delegate. Declare its dependencies as blockedBy HERE, at creation — the Console dispatches assignments on that DAG.", {
          taskId: z.string().min(1).describe("Short stable id you choose, e.g. \"1\" or \"interface\"."),
          subject: z.string().min(1), description: z.string().default(""),
          owner: z.string().min(1).describe("The agent that will DO this work — not you. The roster, the final caveats and the operator's run summary all read this."),
          blockedBy: z.array(z.string()).default([]).describe("taskIds this task depends on. Forward references are fine — the edge attaches when the blocker is created."),
          requirementId: z.string().min(1).optional().describe("The requirement id (inside your delegated sub-scope) this unit discharges — links the ledger to the graph."),
        }, async (args: { taskId: string; subject: string; description: string; owner: string; blockedBy: string[]; requirementId?: string }) => {
          const names = new Set(deps.repo.listAgents(session.id).map((row) => row.name));
          if (!names.has(args.owner)) {
            return fail(`no agent named "${args.owner}" in this session; owners are one of: ${[...names].join(", ")}`);
          }
          if (args.requirementId !== undefined) {
            try {
              deps.requirements?.assertWithinDelegation(session.userSessionId, session.id, args.requirementId);
            } catch (error) {
              return fail(error);
            }
          }
          deps.tasks?.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: args.taskId, subject: args.subject, description: args.description, owner: args.owner, blockedBy: args.blockedBy,
            ...(args.requirementId === undefined ? {} : { requirementId: args.requirementId }), attribution });
          return ok({ taskId: args.taskId, created: true, owner: args.owner });
        }),
        sdk.tool("task_update", "Update a ledger entry. Keep status honest as work progresses — the Console reports open tasks to the operator alongside your final, and completing a task dispatches any assignments scheduled behind it. removeBlockedBy drops a dependency that no longer holds (e.g. a deleted blocker), releasing whatever it was blocking.", {
          taskId: z.string().min(1),
          status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(),
          owner: z.string().optional(), subject: z.string().optional(), description: z.string().optional(),
          addBlockedBy: z.array(z.string()).optional(),
          removeBlockedBy: z.array(z.string()).optional(),
          requirementId: z.string().min(1).optional().describe("Link (or re-link) this unit to the requirement it discharges — inside your delegated sub-scope."),
        }, async (args: { taskId: string; status?: "pending" | "in_progress" | "completed" | "deleted"; owner?: string; subject?: string; description?: string; addBlockedBy?: string[]; removeBlockedBy?: string[]; requirementId?: string }) => {
          if (args.requirementId !== undefined) {
            try {
              deps.requirements?.assertWithinDelegation(session.userSessionId, session.id, args.requirementId);
            } catch (error) {
              return fail(error);
            }
          }
          const { taskId, ...patch } = args;
          deps.tasks?.applyUpdate({ sdkSessionId: listId, sdkTaskId: taskId, patch });
          return ok({ taskId, updated: true });
        }),
      );
    }
    if (ctx.granted.has("assignment_cancel")) {
      tools.push(sdk.tool("assignment_cancel",
        "Withdraw a scheduled assignment by the assignmentId a scheduled send returned. The task and its dependencies stay; only the pending dispatch is withdrawn.",
        { assignmentId: z.string().min(1) },
        async (args: { assignmentId: string }) => {
          try {
            return ok({ canceled: true, assignment: ctx.cancelAssignment(args.assignmentId) });
          } catch (error) {
            return fail(error);
          }
        }));
    }
  }
  // Artifacts live in SQLite, outside every agent's read scope, and
  // browser_screenshot hands back an opaque id. Without this an agent cannot
  // inspect its own evidence.
  tools.push(sdk.tool("read_artifact",
    "Read back an artifact you or a teammate produced (screenshot, diff, captured payload) by its artifact id. Images return as viewable content.",
    { artifactId: z.string().min(1), cursor: z.string().optional(), maxBytes: z.number().int().min(1).max(PAGE_MAX_BYTES).default(PAGE_DEFAULT_BYTES) },
    async (args: { artifactId: string; cursor?: string; maxBytes: number }) => {
      const artifact = deps.artifacts.get(args.artifactId);
      if (!artifact) return fail(`no artifact ${args.artifactId}`);
      if (artifact.mediaType.startsWith("image/")) {
        // MCP's ImageContent is {type,data,mimeType} — NOT the Messages API's
        // nested `source`. The `;base64` suffix is the storage convention (the
        // artifact store branches on it for byte accounting); strip it only
        // here, at the boundary.
        const mimeType = artifact.mediaType.replace(/;base64$/, "");
        if (artifact.content.length > MAX_IMAGE_BASE64_CHARS) {
          return ok({ artifactId: artifact.id, mediaType: artifact.mediaType, bytes: artifact.bytes,
            error: `image is ${Math.round(artifact.bytes / 1024)}KiB, over the ${Math.round(MAX_IMAGE_BASE64_CHARS / 4 * 3 / 1024)}KiB provider limit for inline images. Capture a narrower region, or verify it another way.` });
        }
        return { content: [{ type: "image", data: artifact.content, mimeType }] };
      }
      return ok({ artifactId: artifact.id, mediaType: artifact.mediaType, bytes: artifact.bytes, content: pageTail(artifact.content, args.cursor, args.maxBytes) });
    }));
  // The injected requirement digest is byte-capped; the full governing
  // outline (or the legacy spec text) stays a tool call away for every seat.
  if (deps.requirements) {
    const requirements = deps.requirements;
    tools.push(sdk.tool("read_requirements",
      "Read the run's governing requirements: the outline with console-derived statuses, plus your session's delegated requirement ids. Your work is checked against it. Pass scopeId (inside your delegated sub-scope) to read one subtree in full. The root read includes the operator's approved intent prose. (A legacy run returns its markdown spec instead.)",
    { scopeId: z.string().min(1).optional().describe("Read only this requirement's subtree — must sit inside your delegated sub-scope."),
      cursor: z.string().optional(), maxBytes: z.number().int().min(1).max(PAGE_MAX_BYTES).default(PAGE_DEFAULT_BYTES) },
    async (args: { scopeId?: string; cursor?: string; maxBytes: number }) => {
      const approved = requirements.latestApproved(ctx.session.userSessionId);
      if (approved === undefined) {
        const digest = requirements.digest(ctx.session.userSessionId);
        if (digest === "") return ok({ requirements: null, note: "no approved requirements for this run" });
        return ok({ legacy: true, document: pageTail(digest, args.cursor, args.maxBytes),
          delegatedToThisSession: requirements.delegationSet(session.id) });
      }
      if (args.scopeId !== undefined) {
        try {
          requirements.assertWithinDelegation(session.userSessionId, session.id, args.scopeId);
        } catch (error) {
          return fail(error);
        }
        return ok({ revision: approved.revision, scopeId: args.scopeId,
          document: pageTail(requirements.statusOutlineFor(ctx.session.userSessionId, args.scopeId), args.cursor, args.maxBytes) });
      }
      const intent = requirements.intentDocument(ctx.session.userSessionId);
      return ok({
        revision: approved.revision,
        ...(intent === null ? {} : { intent }),
        document: pageTail(requirements.statusOutlineFor(ctx.session.userSessionId), args.cursor, args.maxBytes),
        delegatedToThisSession: requirements.delegationSet(session.id),
      });
    }));
    if (ctx.granted.has("report_requirement")) {
      tools.push(sdk.tool("report_requirement",
        "Record a requirement STATUS with evidence, within this session's delegated sub-scope. Statuses are semantic claims, never scores: satisfied / violated / infeasible require evidence; open reopens a stale claim. Report LEAVES only — parents derive mechanically. verifiedBy is 'independent' only when the evidence comes from a different seat than the one that did the work (a reviewer confirming an implementer's claim).",
        {
          requirementId: z.string().min(1).describe("A requirement id inside your delegated sub-scope (the delivery lists it; read_requirements shows the whole graph)."),
          status: z.enum(["satisfied", "violated", "infeasible", "open"]),
          evidence: z.array(EvidenceRefSchema).default([]).describe("What proves the claim. Required for satisfied/violated/infeasible."),
          verifiedBy: z.enum(["self", "independent"]).default("self"),
          note: z.string().optional(),
        },
        async (args: { requirementId: string; status: "satisfied" | "violated" | "infeasible" | "open";
          evidence: { kind: "file" | "journal" | "artifact" | "task" | "command" | "url"; ref: string; label?: string }[];
          verifiedBy: "self" | "independent"; note?: string }) => {
          try {
            requirements.assertWithinDelegation(session.userSessionId, session.id, args.requirementId);
            const wire = requirements.reportStatus({
              userSessionId: session.userSessionId, requirementId: args.requirementId, to: args.status,
              evidence: args.evidence, verifiedBy: args.verifiedBy, actor: agent.name, agentSessionId: session.id,
              ...(args.note === undefined ? {} : { note: args.note }),
            });
            return ok({ requirementId: wire.id, status: wire.status,
              note: "Recorded. Parents derive mechanically; main and the operator see this claim with its evidence." });
          } catch (error) {
            return fail(error);
          }
        }));
      tools.push(sdk.tool("decompose_requirement",
        "Refine a requirement INSIDE your delegated sub-scope by adding child requirements below it — smaller checkable statements for how the obligation is discharged. Journaled and attributed to this session; no approval needed. Changing what counts as success (editing statements, retiring nodes, new top-level obligations) is main's and the operator's — route it up.",
        {
          parentId: z.string().min(1).describe("A requirement id inside your delegated sub-scope."),
          children: z.array(z.object({
            statement: z.string().min(1),
            composition: z.enum(["all", "any"]).default("all"),
          })).min(1).max(8),
        },
        async (args: { parentId: string; children: { statement: string; composition: "all" | "any" }[] }) => {
          try {
            requirements.assertWithinDelegation(session.userSessionId, session.id, args.parentId);
            const added = requirements.decompose({
              userSessionId: session.userSessionId, parentId: args.parentId, children: args.children,
              actor: agent.name, agentSessionId: session.id,
            });
            return ok({ parentId: args.parentId, added,
              note: "Children added as refinement nodes (open) inside your sub-scope. Report them with evidence as they are discharged." });
          } catch (error) {
            return fail(error);
          }
        }));
    }
  }
  /**
   * A place to put a long body that is NOT a JSON string parameter: a long
   * free-text tool argument is exposed to provider-side JSON parse failures,
   * and the model's recovery strategy is self-truncation. With this, a long
   * report is an artifact referenced by `evidence`, and the handoff carries a
   * short summary plus the pointer.
   */
  tools.push(sdk.tool("write_note",
    "Store a long body — a verification report, a full log, an analysis — as a durable artifact and get its id back. Reference that id from send_handoff's evidence instead of pasting the body into a field. Never shorten a finding to make it fit a parameter.",
    { title: z.string().min(1).max(200), body: z.string().min(1) },
    async (args: { title: string; body: string }) => {
      const stored = deps.artifacts.store(
        `# ${args.title}\n\n${args.body}`,
        "text/markdown",
        { userSessionId: session.userSessionId, agentSessionId: session.id },
      );
      return ok({ ...stored, title: args.title,
        use: `Reference it as evidence: {"kind":"artifact","ref":"${stored.artifactId}"}` });
    }));
  // A coordinator that RETYPES a specialist's report pays a quality tax. The
  // forward carries the original core+extension untouched, so a forwarded
  // final counts as the session's own report; commentary travels separately.
  if (ctx.granted.has("forward_message") && deps.handoffs) {
    const handoffsService = deps.handoffs;
    tools.push(sdk.tool("forward_message",
      "Forward a handoff you received to main VERBATIM by its id. Use this when a specialist's report should reach the operator in the specialist's own words — do not retype or summarize it. Your own commentary, if any, goes in a separate send_handoff.",
      {
        handoffId: z.string().min(1).describe("The id of a handoff addressed to you."),
        category: z.enum(["milestone", "final", "failure"]).default("milestone"),
      },
      async (args: { handoffId: string; category: "milestone" | "final" | "failure" }) => {
        let record: ReturnType<HandoffService["get"]>;
        try { record = handoffsService.get(args.handoffId); }
        catch (error) { return fail(error); }
        if (record.metadata.agentSessionId !== session.id) return fail(`handoff ${args.handoffId} is not from this session`);
        if (record.metadata.recipient !== agent.name) return fail(`handoff ${args.handoffId} was not addressed to you; forward only what you received`);
        try {
          const message = ctx.post({ agentSessionId: session.id,
            speaker: { kind: speakerKindOf(agent), name: agent.name },
            to: MAIN_RECIPIENT, handoff: { core: record.core, extension: record.extension },
            category: args.category, dedupeKey: `fwd:${record.metadata.id}` });
          return ok({ forwarded: true, messageSeq: message.seq, originalId: record.metadata.id, originalSender: record.metadata.sender });
        } catch (error) {
          if (error instanceof WithheldFinalError) {
            return ok({ delivered: false, withheld: true, blockers: error.blockers, guidance: error.message });
          }
          return fail(error);
        }
      }));
  }
  if (deps.handoffs) {
    tools.push(
      sdk.tool("read_handoff", "Retrieve a lossless handoff section with cursor pagination. Use only when the compact envelope is insufficient.", {
        handoffId: z.string(), section: z.enum(["core", "extension"]).default("core"), cursor: z.string().optional(), maxBytes: z.number().int().min(1).max(PAGE_MAX_BYTES).default(PAGE_DEFAULT_BYTES),
      }, async (args: { handoffId: string; section: "core" | "extension"; cursor?: string; maxBytes: number }) => ok(deps.handoffs?.read(args.handoffId, args.section, args.cursor, args.maxBytes))),
      sdk.tool("report_handoff_discrepancy", "Report a handoff claim contradicted by the repository, task ledger, journal, or artifact. The original evidence stays authoritative.", {
        handoffId: z.string(), claim: z.string().min(1), evidence: z.string().min(1),
      }, async (args: { handoffId: string; claim: string; evidence: string }) => {
        deps.handoffs?.reportDiscrepancy(args.handoffId, agent.name, args.claim, args.evidence); return ok({ recorded: true });
      }),
    );
  }
  // Available to EVERY agent, not just the coordinator: a specialist's
  // question reaches the human directly, with no model hop able to drop it.
  {
    tools.push(sdk.tool("ask_operator",
      "Ask the Human Operator a question only they can answer. This reaches them DIRECTLY — do not route it through your coordinator. " +
      "Use urgency:'blocking' when continuing would waste the work, or when you would otherwise substitute your own judgement for theirs: a version, a scope cut, a deviation from the brief. " +
      "Use urgency:'deferred' when you can keep working meanwhile; the card renders now and their answer reaches you at your next delivery. " +
      "Every answer is recorded and reaches every agent in this session, so you never need to relay it.",
      {
        question: z.string().min(1).describe("One concrete question. State the decision, not the background."),
        header: z.string().max(24).optional().describe("Two or three words for the card's eyebrow."),
        context: z.string().max(2_000).optional().describe("Why you are asking and what you already tried. Not an option."),
        options: z.array(z.object({
          label: z.string().min(1).max(60),
          description: z.string().max(300).optional(),
        })).min(2).max(4).describe("Real, mutually exclusive choices."),
        recommendation: z.string().max(400).optional().describe("Which option you recommend and why. Always give one."),
        urgency: z.enum(["blocking", "deferred"]).default("blocking"),
        allowFreeText: z.boolean().default(true).describe("Let the operator answer outside your options."),
        requirementIds: z.array(z.string().min(1)).max(12).optional()
          .describe("Requirement ids inside your delegated sub-scope that this decision resolves or gates. The answer is recorded pinned to them."),
      },
      async (args: AskOperatorArgs) => {
        try {
          return await ctx.askOperator(args);
        } catch (error) {
          return fail(error);
        }
      }));
  }
  // Who is doing what, on demand. The roster carries this on every delivery
  // already; this is for the agent that is ABOUT to start something and can
  // check first.
  tools.push(sdk.tool("roster_status",
    "See what every agent in this session is doing right now — live state, what they own, and what they last reported. Check before starting anything substantial that a teammate may already have done.",
    {},
    async () => ok({
      agents: deps.repo.listAgents(session.id).map((row) => ({
        name: row.name,
        profile: row.profileId,
        owns: row.ownership,
        state: ctx.agentWorkState(row),
      })),
    })));


  // Nesting: a controller may spawn a CHILD AgentSession running any pattern.
  // The child's "main" resolves to THIS agent — its finals arrive here as
  // milestones. Depth is capped by `config.policy.maxSessionDepth`: sessions
  // at the cap never receive these tools, so the cap is the granting itself.
  if (ctx.granted.has("create_child_session")) {
    tools.push(sdk.tool("create_child_session",
      "Spawn a child AgentSession running its own orchestration pattern, briefed by you and reporting to you. Its final arrives to you as a milestone; your own final is withheld until every child has reported (or you abandon it). Use a child session when a sub-problem deserves its own topology — a pipeline inside your hub, a debate inside your plan.",
      {
        pattern: z.enum(PATTERN_IDS),
        title: z.string().min(1).describe("Short working title for the child session"),
        patternConfig: z.record(z.string(), z.unknown()).optional(),
        agents: z.array(z.object({
          name: z.string(), profileId: z.string(), instructions: z.string().optional(), model: z.string().optional(),
          owns: z.array(z.string()).default([]).describe("Must not collide with any agent's scopes anywhere in this session tree."),
        })).min(1).max(20),
        briefing: HandoffDraftSchema.describe("The child's assignment: objective, evidence, risk, uncertainty, next action."),
        requirements: z.array(z.string().min(1)).max(12).optional()
          .describe("Requirement ids the child answers for — MUST be a subset of your own delegated requirements. The child's entry agent gets the same scoped requirement tools you hold."),
      },
      async (args: { pattern: string; title: string; patternConfig?: Record<string, unknown>; agents: { name: string; profileId: string; instructions?: string; model?: string; owns: string[] }[]; briefing: HandoffDraft; requirements?: string[] }) => {
        try {
          return ok({ ...ctx.createChildSession(args), status: "launched",
            note: "The child works autonomously; its material reports arrive to you as handoffs. Do not poll it." });
        } catch (error) {
          return fail(error);
        }
      }));
    tools.push(sdk.tool("abandon_child_session",
      "Archive a child session that no longer matters or cannot conclude. Its journal stays readable; a console failure handoff closes your obligation to wait for it.",
      { childAgentSessionId: z.string().min(1), reason: z.string().min(1) },
      async (args: { childAgentSessionId: string; reason: string }) => {
        try {
          ctx.abandonChildSession(args.childAgentSessionId, args.reason);
          return ok({ archived: true, childAgentSessionId: args.childAgentSessionId });
        } catch (error) {
          return fail(error);
        }
      }));
  }
  if (ctx.granted.has("dispatch_work_items")) {
    tools.push(sdk.tool("dispatch_work_items",
      "Fan the work out: mint one mapper agent per independent work item and assign each its item. The Console holds every mapper report until the join is met, then delivers them ALL to you in one turn for synthesis. One dispatch in flight at a time.",
      {
        items: z.array(z.object({
          assignment: z.string().min(1).describe("The complete, self-contained work item — the mapper sees nothing else."),
          name: z.string().optional().describe("Optional agent name; default map.<dispatch>.<n>."),
          owns: z.array(z.string()).optional().describe("Ownership scopes if the item writes files."),
        })).min(1).max(8),
        profileId: z.string().optional().describe("Mapper profile; default explorer."),
        instructions: z.string().optional(),
        model: z.string().optional(),
      },
      async (args: { items: { assignment: string; name?: string; owns?: string[] }[]; profileId?: string; instructions?: string; model?: string }) => {
        try {
          return ok(ctx.dispatchWorkItems({ agentSessionId: session.id, items: args.items,
            ...(args.profileId ? { profileId: args.profileId } : {}),
            ...(args.instructions ? { instructions: args.instructions } : {}),
            ...(args.model ? { model: args.model } : {}) }));
        } catch (error) {
          return fail(error);
        }
      }));
  }
  return tools;
}
