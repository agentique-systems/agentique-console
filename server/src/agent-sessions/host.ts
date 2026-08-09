import type { AgentSessionStatus, HandoffDraft, HandoffTrigger, Interaction, InteractionQuestion, InteractionUrgency, ResolveInteractionBody, Speaker } from "@agentique-console/shared";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../api/errors.ts";
import type { AgentProfile, AgentProfileRegistry } from "../agent-profiles/registry.ts";
import type { Config } from "../config.ts";
import {
  Repo,
  toWireAgentSession,
  toWireMessage,
  type AgentSessionRow,
  type AttemptGroupRow,
  type MailboxDeliveryRow,
  type MessageRow,
  type ParticipantRow,
} from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { RuntimeBroadcaster } from "../events/runtime.ts";
import { newId, nowIso } from "../ids.ts";
import { rotationTokenLimit } from "../model-catalog.ts";
import { pageTail } from "../paging.ts";
import { mapSdkMessage } from "../sdk/mapping.ts";
import type { SqliteSessionStore } from "../sdk/session-store.ts";
import type { ConsoleSdk, QueryHandle, SdkHooksFragment, SdkOptions, SdkToolResult, SdkUserMessageLike } from "../sdk/types.ts";
import { sdkEnv } from "../sdk/env.ts";
import type { ProcessManager } from "../runtime/process-manager.ts";
import type { BrowserManager } from "../runtime/browser-manager.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import { renderDecision, type DecisionLedger } from "../orchestrator/decisions.ts";
import type { ContractService } from "../contracts/service.ts";
import { buildContractHooks } from "./contract-hook.ts";
import { dedupeKeyFor, type InteractionService } from "../orchestrator/interactions.ts";
import type { TaskService } from "../tasks/service.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { EvidenceRefSchema, HANDOFF_DRAFT_JSON_SCHEMA, HandoffCoreSchema, HandoffDraftSchema } from "../handoffs/schema.ts";
import { classifyUncertainty, type EscalationCategory, type EscalationItem } from "../handoffs/escalation.ts";
import type { ReapResult } from "../completion/summary.ts";
import { evaluateCheckpointDraft } from "../handoffs/checkpoint-gate.ts";
import { mainPeerName, peerNameOf } from "./peer-names.ts";
import { buildWorktreeHooks } from "./worktree-hook.ts";
import { consoleTaskListId } from "../orchestrator/tools.ts";
import { SESSION_PROTOCOL } from "./presets.ts";
import { mergeHooks } from "../sdk/hooks.ts";
import { AsyncQueue } from "../async-queue.ts";

export const ORCHESTRATOR_SEAT = "orchestrator";
export const MAIN_RECIPIENT = "main";
const SEAT_NAME_RE = /^[A-Za-z0-9_.:-]+$/;
const RESERVED_NAMES = new Set([ORCHESTRATOR_SEAT, "operator", "system", MAIN_RECIPIENT, "coordinator"]);
const MATERIAL_CATEGORIES = new Set(["milestone", "failure", "final", "decision"]);

/**
 * Watchdog thresholds: a seat repeating the identical tool call, or piling up
 * consecutive tool errors, is burning its maxTurns allowance without
 * progress. Conservative on purpose — legitimate retries reset the counters
 * on any different call or any success.
 */
const WATCHDOG_IDENTICAL_CALLS = 5;
const WATCHDOG_ERROR_STREAK = 10;
/** Rotation blocks every sender to the seat; a checkpoint may not run forever. */
const CHECKPOINT_TIMEOUT_MS = 90_000;

/**
 * Provider ceiling for an inline base64 image (~5MB). A full-page screenshot at
 * a large viewport can exceed it, and an oversize image fails the whole tool
 * result rather than degrading — so `read_artifact` returns a text explanation
 * instead, which the seat can act on.
 */
const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024;

/**
 * Unresolved blocking questions allowed per AgentSession before further asks
 * are downgraded to deferred. A wall of simultaneous cards is unanswerable, and
 * each blocking ask pins one of `seatMaxResidentPerSession` (4) processes.
 */
const MAX_CONCURRENT_BLOCKING_ASKS = 3;

/** Per-turn cap on stored reasoning; it is forensics, not an archive. */
const MAX_REASONING_CHARS = 64 * 1024;

interface AskOperatorArgs {
  question: string;
  header?: string;
  context?: string;
  options: { label: string; description?: string }[];
  recommendation?: string;
  urgency: InteractionUrgency;
  allowFreeText: boolean;
}

/** Failed-turn redeliveries per delivery row before the console gives up. */
const MAX_REDELIVERY_ATTEMPTS = 2;

/**
 * Built-in tools a profile may grant. Anything here that a profile does NOT
 * list is explicitly denied, which is what makes `profile.tools` a real
 * boundary rather than an auto-approval hint. Harness conveniences a governed
 * seat should never reach (subagent spawning, scheduling, its own review
 * tooling) are denied unconditionally alongside these.
 */
const GOVERNED_BUILTIN_TOOLS = [
  "Bash", "Edit", "Write", "NotebookEdit", "Read", "Glob", "Grep",
  "WebFetch", "WebSearch",
] as const;

/** Rotation-recovery prefix, applied at most once (it used to accrete). */
const RECOVERY_PREFIX = "Recovery checkpoint: ";
function recoveryAction(action: string): string {
  return action.startsWith(RECOVERY_PREFIX) ? action : `${RECOVERY_PREFIX}${action}`;
}

/**
 * A provider-side 4xx means the request was malformed by US and never reached
 * the model — categorically different from a model that produced nothing.
 */
/**
 * The request never reached the model, so nothing about the seat's context is
 * suspect. Broadened beyond 4xx: a DNS or connection error is even more
 * clearly transport, and db-live-2's three destroyed turns were all
 * `getaddrinfo ENOTIMP api.anthropic.com`.
 */
function isTransportFailure(failure: string | null): boolean {
  if (failure === null) return false;
  return /API Error: 4\d\d/.test(failure)
    || /\b(ENOTIMP|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/.test(failure)
    || /Connection error|Unable to connect to API/i.test(failure);
}

/** Seat names may contain chars git refs forbid; branch components drop them. */
function branchSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** JSON with recursively sorted object keys — a stable identity for tool inputs. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}

/**
 * What this seat can actually do, stated up front.
 *
 * Every capability limit in db-live-1 was discovered mid-run at high cost:
 * renderer spent a 595s turn learning the sandbox has no outbound network,
 * `check` spent four tool searches learning it had no keyboard primitive, and
 * both hunted the filesystem for artifacts that live in SQLite. None of that
 * is discoverable from inside; all of it is known here at spawn.
 */
/**
 * Sandbox network policy for a seat. `allowLocalBinding` is unconditional: a
 * seat must be able to reach a server it started itself, and in db-live-1
 * `check` could not — it got ECONNREFUSED on its own dev server and had to
 * report the traversal and error branches as unverified.
 */
function sandboxNetwork(profile: AgentProfile, workspaceDomains: string[]): { allowedDomains: string[]; allowLocalBinding: true; strictAllowlist: true } {
  const configured = profile.runtime.network;
  return {
    allowedDomains: configured === "default" ? workspaceDomains : configured,
    allowLocalBinding: true,
    strictAllowlist: true,
  };
}

function resolvedDomains(profile: AgentProfile, workspaceDomains: string[]): string[] {
  return profile.runtime.network === "default" ? workspaceDomains : profile.runtime.network;
}

function capabilityBrief(profile: AgentProfile, hasWorktree: boolean, workspaceDomains: string[]): string {
  const can: string[] = [];
  const cannot: string[] = [];
  if (profile.runtime.shell) can.push("run processes (process_start/read/stop) and Bash inside a sandbox");
  else cannot.push("run any process or shell command");
  if (profile.runtime.browser) {
    can.push("drive a real local Chrome: open, click, fill, press keys, evaluate JS, read the console");
    if (profile.runtime.screenshots) can.push("capture screenshots as durable artifacts (read them back with read_artifact)");
    else cannot.push("take screenshots");
  } else cannot.push("open a browser");
  const domains = resolvedDomains(profile, workspaceDomains);
  // The truth, which the old line got backwards. Managed children run in the
  // host network namespace; a seat's Bash runs inside the SDK sandbox's own.
  // They share no loopback, so `curl http://localhost:PORT` from Bash cannot
  // see a server `process_start` launched — while the browser (also host
  // namespace) can. db-live-2's renderer burned three failed curls working
  // this out for itself, and the same asymmetry is what made a live port look
  // simultaneously occupied and free, which is where the whole "stale server"
  // investigation came from.
  if (profile.runtime.shell) {
    can.push(
      "start servers with process_start and reach them from the browser tools and from other process_start children" +
      (profile.runtime.browser
        ? " — verify one with http_probe, browser_open or process_read, never with curl from Bash: Bash runs in a different network namespace and cannot see them"
        : " — check one with http_probe or process_read, not with curl from Bash: Bash runs in a different network namespace and cannot see them"),
    );
  }
  if (domains.length === 0) {
    cannot.push("reach any outbound host. Anything fetched from a CDN or registry at runtime will fail; vendor it locally or verify without it");
  } else {
    can.push(`reach these hosts and no others: ${domains.join(", ")}. A fetch outside that list fails — say so rather than working around it`);
  }
  cannot.push("read outside the paths below, or write outside your own working copy");
  return `## Your capabilities\nYou can: ${can.join("; ") || "read files only"}.\nYou cannot: ${cannot.join("; ")}.\n` +
    `${hasWorktree ? "Your cwd is an isolated worktree; teammates and the coordinator cannot see your files until the Console merges them when you report completed.\n" : ""}` +
    `If an assignment needs something in the "cannot" list, say so immediately in a handoff rather than working around it — the limit is real and will not change mid-run.`;
}

/**
 * `name@semver` pins introduced by a diff's added lines. Deliberately
 * syntax-agnostic: one pattern covers npm specifiers, CDN URLs and import-map
 * entries without parsing any of them. It does not see `"pkg": "1.2.3"`
 * object form — two seats editing the same manifest collide in git anyway.
 */
