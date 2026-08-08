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
import type { ConsoleSdk, QueryHandle, SdkOptions, SdkToolResult } from "../sdk/types.ts";
import { sdkEnv } from "../sdk/env.ts";
import type { ProcessManager } from "../runtime/process-manager.ts";
import type { BrowserManager } from "../runtime/browser-manager.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import type { InteractionService } from "../orchestrator/interactions.ts";
import type { TaskService } from "../tasks/service.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { CheckpointClosingSchema, HandoffDraftSchema } from "../handoffs/schema.ts";
import { evaluateCheckpointDraft } from "../handoffs/checkpoint-gate.ts";
import { COORDINATOR_SEAT, seatOfSpawnName } from "./spawn-names.ts";
import { peerNameOf } from "./peer-names.ts";

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

type Category = MailboxDeliveryRow["category"];

interface Flight { abort: AbortController; query: QueryHandle | null; }
interface Lane { chain: Promise<void>; turns: Map<string, Flight>; lastStatus: "working" | "idle" | null; }

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

const OUTPUT_SCHEMA = CheckpointClosingSchema;

function ok(value: unknown): SdkToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Console-managed, independently resumable participant sessions and durable mailbox. */
export class AgentSessionHost {
  readonly #deps: AgentSessionHostDeps;
  readonly #lanes = new Map<string, Lane>();
  #globalTurns = 0;
  readonly #deferredDecisions = new Map<string, string[]>();
  readonly #legacyBindings = new Map<string, { agentSessionId: string; participant: string; spawnName: string; agentId: string | null }>();

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

  post(input: { agentSessionId: string; speaker: Speaker; to: string; handoff: HandoffDraft; category?: Category; dedupeKey?: string; deferWake?: boolean; turnId?: string }): MessageRow {
    const { repo, bus } = this.#deps;
    const session = repo.getAgentSession(input.agentSessionId);
    if (!session) throw notFound(`no agent session ${input.agentSessionId}`);
    if (session.status !== "open") throw conflict(`agent session ${input.agentSessionId} is archived`);
    if (!this.#deps.handoffs) throw new Error("handoff service unavailable");
    this.#assertRoute(session.id, input.speaker.name, input.to);
    const category = input.category ?? "update";
    if (input.dedupeKey) {
      const prior = repo.findDeliveryByDedupe(session.id, input.speaker.name, input.to, input.dedupeKey);
      const priorMessage = prior ? repo.getMessageById(prior.messageId) : undefined;
      if (priorMessage) return priorMessage;
    }
    if (input.speaker.name === ORCHESTRATOR_SEAT && input.to === MAIN_RECIPIENT && category === "final" && this.#deps.tasks) {
      const incomplete = this.#deps.tasks.listForUserSession(session.userSessionId).filter((task) => task.agentSessionId === session.id && task.status !== "completed" && task.status !== "deleted");
      if (incomplete.length > 0) throw badRequest(`cannot report final while ${incomplete.length} task(s) remain incomplete: ${incomplete.map((task) => task.subject).join(", ")}`);
    }
    if (input.speaker.name === ORCHESTRATOR_SEAT && input.to === MAIN_RECIPIENT && category === "final") {
      const activeSpecialists = [...(this.#lanes.get(session.id)?.turns.keys() ?? [])].filter((name) => name !== ORCHESTRATOR_SEAT);
      const pendingInternal = repo.listActiveDeliveries(session.id).filter((delivery) => delivery.recipient !== MAIN_RECIPIENT);
      if (activeSpecialists.length > 0 || pendingInternal.length > 0) throw badRequest(`cannot report final while AgentSession work is active (${activeSpecialists.length} running, ${pendingInternal.length} queued/delivered)`);
    }
    const senderSeat = input.speaker.name === MAIN_RECIPIENT ? undefined : repo.getParticipant(session.id, input.speaker.name);
    const prepared = this.#deps.handoffs.prepare({
      draft: input.handoff, userSessionId: session.userSessionId, agentSessionId: session.id,
      sender: input.speaker.name, recipient: input.to,
      profileId: input.speaker.name === MAIN_RECIPIENT ? "main" : senderSeat?.profileId ?? null,
      extensionKind: input.speaker.name === MAIN_RECIPIENT ? "coordination" : (senderSeat?.profileSnapshot as AgentProfile | undefined)?.handoffExtension,
      generation: input.speaker.name === MAIN_RECIPIENT ? (repo.getUserSession(session.userSessionId)?.sdkGeneration ?? 0) : senderSeat?.generation ?? 0,
      turnId: input.turnId, trigger: category as HandoffTrigger,
      parentHandoffId: category === "assignment" ? null : (senderSeat?.latestHandoffId ?? (input.speaker.name === MAIN_RECIPIENT ? repo.getUserSession(session.userSessionId)?.latestHandoffId : null)),
      ...(senderSeat?.worktreePath ? { resolveRoot: senderSeat.worktreePath } : {}),
    });
    const text = prepared.text;
    const { message, delivery } = repo.appendHandoffMailbox({
      sessionKind: "agent", sessionId: session.id, userSessionId: session.userSessionId,
      agentSessionId: session.id, speaker: input.speaker, to: input.to, recipient: input.to,
      kind: category === "decision" && session.phase === "planning" ? "plan" : "message",
      text, category, handoff: prepared.row, summary: prepared.summary,
      ...(input.turnId ? { turnId: input.turnId } : {}), ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
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
      payload: { agentSessionId: session.id, deliveryId: delivery.id, messageSeq: message.seq, sender: input.speaker.name, recipient: input.to, category, status: "queued" } });
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
        bus.append({ type: "flow.result", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { userSessionId: session.userSessionId, agentSessionId: session.id, digestPreview: text.slice(0, 140) } });
        this.#deps.wake?.(session.userSessionId, session.id, category, wakeText);
      }
    } else {
      repo.patchParticipant(session.id, input.to, { pendingTurnSeq: message.seq });
      this.#schedule(session.id);
    }
    return message;
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

