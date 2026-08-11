import type { AgentSessionStatus, ConsoleEvent, GetAgentSessionResponse, HandoffDraft, HandoffTrigger, Interaction, InteractionQuestion, InteractionUrgency, PatternId, Speaker } from "@agentique-console/shared";
import fs from "node:fs";
import path from "node:path";
import { InvalidInputError, ConflictError, NotFoundError } from "../errors.ts";
import type { AgentProfile, AgentProfileRegistry } from "../agent-profiles/registry.ts";
import type { Config } from "../config.ts";
import {
  Repo,
  type AgentSessionRow,
  type MailboxDeliveryRow,
  type MessageRow,
  type AgentRow,
} from "../db/repo.ts";
import { toWireAgentSession, toWireMessage } from "../api/wire.ts";
import type { ArtifactStore } from "../events/artifact-store.ts";
import type { EventBus } from "../events/bus.ts";
import { RuntimeBroadcaster } from "../events/runtime.ts";
import { newId, nowIso } from "../ids.ts";
import { rotationTokenLimit } from "../model-catalog.ts";
import { mapSdkMessage } from "../sdk/mapping.ts";
import type { SqliteSessionStore } from "../sdk/session-store.ts";
import type { ConsoleSdk, QueryHandle, SdkOptions, SdkToolResult, SdkUserMessageLike } from "../sdk/types.ts";
import { sdkEnv } from "../sdk/env.ts";
import type { ProcessManager } from "../runtime/process-manager.ts";
import type { BrowserManager } from "../runtime/browser-manager.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import { decisionOf, renderDecision, type DecisionLedger } from "../orchestrator/decisions.ts";
import { dedupeKeyFor, type InteractionService } from "../orchestrator/interactions.ts";
import type { AssignmentScheduler } from "../tasks/scheduler.ts";
import type { TaskService } from "../tasks/service.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { HANDOFF_DRAFT_JSON_SCHEMA, HandoffDraftSchema } from "../handoffs/schema.ts";
import type { ReapResult } from "../completion/summary.ts";
import { CHILD_SENDER_PREFIX, CONSOLE_SENDER, MAIN_RECIPIENT, COORDINATOR_AGENT } from "./names.ts";
import { CHECKPOINT_DENIED_TOOLS } from "../lane-runtime/checkpoint.ts";
import { rotationDue, type RotationReason } from "../lane-runtime/rotation.ts";
import { advanceUsageWatermark } from "../lane-runtime/usage.ts";
import { isTransportFailure } from "../sdk/failure-classifier.ts";
import {
  finalReportBlockers,
  finalReportCaveats,
  isFinalToMain,
  WithheldFinalError,
  type Category,
} from "./final-gate.ts";
import { PromptComposer, questionTextOf, sandboxNetwork, seatUserMessage, summarizeAnswer } from "./composer.ts";
import { syncLedgerFromHandoff } from "./ledger-sync.ts";
import { buildAgentTools, type AskOperatorArgs } from "./agent-tools.ts";
import { ok } from "../sdk/tool-result.ts";
import { hubContract, roleOfAgent, speakerKindOf, RESERVED_NAMES, AGENT_NAME_RE } from "./topology.ts";
import { SessionRouting } from "./routing.ts";
import { WorktreeBinding } from "./worktree-binding.ts";
import type { TransferInput } from "./seams.ts";
import { grantedTools, runtimeToolNames, type AgentToolName } from "./grants.ts";
import { dispatchWorkItems, onPatternPost, sweep as patternSweep, type DispatchWorkItemsInput, type PatternContext } from "./patterns/engine.ts";
import { buildContract } from "./patterns/catalog.ts";
import { AsyncQueue } from "../async-queue.ts";

export { WithheldFinalError } from "./final-gate.ts";
const MATERIAL_CATEGORIES = new Set(["milestone", "failure", "final", "decision"]);

/**
 * Built-in tools a profile may grant. Anything here that a profile does NOT
 * list is explicitly denied, which is what makes `profile.tools` a real
 * boundary rather than an auto-approval hint. Harness conveniences a governed
 * agent should never reach (subagent spawning, scheduling, its own review
 * tooling) are denied unconditionally alongside these.
 */
const GOVERNED_BUILTIN_TOOLS = [
  "Bash", "Edit", "Write", "NotebookEdit", "Read", "Glob", "Grep",
  "WebFetch", "WebSearch",
] as const;


/** JSON with recursively sorted object keys — a stable identity for tool inputs. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/**
 * An agent's persistent peer session. One streaming-input query per live
 * agent; the process registers the agent's peer name and binds its inbox
 * socket, so an agent is natively addressable exactly while its lane is live.
 * Parked lanes keep only the resume handle — the journal owns anything
 * undelivered.
 */
interface AgentLane {
  state: "unspawned" | "waking" | "live" | "rotating" | "parked";
  input: AsyncQueue<SdkUserMessageLike> | null;
  query: QueryHandle | null;
  abort: AbortController | null;
  pump: Promise<void> | null;
  /** Resolves when the current spawn is accepting input. */
  ready: Promise<void> | null;
  /** The in-flight turn; null between turns. */
  activeTurn: {
    turnId: string;
    startedAt: number;
    deliveries: MailboxDeliveryRow[];
    sawSend: boolean;
    toolStarts: Map<string, number>;
    /**
     * The agent's most recent narration; harvested into the synthetic failure
     * handoff when a turn dies.
     */
    lastNarration: string;
    watchdog: { lastKey: string; identical: number; errorStreak: number; tripped: string | null };
    /**
     * Set while this turn is parked inside `ask_operator`. A blocking ask
     * holds `activeTurn`, so without this the agent looks busy forever. Its
     * own controller, so the wait can be cut without killing the lane.
     */
    awaitingOperator: { interactionId: string; since: number; abort: AbortController } | null;
  } | null;
  /** Console pushes awaiting attribution to the next minted turn. */
  pendingDeliveries: MailboxDeliveryRow[];
  /** deliveryId → failed-turn redelivery attempts, capped so retries end. */
  redeliveryAttempts: Map<string, number>;
  /**
   * Peak context-window occupancy observed this provider session, from
   * per-assistant-message usage. This is the rotation signal — NOT the result
   * message's `inputTokens`, which sums every API round-trip in the turn and
   * so overstates occupancy by 5-25x on a tool-heavy turn.
   */
  contextTokens: number;
  /** Last cumulative cost/api-duration seen, for per-turn deltas. */
  lastCumulative: { costUsd: number; apiDurationMs: number };
  /** Set while rotating/recycling; senders await it before ensureLive. */
  rotationGate: Promise<void> | null;
  releaseRotation: (() => void) | null;
  idleTimer: NodeJS.Timeout | null;
  /** Cumulative settled turns since the last assignment delivery. */
  assignmentTurns: number;
  /** The turn-budget notice fired for the current assignment (latch). */
  turnBudgetNotified: boolean;
  lastActiveAt: number;
  lastStatus: "working" | "idle" | null;
}

export interface CreateAgentSessionInput {
  userSessionId: string;
  title: string;
  /**
   * Orchestration pattern; omitted = hub_and_spoke. Agent sessions have no
   * mode/phase of their own: agents always execute; operator-level plan mode
   * lives on the USER session.
   */
  pattern?: PatternId;
  /** Pattern-specific config, validated by the pattern's builder. */
  patternConfig?: Record<string, unknown>;
  /**
   * Set when a controller agent spawns this as a CHILD session. The child's
   * "main" traffic then crosses to `controllerAgent` in the parent instead of
   * waking the runner. One level only — children never get the spawn grant.
   */
  parent?: { agentSessionId: string; controllerAgent: string };
  agents: { name: string; profileId?: string; instructions?: string; model?: string; owns?: string[] }[];
  briefing?: HandoffDraft;
}

export interface AgentSessionServiceDeps {
  repo: Repo;
  bus: EventBus;
  artifacts: ArtifactStore;
  /** Required — every knob's default lives in `loadConfig`, nowhere else. */
  config: Config;
  profiles: AgentProfileRegistry;
  sdk: () => Promise<ConsoleSdk>;
  sessionStore: SqliteSessionStore;
  getWorkspaceRoot: (workspaceId: string) => string;
  wake: (userSessionId: string, agentSessionId: string, category: Category, text: string) => void;
  /** OS capabilities. `null` = absent, stated at the construction site. */
  processes: ProcessManager | null;
  browsers: BrowserManager | null;
  interactions: InteractionService;
  /**
   * What the operator has decided. Read into every agent's prompt and into
   * checkpoint reconstruction, so a decision made once is known by every agent
   * and every later generation. Required: an optional dep would let a missing
   * wire typecheck.
   */
  decisions: DecisionLedger;
  tasks: TaskService;
  handoffs: HandoffService;
  /** Lazy — the scheduler posts through this host, so it is composed after it. */
  scheduler: () => AssignmentScheduler;
  worktrees: WorktreeManager | null;
}

/** Console-managed, independently resumable participant sessions and durable mailbox. */
export class AgentSessionService {
  readonly #deps: AgentSessionServiceDeps;
  readonly #composer: PromptComposer;
  readonly #routing: SessionRouting;
  readonly #worktreeBinding: WorktreeBinding;
  /** agentSessionId → agent name → its persistent lane. */
  readonly #seats = new Map<string, Map<string, AgentLane>>();
  /** Waiters for a resident-capacity slot, resolved oldest-first on park/close. */
  readonly #capacityWaiters: (() => void)[] = [];
  /** Timer releasing `ask_operator` waits the operator has not returned to. */
  #askSweep: ReturnType<typeof setInterval> | null = null;
  /** Notified when a session's derived status changes; completion re-evaluates. */
  #onStatusChanged: ((userSessionId: string) => void) | undefined;
  #sessionStatus = new Map<string, AgentSessionStatus | null>();
  /** Sessions whose operator obligation is closed — reported, or discharged. */
  readonly #operatorDebtSettled = new Set<string>();

