/**
 * The console_agent MCP tool definitions for a seat. Pure definitions over a
 * narrow context: everything host-private the handlers touch (post, the
 * operator ask, lane turn state) arrives as a bound callback, so nothing here
 * reaches back into the host.
 */
import { z } from "zod";
import { PATTERN_IDS, type HandoffDraft, type InteractionUrgency, type Speaker } from "@agentique-console/shared";
import type { AgentProfile } from "../agent-profiles/registry.ts";
import type { Config } from "../config.ts";
import type { AgentSessionRow, MessageRow, ParticipantRow, Repo, UserSessionRow } from "../db/repo.ts";
import type { ArtifactStore } from "../events/artifact-store.ts";
import type { EventBus } from "../events/bus.ts";
import type { ConsoleSdk, SdkToolResult } from "../sdk/types.ts";
import type { ProcessManager } from "../runtime/process-manager.ts";
import type { BrowserManager } from "../runtime/browser-manager.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import type { TaskService } from "../tasks/service.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { EvidenceRefSchema, HandoffCoreSchema, HandoffDraftSchema } from "../handoffs/schema.ts";
import { consoleTaskListId } from "../tasks/service.ts";
import { PAGE_DEFAULT_BYTES, PAGE_MAX_BYTES, pageTail } from "../paging.ts";
import { speakerKindOf } from "./topology.ts";
import { MAIN_RECIPIENT } from "./peer-names.ts";
import { resolvedDomains, WithheldFinalError, type Category } from "./governance.ts";
import type { SeatToolName } from "./grants.ts";

/**
 * Provider ceiling for an inline base64 image (~5MB). A full-page screenshot at
 * a large viewport can exceed it, and an oversize image fails the whole tool
 * result rather than degrading — so `read_artifact` returns a text explanation
 * instead, which the seat can act on.
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

/** The slice of the host's deps the tool handlers read. */
export interface SeatToolsDeps {
  repo: Repo;
  bus: EventBus;
  artifacts: ArtifactStore;
  config?: Config;
  tasks?: TaskService;
  handoffs?: HandoffService;
  processes: ProcessManager | null;
  browsers: BrowserManager | null;
  worktrees: WorktreeManager | null;
}

export interface SeatToolsContext {
  sdk: ConsoleSdk;
  deps: SeatToolsDeps;
  session: AgentSessionRow;
  seat: ParticipantRow;
  profile: AgentProfile;
  user: UserSessionRow | undefined;
  workspaceRoot: string;
  /** From grants.ts — the same set the spawn allow-list is built from. */
  granted: ReadonlySet<SeatToolName>;
  /** `candidate` if the contract has an edge to it, else this seat's escalation target. */
  legalRecipient(candidate: string): string;
  // Host-private operations, bound as closures so nothing becomes public.
  post(input: { agentSessionId: string; speaker: Speaker; to: string; handoff: HandoffDraft; category?: Category; dedupeKey?: string; turnId?: string }): MessageRow;
  askOperator(args: AskOperatorArgs): Promise<SdkToolResult>;
  /** The seat's in-flight turn id, if a turn is open right now. */
  currentTurnId(): string | undefined;
  /** Mark the seat's in-flight turn as having sent a handoff. */
  markSawSend(): void;
  seatWorkState(seat: ParticipantRow): string;
  simpleHandoff(action: string, status: HandoffDraft["core"]["status"], summary: string, nextAction: string | null): HandoffDraft;
  dispatchWorkItems(input: { agentSessionId: string; items: { assignment: string; name?: string; owns?: string[] }[]; profileId?: string; instructions?: string; model?: string }): { joinId: string; seats: string[] };
  createChildSession(input: { pattern: string; title: string; patternConfig?: Record<string, unknown>; agents: { name: string; profileId: string; instructions?: string; model?: string; owns: string[] }[]; briefing: HandoffDraft }): { agentSessionId: string; participants: string[]; entrySeat: string };
  abandonChildSession(childAgentSessionId: string, reason: string): void;
}