  interrupt(agentSessionId: string): void {
    for (const turn of this.#lanes.get(agentSessionId)?.turns.values() ?? []) {
      turn.abort.abort(); void turn.query?.interrupt?.().catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const lane of this.#lanes.values()) for (const turn of lane.turns.values()) {
      turn.abort.abort();
      if (turn.query?.interrupt) pending.push(turn.query.interrupt().catch(() => undefined));
      turn.query?.close?.();
    }
    await Promise.all(pending);
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
    for (const delivery of this.#deps.repo.listQueuedDeliveries()) this.#schedule(delivery.agentSessionId);
  }

  profiles(workspaceId?: string): AgentProfile[] { return this.#deps.profiles?.list(workspaceId) ?? []; }
  runtimeAvailability(): { sandbox: boolean; chrome: boolean } {
    return { sandbox: fs.existsSync("/usr/bin/bwrap") || fs.existsSync("/usr/local/bin/bwrap"), chrome: fs.existsSync("/usr/bin/google-chrome") };
  }

  /** Legacy observation seam retained only for importing/closing old native runs. */
  observeAgentSpawn(callId: string, spawnName: string, agentSessionId: string, subagentType = ""): void {
    const session = this.#deps.repo.getAgentSession(agentSessionId); if (!session) return;
    const seat = seatOfSpawnName(spawnName, agentSessionId, this.#specialists(agentSessionId).map((p) => p.name));
    if (seat === null) return;
    const participant = seat === COORDINATOR_SEAT ? ORCHESTRATOR_SEAT : seat;
    if (session.phase === "planning" && participant !== ORCHESTRATOR_SEAT && subagentType && !subagentType.endsWith("-planning")) {
      this.#deps.repo.patchAgentSession(agentSessionId, { phase: "executing" });
      this.#deps.bus.append({ type: "agent_session.phase", userSessionId: session.userSessionId, agentSessionId, payload: { agentSessionId, phase: "executing" } });
    }
    this.#legacyBindings.set(callId, { agentSessionId, participant, spawnName, agentId: null });
    this.#deps.bus.append({ type: "agent_session.turn.started", userSessionId: session.userSessionId, agentSessionId, payload: { agentSessionId, participant, turnId: callId } });
  }
  confirmAgentLaunch(callId: string, agentId: string): void { const binding = this.#legacyBindings.get(callId); if (binding) binding.agentId = agentId; }
  seatOf(callId: string): { agentSessionId: string; participant: string } | null { const b = this.#legacyBindings.get(callId); return b ? { agentSessionId: b.agentSessionId, participant: b.participant } : null; }
  seatOfSpawnAddress(to: string): { agentSessionId: string; participant: string; callId: string } | null { for (const [callId, b] of this.#legacyBindings) if (b.spawnName === to) return { agentSessionId: b.agentSessionId, participant: b.participant, callId }; return null; }
  hasCoordinator(agentSessionId: string): boolean { return [...this.#legacyBindings.values()].some((b) => b.agentSessionId === agentSessionId && b.participant === ORCHESTRATOR_SEAT); }
  releaseAgent(agentId: string): void { for (const [callId, b] of this.#legacyBindings) if (b.agentId === agentId) { this.#releaseLegacy(callId, b, "completed"); return; } }
  releaseSpawnCall(callId: string): void { const b = this.#legacyBindings.get(callId); if (b) this.#releaseLegacy(callId, b, "aborted"); }
  recordDerivedMessage(input: { agentSessionId: string; speaker: { kind: "orchestrator" | "agent"; name: string }; to?: string; text: string }): void {
    const session = this.#deps.repo.getAgentSession(input.agentSessionId); if (!session) return;
    const isPlan = session.phase === "planning" && input.speaker.kind === "agent" && input.to === ORCHESTRATOR_SEAT;
    const row = this.#deps.repo.appendMessage({ sessionKind: "agent", sessionId: session.id, speaker: input.speaker, ...(input.to ? { to: input.to } : {}), kind: isPlan ? "plan" : "message", text: input.text });
    this.#deps.bus.append({ type: "agent_session.message", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { agentSessionId: session.id, message: toWireMessage(row) } });
    if (isPlan) this.#deps.bus.append({ type: "agent_session.plan.captured", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { agentSessionId: session.id, participant: input.speaker.name, plan: input.text } });
  }

  #releaseLegacy(callId: string, binding: { agentSessionId: string; participant: string }, status: "completed" | "aborted"): void {
    this.#legacyBindings.delete(callId); const session = this.#deps.repo.getAgentSession(binding.agentSessionId); if (!session) return;
    this.#deps.bus.append({ type: "agent_session.turn.settled", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { agentSessionId: session.id, participant: binding.participant, turnId: callId, status } });
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
      worktrees.commitAll(seat.worktreePath, `seat ${seat.name}: reported ${status}`);
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
      commit = worktrees.commitAll(seat.worktreePath, `attempt ${seat.name}: ${group.profileId} work`);
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
    return { id, title: id, purpose: id, instructions: `You are the ${id} specialist.`, tools: ["Read", "Glob", "Grep"], permissionMode: "default", maxTurns: 30, sandboxRequired: true, runtime: { shell: false, browser: false, screenshots: false } };
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

  #lane(id: string): Lane {
    let lane = this.#lanes.get(id);
    if (!lane) { lane = { chain: Promise.resolve(), turns: new Map(), lastStatus: null }; this.#lanes.set(id, lane); }
    return lane;
  }

  #schedule(id: string): void {
    if (!this.#deps.sdk || !this.#deps.config) return;
    const lane = this.#lane(id);
    lane.chain = lane.chain.then(() => this.#drain(id)).catch((error) => this.#recordHostFailure(id, error));
  }

  async #drain(id: string): Promise<void> {
    const config = this.#deps.config;
    if (!config) return;
    const session = this.#deps.repo.getAgentSession(id);
    if (!session || session.status !== "open") return;
    const lane = this.#lane(id);
    const queued = this.#deps.repo.listQueuedDeliveries(id);
    for (const recipient of new Set(queued.map((d) => d.recipient))) {
      if (recipient === MAIN_RECIPIENT || lane.turns.has(recipient)) continue;
      if (lane.turns.size >= config.perAgentSessionTurns || this.#globalTurns >= config.globalAgentTurns) break;
      this.#startTurn(session, recipient);
    }
    this.#setStatus(id, lane.turns.size > 0 || queued.some((d) => d.recipient !== MAIN_RECIPIENT) ? "working" : "idle");
  }

  #startTurn(session: AgentSessionRow, participant: string): void {
    const seat = this.#deps.repo.getParticipant(session.id, participant);
    if (!seat) return;
    const deliveries = this.#deps.repo.listQueuedDeliveries(session.id).filter((d) => d.recipient === participant);
    if (deliveries.length === 0) return;
    const abort = new AbortController();
    const flight: Flight = { abort, query: null };
    const lane = this.#lane(session.id);
    lane.turns.set(participant, flight); this.#globalTurns += 1;
    const turnId = newId("turn");
    for (const delivery of deliveries) this.#patchDelivery(session, delivery, "delivered");
    this.#deps.bus.append({ type: "agent_session.turn.started", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, participant, turnId } });
    void this.#runTurn(session, seat, deliveries, turnId, flight).finally(() => {
      lane.turns.delete(participant); this.#globalTurns -= 1; this.#schedule(session.id);
      for (const other of this.#lanes.keys()) if (other !== session.id) this.#schedule(other);
    });
  }

  async #runTurn(session: AgentSessionRow, seat: ParticipantRow, deliveries: MailboxDeliveryRow[], turnId: string, flight: Flight): Promise<void> {
    const { repo, bus } = this.#deps;
    const runtime = new RuntimeBroadcaster(bus, { kind: "agent", sessionId: session.id }, seat.name,
      { userSessionId: session.userSessionId, agentSessionId: session.id });
    let status: "completed" | "error" | "aborted" = "completed";
    let errorMessage: string | undefined;
    let output: Record<string, unknown> = {};
    const sentThisTurn = new Set<string>();
    const startedAt = Date.now();
    const toolStarts = new Map<string, number>();
    const watchdog = { lastKey: "", identical: 0, errorStreak: 0,
      tripped: null as null | { kind: "repeat_tool_calls" | "tool_error_streak"; detail: string; toolName?: string; count: number } };
    const trip = (tripped: NonNullable<typeof watchdog.tripped>, flightRef: Flight) => {
      if (watchdog.tripped) return;
      watchdog.tripped = tripped;
      bus.append({ type: "agent_session.watchdog", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, participant: seat.name, turnId, kind: tripped.kind,
          ...(tripped.toolName ? { toolName: tripped.toolName } : {}), count: tripped.count, detail: tripped.detail } });
      flightRef.abort.abort();
      void flightRef.query?.interrupt?.()?.catch?.(() => undefined);
    };
    let latestSeat = seat;
    try {
      const sdk = await this.#deps.sdk?.();
      if (!sdk) throw new Error("SDK unavailable");
      latestSeat = await this.#rotateIfNeeded(session, seat, sdk, flight);
      const user = repo.getUserSession(session.userSessionId);
      if (!user || !this.#deps.getWorkspaceRoot) throw new Error("workspace unavailable");
      latestSeat = this.#ensureSeatWorktree(session, latestSeat, this.#deps.getWorkspaceRoot(user.workspaceId));
      const profile = latestSeat.profileSnapshot as AgentProfile;
      const mcp = this.#buildParticipantMcp(sdk, session, latestSeat, flight.abort.signal, sentThisTurn);
      const messages = deliveries.map((delivery) => repo.getMessageById(delivery.messageId)).filter((row): row is MessageRow => row !== undefined);
      const prompt = this.#composePrompt(session, latestSeat, messages);
      // A worktree'd seat lives in its isolated copy: cwd and writes stay
      // there; the real workspace remains readable so git history resolves.
      const workspaceRoot = this.#deps.getWorkspaceRoot(user.workspaceId);
      const seatRoot = latestSeat.worktreePath ?? workspaceRoot;
      const options: SdkOptions = {
        cwd: seatRoot,
        systemPrompt: { type: "preset", preset: "claude_code", append: `${latestSeat.instructions}${this.#checkpointContext(latestSeat)}${latestSeat.worktreePath && !latestSeat.attemptRole ? "\n\nYou work in an isolated worktree (your cwd); the Console merges your changes into the workspace when you report completed. Never run git commit. Install dependencies only if you must run validation." : ""}\n\nUse mcp__console_agent__send_message for all communication. Never use native SendMessage or Agent tools.` },
        settingSources: [], includePartialMessages: true,
        permissionMode: session.phase === "planning" ? "plan" : profile.permissionMode,
        ...(profile.permissionMode === "bypassPermissions" && session.phase !== "planning" ? { allowDangerouslySkipPermissions: true } : {}),
        allowedTools: [...profile.tools, ...this.#runtimeToolNames(profile, latestSeat.name, latestSeat.attemptRole)],
        disallowedTools: ["Agent", "SendMessage", "Task", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"],
        outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA }, maxTurns: profile.maxTurns,
        sandbox: { enabled: true, failIfUnavailable: profile.sandboxRequired, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
          filesystem: { allowManagedReadPathsOnly: true, allowRead: latestSeat.worktreePath ? [seatRoot, workspaceRoot] : [workspaceRoot], allowWrite: [seatRoot] } },
        env: sdkEnv(), abortController: flight.abort, persistSession: true,
        sessionStore: this.#deps.sessionStore as never, sessionStoreFlush: "eager",
        mcpServers: { console_agent: mcp as never },
        ...(latestSeat.model ? { model: latestSeat.model } : {}),
        ...((profile.pluginPath && profile.source === "workspace") ? { plugins: [{ type: "local" as const, path: profile.pluginPath }] } : {}),
        ...((profile.skills?.length ?? 0) > 0 ? { skills: profile.skills } : {}),
        ...((profile.effort ?? this.#deps.config?.effort) ? { effort: (profile.effort ?? this.#deps.config?.effort) as SdkOptions["effort"] } : {}),
        ...(latestSeat.sdkSessionId ? { resume: latestSeat.sdkSessionId } : {}),
      };
      runtime.set("thinking");
      const query = sdk.query({ prompt, options }); flight.query = query;
      try {
        for await (const raw of query) {
          for (const event of mapSdkMessage(raw)) {
            if ("parentCallId" in event && event.parentCallId) continue;
            if (event.kind === "resume") repo.patchParticipant(session.id, seat.name, { sdkSessionId: event.resumeId });
            else if (event.kind === "delta") { runtime.set("responding"); bus.broadcast({ type: "stream.delta", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { scope: { kind: "agent", sessionId: session.id }, speaker: seat.name, turnId, text: event.text } }); }
            else if (event.kind === "reasoning-delta") { runtime.set("thinking"); bus.broadcast({ type: "stream.reasoning", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { scope: { kind: "agent", sessionId: session.id }, speaker: seat.name, turnId, text: event.text } }); }
            else if (event.kind === "message") this.#recordNarration(session, seat.name, event.text, turnId);
            else if (event.kind === "notice") { runtime.note(event.text); bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { agentSessionId: session.id, participant: seat.name, turnId, detail: event.text } }); }
            else if (event.kind === "tool.call") {
              toolStarts.set(event.callId, Date.now()); runtime.set("tool", event.name); bus.append({ type: "agent_session.tool.call", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { sessionId: session.id, participant: seat.name, turnId, callId: event.callId, name: event.name, input: bus.capture(event.input, { userSessionId: session.userSessionId, agentSessionId: session.id }) } });
              const key = `${event.name} ${stableStringify(event.input)}`;
              watchdog.identical = key === watchdog.lastKey ? watchdog.identical + 1 : 1;
              watchdog.lastKey = key;
              if (watchdog.identical >= WATCHDOG_IDENTICAL_CALLS) trip({ kind: "repeat_tool_calls", toolName: event.name, count: watchdog.identical,
                detail: `watchdog: ${watchdog.identical} identical consecutive calls to ${event.name}` }, flight);
            }
            else if (event.kind === "tool.result") {
              const captured = bus.captureSized(event.output, { userSessionId: session.userSessionId, agentSessionId: session.id });
              const toolStartedAt = toolStarts.get(event.callId); toolStarts.delete(event.callId);
              runtime.set("thinking"); bus.append({ type: "agent_session.tool.result", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { sessionId: session.id, participant: seat.name, turnId, callId: event.callId, output: captured.value, bytes: captured.bytes, ...(toolStartedAt === undefined ? {} : { durationMs: Date.now() - toolStartedAt }), ...(event.isError ? { isError: true } : {}) } });
              watchdog.errorStreak = event.isError ? watchdog.errorStreak + 1 : 0;
              if (watchdog.errorStreak >= WATCHDOG_ERROR_STREAK) trip({ kind: "tool_error_streak", count: watchdog.errorStreak,
                detail: `watchdog: ${watchdog.errorStreak} consecutive tool errors` }, flight);
            }
            else if (event.kind === "result") {
              output = event.output && typeof event.output === "object" ? event.output as Record<string, unknown> : {};
              repo.patchParticipant(session.id, seat.name, { ...(event.resumeId ? { sdkSessionId: event.resumeId } : {}), contextTokens: Math.max(latestSeat.contextTokens, event.inputTokens ?? 0) });
              this.#recordUsage(session, latestSeat, turnId, event, "completed", Date.now() - startedAt);
            }
            else if (event.kind === "error") { status = event.aborted ? "aborted" : "error"; errorMessage = event.message; this.#recordUsage(session, latestSeat, turnId, event, status, Date.now() - startedAt); }
            if (watchdog.tripped) break;
          }
          // The provider (and the fake, whose string-prompt interrupt only
          // records) may keep streaming after our abort — leave explicitly.
          if (watchdog.tripped) break;
        }
      } finally { flight.query = null; query.close?.(); }
      if (watchdog.tripped) throw new Error(watchdog.tripped.detail);
      for (const delivery of deliveries) this.#patchDelivery(session, delivery, "acknowledged");
      repo.patchParticipant(session.id, seat.name, { turnCount: latestSeat.turnCount + 1,
        checkpointReady: output?.checkpointReadiness !== "defer" });
      const closing = HandoffDraftSchema.safeParse(output?.handoff);
      if (status === "completed" && closing.success) {
        const to = typeof output.to === "string" ? output.to : (seat.name === ORCHESTRATOR_SEAT ? MAIN_RECIPIENT : ORCHESTRATOR_SEAT);
        const category = typeof output.category === "string" && ["assignment", "update", "milestone", "failure", "final", "decision"].includes(output.category) ? output.category as Category : "update";
        const key = `${to}\u0000${JSON.stringify(closing.data)}`;
        if (!sentThisTurn.has(key)) this.post({ agentSessionId: session.id, speaker: { kind: seat.role === "orchestrator" ? "orchestrator" : "agent", name: seat.name }, to, handoff: closing.data, category, turnId });
      }
    } catch (error) {
      status = flight.abort.signal.aborted ? "aborted" : "error";
      errorMessage = error instanceof Error ? error.message : String(error);
      // A watchdog abort must not read as an operator abort: it is an error
      // with one canonical message, and the coordinator hears about it.
      if (watchdog.tripped) { status = "error"; errorMessage = watchdog.tripped.detail; }
      if (status === "error" && repo.getAgentSession(session.id)?.status === "open") {
        const target = seat.name === ORCHESTRATOR_SEAT ? MAIN_RECIPIENT : ORCHESTRATOR_SEAT;
        this.post({ agentSessionId: session.id, speaker: { kind: seat.role === "orchestrator" ? "orchestrator" : "agent", name: seat.name }, to: target,
          handoff: this.#simpleHandoff("Turn failed", "failed",
            watchdog.tripped ? watchdog.tripped.detail : `Provider turn failed: ${errorMessage}`,
            "Inspect the failure and retry or reassign."), category: "failure", turnId });
      }
    } finally {
      if (status !== "completed") for (const delivery of deliveries) this.#patchDelivery(session, delivery, "cancelled");
      runtime.idle();
      bus.append({ type: "agent_session.turn.settled", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, participant: seat.name, turnId, status, durationMs: Date.now() - startedAt, ...(errorMessage ? { errorMessage } : {}) } });
      // File-state snapshot per settled turn: mid-assignment crash recovery is
      // lossless, and the completion diff (base..branch) is unaffected. The
      // worktree may already be merged away by this turn's closing handoff.
      const current = repo.getParticipant(session.id, seat.name);
      if (current?.worktreePath && this.#deps.worktrees && fs.existsSync(current.worktreePath)) {
        try { this.#deps.worktrees.commitAll(current.worktreePath, `turn ${turnId}`); } catch { /* snapshot is best-effort */ }
      }
    }
  }

  #buildParticipantMcp(sdk: ConsoleSdk, session: AgentSessionRow, seat: ParticipantRow, signal: AbortSignal, sentThisTurn: Set<string>): unknown {
    const tool = sdk.tool("send_message", "Persist and deliver one typed, evidence-bearing handoff through the Console mailbox. Specialists may address only orchestrator; coordinators may address specialists or main.", {
      to: z.string(), handoff: HandoffDraftSchema, category: z.enum(["assignment", "update", "milestone", "failure", "final", "decision"]).default("update"), dedupeKey: z.string().optional(),
    }, async (args: { to: string; handoff: HandoffDraft; category: Category; dedupeKey?: string }) => {
      try {
        const message = this.post({ agentSessionId: session.id, speaker: { kind: seat.role === "orchestrator" ? "orchestrator" : "agent", name: seat.name }, to: args.to, handoff: args.handoff, category: args.category, ...(args.dedupeKey ? { dedupeKey: args.dedupeKey } : {}) });
        sentThisTurn.add(`${args.to}\u0000${JSON.stringify(args.handoff)}`);
        return ok({ delivered: true, messageSeq: message.seq, handoffId: (message.payload?.handoff as { id?: string } | undefined)?.id });
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    });
    const profile = seat.profileSnapshot as AgentProfile;
    const tools: unknown[] = [tool];
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
    const user = this.#deps.repo.getUserSession(session.userSessionId);
    const workspaceRoot = user && this.#deps.getWorkspaceRoot ? this.#deps.getWorkspaceRoot(user.workspaceId) : "";
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
    if (seat.name === ORCHESTRATOR_SEAT && this.#deps.tasks && user) {
      const listId = `console:${session.id}:${ORCHESTRATOR_SEAT}`;
      tools.push(
        sdk.tool("task_create", "Create one authoritative task for a coherent unit and assign an explicit specialist owner.", { subject: z.string(), description: z.string().default(""), owner: z.string() }, async (args: { subject: string; description: string; owner: string }) => {
          const taskId = newId("task"); this.#deps.tasks?.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: taskId, subject: args.subject, description: args.description,
            attribution: { workspaceId: user.workspaceId, userSessionId: session.userSessionId, agentSessionId: session.id, participant: args.owner } }); return ok({ taskId });
        }),
        sdk.tool("task_update", "Update status or ownership in the authoritative Console task ledger.", { taskId: z.string(), status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(), owner: z.string().optional(), description: z.string().optional() }, async (args: { taskId: string; status?: "pending" | "in_progress" | "completed" | "deleted"; owner?: string; description?: string }) => {
          this.#deps.tasks?.applyUpdate({ sdkSessionId: listId, sdkTaskId: args.taskId, patch: { ...(args.status ? { status: args.status } : {}), ...(args.owner ? { owner: args.owner } : {}), ...(args.description ? { description: args.description } : {}) } }); return ok({ updated: true });
        }),
        sdk.tool("task_list", "List the AgentSession's authoritative Console tasks. Retrieval is paged (tail-first, default 8KiB window; cursors continue).", { cursor: z.string().optional(), maxBytes: z.number().int().min(1).max(32 * 1024).default(8 * 1024) }, async (args: { cursor?: string; maxBytes: number }) => {
          const rows = this.#deps.tasks?.listForUserSession(session.userSessionId).filter((task) => task.agentSessionId === session.id && task.status !== "deleted") ?? [];
          return ok({ taskCount: rows.length, tasks: pageTail(JSON.stringify(rows, null, 2), args.cursor, args.maxBytes) });
        }),
      );
    }
    return sdk.createSdkMcpServer({ name: "console_agent", version: "2", tools });
  }

  #runtimeToolNames(profile: AgentProfile, participant: string, attemptRole?: string | null): string[] {
    return ["mcp__console_agent__send_message", "mcp__console_agent__read_handoff", "mcp__console_agent__report_handoff_discrepancy",
      ...(profile.runtime.shell ? ["mcp__console_agent__process_start", "mcp__console_agent__process_read", "mcp__console_agent__process_stop"] : []),
      ...(profile.runtime.browser ? ["mcp__console_agent__browser_open", "mcp__console_agent__browser_snapshot", "mcp__console_agent__browser_click", "mcp__console_agent__browser_fill", "mcp__console_agent__browser_console"] : []),
      ...(profile.runtime.browser && profile.runtime.screenshots ? ["mcp__console_agent__browser_screenshot"] : []),
      ...(participant === ORCHESTRATOR_SEAT ? ["mcp__console_agent__request_decision"] : []),
      ...(participant === ORCHESTRATOR_SEAT ? ["mcp__console_agent__task_create", "mcp__console_agent__task_update", "mcp__console_agent__task_list"] : []),
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
      return `${p.name} (${p.profileId}; owns: ${scopes || "coordination"})`;
    }).join("; ");
    const messages = rows.map((row) => {
      const id = (row.payload?.handoff as { id?: string } | undefined)?.id;
      if (!id || !this.#deps.handoffs) return `[${row.speakerName} → ${row.toName} | ${row.createdAt}] ${row.text}`;
      const handoff = this.#deps.handoffs.get(id);
      const expanded = handoff.core.risk === "high" || handoff.core.status === "needs_verification" || handoff.core.requestExpandedContext;
      this.#deps.bus.append({ type: "handoff.consumed", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { handoffId: id, participant: seat.name, mode: expanded ? "expanded" : "compact" } });
      return `[${row.speakerName} → ${row.toName} | ${row.createdAt}] Handoff ${id}\nCORE:\n${JSON.stringify(handoff.core, null, 2)}\nEVIDENCE MANIFEST: ${JSON.stringify([...handoff.core.state.evidence, ...handoff.core.result.artifacts])}${expanded ? `\nPROFILE EXTENSION:\n${JSON.stringify(handoff.extension, null, 2)}` : `\nExtension ${handoff.extension.kind} is available with read_handoff.`}`;
    }).join("\n\n");
    return `AgentSession ${session.id}: ${session.title}\nYou are ${seat.name}. Participants: ${roster}.\n\nOnly the following addressed handoffs are new:\n${messages}\n\nTreat handoff claims as historical context; verify risky claims against repository/task/journal evidence during normal work. Act without restating the envelope. Use typed send_message for every transfer. Finish with one structured closing output; set checkpointReadiness=defer only while state is genuinely unstable.`;
  }

  #simpleHandoff(action: string, status: HandoffDraft["core"]["status"], summary: string, nextAction: string | null): HandoffDraft {
    return { core: { schemaVersion: 1, taskId: null, status, risk: status === "failed" || status === "blocked" ? "high" : "medium",
      action, state: { summary, evidence: [] }, result: { summary: null, artifacts: [] }, uncertainty: [], nextAction,
      requestExpandedContext: status === "failed" }, extension: { kind: "generic", data: {} } };
  }

  async #rotateIfNeeded(session: AgentSessionRow, seat: ParticipantRow, sdk: ConsoleSdk, flight: Flight): Promise<ParticipantRow> {
    const config = this.#deps.config;
    if (!config || !this.#deps.handoffs) return seat;
    const tokenLimit = rotationTokenLimit(config.contextTokenLimit, seat.model ?? config.model);
    const hard = seat.turnCount >= config.contextTurnLimit || seat.contextTokens >= tokenLimit;
    const soft = seat.turnCount >= Math.ceil(config.contextTurnLimit * 0.8) || seat.contextTokens >= Math.ceil(tokenLimit * 0.75);
    if (!soft || (!hard && !seat.checkpointReady)) return seat;
    const threshold = hard ? "hard" as const : "soft" as const;
    const started = Date.now();
    let { draft, failure } = await this.#checkpointQuery(session, seat, sdk, flight, "");
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
        const retry = await this.#checkpointQuery(session, seat, sdk, flight,
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
      if (!hard) {
        this.#deps.bus.append({ type: "handoff.checkpoint.failed", userSessionId: session.userSessionId, agentSessionId: session.id,
          payload: { participant: seat.name, reason: failure ?? "checkpoint produced no valid handoff", threshold, degraded: false } });
        return seat;
      }
      degraded = true;
      const latest = this.#deps.repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, participant: seat.name });
      draft = latest ? { core: { ...latest.core, action: `Recovery checkpoint: ${latest.core.action}`, status: "needs_verification", risk: "high", requestExpandedContext: true }, extension: latest.extension }
        : this.#simpleHandoff("Recover interrupted context", "needs_verification", "No valid model checkpoint was available. Reconstruct state from the task ledger, repository, provider journal, and incoming assignment.", "Verify authoritative state before continuing.");
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
  async #checkpointQuery(session: AgentSessionRow, seat: ParticipantRow, sdk: ConsoleSdk, flight: Flight, promptSuffix: string): Promise<{ draft: HandoffDraft | null; failure: string | null }> {
    const config = this.#deps.config;
    let draft: HandoffDraft | null = null;
    let failure: string | null = null;
    if (!seat.sdkSessionId) return { draft, failure };
    const checkpointAbort = new AbortController();
    const profile = seat.profileSnapshot as AgentProfile;
    const user = this.#deps.repo.getUserSession(session.userSessionId);
    if (!user || !this.#deps.getWorkspaceRoot) return { draft, failure };
    const checkpointRoot = seat.worktreePath ?? this.#deps.getWorkspaceRoot(user.workspaceId);
    const query = sdk.query({ prompt: `Create a lossless rotation checkpoint for your successor context. Capture only durable task state, verified evidence pointers, results, uncertainty, and the exact next action. Do not perform work or call tools.${promptSuffix}`, options: {
      cwd: checkpointRoot, systemPrompt: { type: "preset", preset: "claude_code", append: "You are checkpointing your own context. Report faithfully; do not correct or embellish uncertain state." },
      settingSources: [], includePartialMessages: false, permissionMode: "plan", allowedTools: [],
      disallowedTools: ["Agent", "SendMessage", "Task", "Bash", "Edit", "Write", "WebSearch", "WebFetch"],
      outputFormat: { type: "json_schema", schema: CheckpointClosingSchema.properties.handoff }, maxTurns: 2,
      sandbox: { enabled: true, failIfUnavailable: profile.sandboxRequired, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
        filesystem: { allowManagedReadPathsOnly: true, allowRead: seat.worktreePath ? [checkpointRoot, this.#deps.getWorkspaceRoot(user.workspaceId)] : [checkpointRoot], allowWrite: [] } },
      env: sdkEnv(), abortController: checkpointAbort, persistSession: true, sessionStore: this.#deps.sessionStore as never,
      sessionStoreFlush: "eager", resume: seat.sdkSessionId, ...(seat.model ? { model: seat.model } : {}),
      ...((profile.effort ?? config?.effort) ? { effort: (profile.effort ?? config?.effort) as SdkOptions["effort"] } : {}),
    } });
    flight.query = query;
    try {
      for await (const raw of query) for (const event of mapSdkMessage(raw)) {
        if (event.kind === "result") {
          const parsed = HandoffDraftSchema.safeParse(event.output);
          if (parsed.success) draft = parsed.data;
          this.#recordUsage(session, seat, `checkpoint:${newId("turn")}`, event);
        } else if (event.kind === "error") failure = event.message;
      }
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    finally { flight.query = null; query.close?.(); }
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

  #recordUsage(session: AgentSessionRow, seat: ParticipantRow, turnId: string, usageEvent: { inputTokens?: number; uncachedInputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; outputTokens?: number; costUsd?: number; modelId?: string; apiDurationMs?: number; sdkDurationMs?: number; stopReason?: string }, status: "completed" | "error" | "aborted" = "completed", durationMs?: number): void {
    const usage = { id: newId("usage"), userSessionId: session.userSessionId, agentSessionId: session.id, participant: seat.name, profileId: seat.profileId,
      generation: seat.generation, turnId, inputTokens: usageEvent.inputTokens ?? 0, uncachedInputTokens: usageEvent.uncachedInputTokens ?? 0,
      cacheCreationInputTokens: usageEvent.cacheCreationInputTokens ?? 0, cacheReadInputTokens: usageEvent.cacheReadInputTokens ?? 0,
      outputTokens: usageEvent.outputTokens ?? 0, costUsd: usageEvent.costUsd ?? null,
      model: usageEvent.modelId ?? seat.model, effort: (seat.profileSnapshot as AgentProfile).effort ?? this.#deps.config?.effort ?? null,
      trigger: "delivery", durationMs: durationMs ?? null, apiDurationMs: usageEvent.apiDurationMs ?? null, sdkDurationMs: usageEvent.sdkDurationMs ?? null, status, stopReason: usageEvent.stopReason ?? null, createdAt: nowIso() };
    this.#deps.repo.insertUsage(usage);
    this.#deps.bus.append({ type: "usage.recorded", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { sessionId: session.id, participant: seat.name, profileId: seat.profileId, generation: seat.generation, turnId,
        inputTokens: usage.inputTokens, uncachedInputTokens: usage.uncachedInputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens, outputTokens: usage.outputTokens, ...(usageEvent.costUsd === undefined ? {} : { costUsd: usageEvent.costUsd }),
        model: usage.model ?? undefined, effort: usage.effort ?? undefined, trigger: "delivery", durationMs: usage.durationMs ?? undefined,
        apiDurationMs: usage.apiDurationMs ?? undefined, sdkDurationMs: usage.sdkDurationMs ?? undefined, status, stopReason: usage.stopReason ?? undefined } });
  }

  #patchDelivery(session: AgentSessionRow, delivery: MailboxDeliveryRow, status: "delivered" | "acknowledged" | "cancelled"): void {
    const now = nowIso();
    this.#deps.repo.patchDelivery(delivery.id, { status, ...(status === "delivered" ? { deliveredAt: now } : {}), ...(status === "acknowledged" ? { acknowledgedAt: now, deliveredAt: delivery.deliveredAt ?? now } : {}) });
    const message = this.#deps.repo.getMessageById(delivery.messageId);
    this.#deps.bus.append({ type: "agent_session.mailbox", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, deliveryId: delivery.id, messageSeq: message?.seq ?? 0, sender: delivery.sender, recipient: delivery.recipient, category: delivery.category, status } });
  }

  #specialists(id: string): ParticipantRow[] { return this.#deps.repo.listParticipants(id).filter((p) => p.role === "agent"); }
  #statusOf(row: AgentSessionRow): "working" | "idle" | "archived" {
    if (row.status === "archived") return "archived";
    return (this.#lanes.get(row.id)?.turns.size ?? 0) > 0 || this.#deps.repo.listQueuedDeliveries(row.id).some((d) => d.recipient !== MAIN_RECIPIENT) ? "working" : "idle";
  }
  #setStatus(id: string, status: "working" | "idle"): void {
    const lane = this.#lane(id); if (lane.lastStatus === status) return;
    if (lane.lastStatus === null && status === "idle") { lane.lastStatus = status; return; }
    lane.lastStatus = status; const session = this.#deps.repo.getAgentSession(id); if (!session) return;
    this.#deps.bus.append({ type: "agent_session.status", userSessionId: session.userSessionId, agentSessionId: id, payload: { agentSessionId: id, status, owedToOrchestrator: false } });
  }
  #recordHostFailure(id: string, error: unknown): void {
    const session = this.#deps.repo.getAgentSession(id); if (!session) return;
    const text = error instanceof Error ? error.message : String(error);
    this.#deps.bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: id, payload: { agentSessionId: id, participant: "system", detail: `scheduler failure: ${text}` } });
  }
}
