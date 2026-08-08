import type { HandoffDraft, HandoffTrigger, Speaker } from "@agentique-console/shared";
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
import type { InteractionService } from "../orchestrator/interactions.ts";
import type { TaskService } from "../tasks/service.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { EvidenceRefSchema, HANDOFF_DRAFT_JSON_SCHEMA, HandoffCoreSchema, HandoffDraftSchema } from "../handoffs/schema.ts";
import { evaluateCheckpointDraft } from "../handoffs/checkpoint-gate.ts";
import { mainPeerName, peerNameOf } from "./peer-names.ts";
import { buildTaskHooks } from "../tasks/hooks.ts";
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
function isTransportFailure(failure: string | null): boolean {
  return failure !== null && /API Error: 4\d\d/.test(failure);
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
  can.push("connect to localhost — servers you start are reachable from your own commands and from the browser");
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
    `Put the substance in stateSummary — the findings themselves, not a description of having found them — and say what you could not verify in uncertainty. ` +
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
  interactions?: InteractionService;
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

/** Console-managed, independently resumable participant sessions and durable mailbox. */
export class AgentSessionHost {
  readonly #deps: AgentSessionHostDeps;
  /** agentSessionId → seat name → its persistent lane. */
  readonly #seats = new Map<string, Map<string, SeatLane>>();
  readonly #deferredDecisions = new Map<string, string[]>();
  /** Idempotency for peer-carry retries: send fingerprint → delivery id. */
  readonly #recentPeerSends = new Map<string, { deliveryId: string; at: number }>();
  /** Waiters for a resident-capacity slot, resolved oldest-first on park/close. */
  readonly #capacityWaiters: (() => void)[] = [];

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
    const title = input.title.trim();
    if (!title) throw badRequest("a session title is required");
    const parent = repo.getUserSession(input.userSessionId);
    if (!parent) throw badRequest("unknown user session");
    const now = nowIso();
    const row: AgentSessionRow = {
      id: newId("as"), userSessionId: input.userSessionId, title, mode: input.mode,
      phase: input.mode === "plan_execute" ? "planning" : "executing", status: "open", createdAt: now, updatedAt: now,
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
  post(input: { agentSessionId: string; speaker: Speaker; to: string; handoff: HandoffDraft; category?: Category; dedupeKey?: string; deferWake?: boolean; turnId?: string }): MessageRow {
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
    const caveats = this.#finalReportCaveats(session, input.speaker.name, input.to, category);
    if (caveats.length > 0) {
      input = { ...input, handoff: { ...input.handoff, core: { ...input.handoff.core,
        uncertainty: [...input.handoff.core.uncertainty, `Console: reported final with work outstanding — ${caveats.join("; ")}.`] } } };
      this.#deps.bus.append({ type: "handoff.final.caveats", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, sender: input.speaker.name, caveats } });
    }
    const { message, delivery, text } = this.#journal(session, input.speaker, input.to, input.handoff, category, {
      transport: "console", ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}), ...(input.turnId ? { turnId: input.turnId } : {}),
    });
    if (input.to === MAIN_RECIPIENT) {
      this.#patchDelivery(session, delivery, "acknowledged");
      if (category === "decision" && input.deferWake === true) {
        const pending = this.#deferredDecisions.get(session.id) ?? [];
        if (!pending.includes(text)) pending.push(text);
        this.#deferredDecisions.set(session.id, pending);
      } else if (MATERIAL_CATEGORIES.has(category)) {
        const deferred = this.#deferredDecisions.get(session.id) ?? [];
        this.#deferredDecisions.delete(session.id);
        const wakeText = deferred.length === 0 ? text : `${text}\n\nBatched nonblocking operator decisions:\n${deferred.map((decision, index) => `${index + 1}. ${decision}`).join("\n")}`;
        this.#deps.bus.append({ type: "flow.result", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { userSessionId: session.userSessionId, agentSessionId: session.id, digestPreview: text.slice(0, 140) } });
        this.#deps.wake?.(session.userSessionId, session.id, category, wakeText);
      }
    } else {
      void this.#deliverConsole(session.id, input.to).catch((error) => this.#recordHostFailure(session.id, error));
    }
    return message;
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
      ...(senderSeat?.worktreePath ? { resolveRoot: senderSeat.worktreePath } : {}),
    });
    const text = prepared.text;
    const { message, delivery } = repo.appendHandoffMailbox({
      sessionKind: "agent", sessionId: session.id, userSessionId: session.userSessionId,
      agentSessionId: session.id, speaker, to, recipient: to,
      kind: category === "decision" && session.phase === "planning" ? "plan" : "message",
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

  archiveForUserSession(userSessionId: string): void {
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
    const writes = profile.tools.includes("Edit") || profile.tools.includes("Write");
    if (!worktrees || this.#deps.config?.seatWorktrees === false || seat.role !== "agent" || seat.attemptRole !== null
      || seat.worktreePath !== null || !writes || !worktrees.isGitRepo(workspaceRoot)) return seat;
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
    if (!victim) return false;
    this.#parkSeat(victim.sessionId, victim.seat, victim.lane, "capacity");
    return true;
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
    // A fresh CLI process restarts both counters: cumulative cost/duration
    // begin at zero, and occupancy is re-reported by its first assistant
    // message. Carrying the old watermarks forward would zero out real spend.
    lane.contextTokens = 0;
    lane.lastCumulative = { costUsd: 0, apiDurationMs: 0 };
    lane.ready = (async () => {
      const sdk = await this.#deps.sdk!();
      const user = this.#deps.repo.getUserSession(session.userSessionId);
      if (!user) throw new Error("workspace unavailable");
      const workspaceRoot = this.#deps.getWorkspaceRoot!(user.workspaceId);
      const latestSeat = this.#ensureSeatWorktree(session, this.#deps.repo.getParticipant(session.id, seatRow.name) ?? seatRow, workspaceRoot);
      const profile = latestSeat.profileSnapshot as AgentProfile;
      const seatRoot = latestSeat.worktreePath ?? workspaceRoot;
      const mcp = this.#buildParticipantMcp(sdk, session, latestSeat, lane.abort!.signal);
      const options: SdkOptions = {
        cwd: seatRoot,
        // Order matters for prompt caching: the invariant part (instructions,
        // capabilities, messaging brief) comes first and is byte-identical
        // across generations; the volatile checkpoint goes last.
        systemPrompt: { type: "preset", preset: "claude_code", append: `${latestSeat.instructions}\n\n${capabilityBrief(profile, latestSeat.worktreePath !== null && !latestSeat.attemptRole, this.#deps.config?.allowedDomains ?? [])}${latestSeat.worktreePath && !latestSeat.attemptRole ? "\nNever run git commit — the Console lands your work when you report completed. Install dependencies only if you must run validation." : ""}\n\n${seatMessagingBrief(this.#roster(session), latestSeat.name)}\n${SESSION_PROTOCOL}${this.#checkpointContext(latestSeat)}` },
        settingSources: [], includePartialMessages: true,
        settings: { crossSessionInbound: "accept" } as unknown as SdkOptions["settings"],
        permissionMode: session.phase === "planning" ? "plan" : profile.permissionMode,
        ...(profile.permissionMode === "bypassPermissions" && session.phase !== "planning" ? { allowDangerouslySkipPermissions: true } : {}),
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
    // No send middleware: transfers go through the console-owned `send_handoff`
    // tool, which is journalled by `post()` directly. There is no second wire to
    // govern, and therefore no envelope to validate, coerce, or degrade.
    const fragments: SdkHooksFragment[] = [];
    const user = this.#deps.repo.getUserSession(session.userSessionId);
    if (this.#deps.tasks && user && seat.name === ORCHESTRATOR_SEAT) {
      fragments.push(buildTaskHooks(this.#deps.tasks, {
        workspaceId: user.workspaceId, userSessionId: session.userSessionId,
        agentSessionId: session.id, participant: seat.name,
      }) as SdkHooksFragment);
    }
    if (this.#deps.worktrees && user && this.#deps.getWorkspaceRoot) {
      fragments.push(buildWorktreeHooks({
        repo: this.#deps.repo, bus: this.#deps.bus, worktrees: this.#deps.worktrees,
        workspaceRoot: this.#deps.getWorkspaceRoot(user.workspaceId),
        userSessionId: session.userSessionId, agentSessionId: session.id, seat: seat.name,
      }));
    }
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

  #tripWatchdog(session: AgentSessionRow, seatName: string, lane: SeatLane, tripped: { kind: "repeat_tool_calls" | "tool_error_streak"; detail: string; toolName?: string; count: number }): void {
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
      toolStarts: new Map(), lastNarration: "", watchdog: { lastKey: "", identical: 0, errorStreak: 0, tripped: null } };
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
      for (const delivery of turn.deliveries) {
        const attempts = (lane.redeliveryAttempts.get(delivery.id) ?? 0) + 1;
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
    const seat = repo.getParticipant(session.id, seatName);
    if (seat) {
      repo.patchParticipant(session.id, seatName, { turnCount: seat.turnCount + 1, lastActiveAt: nowIso(),
        ...(turn.sawSend ? {} : { checkpointReady: false }) });
    }
    lane.assignmentTurns += 1;
    lane.lastActiveAt = Date.now();
    if (status === "error" && repo.getAgentSession(session.id)?.status === "open") {
      const target = seatName === ORCHESTRATOR_SEAT ? MAIN_RECIPIENT : ORCHESTRATOR_SEAT;
      // Carry the seat's last narration: a seat whose transport failed may
      // already hold the finished work, and an empty "Turn failed" tells the
      // coordinator only that something broke — not what was learned.
      const salvaged = turn.lastNarration.trim();
      this.post({ agentSessionId: session.id, speaker: { kind: seatName === ORCHESTRATOR_SEAT ? "orchestrator" : "agent", name: seatName }, to: target,
        handoff: this.#simpleHandoff("Turn failed", "failed",
          `${turn.watchdog.tripped ?? `Provider turn failed: ${errorMessage}`}${salvaged === "" ? "" : `\n\nUnsent work recovered from ${seatName}'s last output (unverified — it never passed through a handoff):\n${salvaged.slice(0, 8_000)}`}`,
          "Inspect the failure and retry or reassign."), category: "failure", turnId: turn.turnId });
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

  /** Close the process (name and socket unregister); keep the resume handle. */
  #parkSeat(agentSessionId: string, seatName: string, lane: SeatLane, reason: string): void {
    lane.state = "parked";
    lane.input?.close(); lane.input = null;
    const query = lane.query; lane.query = null;
    query?.close?.();
    lane.abort = null;
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (session) {
      this.#deps.bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId,
        payload: { agentSessionId, participant: seatName, detail: `seat parked (${reason}); provider session retained` } });
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

  #buildParticipantMcp(sdk: ConsoleSdk, session: AgentSessionRow, seat: ParticipantRow, signal: AbortSignal): unknown {
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
        const message = this.post({ agentSessionId: session.id, speaker: { kind: seat.name === ORCHESTRATOR_SEAT ? "orchestrator" : "agent", name: seat.name },
          to: args.to, handoff: draft, category: args.category, ...(args.dedupeKey ? { dedupeKey: args.dedupeKey } : {}),
          ...(this.#laneOf(session.id, seat.name).activeTurn ? { turnId: this.#laneOf(session.id, seat.name).activeTurn!.turnId } : {}) });
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
          }, async (args: { taskId: string; subject: string; description: string }) => {
            this.#deps.tasks?.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: args.taskId, subject: args.subject, description: args.description, attribution });
            return ok({ taskId: args.taskId, created: true });
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
          const mediaType = artifact.mediaType.replace(/;base64$/, "");
          return { content: [{ type: "image", source: { type: "base64", media_type: mediaType, data: artifact.content } }] } as unknown as SdkToolResult;
        }
        return ok({ artifactId: artifact.id, mediaType: artifact.mediaType, bytes: artifact.bytes, content: pageTail(artifact.content, args.cursor, args.maxBytes) });
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
        sdk.tool("browser_evaluate", "Evaluate JavaScript in the page and return the result as JSON. Use it to read state the rendered text does not expose — localStorage, canvas/game state, module exports.", {
          expression: z.string().min(1),
        }, async (args: { expression: string }) => ok(await this.#deps.browsers?.evaluate(key, args.expression))),
      );
      if (profile.runtime.screenshots) {
        tools.push(sdk.tool("browser_screenshot", "Capture a full-page screenshot as a durable Console artifact.", {}, async () => ok(await this.#deps.browsers?.screenshot(key, { userSessionId: session.userSessionId, agentSessionId: session.id }))));
      }
    }
    if (seat.name === ORCHESTRATOR_SEAT && this.#deps.interactions) {
      tools.push(sdk.tool("request_decision", "Escalate a decision that belongs to the Human Operator. Blocking requests render immediately and wait for an answer. Nonblocking requests are coalesced into the next main-agent milestone.", {
        question: z.string().min(1), header: z.string().max(24).optional(),
        options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(2).max(4),
        blocking: z.boolean().default(true), recommendation: z.string().optional(),
      }, async (args: { question: string; header?: string; options: { label: string; description?: string }[]; blocking: boolean; recommendation?: string }) => {
        const text = `${args.question}\n${args.recommendation ? `Recommendation: ${args.recommendation}\n` : ""}${args.options.map((option) => `- ${option.label}: ${option.description ?? ""}`).join("\n")}`;
        if (!args.blocking) {
          this.post({ agentSessionId: session.id, speaker: { kind: "orchestrator", name: seat.name }, to: MAIN_RECIPIENT,
            handoff: this.#simpleHandoff("Operator decision requested", "blocked", text, "Main should decide or ask the operator."),
            category: "decision", dedupeKey: args.question, deferWake: true });
          return ok({ queued: true });
        }
        const pending = this.#deps.interactions?.createQuestion(session.userSessionId, [{ question: args.question, ...(args.header ? { header: args.header } : {}), options: args.options }], `agent:${session.id}:${seat.name}:${newId("turn")}`, signal);
        if (!pending) throw new Error("interaction service unavailable");
        const resolution = await pending.resolution;
        return ok(resolution);
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
      "mcp__console_agent__task_list", "mcp__console_agent__read_artifact",
      ...(participant === ORCHESTRATOR_SEAT ? ["mcp__console_agent__task_create", "mcp__console_agent__task_update"] : []),
      ...(profile.runtime.shell ? ["mcp__console_agent__process_start", "mcp__console_agent__process_read", "mcp__console_agent__process_stop"] : []),
      ...(profile.runtime.browser ? ["mcp__console_agent__browser_open", "mcp__console_agent__browser_snapshot", "mcp__console_agent__browser_click", "mcp__console_agent__browser_fill", "mcp__console_agent__browser_console", "mcp__console_agent__browser_press", "mcp__console_agent__browser_evaluate"] : []),
      ...(profile.runtime.browser && profile.runtime.screenshots ? ["mcp__console_agent__browser_screenshot"] : []),
      ...(participant === ORCHESTRATOR_SEAT ? ["mcp__console_agent__request_decision"] : []),
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
      return `${p.name} (${p.profileId}; ${capabilityTag(p.profileSnapshot as AgentProfile)}; owns: ${scopes || "coordination"}${p.worktreeBranch ? `; ${this.#seatWorkState(p)}` : ""})`;
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
    return `AgentSession ${session.id}: ${session.title}\nYou are ${seat.name}. Participants: ${roster}.\n\nOnly the following addressed handoffs are new:\n${messages}\n\nTreat handoff claims as historical context; verify risky claims against repository/task/journal evidence during normal work. Act without restating the envelope. Set checkpointReadiness=defer only while state is genuinely unstable.`;
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
  #seatWorkState(seat: ParticipantRow): string {
    if (!seat.worktreePath || !seat.worktreeBranch || !seat.worktreeBaseCommit || !this.#deps.worktrees) return "no isolated worktree";
    try {
      const diff = this.#deps.worktrees.captureDiff(seat.worktreePath, seat.worktreeBaseCommit, seat.worktreeBranch);
      return diff.filesChanged === 0
        ? "unmerged worktree, nothing written yet"
        : `unmerged worktree: ${diff.filesChanged} file(s) +${diff.insertions}/-${diff.deletions}, not visible in the workspace until they report completed`;
    } catch { return "unmerged worktree (state unavailable)"; }
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
    this.#deps.repo.patchParticipant(session.id, seat.name, { sdkSessionId: null, generation: seat.generation + 1, turnCount: 0, contextTokens: 0, latestHandoffId: prepared.row.id, checkpointReady: true });
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
    // Its own baseline: this is a separate query() process, so its cumulative
    // totals start from zero rather than continuing the seat lane's.
    const cumulative = { costUsd: 0, apiDurationMs: 0 };
    try {
      for await (const raw of query) for (const event of mapSdkMessage(raw)) {
        if (event.kind === "result") {
          const parsed = HandoffDraftSchema.safeParse(event.output);
          if (parsed.success) draft = parsed.data;
          this.#recordUsage(session, seat, cumulative, `checkpoint:${newId("turn")}`, event);
        } else if (event.kind === "error") failure = event.message;
      }
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    finally { clearTimeout(checkpointDeadline); flight.query = null; query.close?.(); }
    return { draft, failure };
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
  #recordUsage(session: AgentSessionRow, seat: ParticipantRow, cumulative: { costUsd: number; apiDurationMs: number }, turnId: string, usageEvent: { inputTokens?: number; uncachedInputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; outputTokens?: number; cumulativeCostUsd?: number; modelId?: string; cumulativeApiDurationMs?: number; sdkDurationMs?: number; stopReason?: string }, status: "completed" | "error" | "aborted" = "completed", durationMs?: number): void {
    // A result carrying no tokens at all is a CLI-level artifact, not a turn.
    if ((usageEvent.inputTokens ?? 0) === 0 && (usageEvent.outputTokens ?? 0) === 0) return;
    const costUsd = usageEvent.cumulativeCostUsd === undefined ? null
      : Math.max(0, usageEvent.cumulativeCostUsd - cumulative.costUsd);
    const apiDurationMs = usageEvent.cumulativeApiDurationMs === undefined ? null
      : Math.max(0, usageEvent.cumulativeApiDurationMs - cumulative.apiDurationMs);
    if (usageEvent.cumulativeCostUsd !== undefined) cumulative.costUsd = usageEvent.cumulativeCostUsd;
    if (usageEvent.cumulativeApiDurationMs !== undefined) cumulative.apiDurationMs = usageEvent.cumulativeApiDurationMs;
    const usage = { id: newId("usage"), userSessionId: session.userSessionId, agentSessionId: session.id, participant: seat.name, profileId: seat.profileId,
      generation: seat.generation, turnId, inputTokens: usageEvent.inputTokens ?? 0, uncachedInputTokens: usageEvent.uncachedInputTokens ?? 0,
      cacheCreationInputTokens: usageEvent.cacheCreationInputTokens ?? 0, cacheReadInputTokens: usageEvent.cacheReadInputTokens ?? 0,
      outputTokens: usageEvent.outputTokens ?? 0, costUsd,
      model: usageEvent.modelId ?? seat.model, effort: (seat.profileSnapshot as AgentProfile).effort ?? this.#deps.config?.effort ?? null,
      trigger: "delivery", durationMs: durationMs ?? null, apiDurationMs, sdkDurationMs: usageEvent.sdkDurationMs ?? null, status, stopReason: usageEvent.stopReason ?? null, createdAt: nowIso() };
    this.#deps.repo.insertUsage(usage);
    this.#deps.bus.append({ type: "usage.recorded", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { sessionId: session.id, participant: seat.name, profileId: seat.profileId, generation: seat.generation, turnId,
        inputTokens: usage.inputTokens, uncachedInputTokens: usage.uncachedInputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens, outputTokens: usage.outputTokens, ...(costUsd === null ? {} : { costUsd }),
        model: usage.model ?? undefined, effort: usage.effort ?? undefined, trigger: "delivery", durationMs: usage.durationMs ?? undefined,
        apiDurationMs: usage.apiDurationMs ?? undefined, sdkDurationMs: usage.sdkDurationMs ?? undefined, status, stopReason: usage.stopReason ?? undefined } });
  }

  #patchDelivery(session: AgentSessionRow, delivery: MailboxDeliveryRow, status: "queued" | "delivered" | "acknowledged" | "cancelled"): void {
    const now = nowIso();
    this.#deps.repo.patchDelivery(delivery.id, { status, ...(status === "delivered" ? { deliveredAt: now } : {}), ...(status === "acknowledged" ? { acknowledgedAt: now, deliveredAt: delivery.deliveredAt ?? now } : {}) });
    const message = this.#deps.repo.getMessageById(delivery.messageId);
    this.#deps.bus.append({ type: "agent_session.mailbox", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, deliveryId: delivery.id, messageSeq: message?.seq ?? 0, sender: delivery.sender, recipient: delivery.recipient, category: delivery.category, status } });
  }

  #specialists(id: string): ParticipantRow[] { return this.#deps.repo.listParticipants(id).filter((p) => p.role === "agent"); }
  #sessionStatus = new Map<string, "working" | "idle" | null>();
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
  #statusOf(row: AgentSessionRow): "working" | "idle" | "archived" {
    if (row.status === "archived") return "archived";
    const lanes = this.#seats.get(row.id);
    const anyTurn = [...(lanes?.values() ?? [])].some((lane) => lane.activeTurn !== null);
    return anyTurn || this.#deps.repo.listQueuedDeliveries(row.id).some((d) => d.recipient !== MAIN_RECIPIENT) ? "working" : "idle";
  }
  #setStatus(id: string, status: "working" | "idle"): void {
    const last = this.#sessionStatus.get(id) ?? null;
    // New work re-opens the obligation: a session that was discharged once and
    // then given more to do owes the operator another word.
    if (status === "working") this.#operatorDebtSettled.delete(id);
    if (last === status) return;
    if (last === null && status === "idle") { this.#sessionStatus.set(id, status); return; }
    this.#sessionStatus.set(id, status);
    const session = this.#deps.repo.getAgentSession(id); if (!session) return;
    this.#deps.bus.append({ type: "agent_session.status", userSessionId: session.userSessionId, agentSessionId: id, payload: { agentSessionId: id, status, owedToOrchestrator: false } });
  }
  #recordHostFailure(id: string, error: unknown): void {
    const session = this.#deps.repo.getAgentSession(id); if (!session) return;
    const text = error instanceof Error ? error.message : String(error);
    this.#deps.bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: id, payload: { agentSessionId: id, participant: "system", detail: `scheduler failure: ${text}` } });
  }
}