// Messaging IS this server: `send_handoff` is the one transfer path (there is
// no native SendMessage wire), alongside handoff retrieval, the shared ledger,
// operator asks, contracts, and the console-owned runtime tools.
export function buildSeatTools(ctx: SeatToolsContext): unknown[] {
  const { sdk, deps, session, seat, profile, user, workspaceRoot } = ctx;
  const tools: unknown[] = [];
  // The disciplined transfer path. Its parameters ARE the handoff core, so
  // the provider enforces the shape and there is nothing to hand-serialize —
  // which removes the failure that destroyed db-live-1's verification report
  // (a 4KB body could not be escaped into a JSON string, 15 times running).
  // It is console-carried, so it also has no peer ref handshake to lose.
  tools.push(sdk.tool("send_handoff",
    "Send a typed handoff to another participant. This is the preferred way to transfer anything — assignments, progress, findings, failures, final results. Fill the fields; the console builds and journals the envelope. Your plain text output reaches no one.",
    {
      to: z.string().min(1).describe("Recipient's bare seat name, or \"main\" to reach the Orchestrator."),
      category: z.enum(["assignment", "update", "milestone", "failure", "final", "decision"]).default("update"),
      status: HandoffCoreSchema.shape.status,
      risk: HandoffCoreSchema.shape.risk.default("medium"),
      action: z.string().min(1).describe("The request or the work this handoff is about, in one line."),
      stateSummary: z.string().min(1).describe("What is true now — the substance. Write the findings themselves, not a description of having found them."),
      evidence: z.array(EvidenceRefSchema).default([]).describe("Pointers backing the state: files, artifacts, tasks, commands, urls."),
      resultSummary: z.string().nullable().default(null),
      artifacts: z.array(EvidenceRefSchema).default([]),
      uncertainty: z.array(z.string()).default([]).describe("What you could not verify. Say so plainly rather than omitting it."),
      nextAction: z.string().nullable().default(null).describe("The exact next step for the recipient, or null when nothing is owed."),
      taskId: z.string().nullable().default(null),
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
      // `post()` throws for a forbidden route (a genuine seat mistake → tool
      // error) and for a withheld final (a Console-imposed HOLD → a
      // structured NON-error, for the same reason ask_operator never returns
      // isError: error results feed the error-streak watchdog and retries
      // feed the identical-call watchdog, and punishing a seat for a hold the
      // Console imposed kills the turn that must stay alive for the release).
      let message: MessageRow;
      try {
        const turnId = ctx.currentTurnId();
        message = ctx.post({ agentSessionId: session.id, speaker: { kind: speakerKindOf(seat), name: seat.name },
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
  // Console-owned ledger. Keyed on a synthetic id derived from the agent
  // session, so it survives context rotation and is shared by every seat —
  // the native Task* tools are per-provider-session, which meant the
  // db-live-1 coordinator watched its own four tasks vanish at the first
  // rotation and never touched the ledger again for 28 minutes.
  if (deps.tasks && user) {
    const listId = consoleTaskListId(session.id);
    const attribution = { workspaceId: user.workspaceId, userSessionId: session.userSessionId, agentSessionId: session.id, participant: seat.name };
    tools.push(sdk.tool("task_list", "Read the AgentSession's task ledger. Authoritative and shared by every seat; it survives context rotation.", {},
      async () => ok({ tasks: deps.tasks?.listForUserSession(session.userSessionId).filter((task) => task.agentSessionId === session.id) ?? [] })));
    if (ctx.granted.has("task_create")) {
      tools.push(
        sdk.tool("task_create", "Add a unit of work to the ledger. Track every unit you delegate.", {
          taskId: z.string().min(1).describe("Short stable id you choose, e.g. \"1\" or \"interface\"."),
          subject: z.string().min(1), description: z.string().default(""),
          owner: z.string().min(1).describe("The seat that will DO this work — not you. The roster, the final caveats and the operator's run summary all read this."),
        }, async (args: { taskId: string; subject: string; description: string; owner: string }) => {
          const seats = new Set(deps.repo.listParticipants(session.id).map((row) => row.name));
          if (!seats.has(args.owner)) {
            return fail(`no seat named "${args.owner}" in this session; owners are one of: ${[...seats].join(", ")}`);
          }
          deps.tasks?.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: args.taskId, subject: args.subject, description: args.description, owner: args.owner, attribution });
          return ok({ taskId: args.taskId, created: true, owner: args.owner });
        }),
        sdk.tool("task_update", "Update a ledger entry. Keep status honest as work progresses — the Console reports open tasks to the operator alongside your final.", {
          taskId: z.string().min(1),
          status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(),
          owner: z.string().optional(), subject: z.string().optional(), description: z.string().optional(),
          addBlockedBy: z.array(z.string()).optional(),
        }, async (args: { taskId: string; status?: "pending" | "in_progress" | "completed" | "deleted"; owner?: string; subject?: string; description?: string; addBlockedBy?: string[] }) => {
          const { taskId, ...patch } = args;
          deps.tasks?.applyUpdate({ sdkSessionId: listId, sdkTaskId: taskId, patch });
          return ok({ taskId, updated: true });
        }),
      );
    }
  }
  // Artifacts live in SQLite, outside every seat's read scope, and
  // browser_screenshot hands back an opaque id. Without this a seat cannot
  // inspect its own evidence: in db-live-1 both renderer and `check` resorted
  // to scanning the filesystem for artifact files that were never on disk.
  tools.push(sdk.tool("read_artifact",
    "Read back an artifact you or a teammate produced (screenshot, diff, captured payload) by its artifact id. Images return as viewable content.",
    { artifactId: z.string().min(1), cursor: z.string().optional(), maxBytes: z.number().int().min(1).max(PAGE_MAX_BYTES).default(PAGE_DEFAULT_BYTES) },
    async (args: { artifactId: string; cursor?: string; maxBytes: number }) => {
      const artifact = deps.artifacts.get(args.artifactId);
      if (!artifact) return fail(`no artifact ${args.artifactId}`);
      if (artifact.mediaType.startsWith("image/")) {
        // MCP's ImageContent is {type,data,mimeType} — NOT the Messages API's
        // nested `source`. The old shape failed schema validation on every
        // call, so db-live-2 captured three valid screenshots that no agent
        // could open and `check` reimplemented visual verification in
        // gl.readPixels instead. The `;base64` suffix is the storage
        // convention (the artifact store branches on it for byte accounting);
        // strip it only here, at the boundary.
        const mimeType = artifact.mediaType.replace(/;base64$/, "");
        if (artifact.content.length > MAX_IMAGE_BASE64_CHARS) {
          return ok({ artifactId: artifact.id, mediaType: artifact.mediaType, bytes: artifact.bytes,
            error: `image is ${Math.round(artifact.bytes / 1024)}KiB, over the ${Math.round(MAX_IMAGE_BASE64_CHARS / 4 * 3 / 1024)}KiB provider limit for inline images. Capture a narrower region, or verify it another way.` });
        }
        return { content: [{ type: "image", data: artifact.content, mimeType }] };
      }
      return ok({ artifactId: artifact.id, mediaType: artifact.mediaType, bytes: artifact.bytes, content: pageTail(artifact.content, args.cursor, args.maxBytes) });
    }));
  /**
   * A place to put a long body that is NOT a JSON string parameter.
   *
   * db-live-2's `renderer` hit `InputValidationError: could not be parsed as
   * JSON` twice on ~4.5KB `send_handoff` payloads, concluded "the handoff
   * payload is getting truncated", and shipped a shortened report. Main hit
   * the same failure family on its first `create_agent_session` and needed
   * two retries. Any tool whose input embeds a long free-text body is exposed
   * to it, and the model's own recovery strategy is self-truncation.
   *
   * With this, a 12KB verification report is an artifact referenced by
   * `evidence`, and the handoff carries a short summary plus the pointer.
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
  // The supervisor "translation problem", fixed at the wire: a coordinator
  // that RETYPES a specialist's report pays a measured quality tax (LangChain
  // recovered ~50% of supervisor underperformance with exactly this tool).
  // The forward carries the original core+extension untouched, so a forwarded
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
        if (record.metadata.recipient !== seat.name) return fail(`handoff ${args.handoffId} was not addressed to you; forward only what you received`);
        try {
          const message = ctx.post({ agentSessionId: session.id,
            speaker: { kind: speakerKindOf(seat), name: seat.name },
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
        deps.handoffs?.reportDiscrepancy(args.handoffId, seat.name, args.claim, args.evidence); return ok({ recorded: true });
      }),
    );
  }
  if (profile.runtime.shell && deps.processes) {
    const scope = { workspaceRoot: seat.worktreePath ?? workspaceRoot, userSessionId: session.userSessionId, agentSessionId: session.id, participant: seat.name };
    const processOwner = `${session.id}:${seat.name}`;
    tools.push(
      sdk.tool("process_start", "Start a Console-owned long-running process. Pass an executable and argv separately; cwd must remain in the workspace.", { command: z.string(), args: z.array(z.string()).default([]), cwd: z.string().default(".") }, async (args: { command: string; args: string[]; cwd: string }) => ok(deps.processes?.start(scope, args.command, args.args, args.cwd))),
      sdk.tool("process_read", "Read new process output, optionally waiting once for a state change. Use waitMs instead of polling. Output is paged tail-first (default 8KiB, newest last); use cursors for more, afterSeq for incremental reads.", { processId: z.string(), afterSeq: z.number().int().default(0), waitMs: z.number().int().min(0).max(60_000).default(0), cursor: z.string().optional(), maxBytes: z.number().int().min(1).max(PAGE_MAX_BYTES).default(PAGE_DEFAULT_BYTES) }, async (args: { processId: string; afterSeq: number; waitMs: number; cursor?: string; maxBytes: number }) => {
        const result = await deps.processes?.read(processOwner, args.processId, args.afterSeq, args.waitMs);
        if (!result) return ok(result);
        const text = result.chunks.map((chunk) => `[${chunk.stream} #${chunk.seq}] ${chunk.text}`).join("");
        return ok({ headSeq: result.headSeq, exit: result.exit, output: pageTail(text, args.cursor, args.maxBytes) });
      }),
      sdk.tool("process_stop", "Stop a process owned by this participant.", { processId: z.string() }, async (args: { processId: string }) => { deps.processes?.stop(processOwner, args.processId); return ok({ stopped: true }); }),
    );
  }
  if (profile.runtime.browser && deps.browsers) {
    const key = `${session.id}:${seat.name}`;
    tools.push(
      sdk.tool("browser_open", "Open a URL in the participant's managed local Chrome page.", { url: z.string() }, async (args: { url: string }) => ok(await deps.browsers?.open(key, args.url))),
      sdk.tool("browser_snapshot", "Inspect current URL, title, and rendered body text.", {}, async () => ok(await deps.browsers?.snapshot(key))),
      sdk.tool("browser_click", "Click a locator (CSS or Playwright text locator syntax).", { selector: z.string() }, async (args: { selector: string }) => { await deps.browsers?.click(key, args.selector); return ok({ clicked: true }); }),
      sdk.tool("browser_fill", "Fill an input located by CSS or Playwright locator syntax.", { selector: z.string(), value: z.string() }, async (args: { selector: string; value: string }) => { await deps.browsers?.fill(key, args.selector, args.value); return ok({ filled: true }); }),
      sdk.tool("browser_console", "Read browser console and page errors.", {}, async () => ok(await deps.browsers?.consoleMessages(key))),
      sdk.tool("browser_press", "Press a key (e.g. \"ArrowLeft\", \"Enter\", \"Space\"). Use this to exercise keyboard-driven UI — games, shortcuts, form submission. Target the page by default, or a locator to focus first.", {
        keys: z.string().min(1), selector: z.string().optional(),
        repeat: z.number().int().min(1).max(100).default(1), delayMs: z.number().int().min(0).max(2_000).optional(),
      }, async (args: { keys: string; selector?: string; repeat: number; delayMs?: number }) =>
        ok(await deps.browsers?.press(key, args.keys, { ...(args.selector ? { selector: args.selector } : {}), repeat: args.repeat, ...(args.delayMs === undefined ? {} : { delayMs: args.delayMs }) }))),
      sdk.tool("browser_evaluate", "Evaluate JavaScript in the page and return the result as JSON. Use it to read state the rendered text does not expose — localStorage, canvas/game state, module exports. Bare expressions and statement bodies both work. A result carrying `threw` means the page raised (a finding); `undefined:true` means the expression produced nothing, which is different from producing null.", {
        expression: z.string().min(1),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
      }, async (args: { expression: string; timeoutMs: number }) => {
        const outcome = await deps.browsers?.evaluate(key, args.expression, args.timeoutMs);
        // Only a compile failure is the SEAT's error — that is its own
        // JavaScript failing to parse, and it is actionable. A page
        // exception or a null is data, and marking those `isError` would
        // feed the consecutive-error watchdog for legitimate probing.
        if (outcome?.compileError !== undefined) {
          return fail(JSON.stringify(outcome));
        }
        return ok(outcome);
      }),
    );
    if (profile.runtime.screenshots) {
      tools.push(sdk.tool("browser_screenshot", "Capture a full-page screenshot as a durable Console artifact.", {}, async () => ok(await deps.browsers?.screenshot(key, { userSessionId: session.userSessionId, agentSessionId: session.id }))));
    }
  }
  // Available to EVERY seat, not just the coordinator.
  //
  // `request_decision` was coordinator-only, so a specialist's question took
  // three model hops to reach a human — specialist → coordinator judges →
  // coordinator escalates — and every hop could drop it. In db-live-1 one
  // did: `renderer` diagnosed the defect that made the deliverable
  // non-functional and asked permission to fix it; the coordinator replied
  // "Leave game.js as-is… do not report it as a bug," and the operator never
  // learned the option existed. Two tools doing the same job is also how you
  // get a model calling neither, so this replaces it outright.
  {
    tools.push(sdk.tool("ask_operator",
      "Ask the Human Operator a question only they can answer. This reaches them DIRECTLY — do not route it through your coordinator. " +
      "Use urgency:'blocking' when continuing would waste the work, or when you would otherwise substitute your own judgement for theirs: a version, a scope cut, a deviation from the brief. " +
      "Use urgency:'deferred' when you can keep working meanwhile; the card renders now and their answer reaches you at your next delivery. " +
      "Every answer is recorded and reaches every seat in this session, so you never need to relay it.",
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
  // already; this is for the seat that is ABOUT to start something and can
  // check first. db-live-2's renderer spent ~16 minutes building a private
  // duplicate of a dev server `page` had already written and was serving.
  tools.push(sdk.tool("roster_status",
    "See what every seat in this session is doing right now — live state, what they own, and what they last reported. Check before starting anything substantial that a teammate may already have done.",
    {},
    async () => ok({
      seats: deps.repo.listParticipants(session.id).map((row) => ({
        name: row.name,
        profile: row.profileId,
        owns: row.ownership,
        state: ctx.seatWorkState(row),
      })),
    })));

  // The curl that actually works.
  //
  // Managed children run in the HOST network namespace (`bwrap --share-net`)
  // while a seat's Bash runs inside the SDK sandbox's own, so a seat cannot
  // reach a server it just started. db-live-2's renderer burned three failed
  // curls discovering this and concluded, correctly, "servers started via
  // process_start live in a different network namespace than my Bash shell".
  // Executed in the SERVER process, which shares the children's namespace.
  if (profile.runtime.shell) {
    tools.push(sdk.tool("http_probe",
      "Make an HTTP request from the Console's own process — the only way to reach a server you started with process_start, since your Bash shell is in a different network namespace. Use this instead of curl for localhost checks.",
      {
        url: z.string().min(1).describe("http(s) URL. Loopback, or a host your profile is allowed to reach."),
        method: z.enum(["GET", "HEAD", "POST"]).default("GET"),
        timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
        maxBytes: z.number().int().min(1).max(PAGE_MAX_BYTES).default(PAGE_DEFAULT_BYTES),
      },
      async (args: { url: string; method: "GET" | "HEAD" | "POST"; timeoutMs: number; maxBytes: number }) => {
        let parsed: URL;
        try { parsed = new URL(args.url); } catch { return ok({ error: `not a URL: ${args.url}` }); }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return ok({ error: "http_probe accepts only http(s) URLs" });
        }
        const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
        const allowed = resolvedDomains(profile, deps.config?.allowedDomains ?? []);
        if (!loopback && !allowed.some((domain) => domain === parsed.hostname || (domain.startsWith("*.") && parsed.hostname.endsWith(domain.slice(1))))) {
          return ok({ error: `${parsed.hostname} is outside this profile's allowed hosts (${allowed.join(", ") || "none"})` });
        }
        try {
          const response = await fetch(parsed, { method: args.method, signal: AbortSignal.timeout(args.timeoutMs) });
          const body = args.method === "HEAD" ? "" : (await response.text()).slice(0, args.maxBytes);
          return ok({ status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), body });
        } catch (error) {
          return ok({ error: error instanceof Error ? error.message : String(error) });
        }
      }));
  }

  // One level of nesting: a controller may spawn a CHILD AgentSession running
  // any pattern. The child's "main" resolves to THIS seat — its finals arrive
  // here as milestones — and child seats never receive these tools, so the
  // depth cap is the granting itself.
  if (ctx.granted.has("create_child_session")) {
    tools.push(sdk.tool("create_child_session",
      "Spawn a child AgentSession running its own orchestration pattern, briefed by you and reporting to you. Its final arrives to you as a milestone; your own final is withheld until every child has reported (or you abandon it). Use a child session when a sub-problem deserves its own topology — a pipeline inside your hub, a debate inside your plan.",
      {
        pattern: z.enum(PATTERN_IDS),
        title: z.string().min(1).describe("Short working title for the child session"),
        patternConfig: z.record(z.string(), z.unknown()).optional(),
        agents: z.array(z.object({
          name: z.string(), profileId: z.string(), instructions: z.string().optional(), model: z.string().optional(),
          owns: z.array(z.string()).default([]).describe("Must not collide with any seat's scopes anywhere in this session tree."),
        })).min(1).max(20),
        briefing: HandoffDraftSchema.describe("The child's assignment: objective, evidence, risk, uncertainty, next action."),
      },
      async (args: { pattern: string; title: string; patternConfig?: Record<string, unknown>; agents: { name: string; profileId: string; instructions?: string; model?: string; owns: string[] }[]; briefing: HandoffDraft }) => {
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
      "Fan the work out: mint one mapper seat per independent work item and assign each its item. The Console holds every mapper report until the join is met, then delivers them ALL to you in one turn for synthesis. One dispatch in flight at a time.",
      {
        items: z.array(z.object({
          assignment: z.string().min(1).describe("The complete, self-contained work item — the mapper sees nothing else."),
          name: z.string().optional().describe("Optional seat name; default map.<dispatch>.<n>."),
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