export function dependencyPinsInPatch(patch: string): { name: string; version: string }[] {
  const pins: { name: string; version: string }[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const match of line.matchAll(/(?:^|[/"'\s@])([a-z][a-z0-9._-]{1,40})@(\d+\.\d+\.\d+)/gi)) {
      pins.push({ name: (match[1] as string).toLowerCase(), version: match[2] as string });
    }
  }
  return pins;
}

/** Compact capability tag for roster lines — what this seat can be asked to do. */
function capabilityTag(profile: AgentProfile): string {
  const caps = [
    ...(profile.tools.includes("Edit") || profile.tools.includes("Write") ? ["writes files"] : ["read-only"]),
    ...(profile.runtime.shell ? ["runs processes"] : []),
    ...(profile.runtime.browser ? [profile.runtime.screenshots ? "browser+keyboard+screenshots" : "browser+keyboard"] : []),
  ];
  return `can: ${caps.join(", ")}`;
}

/** Console-synthesized lane input: neither human nor peer, so no origin. */
function seatUserMessage(text: string): SdkUserMessageLike {
  return { type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, shouldQuery: true };
}

/**
 * The seat's messaging documentation. Short by construction: there is one way
 * to transfer, its fields are typed, and nothing has to be serialized by hand.
 * The predecessor to this brief had to teach a JSON envelope by example and
 * still cost 5-9 rejections per seat before the first message landed.
 */
function seatMessagingBrief(roster: string, seatName: string): string {
  return `Communication: your plain text output reaches no one. To transfer anything — an assignment, progress, findings, a failure, a final result — call send_handoff. Its fields are typed; there is no JSON to write or escape. Participants: ${roster}. ` +
    `Address participants by bare name (e.g. "orchestrator"); "main" reaches the Orchestrator. ` +
    `${seatName === ORCHESTRATOR_SEAT ? "You may address your specialists and main." : "You may address only orchestrator."} ` +
    `The Human Operator is reachable separately and directly with ask_operator — that path does not go through anyone. ` +
    `Put the substance in stateSummary — the findings themselves, not a description of having found them — and say what you could not verify in uncertainty. ` +
    `Size is not a constraint on truth: if the substance is long, put it in write_note and reference the artifact. Never shorten a finding to fit. ` +
    `If send_handoff ever rejects your input as unparseable, do NOT retry the same payload — move the body into write_note and re-send with the reference. ` +
    `Never use the Agent or SendMessage tools.`;
}

type Category = MailboxDeliveryRow["category"];

/**
 * A seat's persistent peer session. One streaming-input query per live seat;
 * the process registers the seat's peer name and binds its inbox socket, so a
 * seat is natively addressable exactly while its lane is live. Parked lanes
 * keep only the resume handle — the journal owns anything undelivered.
 */
interface SeatLane {
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
    trigger: "delivery" | "peer" | "steer";
    deliveries: MailboxDeliveryRow[];
    sawSend: boolean;
    toolStarts: Map<string, number>;
    /**
     * The seat's most recent narration. Harvested into the synthetic failure
     * handoff when a turn dies: in db-live-1 `check` had finished its review
     * and could only print it, so the interrupt destroyed the run's best output.
     */
    lastNarration: string;
    watchdog: { lastKey: string; identical: number; errorStreak: number; tripped: string | null };
    /**
     * Set while this turn is parked inside `ask_operator` waiting for a human.
     * A blocking ask holds `activeTurn`, so without this the seat looks busy
     * forever: the idle timer never arms, capacity eviction skips it, and one
     * resident CLI process is pinned until the operator happens to answer.
     * Its own controller, so the wait can be cut without killing the lane.
     */
    awaitingOperator: { interactionId: string; since: number; abort: AbortController } | null;
    /** Cumulative provider back-off this turn; the budget is wall clock, not attempts. */
    retryMs: number;
    /** Reasoning text, accumulated only when persistence is enabled. */
    reasoning: string;
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
  lastActiveAt: number;
  lastStatus: "working" | "idle" | null;
}

export interface CreateAgentSessionInput {
  userSessionId: string;
  title: string;
  mode: "execute" | "plan_execute";
  agents: { name: string; profileId?: string; preset?: string; instructions?: string; model?: string; owns?: string[] }[];
  briefing?: HandoffDraft;
}

export interface AgentSessionHostDeps {
  repo: Repo;
  bus: EventBus;
  config?: Config;
  profiles?: AgentProfileRegistry;
  sdk?: () => Promise<ConsoleSdk>;
  sessionStore?: SqliteSessionStore;
  getWorkspaceRoot?: (workspaceId: string) => string;
  wake?: (userSessionId: string, agentSessionId: string, category: Category, text: string) => void;
  processes?: ProcessManager;
  browsers?: BrowserManager;
  interactions: InteractionService;
  /**
   * What the operator has decided. Read into every seat's prompt and into
   * checkpoint reconstruction, so a decision made once is known by every seat
   * and every later generation. Required, like `interactions` and `contracts`:
   * optional feature deps let a missing wire typecheck, which is how the
   * decision ledger shipped dark in production.
   */
  decisions: DecisionLedger;
  /** Shared-interface contracts; writes to their scopes gate on acceptance. */
  contracts: ContractService;
  tasks?: TaskService;
  handoffs?: HandoffService;
  worktrees?: WorktreeManager;
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

function ok(value: unknown): SdkToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Questions on one auto-promoted card before the rest spill into context. */
const MAX_QUESTIONS_PER_CARD = 4;

/** Capability shape for a sender the console has no profile for (main). */
const FALLBACK_PROFILE_RUNTIME = { runtime: { shell: false, browser: false, screenshots: false, network: [] as string[] } } as AgentProfile;

const ESCALATION_HEADER: Record<EscalationCategory, string> = {
  version_substitution: "Version",
  spec_deviation: "Deviation",
  capability_gap: "Blocked",
  unverifiable_claim: "Unverified",
  ambiguity: "Ambiguous",
  volume: "Open items",
};

/** Stable question text, so a re-reported uncertainty is recognisably the same. */
function uncertaintyQuestion(item: EscalationItem): string {
  if (item.category === "version_substitution" && item.versions) {
    return `${item.versions.dependency}: ship ${item.versions.shipped}, or hold for ${item.versions.expected}?`;
  }
  return item.text;
}

/**
 * The card block for one escalated uncertainty.
 *
 * For `version_substitution` the console genuinely knows both versions, so it
 * offers REAL choices. For every other category it does not know the domain,
 * so it poses the meta-decision it CAN pose correctly and puts the seat's own
 * words in `context` verbatim.
 *
 * Deliberately never fabricates domain-specific labels. It would be wrong often
 * enough that the operator would click through them, and a wrong answer
 * laundered through the decision ledger is worse than no card at all.
 */
function uncertaintyBlock(item: EscalationItem, spilled: readonly EscalationItem[] = []): InteractionQuestion {
  const extra = spilled.length === 0 ? "" : `\n\nAlso open from this seat:\n${spilled.map((other) => `- ${other.text}`).join("\n")}`;
  if (item.category === "version_substitution" && item.versions) {
    const { dependency, shipped, expected } = item.versions;
    return {
      question: uncertaintyQuestion(item),
      header: ESCALATION_HEADER[item.category],
      context: `${item.text}${extra}`,
      options: [
        { label: `Ship ${shipped}`, description: `Keep what is built. ${dependency} stays at ${shipped}.` },
        { label: `Hold for ${expected}`, description: `The version named earlier. May not be reachable right now.` },
      ],
    };
  }
  return {
    question: uncertaintyQuestion(item),
    header: ESCALATION_HEADER[item.category],
    context: `Raised as an uncertainty by the agent that reported it:\n${item.text}${extra}`,
    options: [
      { label: "Proceed anyway", description: "Accept this and keep going." },
      { label: "Stop and fix this first", description: "Treat it as blocking; the work is not done until it is resolved." },
      { label: "I'll answer in chat", description: "Neither option fits — say what you want in your own words." },
    ],
  };
}

/** The question text of an interaction, for prompts and operator-facing lines. */
function questionTextOf(interaction: Interaction): string {
  const questions = (interaction.payload as { questions?: InteractionQuestion[] }).questions ?? [];
  return questions.map((question) => question.question).join(" | ");
}

/** "What was asked → what the operator said", rendered once for every consumer. */
function summarizeAnswer(interaction: Interaction): string {
  const asked = questionTextOf(interaction);
  const response = (interaction.response ?? {}) as { answers?: Record<string, string[]>; freeText?: Record<string, string>; note?: string };
  const chosen = Object.values(response.answers ?? {}).flat().join(", ");
  const free = Object.values(response.freeText ?? {}).join(" ");
  const parts = [chosen, free, response.note].filter((part) => part !== undefined && part !== "");
  if (asked === "" && parts.length === 0) return "";
  return `${asked} → ${parts.join(" · ") || "(no answer recorded)"}${interaction.autoTaken ? " [auto-taken on timeout, not chosen by the operator]" : ""}`;
}

/** Console-managed, independently resumable participant sessions and durable mailbox. */
export class AgentSessionHost {
  readonly #deps: AgentSessionHostDeps;
  /** agentSessionId → seat name → its persistent lane. */
  readonly #seats = new Map<string, Map<string, SeatLane>>();
  /** Idempotency for peer-carry retries: send fingerprint → delivery id. */
  readonly #recentPeerSends = new Map<string, { deliveryId: string; at: number }>();
  /** Waiters for a resident-capacity slot, resolved oldest-first on park/close. */
  readonly #capacityWaiters: (() => void)[] = [];
  /** Timer releasing `ask_operator` waits the operator has not returned to. */
  #askSweep: ReturnType<typeof setInterval> | null = null;
  /** Notified when a session's derived status changes; completion re-evaluates. */
  #onStatusChanged: ((userSessionId: string) => void) | undefined;
  /** Sessions whose `final` the gate withheld, so clearing it can say so. */
  readonly #withheldFinals = new Set<string>();
  /** deliveryId → assignment held until its blocker task completes. */
  readonly #blockedAssignments = new Map<string, { agentSessionId: string; recipient: string; since: number }>();

  constructor(deps: AgentSessionHostDeps) { this.#deps = deps; }

  createSession(input: CreateAgentSessionInput): { agentSessionId: string; participants: string[] } {
    const { repo, bus } = this.#deps;
    const user = repo.getUserSession(input.userSessionId);
    if (!user) throw notFound(`no user session ${input.userSessionId}`);
    if (input.agents.length < 1 || input.agents.length > 20) throw badRequest("an agent session seats 1 to 20 specialists");
    const names = new Set<string>();
    for (const agent of input.agents) {
      if (!SEAT_NAME_RE.test(agent.name) || RESERVED_NAMES.has(agent.name.toLowerCase())) throw badRequest(`invalid or reserved seat name \"${agent.name}\"`);
      if (names.has(agent.name)) throw badRequest(`duplicate seat name \"${agent.name}\"`);
      names.add(agent.name);
    }
    // Ownership is mandatory for a seat that WRITES, and optional for one that
    // does not. The old `owns: min(1)` schema forced db-live-2's visual-reviewer
    // to pass the sentence "verification report and screenshot (no source
    // files)" as an ownership scope — a string that is not a path, in a map
    // that holds paths, on a seat the disjointness check below then skipped
    // anyway.
    //
    // Deliberately NOT symmetric: a read-only seat may still declare a scope,
    // because `owns` doubles as the assignment/review boundary for seats that
    // never write. Forbidding that would break a legitimate use to fix a
    // problem nobody had.
    for (const agent of input.agents) {
      const profile = this.#profile(agent.profileId ?? agent.preset ?? "explorer", user.workspaceId);
      const writes = profile.tools.includes("Edit") || profile.tools.includes("Write");
      if (writes && (agent.owns ?? []).filter((scope) => scope.trim() !== "").length === 0) {
        throw badRequest(`seat "${agent.name}" (${profile.id}) writes files, so it must declare what it owns`);
      }
    }
    const ownedScopes = new Map<string, string>();
    for (const agent of input.agents) {
      const profileId = agent.profileId ?? agent.preset ?? "explorer";
      if (profileId.includes("reviewer")) continue;
      for (const scope of agent.owns ?? []) {
        const normalized = scope.trim(); if (!normalized) continue;
        const owner = ownedScopes.get(normalized);
        if (owner) throw badRequest(`ownership scope \"${normalized}\" is assigned to both ${owner} and ${agent.name}`);
        ownedScopes.set(normalized, agent.name);
      }
    }
    // Isolation needs a repository. Done here, at session creation, rather
    // than lazily at seat spawn: the operator initiated this moment and can be
    // told about it once, instead of discovering a `.git` appearing later.
    this.#ensureWorkspaceRepo(user.workspaceId, input.userSessionId);
    const title = input.title.trim();
    if (!title) throw badRequest("a session title is required");
    const parent = repo.getUserSession(input.userSessionId);
    if (!parent) throw badRequest("unknown user session");
    const now = nowIso();
    const row: AgentSessionRow = {
      id: newId("as"), userSessionId: input.userSessionId, title, mode: input.mode,
      phase: "executing", status: "open", createdAt: now, updatedAt: now,
    };
    repo.insertAgentSession(row);
    const coordinator = this.#snapshotProfile(this.#profile("coordinator", parent.workspaceId));
    repo.insertParticipant(this.#participant(row.id, ORCHESTRATOR_SEAT, "orchestrator", coordinator, "", undefined, [], 0, now));
    input.agents.forEach((agent, index) => {
      const profile = this.#snapshotProfile(this.#profile(agent.profileId ?? agent.preset ?? "explorer", parent.workspaceId));
      repo.insertParticipant(this.#participant(row.id, agent.name, "agent", profile, agent.instructions ?? "", agent.model, agent.owns ?? [], index + 1, now));
    });
    const specialists = input.agents.map((agent) => agent.name);
    bus.append({ type: "agent_session.created", userSessionId: row.userSessionId, agentSessionId: row.id,
      payload: { session: toWireAgentSession(row, specialists, false), participants: specialists } });
    bus.append({ type: "flow.delegation", userSessionId: row.userSessionId, agentSessionId: row.id,
      payload: { userSessionId: row.userSessionId, agentSessionId: row.id, kind: "created", preview: title } });
    if (input.briefing) this.post({ agentSessionId: row.id, speaker: { kind: "orchestrator", name: MAIN_RECIPIENT }, to: ORCHESTRATOR_SEAT, handoff: input.briefing, category: "assignment" });
    return { agentSessionId: row.id, participants: specialists };
  }

  /**
   * Best-of-N fan-out: seats N attempt copies of one profile, each in an
   * isolated worktree, and posts them the same assignment. Seat identity,
   * worktree binding, and group metadata are server-authored; attempts share
   * scope intentionally — the isolation is the worktree, not the scope.
   */
  startAttempts(input: { agentSessionId: string; assignment: HandoffDraft; profileId?: string; attempts?: number; baseSeatName?: string; owns: string[]; instructions?: string; model?: string; turnId?: string }): { groupId: string; seats: string[]; branches: string[]; baseCommit: string; dirtyWorkspace: boolean } {
    const { repo, bus } = this.#deps;
    const worktrees = this.#deps.worktrees;
    if (!worktrees) throw new Error("worktree manager unavailable");
    const session = repo.getAgentSession(input.agentSessionId);
    if (!session) throw notFound(`no agent session ${input.agentSessionId}`);
    if (session.status !== "open") throw conflict(`agent session ${input.agentSessionId} is archived`);
    const user = repo.getUserSession(session.userSessionId);
    if (!user || !this.#deps.getWorkspaceRoot) throw new Error("workspace unavailable");
    const workspaceRoot = this.#deps.getWorkspaceRoot(user.workspaceId);
    if (!worktrees.isGitRepo(workspaceRoot)) {
      throw badRequest(`best-of-N attempts require the workspace to be a git repository; ${workspaceRoot} is not one (git init it or run the work as a single assignment)`);
    }
    if (repo.findOpenAttemptGroup(session.id)) throw conflict("an attempt group is already active for this session; wait for it to finish");
    const attempts = Math.max(2, Math.min(3, input.attempts ?? 2));
    const base = (input.baseSeatName ?? input.profileId ?? "implementer").trim();
    if (!SEAT_NAME_RE.test(base) || RESERVED_NAMES.has(base.toLowerCase())) throw badRequest(`invalid or reserved attempt base name "${base}"`);
    const existing = new Set(repo.listParticipants(session.id).map((p) => p.name));
    const seatNames = Array.from({ length: attempts }, (_, i) => `${base}.${i + 1}`);
    for (const name of [...seatNames, `${base}.review`]) if (existing.has(name)) throw conflict(`seat name "${name}" is already taken`);
    const profile = this.#snapshotProfile(this.#profile(input.profileId ?? "implementer", user.workspaceId));
    const groupId = newId("bon");
    const dirtyWorkspace = worktrees.isDirty(workspaceRoot);
    const now = nowIso();
    const attemptsState: NonNullable<AttemptGroupRow["attemptsState"]> = {};
    const branches: string[] = [];
    let baseCommit = "";
    const attemptInstructions = `${input.instructions ?? ""}\n\nYou are attempt seat of a best-of-N group: work independently in your own isolated worktree (your cwd). Never run git commit — the Console captures your changes when you report. Install dependencies only if you must run validation.`.trim();
    for (let i = 0; i < attempts; i += 1) {
      const ref = worktrees.addWorktree(workspaceRoot, session.id, `${groupId}-${i + 1}`, `attempt/${session.id}/${groupId}/${i + 1}`);
      baseCommit = ref.baseCommit;
      branches.push(ref.branch);
      const row = this.#participant(session.id, seatNames[i]!, "agent", profile, attemptInstructions, input.model, input.owns, existing.size + i, now);
      repo.insertParticipant({ ...row, worktreePath: ref.path, worktreeBaseCommit: ref.baseCommit, worktreeBranch: ref.branch, attemptGroupId: groupId, attemptRole: "attempt" });
      attemptsState[seatNames[i]!] = { branch: ref.branch, worktreePath: ref.path, commit: null, artifactId: null, status: "running" };
    }
    repo.insertAttemptGroup({ id: groupId, agentSessionId: session.id, userSessionId: session.userSessionId,
      profileId: profile.id, baseSeat: base, attempts, baseCommit, status: "running", reviewerSeat: null,
      winnerSeat: null, mergeCommit: null, dirtyWorkspace, attemptsState, createdAt: now, updatedAt: now });
    bus.append({ type: "agent_session.attempt_group.started", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, groupId, seats: seatNames, profileId: profile.id, attempts, baseCommit, dirtyWorkspace } });
    for (const name of seatNames) {
      this.post({ agentSessionId: session.id, speaker: { kind: "orchestrator", name: ORCHESTRATOR_SEAT }, to: name,
        handoff: input.assignment, category: "assignment", dedupeKey: `bon:${groupId}:${name}`, ...(input.turnId ? { turnId: input.turnId } : {}) });
    }
    return { groupId, seats: seatNames, branches, baseCommit, dirtyWorkspace };
  }

  /**
   * The reviewer's single selection call. Merge runs synchronously so the
   * returned outcome is ground truth for the reviewer's closing handoff; a
   * conflict aborts cleanly (workspace untouched) and fails the group.
   */
  selectAttemptWinner(input: { agentSessionId: string; groupId: string; reviewer: string; winner?: string; rejectAll?: boolean; reason: string }):
    { merged: true; commit: string; winner: string } | { merged: false; conflicts: string[]; detail: string; winner: string } | { rejected: true } {
    const { repo, bus } = this.#deps;
    const worktrees = this.#deps.worktrees;
    if (!worktrees) throw new Error("worktree manager unavailable");
    const session = repo.getAgentSession(input.agentSessionId);
    if (!session) throw notFound(`no agent session ${input.agentSessionId}`);
    const group = repo.getAttemptGroup(input.groupId);
    if (!group || group.agentSessionId !== session.id) throw notFound(`no attempt group ${input.groupId}`);
    if (group.status !== "reviewing") throw conflict(`attempt group ${input.groupId} is ${group.status}; selection is closed`);
    if (group.reviewerSeat !== input.reviewer) throw badRequest(`only ${group.reviewerSeat} may select for group ${input.groupId}`);
    if ((input.winner === undefined) === (input.rejectAll !== true)) throw badRequest("pass exactly one of winner or rejectAll");
    const user = repo.getUserSession(session.userSessionId);
    if (!user || !this.#deps.getWorkspaceRoot) throw new Error("workspace unavailable");
    const workspaceRoot = this.#deps.getWorkspaceRoot(user.workspaceId);
    if (input.rejectAll === true) {
      bus.append({ type: "agent_session.attempt_group.selected", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, groupId: group.id, winner: null, rejectedAll: true, reason: input.reason } });
      this.#closeAttemptGroup(session, group, "rejected");
      return { rejected: true };
    }
    const winner = input.winner!;
    const entry = group.attemptsState[winner];
    if (!entry || entry.status !== "completed") throw badRequest(`"${winner}" is not a completed attempt of group ${input.groupId}`);
    bus.append({ type: "agent_session.attempt_group.selected", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, groupId: group.id, winner, rejectedAll: false, reason: input.reason } });
    const outcome = worktrees.mergeBranch(workspaceRoot, entry.branch,
      `Merge best-of-N winner ${winner} (group ${group.id})\n\nAttempt-Group: ${group.id}\nAttempt-Seat: ${winner}`);
    if (outcome.merged) {
      repo.patchAttemptGroup(group.id, { winnerSeat: winner, mergeCommit: outcome.commit });
      bus.append({ type: "agent_session.attempt_group.merged", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, groupId: group.id, winner, mergeCommit: outcome.commit } });
      this.#closeAttemptGroup(session, { ...group, winnerSeat: winner }, "merged");
      return { merged: true, commit: outcome.commit, winner };
    }
    bus.append({ type: "agent_session.attempt_group.merge_failed", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, groupId: group.id, winner, conflicts: outcome.conflicts, detail: outcome.detail } });
    this.#closeAttemptGroup(session, group, "failed");
    return { merged: false, conflicts: outcome.conflicts, detail: outcome.detail, winner };
  }

  /**
   * Console-path send: journal, then deliver by pushing into the recipient's
   * lane input. Used by briefings, best-of-N fan-out, failure notices, and
   * redelivery — the model-to-model path is native SendMessage governed by
   * the middleware, which shares #journal via the SendGovernor surface.
   */
  post(input: { agentSessionId: string; speaker: Speaker; to: string; handoff: HandoffDraft; category?: Category; dedupeKey?: string; turnId?: string }): MessageRow {
    const { repo } = this.#deps;
    const session = repo.getAgentSession(input.agentSessionId);
    if (!session) throw notFound(`no agent session ${input.agentSessionId}`);
    if (session.status !== "open") throw conflict(`agent session ${input.agentSessionId} is archived`);
    this.#assertRoute(session.id, input.speaker.name, input.to);
    const category = input.category ?? "update";
    if (input.dedupeKey) {
      const prior = repo.findDeliveryByDedupe(session.id, input.speaker.name, input.to, input.dedupeKey);
      const priorMessage = prior ? repo.getMessageById(prior.messageId) : undefined;
      if (priorMessage) return priorMessage;
    }
    // Promotion runs BEFORE the gate reads the open cards, so an uncertainty
    // this very handoff raised can withhold this very final. That ordering is
    // the whole point on a `final`: db-live-2's report and the question about
    // its open items were eleven seconds apart, in the wrong order.
    this.#promoteUncertainty(session, input.speaker.name, input.handoff, category);
    // Withheld BEFORE journalling, so a blocked final leaves no half-record.
    //
    // A `final` attempt promotes every DEFERRED question first. Deferred means
    // "I can keep working while this is open" — and at final time there is no
    // more work, so the judgement that made it non-gating has expired. This is
    // the precise shape of db-live-2's ending: a question the coordinator
    // thought was minor, asked eleven seconds after it declared the run done.
    const promoted = this.#isFinalToMain(input.speaker.name, input.to, category)
      ? this.#deps.interactions.promoteDeferredToBlocking(session.id)
      : 0;
    const blockers = this.#finalReportBlockers(session, input.speaker.name, input.to, category);
    if (blockers.length > 0) {
      this.#withheldFinals.add(session.id);
      this.#deps.bus.append({ type: "handoff.final.blocked", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, sender: input.speaker.name, interactionIds: blockers.map((row) => row.id) } });
      const now = Date.now();
      const listed = blockers.map((row) => {
        const age = Math.max(0, Math.round((now - Date.parse(row.createdAt)) / 60_000));
        return `[${row.id}] "${questionTextOf(row)}" (asked ${age}m ago by ${row.participant ?? "main"})`;
      }).join("; ");
      throw conflict(
        `final report withheld: ${blockers.length} question(s) this session put to the operator ${blockers.length === 1 ? "is" : "are"} still unanswered — ${listed}. ` +
        `${promoted > 0 ? `${promoted} question(s) you had marked deferred are now blocking: at final time there is no "later" left to answer them in. ` : ""}` +
        `Those cards are on the operator's screen now; you cannot answer them and neither can main. ` +
        `Do NOT retry this final — an identical retry trips the repeat-call watchdog and kills your turn. ` +
        `Either continue other work, or send category:"milestone" with what you have. ` +
        `When the operator answers, the Console delivers their answer to you and you may report final then.`,
      );
    }
    const caveats = this.#finalReportCaveats(session, input.speaker.name, input.to, category);
    if (caveats.length > 0) {
      input = { ...input, handoff: { ...input.handoff, core: { ...input.handoff.core,
        uncertainty: [...input.handoff.core.uncertainty, `Console: reported final with work outstanding — ${caveats.join("; ")}.`] } } };
      this.#deps.bus.append({ type: "handoff.final.caveats", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, sender: input.speaker.name, caveats } });
    }
    // The ledger follows the journal, rather than waiting for a coordinator to
    // remember. In db-live-2 every transition lagged reality by 5-11 minutes:
    // unit 1 was marked complete 10m17s after implementation finished, unit 2
    // went in_progress 11m16s after the file was written, and the lag mapped
    // exactly onto coordinator turns that were dead or asleep.
    this.#syncLedgerFromHandoff(session, input.to, input.handoff, category);
    const { message, delivery, text } = this.#journal(session, input.speaker, input.to, input.handoff, category, {
      transport: "console", ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}), ...(input.turnId ? { turnId: input.turnId } : {}),
    });
    if (input.to === MAIN_RECIPIENT) {
      this.#patchDelivery(session, delivery, "acknowledged");
      if (MATERIAL_CATEGORIES.has(category)) {
        // Answered operator questions ride along with the next material wake.
        // This used to be an in-memory `#deferredDecisions` map, which meant a
        // non-blocking decision was silently DROPPED whenever no further
        // material report happened to arrive — and lost outright on restart.
        // The rows are durable now, so the worst case is a late telling rather
        // than none. Not marked flushed here: `flushed_at` means the ASKING
        // SEAT has been told, and main is not the asker.
        const answered = this.#deps.interactions.listAnsweredUnflushed(session.id);
        const decisions = answered.map((row) => summarizeAnswer(row)).filter((line) => line !== "");
        const wakeText = decisions.length === 0 ? text
          : `${text}\n\nOperator decisions answered since your last update:\n${decisions.map((line, index) => `${index + 1}. ${line}`).join("\n")}`;
        const openAsks = this.#deps.interactions.listUnresolvedForAgentSession(session.id)
          .filter((row) => row.participant !== null);
        const withAsks = openAsks.length === 0 ? wakeText
          : `${wakeText}\n\nStill waiting on the operator (you cannot answer these; only they can):\n${openAsks.map((row) => `- ${row.participant}: ${questionTextOf(row)}`).join("\n")}`;
        this.#deps.bus.append({ type: "flow.result", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { userSessionId: session.userSessionId, agentSessionId: session.id, digestPreview: text.slice(0, 140) } });
        this.#deps.wake?.(session.userSessionId, session.id, category, withAsks);
      }
    } else {
      // An assignment whose blocker is open is JOURNALED AND QUEUED — not
      // denied, and not delivered with a warning.
      //
      // Denying turns delivery into something the model must interpret, and it
      // counts toward the tool-error watchdog; steering.e2e.test.ts records
      // that this codebase already removed exactly that pattern once.
      // Delivering with a warning is the status quo plus a sentence, and it is
      // how db-live-2's renderer wrote game.js 61 seconds after receiving a
      // contract it never confirmed. Queuing keeps the "a message is never
      // lost" guarantee and lets the Console carry it the moment the blocker
      // clears.
      const blockers = this.#assignmentBlockers(session, input.to, category, input.handoff.core.taskId);
      if (blockers.length > 0) {
        this.#deps.bus.append({ type: "governance.tool.denied", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { sessionId: session.userSessionId, agentSessionId: session.id, participant: input.speaker.name,
            toolName: "send_handoff", kind: "blocked_by_dependency",
            reason: `assignment to ${input.to} held: ${blockers.join("; ")}` } });
        this.#blockedAssignments.set(delivery.id, { agentSessionId: session.id, recipient: input.to, since: Date.now() });
        return message;
      }
      void this.#deliverConsole(session.id, input.to).catch((error) => this.#recordHostFailure(session.id, error));
    }
    return message;
  }

  /**
   * Conditions that make a `final` a lie the Console can PROVE.
   *
   * The distinction from `#finalReportCaveats` below is the whole design.
   * Caveats are model-maintained facts — an open ledger task, a specialist
   * still running — and those must never block, because in db-live-1 the
   * ledger orphaned on rotation and a blocking rule made `final` structurally
   * impossible while the operator heard nothing for 35 minutes.
   *
   * An unanswered operator question is different in kind: the Console owns it
   * end to end. It knows the question was asked, that nobody but the operator
   * can answer it, and that it has not been answered. db-live-2 declared a run
   * done and THEN asked whether two open items mattered — a question that is
   * still `pending` in that database, and was the last row written. A report
   * that precedes its own outstanding questions is not a report.
   */
  /**
   * Incomplete blockers of the task this assignment carries. Advisory
   * `blocked_by` edges become a real gate here — before this, `task_dependencies`
   * had eight rows in db-live-2 and nothing ever consulted them.
   */
  /**
   * An assignment carrying a taskId starts that unit; a terminal-status report
   * finishes it. Both are facts the console already holds at this moment.
   */
  #syncLedgerFromHandoff(session: AgentSessionRow, to: string, handoff: HandoffDraft, category: Category): void {
    const tasks = this.#deps.tasks;
    const taskId = handoff.core.taskId;
    if (!tasks || taskId === null) return;
    const listId = consoleTaskListId(session.id);
    try {
      if (category === "assignment") {
        tasks.applyUpdate({ sdkSessionId: listId, sdkTaskId: taskId, patch: { status: "in_progress", owner: to } });
        return;
      }
      if (handoff.core.status === "completed") {
        tasks.applyUpdate({ sdkSessionId: listId, sdkTaskId: taskId, patch: { status: "completed" } });
      } else if (handoff.core.status === "failed" || handoff.core.status === "blocked") {
        tasks.applyUpdate({ sdkSessionId: listId, sdkTaskId: taskId, patch: { status: "pending" } });
      }
    } catch { /* a ledger write must never fail a transfer */ }
  }

  #assignmentBlockers(session: AgentSessionRow, to: string, category: Category, taskId: string | null): string[] {
    if (category !== "assignment" || taskId === null || !this.#deps.tasks) return [];
    void to;
    const all = this.#deps.tasks.listForUserSession(session.userSessionId)
      .filter((task) => task.agentSessionId === session.id);
    const target = all.find((task) => task.sdkTaskId === taskId || task.id === taskId);
    if (!target) return [];
    const open: string[] = [];
    for (const blockerId of target.dependencyIds) {
      const blocker = all.find((task) => task.id === blockerId);
      if (blocker && blocker.status !== "completed" && blocker.status !== "deleted") {
        open.push(`"${target.subject}" is blocked_by "${blocker.subject}" (${blocker.status})`);
      }
    }
    return open;
  }

  /**
   * A blocker completed, or the grace expired. Carries anything now unblocked.
   *
   * The grace is NOT optional. A mis-declared dependency must never deadlock a
   * run — the same instinct that made `#finalReportCaveats` stop throwing.
   */
  releaseBlockedAssignments(): void {
    const grace = this.#deps.config?.assignmentBlockGraceMs ?? 600_000;
    const now = Date.now();
    for (const [deliveryId, held] of [...this.#blockedAssignments]) {
      const session = this.#deps.repo.getAgentSession(held.agentSessionId);
      if (!session || session.status !== "open") { this.#blockedAssignments.delete(deliveryId); continue; }
      const delivery = this.#deps.repo.getDeliveryById(deliveryId);
      if (!delivery || delivery.status !== "queued") { this.#blockedAssignments.delete(deliveryId); continue; }
      const message = this.#deps.repo.getMessageById(delivery.messageId);
      const taskId = ((message?.payload?.handoff as { taskId?: string } | undefined)?.taskId) ?? null;
      const stillBlocked = this.#assignmentBlockers(session, held.recipient, "assignment", taskId);
      const expired = now - held.since >= grace;
      if (stillBlocked.length > 0 && !expired) continue;
      this.#blockedAssignments.delete(deliveryId);
      if (expired && stillBlocked.length > 0) {
        this.#deps.bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { agentSessionId: session.id, participant: held.recipient,
            detail: `held assignment released after the grace period despite ${stillBlocked.join("; ")} — a declared dependency must never deadlock a run` } });
      }
      void this.#deliverConsole(held.agentSessionId, held.recipient).catch(() => undefined);
    }
  }

  #finalReportBlockers(session: AgentSessionRow, sender: string, to: string, category: Category): Interaction[] {
    if (!this.#isFinalToMain(sender, to, category)) return [];
    return this.#deps.interactions.listUnresolvedForAgentSession(session.id)
      .filter((row) => row.urgency === "blocking");
  }

  #isFinalToMain(sender: string, to: string, category: Category): boolean {
    return sender === ORCHESTRATOR_SEAT && to === MAIN_RECIPIENT && category === "final";
  }

  /**
   * Conditions a `final` report has not met. These used to THROW, which made
   * the operator's report conditional on model-maintained state: in db-live-1
   * the ledger orphaned on rotation, so a `final` was structurally impossible
   * and the operator heard nothing for 35 minutes. The console may enforce
   * only on facts it owns — so unmet conditions now travel WITH the report,
   * where the operator can weigh them, instead of suppressing it.
   */
  #finalReportCaveats(session: AgentSessionRow, sender: string, to: string, category: Category): string[] {
    if (sender !== ORCHESTRATOR_SEAT || to !== MAIN_RECIPIENT || category !== "final") return [];
    const caveats: string[] = [];
    if (this.#deps.tasks) {
      const incomplete = this.#deps.tasks.listForUserSession(session.userSessionId).filter((task) => task.agentSessionId === session.id && task.status !== "completed" && task.status !== "deleted");
      if (incomplete.length > 0) caveats.push(`${incomplete.length} task(s) still open in the ledger: ${incomplete.map((task) => task.subject).join(", ")}`);
    }
    const lanes = this.#seats.get(session.id);
    const activeSpecialists = [...(lanes?.entries() ?? [])].filter(([name, lane]) => name !== ORCHESTRATOR_SEAT && lane.activeTurn !== null).map(([name]) => name);
    // Only deliveries addressed to SPECIALISTS count as outstanding work: a
    // native final goes out mid-turn, so the very report that woke the
    // coordinator is still unacknowledged in its own inbox.
    const pendingInternal = this.#deps.repo.listActiveDeliveries(session.id).filter((delivery) => delivery.recipient !== MAIN_RECIPIENT && delivery.recipient !== ORCHESTRATOR_SEAT);
    if (activeSpecialists.length > 0) caveats.push(`still running: ${activeSpecialists.join(", ")}`);
    if (pendingInternal.length > 0) caveats.push(`${pendingInternal.length} delivery(ies) to specialists not yet acknowledged`);
    return caveats;
  }

  /** Journal core shared by the console path and the SendMessage middleware. */
  /**
   * Read `core.uncertainty[]` and put what belongs to the operator in front of
   * them.
   *
   * Hooked here in `post()` rather than in `HandoffService.prepare` for two
   * reasons. `prepare` is also the ROTATION CHECKPOINT path, and a checkpoint's
   * uncertainty is a seat's private note to its own successor — the wrong
   * audience entirely — and it runs inside `#maybeRotate`'s gate, which blocks
   * every sender to that seat and is the last place to do anything that can
   * wait. `post()` also has what the classifier needs: the interaction service,
   * the decision ledger, and the sender's real profile capabilities.
   *
   * CONSEQUENCE, stated plainly: `post()` is synchronous, so this is
   * fire-and-forget card creation. An auto-promoted BLOCKING item does not stop
   * the seat mid-turn — you cannot retroactively block a tool call that has
   * already returned. It stops the next `final`. The only thing that stops a
   * seat immediately is its own `ask_operator(urgency:'blocking')`. That is
   * precisely why both paths exist.
   */
  #promoteUncertainty(session: AgentSessionRow, sender: string, handoff: HandoffDraft, category: Category): void {
    const interactions = this.#deps.interactions;
    if (!interactions || handoff.core.uncertainty.length === 0) return;
    const senderSeat = sender === MAIN_RECIPIENT ? undefined : this.#deps.repo.getParticipant(session.id, sender);
    const profile = senderSeat?.profileSnapshot as AgentProfile | undefined;
    const items = classifyUncertainty(handoff.core, {
      trigger: category as HandoffTrigger,
      operatorPins: this.#deps.decisions.pins(session.userSessionId),
      operatorConstraints: this.#deps.decisions.constraints(session.userSessionId),
      capabilities: {
        shell: profile?.runtime.shell ?? false,
        browser: profile?.runtime.browser ?? false,
        screenshots: profile?.runtime.screenshots ?? false,
        network: resolvedDomains(profile ?? FALLBACK_PROFILE_RUNTIME, this.#deps.config?.allowedDomains ?? []),
      },
    });
    if (items.length === 0) return;

    // One card per (session, sender). A wall of simultaneous cards is
    // unanswerable, and re-reporting the same uncertainty on every update
    // would otherwise mint one each time.
    const existing = interactions.listUnresolvedForAgentSession(session.id)
      .find((row) => row.source === "uncertainty" && row.participant === sender);
    const already = new Set(
      (existing ? ((existing.payload as { questions?: InteractionQuestion[] }).questions ?? []) : [])
        .map((question) => question.question),
    );
    const fresh = items.filter((item) => !already.has(uncertaintyQuestion(item)));
    if (fresh.length === 0) return;
    if (existing) {
      // Merging into an open card rather than opening a second one keeps the
      // operator's screen honest: one seat, one outstanding ask.
      interactions.mergeQuestions(
        existing.id,
        fresh.slice(0, MAX_QUESTIONS_PER_CARD).map((item) => uncertaintyBlock(item)),
        fresh.some((item) => item.urgency === "blocking") ? "blocking" : undefined,
      );
      return;
    }
    const shown = fresh.slice(0, MAX_QUESTIONS_PER_CARD);
    const spilled = fresh.slice(MAX_QUESTIONS_PER_CARD);
    const blocks = shown.map((item) => uncertaintyBlock(item, spilled));
    interactions.createOperatorQuestion({
      userSessionId: session.userSessionId,
      agentSessionId: session.id,
      participant: sender,
      questions: blocks,
      urgency: fresh.some((item) => item.urgency === "blocking") ? "blocking" : "deferred",
      source: "uncertainty",
      allowFreeText: true,
      dedupeKey: `uncertainty:${sender}`,
    });
  }

  /**
   * `operatorDecisions` for a coordination-extension handoff, and nothing for
   * any other kind — the field only exists on `CoordinationHandoffData`, and
   * putting it elsewhere would be inventing schema.
   */
  #coordinationDefaults(session: AgentSessionRow, speaker: Speaker, senderSeat: ParticipantRow | undefined): { extensionDefaults?: Record<string, unknown> } {
    const kind = speaker.name === MAIN_RECIPIENT
      ? "coordination"
      : (senderSeat?.profileSnapshot as AgentProfile | undefined)?.handoffExtension;
    if (kind !== "coordination") return {};
    const lines = this.#deps.decisions.lines(session.userSessionId, { max: 12 });
    if (lines.length === 0) return {};
    return { extensionDefaults: { operatorDecisions: lines } };
  }

  #journal(session: AgentSessionRow, speaker: Speaker, to: string, handoff: HandoffDraft, category: Category, opts: {
    transport: MailboxDeliveryRow["transport"]; dedupeKey?: string; turnId?: string;
  }): { message: MessageRow; delivery: MailboxDeliveryRow; text: string; handoffId: string } {
    const { repo, bus } = this.#deps;
    if (!this.#deps.handoffs) throw new Error("handoff service unavailable");
    const senderSeat = speaker.name === MAIN_RECIPIENT ? undefined : repo.getParticipant(session.id, speaker.name);
    const prepared = this.#deps.handoffs.prepare({
      draft: handoff, userSessionId: session.userSessionId, agentSessionId: session.id,
      sender: speaker.name, recipient: to,
      profileId: speaker.name === MAIN_RECIPIENT ? "main" : senderSeat?.profileId ?? null,
      extensionKind: speaker.name === MAIN_RECIPIENT ? "coordination" : (senderSeat?.profileSnapshot as AgentProfile | undefined)?.handoffExtension,
      generation: speaker.name === MAIN_RECIPIENT ? (repo.getUserSession(session.userSessionId)?.sdkGeneration ?? 0) : senderSeat?.generation ?? 0,
      turnId: opts.turnId, trigger: category as HandoffTrigger,
      parentHandoffId: category === "assignment" ? null : (senderSeat?.latestHandoffId ?? (speaker.name === MAIN_RECIPIENT ? repo.getUserSession(session.userSessionId)?.latestHandoffId : null)),
      // A coordination handoff carries the operator's decisions with it, so a
      // recipient reading only the envelope still knows what was decided. The
      // field is console-authored under the model's own data; this is the
      // first thing that has ever written it.
      ...(this.#coordinationDefaults(session, speaker, senderSeat)),
      ...(senderSeat?.worktreePath ? { resolveRoot: senderSeat.worktreePath } : {}),
    });
    const text = prepared.text;
    const { message, delivery } = repo.appendHandoffMailbox({
      sessionKind: "agent", sessionId: session.id, userSessionId: session.userSessionId,
      agentSessionId: session.id, speaker, to, recipient: to,
      kind: "message" as const,
      text, category, transport: opts.transport, handoff: prepared.row, summary: prepared.summary,
      ...(opts.turnId ? { turnId: opts.turnId } : {}), ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}),
    });
    this.#deps.handoffs.committed(prepared.record);
    if (senderSeat?.attemptRole === "attempt" && (prepared.record.core.status === "completed" || prepared.record.core.status === "failed")) {
      this.#onAttemptPost(session, senderSeat, prepared.record.core.status);
    } else if (senderSeat && senderSeat.attemptRole === null && senderSeat.worktreePath && (prepared.record.core.status === "completed" || prepared.record.core.status === "failed")) {
      this.#onSeatWorktreePost(session, senderSeat, prepared.record.core.status);
    }
    bus.append({ type: "agent_session.message", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, message: toWireMessage(message) } });
    bus.append({ type: "agent_session.mailbox", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, deliveryId: delivery.id, messageSeq: message.seq, sender: speaker.name, recipient: to, category, status: "queued" } });
    return { message, delivery, text, handoffId: prepared.row.id };
  }

  readSession(input: { agentSessionId: string; afterSeq?: number; limit?: number }) {
    const session = this.#deps.repo.getAgentSession(input.agentSessionId);
    if (!session) throw notFound(`no agent session ${input.agentSessionId}`);
    let rows = this.#deps.repo.listMessages("agent", session.id, input.afterSeq ?? 0);
    if (input.limit !== undefined) rows = rows.slice(-input.limit);
    return { status: this.#statusOf(session), phase: session.phase,
      participants: this.#specialists(session.id).map((p) => ({ name: p.name, preset: p.profileId, profileId: p.profileId, model: p.model })),
      messages: rows.map(toWireMessage) };
  }

  listForUserSession(userSessionId: string) {
    return this.#deps.repo.listAgentSessions(userSessionId).map((row) => ({
      id: row.id, title: row.title, mode: row.mode, phase: row.phase, status: this.#statusOf(row),
      participants: this.#specialists(row.id).map((p) => p.name),
      unseenCount: this.#deps.repo.listQueuedDeliveries(row.id).filter((d) => d.recipient === MAIN_RECIPIENT).length,
      updatedAt: row.updatedAt,
    }));
  }

  wireSession(row: AgentSessionRow) { return toWireAgentSession(row, this.#specialists(row.id).map((p) => p.name), this.#statusOf(row) === "working"); }

  /** Whole-session stop (archive/shutdown): every lane closes hard. */
  interrupt(agentSessionId: string): void {
    for (const lane of this.#seats.get(agentSessionId)?.values() ?? []) this.#closeLaneHard(lane);
  }

  /**
   * Scoped stop: abort one specialist's in-flight turn without touching its
   * siblings. Its delivered work is cancelled so redelivery does not restart
   * the same assignment; the lane survives for the corrected one.
   */
  interruptParticipant(agentSessionId: string, participant: string, reason: string): void {
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (!session) throw notFound(`no agent session ${agentSessionId}`);
    const lane = this.#seats.get(agentSessionId)?.get(participant);
    if (!lane || lane.activeTurn === null) throw conflict(`${participant} has no turn in flight`);
    for (const delivery of this.#deps.repo.listUnackedDeliveries(agentSessionId, participant)) {
      if (delivery.status === "delivered") this.#patchDelivery(session, delivery, "cancelled");
    }
    this.#deps.bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId,
      payload: { agentSessionId, participant, turnId: lane.activeTurn.turnId, detail: `stopped: ${reason}` } });
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

  #closeLaneHard(lane: SeatLane): void {
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
   * and WITHOUT touching worktrees.
   *
   * Called when the Console proposes completion, so the operator never reads a
   * summary while a dev server the run started is still bound to a port. It
   * stops short of archival because the operator may ask for changes: the
   * seats respawn lazily over their retained provider sessions, and a worktree
   * destroyed here could not be merged afterwards.
   *
   * Returns what it killed, so the summary can state it — the alternative is
   * the operator wondering where their server went, which is the same class of
   * mystery the leak itself caused.
   */
  reapForUserSession(userSessionId: string): ReapResult {
    const processes: ReapResult["processes"] = [];
    let browsers = 0;
    for (const session of this.#deps.repo.listAgentSessions(userSessionId)) {
      if (session.status !== "open") continue;
      for (const seat of this.#deps.repo.listParticipants(session.id)) {
        for (const killed of this.#deps.processes?.stopParticipant(session.id, seat.name) ?? []) {
          processes.push({ agentSessionId: session.id, participant: seat.name, processId: killed.processId, pid: killed.pid });
        }
        void this.#deps.browsers?.closeParticipant(`${session.id}:${seat.name}`)
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
    for (const session of this.#deps.repo.listAgentSessions(userSessionId)) {
      if (session.status !== "open") continue;
      this.interrupt(session.id);
      this.#deps.processes?.stopSession(session.id);
      void this.#deps.browsers?.closeSession(session.id);
      const openGroup = this.#deps.repo.findOpenAttemptGroup(session.id);
      if (openGroup) this.#closeAttemptGroup(session, openGroup, "abandoned");
      if (this.#deps.worktrees && this.#deps.getWorkspaceRoot) {
        const user = this.#deps.repo.getUserSession(session.userSessionId);
        for (const seat of this.#deps.repo.listParticipants(session.id)) {
          if (!seat.worktreePath || seat.attemptRole !== null || !user) continue;
          try { this.#deps.worktrees.remove(this.#deps.getWorkspaceRoot(user.workspaceId), seat.worktreePath, seat.worktreeBranch ?? "", { archiveBranch: true }); } catch { /* best effort */ }
          this.#deps.repo.patchParticipant(session.id, seat.name, { worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null });
        }
      }
      for (const delivery of this.#deps.repo.listActiveDeliveries(session.id)) this.#patchDelivery(session, delivery, "cancelled");
      this.#deps.repo.patchAgentSession(session.id, { status: "archived" });
      this.#deps.bus.append({ type: "agent_session.status", userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, status: "archived", owedToOrchestrator: false } });
    }
  }

  /**
   * Releases any `ask_operator` wait older than `operatorAskDetachMs`. The
   * third of three mechanisms bounding a blocking ask, alongside the
   * concurrent-card cap and the capacity-eviction second pass — this is the one
   * that fires when nothing else needs the slot and the human is simply away.
   */
  onStatusChanged(handler: (userSessionId: string) => void): void {
    if (this.#onStatusChanged) throw new Error("onStatusChanged is already registered — wire callbacks once, in createApp");
    this.#onStatusChanged = handler;
  }

  startOperatorAskSweep(intervalMs = 30_000): void {
    if (this.#askSweep) return;
    this.#askSweep = setInterval(() => {
      const limit = this.#deps.config?.operatorAskDetachMs;
      if (limit === undefined) return;
      const cutoff = Date.now() - limit;
      for (const lanes of this.#seats.values()) for (const lane of lanes.values()) {
        const asking = lane.activeTurn?.awaitingOperator;
        if (asking && asking.since < cutoff) {
          this.#detachOperatorAsk(lane, `no answer within ${Math.round(limit / 60_000)} minutes; the question stays open`);
        }
      }
    }, intervalMs);
    this.#askSweep.unref?.();
  }

  stopOperatorAskSweep(): void {
    if (this.#askSweep) clearInterval(this.#askSweep);
    this.#askSweep = null;
  }

  /**
   * Hand a seat an answer its own tool call can no longer return.
   *
   * A seat is not revived by a lane the way main is — it is woken by a
   * delivery. So when its parked promise died (park, rotation, watchdog, or a
   * server restart) the answer arrives as a journaled `decision` handoff from
   * the coordinator's address, which is a legal `#assertRoute` edge where a
   * `system` speaker would not be. The dedupe key makes a double answer a
   * no-op.
   */
  deliverOperatorAnswer(interaction: Interaction, body: ResolveInteractionBody): void {
    if (!interaction.agentSessionId || !interaction.participant) return;
    const questions = (interaction.payload as { questions?: InteractionQuestion[] }).questions ?? [];
    const asked = questions.map((question) => question.question).join(" | ");
    const answer = "answers" in body
      ? [
          Object.entries(body.answers).map(([question, labels]) => `${question} → ${labels.join(", ")}`).join("\n"),
          ...(body.freeText === undefined ? [] : [`In their own words: ${Object.values(body.freeText).join(" ")}`]),
          ...(body.note === undefined ? [] : [`Note: ${body.note}`]),
        ].filter(Boolean).join("\n")
      : `${body.decision === "approve" ? "Approved" : "Changes requested"}${body.note === undefined ? "" : `: ${body.note}`}`;
    this.post({
      agentSessionId: interaction.agentSessionId,
      speaker: { kind: "orchestrator", name: ORCHESTRATOR_SEAT },
      to: interaction.participant,
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

  /**
   * The other half of the final gate.
   *
   * Withholding a report and then saying nothing is how db-live-1 produced a
   * 35-minute silence. So when a session's LAST blocking question clears, the
   * Console tells both ends: the coordinator learns it may report, and main
   * learns why the report it was expecting was late.
   *
   * Registered by `main.ts` on the interaction service.
   */
  onBlockingQuestionsCleared(userSessionId: string, agentSessionId: string): void {
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (!session || session.status !== "open") return;
    const lane = this.#seats.get(agentSessionId)?.get(ORCHESTRATOR_SEAT);
    // Only meaningful if a final was actually withheld from this session.
    if (!this.#withheldFinals.delete(agentSessionId)) return;
    try {
      this.post({
        agentSessionId,
        speaker: { kind: "orchestrator", name: ORCHESTRATOR_SEAT },
        to: MAIN_RECIPIENT,
        handoff: this.#simpleHandoff(
          "Operator answered; the withheld final can now be sent",
          "in_progress",
          "A final report from this session was withheld while the operator had unanswered questions. They have now answered, and the coordinator has been told it may report.",
          "Expect the coordinator's final shortly.",
        ),
        category: "milestone",
      });
    } catch { /* the notice is best effort; the coordinator still gets its delivery */ }
    if (lane) void this.#deliverConsole(agentSessionId, ORCHESTRATOR_SEAT).catch(() => undefined);
    void userSessionId;
  }

  boot(): void {
    const wakes = new Set<string>();
    for (const delivery of this.#deps.repo.listQueuedDeliveries()) {
      if (delivery.recipient === MAIN_RECIPIENT) continue;
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


  /**
   * Default-on isolation for write seats in git workspaces: a lazy worktree
   * per assignment, so completed work lands atomically and interrupted work
   * leaves zero residue. Fail-open — if the worktree cannot be created the
   * seat runs directly in the workspace, with a runtime notice.
   */
  #ensureSeatWorktree(session: AgentSessionRow, seat: ParticipantRow, workspaceRoot: string): ParticipantRow {
    const { repo, bus } = this.#deps;
    const worktrees = this.#deps.worktrees;
    const profile = seat.profileSnapshot as AgentProfile;
    // Read-only seats get one too.
    //
    // The gate used to be `writes`, which is why `check` had no worktree in
    // EITHER live run. A reviewer with Bash can still write, and more to the
    // point it needs a STABLE SNAPSHOT of what it is reviewing: db-live-2's
    // check verified a tree that renderer was still editing. Its worktree is
    // discarded rather than merged — `#onSeatWorktreePost` only merges a seat
    // whose profile can write.
    if (!worktrees || this.#deps.config?.seatWorktrees === false || seat.role !== "agent" || seat.attemptRole !== null
      || seat.worktreePath !== null || !worktrees.isGitRepo(workspaceRoot)) return seat;
    try {
      const dirName = `seat-${branchSafe(seat.name)}-${seat.generation}-${newId("turn").slice(-6)}`;
      const ref = worktrees.addWorktree(workspaceRoot, session.id, dirName, `seat/${session.id}/${branchSafe(seat.name)}-${seat.generation}`);
      repo.patchParticipant(session.id, seat.name, { worktreePath: ref.path, worktreeBaseCommit: ref.baseCommit, worktreeBranch: ref.branch });
      bus.append({ type: "agent_session.worktree.created", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, seat: seat.name, branch: ref.branch, baseCommit: ref.baseCommit } });
      return repo.getParticipant(session.id, seat.name) ?? seat;
    } catch (error) {
      bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, participant: seat.name, detail: `worktree isolation unavailable (${error instanceof Error ? error.message : String(error)}); working directly in the workspace` } });
      return seat;
    }
  }

  /**
   * A worktree'd write seat reported terminal status: completed work merges
   * atomically into the workspace (conflict → failure handoff, workspace
   * untouched); failed work is discarded with its diff retained. Fail-open on
   * git errors — the mailbox append already happened.
   */
  #onSeatWorktreePost(session: AgentSessionRow, seat: ParticipantRow, status: "completed" | "failed"): void {
    const { repo, bus } = this.#deps;
    const worktrees = this.#deps.worktrees;
    if (!worktrees || !seat.worktreePath || !seat.worktreeBranch || !seat.worktreeBaseCommit || !this.#deps.getWorkspaceRoot) return;
    const user = repo.getUserSession(session.userSessionId);
    if (!user) return;
    const workspaceRoot = this.#deps.getWorkspaceRoot(user.workspaceId);
    const release = () => repo.patchParticipant(session.id, seat.name, { worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null });
    // A read-only seat's worktree exists to give it a stable snapshot, not to
    // produce changes. Discard it: merging a reviewer's incidental scratch
    // files into the workspace would be a surprise, not a result.
    const profile = seat.profileSnapshot as AgentProfile;
    if (!profile.tools.includes("Edit") && !profile.tools.includes("Write")) {
      try { worktrees.remove(workspaceRoot, seat.worktreePath, seat.worktreeBranch, { archiveBranch: false }); } catch { /* best effort */ }
      release();
      bus.append({ type: "agent_session.worktree.discarded", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, seat: seat.name, reason: "read-only seat: snapshot discarded, nothing to land", artifactId: null } });
      return;
    }
    try {
      worktrees.commitAll(seat.worktreePath, `seat ${seat.name}: reported ${status}`, seat.ownership);
      const diff = worktrees.captureDiff(workspaceRoot, seat.worktreeBaseCommit, seat.worktreeBranch);
      const artifactId = diff.filesChanged === 0 ? null
        : bus.storeArtifact(`${diff.stat}\n\n${diff.patch}`, "text/x-patch", { userSessionId: session.userSessionId, agentSessionId: session.id }).artifactId;
      if (status === "failed" || diff.filesChanged === 0) {
        worktrees.remove(workspaceRoot, seat.worktreePath, seat.worktreeBranch);
        release();
        bus.append({ type: "agent_session.worktree.discarded", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { agentSessionId: session.id, seat: seat.name, reason: status === "failed" ? "seat reported failed" : "no changes to land", artifactId } });
        return;
      }
      const outcome = worktrees.mergeBranch(workspaceRoot, seat.worktreeBranch,
        `Merge seat ${seat.name} (session ${session.id})\n\nSeat-Worktree: ${seat.worktreeBranch}`);
      worktrees.remove(workspaceRoot, seat.worktreePath, seat.worktreeBranch, { archiveBranch: !outcome.merged });
      release();
      if (outcome.merged) {
        bus.append({ type: "agent_session.worktree.merged", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { agentSessionId: session.id, seat: seat.name, mergeCommit: outcome.commit, filesChanged: diff.filesChanged, artifactId } });
        this.#checkDependencyDrift(session, seat, diff.patch);
        return;
      }
      bus.append({ type: "agent_session.worktree.merge_failed", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, seat: seat.name, conflicts: outcome.conflicts, detail: outcome.detail, artifactId } });
      this.post({ agentSessionId: session.id, speaker: { kind: "agent", name: seat.name }, to: ORCHESTRATOR_SEAT,
        handoff: this.#simpleHandoff("Completed work failed to merge", "failed",
          `The workspace advanced past this seat's base; merging its changes conflicts in: ${outcome.conflicts.join(", ") || "unknown files"}. The diff is retained as artifact ${artifactId ?? "n/a"}.`,
          "Reassign the unit against the current HEAD."), category: "failure" });
    } catch (error) {
      bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, participant: seat.name, detail: `worktree landing failed: ${error instanceof Error ? error.message : String(error)}` } });
    }
  }

  /**
   * An attempt seat reported terminal status: commit its worktree, capture the
   * diff as a durable artifact, and when the whole group is settled either
   * seat the reviewer or fail the group. Fail-open — a git error marks the
   * attempt failed but never blocks the mailbox append that already happened.
   */
  #onAttemptPost(session: AgentSessionRow, seat: ParticipantRow, status: "completed" | "failed"): void {
    const { repo, bus } = this.#deps;
    const worktrees = this.#deps.worktrees;
    const group = seat.attemptGroupId ? repo.getAttemptGroup(seat.attemptGroupId) : undefined;
    if (!group || group.status !== "running" || !worktrees || !seat.worktreePath || !this.#deps.getWorkspaceRoot) return;
    const user = repo.getUserSession(session.userSessionId);
    if (!user) return;
    const workspaceRoot = this.#deps.getWorkspaceRoot(user.workspaceId);
    const state = { ...group.attemptsState };
    const entry = state[seat.name];
    if (!entry || entry.status !== "running") return;
    let commit: string | null = null;
    let artifactId: string | null = null;
    let diffBytes = 0;
    let filesChanged = 0;
    let attemptStatus: "completed" | "failed" = status;
    try {
      commit = worktrees.commitAll(seat.worktreePath, `attempt ${seat.name}: ${group.profileId} work`, seat.ownership);
      const diff = worktrees.captureDiff(workspaceRoot, group.baseCommit, entry.branch);
      filesChanged = diff.filesChanged;
      const content = diff.patch.length > 4 * 1024 * 1024
        ? `${diff.stat}\n\n[patch truncated at 4MiB — full history retained on archived branch]\n${diff.patch.slice(0, 4 * 1024 * 1024)}`
        : `${diff.stat}\n\n${diff.patch}`;
      const stored = bus.storeArtifact(content, "text/x-patch", { userSessionId: session.userSessionId, agentSessionId: session.id });
      artifactId = stored.artifactId;
      diffBytes = stored.bytes;
    } catch (error) {
      attemptStatus = "failed";
      bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, participant: seat.name, detail: `attempt capture failed: ${error instanceof Error ? error.message : String(error)}` } });
    }
    state[seat.name] = { ...entry, commit, artifactId, status: attemptStatus };
    repo.patchAttemptGroup(group.id, { attemptsState: state });
    bus.append({ type: "agent_session.attempt.completed", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, groupId: group.id, seat: seat.name, status: attemptStatus,
        branch: entry.branch, commit, artifactId, diffBytes, filesChanged } });
    const settled = Object.values(state);
    if (settled.some((attempt) => attempt.status === "running")) return;
    if (settled.every((attempt) => attempt.status === "failed")) {
      this.#closeAttemptGroup(session, { ...group, attemptsState: state }, "failed");
      this.post({ agentSessionId: session.id, speaker: { kind: "agent", name: seat.name }, to: ORCHESTRATOR_SEAT,
        handoff: this.#simpleHandoff(`All ${group.attempts} attempts failed`, "failed",
          `Every attempt in best-of-N group ${group.id} failed. Diffs (if any) are retained as artifacts.`,
          "Decide whether to retry with a fresh attempt group or rework the assignment."), category: "failure" });
      return;
    }
    this.#seatReviewer(session, { ...group, attemptsState: state });
  }

  #seatReviewer(session: AgentSessionRow, group: AttemptGroupRow): void {
    const { repo, bus } = this.#deps;
    const user = repo.getUserSession(session.userSessionId);
    if (!user) return;
    const reviewerName = `${group.baseSeat}.review`;
    const profile = this.#snapshotProfile(this.#profile("reviewer", user.workspaceId));
    const now = nowIso();
    const instructions = "You are selecting the winning attempt of a best-of-N group. Compare the attempts' diffs and reports with evidence, run read-only validation where useful, and you MUST call select_attempt_winner exactly once before your closing handoff. Reject all attempts only when none is sound.";
    const existing = repo.listParticipants(session.id);
    if (!existing.some((p) => p.name === reviewerName)) {
      const row = this.#participant(session.id, reviewerName, "agent", profile, instructions, undefined, [], existing.length, now);
      repo.insertParticipant({ ...row, attemptGroupId: group.id, attemptRole: "reviewer" });
    }
    repo.patchAttemptGroup(group.id, { status: "reviewing", reviewerSeat: reviewerName });
    bus.append({ type: "agent_session.attempt_group.review_started", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, groupId: group.id, reviewer: reviewerName } });
    const completed = Object.entries(group.attemptsState).filter(([, attempt]) => attempt.status === "completed");
    const evidence = completed.map(([seatName, attempt]) => ({ kind: "artifact" as const, ref: attempt.artifactId ?? "", label: `diff ${seatName}` })).filter((ref) => ref.ref !== "");
    this.post({ agentSessionId: session.id, speaker: { kind: "orchestrator", name: ORCHESTRATOR_SEAT }, to: reviewerName,
      handoff: { core: { schemaVersion: 1, taskId: null, status: "pending", risk: "medium",
        action: `Select the winning attempt for best-of-N group ${group.id}`,
        state: { summary: `${completed.length} of ${group.attempts} attempts completed (base ${group.baseCommit.slice(0, 12)}; branches: ${completed.map(([, attempt]) => attempt.branch).join(", ")}). Compare their diffs with read_attempt_diff or git, then select.`, evidence },
        result: { summary: null, artifacts: [] }, uncertainty: [],
        nextAction: "Call select_attempt_winner with the winning seat, or rejectAll.", requestExpandedContext: false },
        extension: { kind: "coordination", data: { attempts: Object.fromEntries(completed.map(([seatName, attempt]) => [seatName, { branch: attempt.branch, commit: attempt.commit }])) } } },
      category: "assignment", dedupeKey: `bon:${group.id}:review` });
  }

  /** Terminal transition: clean up worktrees (diffs are already durable) and journal. */
  #closeAttemptGroup(session: AgentSessionRow, group: AttemptGroupRow, status: "merged" | "rejected" | "failed" | "abandoned"): void {
    const { repo, bus } = this.#deps;
    const worktrees = this.#deps.worktrees;
    const user = repo.getUserSession(session.userSessionId);
    const workspaceRoot = user && this.#deps.getWorkspaceRoot ? this.#deps.getWorkspaceRoot(user.workspaceId) : null;
    if (worktrees && workspaceRoot) {
      for (const [seatName, attempt] of Object.entries(group.attemptsState)) {
        const oversized = attempt.artifactId === null && attempt.status === "completed";
        try { worktrees.remove(workspaceRoot, attempt.worktreePath, attempt.branch, { archiveBranch: oversized }); } catch { /* best effort */ }
        repo.patchParticipant(session.id, seatName, { worktreePath: null });
      }
    }
    repo.patchAttemptGroup(group.id, { status });
    bus.append({ type: "agent_session.attempt_group.closed", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, groupId: group.id, status } });
  }

  #participant(agentSessionId: string, name: string, role: "orchestrator" | "agent", profile: AgentProfile, extra: string, model: string | undefined, ownership: string[], ord: number, createdAt: string): ParticipantRow {
    const instructions = [profile.instructions, extra.trim()].filter(Boolean).join("\n\nAssigned role context:\n");
    return { agentSessionId, name, role, preset: profile.id, instructions, model: model ?? profile.model ?? null,
      profileId: profile.id, profileSnapshot: profile, ownership, sdkSessionId: null,
      peerName: peerNameOf(this.#deps.config?.peerNamePrefix ?? "console-", agentSessionId, name), lastActiveAt: null,
      generation: 0, turnCount: 0,
      contextTokens: 0, memory: "", latestHandoffId: null, checkpointReady: true, pendingTurnSeq: 0, lastSeenSeq: 0,
      cumulativeCostUsd: 0, cumulativeApiDurationMs: 0, lastDecisionAt: null,
      worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null, attemptGroupId: null, attemptRole: null, ord, createdAt };
  }

  #profile(id: string, workspaceId?: string): AgentProfile {
    if (this.#deps.profiles) return this.#deps.profiles.get(id, workspaceId);
    return { id, title: id, purpose: id, instructions: `You are the ${id} specialist.`, tools: ["Read", "Glob", "Grep"], permissionMode: "default", maxTurns: 30, sandboxRequired: true, runtime: { shell: false, browser: false, screenshots: false, network: [] } };
  }

  #assertRoute(agentSessionId: string, sender: string, recipient: string): void {
    const specialists = new Set(this.#specialists(agentSessionId).map((p) => p.name));
    const valid = sender === MAIN_RECIPIENT
      ? recipient === ORCHESTRATOR_SEAT
      : sender === ORCHESTRATOR_SEAT
        ? recipient === MAIN_RECIPIENT || specialists.has(recipient)
        : specialists.has(sender) && recipient === ORCHESTRATOR_SEAT;
    if (!valid) throw badRequest(`route ${sender} → ${recipient} is not allowed; communication is main ↔ coordinator ↔ specialist`);
  }

  // ── Persistent seat lanes ────────────────────────────────────────────────

  #laneOf(agentSessionId: string, seat: string): SeatLane {
    let lanes = this.#seats.get(agentSessionId);
    if (!lanes) { lanes = new Map(); this.#seats.set(agentSessionId, lanes); }
    let lane = lanes.get(seat);
    if (!lane) {
      lane = { state: "unspawned", input: null, query: null, abort: null, pump: null, ready: null,
        activeTurn: null, pendingDeliveries: [], redeliveryAttempts: new Map(), contextTokens: 0,
        lastCumulative: { costUsd: 0, apiDurationMs: 0 }, rotationGate: null, releaseRotation: null,
        idleTimer: null, assignmentTurns: 0, lastActiveAt: 0, lastStatus: null };
      lanes.set(seat, lane);
    }
    return lane;
  }

  /** Spawn or unpark a seat so its peer session is registered and accepting input. */
  async ensureSeatLive(agentSessionId: string, seat: string, deadline?: number): Promise<void> {
    const { repo } = this.#deps;
    const until = deadline ?? Date.now() + (this.#deps.config?.sendWakeTimeoutMs ?? 30_000);
    const lane = this.#laneOf(agentSessionId, seat);
    while (lane.rotationGate) await lane.rotationGate;
    if (lane.state === "live" || lane.state === "waking") { await lane.ready; return; }
    const session = repo.getAgentSession(agentSessionId);
    if (!session || session.status !== "open") throw conflict(`agent session ${agentSessionId} is not open`);
    const seatRow = repo.getParticipant(agentSessionId, seat);
    if (!seatRow) throw notFound(`no participant ${seat} in ${agentSessionId}`);
    await this.#reserveCapacity(agentSessionId, until);
    const raced = lane.state as SeatLane["state"];
    if (raced === "live" || raced === "waking") { await lane.ready; return; }
    this.#spawnSeat(session, seatRow, lane);
    await lane.ready;
    // A respawn may inherit rows the previous process took delivery of but
    // never consumed; requeue them so the console path re-carries exactly once.
    const stale = repo.listUnackedDeliveries(agentSessionId, seat).filter((row) => row.status === "delivered" && row.transport === "console");
    for (const row of stale) repo.patchDelivery(row.id, { status: "queued", deliveredAt: null });
  }

  #resident(agentSessionId?: string): number {
    let count = 0;
    for (const [sessionId, lanes] of this.#seats) {
      if (agentSessionId !== undefined && sessionId !== agentSessionId) continue;
      for (const lane of lanes.values()) if (lane.state === "live" || lane.state === "waking" || lane.state === "rotating") count += 1;
    }
    return count;
  }

  /** Resident CLI processes are the scarce resource now, not concurrent turns. */
  async #reserveCapacity(agentSessionId: string, until: number): Promise<void> {
    const config = this.#deps.config;
    if (!config) return;
    for (;;) {
      if (this.#resident() < config.seatMaxResident && this.#resident(agentSessionId) < config.seatMaxResidentPerSession) return;
      if (this.#parkLeastRecentIdle()) continue;
      if (Date.now() >= until) throw new Error("no resident seat capacity");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(1_000, Math.max(50, until - Date.now())));
        timer.unref?.();
        this.#capacityWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  #parkLeastRecentIdle(): boolean {
    let victim: { sessionId: string; seat: string; lane: SeatLane } | null = null;
    for (const [sessionId, lanes] of this.#seats) for (const [seat, lane] of lanes) {
      if (lane.state !== "live" || lane.activeTurn !== null) continue;
      if (this.#deps.repo.listUnackedDeliveries(sessionId, seat).length > 0) continue;
      if (!victim || lane.lastActiveAt < victim.lane.lastActiveAt) victim = { sessionId, seat, lane };
    }
    if (victim) {
      this.#parkSeat(victim.sessionId, victim.seat, victim.lane, "capacity");
      return true;
    }
    // Second pass: nothing is idle, but a seat blocked on the operator is not
    // WORKING — it is waiting on a human who may be away for hours. Detaching
    // the oldest such wait frees its process without losing the question: the
    // row stays open and the answer arrives later as a delivery.
    let waiting: { sessionId: string; seat: string; lane: SeatLane; since: number } | null = null;
    for (const [sessionId, lanes] of this.#seats) for (const [seat, lane] of lanes) {
      const asking = lane.activeTurn?.awaitingOperator;
      if (!asking) continue;
      if (!waiting || asking.since < waiting.since) waiting = { sessionId, seat, lane, since: asking.since };
    }
    if (!waiting) return false;
    this.#detachOperatorAsk(waiting.lane, "another seat needed this process while you waited on the operator");
    return true;
  }

  /**
   * Cut a blocking `ask_operator` loose. The tool call returns, the turn ends,
   * and the question stays open — the answer will arrive as a delivery.
   */
  #detachOperatorAsk(lane: SeatLane, reason: string): void {
    const asking = lane.activeTurn?.awaitingOperator;
    if (!asking) return;
    this.#deps.interactions.detach(asking.interactionId, reason);
    asking.abort.abort();
  }

  /**
   * A seat putting a question to the human.
   *
   * The hard parts are all about not making things worse than silence:
   *  - a duplicate returns the OPEN card rather than minting a second one, so a
   *    seat that re-asks does not feed WATCHDOG_IDENTICAL_CALLS (5) or hand the
   *    operator the same question twice;
   *  - past three unresolved blocking cards in one session, further asks are
   *    downgraded to deferred — a card avalanche is unanswerable, and every
   *    blocking ask pins a resident process;
   *  - nothing here EVER returns `isError`. A dismissal, a detach or an expiry
   *    is not the seat's mistake, and ten consecutive error results trip
   *    WATCHDOG_ERROR_STREAK and kill its turn. Punishing a seat for the
   *    operator's silence is precisely backwards.
   */
  async #askOperator(session: AgentSessionRow, seat: ParticipantRow, lane: SeatLane, args: AskOperatorArgs): Promise<SdkToolResult> {
    const interactions = this.#deps.interactions;
    if (!interactions) return ok({ resolved: false, reason: "the console cannot reach the operator right now" });
    const dedupeKey = dedupeKeyFor(seat.name, args.question);
    const open = interactions.findUnresolvedByDedupe(session.id, dedupeKey);
    if (open) {
      return ok({ queued: true, interactionId: open.id, deduped: true,
        note: "You already asked this and the card is still open on the operator's screen. Do not ask again; keep working or stop." });
    }
    const blocking = interactions.listUnresolvedForAgentSession(session.id).filter((row) => row.urgency === "blocking");
    const urgency: InteractionUrgency = args.urgency === "blocking" && blocking.length >= MAX_CONCURRENT_BLOCKING_ASKS ? "deferred" : args.urgency;
    const downgraded = urgency !== args.urgency;

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
      participant: seat.name,
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
        ...(downgraded ? { downgraded: true, reason: `${blocking.length} blocking question(s) are already open in this session` } : {}),
        note: "The operator can see this now. Their answer will be handed to you at your next delivery — keep working; do not poll." });
    }

    const turn = lane.activeTurn;
    if (turn) turn.awaitingOperator = { interactionId: pending.id, since: Date.now(), abort };
    this.#deps.bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, participant: seat.name, detail: `waiting on the operator (${pending.id})` } });
    try {
      const resolved = await pending.resolution;
      if (resolved.kind === "answers") {
        return ok({ resolved: true, interactionId: pending.id, answers: resolved.answers,
          ...(resolved.freeText === undefined ? {} : { freeText: resolved.freeText }),
          ...(resolved.note === undefined ? {} : { note: resolved.note }),
          ...(resolved.autoTaken === true ? { autoTaken: true } : {}),
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

  #spawnSeat(session: AgentSessionRow, seatRow: ParticipantRow, lane: SeatLane): void {
    if (!this.#deps.sdk || !this.#deps.config || !this.#deps.getWorkspaceRoot) throw new Error("SDK unavailable");
    lane.state = "waking";
    lane.abort = new AbortController();
    lane.input = new AsyncQueue<SdkUserMessageLike>();
    lane.lastActiveAt = Date.now();
    // Occupancy is re-reported by the first assistant message of any new
    // process, so it always restarts at zero.
    lane.contextTokens = 0;
    // Cost and api-duration do NOT. The SDK reports them cumulatively per
    // query(), and a RESUMED session continues its running total across the
    // process boundary — so the baseline belongs to the PROVIDER SESSION, not
    // to the lane. Zeroing it on every spawn is what made db-live-1 record
    // $4.4875 for a 55-second turn (its api_duration_ms was 20x its own wall
    // clock), overstating that run by 33.4%.
    //
    // A seat with no `sdkSessionId` is genuinely starting fresh — that is what
    // rotation does at host.ts's #rotateNow — so its baseline is zero.
    lane.lastCumulative = seatRow.sdkSessionId === null
      ? { costUsd: 0, apiDurationMs: 0 }
      : { costUsd: seatRow.cumulativeCostUsd, apiDurationMs: seatRow.cumulativeApiDurationMs };
    lane.ready = (async () => {
      const sdk = await this.#deps.sdk!();
      const user = this.#deps.repo.getUserSession(session.userSessionId);
      if (!user) throw new Error("workspace unavailable");
      const workspaceRoot = this.#deps.getWorkspaceRoot!(user.workspaceId);
      const latestSeat = this.#ensureSeatWorktree(session, this.#deps.repo.getParticipant(session.id, seatRow.name) ?? seatRow, workspaceRoot);
      const profile = latestSeat.profileSnapshot as AgentProfile;
      const seatRoot = latestSeat.worktreePath ?? workspaceRoot;
      const mcp = this.#buildParticipantMcp(sdk, session, latestSeat, lane);
      const options: SdkOptions = {
        cwd: seatRoot,
        // Order matters for prompt caching: the invariant part (instructions,
        // capabilities, messaging brief) comes first and is byte-identical
        // across generations; the volatile checkpoint goes last.
        systemPrompt: { type: "preset", preset: "claude_code", append: `${latestSeat.instructions}\n\n${capabilityBrief(profile, latestSeat.worktreePath !== null && !latestSeat.attemptRole, this.#deps.config?.allowedDomains ?? [])}${latestSeat.worktreePath && !latestSeat.attemptRole ? "\nNever run git commit — the Console lands your work when you report completed. Install dependencies only if you must run validation." : ""}\n\n${seatMessagingBrief(this.#roster(session), latestSeat.name)}\n${SESSION_PROTOCOL}${this.#decisionContext(session)}${this.#checkpointContext(latestSeat)}` },
        settingSources: [], includePartialMessages: true,
        settings: { crossSessionInbound: "accept" } as unknown as SdkOptions["settings"],
        permissionMode: profile.permissionMode,
        ...(profile.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        allowedTools: [...profile.tools,
          ...(profile.tools.includes("Edit") || profile.tools.includes("Write") ? ["EnterWorktree", "ExitWorktree"] : []),
          ...this.#runtimeToolNames(profile, latestSeat.name, latestSeat.attemptRole)],
        // A profile's tool list must be BINDING. `allowedTools` is only an
        // auto-approval list, so the db-live-1 coordinator — profile
        // ["Read","Glob","Grep"], brief "your own tools are intentionally
        // read-only" — ran Bash 20 times, including curl and `find /`.
        // Everything the profile did not grant is denied by name.
        //
        // The native Task* tools are additionally scoped to the provider
        // session, so their ledger dies at every rotation; seats use the
        // console-owned task_list/task_create/task_update instead.
        disallowedTools: [...new Set([
          // One transport. `send_handoff` is console-carried, so there is no
          // second wire whose delivery semantics, ref handshake, or hand-
          // written envelope can diverge from it.
          "Agent", "Task", "SendMessage", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
          ...GOVERNED_BUILTIN_TOOLS.filter((name) => !profile.tools.includes(name)),
        ])],
        hooks: this.#buildSeatHooks(session, latestSeat) as SdkOptions["hooks"],
        sandbox: { enabled: true, failIfUnavailable: profile.sandboxRequired, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
          filesystem: { allowManagedReadPathsOnly: true, allowRead: latestSeat.worktreePath ? [seatRoot, workspaceRoot] : [workspaceRoot], allowWrite: [seatRoot] },
          network: sandboxNetwork(profile, this.#deps.config?.allowedDomains ?? []) },
        env: sdkEnv({ sessionName: latestSeat.peerName }), abortController: lane.abort!, persistSession: true,
        sessionStore: this.#deps.sessionStore as never, sessionStoreFlush: "eager",
        mcpServers: { console_agent: mcp as never },
        ...(latestSeat.model ? { model: latestSeat.model } : {}),
        ...((profile.pluginPath && profile.source === "workspace") ? { plugins: [{ type: "local" as const, path: profile.pluginPath }] } : {}),
        // Always explicit: omitting the key lets the CLI fall back to the
        // OPERATOR's personal skill listing, which was injected verbatim into
        // all 14 db-live-1 sessions (~18.6K tokens of dataviz/keybindings noise
        // in three.js seats) despite settingSources: [].
        skills: profile.skills ?? [],
        ...((profile.effort ?? this.#deps.config?.effort) ? { effort: (profile.effort ?? this.#deps.config?.effort) as SdkOptions["effort"] } : {}),
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

  /**
   * Fail-open, exactly like `#ensureSeatWorktree`: if the workspace cannot
   * become a repository the run proceeds without isolation and says so, rather
   * than refusing to start.
   */
  #ensureWorkspaceRepo(workspaceId: string, userSessionId: string): void {
    const worktrees = this.#deps.worktrees;
    if (!worktrees || !this.#deps.getWorkspaceRoot || this.#deps.config?.autoInitGit === false) return;
    if (this.#deps.config?.seatWorktrees === false) return;
    let root: string;
    try { root = this.#deps.getWorkspaceRoot(workspaceId); } catch { return; }
    if (worktrees.isGitRepo(root)) return;
    const forbidden = (this.#deps.config?.fsRoots ?? []).map((entry) => entry.path);
    const outcome = worktrees.initRepo(root, { forbiddenRoots: forbidden });
    this.#deps.bus.append({
      type: "user_session.runtime", userSessionId,
      payload: {
        sessionId: userSessionId,
        detail: outcome.initialized
          ? `workspace initialised as a git repository so each seat gets an isolated worktree (${outcome.reason})`
          : `seats will share the workspace directory — no isolation: ${outcome.reason}`,
      },
    });
  }

  #roster(session: AgentSessionRow): string {
    return this.#deps.repo.listParticipants(session.id).map((p) => {
      const scopes = p.ownership.slice(0, 3).join(", ") + (p.ownership.length > 3 ? ` +${p.ownership.length - 3} more` : "");
      // Capability tag so a coordinator assigns work a seat can actually do.
      // db-live-1 assigned "play a round using arrow keys" to a seat with no
      // keyboard primitive; nothing in the system could notice before the seat
      // had spent twenty minutes discovering it.
      return `${p.name} (${p.profileId}; ${capabilityTag(p.profileSnapshot as AgentProfile)}; owns: ${scopes || "coordination"})`;
    }).join("; ");
  }

  #buildSeatHooks(session: AgentSessionRow, seat: ParticipantRow): SdkHooksFragment {
    const workspaceRoot = (() => {
      const user = this.#deps.repo.getUserSession(session.userSessionId);
      try { return user && this.#deps.getWorkspaceRoot ? this.#deps.getWorkspaceRoot(user.workspaceId) : ""; } catch { return ""; }
    })();
    // No send middleware: transfers go through the console-owned `send_handoff`
    // tool, which is journalled by `post()` directly. There is no second wire to
    // govern, and therefore no envelope to validate, coerce, or degrade.
    const fragments: SdkHooksFragment[] = [];
    const user = this.#deps.repo.getUserSession(session.userSessionId);
    // No native task mirror: all four Task* tools are in every seat's
    // `disallowedTools`, so this fragment could never have fired. Seats use the
    // console-owned task_list/task_create/task_update.
    if (this.#deps.worktrees && user && this.#deps.getWorkspaceRoot) {
      fragments.push(buildWorktreeHooks({
        repo: this.#deps.repo, bus: this.#deps.bus, worktrees: this.#deps.worktrees,
        workspaceRoot: this.#deps.getWorkspaceRoot(user.workspaceId),
        userSessionId: session.userSessionId, agentSessionId: session.id, seat: seat.name,
      }));
    }
    // Writes gate on agreement, and (opt-in) on declared ownership.
    fragments.push(buildContractHooks({
      contracts: this.#deps.contracts,
      bus: this.#deps.bus,
      userSessionId: session.userSessionId,
      agentSessionId: session.id,
      seat: seat.name,
      seatRoot: seat.worktreePath ?? workspaceRoot,
      workspaceRoot,
      ownership: seat.ownership,
      enforceOwnership: this.#deps.config?.enforceOwnership === true,
    }));
    return mergeHooks(fragments);
  }

  async #pumpSeat(session: AgentSessionRow, seatName: string, lane: SeatLane, query: QueryHandle): Promise<void> {
    const { repo, bus } = this.#deps;
    const runtime = new RuntimeBroadcaster(bus, { kind: "agent", sessionId: session.id }, seatName,
      { userSessionId: session.userSessionId, agentSessionId: session.id });
    try {
      for await (const raw of query) {
        for (const event of mapSdkMessage(raw)) {
          if ("parentCallId" in event && event.parentCallId) continue;
          if (event.kind === "resume") { repo.patchParticipant(session.id, seatName, { sdkSessionId: event.resumeId }); continue; }
          if (event.kind === "turn-idle") { this.#settleSeatTurn(session, seatName, lane, runtime, "completed"); continue; }
          if (event.kind === "task-terminal") { runtime.note(event.summary); continue; }
          if (event.kind === "notice") {
            runtime.note(event.text);
            bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: session.id,
              payload: { agentSessionId: session.id, participant: seatName, ...(lane.activeTurn ? { turnId: lane.activeTurn.turnId } : {}), detail: event.text } });
            continue;
          }
          // An event with no open turn is native inbound waking the seat.
          if (!lane.activeTurn && (event.kind === "delta" || event.kind === "reasoning-delta" || event.kind === "message" || event.kind === "tool.call" || event.kind === "peer-message")) {
            this.#mintTurn(session, seatName, lane, "peer", []);
          }
          const turn = lane.activeTurn;
          const turnId = turn?.turnId ?? "";
          if (event.kind === "delta") {
            runtime.set("responding");
            bus.broadcast({ type: "stream.delta", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { scope: { kind: "agent", sessionId: session.id }, speaker: seatName, turnId, text: event.text } });
          } else if (event.kind === "reasoning-delta") {
            runtime.set("thinking");
            bus.broadcast({ type: "stream.reasoning", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { scope: { kind: "agent", sessionId: session.id }, speaker: seatName, turnId, text: event.text } });
            // Reasoning was broadcast and never stored: `thinking_chars` is 0
            // in both live databases, so every "why did it decide that"
            // question in the post-run analyses had to be reverse-engineered
            // from surface text. Off by default — it is more of a category the
            // console already persists (tool inputs and results carry the same
            // workspace content), but it is still more, and that should be the
            // operator's call.
            if (turn && this.#deps.config?.persistReasoning === true && turn.reasoning.length < MAX_REASONING_CHARS) {
              turn.reasoning += event.text;
            }
          } else if (event.kind === "message") {
            if (turn) turn.lastNarration = event.text;
            this.#recordNarration(session, seatName, event.text, turnId);
          } else if (event.kind === "tool.call") {
            turn?.toolStarts.set(event.callId, Date.now());
            runtime.set("tool", event.name);
            bus.append({ type: "agent_session.tool.call", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { sessionId: session.id, participant: seatName, turnId, callId: event.callId, name: event.name, input: bus.capture(event.input, { userSessionId: session.userSessionId, agentSessionId: session.id }) } });
            if (turn) {
              const key = `${event.name} ${stableStringify(event.input)}`;
              turn.watchdog.identical = key === turn.watchdog.lastKey ? turn.watchdog.identical + 1 : 1;
              turn.watchdog.lastKey = key;
              if (turn.watchdog.identical >= WATCHDOG_IDENTICAL_CALLS) {
                this.#tripWatchdog(session, seatName, lane, { kind: "repeat_tool_calls", toolName: event.name, count: turn.watchdog.identical,
                  detail: `watchdog: ${turn.watchdog.identical} identical consecutive calls to ${event.name}` });
              }
            }
          } else if (event.kind === "tool.result") {
            const captured = bus.captureSized(event.output, { userSessionId: session.userSessionId, agentSessionId: session.id });
            const startedAt = turn?.toolStarts.get(event.callId); turn?.toolStarts.delete(event.callId);
            runtime.set("thinking");
            bus.append({ type: "agent_session.tool.result", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { sessionId: session.id, participant: seatName, turnId, callId: event.callId, output: captured.value, bytes: captured.bytes, ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }), ...(event.isError ? { isError: true } : {}) } });
            if (turn) {
              turn.watchdog.errorStreak = event.isError ? turn.watchdog.errorStreak + 1 : 0;
              if (turn.watchdog.errorStreak >= WATCHDOG_ERROR_STREAK) {
                this.#tripWatchdog(session, seatName, lane, { kind: "tool_error_streak", count: turn.watchdog.errorStreak,
                  detail: `watchdog: ${turn.watchdog.errorStreak} consecutive tool errors` });
              }
            }
          } else if (event.kind === "retry") {
            // Budget on wall clock. In db-live-2 three bursts each ran to
            // 10/10 and destroyed their turns after 181s, 173s and 172s of
            // pure back-off; interrupting at the budget turns those into ~90s
            // and hands the successor real state instead of an error string.
            if (turn) {
              turn.retryMs += event.delayMs;
              const budget = this.#deps.config?.retryBudgetMs ?? 90_000;
              if (turn.retryMs >= budget && turn.watchdog.tripped === null) {
                this.#tripWatchdog(session, seatName, lane, {
                  kind: "retry_budget", count: Math.round(turn.retryMs / 1000),
                  detail: `provider retries consumed ${Math.round(turn.retryMs / 1000)}s of back-off; interrupting rather than waiting out the schedule`,
                });
              }
            }
          } else if (event.kind === "context") {
            lane.contextTokens = Math.max(lane.contextTokens, event.occupancyTokens);
          } else if (event.kind === "result") {
            const seat = repo.getParticipant(session.id, seatName);
            if (seat) {
              repo.patchParticipant(session.id, seatName, { ...(event.resumeId ? { sdkSessionId: event.resumeId } : {}), contextTokens: Math.max(seat.contextTokens, lane.contextTokens) });
              this.#recordUsage(session, seat, lane.lastCumulative, turnId || newId("turn"), event, "completed", turn ? Date.now() - turn.startedAt : undefined);
            }
            this.#settleSeatTurn(session, seatName, lane, runtime, "completed");
          } else if (event.kind === "error") {
            const seat = repo.getParticipant(session.id, seatName);
            if (seat) {
              repo.patchParticipant(session.id, seatName, { contextTokens: Math.max(seat.contextTokens, lane.contextTokens) });
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

  /** Console-synthesized nudge into a live turn; a no-op on a parked lane. */
  #steer(session: AgentSessionRow, seatName: string, text: string, detail: string): void {
    const lane = this.#laneOf(session.id, seatName);
    if (!lane.input || !lane.activeTurn) return;
    lane.input.push(seatUserMessage(text));
    this.#deps.bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, participant: seatName, turnId: lane.activeTurn.turnId, detail } });
  }

  #tripWatchdog(session: AgentSessionRow, seatName: string, lane: SeatLane, tripped: { kind: "repeat_tool_calls" | "tool_error_streak" | "retry_budget"; detail: string; toolName?: string; count: number }): void {
    const turn = lane.activeTurn;
    if (!turn || turn.watchdog.tripped) return;
    turn.watchdog.tripped = tripped.detail;
    this.#deps.bus.append({ type: "agent_session.watchdog", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, participant: seatName, turnId: turn.turnId, kind: tripped.kind,
        ...(tripped.toolName ? { toolName: tripped.toolName } : {}), count: tripped.count, detail: tripped.detail } });
    // Interrupt, never abort: the turn dies, the lane (and its inbox) survive.
    void lane.query?.interrupt?.().catch(() => undefined);
  }

  #mintTurn(session: AgentSessionRow, seatName: string, lane: SeatLane, trigger: "delivery" | "peer" | "steer", deliveries: MailboxDeliveryRow[]): void {
    const attributed = deliveries.length > 0 ? deliveries
      : this.#deps.repo.listUnackedDeliveries(session.id, seatName).filter((row) => row.status === "delivered");
    lane.activeTurn = { turnId: newId("turn"), startedAt: Date.now(), trigger, deliveries: attributed, sawSend: false,
      toolStarts: new Map(), lastNarration: "", watchdog: { lastKey: "", identical: 0, errorStreak: 0, tripped: null }, awaitingOperator: null, retryMs: 0, reasoning: "" };
    lane.lastActiveAt = Date.now();
    if (lane.idleTimer) { clearTimeout(lane.idleTimer); lane.idleTimer = null; }
    this.#deps.bus.append({ type: "agent_session.turn.started", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, participant: seatName, turnId: lane.activeTurn.turnId } });
    this.#setStatus(session.id, "working");
  }

  #settleSeatTurn(session: AgentSessionRow, seatName: string, lane: SeatLane, runtime: RuntimeBroadcaster, status: "completed" | "error" | "aborted", errorMessage?: string): void {
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
      // A provider or transport failure is not consent to drop the work —
      // cancelling unconditionally broke the documented "a message is never
      // lost" guarantee. But a watchdog trip means the seat malfunctioned ON
      // THIS INPUT and an operator abort is a deliberate stop; redelivering
      // either just reproduces the failure. Those cancel, and the coordinator
      // decides from the failure handoff (which now carries the seat's work).
      const retryable = status === "error" && turn.watchdog.tripped === null;
      // A transport failure says nothing about the delivery — the request never
      // reached the model. Spending a redelivery slot on it means a seat can
      // exhaust its retries on network weather and have its assignment
      // CANCELLED, which is how db-live-2 lost turns it could have resumed.
      const transport = isTransportFailure(errorMessage ?? null);
      for (const delivery of turn.deliveries) {
        const attempts = (lane.redeliveryAttempts.get(delivery.id) ?? 0) + (transport ? 0 : 1);
        if (!retryable || attempts > MAX_REDELIVERY_ATTEMPTS) {
          lane.redeliveryAttempts.delete(delivery.id);
          this.#patchDelivery(session, delivery, "cancelled");
          continue;
        }
        lane.redeliveryAttempts.set(delivery.id, attempts);
        this.#patchDelivery(session, delivery, "queued");
        requeued = true;
      }
    }
    if (turn.reasoning !== "") {
      // An artifact, never a message: it must not re-enter any prompt.
      const stored = this.#deps.bus.storeArtifact(turn.reasoning.slice(0, MAX_REASONING_CHARS), "text/plain",
        { userSessionId: session.userSessionId, agentSessionId: session.id });
      this.#deps.bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, participant: seatName, turnId: turn.turnId,
          detail: `reasoning captured as ${stored.artifactId} (${stored.bytes}B)` } });
    }
    const seat = repo.getParticipant(session.id, seatName);
    if (seat) {
      repo.patchParticipant(session.id, seatName, { turnCount: seat.turnCount + 1, lastActiveAt: nowIso(),
        ...(turn.sawSend ? {} : { checkpointReady: false }) });
    }
    lane.assignmentTurns += 1;
    lane.lastActiveAt = Date.now();
    if (status === "error" && repo.getAgentSession(session.id)?.status === "open") {
      const target = seatName === ORCHESTRATOR_SEAT ? MAIN_RECIPIENT : ORCHESTRATOR_SEAT;
      // A dead turn must hand its successor real state.
      //
      // This used to be `#simpleHandoff` plus whatever narration happened to be
      // buffered — 528 bytes in practice, because a seat that dies mid-tool-loop
      // has no recent narration at all. db-live-2 represented NINE MINUTES of
      // renderer's work to the coordinator with 45 characters of error text,
      // and the coordinator had to reconstruct the state by inferring it from
      // another seat's report.
      //
      // `#reconstructCheckpoint` already assembles what the console owns —
      // ownership, task ledger, worktree diff, current assignment, last report
      // — so the failure carries that, with the error and any salvaged
      // narration spliced on top.
      const salvaged = turn.lastNarration.trim();
      const reason = turn.watchdog.tripped ?? `Provider turn failed: ${errorMessage}`;
      let draft: HandoffDraft;
      try {
        const reconstructed = seat ? this.#reconstructCheckpoint(session, seat) : null;
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
      this.post({ agentSessionId: session.id, speaker: { kind: seatName === ORCHESTRATOR_SEAT ? "orchestrator" : "agent", name: seatName }, to: target,
        handoff: draft, category: "failure", turnId: turn.turnId });
    }
    const profile = seat?.profileSnapshot as AgentProfile | undefined;
    if (status === "completed" && profile && lane.assignmentTurns === profile.maxTurns + 1 && repo.getAgentSession(session.id)?.status === "open") {
      const target = seatName === ORCHESTRATOR_SEAT ? MAIN_RECIPIENT : ORCHESTRATOR_SEAT;
      this.post({ agentSessionId: session.id, speaker: { kind: seatName === ORCHESTRATOR_SEAT ? "orchestrator" : "agent", name: seatName }, to: target,
        handoff: this.#simpleHandoff("Turn budget exhausted", "blocked",
          `${seatName} has spent ${lane.assignmentTurns - 1} turns on the current assignment (budget ${profile.maxTurns}).`,
          "Refocus, reassign, or explicitly continue the work."), category: "failure", turnId: turn.turnId });
    }
    bus.append({ type: "agent_session.turn.settled", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, participant: seatName, turnId: turn.turnId, status, durationMs: Date.now() - turn.startedAt, ...(errorMessage ? { errorMessage } : {}) } });
    // File-state snapshot per settled turn: mid-assignment crash recovery is
    // lossless, and the completion diff (base..branch) is unaffected.
    const current = repo.getParticipant(session.id, seatName);
    if (current?.worktreePath && this.#deps.worktrees && fs.existsSync(current.worktreePath)) {
      try { this.#deps.worktrees.commitAll(current.worktreePath, `turn ${turn.turnId}`, current.ownership); } catch { /* snapshot is best-effort */ }
    }
    runtime.idle();
    if (requeued && repo.getAgentSession(session.id)?.status === "open") {
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
    const seatRow = repo.getParticipant(agentSessionId, recipient);
    if (!session || !lane.input || !seatRow) return;
    const rows = repo.listUnackedDeliveries(agentSessionId, recipient).filter((row) => row.status === "queued");
    if (rows.length === 0) return;
    const messages = rows.map((row) => repo.getMessageById(row.messageId)).filter((row): row is MessageRow => row !== undefined);
    for (const row of rows) this.#patchDelivery(session, row, "delivered");
    if (rows.some((row) => row.category === "assignment")) lane.assignmentTurns = 0;
    const prompt = this.#composePrompt(session, seatRow, messages);
    if (lane.activeTurn) {
      lane.activeTurn.deliveries.push(...rows);
      lane.input.push(seatUserMessage(`New addressed handoffs arrived while you were working — fold them into the work in progress.\n\n${prompt}`));
      bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, participant: recipient, turnId: lane.activeTurn.turnId, detail: `steered mid-turn (${rows.length} deliveries)` } });
    } else {
      this.#mintTurn(session, recipient, lane, "delivery", rows);
      lane.input.push(seatUserMessage(prompt));
    }
    if (messages.length > 0) repo.patchParticipant(agentSessionId, recipient, { pendingTurnSeq: messages[messages.length - 1]!.seq });
  }

  #armIdleTimer(agentSessionId: string, seatName: string, lane: SeatLane): void {
    const config = this.#deps.config;
    if (!config) return;
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    lane.idleTimer = setTimeout(() => {
      lane.idleTimer = null;
      if (lane.state !== "live" || lane.activeTurn !== null) return;
      if (this.#deps.repo.listUnackedDeliveries(agentSessionId, seatName).length > 0) return;
      this.#parkSeat(agentSessionId, seatName, lane, "idle");
    }, config.seatIdleReapMs);
    lane.idleTimer.unref?.();
  }

  /**
   * Close the process (name and socket unregister); keep the resume handle.
   *
   * Runtime the seat still holds dies with the lane. A parked seat is not
   * coming back imminently — for `idle` it has been quiet for
   * `seatIdleReapMs`, and for `capacity` it was evicted to make room — so its
   * dev servers and Chrome are pure leak. db-live-2 parked `check` with
   * `node serve.mjs` still bound to :8173; the process outlived the run and
   * the next run inherited it as a foreign app squatting the port it wanted.
   */
  #parkSeat(agentSessionId: string, seatName: string, lane: SeatLane, reason: string): void {
    lane.state = "parked";
    lane.input?.close(); lane.input = null;
    const query = lane.query; lane.query = null;
    query?.close?.();
    lane.abort = null;
    const killed = this.#deps.processes?.stopParticipant(agentSessionId, seatName) ?? [];
    void this.#deps.browsers?.closeParticipant(`${agentSessionId}:${seatName}`).catch(() => undefined);
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (session) {
      // Name what was reaped. A silent kill turns "my server vanished" into
      // the same six-minute forensic exercise the leak itself caused.
      const reaped = killed.length === 0 ? "" : `; reaped ${killed.length} process(es): ${killed.map((p) => `${p.processId}${p.pid === undefined ? "" : ` (pid ${p.pid})`}`).join(", ")}`;
      this.#deps.bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId,
        payload: { agentSessionId, participant: seatName, detail: `seat parked (${reason}); provider session retained${reaped}` } });
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
    const seat = repo.getParticipant(agentSessionId, seatName);
    if (!session || session.status !== "open" || !seat) return;
    const tokenLimit = rotationTokenLimit(config.contextTokenLimit, seat.model ?? config.model);
    const hard = seat.turnCount >= config.contextTurnLimit || seat.contextTokens >= tokenLimit;
    const soft = seat.turnCount >= Math.ceil(config.contextTurnLimit * 0.8) || seat.contextTokens >= Math.ceil(tokenLimit * 0.75);
    if (!soft || (!hard && !seat.checkpointReady)) return;
    lane.state = "rotating";
    lane.rotationGate = new Promise((resolve) => { lane.releaseRotation = resolve; });
    try {
      lane.input?.close(); lane.input = null;
      const closing = lane.pump;
      lane.query?.close?.(); lane.query = null;
      await closing?.catch(() => undefined);
      const sdk = await this.#deps.sdk();
      const rotated = await this.#rotateNow(session, repo.getParticipant(agentSessionId, seatName) ?? seat, sdk, hard, tokenLimit);
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
   * Takes the LANE, not `lane.abort.signal`.
   *
   * Closing over the lane-wide signal meant a pending `ask_operator` could only
   * be cut by killing the whole lane — and worse, `#parkSeat` nulls `lane.abort`
   * WITHOUT aborting, so park, rotation and a watchdog interrupt each stranded
   * the parked promise and left its row `pending` forever. That is the
   * mechanical cause of db-live-2's orphan question, which is still unresolved
   * in that database today. Each ask now mints its own controller.
   */
  #buildParticipantMcp(sdk: ConsoleSdk, session: AgentSessionRow, seat: ParticipantRow, lane: SeatLane): unknown {
    // Messaging is native SendMessage (governed by the PreToolUse middleware);
    // this server carries only handoff retrieval and console-owned runtime.
    const profile = seat.profileSnapshot as AgentProfile;
    const user = this.#deps.repo.getUserSession(session.userSessionId);
    const workspaceRoot = user && this.#deps.getWorkspaceRoot ? this.#deps.getWorkspaceRoot(user.workspaceId) : "";
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
        // `post()` throws for a forbidden route and for a withheld final. Both
        // are things the SEAT must read and act on, so they come back as tool
        // errors rather than escaping the handler — the in-process MCP server's
        // behaviour on a throwing handler is not something to bet a gate on.
        let message: MessageRow;
        try {
          message = this.post({ agentSessionId: session.id, speaker: { kind: seat.name === ORCHESTRATOR_SEAT ? "orchestrator" : "agent", name: seat.name },
            to: args.to, handoff: draft, category: args.category, ...(args.dedupeKey ? { dedupeKey: args.dedupeKey } : {}),
            ...(this.#laneOf(session.id, seat.name).activeTurn ? { turnId: this.#laneOf(session.id, seat.name).activeTurn!.turnId } : {}) });
        } catch (error) {
          return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
        }
        const lane = this.#laneOf(session.id, seat.name);
        if (lane.activeTurn) lane.activeTurn.sawSend = true;
        return ok({ delivered: true, messageSeq: message.seq, to: args.to, category: args.category });
      }));
    // Console-owned ledger. Keyed on a synthetic id derived from the agent
    // session, so it survives context rotation and is shared by every seat —
    // the native Task* tools are per-provider-session, which meant the
    // db-live-1 coordinator watched its own four tasks vanish at the first
    // rotation and never touched the ledger again for 28 minutes.
    if (this.#deps.tasks && user) {
      const listId = consoleTaskListId(session.id);
      const attribution = { workspaceId: user.workspaceId, userSessionId: session.userSessionId, agentSessionId: session.id, participant: seat.name };
      tools.push(sdk.tool("task_list", "Read the AgentSession's task ledger. Authoritative and shared by every seat; it survives context rotation.", {},
        async () => ok({ tasks: this.#deps.tasks?.listForUserSession(session.userSessionId).filter((task) => task.agentSessionId === session.id) ?? [] })));
      if (seat.name === ORCHESTRATOR_SEAT) {
        tools.push(
          sdk.tool("task_create", "Add a unit of work to the ledger. Track every unit you delegate.", {
            taskId: z.string().min(1).describe("Short stable id you choose, e.g. \"1\" or \"interface\"."),
            subject: z.string().min(1), description: z.string().default(""),
            owner: z.string().min(1).describe("The seat that will DO this work — not you. The roster, the final caveats and the operator's run summary all read this."),
          }, async (args: { taskId: string; subject: string; description: string; owner: string }) => {
            const seats = new Set(this.#deps.repo.listParticipants(session.id).map((row) => row.name));
            if (!seats.has(args.owner)) {
              return { content: [{ type: "text" as const, text: `no seat named "${args.owner}" in this session; owners are one of: ${[...seats].join(", ")}` }], isError: true };
            }
            this.#deps.tasks?.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: args.taskId, subject: args.subject, description: args.description, owner: args.owner, attribution });
            return ok({ taskId: args.taskId, created: true, owner: args.owner });
          }),
          sdk.tool("task_update", "Update a ledger entry. Keep status honest as work progresses — the Console reports open tasks to the operator alongside your final.", {
            taskId: z.string().min(1),
            status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(),
            owner: z.string().optional(), subject: z.string().optional(), description: z.string().optional(),
            addBlockedBy: z.array(z.string()).optional(),
          }, async (args: { taskId: string; status?: "pending" | "in_progress" | "completed" | "deleted"; owner?: string; subject?: string; description?: string; addBlockedBy?: string[] }) => {
            const { taskId, ...patch } = args;
            this.#deps.tasks?.applyUpdate({ sdkSessionId: listId, sdkTaskId: taskId, patch });
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
      { artifactId: z.string().min(1), cursor: z.string().optional(), maxBytes: z.number().int().min(1).max(32 * 1024).default(8 * 1024) },
      async (args: { artifactId: string; cursor?: string; maxBytes: number }) => {
        const artifact = this.#deps.bus.getArtifact(args.artifactId);
        if (!artifact) return ok({ error: `no artifact ${args.artifactId}` });
        if (artifact.mediaType.startsWith("image/")) {
          // MCP's ImageContent is {type,data,mimeType} — NOT the Messages API's
          // nested `source`. The old shape failed schema validation on every
          // call, so db-live-2 captured three valid screenshots that no agent
          // could open and `check` reimplemented visual verification in
          // gl.readPixels instead. The `;base64` suffix is the storage
          // convention (bus.storeArtifact branches on it for byte accounting);
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
        const stored = this.#deps.bus.storeArtifact(
          `# ${args.title}\n\n${args.body}`,
          "text/markdown",
          { userSessionId: session.userSessionId, agentSessionId: session.id },
        );
        return ok({ ...stored, title: args.title,
          use: `Reference it as evidence: {"kind":"artifact","ref":"${stored.artifactId}"}` });
      }));
    if (this.#deps.handoffs) {
      tools.push(
        sdk.tool("read_handoff", "Retrieve a lossless handoff section with cursor pagination. Use only when the compact envelope is insufficient.", {
          handoffId: z.string(), section: z.enum(["core", "extension"]).default("core"), cursor: z.string().optional(), maxBytes: z.number().int().min(1).max(32 * 1024).default(8 * 1024),
        }, async (args: { handoffId: string; section: "core" | "extension"; cursor?: string; maxBytes: number }) => ok(this.#deps.handoffs?.read(args.handoffId, args.section, args.cursor, args.maxBytes))),
        sdk.tool("report_handoff_discrepancy", "Report a handoff claim contradicted by the repository, task ledger, journal, or artifact. The original evidence stays authoritative.", {
          handoffId: z.string(), claim: z.string().min(1), evidence: z.string().min(1),
        }, async (args: { handoffId: string; claim: string; evidence: string }) => {
          this.#deps.handoffs?.reportDiscrepancy(args.handoffId, seat.name, args.claim, args.evidence); return ok({ recorded: true });
        }),
      );
    }
    if (profile.runtime.shell && this.#deps.processes) {
      const scope = { workspaceRoot: seat.worktreePath ?? workspaceRoot, userSessionId: session.userSessionId, agentSessionId: session.id, participant: seat.name };
      const processOwner = `${session.id}:${seat.name}`;
      tools.push(
        sdk.tool("process_start", "Start a Console-owned long-running process. Pass an executable and argv separately; cwd must remain in the workspace.", { command: z.string(), args: z.array(z.string()).default([]), cwd: z.string().default(".") }, async (args: { command: string; args: string[]; cwd: string }) => ok(this.#deps.processes?.start(scope, args.command, args.args, args.cwd))),
        sdk.tool("process_read", "Read new process output, optionally waiting once for a state change. Use waitMs instead of polling. Output is paged tail-first (default 8KiB, newest last); use cursors for more, afterSeq for incremental reads.", { processId: z.string(), afterSeq: z.number().int().default(0), waitMs: z.number().int().min(0).max(60_000).default(0), cursor: z.string().optional(), maxBytes: z.number().int().min(1).max(32 * 1024).default(8 * 1024) }, async (args: { processId: string; afterSeq: number; waitMs: number; cursor?: string; maxBytes: number }) => {
          const result = await this.#deps.processes?.read(processOwner, args.processId, args.afterSeq, args.waitMs);
          if (!result) return ok(result);
          const text = result.chunks.map((chunk) => `[${chunk.stream} #${chunk.seq}] ${chunk.text}`).join("");
          return ok({ headSeq: result.headSeq, exit: result.exit, output: pageTail(text, args.cursor, args.maxBytes) });
        }),
        sdk.tool("process_stop", "Stop a process owned by this participant.", { processId: z.string() }, async (args: { processId: string }) => { this.#deps.processes?.stop(processOwner, args.processId); return ok({ stopped: true }); }),
      );
    }
    if (profile.runtime.browser && this.#deps.browsers) {
      const key = `${session.id}:${seat.name}`;
      tools.push(
        sdk.tool("browser_open", "Open a URL in the participant's managed local Chrome page.", { url: z.string() }, async (args: { url: string }) => ok(await this.#deps.browsers?.open(key, args.url))),
        sdk.tool("browser_snapshot", "Inspect current URL, title, and rendered body text.", {}, async () => ok(await this.#deps.browsers?.snapshot(key))),
        sdk.tool("browser_click", "Click a locator (CSS or Playwright text locator syntax).", { selector: z.string() }, async (args: { selector: string }) => { await this.#deps.browsers?.click(key, args.selector); return ok({ clicked: true }); }),
        sdk.tool("browser_fill", "Fill an input located by CSS or Playwright locator syntax.", { selector: z.string(), value: z.string() }, async (args: { selector: string; value: string }) => { await this.#deps.browsers?.fill(key, args.selector, args.value); return ok({ filled: true }); }),
        sdk.tool("browser_console", "Read browser console and page errors.", {}, async () => ok(await this.#deps.browsers?.consoleMessages(key))),
        sdk.tool("browser_press", "Press a key (e.g. \"ArrowLeft\", \"Enter\", \"Space\"). Use this to exercise keyboard-driven UI — games, shortcuts, form submission. Target the page by default, or a locator to focus first.", {
          keys: z.string().min(1), selector: z.string().optional(),
          repeat: z.number().int().min(1).max(100).default(1), delayMs: z.number().int().min(0).max(2_000).optional(),
        }, async (args: { keys: string; selector?: string; repeat: number; delayMs?: number }) =>
          ok(await this.#deps.browsers?.press(key, args.keys, { ...(args.selector ? { selector: args.selector } : {}), repeat: args.repeat, ...(args.delayMs === undefined ? {} : { delayMs: args.delayMs }) }))),
        sdk.tool("browser_evaluate", "Evaluate JavaScript in the page and return the result as JSON. Use it to read state the rendered text does not expose — localStorage, canvas/game state, module exports. Bare expressions and statement bodies both work. A result carrying `threw` means the page raised (a finding); `undefined:true` means the expression produced nothing, which is different from producing null.", {
          expression: z.string().min(1),
          timeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
        }, async (args: { expression: string; timeoutMs: number }) => {
          const outcome = await this.#deps.browsers?.evaluate(key, args.expression, args.timeoutMs);
          // Only a compile failure is the SEAT's error — that is its own
          // JavaScript failing to parse, and it is actionable. A page
          // exception or a null is data, and marking those `isError` would
          // feed the consecutive-error watchdog for legitimate probing.
          if (outcome?.compileError !== undefined) {
            return { content: [{ type: "text" as const, text: JSON.stringify(outcome) }], isError: true };
          }
          return ok(outcome);
        }),
      );
      if (profile.runtime.screenshots) {
        tools.push(sdk.tool("browser_screenshot", "Capture a full-page screenshot as a durable Console artifact.", {}, async () => ok(await this.#deps.browsers?.screenshot(key, { userSessionId: session.userSessionId, agentSessionId: session.id }))));
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
            return await this.#askOperator(session, seat, lane, args);
          } catch (error) {
            return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
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
        seats: this.#deps.repo.listParticipants(session.id).map((row) => ({
          name: row.name,
          profile: row.profileId,
          owns: row.ownership,
          state: this.#seatWorkState(row),
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
          maxBytes: z.number().int().min(1).max(32 * 1024).default(8 * 1024),
        },
        async (args: { url: string; method: "GET" | "HEAD" | "POST"; timeoutMs: number; maxBytes: number }) => {
          let parsed: URL;
          try { parsed = new URL(args.url); } catch { return ok({ error: `not a URL: ${args.url}` }); }
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return ok({ error: "http_probe accepts only http(s) URLs" });
          }
          const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
          const allowed = resolvedDomains(profile, this.#deps.config?.allowedDomains ?? []);
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

    {
      const contracts = this.#deps.contracts;
      if (seat.name === ORCHESTRATOR_SEAT) {
        tools.push(sdk.tool("declare_contract",
          "Declare a shared interface two or more seats must agree BEFORE any of them writes to it — a module signature, a data shape, a file format. The Console denies writes to the declared scopes until every party accepts. Use this whenever two seats' work has to fit together.",
          {
            name: z.string().min(1).max(60).describe("Short stable name, e.g. \"game-module\"."),
            body: z.string().min(1).describe("The interface itself: signatures, params, return shapes, shared constants. Concrete enough that a party could implement against it without asking you anything."),
            parties: z.array(z.string().min(1)).min(2).describe("Seat names that must agree. At least two — a contract with one party is a note."),
            scopes: z.array(z.string().min(1)).min(1).describe("Files or directories this governs; writes to them are gated on acceptance."),
          },
          async (args: { name: string; body: string; parties: string[]; scopes: string[] }) => {
            try {
              const contract = contracts.declare({
                agentSessionId: session.id, userSessionId: session.userSessionId,
                declaredBy: seat.name, name: args.name, body: args.body,
                parties: args.parties, scopes: args.scopes,
              });
              // The parties learn about it the same way they learn about
              // everything else — a journaled handoff through the star.
              for (const party of args.parties) {
                try {
                  this.post({ agentSessionId: session.id, speaker: { kind: "orchestrator", name: seat.name }, to: party,
                    handoff: this.#simpleHandoff(`Contract "${args.name}" needs your agreement`, "pending",
                      `${args.body}\n\nGoverns: ${args.scopes.join(", ")}. Parties: ${args.parties.join(", ")}.`,
                      `Read it with read_contract("${contract.id}") and accept_contract({contractId:"${contract.id}", revision:${contract.revision}}) — or propose_contract_amendment if it is wrong. You cannot write to the governed paths until you do.`),
                    category: "decision", dedupeKey: `contract:${contract.id}:${contract.revision}` });
                } catch { /* one unreachable party must not fail the declaration */ }
              }
              return ok(contract);
            } catch (error) {
              return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
            }
          }));
        tools.push(sdk.tool("supersede_contract", "Retire a contract that no longer describes the work.", {
          contractId: z.string().min(1), reason: z.string().min(1),
        }, async (args: { contractId: string; reason: string }) => {
          try { return ok(contracts.supersede(args.contractId, args.reason)); }
          catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
        }));
      }
      tools.push(sdk.tool("read_contract", "Read a shared-interface contract: its body, revision, and where each party stands.", {
        contractId: z.string().optional(), name: z.string().optional(),
      }, async (args: { contractId?: string; name?: string }) => {
        try {
          if (args.contractId) return ok(contracts.get(args.contractId));
          if (args.name) {
            const found = contracts.findByName(session.id, args.name);
            return ok(found ?? { error: `no open contract named ${args.name}` });
          }
          return ok({ contracts: contracts.listForSession(session.id) });
        } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
      }));
      tools.push(sdk.tool("accept_contract",
        "Accept a contract's CURRENT revision. Do this only once you have read it and can implement against it — accepting unblocks your writes to its scopes and tells the other parties you are building to this shape.",
        { contractId: z.string().min(1), revision: z.number().int().min(1) },
        async (args: { contractId: string; revision: number }) => {
          try { return ok(contracts.accept(args.contractId, seat.name, args.revision)); }
          catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
        }));
      tools.push(sdk.tool("propose_contract_amendment",
        "Change a contract you are party to. This bumps the revision and RESETS every acceptance, including your own — an amendment nobody re-agreed to would be a contract nobody agreed to. Use it when the shape is wrong, not to record a preference.",
        { contractId: z.string().min(1), body: z.string().min(1), rationale: z.string().min(1) },
        async (args: { contractId: string; body: string; rationale: string }) => {
          try {
            const contract = contracts.amend(args.contractId, seat.name, args.body, args.rationale);
            for (const party of contract.parties.map((entry) => entry.participant)) {
              if (party === seat.name) continue;
              try {
                this.post({ agentSessionId: session.id, speaker: { kind: seat.name === ORCHESTRATOR_SEAT ? "orchestrator" : "agent", name: seat.name },
                  to: party === ORCHESTRATOR_SEAT || seat.name === ORCHESTRATOR_SEAT ? party : ORCHESTRATOR_SEAT,
                  handoff: this.#simpleHandoff(`Contract "${contract.name}" amended to revision ${contract.revision}`, "pending",
                    `${args.rationale}\n\n${contract.body}`,
                    `Re-read and accept revision ${contract.revision}; your earlier acceptance no longer applies.`),
                  category: "decision", dedupeKey: `contract:${contract.id}:${contract.revision}` });
              } catch { /* notification is best effort */ }
            }
            return ok(contract);
          } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
        }));
      tools.push(sdk.tool("object_to_contract",
        "Say a contract is wrong without proposing the fix yourself. Reopens it for amendment and tells the coordinator why.",
        { contractId: z.string().min(1), reason: z.string().min(1) },
        async (args: { contractId: string; reason: string }) => {
          try { return ok(contracts.object(args.contractId, seat.name, args.reason)); }
          catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
        }));
    }
    if (seat.name === ORCHESTRATOR_SEAT && this.#deps.worktrees) {
      tools.push(sdk.tool("start_attempts", "Run best-of-N parallel attempts at one high-stakes assignment: N isolated worktree seats race the same work, a fresh reviewer picks the winner, and only the winner's changes merge into the workspace. Requires the workspace to be a git repository. One active group at a time.", {
        assignment: HandoffDraftSchema, profileId: z.string().default("implementer"), attempts: z.number().int().min(2).max(3).default(2),
        baseSeatName: z.string().optional(), owns: z.array(z.string()).min(1), instructions: z.string().optional(), model: z.string().optional(),
      }, async (args: { assignment: HandoffDraft; profileId: string; attempts: number; baseSeatName?: string; owns: string[]; instructions?: string; model?: string }) => {
        try {
          return ok(this.startAttempts({ agentSessionId: session.id, assignment: args.assignment, profileId: args.profileId,
            attempts: args.attempts, ...(args.baseSeatName ? { baseSeatName: args.baseSeatName } : {}), owns: args.owns,
            ...(args.instructions ? { instructions: args.instructions } : {}), ...(args.model ? { model: args.model } : {}) }));
        } catch (error) {
          return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
        }
      }));
    }
    if (seat.attemptRole === "reviewer" && seat.attemptGroupId && this.#deps.worktrees) {
      const groupId = seat.attemptGroupId;
      tools.push(
        sdk.tool("read_attempt_diff", "Read one attempt's captured diff (paged tail-first; cursors continue).", {
          seat: z.string(), cursor: z.string().optional(), maxBytes: z.number().int().min(1).max(32 * 1024).default(8 * 1024),
        }, async (args: { seat: string; cursor?: string; maxBytes: number }) => {
          const group = this.#deps.repo.getAttemptGroup(groupId);
          const artifactId = group?.attemptsState[args.seat]?.artifactId;
          if (!artifactId) return { content: [{ type: "text", text: `no captured diff for attempt seat "${args.seat}"` }], isError: true };
          const artifact = this.#deps.bus.getArtifact(artifactId);
          if (!artifact) return { content: [{ type: "text", text: `diff artifact ${artifactId} is missing` }], isError: true };
          return ok({ seat: args.seat, artifactId, diff: pageTail(artifact.content, args.cursor, args.maxBytes) });
        }),
        sdk.tool("select_attempt_winner", "Declare the winning attempt (merged into the workspace immediately) or reject all. Exactly one call; the structured result reports the real merge outcome.", {
          winner: z.string().optional(), rejectAll: z.boolean().default(false), reason: z.string().min(1),
        }, async (args: { winner?: string; rejectAll: boolean; reason: string }) => {
          try {
            return ok(this.selectAttemptWinner({ agentSessionId: session.id, groupId, reviewer: seat.name,
              ...(args.winner ? { winner: args.winner } : {}), rejectAll: args.rejectAll, reason: args.reason }));
          } catch (error) {
            return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
          }
        }),
      );
    }
    // alwaysLoad: the profile already decided this seat's tools. Deferring them
    // behind ToolSearch made every seat spend a round-trip rediscovering what
    // the console had granted it — 21 lookups in db-live-1, and a seat that
    // wrongly concluded it lacked a capability it had.
    return sdk.createSdkMcpServer({ name: "console_agent", version: "2", tools, alwaysLoad: true });
  }

  #runtimeToolNames(profile: AgentProfile, participant: string, attemptRole?: string | null): string[] {
    return ["mcp__console_agent__send_handoff", "mcp__console_agent__read_handoff", "mcp__console_agent__report_handoff_discrepancy",
      "mcp__console_agent__task_list", "mcp__console_agent__read_artifact", "mcp__console_agent__write_note", "mcp__console_agent__roster_status",
      ...(profile.runtime.shell ? ["mcp__console_agent__http_probe"] : []),
      "mcp__console_agent__read_contract", "mcp__console_agent__accept_contract", "mcp__console_agent__propose_contract_amendment", "mcp__console_agent__object_to_contract",
      ...(this.#deps.contracts && participant === ORCHESTRATOR_SEAT ? ["mcp__console_agent__declare_contract", "mcp__console_agent__supersede_contract"] : []),
      ...(participant === ORCHESTRATOR_SEAT ? ["mcp__console_agent__task_create", "mcp__console_agent__task_update"] : []),
      ...(profile.runtime.shell ? ["mcp__console_agent__process_start", "mcp__console_agent__process_read", "mcp__console_agent__process_stop"] : []),
      ...(profile.runtime.browser ? ["mcp__console_agent__browser_open", "mcp__console_agent__browser_snapshot", "mcp__console_agent__browser_click", "mcp__console_agent__browser_fill", "mcp__console_agent__browser_console", "mcp__console_agent__browser_press", "mcp__console_agent__browser_evaluate"] : []),
      ...(profile.runtime.browser && profile.runtime.screenshots ? ["mcp__console_agent__browser_screenshot"] : []),
      // Every seat can reach the operator, so this is unconditional.
      "mcp__console_agent__ask_operator",
      ...(participant === ORCHESTRATOR_SEAT && this.#deps.worktrees ? ["mcp__console_agent__start_attempts"] : []),
      ...(attemptRole === "reviewer" ? ["mcp__console_agent__select_attempt_winner", "mcp__console_agent__read_attempt_diff"] : []),
    ];
  }

  #snapshotProfile(profile: AgentProfile): AgentProfile {
    if (profile.source !== "workspace" || !profile.pluginPath || !profile.revision || !this.#deps.config) return profile;
    const parent = path.join(this.#deps.config.dataDir, "profile-snapshots");
    const target = path.join(parent, profile.revision);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(parent, { recursive: true });
      const temp = path.join(parent, `.${profile.revision}-${newId("artifact")}`);
      try { fs.cpSync(profile.pluginPath, temp, { recursive: true, dereference: true }); fs.renameSync(temp, target); }
      catch (error) { if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true }); if (!fs.existsSync(target)) throw error; }
    }
    return { ...profile, pluginPath: target };
  }

  #composePrompt(session: AgentSessionRow, seat: ParticipantRow, rows: MessageRow[]): string {
    // At up to 20 seats the roster header is advisory: render at most three
    // scopes per seat; the full ownership list stays in the DB and the API.
    const roster = this.#deps.repo.listParticipants(session.id).map((p) => {
      const scopes = p.ownership.slice(0, 3).join(", ") + (p.ownership.length > 3 ? ` +${p.ownership.length - 3} more` : "");
      // Seat worktree state on every line: the coordinator otherwise has no
      // way to see in-progress work and infers absence from `ls` on the shared
      // workspace — which cost db-live-1 ten minutes and three generations.
      return `${p.name} (${p.profileId}; ${capabilityTag(p.profileSnapshot as AgentProfile)}; owns: ${scopes || "coordination"}; ${this.#seatWorkState(p)})`;
    }).join("; ");
    const messages = rows.map((row) => {
      const id = (row.payload?.handoff as { id?: string } | undefined)?.id;
      if (!id || !this.#deps.handoffs) return `[${row.speakerName} → ${row.toName} | ${row.createdAt}] ${row.text}`;
      const handoff = this.#deps.handoffs.get(id);
      const expanded = handoff.core.risk === "high" || handoff.core.status === "needs_verification" || handoff.core.requestExpandedContext;
      this.#deps.bus.append({ type: "handoff.consumed", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { handoffId: id, participant: seat.name, mode: expanded ? "expanded" : "compact" } });
      // Rendered in SEND shape, not as a top-level `CORE:` blob. The flat
      // rendering was the seat's only worked example of a handoff, so it
      // taught the exact mistake the middleware then rejected.
      return `[${row.speakerName} → ${row.toName} | ${row.createdAt}] Handoff ${id}\n${JSON.stringify({ handoff: { core: handoff.core, extension: expanded ? handoff.extension : undefined } }, null, 2)}${expanded ? "" : `\nExtension ${handoff.extension.kind} is available with read_handoff.`}`;
    }).join("\n\n");
    // The operator's answers to THIS seat's own questions. This delivery does
    // not exist in the pre-release console at all: a deferred ask returned
    // "their answer will reach you" and then nothing ever did. Rendered before
    // the handoffs because it outranks them — an operator decision is not a
    // claim to be verified.
    const answered = this.#deps.interactions.listAnsweredUnflushed(session.id, seat.name);
    const decisions = answered.map((row) => summarizeAnswer(row)).filter((line) => line !== "");
    if (decisions.length > 0) this.#deps.interactions.markFlushed(answered.map((row) => row.id));
    const answersBlock = decisions.length === 0 ? ""
      : `## The operator answered your question(s)\nAuthoritative — act on these and do not ask again.\n${decisions.map((line) => `- ${line}`).join("\n")}\n\n`;
    // Decisions made since this seat's last delivery — including ones it never
    // asked for. A LIVE seat may not respawn for hours, so the system prompt's
    // digest (written at spawn) is stale for exactly the seats that are busy.
    //
    // The DELTA only, never the whole list: a long session would otherwise
    // re-send an ever-growing block on every delivery. And omitted entirely
    // when empty, so the common-path prompt is byte-identical to what it was
    // before this feature existed — asserted in decision-ledger.e2e.test.ts,
    // because a block that renders empty would change every prompt in every
    // session and silently destroy prompt caching.
    const fresh = this.#deps.decisions.since(session.userSessionId, seat.lastDecisionAt);
    const unseen = fresh.filter((row) => row.askedBy !== seat.name);
    if (fresh.length > 0) {
      this.#deps.repo.patchParticipant(session.id, seat.name, { lastDecisionAt: fresh[fresh.length - 1]!.createdAt });
    }
    const freshBlock = unseen.length === 0 ? ""
      : `## New operator decisions since your last delivery\nAuthoritative — these were decided for this whole session, not just for the seat that asked.\n${unseen.map((row) => `- ${renderDecision(row)}`).join("\n")}\n\n`;
    return `AgentSession ${session.id}: ${session.title}\nYou are ${seat.name}. Participants: ${roster}.\n\n${answersBlock}${freshBlock}Only the following addressed handoffs are new:\n${messages}\n\nTreat handoff claims as historical context; verify risky claims against repository/task/journal evidence during normal work. Act without restating the envelope. Set checkpointReadiness=defer only while state is genuinely unstable.`;
  }

  /**
   * The successor's inheritance when the model could not produce a checkpoint.
   *
   * Built from facts the console owns — the task ledger, the seat's declared
   * ownership, its worktree branch and diff, the assignment it is working, and
   * its own last report. It therefore always exists and is always true, where
   * the old fallback reused whatever message happened to be latest and
   * degraded a little further each generation (db-live-1's coordinator
   * inherited another seat's report, then a junk probe, then 395 bytes of
   * "Turn failed"). A failed model checkpoint should cost fidelity, not truth.
   */
  #reconstructCheckpoint(session: AgentSessionRow, seat: ParticipantRow): HandoffDraft {
    const { repo } = this.#deps;
    const evidence: HandoffDraft["core"]["state"]["evidence"] = [];
    const facts: string[] = [];

    const assignment = repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, participant: seat.name, excludeCheckpoints: true });
    const own = repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, sender: seat.name, excludeCheckpoints: true });

    if (seat.ownership.length > 0) facts.push(`Owns: ${seat.ownership.join(", ")}.`);
    // Before the task ledger, deliberately: an operator decision outranks
    // model-maintained state, and rotation is exactly where db-live-1's
    // "DODGE" would have died even if it HAD reached the seats.
    const decisions = this.#deps.decisions.lines(session.userSessionId, { max: 12 });
    if (decisions.length > 0) facts.push(`Operator decisions (Console-recorded, authoritative — do not contradict):\n${decisions.map((line) => `- ${line}`).join("\n")}`);
    const taskLines = this.#deps.tasks?.linesForAgentSession(session.id) ?? [];
    if (taskLines.length > 0) facts.push(`Task ledger:\n${taskLines.join("\n")}`);
    if (seat.worktreePath && this.#deps.worktrees && seat.worktreeBranch && seat.worktreeBaseCommit) {
      try {
        const diff = this.#deps.worktrees.captureDiff(seat.worktreePath, seat.worktreeBaseCommit, seat.worktreeBranch);
        facts.push(`Isolated worktree ${seat.worktreeBranch}: ${diff.stat || "no changes yet"}. Not visible in the shared workspace until you report completed.`);
      } catch { facts.push(`Isolated worktree ${seat.worktreeBranch} (diff unavailable).`); }
    }
    if (assignment) {
      facts.push(`Current assignment from ${assignment.sender}: ${assignment.core.action}${assignment.core.nextAction ? ` — next: ${assignment.core.nextAction}` : ""}`);
      evidence.push({ kind: "journal", ref: assignment.id, label: `assignment from ${assignment.sender}` });
    }
    if (own) {
      facts.push(`Your last report (${own.core.status}): ${own.core.state.summary.slice(0, 600)}`);
      evidence.push({ kind: "journal", ref: own.id, label: "your last report" });
    }

    return {
      core: {
        schemaVersion: 1,
        taskId: own?.core.taskId ?? assignment?.core.taskId ?? null,
        status: "needs_verification",
        risk: "high",
        action: recoveryAction(assignment?.core.action ?? own?.core.action ?? "Resume interrupted work"),
        state: {
          summary: `Context was rotated before ${seat.name} could write a checkpoint, so this was reconstructed by the Console from authoritative state — not from the previous context's memory. Treat it as a starting point and re-derive anything not listed.\n\n${facts.join("\n")}`,
          evidence,
        },
        result: { summary: null, artifacts: [] },
        uncertainty: ["Reconstructed checkpoint: the prior context's reasoning and any unreported findings were lost. Re-verify before reporting completion."],
        nextAction: assignment?.core.nextAction ?? own?.core.nextAction ?? "Re-read the assignment and continue.",
        requestExpandedContext: true,
      },
      extension: { kind: (seat.profileSnapshot as AgentProfile).handoffExtension ?? "generic", data: { source: "reconstructed" } },
    };
  }

  /**
   * Cross-seat dependency drift, read from the merged diff rather than from
   * anything a seat declared.
   *
   * Disjoint file ownership stops seats from colliding on files, but not on
   * facts: in db-live-1 `page` pinned three@0.169.0 in an import map while
   * `renderer` imported 0.160.0 by URL — the version the operator specified.
   * Three agents examined that graph and all three called it fine. The
   * evidence was in the diffs all along.
   */
  #checkDependencyDrift(session: AgentSessionRow, seat: ParticipantRow, patch: string): void {
    const seen = this.#dependencyPins.get(session.id) ?? new Map<string, { version: string; seat: string }>();
    this.#dependencyPins.set(session.id, seen);
    for (const { name, version } of dependencyPinsInPatch(patch)) {
      const prior = seen.get(name);
      if (!prior) { seen.set(name, { version, seat: seat.name }); continue; }
      if (prior.version === version || prior.seat === seat.name) continue;
      this.#deps.bus.append({ type: "agent_session.dependency_drift", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, dependency: name, versions: [{ seat: prior.seat, version: prior.version }, { seat: seat.name, version }] } });
      this.post({ agentSessionId: session.id, speaker: { kind: "agent", name: seat.name }, to: ORCHESTRATOR_SEAT,
        handoff: this.#simpleHandoff(`Dependency drift on ${name}`, "needs_verification",
          `${prior.seat} landed ${name}@${prior.version} and ${seat.name} landed ${name}@${version}. Two versions of one dependency in a single build load twice and fail cross-module identity checks. Neither seat can see this — their files are disjoint.`,
          `Decide the single version for ${name} and have the owning seat align.`), category: "failure" });
      seen.set(name, { version, seat: seat.name });
    }
  }

  /** One-line, always-true summary of a seat's unmerged work. */
  /**
   * What this seat is doing right now, in one clause, from facts the console
   * owns. Rendered for EVERY seat — the worktree diff is the richest variant,
   * not the only one.
   *
   * db-live-2's workspace was not a git repo, so no seat had a worktree and the
   * roster degraded to name/profile/owns. Blind to each other, `renderer` built
   * a private duplicate of the dev server `page` had already written (~16 min),
   * then re-ran `check`'s entire verification job (~7 min of a $2.62 turn whose
   * real deliverable was a one-line edit), and the two of them independently
   * diagnosed the same CDN outage without ever telling each other.
   */
  #seatWorkState(seat: ParticipantRow): string {
    const facts: string[] = [];
    const lane = this.#seats.get(seat.agentSessionId)?.get(seat.name);
    if (lane?.activeTurn) facts.push("working now");
    else if (lane?.state === "live") facts.push("live, between turns");
    else if (seat.turnCount > 0) facts.push(`parked after ${seat.turnCount} turn(s)`);
    else facts.push("not started");
    if (seat.latestHandoffId && this.#deps.handoffs) {
      try {
        const last = this.#deps.handoffs.get(seat.latestHandoffId);
        facts.push(`last reported ${last.core.status}: ${last.core.action}`);
      } catch { /* a handoff we cannot read tells the roster nothing */ }
    }
    if (seat.worktreePath && seat.worktreeBranch && seat.worktreeBaseCommit && this.#deps.worktrees) {
      try {
        const diff = this.#deps.worktrees.captureDiff(seat.worktreePath, seat.worktreeBaseCommit, seat.worktreeBranch);
        facts.push(diff.filesChanged === 0
          ? "unmerged worktree, nothing written yet"
          : `unmerged worktree: ${diff.filesChanged} file(s) +${diff.insertions}/-${diff.deletions}, not visible in the workspace until they report completed`);
      } catch { facts.push("unmerged worktree (state unavailable)"); }
    }
    return facts.join("; ");
  }

  #simpleHandoff(action: string, status: HandoffDraft["core"]["status"], summary: string, nextAction: string | null): HandoffDraft {
    return { core: { schemaVersion: 1, taskId: null, status, risk: status === "failed" || status === "blocked" ? "high" : "medium",
      action, state: { summary, evidence: [] }, result: { summary: null, artifacts: [] }, uncertainty: [], nextAction,
      requestExpandedContext: status === "failed" }, extension: { kind: "generic", data: {} } };
  }

  /**
   * The checkpoint-and-rotate body, run by #maybeRotate under its gate after
   * the seat's process has closed. Returns the successor participant row.
   */
  async #rotateNow(session: AgentSessionRow, seat: ParticipantRow, sdk: ConsoleSdk, hard: boolean, tokenLimit: number): Promise<ParticipantRow> {
    const config = this.#deps.config;
    if (!config || !this.#deps.handoffs) return seat;
    const threshold = hard ? "hard" as const : "soft" as const;
    const started = Date.now();
    const holder: { query: QueryHandle | null } = { query: null };
    let { draft, failure } = await this.#checkpointQuery(session, seat, sdk, holder, "");
    // Deterministic quality gate with one feedback retry: the checkpoint is
    // the successor's only inheritance, so a structurally weak draft gets one
    // chance to fix the named failures before the threshold rules decide.
    if (draft && this.#deps.handoffs) {
      const gate = (candidate: HandoffDraft) => evaluateCheckpointDraft({ draft: candidate,
        referenceWarnings: this.#deps.handoffs!.referenceWarnings(session.userSessionId, [...candidate.core.state.evidence, ...candidate.core.result.artifacts]),
        taskResolves: candidate.core.taskId == null ? null : this.#deps.repo.hasDurableReference("task", candidate.core.taskId) });
      const initialFailures = gate(draft);
      if (initialFailures.length > 0) {
        this.#deps.bus.append({ type: "handoff.checkpoint.retried", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { participant: seat.name, threshold, failures: initialFailures, accepted: "none" } });
        const retry = await this.#checkpointQuery(session, seat, sdk, holder,
          `\n\nA previous checkpoint attempt failed these deterministic checks — fix each one:\n- ${initialFailures.join("\n- ")}`);
        const retryFailures = retry.draft ? gate(retry.draft) : null;
        if (retry.draft && retryFailures !== null && retryFailures.length === 0) {
          draft = retry.draft;
          this.#deps.bus.append({ type: "handoff.checkpoint.retried", userSessionId: session.userSessionId, agentSessionId: session.id,
            payload: { participant: seat.name, threshold, failures: [], accepted: "retry" } });
        } else if (!hard) {
          this.#deps.bus.append({ type: "handoff.checkpoint.failed", userSessionId: session.userSessionId, agentSessionId: session.id,
            payload: { participant: seat.name, reason: "checkpoint failed the quality gate", threshold, degraded: false,
              checkFailures: retryFailures ?? initialFailures } });
          return seat;
        } else {
          // Hard threshold: rotation cannot wait — accept the better draft.
          const useRetry = retry.draft !== null && retryFailures !== null && retryFailures.length <= initialFailures.length;
          draft = useRetry ? retry.draft : draft;
          this.#deps.bus.append({ type: "handoff.checkpoint.retried", userSessionId: session.userSessionId, agentSessionId: session.id,
            payload: { participant: seat.name, threshold, failures: useRetry ? retryFailures ?? [] : initialFailures, accepted: useRetry ? "retry" : "initial" } });
        }
      }
    }
    let degraded = false;
    if (!draft) {
      // A 4xx means the request never reached the model — that is a console
      // bug, not a model failure, and a fabricated checkpoint would be strictly
      // worse than the working context we already have. Keep the context.
      if (isTransportFailure(failure)) {
        this.#deps.bus.append({ type: "handoff.checkpoint.transport_failed", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { participant: seat.name, reason: failure ?? "checkpoint request failed", threshold } });
        return seat;
      }
      if (!hard) {
        this.#deps.bus.append({ type: "handoff.checkpoint.failed", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { participant: seat.name, reason: failure ?? "checkpoint produced no valid handoff", threshold, degraded: false } });
        return seat;
      }
      degraded = true;
      draft = this.#reconstructCheckpoint(session, seat);
      this.#deps.bus.append({ type: "handoff.checkpoint.failed", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { participant: seat.name, reason: failure ?? "checkpoint produced no valid handoff", threshold, degraded: true } });
    }
    const prepared = this.#deps.handoffs.prepare({ draft, userSessionId: session.userSessionId, agentSessionId: session.id,
      sender: seat.name, recipient: seat.name, profileId: seat.profileId, generation: seat.generation,
      extensionKind: (seat.profileSnapshot as AgentProfile).handoffExtension,
      trigger: degraded ? "recovery" : "rotation", parentHandoffId: seat.latestHandoffId, checkpoint: true });
    this.#deps.repo.insertCheckpointHandoff(prepared.row);
    this.#deps.handoffs.committed(prepared.record);
    // Rotation retires the provider session, so its cumulative baseline retires
    // with it — the successor genuinely starts from zero.
    this.#deps.repo.patchParticipant(session.id, seat.name, { sdkSessionId: null, generation: seat.generation + 1, turnCount: 0, contextTokens: 0, latestHandoffId: prepared.row.id, checkpointReady: true, cumulativeCostUsd: 0, cumulativeApiDurationMs: 0 });
    const fresh = this.#deps.repo.getParticipant(session.id, seat.name) ?? seat;
    this.#deps.bus.append({ type: "agent_session.context.rotated", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, participant: seat.name, generation: seat.generation + 1,
        reason: seat.contextTokens >= Math.ceil(tokenLimit * 0.75) ? "token_limit" : "turn_limit", memoryChars: 0,
        handoffId: prepared.row.id, threshold, checkpointBytes: prepared.row.bytes, degraded } });
    this.#deps.bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, participant: seat.name, detail: `checkpoint ${prepared.row.id} completed in ${Date.now() - started}ms` } });
    return fresh;
  }

  /** One tool-free checkpoint query against the seat's current context. */
  async #checkpointQuery(session: AgentSessionRow, seat: ParticipantRow, sdk: ConsoleSdk, flight: { query: QueryHandle | null }, promptSuffix: string): Promise<{ draft: HandoffDraft | null; failure: string | null }> {
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
    const checkpointDeadline = setTimeout(() => checkpointAbort.abort(), CHECKPOINT_TIMEOUT_MS);
    checkpointDeadline.unref?.();
    const query = sdk.query({ prompt: `Create a lossless rotation checkpoint for your successor context. Capture only durable task state, verified evidence pointers, results, uncertainty, and the exact next action. Do not perform work or call tools.${promptSuffix}`, options: {
      cwd: checkpointRoot, systemPrompt: { type: "preset", preset: "claude_code", append: "You are checkpointing your own context. Report faithfully; do not correct or embellish uncertain state." },
      settingSources: [], includePartialMessages: false, permissionMode: "plan", allowedTools: [],
      disallowedTools: ["Agent", "SendMessage", "Task", "Bash", "Edit", "Write", "WebSearch", "WebFetch"],
      // MUST be object-rooted: the CLI turns this into a synthetic
      // `StructuredOutput` tool and ships it verbatim as input_schema, and the
      // API rejects anything whose root `type` is not the string "object".
      outputFormat: { type: "json_schema", schema: HANDOFF_DRAFT_JSON_SCHEMA }, maxTurns: 2,
      sandbox: { enabled: true, failIfUnavailable: profile.sandboxRequired, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
        filesystem: { allowManagedReadPathsOnly: true, allowRead: seat.worktreePath ? [checkpointRoot, this.#deps.getWorkspaceRoot(user.workspaceId)] : [checkpointRoot], allowWrite: [] } },
      env: sdkEnv(), abortController: checkpointAbort, persistSession: true, sessionStore: this.#deps.sessionStore as never,
      sessionStoreFlush: "eager", resume: seat.sdkSessionId, ...(seat.model ? { model: seat.model } : {}),
      ...((profile.effort ?? config?.effort) ? { effort: (profile.effort ?? config?.effort) as SdkOptions["effort"] } : {}),
    } });
    flight.query = query;
    // A separate process, but `resume: seat.sdkSessionId` above means it is the
    // SAME provider session — so its cumulative totals continue the seat's, and
    // its baseline is the seat's. Starting from zero here would bill the whole
    // session-to-date to one checkpoint pseudo-turn. (This never fired in
    // db-live-1 only because all 13 checkpoints died on a provider 400 before
    // any result carried usage.)
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
    finally { clearTimeout(checkpointDeadline); flight.query = null; query.close?.(); }
    return { draft, failure };
  }

  /**
   * Everything the operator has decided, injected into the VOLATILE TAIL of a
   * seat's system prompt.
   *
   * Placement is load-bearing. The append is ordered deliberately (`#spawnSeat`
   * says so): instructions, capabilities and messaging brief are byte-identical
   * across generations so they cache, and the volatile checkpoint goes last.
   * Decisions sit between SESSION_PROTOCOL and the checkpoint — after the
   * invariant head, so nothing that used to cache stops caching, and BEFORE the
   * checkpoint, because an operator decision outranks a model-authored summary
   * of state.
   *
   * Cache-safe because the system prompt is assembled only at spawn, never per
   * turn. A new decision therefore invalidates nothing that was not already
   * being rebuilt.
   */
  #decisionContext(session: AgentSessionRow): string {
    const digest = this.#deps.decisions.digest(session.userSessionId);
    if (digest === "") return "";
    return `\n\n## Operator decisions (authoritative)\nThe operator made these. Do not re-litigate them, do not contradict them, and do not ask again.\n${digest}`;
  }

  #checkpointContext(seat: ParticipantRow): string {
    if (seat.latestHandoffId && this.#deps.handoffs) {
      const handoff = this.#deps.handoffs.get(seat.latestHandoffId);
      return `\n\n## Rotation checkpoint ${handoff.metadata.id}\n${JSON.stringify({ core: handoff.core, extension: handoff.extension }, null, 2)}`;
    }
    return seat.memory ? `\n\n## Read-only legacy context memory\n${seat.memory}` : "";
  }

  #recordNarration(session: AgentSessionRow, participant: string, text: string, turnId: string): void {
    const row = this.#deps.repo.appendMessage({ sessionKind: "agent", sessionId: session.id, speaker: { kind: participant === ORCHESTRATOR_SEAT ? "orchestrator" : "agent", name: participant }, kind: "notice", text, turnId, payload: { channel: "model_output" } });
    this.#deps.bus.append({ type: "agent_session.message", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { agentSessionId: session.id, message: toWireMessage(row) } });
  }

  /**
   * `cumulativeCostUsd`/`cumulativeApiDurationMs` restate the provider
   * session's running total on every result, so the per-turn figure is the
   * delta against what this lane last saw. Recording them raw overstated the
   * db-live-1 ledger by 25% and produced an api-duration 20x the wall clock.
   */
  #recordUsage(session: AgentSessionRow, seat: ParticipantRow, cumulative: { costUsd: number; apiDurationMs: number }, turnId: string, usageEvent: { inputTokens?: number; uncachedInputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; outputTokens?: number; cumulativeCostUsd?: number; modelId?: string; cumulativeApiDurationMs?: number; sdkDurationMs?: number; stopReason?: string }, status: "completed" | "error" | "aborted" = "completed", durationMs?: number, trigger = "delivery"): void {
    // Every settled turn gets a row, including one that burned wall clock and
    // bought nothing. A zero-token `error` is the MOST interesting row in the
    // ledger — db-live-2's two DNS-dead orchestrator turns consumed 9m11s
    // between them and were invisible to billing, while renderer's errored
    // turn WAS recorded. Skipping them made failure accounting inconsistent
    // with the runner, which has always recorded unconditionally.
    const empty = (usageEvent.inputTokens ?? 0) === 0 && (usageEvent.outputTokens ?? 0) === 0;
    if (empty && status === "completed") return; // a genuine CLI-level artifact
    // The SDK restates the provider session's running total on every result,
    // so a turn's figure is the delta against what we last saw. If the total
    // came back BELOW the baseline the counter restarted underneath us (a
    // fresh session on the same seat) — take the raw value rather than
    // clamping a real turn to zero. That makes this correct under either SDK
    // behaviour, which matters because the documented one ("resumed sessions
    // start fresh") is contradicted by the db-live-1 data.
    const rebased = usageEvent.cumulativeCostUsd !== undefined && usageEvent.cumulativeCostUsd < cumulative.costUsd;
    if (rebased) { cumulative.costUsd = 0; cumulative.apiDurationMs = 0; }
    const costUsd = usageEvent.cumulativeCostUsd === undefined ? null
      : Math.max(0, usageEvent.cumulativeCostUsd - cumulative.costUsd);
    const apiDurationMs = usageEvent.cumulativeApiDurationMs === undefined ? null
      : Math.max(0, usageEvent.cumulativeApiDurationMs - cumulative.apiDurationMs);
    if (usageEvent.cumulativeCostUsd !== undefined) cumulative.costUsd = usageEvent.cumulativeCostUsd;
    if (usageEvent.cumulativeApiDurationMs !== undefined) cumulative.apiDurationMs = usageEvent.cumulativeApiDurationMs;
    // Persist the new baseline with the seat, so the next process to resume
    // this provider session inherits it instead of restarting from zero.
    this.#deps.repo.patchParticipant(session.id, seat.name, {
      cumulativeCostUsd: cumulative.costUsd, cumulativeApiDurationMs: cumulative.apiDurationMs,
    });
    const usage = { id: newId("usage"), userSessionId: session.userSessionId, agentSessionId: session.id, participant: seat.name, profileId: seat.profileId,
      generation: seat.generation, turnId, inputTokens: usageEvent.inputTokens ?? 0, uncachedInputTokens: usageEvent.uncachedInputTokens ?? 0,
      cacheCreationInputTokens: usageEvent.cacheCreationInputTokens ?? 0, cacheReadInputTokens: usageEvent.cacheReadInputTokens ?? 0,
      outputTokens: usageEvent.outputTokens ?? 0, costUsd,
      model: usageEvent.modelId ?? seat.model, effort: (seat.profileSnapshot as AgentProfile).effort ?? this.#deps.config?.effort ?? null,
      trigger, durationMs: durationMs ?? null, apiDurationMs, sdkDurationMs: usageEvent.sdkDurationMs ?? null, status, stopReason: usageEvent.stopReason ?? null, createdAt: nowIso() };
    this.#deps.repo.insertUsage(usage);
    this.#deps.bus.append({ type: "usage.recorded", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { sessionId: session.id, participant: seat.name, profileId: seat.profileId, generation: seat.generation, turnId,
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
    // Reading it off the in-memory `delivery` here is what produced db-live-2's
    // fabricated 400-second latencies — those objects are snapshots taken
    // before the `delivered` patch.
    this.#deps.repo.patchDelivery(delivery.id, { status, ...(status === "delivered" ? { deliveredAt: now } : {}), ...(status === "acknowledged" ? { acknowledgedAt: now, deliveredAt: now } : {}) });
    const message = this.#deps.repo.getMessageById(delivery.messageId);
    this.#deps.bus.append({ type: "agent_session.mailbox", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, deliveryId: delivery.id, messageSeq: message?.seq ?? 0, sender: delivery.sender, recipient: delivery.recipient, category: delivery.category, status } });
  }

  #specialists(id: string): ParticipantRow[] { return this.#deps.repo.listParticipants(id).filter((p) => p.role === "agent"); }
  #sessionStatus = new Map<string, AgentSessionStatus | null>();
  /** Sessions whose operator obligation is closed — reported, or discharged. */
  readonly #operatorDebtSettled = new Set<string>();
  /** agentSessionId → dependency name → the version last merged, and by whom. */
  readonly #dependencyPins = new Map<string, Map<string, { version: string; seat: string }>>();
  #refreshStatus(agentSessionId: string): void {
    const row = this.#deps.repo.getAgentSession(agentSessionId);
    if (!row || row.status !== "open") return;
    const status = this.#statusOf(row) === "working" ? "working" : "idle";
    this.#setStatus(agentSessionId, status);
    if (status === "idle") this.#dischargeOperatorDebt(row);
  }

  /**
   * An AgentSession that accepted an assignment owes the operator a reply. The
   * coordinator is asked to send it, but the obligation is the CONSOLE's — in
   * db-live-1 the session simply went idle with `owedToOrchestrator: false`
   * hardcoded, and the operator's last information was 35 minutes stale while
   * a finished review sat unreported in the journal.
   *
   * Discharged from whatever evidence exists: the coordinator's last report,
   * or failing that every seat's last word. An incomplete report beats silence.
   */
  #dischargeOperatorDebt(session: AgentSessionRow): void {
    if (this.#operatorDebtSettled.has(session.id)) return;
    const { repo } = this.#deps;
    if (repo.listActiveDeliveries(session.id).length > 0) return;
    const reportedToMain = repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, participant: MAIN_RECIPIENT });
    if (reportedToMain) { this.#operatorDebtSettled.add(session.id); return; }

    const coordinator = repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, sender: ORCHESTRATOR_SEAT, excludeCheckpoints: true });
    const seatReports = this.#specialists(session.id)
      .map((seat) => repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, sender: seat.name, excludeCheckpoints: true }))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
    if (!coordinator && seatReports.length === 0) return;

    this.#operatorDebtSettled.add(session.id);
    const lines = seatReports.map((row) => `- ${row.sender} (${row.core.status}): ${row.core.state.summary.slice(0, 1_500)}`);
    const summary = `This AgentSession went idle without its coordinator reporting a result, so the Console is closing the loop from the journal. Nothing below was assembled or endorsed by the coordinator.\n\n` +
      `${coordinator ? `Coordinator's last word (${coordinator.core.status}): ${coordinator.core.state.summary.slice(0, 2_000)}\n\n` : ""}` +
      `${lines.length > 0 ? `Specialist reports:\n${lines.join("\n")}` : "No specialist reported."}`;
    this.#deps.bus.append({ type: "agent_session.unreported", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, seatReports: seatReports.length, hadCoordinatorReport: coordinator !== undefined } });
    try {
      this.post({ agentSessionId: session.id, speaker: { kind: "orchestrator", name: ORCHESTRATOR_SEAT }, to: MAIN_RECIPIENT,
        handoff: this.#simpleHandoff("AgentSession went idle without a final report", "needs_verification", summary,
          "Review the seat reports above and decide whether the work is complete."), category: "milestone" });
    } catch (error) { this.#recordHostFailure(session.id, error); }
  }
  /**
   * `reported` is the state a finished session was missing. Without it, a
   * coordinator that had delivered its final and a seat that had crashed both
   * rendered as the same grey `idle` dot, and the operator could not tell a
   * completed run from a dead one.
   *
   * A turn parked in `ask_operator` does NOT count as working: the seat is
   * waiting on a human, which is the opposite of busy, and treating it as busy
   * is what kept db-live-2's spinner turning after the run was over.
   */
  statusOf(row: AgentSessionRow): AgentSessionStatus { return this.#statusOf(row); }

  #statusOf(row: AgentSessionRow): AgentSessionStatus {
    if (row.status === "archived") return "archived";
    const lanes = this.#seats.get(row.id);
    const working = [...(lanes?.values() ?? [])].some((lane) => lane.activeTurn !== null && lane.activeTurn.awaitingOperator === null);
    if (working) return "working";
    if (this.#deps.repo.listQueuedDeliveries(row.id).some((d) => d.recipient !== MAIN_RECIPIENT)) return "working";
    const reported = this.#deps.repo.latestHandoff({
      userSessionId: row.userSessionId, agentSessionId: row.id,
      participant: MAIN_RECIPIENT, sender: ORCHESTRATOR_SEAT, excludeCheckpoints: true,
    });
    if (reported && this.#deps.repo.listActiveDeliveries(row.id).length === 0) return "reported";
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
    this.#deps.bus.append({ type: "agent_session.status", userSessionId: session.userSessionId, agentSessionId: id, payload: { agentSessionId: id, status, owedToOrchestrator: false } });
  }
  #recordHostFailure(id: string, error: unknown): void {
    const session = this.#deps.repo.getAgentSession(id); if (!session) return;
    const text = error instanceof Error ? error.message : String(error);
    this.#deps.bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: id, payload: { agentSessionId: id, participant: "system", detail: `scheduler failure: ${text}` } });
  }
}