  constructor(deps: AgentSessionServiceDeps) {
    this.#deps = deps;
    this.#routing = new SessionRouting({ repo: deps.repo });
    this.#worktreeBinding = new WorktreeBinding({
      repo: deps.repo, bus: deps.bus, artifacts: deps.artifacts, config: deps.config,
      worktrees: deps.worktrees, getWorkspaceRoot: deps.getWorkspaceRoot,
      escalationTarget: (session, agentName) => this.#routing.escalationTarget(session, agentName),
      transfer: (input) => this.post(input),
      simpleHandoff: (action, status, summary, nextAction) => this.#simpleHandoff(action, status, summary, nextAction),
    });
    this.#composer = new PromptComposer({
      repo: deps.repo, bus: deps.bus, config: deps.config, handoffs: deps.handoffs,
      decisions: deps.decisions, tasks: deps.tasks, interactions: deps.interactions,
      worktrees: deps.worktrees,
      laneState: (agentSessionId, agent) => {
        const lane = this.#seats.get(agentSessionId)?.get(agent);
        return lane ? { activeTurn: lane.activeTurn !== null, live: lane.state === "live" } : null;
      },
    });
  }

  createSession(input: CreateAgentSessionInput): { agentSessionId: string; agents: string[]; entryAgent: string; coordinatorName?: string } {
    const { repo, bus } = this.#deps;
    const user = repo.getUserSession(input.userSessionId);
    if (!user) throw new NotFoundError(`no user session ${input.userSessionId}`);
    // The pattern builder owns roster bounds, role assignment, prompts and
    // wiring; the host only executes what comes out.
    const build = buildContract(input.pattern ?? "hub_and_spoke", {
      agents: input.agents, config: input.patternConfig,
      resolveProfile: (id) => this.#profile(id, user.workspaceId),
    });
    let parentRow: AgentSessionRow | null = null;
    if (input.parent) {
      parentRow = repo.getAgentSession(input.parent.agentSessionId) ?? null;
      if (!parentRow || parentRow.lifecycle !== "open") throw new InvalidInputError(`parent session ${input.parent.agentSessionId} is not open`);
      if (parentRow.parentAgentSessionId !== null) throw new InvalidInputError("a child session cannot spawn children of its own — one level of nesting only");
      if (parentRow.userSessionId !== input.userSessionId) throw new InvalidInputError("a child session belongs to its parent's run");
      const openChildren = repo.listChildSessions(parentRow.id).filter((child) => child.lifecycle === "open");
      if (openChildren.length >= this.#deps.config.policy.maxChildSessionsPerParent) {
        throw new InvalidInputError(`parent already has ${openChildren.length} open child session(s); finish or abandon one first (cap ${this.#deps.config.policy.maxChildSessionsPerParent})`);
      }
    }
    const names = new Set<string>();
    for (const agent of input.agents) {
      if (!AGENT_NAME_RE.test(agent.name) || RESERVED_NAMES.has(agent.name.toLowerCase()) || agent.name.toLowerCase().startsWith(CHILD_SENDER_PREFIX)) throw new InvalidInputError(`invalid or reserved agent name \"${agent.name}\"`);
      if (names.has(agent.name)) throw new InvalidInputError(`duplicate agent name \"${agent.name}\"`);
      names.add(agent.name);
    }
    // Ownership is mandatory for an agent that WRITES, and optional for one
    // that does not. Deliberately NOT symmetric: a read-only agent may still
    // declare a scope, because `owns` doubles as the assignment/review
    // boundary for agents that never write.
    for (const agent of input.agents) {
      const profile = this.#profile(agent.profileId ?? "explorer", user.workspaceId);
      const writes = profile.tools.includes("Edit") || profile.tools.includes("Write");
      if (writes && (agent.owns ?? []).filter((scope) => scope.trim() !== "").length === 0) {
        throw new InvalidInputError(`agent "${agent.name}" (${profile.id}) writes files, so it must declare what it owns`);
      }
    }
    const ownedScopes = new Map<string, string>();
    if (parentRow) {
      // Cross-tree disjointness: parent-tree agents and this child's agents
      // all merge worktrees into ONE workspace, so their write scopes must not
      // collide any more than sibling agents' may.
      const treeSessions = [parentRow, ...repo.listChildSessions(parentRow.id).filter((child) => child.lifecycle === "open")];
      for (const treeSession of treeSessions) {
        for (const seat of repo.listAgents(treeSession.id)) {
          if ((seat.profileSnapshot as AgentProfile | undefined)?.exemptFromOwnership === true) continue;
          for (const scope of seat.ownership) {
            const normalized = scope.trim(); if (!normalized) continue;
            ownedScopes.set(normalized, `${seat.name} (in ${treeSession.id})`);
          }
        }
      }
    }
    for (const agent of input.agents) {
      if (this.#profile(agent.profileId ?? "explorer", user.workspaceId).exemptFromOwnership) continue;
      for (const scope of agent.owns ?? []) {
        const normalized = scope.trim(); if (!normalized) continue;
        const owner = ownedScopes.get(normalized);
        if (owner) throw new InvalidInputError(`ownership scope \"${normalized}\" is assigned to both ${owner} and ${agent.name}`);
        ownedScopes.set(normalized, agent.name);
      }
    }
    // Worktree isolation needs a repository; ensured at session creation, not
    // lazily at agent spawn.
    this.#worktreeBinding.ensureWorkspaceRepo(user.workspaceId, input.userSessionId);
    const title = input.title.trim();
    if (!title) throw new InvalidInputError("a session title is required");
    const parent = repo.getUserSession(input.userSessionId);
    if (!parent) throw new InvalidInputError("unknown user session");
    // The run's baseline for "what was built": HEAD at the first delegation.
    // The Run Summary diffs the working tree against this.
    if (parent.runBaseCommit === null && this.#deps.worktrees && this.#deps.getWorkspaceRoot) {
      try {
        const root = this.#deps.getWorkspaceRoot(user.workspaceId);
        repo.patchUserSession(input.userSessionId, { runBaseCommit: this.#deps.worktrees.headCommit(root) });
      } catch { /* not a repo — the summary falls back to handoff claims */ }
    }
    const now = nowIso();
    const contract = build.contract;
    const row: AgentSessionRow = {
      id: newId("as"), userSessionId: input.userSessionId, title,
      lifecycle: "open", createdAt: now, updatedAt: now,
      pattern: contract.pattern, topology: contract as unknown as Record<string, unknown>,
      parentAgentSessionId: parentRow?.id ?? null,
      parentControllerAgent: parentRow ? input.parent!.controllerAgent : null,
      depth: parentRow ? 1 : 0,
    };
    repo.insertAgentSession(row);
    if (parentRow) {
      bus.append({ type: "agent_session.child.spawned", userSessionId: row.userSessionId, agentSessionId: parentRow.id,
        payload: { agentSessionId: parentRow.id, childAgentSessionId: row.id, pattern: row.pattern,
          byAgent: input.parent!.controllerAgent, title } });
    }
    for (const plan of build.agents) {
      const profile = this.#snapshotProfile(this.#profile(plan.profileId, parent.workspaceId));
      repo.insertAgent(this.#agentRow(row.id, plan.name, plan.role, profile, plan.instructions ?? "", plan.model, plan.owns, plan.ord, now));
    }
    const specialists = input.agents.map((agent) => agent.name);
    bus.append({ type: "agent_session.created", userSessionId: row.userSessionId, agentSessionId: row.id,
      payload: { session: toWireAgentSession(row, specialists, false), agents: specialists } });
    bus.append({ type: "agent_session.delegation.sent", userSessionId: row.userSessionId, agentSessionId: row.id,
      payload: { userSessionId: row.userSessionId, agentSessionId: row.id, kind: "created", preview: title } });
    const entry = this.#routing.contractOf(row).contract.entry;
    const entrySeats = this.#routing.agentsOfRole(row.id, entry.role);
    if (input.briefing) {
      for (const seat of entry.broadcast ? entrySeats : entrySeats.slice(0, 1)) {
        this.post({ agentSessionId: row.id, speaker: { kind: "orchestrator", name: MAIN_RECIPIENT }, to: seat.name, handoff: input.briefing, category: "assignment" });
      }
    }
    return { agentSessionId: row.id, agents: specialists, entryAgent: entrySeats[0]?.name ?? COORDINATOR_AGENT,
      ...(build.coordinatorName !== undefined ? { coordinatorName: build.coordinatorName } : {}) };
  }

  /** The agent main steers: the contract entry role's first agent. */
  entryAgent(agentSessionId: string): string {
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (!session) throw new NotFoundError(`no agent session ${agentSessionId}`);
    const entry = this.#routing.contractOf(session).contract.entry;
    return this.#routing.agentsOfRole(agentSessionId, entry.role)[0]?.name ?? COORDINATOR_AGENT;
  }

  /**
   * The ONE transfer path: journal, then deliver by pushing into the
   * recipient's lane input. Every hop — briefings, agent reports via the
   * `send_handoff` tool, failure notices, redelivery — comes through here,
   * which is what makes the governance gates below inescapable.
   */
  post(input: TransferInput): MessageRow {
    const { repo } = this.#deps;
    const session = repo.getAgentSession(input.agentSessionId);
    if (!session) throw new NotFoundError(`no agent session ${input.agentSessionId}`);
    if (session.lifecycle !== "open") throw new ConflictError(`agent session ${input.agentSessionId} is archived`);
    const category = input.category ?? "update";
    const edge = this.#routing.assertRoute(session, input.speaker.name, input.to, category);
    const finalSeat = this.#routing.completionAgent(session, "finalFrom");
    if (input.dedupeKey) {
      const prior = repo.findDeliveryByDedupe(session.id, input.speaker.name, input.to, input.dedupeKey);
      const priorMessage = prior ? repo.getMessageById(prior.messageId) : undefined;
      if (priorMessage) return priorMessage;
    }
    // Withheld BEFORE journalling, so a blocked final leaves no half-record.
    const blockers = finalReportBlockers(this.#deps, session, finalSeat, input.speaker.name, input.to, category);
    if (blockers.length > 0) {
      this.#deps.bus.append({ type: "handoff.final.blocked", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, sender: input.speaker.name, interactionIds: blockers.map((row) => row.id) } });
      const now = Date.now();
      const structured = blockers.map((row) => ({
        id: row.id,
        question: questionTextOf(row),
        asker: row.agent ?? "main",
        ageMinutes: Math.max(0, Math.round((now - Date.parse(row.createdAt)) / 60_000)),
      }));
      const listed = structured
        .map((b) => `[${b.id}] "${b.question}" (asked ${b.ageMinutes}m ago by ${b.asker})`)
        .join("; ");
      throw new WithheldFinalError(structured,
        `final report withheld: ${blockers.length} question(s) this session put to the operator ${blockers.length === 1 ? "is" : "are"} still unanswered — ${listed}. ` +
        `Those cards are on the operator's screen now; you cannot answer them and neither can main. ` +
        `This is a hold, not a failure — do not re-send the same final. ` +
        `Either continue other work, or send category:"milestone" with what you have. ` +
        `When the operator answers, the Console delivers their answer to you and you may report final then.`,
      );
    }
    // A parent's final waits for its children: their finals are the boundary
    // milestones the report must reflect, and abandon_child_session is the
    // deliberate escape hatch for one that no longer matters. A hold, never an
    // error — the release notice fires when the last child reports.
    if (isFinalToMain(finalSeat, input.speaker.name, input.to, category)) {
      const unsettled = repo.listChildSessions(session.id).filter((child) => child.lifecycle === "open" && this.#statusOf(child) !== "reported");
      if (unsettled.length > 0) {
        this.#deps.bus.append({ type: "handoff.final.blocked", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { agentSessionId: session.id, sender: input.speaker.name, interactionIds: [] } });
        throw new WithheldFinalError([],
          `final report withheld: ${unsettled.length} child session(s) of this session have not reported — ${unsettled.map((child) => `"${child.title}" (${child.id})`).join("; ")}. ` +
          `Their finals arrive to you as milestones; wait for them, or abandon_child_session the ones that no longer matter. ` +
          `This is a hold, not a failure — do not re-send the same final.`);
      }
    }
    const caveats = finalReportCaveats(this.#deps, session, finalSeat, input.speaker.name, input.to, category, () => {
      const lanes = this.#seats.get(session.id);
      return [...(lanes?.entries() ?? [])].filter(([name, lane]) => name !== input.speaker.name && lane.activeTurn !== null).map(([name]) => name);
    });
    if (caveats.length > 0) {
      input = { ...input, handoff: { ...input.handoff, core: { ...input.handoff.core,
        uncertainty: [...input.handoff.core.uncertainty, `Console: reported final with work outstanding — ${caveats.join("; ")}.`] } } };
      this.#deps.bus.append({ type: "handoff.final.caveats", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, sender: input.speaker.name, caveats } });
    }
    // The ledger follows the journal, not a coordinator's memory.
    syncLedgerFromHandoff(this.#deps, session, input.to, input.handoff, category);
    const { message, delivery, text } = this.#journal(session, input.speaker, input.to, input.handoff, category, {
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}), ...(input.turnId ? { turnId: input.turnId } : {}),
    });
    if (input.to === MAIN_RECIPIENT) {
      if (session.parentAgentSessionId !== null) {
        // A child session's "main" is its parent's controller. The literal
        // stays "main" in the child's journal and every governance predicate;
        // only the SINK differs: re-post the handoff verbatim into the parent
        // (its own record, mailbox row, and lane wake), then ack child-side.
        // The dedupe key makes a crash between re-post and ack replay-safe.
        // The parent's release check runs AFTER the ack — before it, this very
        // delivery still counts the child as unsettled.
        if (MATERIAL_CATEGORIES.has(category)) this.#crossBoundary(session, message, input.handoff, category);
        this.#patchDelivery(session, delivery, "acknowledged");
        if (category === "final" || category === "failure") {
          const parent = session.parentAgentSessionId === null ? undefined : this.#deps.repo.getAgentSession(session.parentAgentSessionId);
          if (parent && parent.lifecycle === "open") this.#maybeReleaseParentFinal(parent);
        }
      } else {
      this.#patchDelivery(session, delivery, "acknowledged");
      if (MATERIAL_CATEGORIES.has(category)) {
        // Answered operator questions ride along with the next material wake.
        // Not marked flushed here: `flushed_at` means the ASKING AGENT has
        // been told, and main is not the asker.
        const answered = this.#deps.interactions.listAnsweredUnflushed(session.id);
        const decisions = answered.map((row) => summarizeAnswer(row)).filter((line) => line !== "");
        const wakeText = decisions.length === 0 ? text
          : `${text}\n\nOperator decisions answered since your last update:\n${decisions.map((line, index) => `${index + 1}. ${line}`).join("\n")}`;
        const openAsks = this.#deps.interactions.listUnresolvedForAgentSession(session.id)
          .filter((row) => row.agent !== null);
        const withAsks = openAsks.length === 0 ? wakeText
          : `${wakeText}\n\nStill waiting on the operator (you cannot answer these; only they can):\n${openAsks.map((row) => `- ${row.agent}: ${questionTextOf(row)}`).join("\n")}`;
        this.#deps.bus.append({ type: "agent_session.result.returned", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { userSessionId: session.userSessionId, agentSessionId: session.id, digestPreview: text.slice(0, 140) } });
        this.#deps.wake?.(session.userSessionId, session.id, category, withAsks);
      }
      }
    } else {
      // A router edge delivers now; a console-advanced edge stays journaled
      // and queued for the pattern progression to carry (joins, stages).
      if (edge.advance === "immediate") {
        void this.#deliverConsole(session.id, input.to).catch((error) => this.#recordHostFailure(session.id, error));
      }
    }
    // Counters and termination bounds see every hop, AFTER it is journaled and
    // routed — a trip defers its own action, so this cannot fail the transfer.
    try {
      onPatternPost(this.#patternCtx(), session, { sender: input.speaker.name, recipient: input.to, category,
        status: input.handoff.core.status,
        synthetic: (input.handoff.extension?.data as { consoleSynthesized?: boolean } | undefined)?.consoleSynthesized === true,
        countsRound: edge.countsRound === true, advance: edge.advance });
    } catch (error) { this.#recordHostFailure(session.id, error); }
    return message;
  }

  /**
   * `operatorDecisions` for a coordination-extension handoff, and nothing for
   * any other kind — the field only exists on `CoordinationHandoffData`.
   */
  #coordinationDefaults(session: AgentSessionRow, speaker: Speaker, senderSeat: AgentRow | undefined): { extensionDefaults?: Record<string, unknown> } {
    const kind = speaker.name === MAIN_RECIPIENT
      ? "coordination"
      : (senderSeat?.profileSnapshot as AgentProfile | undefined)?.handoffExtension;
    if (kind !== "coordination") return {};
    const lines = this.#deps.decisions.lines(session.userSessionId, { max: 12 });
    if (lines.length === 0) return {};
    return { extensionDefaults: { operatorDecisions: lines } };
  }

  /** Journal core: persist the handoff and mint its mailbox delivery. */
  #journal(session: AgentSessionRow, speaker: Speaker, to: string, handoff: HandoffDraft, category: Category, opts: {
    dedupeKey?: string; turnId?: string;
  }): { message: MessageRow; delivery: MailboxDeliveryRow; text: string; handoffId: string } {
    const { repo, bus } = this.#deps;
    if (!this.#deps.handoffs) throw new Error("handoff service unavailable");
    const senderSeat = speaker.name === MAIN_RECIPIENT ? undefined : repo.getAgent(session.id, speaker.name);
    const prepared = this.#deps.handoffs.prepare({
      draft: handoff, userSessionId: session.userSessionId, agentSessionId: session.id,
      sender: speaker.name, recipient: to,
      profileId: speaker.name === MAIN_RECIPIENT ? "main" : senderSeat?.profileId ?? null,
      extensionKind: speaker.name === MAIN_RECIPIENT ? "coordination" : (senderSeat?.profileSnapshot as AgentProfile | undefined)?.handoffExtension,
      generation: speaker.name === MAIN_RECIPIENT ? (repo.getUserSession(session.userSessionId)?.sdkGeneration ?? 0) : senderSeat?.generation ?? 0,
      turnId: opts.turnId, trigger: category as HandoffTrigger,
      parentHandoffId: category === "assignment" ? null : (senderSeat?.latestHandoffId ?? (speaker.name === MAIN_RECIPIENT ? repo.getUserSession(session.userSessionId)?.latestHandoffId : null)),
      // A coordination handoff carries the operator's decisions with it, so a
      // recipient reading only the envelope still knows what was decided.
      ...(this.#coordinationDefaults(session, speaker, senderSeat)),
      ...(senderSeat?.worktreePath ? { resolveRoot: senderSeat.worktreePath } : {}),
    });
    const text = prepared.text;
    const { message, delivery } = repo.appendHandoffMailbox({
      sessionKind: "agent", sessionId: session.id, userSessionId: session.userSessionId,
      agentSessionId: session.id, speaker, to, recipient: to,
      kind: "message" as const,
      text, category, handoff: prepared.row, summary: prepared.summary,
      ...(opts.turnId ? { turnId: opts.turnId } : {}), ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}),
    });
    // Latest-handoff pointers, chosen HERE where the recipient is known — the
    // store offers the two targets and never branches on a domain sentinel.
    for (const agent of new Set([to, speaker.name])) {
      if (agent === MAIN_RECIPIENT) repo.setMainLatestHandoff(session.userSessionId, prepared.row.id);
      else repo.setAgentLatestHandoff(session.id, agent, prepared.row.id);
    }
    this.#deps.handoffs.committed(prepared.record);
    if (senderSeat && senderSeat.worktreePath && (prepared.record.core.status === "completed" || prepared.record.core.status === "failed")) {
      this.#worktreeBinding.landOnReport(session, senderSeat, prepared.record.core.status);
    }
    bus.append({ type: "agent_session.message.appended", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, message: toWireMessage(message) } });
    bus.append({ type: "agent_session.delivery.updated", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, deliveryId: delivery.id, messageSeq: message.seq, sender: speaker.name, recipient: to, category, status: "queued" } });
    return { message, delivery, text, handoffId: prepared.row.id };
  }

  readSession(input: { agentSessionId: string; afterSeq?: number; limit?: number }) {
    const session = this.#deps.repo.getAgentSession(input.agentSessionId);
    if (!session) throw new NotFoundError(`no agent session ${input.agentSessionId}`);
    let rows = this.#deps.repo.listMessages("agent", session.id, input.afterSeq ?? 0);
    if (input.limit !== undefined) rows = rows.slice(-input.limit);
    return { status: this.#statusOf(session),
      agents: this.#specialists(session.id).map((p) => ({ name: p.name, profileId: p.profileId, model: p.model })),
      messages: rows.map(toWireMessage) };
  }

  listForUserSession(userSessionId: string) {
    return this.#deps.repo.listAgentSessions(userSessionId).map((row) => ({
      id: row.id, title: row.title, status: this.#statusOf(row),
      agents: this.#specialists(row.id).map((p) => p.name),
      unseenCount: this.#deps.repo.listQueuedDeliveries(row.id).filter((d) => d.recipient === MAIN_RECIPIENT).length,
      updatedAt: row.updatedAt,
    }));
  }

  wireSession(row: AgentSessionRow) { return toWireAgentSession(row, this.#specialists(row.id).map((p) => p.name), this.#statusOf(row) === "working"); }

  wireSessionsForUserSession(userSessionId: string) {
    return this.#deps.repo.listAgentSessions(userSessionId).map((row) => this.wireSession(row));
  }

  /** The session detail view: wire session + per-agent run stats + messages. */
  detail(agentSessionId: string): GetAgentSessionResponse {
    const row = this.#deps.repo.getAgentSession(agentSessionId);
    if (!row) throw new NotFoundError(`no agent session ${agentSessionId}`);
    return {
      session: this.wireSession(row),
      runs: this.#deps.repo.listAgents(row.id).map((agent) => ({
        agent: agent.name,
        profileId: agent.profileId,
        profile: agent.profileSnapshot,
        ownership: agent.ownership,
        generation: agent.generation,
        turnCount: agent.turnCount,
        contextTokens: agent.contextTokens,
        providerSessionId: agent.sdkSessionId,
      })),
      messages: this.#deps.repo.listMessages("agent", row.id).map(toWireMessage),
    };
  }

  async transcript(agentSessionId: string): Promise<ConsoleEvent[]> {
    const row = this.#deps.repo.getAgentSession(agentSessionId);
    if (!row) throw new NotFoundError(`no agent session ${agentSessionId}`);
    const events: ConsoleEvent[] = [];
    for await (const event of this.#deps.bus.readWithSeq({ agentSessionId: row.id })) {
      events.push(event);
    }
    return events;
  }

  /** Whole-session stop (archive/shutdown): every lane closes hard. */
  interrupt(agentSessionId: string): void {
    for (const lane of this.#seats.get(agentSessionId)?.values() ?? []) this.#closeLaneHard(lane);
  }

  /**
   * Scoped stop: abort one specialist's in-flight turn without touching its
   * siblings. Its delivered work is cancelled so redelivery does not restart
   * the same assignment; the lane survives for the corrected one.
   */
  interruptAgent(agentSessionId: string, agent: string, reason: string): void {
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (!session) throw new NotFoundError(`no agent session ${agentSessionId}`);
    const lane = this.#seats.get(agentSessionId)?.get(agent);
    if (!lane || lane.activeTurn === null) throw new ConflictError(`${agent} has no turn in flight`);
    for (const delivery of this.#deps.repo.listUnackedDeliveries(agentSessionId, agent)) {
      if (delivery.status === "delivered") this.#patchDelivery(session, delivery, "cancelled");
    }
    this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId,
      payload: { agentSessionId, agent, turnId: lane.activeTurn.turnId, detail: `stopped: ${reason}` } });
    if (lane.activeTurn) lane.activeTurn.watchdog.tripped = `stopped: ${reason}`;
    void lane.query?.interrupt?.().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const lanes of this.#seats.values()) for (const lane of lanes.values()) {
      this.#closeLaneHard(lane);
      if (lane.pump) pending.push(lane.pump.catch(() => undefined));
    }
    await Promise.all(pending);
  }

  #closeLaneHard(lane: AgentLane): void {
    lane.input?.close();
    lane.abort?.abort();
    void lane.query?.interrupt?.().catch(() => undefined);
    lane.query?.close?.();
    if (lane.idleTimer) { clearTimeout(lane.idleTimer); lane.idleTimer = null; }
    lane.state = "parked";
    this.#signalCapacity();
  }

  /**
   * Release every runtime resource this run holds, WITHOUT archiving anything
   * and WITHOUT touching worktrees. It stops short of archival because the
   * operator may ask for changes: agents respawn lazily over their retained
   * provider sessions, and a worktree destroyed here could not be merged
   * afterwards. Returns what it killed, so the summary can state it.
   */
  reapForUserSession(userSessionId: string): ReapResult {
    const processes: ReapResult["processes"] = [];
    let browsers = 0;
    for (const session of this.#deps.repo.listAgentSessions(userSessionId)) {
      if (session.lifecycle !== "open") continue;
      for (const seat of this.#deps.repo.listAgents(session.id)) {
        for (const killed of this.#deps.processes?.stopAgent(session.id, seat.name) ?? []) {
          processes.push({ agentSessionId: session.id, agent: seat.name, processId: killed.processId, pid: killed.pid });
        }
        void this.#deps.browsers?.closeAgent(`${session.id}:${seat.name}`)
          .then((closed) => { if (closed) browsers += 1; })
          .catch(() => undefined);
      }
    }
    // Processes the JOURNAL says are still running: started with no matching
    // exit. Counted separately from what we just killed, because a non-zero
    // figure here means something outlived its own bookkeeping.
    const started = new Map<string, string>();
    for (const event of this.#deps.repo.listProcessEvents(userSessionId)) {
      if (event.type === "agent_session.process.started") started.set(event.processId, event.processId);
      if (event.type === "agent_session.process.exited") started.delete(event.processId);
    }
    return { processes, browsers, leakedBefore: started.size };
  }

  archiveForUserSession(userSessionId: string): void {
    this.reapForUserSession(userSessionId);
    // Children first (they sort newer), so a child's cancelled deliveries can
    // never race its parent's teardown. Children share the userSessionId, so
    // the flat list covers the whole tree by construction.
    const open = this.#deps.repo.listAgentSessions(userSessionId)
      .filter((session) => session.lifecycle === "open")
      .sort((a, b) => b.depth - a.depth);
    for (const session of open) this.#archiveOne(session);
  }

  #archiveOne(session: AgentSessionRow): void {
    this.interrupt(session.id);
    this.#deps.processes?.stopSession(session.id);
    void this.#deps.browsers?.closeSession(session.id);
    this.#worktreeBinding.removeForSession(session);
    for (const delivery of this.#deps.repo.listActiveDeliveries(session.id)) this.#patchDelivery(session, delivery, "cancelled");
    this.#deps.repo.patchAgentSession(session.id, { lifecycle: "archived" });
    this.#forget(session.id);
    this.#deps.bus.append({ type: "agent_session.status.changed", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, status: "archived" } });
  }

  /** The ONE cleanup point for every per-session in-memory structure. */
  #forget(agentSessionId: string): void {
    this.#seats.delete(agentSessionId);
    this.#sessionStatus.delete(agentSessionId);
    this.#operatorDebtSettled.delete(agentSessionId);
    this.#routing.forget(agentSessionId);
  }

  /**
   * Boot sweep: children whose parent is archived or gone can never report to
   * anyone.
   */
  archiveOrphanChildren(): number {
    let archived = 0;
    for (const session of this.#deps.repo.listOpenAgentSessions()) {
      if (session.parentAgentSessionId === null) continue;
      const parent = this.#deps.repo.getAgentSession(session.parentAgentSessionId);
      if (parent && parent.lifecycle === "open") continue;
      this.#archiveOne(session);
      archived += 1;
      this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: "system", detail: "archived: parent session is no longer open" } });
    }
    return archived;
  }

  /**
   * The escape hatch for a wedged child: archive it and hand the parent's
   * controller a console failure so the tree can still conclude.
   */
  abandonChildSession(parentAgentSessionId: string, controllerAgent: string, childAgentSessionId: string, reason: string): void {
    const child = this.#deps.repo.getAgentSession(childAgentSessionId);
    if (!child || child.parentAgentSessionId !== parentAgentSessionId) {
      throw new InvalidInputError(`${childAgentSessionId} is not a child of this session`);
    }
    if (child.lifecycle === "open") this.#archiveOne(child);
    const parent = this.#deps.repo.getAgentSession(parentAgentSessionId);
    if (!parent || parent.lifecycle !== "open") return;
    try {
      this.post({ agentSessionId: parent.id, speaker: { kind: "agent", name: `${CHILD_SENDER_PREFIX}${child.id}` },
        to: child.parentControllerAgent ?? controllerAgent, category: "failure", dedupeKey: `child-abandoned:${child.id}`,
        handoff: this.#simpleHandoff(`Child session "${child.title}" abandoned`, "failed",
          `Abandoned by ${controllerAgent}: ${reason}. Whatever the child journaled is retrievable with read_handoff; nothing further will arrive from it.`,
          "Account for the abandoned work in your plan and your final report.") });
    } catch (error) { this.#recordHostFailure(parent.id, error); }
    this.#deps.bus.append({ type: "agent_session.child.reported", userSessionId: child.userSessionId, agentSessionId: parentAgentSessionId,
      payload: { agentSessionId: parentAgentSessionId, childAgentSessionId: child.id, status: "failed", handoffId: "" } });
    if (parent) this.#maybeReleaseParentFinal(parent);
  }

  onStatusChanged(handler: (userSessionId: string) => void): void {
    if (this.#onStatusChanged) throw new Error("onStatusChanged is already registered — wire callbacks once, in createApp");
    this.#onStatusChanged = handler;
  }

  /**
   * The governance clock: any `ask_operator` wait older than
   * `operatorAskDetachMs` is detached — the agent's process frees up while the
   * card stays open on the operator's screen.
   */
  startGovernanceSweep(intervalMs = this.#deps.config.policy.governanceSweepIntervalMs): void {
    if (this.#askSweep) return;
    this.#askSweep = setInterval(() => {
      const limit = this.#deps.config.policy.operatorAskDetachMs;
      const cutoff = Date.now() - limit;
      for (const lanes of this.#seats.values()) for (const lane of lanes.values()) {
        const asking = lane.activeTurn?.awaitingOperator;
        if (asking && asking.since < cutoff) {
          this.#detachOperatorAsk(lane, `no answer within ${Math.round(limit / 60_000)} minutes; the question stays open`);
        }
      }
      // The quiet-time stall lives here — it can trip while every lane is
      // quiet, which is exactly when it matters.
      for (const session of this.#deps.repo.listOpenAgentSessions()) {
        try { patternSweep(this.#patternCtx(), session); } catch (error) { this.#recordHostFailure(session.id, error); }
      }
    }, intervalMs);
    this.#askSweep.unref?.();
  }

  stopGovernanceSweep(): void {
    if (this.#askSweep) clearInterval(this.#askSweep);
    this.#askSweep = null;
  }

  /**
   * Hand an agent an answer its own tool call can no longer return.
   *
   * An agent is not revived by a lane the way main is — it is woken by a
   * delivery. So when its parked promise died (park, rotation, watchdog, or a
   * server restart) the answer arrives as a journaled `decision` handoff from
   * the coordinator's address, which is a legal `assertRoute` edge where a
   * `system` speaker would not be. The dedupe key makes a double answer a
   * no-op.
   */
  deliverOperatorAnswer(interaction: Interaction): void {
    if (!interaction.agentSessionId || !interaction.agent) return;
    const asked = questionTextOf(interaction);
    // The route resolved the row before calling this — render from the durable
    // record, through the one canonical renderer, so the agent reads exactly
    // what every later prompt will say.
    const decision = decisionOf(this.#deps.interactions.get(interaction.id));
    const answer = decision === null ? `${asked} → (no answer recorded)` : renderDecision(decision);
    const session = this.#deps.repo.getAgentSession(interaction.agentSessionId);
    if (!session) return;
    this.post({
      agentSessionId: interaction.agentSessionId,
      speaker: { kind: "system", name: CONSOLE_SENDER },
      to: interaction.agent,
      handoff: this.#simpleHandoff(
        `Operator answered: ${asked}`,
        "pending",
        `${answer}\n\nThis answer was recorded by the Console, not relayed by your coordinator. It is authoritative — do not re-litigate it, and do not ask again.`,
        "Continue from the operator's decision.",
      ),
      category: "decision",
      dedupeKey: `answer:${interaction.id}`,
    });
  }


  /** The bound context patterns/engine.ts runs over. */
  #patternCtx(): PatternContext {
    return {
      deps: { repo: this.#deps.repo, bus: this.#deps.bus, config: this.#deps.config },
      contract: (session) => this.#routing.contractOf(session).contract,
      completionSeat: (session, which) => this.#routing.completionAgent(session, which),
      post: (input) => this.post(input),
      simpleHandoff: (action, status, summary, nextAction) => this.#simpleHandoff(action, status, summary, nextAction),
      deliverNow: (agentSessionId, recipient) => void this.#deliverConsole(agentSessionId, recipient).catch((error) => this.#recordHostFailure(agentSessionId, error)),
      hasActivity: (agentSessionId) => {
        for (const lane of this.#seats.get(agentSessionId)?.values() ?? []) if (lane.activeTurn !== null) return true;
        return false;
      },
      sessionReported: (session) => this.#statusOf(session) === "reported",
      profile: (id, workspaceId) => this.#profile(id, workspaceId),
      snapshotProfile: (profile) => this.#snapshotProfile(profile),
      agent: (agentSessionId, name, role, profile, extra, model, ownership, ord, createdAt) =>
        this.#agentRow(agentSessionId, name, role, profile, extra, model, ownership, ord, createdAt),
    };
  }

  /** map_reduce fan-out; the machinery lives in patterns/engine.ts. */
  dispatchWorkItems(dispatcherAgent: string, input: DispatchWorkItemsInput): { joinId: string; agents: string[] } {
    const session = this.#deps.repo.getAgentSession(input.agentSessionId);
    if (!session) throw new NotFoundError(`no agent session ${input.agentSessionId}`);
    const dispatcher = this.#deps.repo.getAgent(session.id, dispatcherAgent);
    if (!dispatcher) throw new NotFoundError(`no agent ${dispatcherAgent} in ${input.agentSessionId}`);
    return dispatchWorkItems(this.#patternCtx(), session, dispatcher, input);
  }

  /**
   * The other half of the final gate: when a session's LAST blocking question
   * clears, the Console tells both ends — the coordinator learns it may
   * report, and main learns why the report it was expecting was late.
   * Registered by `main.ts` on the interaction service.
   */
  onBlockingQuestionsCleared(userSessionId: string, agentSessionId: string): void {
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (!session || session.lifecycle !== "open") return;
    const finalSeat = this.#routing.completionAgent(session, "finalFrom");
    const voiceSeat = this.#routing.completionAgent(session, "voice");
    const lane = this.#seats.get(agentSessionId)?.get(finalSeat);
    // Only meaningful if a final was actually withheld from this session —
    // derived from the durable handoff.final.blocked event, not an in-memory
    // set a restart wipes.
    if (!this.#finalWithheld(session)) return;
    try {
      this.post({
        agentSessionId,
        speaker: { kind: speakerKindOf(this.#deps.repo.getAgent(agentSessionId, voiceSeat)), name: voiceSeat },
        to: MAIN_RECIPIENT,
        handoff: this.#simpleHandoff(
          "Operator answered; the withheld final can now be sent",
          "in_progress",
          "A final report from this session was withheld while the operator had unanswered questions. They have now answered, and the coordinator has been told it may report.",
          "Expect the coordinator's final shortly.",
        ),
        category: "milestone",
      });
    } catch { /* the notice is best effort; the reporting agent still gets its delivery */ }
    if (lane) void this.#deliverConsole(agentSessionId, finalSeat).catch(() => undefined);
    void userSessionId;
  }

  /**
   * A child's material report crosses into its parent as a journaled handoff
   * to the parent's controller — verbatim core and extension, a state-summary
   * preamble naming the child, and the child final downgraded to a parent
   * MILESTONE (a child finishing is a milestone of the parent's work; keeping
   * `isFinalToMain` false on the boundary keeps the parent's final gate
   * honest). Uncertainty was already classified child-side, so the boundary
   * hop never re-promotes it. Idempotent by dedupe key across restarts.
   */
  #crossBoundary(child: AgentSessionRow, message: MessageRow, draft: HandoffDraft, category: Category): void {
    const parent = child.parentAgentSessionId === null ? undefined : this.#deps.repo.getAgentSession(child.parentAgentSessionId);
    if (!parent || parent.lifecycle !== "open" || child.parentControllerAgent === null) return;
    const mapped: Category = category === "final" ? "milestone" : category === "failure" ? "failure" : "update";
    const handoffId = (message.payload?.handoff as { id?: string } | undefined)?.id ?? message.id;
    const boundaryDraft: HandoffDraft = {
      core: { ...draft.core, state: { ...draft.core.state,
        summary: `Child session "${child.title}" (${child.id}) reports:\n${draft.core.state.summary}` } },
      extension: draft.extension,
    };
    try {
      this.post({ agentSessionId: parent.id, speaker: { kind: "agent", name: `${CHILD_SENDER_PREFIX}${child.id}` },
        to: child.parentControllerAgent, handoff: boundaryDraft, category: mapped, dedupeKey: `child:${handoffId}` });
      if (category === "final" || category === "failure") {
        this.#deps.bus.append({ type: "agent_session.child.reported", userSessionId: parent.userSessionId, agentSessionId: parent.id,
          payload: { agentSessionId: parent.id, childAgentSessionId: child.id,
            status: category === "final" ? "completed" : "failed", handoffId } });
      }
    } catch (error) { this.#recordHostFailure(child.id, error); }
  }

  /**
   * A final from this session was withheld and its real final has not landed
   * since — derived from the durable `handoff.final.blocked` event plus the
   * session's own status, so it survives restarts.
   */
  #finalWithheld(session: AgentSessionRow): boolean {
    return this.#statusOf(session) !== "reported" && this.#deps.repo.hasEvent("handoff.final.blocked", session.id);
  }

  /** The child-hold counterpart of onBlockingQuestionsCleared. */
  #maybeReleaseParentFinal(parent: AgentSessionRow): void {
    if (!this.#finalWithheld(parent)) return;
    const unsettled = this.#deps.repo.listChildSessions(parent.id)
      .filter((child) => child.lifecycle === "open" && this.#statusOf(child) !== "reported");
    if (unsettled.length > 0) return;
    const finalSeat = this.#routing.completionAgent(parent, "finalFrom");
    try {
      this.post({ agentSessionId: parent.id, speaker: { kind: "system", name: CONSOLE_SENDER }, to: finalSeat,
        handoff: this.#simpleHandoff("All child sessions have reported", "in_progress",
          "Every child session's final has crossed into this session. The withheld final may be sent now.",
          "Compile and send your final report."),
        category: "decision", dedupeKey: `children-clear:${parent.id}` });
    } catch { /* best effort — the next final attempt re-evaluates the gate */ }
  }

  /** Boot replay of a crash between a child's journal write and its boundary ack. */
  #redriveChildBoundary(session: AgentSessionRow, delivery: MailboxDeliveryRow): void {
    try {
      const message = this.#deps.repo.getMessageById(delivery.messageId);
      const summary = message?.payload?.handoff as { id?: string } | undefined;
      if (!message) return;
      if (summary?.id && this.#deps.handoffs && MATERIAL_CATEGORIES.has(delivery.category)) {
        const record = this.#deps.handoffs.get(summary.id);
        this.#crossBoundary(session, message, { core: record.core, extension: record.extension }, delivery.category);
      }
      this.#patchDelivery(session, delivery, "acknowledged");
      const parent = session.parentAgentSessionId === null ? undefined : this.#deps.repo.getAgentSession(session.parentAgentSessionId);
      if (parent && parent.lifecycle === "open") this.#maybeReleaseParentFinal(parent);
    } catch (error) { this.#recordHostFailure(session.id, error); }
  }

  boot(): void {
    const wakes = new Set<string>();
    for (const delivery of this.#deps.repo.listQueuedDeliveries()) {
      if (delivery.recipient === MAIN_RECIPIENT) {
        const session = this.#deps.repo.getAgentSession(delivery.agentSessionId);
        if (session && session.lifecycle === "open" && session.parentAgentSessionId !== null) this.#redriveChildBoundary(session, delivery);
        continue;
      }
      wakes.add(`${delivery.agentSessionId} ${delivery.recipient}`);
    }
    for (const key of wakes) {
      const [agentSessionId, recipient] = key.split(" ") as [string, string];
      void this.#deliverConsole(agentSessionId, recipient).catch((error) => this.#recordHostFailure(agentSessionId, error));
    }
  }

  profiles(workspaceId?: string): AgentProfile[] { return this.#deps.profiles?.list(workspaceId) ?? []; }
  runtimeAvailability(): { sandbox: boolean; chrome: boolean } {
    return { sandbox: fs.existsSync("/usr/bin/bwrap") || fs.existsSync("/usr/local/bin/bwrap"), chrome: fs.existsSync("/usr/bin/google-chrome") };
  }

  #agentRow(agentSessionId: string, name: string, role: string, profile: AgentProfile, extra: string, model: string | undefined, ownership: string[], ord: number, createdAt: string): AgentRow {
    const instructions = [profile.instructions, extra.trim()].filter(Boolean).join("\n\nAssigned role context:\n");
    return { agentSessionId, name, role, instructions, model: model ?? profile.model ?? null,
      profileId: profile.id, profileSnapshot: profile, ownership, sdkSessionId: null, lastActiveAt: null,
      generation: 0, turnCount: 0,
      contextTokens: 0, latestHandoffId: null,
      cumulativeCostUsd: 0, cumulativeApiDurationMs: 0, lastDecisionAt: null,
      worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null,
      ord, createdAt };
  }

  #profile(id: string, workspaceId?: string): AgentProfile {
    if (this.#deps.profiles) return this.#deps.profiles.get(id, workspaceId);
    return { id, title: id, purpose: id, instructions: `You are the ${id} specialist.`, tools: ["Read", "Glob", "Grep"], permissionMode: "default", exemptFromOwnership: false, maxTurns: 30, sandboxRequired: true, runtime: { shell: false, browser: false, screenshots: false, network: [] } };
  }

  /**
   * When an agent completes a turn without sending, while its current
   * assignment still lacks a terminal report from it, the Console carries the
   * turn's final text to its collector as a completed report — in EVERY
   * pattern (specialist→coordinator, stage→next stage, debater→judge,
   * mapper→reducer). An explicit send supersedes this (`sawSend`); an agent
   * with an open operator question keeps its silence — the answer's delivery
   * gives it another turn to report from. Coordinator-role agents are exempt:
   * they legitimately settle many quiet turns mid-orchestration, and their
   * own silence is the operator-debt discharge's job.
   */
  #carryReport(session: AgentSessionRow, seatName: string, turn: NonNullable<AgentLane["activeTurn"]>): void {
    const seat = this.#deps.repo.getAgent(session.id, seatName);
    if (!seat || seat.role === "coordinator") return;
    const text = turn.lastNarration.trim();
    if (text === "") return;
    const assignment = this.#deps.repo.latestAssignmentDelivery(session.id, seatName);
    if (!assignment) return;
    const assignmentSeq = this.#deps.repo.getMessageById(assignment.messageId)?.seq ?? 0;
    const reported = this.#deps.repo.listMessages("agent", session.id).some((row) =>
      row.speakerName === seatName && row.seq > assignmentSeq
      && ["completed", "failed"].includes((row.payload?.handoff as { status?: string } | undefined)?.status ?? ""));
    if (reported) return;
    const collector = this.#routing.relayCollector(session, roleOfAgent(seat), seatName);
    if (collector === null) return;
    if (this.#deps.interactions.listUnresolvedForAgentSession(session.id).some((row) => row.agent === seatName)) return;
    this.post({ agentSessionId: session.id, speaker: { kind: "agent", name: seatName }, to: collector,
      handoff: this.#simpleHandoff(`Report relayed by the Console from ${seatName}'s settled turn (the agent ended it without send_handoff)`, "completed", text, null),
      category: "update", turnId: turn.turnId });
  }

  // ── Persistent agent lanes ───────────────────────────────────────────────

  #laneOf(agentSessionId: string, seat: string): AgentLane {
    let lanes = this.#seats.get(agentSessionId);
    if (!lanes) { lanes = new Map(); this.#seats.set(agentSessionId, lanes); }
    let lane = lanes.get(seat);
    if (!lane) {
      lane = { state: "unspawned", input: null, query: null, abort: null, pump: null, ready: null,
        activeTurn: null, pendingDeliveries: [], redeliveryAttempts: new Map(), contextTokens: 0,
        lastCumulative: { costUsd: 0, apiDurationMs: 0 }, rotationGate: null, releaseRotation: null,
        idleTimer: null, assignmentTurns: 0, turnBudgetNotified: false, lastActiveAt: 0, lastStatus: null };
      lanes.set(seat, lane);
    }
    return lane;
  }

  /** Spawn or unpark an agent so its peer session is registered and accepting input. */
  async ensureSeatLive(agentSessionId: string, seat: string, deadline?: number): Promise<void> {
    const { repo } = this.#deps;
    const until = deadline ?? Date.now() + (this.#deps.config.policy.agentSpawnTimeoutMs ?? 30_000);
    const lane = this.#laneOf(agentSessionId, seat);
    while (lane.rotationGate) await lane.rotationGate;
    if (lane.state === "live" || lane.state === "waking") { await lane.ready; return; }
    const session = repo.getAgentSession(agentSessionId);
    if (!session || session.lifecycle !== "open") throw new ConflictError(`agent session ${agentSessionId} is not open`);
    const seatRow = repo.getAgent(agentSessionId, seat);
    if (!seatRow) throw new NotFoundError(`no agent ${seat} in ${agentSessionId}`);
    await this.#reserveCapacity(agentSessionId, until);
    const raced = lane.state as AgentLane["state"];
    if (raced === "live" || raced === "waking") { await lane.ready; return; }
    this.#spawnSeat(session, seatRow, lane);
    await lane.ready;
    // A respawn may inherit rows the previous process took delivery of but
    // never consumed; requeue them so the console path re-carries exactly once.
    const stale = repo.listUnackedDeliveries(agentSessionId, seat).filter((row) => row.status === "delivered");
    for (const row of stale) repo.patchDelivery(row.id, { status: "queued", deliveredAt: null });
  }

  #resident(): number {
    let count = 0;
    for (const lanes of this.#seats.values()) {
      for (const lane of lanes.values()) if (lane.state === "live" || lane.state === "waking" || lane.state === "rotating") count += 1;
    }
    return count;
  }

  /** Session ids sharing one resident budget: the root and its children. */
  #treeSessionIds(agentSessionId: string): Set<string> {
    const row = this.#deps.repo.getAgentSession(agentSessionId);
    const rootId = row?.parentAgentSessionId ?? agentSessionId;
    const ids = new Set([rootId]);
    for (const child of this.#deps.repo.listChildSessions(rootId)) ids.add(child.id);
    return ids;
  }

  #residentIn(sessionIds: ReadonlySet<string>): number {
    let count = 0;
    for (const [sessionId, lanes] of this.#seats) {
      if (!sessionIds.has(sessionId)) continue;
      for (const lane of lanes.values()) if (lane.state === "live" || lane.state === "waking" || lane.state === "rotating") count += 1;
    }
    return count;
  }

  /** Resident CLI processes are the scarce resource, not concurrent turns. */
  async #reserveCapacity(agentSessionId: string, until: number): Promise<void> {
    const config = this.#deps.config;
    if (!config) return;
    for (;;) {
      const tree = this.#treeSessionIds(agentSessionId);
      const globalFull = this.#resident() >= config.policy.agentMaxResident;
      // A parent and its children SHARE a budget: nesting must not multiply
      // the footprint, and a tree self-throttles before it thrashes strangers.
      const treeFull = this.#residentIn(tree) >= config.policy.agentMaxResidentPerTree;
      if (!globalFull && !treeFull) return;
      // Evict only where it frees the BINDING constraint: when the global cap
      // binds, try our own tree first.
      const scope = globalFull ? undefined : tree;
      if (scope === undefined && this.#parkLeastRecentIdle(tree)) continue;
      if (this.#parkLeastRecentIdle(scope)) continue;
      if (Date.now() >= until) throw new Error("no resident seat capacity");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(1_000, Math.max(50, until - Date.now())));
        timer.unref?.();
        this.#capacityWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  #parkLeastRecentIdle(within?: ReadonlySet<string>): boolean {
    let victim: { sessionId: string; seat: string; lane: AgentLane } | null = null;
    for (const [sessionId, lanes] of this.#seats) {
      if (within !== undefined && !within.has(sessionId)) continue;
      for (const [seat, lane] of lanes) {
        if (lane.state !== "live" || lane.activeTurn !== null) continue;
        if (this.#deps.repo.listUnackedDeliveries(sessionId, seat).length > 0) continue;
        if (!victim || lane.lastActiveAt < victim.lane.lastActiveAt) victim = { sessionId, seat, lane };
      }
    }
    if (!victim) return false;
    this.#parkSeat(victim.sessionId, victim.seat, victim.lane, "capacity");
    return true;
  }

  /**
   * Cut a blocking `ask_operator` loose. The tool call returns, the turn ends,
   * and the question stays open — the answer will arrive as a delivery.
   */
  #detachOperatorAsk(lane: AgentLane, reason: string): void {
    const asking = lane.activeTurn?.awaitingOperator;
    if (!asking) return;
    this.#deps.interactions.detach(asking.interactionId, reason);
    asking.abort.abort();
  }

  /**
   * An agent putting a question to the human.
   *  - a duplicate returns the OPEN card rather than minting a second one;
   *  - a blocking wait is bounded by ONE mechanism, the operatorAskDetachMs
   *    timer: the agent's process frees up, the card stays open and blocking;
   *  - nothing here EVER returns `isError` — a dismissal, a detach or an
   *    expiry is not the agent's mistake, and error results feed the
   *    error-streak watchdog.
   */
  async #askOperator(session: AgentSessionRow, seat: AgentRow, lane: AgentLane, args: AskOperatorArgs): Promise<SdkToolResult> {
    const interactions = this.#deps.interactions;
    if (!interactions) return ok({ resolved: false, reason: "the console cannot reach the operator right now" });
    const dedupeKey = dedupeKeyFor(seat.name, args.question);
    const open = interactions.findUnresolvedByDedupe(session.id, dedupeKey);
    if (open) {
      return ok({ queued: true, interactionId: open.id, deduped: true,
        note: "You already asked this and the card is still open on the operator's screen. Do not ask again; keep working or stop." });
    }
    const urgency: InteractionUrgency = args.urgency;

    const question: InteractionQuestion = {
      question: args.question,
      ...(args.header ? { header: args.header } : {}),
      ...(args.context ? { context: args.context } : {}),
      options: args.options,
      ...(args.recommendation ? { recommendation: args.recommendation } : {}),
    };
    // Its OWN controller, chained to the lane's, so park/rotation/watchdog can
    // release this one wait without taking the lane down with it.
    const abort = new AbortController();
    const pending = interactions.createOperatorQuestion({
      userSessionId: session.userSessionId,
      agentSessionId: session.id,
      agent: seat.name,
      questions: [question],
      urgency,
      source: "agent",
      ...(args.recommendation ? { recommendation: args.recommendation } : {}),
      allowFreeText: args.allowFreeText,
      dedupeKey,
      signal: abort.signal,
    });

    if (urgency === "deferred") {
      return ok({ queued: true, interactionId: pending.id, urgency: "deferred",
        note: "The operator can see this now. Their answer will be handed to you at your next delivery — keep working; do not poll." });
    }

    const turn = lane.activeTurn;
    if (turn) turn.awaitingOperator = { interactionId: pending.id, since: Date.now(), abort };
    this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, agent: seat.name, detail: `waiting on the operator (${pending.id})` } });
    try {
      const resolved = await pending.resolution;
      if (resolved.kind === "answers") {
        return ok({ resolved: true, interactionId: pending.id, answers: resolved.answers,
          ...(resolved.freeText === undefined ? {} : { freeText: resolved.freeText }),
          ...(resolved.note === undefined ? {} : { note: resolved.note }),
          ledger: "Recorded as an operator decision; every seat in this session now sees it, so do not relay it." });
      }
      return ok({ resolved: false, interactionId: pending.id,
        reason: resolved.kind === "dismissed" ? resolved.reason : "the operator declined" });
    } finally {
      if (turn) turn.awaitingOperator = null;
    }
  }

  #signalCapacity(): void {
    this.#capacityWaiters.shift()?.();
  }

  #spawnSeat(session: AgentSessionRow, seatRow: AgentRow, lane: AgentLane): void {
    if (!this.#deps.sdk || !this.#deps.config || !this.#deps.getWorkspaceRoot) throw new Error("SDK unavailable");
    lane.state = "waking";
    lane.abort = new AbortController();
    lane.input = new AsyncQueue<SdkUserMessageLike>();
    lane.lastActiveAt = Date.now();
    // Occupancy is re-reported by the first assistant message of any new
    // process, so it always restarts at zero.
    lane.contextTokens = 0;
    // Cost and api-duration do NOT: the SDK reports them cumulatively per
    // query(), and a RESUMED session continues its running total across the
    // process boundary — the baseline belongs to the PROVIDER SESSION, not
    // the lane. An agent with no `sdkSessionId` is genuinely starting fresh
    // (rotation does that in #rotateNow), so its baseline is zero.
    lane.lastCumulative = seatRow.sdkSessionId === null
      ? { costUsd: 0, apiDurationMs: 0 }
      : { costUsd: seatRow.cumulativeCostUsd, apiDurationMs: seatRow.cumulativeApiDurationMs };
    lane.ready = (async () => {
      const sdk = await this.#deps.sdk!();
      const user = this.#deps.repo.getUserSession(session.userSessionId);
      if (!user) throw new Error("workspace unavailable");
      const workspaceRoot = this.#deps.getWorkspaceRoot!(user.workspaceId);
      const latestSeat = this.#worktreeBinding.ensureAgentWorktree(session, this.#deps.repo.getAgent(session.id, seatRow.name) ?? seatRow, workspaceRoot);
      const profile = latestSeat.profileSnapshot as AgentProfile;
      const seatRoot = latestSeat.worktreePath ?? workspaceRoot;
      const contract = this.#routing.contractOf(session);
      const seatRole = roleOfAgent(latestSeat);
      // Builders must supply a prompt for every role; the hub specialist pack
      // is the conservative fallback for a snapshot that somehow lacks one.
      const rolePrompt = contract.prompt(seatRole) ?? hubContract().promptPack.specialist!;
      const granted = grantedTools(contract.role(seatRole), profile, {
        tasks: Boolean(this.#deps.tasks), handoffs: Boolean(this.#deps.handoffs),
        processes: Boolean(this.#deps.processes), browsers: Boolean(this.#deps.browsers),
        worktrees: Boolean(this.#deps.worktrees), user: Boolean(user),
        childSessions: this.#deps.config.policy.enableChildSessions !== false && session.parentAgentSessionId === null,
      });
      const mcp = this.#buildParticipantMcp(sdk, session, latestSeat, lane, granted);
      const options: SdkOptions = {
        cwd: seatRoot,
        systemPrompt: { type: "preset", preset: "claude_code", append: this.#composer.systemPromptAppend(session, latestSeat, profile, rolePrompt) },
        settingSources: [], includePartialMessages: true,
        permissionMode: profile.permissionMode,
        ...(profile.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        allowedTools: [...profile.tools,
          ...(profile.tools.includes("Edit") || profile.tools.includes("Write") ? ["EnterWorktree", "ExitWorktree"] : []),
          ...runtimeToolNames(granted)],
        // A profile's tool list must be BINDING: `allowedTools` is only an
        // auto-approval list, so everything the profile did not grant is
        // denied by name. The native Task* tools are additionally scoped to
        // the provider session, so their ledger dies at every rotation; agents
        // use the console-owned task_list/task_create/task_update instead.
        disallowedTools: [...new Set([
          // One transport: `send_handoff` is console-carried, so there is no
          // second wire whose delivery semantics can diverge from it.
          "Agent", "Task", "SendMessage", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
          ...GOVERNED_BUILTIN_TOOLS.filter((name) => !profile.tools.includes(name)),
        ])],
        sandbox: { enabled: true, failIfUnavailable: profile.sandboxRequired, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
          filesystem: { allowManagedReadPathsOnly: true, allowRead: latestSeat.worktreePath ? [seatRoot, workspaceRoot] : [workspaceRoot], allowWrite: [seatRoot] },
          network: sandboxNetwork(profile, this.#deps.config.infra.allowedDomains ?? []) },
        // Agent identity rides the ENV, not the prompt: visible to process
        // forensics and the test discriminator without perturbing the
        // cache-invariant system-prompt head above.
        env: { ...sdkEnv(),
          CONSOLE_AGENT_SESSION_ID: session.id,
          CONSOLE_AGENT_NAME: latestSeat.name,
          CONSOLE_PATTERN_ROLE: seatRole,
          CONSOLE_PATTERN: session.pattern,
          CONSOLE_SESSION_DEPTH: String(session.depth),
        },
        abortController: lane.abort!, persistSession: true,
        sessionStore: this.#deps.sessionStore as never, sessionStoreFlush: "eager",
        mcpServers: { console_agent: mcp as never },
        ...(latestSeat.model ? { model: latestSeat.model } : {}),
        ...((profile.pluginPath && profile.source === "workspace") ? { plugins: [{ type: "local" as const, path: profile.pluginPath }] } : {}),
        // Always explicit: omitting the key lets the CLI fall back to the
        // OPERATOR's personal skill listing despite settingSources: [].
        skills: profile.skills ?? [],
        ...((profile.effort ?? this.#deps.config.infra.effort) ? { effort: (profile.effort ?? this.#deps.config.infra.effort) as SdkOptions["effort"] } : {}),
        ...(latestSeat.sdkSessionId ? { resume: latestSeat.sdkSessionId } : {}),
      };
      const query = sdk.query({ prompt: lane.input as AsyncIterable<SdkUserMessageLike>, options });
      lane.query = query;
      lane.state = "live";
      lane.pump = this.#pumpSeat(session, latestSeat.name, lane, query).catch((error) => this.#recordHostFailure(session.id, error));
    })().catch((error) => {
      lane.state = "parked";
      lane.input?.close(); lane.input = null;
      this.#signalCapacity();
      throw error;
    });
  }

  async #pumpSeat(session: AgentSessionRow, seatName: string, lane: AgentLane, query: QueryHandle): Promise<void> {
    const { repo, bus } = this.#deps;
    const runtime = new RuntimeBroadcaster(bus, { kind: "agent", agentSessionId: session.id }, seatName,
      { userSessionId: session.userSessionId, agentSessionId: session.id });
    try {
      for await (const raw of query) {
        for (const event of mapSdkMessage(raw)) {
          if ("parentCallId" in event && event.parentCallId) continue;
          if (event.kind === "resume") { repo.patchAgent(session.id, seatName, { sdkSessionId: event.resumeId }); continue; }
          if (event.kind === "turn-idle") { this.#settleSeatTurn(session, seatName, lane, runtime, "completed"); continue; }
          if (event.kind === "task-terminal") { runtime.note(event.summary); continue; }
          if (event.kind === "notice") {
            runtime.note(event.text);
            bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
              payload: { agentSessionId: session.id, agent: seatName, ...(lane.activeTurn ? { turnId: lane.activeTurn.turnId } : {}), detail: event.text } });
            continue;
          }
          if (event.kind === "retry") {
            // Alongside the notice prose, never instead of it: the transcript
            // keeps the human-readable line, counters read this one.
            bus.append({ type: "agent_session.retry.recorded", userSessionId: session.userSessionId, agentSessionId: session.id,
              payload: { userSessionId: session.userSessionId, agentSessionId: session.id, agent: seatName, kind: event.classification,
                ...(event.attempt === undefined ? {} : { attempt: event.attempt }), retryInMs: event.delayMs, detail: event.detail } });
            continue;
          }
          // Output with no open turn: the CLI resumed work on its own (e.g.
          // after an interrupt landed mid-stream). Mint a turn so the work is
          // attributed rather than orphaned.
          if (!lane.activeTurn && (event.kind === "delta" || event.kind === "reasoning-delta" || event.kind === "message" || event.kind === "tool.call")) {
            this.#mintTurn(session, seatName, lane, []);
          }
          const turn = lane.activeTurn;
          const turnId = turn?.turnId ?? "";
          if (event.kind === "delta") {
            runtime.set("responding");
            bus.broadcast({ type: "stream.delta", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { scope: { kind: "agent", agentSessionId: session.id }, speaker: seatName, turnId, text: event.text } });
          } else if (event.kind === "reasoning-delta") {
            runtime.set("thinking");
            bus.broadcast({ type: "stream.reasoning", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { scope: { kind: "agent", agentSessionId: session.id }, speaker: seatName, turnId, text: event.text } });
            // Broadcast only — reasoning is not persisted.
          } else if (event.kind === "message") {
            if (turn) turn.lastNarration = event.text;
            this.#recordNarration(session, seatName, event.text, turnId);
          } else if (event.kind === "tool.call") {
            turn?.toolStarts.set(event.callId, Date.now());
            runtime.set("tool", event.name);
            bus.append({ type: "agent_session.tool.called", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { agentSessionId: session.id, agent: seatName, turnId, callId: event.callId, name: event.name, input: bus.captureSized(event.input, { userSessionId: session.userSessionId, agentSessionId: session.id }).value } });
            if (turn) {
              const key = `${event.name} ${stableStringify(event.input)}`;
              turn.watchdog.identical = key === turn.watchdog.lastKey ? turn.watchdog.identical + 1 : 1;
              turn.watchdog.lastKey = key;
              if (turn.watchdog.identical >= this.#deps.config.policy.watchdogIdenticalCalls) {
                this.#tripWatchdog(session, seatName, lane, { kind: "repeat_tool_calls", toolName: event.name, count: turn.watchdog.identical,
                  detail: `watchdog: ${turn.watchdog.identical} identical consecutive calls to ${event.name}` });
              }
            }
          } else if (event.kind === "tool.result") {
            const captured = bus.captureSized(event.output, { userSessionId: session.userSessionId, agentSessionId: session.id });
            const startedAt = turn?.toolStarts.get(event.callId); turn?.toolStarts.delete(event.callId);
            runtime.set("thinking");
            bus.append({ type: "agent_session.tool.completed", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { agentSessionId: session.id, agent: seatName, turnId, callId: event.callId, output: captured.value, bytes: captured.bytes, ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }), ...(event.isError ? { isError: true } : {}) } });
            if (turn) {
              turn.watchdog.errorStreak = event.isError ? turn.watchdog.errorStreak + 1 : 0;
              if (turn.watchdog.errorStreak >= this.#deps.config.policy.watchdogErrorStreak) {
                this.#tripWatchdog(session, seatName, lane, { kind: "tool_error_streak", count: turn.watchdog.errorStreak,
                  detail: `watchdog: ${turn.watchdog.errorStreak} consecutive tool errors` });
              }
            }
          } else if (event.kind === "context") {
            lane.contextTokens = Math.max(lane.contextTokens, event.occupancyTokens);
          } else if (event.kind === "result") {
            const seat = repo.getAgent(session.id, seatName);
            if (seat) {
              repo.patchAgent(session.id, seatName, { ...(event.resumeId ? { sdkSessionId: event.resumeId } : {}), contextTokens: Math.max(seat.contextTokens, lane.contextTokens) });
              this.#recordUsage(session, seat, lane.lastCumulative, turnId || newId("turn"), event, "completed", turn ? Date.now() - turn.startedAt : undefined);
            }
            this.#settleSeatTurn(session, seatName, lane, runtime, "completed");
          } else if (event.kind === "error") {
            const seat = repo.getAgent(session.id, seatName);
            if (seat) {
              repo.patchAgent(session.id, seatName, { contextTokens: Math.max(seat.contextTokens, lane.contextTokens) });
              this.#recordUsage(session, seat, lane.lastCumulative, turnId || newId("turn"), event, event.aborted ? "aborted" : "error", turn ? Date.now() - turn.startedAt : undefined);
            }
            this.#settleSeatTurn(session, seatName, lane, runtime, event.aborted ? "aborted" : "error", event.message);
          }
        }
      }
    } finally {
      this.#settleSeatTurn(session, seatName, lane, runtime, "aborted", "the seat stream ended");
      runtime.idle();
      if (lane.state === "live" || lane.state === "waking") { lane.state = "parked"; lane.input = null; lane.query = null; this.#signalCapacity(); }
    }
  }

  #tripWatchdog(session: AgentSessionRow, seatName: string, lane: AgentLane, tripped: { kind: "repeat_tool_calls" | "tool_error_streak"; detail: string; toolName?: string; count: number }): void {
    const turn = lane.activeTurn;
    if (!turn || turn.watchdog.tripped) return;
    turn.watchdog.tripped = tripped.detail;
    this.#deps.bus.append({ type: "agent_session.watchdog.tripped", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, agent: seatName, turnId: turn.turnId, kind: tripped.kind,
        ...(tripped.toolName ? { toolName: tripped.toolName } : {}), count: tripped.count, detail: tripped.detail } });
    // Interrupt, never abort: the turn dies, the lane (and its inbox) survive.
    void lane.query?.interrupt?.().catch(() => undefined);
  }

  #mintTurn(session: AgentSessionRow, seatName: string, lane: AgentLane, deliveries: MailboxDeliveryRow[]): void {
    const attributed = deliveries.length > 0 ? deliveries
      : this.#deps.repo.listUnackedDeliveries(session.id, seatName).filter((row) => row.status === "delivered");
    lane.activeTurn = { turnId: newId("turn"), startedAt: Date.now(), deliveries: attributed, sawSend: false,
      toolStarts: new Map(), lastNarration: "", watchdog: { lastKey: "", identical: 0, errorStreak: 0, tripped: null }, awaitingOperator: null };
    lane.lastActiveAt = Date.now();
    if (lane.idleTimer) { clearTimeout(lane.idleTimer); lane.idleTimer = null; }
    this.#deps.bus.append({ type: "agent_session.turn.started", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, agent: seatName, turnId: lane.activeTurn.turnId } });
    this.#setStatus(session.id, "working");
  }

  #settleSeatTurn(session: AgentSessionRow, seatName: string, lane: AgentLane, runtime: RuntimeBroadcaster, status: "completed" | "error" | "aborted", errorMessage?: string): void {
    const turn = lane.activeTurn;
    if (!turn) return;
    lane.activeTurn = null;
    const { repo, bus } = this.#deps;
    if (turn.watchdog.tripped !== null) { status = "error"; errorMessage = turn.watchdog.tripped; }
    let requeued = false;
    if (status === "completed") {
      for (const delivery of turn.deliveries) this.#patchDelivery(session, delivery, "acknowledged");
      for (const delivery of turn.deliveries) lane.redeliveryAttempts.delete(delivery.id);
    } else {
      // A watchdog trip means the agent malfunctioned ON THIS INPUT and an
      // operator abort is a deliberate stop; redelivering either just
      // reproduces the failure. Those cancel, and the coordinator decides
      // from the failure handoff.
      const retryable = status === "error" && turn.watchdog.tripped === null;
      // A transport failure says nothing about the delivery — the request
      // never reached the model — so it does not spend a redelivery attempt.
      const transport = isTransportFailure(errorMessage ?? null);
      for (const delivery of turn.deliveries) {
        const attempts = (lane.redeliveryAttempts.get(delivery.id) ?? 0) + (transport ? 0 : 1);
        if (!retryable || attempts > this.#deps.config.policy.maxRedeliveryAttempts) {
          lane.redeliveryAttempts.delete(delivery.id);
          this.#patchDelivery(session, delivery, "cancelled");
          continue;
        }
        lane.redeliveryAttempts.set(delivery.id, attempts);
        this.#patchDelivery(session, delivery, "queued");
        requeued = true;
      }
    }
    const seat = repo.getAgent(session.id, seatName);
    if (seat) {
      repo.patchAgent(session.id, seatName, { turnCount: seat.turnCount + 1, lastActiveAt: nowIso() });
    }
    lane.assignmentTurns += 1;
    lane.lastActiveAt = Date.now();
    if (status === "error" && repo.getAgentSession(session.id)?.lifecycle === "open") {
      const target = this.#routing.escalationTarget(session, seatName);
      // A dead turn must hand its successor real state: `#reconstructCheckpoint`
      // assembles what the console owns (ownership, task ledger, worktree diff,
      // current assignment, last report), with the error and any salvaged
      // narration spliced on top.
      const salvaged = turn.lastNarration.trim();
      const reason = turn.watchdog.tripped ?? `Provider turn failed: ${errorMessage}`;
      let draft: HandoffDraft;
      try {
        const reconstructed = seat ? this.#composer.reconstructCheckpoint(session, seat) : null;
        draft = reconstructed
          ? { core: { ...reconstructed.core, status: "failed", risk: "high", action: "Turn failed",
              state: { ...reconstructed.core.state,
                summary: `${reason}\n\nState the Console can vouch for:\n${reconstructed.core.state.summary}${salvaged === "" ? "" : `\n\nUnsent work from ${seatName}'s last output (unverified — it never passed through a handoff):\n${salvaged.slice(0, 8_000)}`}` },
              nextAction: "Inspect the failure and retry or reassign." },
              ...(reconstructed.extension ? { extension: reconstructed.extension } : {}) }
          : this.#simpleHandoff("Turn failed", "failed", reason, "Inspect the failure and retry or reassign.");
      } catch {
        draft = this.#simpleHandoff("Turn failed", "failed", reason, "Inspect the failure and retry or reassign.");
      }
      this.post({ agentSessionId: session.id, speaker: { kind: speakerKindOf(seat), name: seatName }, to: target,
        handoff: draft, category: "failure", turnId: turn.turnId });
    }
    // Error settles already reached the collector above (escalateTo IS the
    // fan-in collector); aborted settles are teardown paths that must not
    // post. Only a clean completion can leave a join waiting.
    if (status === "completed" && !turn.sawSend && repo.getAgentSession(session.id)?.lifecycle === "open") {
      try { this.#carryReport(session, seatName, turn); } catch (error) { this.#recordHostFailure(session.id, error); }
    }
    const profile = seat?.profileSnapshot as AgentProfile | undefined;
    if (status === "completed" && profile && lane.assignmentTurns >= profile.maxTurns + 1 && !lane.turnBudgetNotified && repo.getAgentSession(session.id)?.lifecycle === "open") {
      lane.turnBudgetNotified = true;
      const target = this.#routing.escalationTarget(session, seatName);
      this.post({ agentSessionId: session.id, speaker: { kind: speakerKindOf(seat), name: seatName }, to: target,
        handoff: this.#simpleHandoff("Turn budget exhausted", "blocked",
          `${seatName} has spent ${lane.assignmentTurns - 1} turns on the current assignment (budget ${profile.maxTurns}).`,
          "Refocus, reassign, or explicitly continue the work."), category: "failure", turnId: turn.turnId });
    }
    bus.append({ type: "agent_session.turn.settled", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, agent: seatName, turnId: turn.turnId, status, durationMs: Date.now() - turn.startedAt, ...(errorMessage ? { errorMessage } : {}) } });
    this.#worktreeBinding.snapshotTurn(session.id, seatName, turn.turnId);
    runtime.idle();
    if (requeued && repo.getAgentSession(session.id)?.lifecycle === "open") {
      void this.#deliverConsole(session.id, seatName).catch((error) => this.#recordHostFailure(session.id, error));
    }
    this.#refreshStatus(session.id);
    this.#armIdleTimer(session.id, seatName, lane);
    void this.#maybeRotate(session.id, seatName).catch((error) => this.#recordHostFailure(session.id, error));
  }

  /** Console-path delivery: render queued journal rows into the lane input. */
  async #deliverConsole(agentSessionId: string, recipient: string): Promise<void> {
    await this.ensureSeatLive(agentSessionId, recipient);
    const { repo, bus } = this.#deps;
    const session = repo.getAgentSession(agentSessionId);
    const lane = this.#laneOf(agentSessionId, recipient);
    const seatRow = repo.getAgent(agentSessionId, recipient);
    if (!session || !lane.input || !seatRow) return;
    const rows = repo.listUnackedDeliveries(agentSessionId, recipient).filter((row) => row.status === "queued");
    if (rows.length === 0) return;
    const messages = rows.map((row) => repo.getMessageById(row.messageId)).filter((row): row is MessageRow => row !== undefined);
    for (const row of rows) this.#patchDelivery(session, row, "delivered");
    if (rows.some((row) => row.category === "assignment")) { lane.assignmentTurns = 0; lane.turnBudgetNotified = false; }
    const prompt = this.#composer.deliveryPrompt(session, seatRow, messages);
    if (lane.activeTurn) {
      lane.activeTurn.deliveries.push(...rows);
      lane.input.push(seatUserMessage(`New addressed handoffs arrived while you were working — fold them into the work in progress.\n\n${prompt}`));
      bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: recipient, turnId: lane.activeTurn.turnId, detail: `steered mid-turn (${rows.length} deliveries)` } });
    } else {
      this.#mintTurn(session, recipient, lane, rows);
      lane.input.push(seatUserMessage(prompt));
    }
  }

  #armIdleTimer(agentSessionId: string, seatName: string, lane: AgentLane): void {
    const config = this.#deps.config;
    if (!config) return;
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    lane.idleTimer = setTimeout(() => {
      lane.idleTimer = null;
      if (lane.state !== "live" || lane.activeTurn !== null) return;
      if (this.#deps.repo.listUnackedDeliveries(agentSessionId, seatName).length > 0) return;
      this.#parkSeat(agentSessionId, seatName, lane, "idle");
    }, config.policy.agentIdleReapMs);
    lane.idleTimer.unref?.();
  }

  /**
   * Close the process (name and socket unregister); keep the resume handle.
   * Runtime the agent still holds dies with the lane: a parked agent is not
   * coming back imminently, so its dev servers and Chrome are pure leak.
   */
  #parkSeat(agentSessionId: string, seatName: string, lane: AgentLane, reason: string): void {
    lane.state = "parked";
    lane.input?.close(); lane.input = null;
    const query = lane.query; lane.query = null;
    query?.close?.();
    lane.abort = null;
    const killed = this.#deps.processes?.stopAgent(agentSessionId, seatName) ?? [];
    void this.#deps.browsers?.closeAgent(`${agentSessionId}:${seatName}`).catch(() => undefined);
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (session) {
      // Name what was reaped.
      const reaped = killed.length === 0 ? "" : `; reaped ${killed.length} process(es): ${killed.map((p) => `${p.processId}${p.pid === undefined ? "" : ` (pid ${p.pid})`}`).join(", ")}`;
      this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId,
        payload: { agentSessionId, agent: seatName, detail: `agent parked (${reason}); provider session retained${reaped}` } });
    }
    this.#signalCapacity();
  }

  /**
   * Context rotation at a turn boundary, under a gate that blocks senders:
   * checkpoint the old process, close it, respawn the same peer name on a
   * fresh provider session, then re-carry anything unacknowledged.
   */
  async #maybeRotate(agentSessionId: string, seatName: string): Promise<void> {
    const config = this.#deps.config;
    if (!config || !this.#deps.handoffs || !this.#deps.sdk) return;
    const lane = this.#laneOf(agentSessionId, seatName);
    if (lane.state !== "live" || lane.activeTurn !== null || lane.rotationGate !== null) return;
    const { repo } = this.#deps;
    const session = repo.getAgentSession(agentSessionId);
    const seat = repo.getAgent(agentSessionId, seatName);
    if (!session || session.lifecycle !== "open" || !seat) return;
    const tokenLimit = rotationTokenLimit(config.policy.contextTokenLimit, seat.model ?? config.infra.model);
    const due = rotationDue({
      turnCount: seat.turnCount, contextTokens: seat.contextTokens,
      turnLimit: config.policy.contextTurnLimit, tokenLimit,
    });
    if (!due) return;
    lane.state = "rotating";
    lane.rotationGate = new Promise((resolve) => { lane.releaseRotation = resolve; });
    try {
      lane.input?.close(); lane.input = null;
      const closing = lane.pump;
      lane.query?.close?.(); lane.query = null;
      await closing?.catch(() => undefined);
      const sdk = await this.#deps.sdk();
      const rotated = await this.#rotateNow(session, repo.getAgent(agentSessionId, seatName) ?? seat, sdk, due.reason);
      this.#spawnSeat(session, rotated, lane);
      await lane.ready;
    } finally {
      const release = lane.releaseRotation;
      lane.rotationGate = null; lane.releaseRotation = null;
      if (lane.state === "rotating") lane.state = lane.query ? "live" : "parked";
      release?.();
      const stale = repo.listUnackedDeliveries(agentSessionId, seatName).filter((row) => row.status === "delivered");
      for (const row of stale) repo.patchDelivery(row.id, { status: "queued", deliveredAt: null });
      void this.#deliverConsole(agentSessionId, seatName).catch((error) => this.#recordHostFailure(agentSessionId, error));
    }
  }

  /**
   * Takes the LANE, not `lane.abort.signal`: `#parkSeat` nulls `lane.abort`
   * WITHOUT aborting, so a wait tied to the lane-wide signal would strand on
   * park/rotation/watchdog. Each ask mints its own controller.
   */
  #buildParticipantMcp(sdk: ConsoleSdk, session: AgentSessionRow, seat: AgentRow, lane: AgentLane, granted: ReadonlySet<AgentToolName>): unknown {
    const user = this.#deps.repo.getUserSession(session.userSessionId);
    const workspaceRoot = user && this.#deps.getWorkspaceRoot ? this.#deps.getWorkspaceRoot(user.workspaceId) : "";
    const tools = buildAgentTools({
      sdk, deps: this.#deps, session, agent: seat, profile: seat.profileSnapshot as AgentProfile, user, workspaceRoot,
      granted,
      legalRecipient: (candidate) => {
        const fresh = this.#deps.repo.getAgentSession(session.id) ?? session;
        const toRole = this.#routing.roleOf(session.id, candidate);
        const fromRole = this.#routing.roleOf(session.id, seat.name);
        if (toRole !== "" && candidate !== seat.name && this.#routing.contractOf(fresh).edge(fromRole, toRole)) return candidate;
        return this.#routing.escalationTarget(fresh, seat.name);
      },
      post: (input) => this.post(input),
      interceptAssignment: (input) => {
        // Route legality first, exactly as post would assert it — an illegal
        // recipient must fail NOW, not at dispatch.
        const fresh = this.#deps.repo.getAgentSession(session.id);
        if (!fresh || fresh.lifecycle !== "open") throw new ConflictError(`agent session ${session.id} is not open`);
        this.#routing.assertRoute(fresh, seat.name, input.to, input.category);
        return this.#deps.scheduler().intercept({
          agentSessionId: session.id, sender: seat.name, recipient: input.to,
          category: input.category, handoff: input.handoff,
        });
      },
      cancelAssignment: (assignmentId) =>
        this.#deps.scheduler().cancel(assignmentId, { actor: seat.name, agentSessionId: session.id }),
      askOperator: (args) => this.#askOperator(session, seat, lane, args),
      currentTurnId: () => this.#laneOf(session.id, seat.name).activeTurn?.turnId,
      markSawSend: () => { const current = this.#laneOf(session.id, seat.name); if (current.activeTurn) current.activeTurn.sawSend = true; },
      agentWorkState: (row) => this.#composer.agentWorkState(row),
      simpleHandoff: (action, status, summary, nextAction) => this.#simpleHandoff(action, status, summary, nextAction),
      dispatchWorkItems: (input) => this.dispatchWorkItems(seat.name, input),
      createChildSession: (input) => this.createSession({
        userSessionId: session.userSessionId, title: input.title,
        pattern: input.pattern as PatternId,
        ...(input.patternConfig ? { patternConfig: input.patternConfig } : {}),
        parent: { agentSessionId: session.id, controllerAgent: seat.name },
        agents: input.agents, briefing: input.briefing,
      }),
      abandonChildSession: (childAgentSessionId, reason) => this.abandonChildSession(session.id, seat.name, childAgentSessionId, reason),
    });
    // alwaysLoad: the profile already decided this agent's tools; deferring
    // them behind ToolSearch costs a round-trip rediscovering what was granted.
    return sdk.createSdkMcpServer({ name: "console_agent", version: "2", tools, alwaysLoad: true });
  }

  #snapshotProfile(profile: AgentProfile): AgentProfile {
    if (profile.source !== "workspace" || !profile.pluginPath || !profile.revision || !this.#deps.config) return profile;
    const parent = path.join(this.#deps.config.infra.dataDir, "profile-snapshots");
    const target = path.join(parent, profile.revision);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(parent, { recursive: true });
      const temp = path.join(parent, `.${profile.revision}-${newId("rnd")}`);
      try { fs.cpSync(profile.pluginPath, temp, { recursive: true, dereference: true }); fs.renameSync(temp, target); }
      catch (error) { if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true }); if (!fs.existsSync(target)) throw error; }
    }
    return { ...profile, pluginPath: target };
  }

  /**
   * A Console-authored notice draft. Every draft minted here is marked
   * `consoleSynthesized`: models never write through this path, and
   * `#statusOf` must tell a report the COORDINATOR sent from a notice the
   * Console posted in its name.
   */
  #simpleHandoff(action: string, status: HandoffDraft["core"]["status"], summary: string, nextAction: string | null): HandoffDraft {
    return { core: { schemaVersion: 1, taskId: null, status, risk: status === "failed" || status === "blocked" ? "high" : "medium",
      action, state: { summary, evidence: [] }, result: { summary: null, artifacts: [] }, uncertainty: [], nextAction,
      requestExpandedContext: status === "failed" }, extension: { kind: "generic", data: { consoleSynthesized: true } } };
  }

  /**
   * The checkpoint-and-rotate body, run by #maybeRotate under its gate after
   * the agent's process has closed. Returns the successor participant row.
   * One ungated model attempt over an always-available floor: the Console's
   * reconstruction is true by construction, so a clean model checkpoint
   * upgrades it and a bad or failed one costs nothing.
   */
  async #rotateNow(session: AgentSessionRow, seat: AgentRow, sdk: ConsoleSdk, reason: RotationReason): Promise<AgentRow> {
    const config = this.#deps.config;
    if (!config || !this.#deps.handoffs) return seat;
    const started = Date.now();
    const { draft: attempted, failure } = await this.#checkpointQuery(session, seat, sdk);
    const degraded = attempted === null;
    const draft = attempted ?? this.#composer.reconstructCheckpoint(session, seat);
    if (degraded) {
      this.#deps.bus.append({ type: "handoff.checkpoint.failed", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agent: seat.name, reason: failure ?? "checkpoint produced no valid handoff", degraded: true } });
    }
    const prepared = this.#deps.handoffs.prepare({ draft, userSessionId: session.userSessionId, agentSessionId: session.id,
      sender: seat.name, recipient: seat.name, profileId: seat.profileId, generation: seat.generation,
      extensionKind: (seat.profileSnapshot as AgentProfile).handoffExtension,
      trigger: degraded ? "recovery" : "rotation", parentHandoffId: seat.latestHandoffId, checkpoint: true });
    this.#deps.repo.insertCheckpointHandoff(prepared.row);
    this.#deps.handoffs.committed(prepared.record);
    // Rotation retires the provider session, so its cumulative baseline retires
    // with it — the successor genuinely starts from zero.
    this.#deps.repo.patchAgent(session.id, seat.name, { sdkSessionId: null, generation: seat.generation + 1, turnCount: 0, contextTokens: 0, latestHandoffId: prepared.row.id, cumulativeCostUsd: 0, cumulativeApiDurationMs: 0 });
    const fresh = this.#deps.repo.getAgent(session.id, seat.name) ?? seat;
    this.#deps.bus.append({ type: "agent_session.context.rotated", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, agent: seat.name, generation: seat.generation + 1,
        reason,
        handoffId: prepared.row.id, checkpointBytes: prepared.row.bytes, degraded } });
    this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, agent: seat.name, detail: `checkpoint ${prepared.row.id} completed in ${Date.now() - started}ms` } });
    return fresh;
  }

  /** One tool-free checkpoint query against the agent's current context. */
  async #checkpointQuery(session: AgentSessionRow, seat: AgentRow, sdk: ConsoleSdk): Promise<{ draft: HandoffDraft | null; failure: string | null }> {
    const config = this.#deps.config;
    let draft: HandoffDraft | null = null;
    let failure: string | null = null;
    if (!seat.sdkSessionId) return { draft, failure };
    const checkpointAbort = new AbortController();
    const profile = seat.profileSnapshot as AgentProfile;
    const user = this.#deps.repo.getUserSession(session.userSessionId);
    if (!user || !this.#deps.getWorkspaceRoot) return { draft, failure };
    const checkpointRoot = seat.worktreePath ?? this.#deps.getWorkspaceRoot(user.workspaceId);
    // The abort controller is useless unarmed: a provider-side outage makes the
    // CLI retry for minutes while #maybeRotate's gate blocks every sender.
    const checkpointDeadline = setTimeout(() => checkpointAbort.abort(), config.policy.checkpointTimeoutMs);
    checkpointDeadline.unref?.();
    const query = sdk.query({ prompt: `Create a lossless rotation checkpoint for your successor context. Capture only durable task state, verified evidence pointers, results, uncertainty, and the exact next action. Do not perform work or call tools.`, options: {
      cwd: checkpointRoot, systemPrompt: { type: "preset", preset: "claude_code", append: "You are checkpointing your own context. Report faithfully; do not correct or embellish uncertain state." },
      settingSources: [], includePartialMessages: false, permissionMode: "plan", allowedTools: [],
      disallowedTools: CHECKPOINT_DENIED_TOOLS,
      // MUST be object-rooted: the CLI turns this into a synthetic
      // `StructuredOutput` tool and ships it verbatim as input_schema, and the
      // API rejects anything whose root `type` is not the string "object".
      outputFormat: { type: "json_schema", schema: HANDOFF_DRAFT_JSON_SCHEMA }, maxTurns: 2,
      sandbox: { enabled: true, failIfUnavailable: profile.sandboxRequired, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
        filesystem: { allowManagedReadPathsOnly: true, allowRead: seat.worktreePath ? [checkpointRoot, this.#deps.getWorkspaceRoot(user.workspaceId)] : [checkpointRoot], allowWrite: [] } },
      env: sdkEnv(), abortController: checkpointAbort, persistSession: true, sessionStore: this.#deps.sessionStore as never,
      sessionStoreFlush: "eager", resume: seat.sdkSessionId, ...(seat.model ? { model: seat.model } : {}),
      ...((profile.effort ?? config?.infra.effort) ? { effort: (profile.effort ?? config?.infra.effort) as SdkOptions["effort"] } : {}),
    } });
    // A separate process, but `resume: seat.sdkSessionId` means it is the SAME
    // provider session — its cumulative totals continue the agent's, and its
    // baseline is the agent's. Starting from zero here would bill the whole
    // session-to-date to one checkpoint pseudo-turn.
    const cumulative = { costUsd: seat.cumulativeCostUsd, apiDurationMs: seat.cumulativeApiDurationMs };
    try {
      for await (const raw of query) for (const event of mapSdkMessage(raw)) {
        if (event.kind === "result") {
          const parsed = HandoffDraftSchema.safeParse(event.output);
          if (parsed.success) draft = parsed.data;
          this.#recordUsage(session, seat, cumulative, `checkpoint:${newId("turn")}`, event, "completed", undefined, "checkpoint");
        } else if (event.kind === "error") failure = event.message;
      }
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    finally { clearTimeout(checkpointDeadline); query.close?.(); }
    return { draft, failure };
  }

  #recordNarration(session: AgentSessionRow, participant: string, text: string, turnId: string): void {
    const seatRow = this.#deps.repo.getAgent(session.id, participant);
    const row = this.#deps.repo.appendMessage({ sessionKind: "agent", sessionId: session.id, speaker: { kind: speakerKindOf(seatRow), name: participant }, kind: "notice", text, turnId, payload: { channel: "model_output" } });
    this.#deps.bus.append({ type: "agent_session.message.appended", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { agentSessionId: session.id, message: toWireMessage(row) } });
  }

  /**
   * `cumulativeCostUsd`/`cumulativeApiDurationMs` restate the provider
   * session's running total on every result, so the per-turn figure is the
   * delta against what this lane last saw.
   */
  #recordUsage(session: AgentSessionRow, seat: AgentRow, cumulative: { costUsd: number; apiDurationMs: number }, turnId: string, usageEvent: { inputTokens?: number; uncachedInputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; outputTokens?: number; cumulativeCostUsd?: number; modelId?: string; cumulativeApiDurationMs?: number; sdkDurationMs?: number; stopReason?: string }, status: "completed" | "error" | "aborted" = "completed", durationMs?: number, trigger = "delivery"): void {
    // Errors and aborts record unconditionally — a zero-token error is still a
    // real turn. A zero-token COMPLETED result is a CLI-level artifact frame,
    // not a turn that happened; recording those would inflate turn counts.
    const empty = (usageEvent.inputTokens ?? 0) === 0 && (usageEvent.outputTokens ?? 0) === 0;
    if (empty && status === "completed") return;
    const { costUsd, apiDurationMs } = advanceUsageWatermark(cumulative, usageEvent);
    // Persist the new baseline with the agent, so the next process to resume
    // this provider session inherits it instead of restarting from zero.
    this.#deps.repo.patchAgent(session.id, seat.name, {
      cumulativeCostUsd: cumulative.costUsd, cumulativeApiDurationMs: cumulative.apiDurationMs,
    });
    const usage = { id: newId("usage"), userSessionId: session.userSessionId, agentSessionId: session.id, participant: seat.name, profileId: seat.profileId,
      generation: seat.generation, turnId, inputTokens: usageEvent.inputTokens ?? 0, uncachedInputTokens: usageEvent.uncachedInputTokens ?? 0,
      cacheCreationInputTokens: usageEvent.cacheCreationInputTokens ?? 0, cacheReadInputTokens: usageEvent.cacheReadInputTokens ?? 0,
      outputTokens: usageEvent.outputTokens ?? 0, costUsd,
      model: usageEvent.modelId ?? seat.model, effort: (seat.profileSnapshot as AgentProfile).effort ?? this.#deps.config.infra.effort ?? null,
      trigger, durationMs: durationMs ?? null, apiDurationMs, sdkDurationMs: usageEvent.sdkDurationMs ?? null, status, stopReason: usageEvent.stopReason ?? null, createdAt: nowIso() };
    this.#deps.repo.insertUsage(usage);
    this.#deps.bus.append({ type: "usage.recorded", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { userSessionId: session.userSessionId, agentSessionId: session.id, agent: seat.name, profileId: seat.profileId, generation: seat.generation, turnId,
        inputTokens: usage.inputTokens, uncachedInputTokens: usage.uncachedInputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens, outputTokens: usage.outputTokens, ...(costUsd === null ? {} : { costUsd }),
        model: usage.model ?? undefined, effort: usage.effort ?? undefined, trigger, durationMs: usage.durationMs ?? undefined,
        apiDurationMs: usage.apiDurationMs ?? undefined, sdkDurationMs: usage.sdkDurationMs ?? undefined, status, stopReason: usage.stopReason ?? undefined } });
  }

  #patchDelivery(session: AgentSessionRow, delivery: MailboxDeliveryRow, status: "queued" | "delivered" | "acknowledged" | "cancelled"): void {
    const now = nowIso();
    // `deliveredAt: now` on the acknowledged path is a FLOOR, not an
    // overwrite: repo.patchDelivery coalesces it against whatever is already
    // stored, so an ack only fills the field in when delivery never stamped it.
    this.#deps.repo.patchDelivery(delivery.id, { status, ...(status === "delivered" ? { deliveredAt: now } : {}), ...(status === "acknowledged" ? { acknowledgedAt: now, deliveredAt: now } : {}) });
    const message = this.#deps.repo.getMessageById(delivery.messageId);
    this.#deps.bus.append({ type: "agent_session.delivery.updated", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, deliveryId: delivery.id, messageSeq: message?.seq ?? 0, sender: delivery.sender, recipient: delivery.recipient, category: delivery.category, status } });
  }

  #specialists(id: string): AgentRow[] { return this.#deps.repo.listAgents(id).filter((p) => p.role !== "coordinator"); }
  #refreshStatus(agentSessionId: string): void {
    const row = this.#deps.repo.getAgentSession(agentSessionId);
    if (!row || row.lifecycle !== "open") return;
    const computed = this.#statusOf(row);
    const status = computed === "working" ? "working" : "idle";
    this.#setStatus(agentSessionId, status);
    // A child settling into `reported` may be the LAST hold on its parent's
    // withheld final — the delivery acks that gate the flip land after the
    // boundary hop itself, so this recompute is the reliable release point.
    if (computed === "reported" && row.parentAgentSessionId !== null) {
      const parent = this.#deps.repo.getAgentSession(row.parentAgentSessionId);
      if (parent && parent.lifecycle === "open") this.#maybeReleaseParentFinal(parent);
    }
    if (status === "idle") this.#dischargeOperatorDebt(row);
  }

  /**
   * An AgentSession that accepted an assignment owes the operator a reply. The
   * coordinator is asked to send it, but the obligation is the CONSOLE's.
   * Discharged from whatever evidence exists: the coordinator's last report,
   * or failing that every agent's last word. An incomplete report beats
   * silence.
   */
  #dischargeOperatorDebt(session: AgentSessionRow): void {
    if (this.#operatorDebtSettled.has(session.id)) return;
    const { repo } = this.#deps;
    if (repo.listActiveDeliveries(session.id).length > 0) return;
    const reportedToMain = repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, recipient: MAIN_RECIPIENT });
    if (reportedToMain) { this.#operatorDebtSettled.add(session.id); return; }

    const voiceSeat = this.#routing.completionAgent(session, "voice");
    const coordinator = repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, sender: voiceSeat, excludeCheckpoints: true });
    const seatReports = repo.listAgents(session.id)
      .filter((seat) => seat.name !== voiceSeat)
      .map((seat) => repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, sender: seat.name, excludeCheckpoints: true }))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
    if (!coordinator && seatReports.length === 0) return;

    this.#operatorDebtSettled.add(session.id);
    const lines = seatReports.map((row) => `- ${row.sender} (${row.core.status}): ${row.core.state.summary.slice(0, 1_500)}`);
    const summary = `This AgentSession went idle without its coordinator reporting a result, so the Console is closing the loop from the journal. Nothing below was assembled or endorsed by the coordinator.\n\n` +
      `${coordinator ? `Coordinator's last word (${coordinator.core.status}): ${coordinator.core.state.summary.slice(0, 2_000)}\n\n` : ""}` +
      `${lines.length > 0 ? `Specialist reports:\n${lines.join("\n")}` : "No specialist reported."}`;
    this.#deps.bus.append({ type: "agent_session.closeout.forced", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, agentReports: seatReports.length, hadCoordinatorReport: coordinator !== undefined } });
    try {
      this.post({ agentSessionId: session.id, speaker: { kind: speakerKindOf(repo.getAgent(session.id, voiceSeat)), name: voiceSeat }, to: MAIN_RECIPIENT,
        handoff: this.#simpleHandoff("AgentSession went idle without a final report", "needs_verification", summary,
          "Review the seat reports above and decide whether the work is complete."), category: "milestone" });
    } catch (error) { this.#recordHostFailure(session.id, error); }
  }
  /**
   * `reported` distinguishes a completed run from a dead one. A turn parked in
   * `ask_operator` does NOT count as working: the agent is waiting on a human.
   */
  statusOf(row: AgentSessionRow): AgentSessionStatus { return this.#statusOf(row); }

  #statusOf(row: AgentSessionRow): AgentSessionStatus {
    if (row.lifecycle === "archived") return "archived";
    const lanes = this.#seats.get(row.id);
    const working = [...(lanes?.values() ?? [])].some((lane) => lane.activeTurn !== null && lane.activeTurn.awaitingOperator === null);
    if (working) return "working";
    if (this.#deps.repo.listQueuedDeliveries(row.id).some((d) => d.recipient !== MAIN_RECIPIENT)) return "working";
    const reported = this.#deps.repo.latestHandoff({
      userSessionId: row.userSessionId, agentSessionId: row.id,
      recipient: MAIN_RECIPIENT, sender: this.#routing.completionAgent(row, "finalFrom"), excludeCheckpoints: true,
      // Only what the reporting agent ITSELF sent counts as having reported.
      excludeSynthetic: true,
    });
    if (reported && this.#deps.repo.listActiveDeliveries(row.id).length === 0) {
      // Bottom-up settling: a parent has not truly reported while an open
      // child still owes its final — the parent's report could not have
      // reflected work that has not concluded.
      const unsettledChild = this.#deps.repo.listChildSessions(row.id)
        .some((child) => child.lifecycle === "open" && this.#statusOf(child) !== "reported");
      return unsettledChild ? "idle" : "reported";
    }
    return "idle";
  }
  #setStatus(id: string, status: AgentSessionStatus): void {
    const session = this.#deps.repo.getAgentSession(id);
    // Every status transition may be the one that completes the run, so the
    // predicate gets a chance to look. It is debounced; this is cheap.
    if (session) this.#onStatusChanged?.(session.userSessionId);
    const last = this.#sessionStatus.get(id) ?? null;
    // New work re-opens the obligation: a session that was discharged once and
    // then given more to do owes the operator another word.
    if (status === "working") this.#operatorDebtSettled.delete(id);
    if (last === status) return;
    if (last === null && status === "idle") { this.#sessionStatus.set(id, status); return; }
    this.#sessionStatus.set(id, status);
    if (!session) return;
    this.#deps.bus.append({ type: "agent_session.status.changed", userSessionId: session.userSessionId, agentSessionId: id, payload: { agentSessionId: id, status } });
  }
  #recordHostFailure(id: string, error: unknown): void {
    const session = this.#deps.repo.getAgentSession(id); if (!session) return;
    const text = error instanceof Error ? error.message : String(error);
    this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: id, payload: { agentSessionId: id, agent: "system", detail: `scheduler failure: ${text}` } });
  }
}
