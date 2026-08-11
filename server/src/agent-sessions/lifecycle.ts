/**
 * Session lifecycle: creation and teardown. Every creation-time validation —
 * roster names, ownership disjointness, the child cap — lives in
 * `createSession`, so a session that exists is one that passed them all.
 * `archiveOne` is the ONE teardown path and `#forget` the ONE cleanup point
 * for per-session in-memory structures. Boot redrive is restart-time
 * lifecycle: queued deliveries wake lanes; child-boundary rows re-cross
 * through the nesting broker.
 */
import type { HandoffDraft, PatternId } from "@agentique-console/shared";
import type { AgentProfile, AgentProfileRegistry } from "../agent-profiles/registry.ts";
import { toWireAgentSession } from "../api/wire.ts";
import type { ReapResult } from "../completion/summary.ts";
import type { Config } from "../config.ts";
import type { AgentRow, AgentSessionRow, MailboxDeliveryRow, Repo } from "../db/repo.ts";
import { InvalidInputError, NotFoundError } from "../errors.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";
import type { BrowserManager } from "../runtime/browser-manager.ts";
import type { ProcessManager } from "../runtime/process-manager.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import type { AgentLanePool } from "./lanes.ts";
import { CHILD_SENDER_PREFIX, COORDINATOR_AGENT, MAIN_RECIPIENT } from "./names.ts";
import { buildContract } from "./patterns/catalog.ts";
import type { SessionRouting } from "./routing.ts";
import type { Deliver, RecordFailure, Transfer } from "./seams.ts";
import { AGENT_NAME_RE, RESERVED_NAMES } from "./topology.ts";
import type { WorktreeBinding } from "./worktree-binding.ts";

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

export interface SessionLifecycleDeps {
  repo: Repo;
  bus: EventBus;
  config: Config;
  profiles: AgentProfileRegistry;
  getWorkspaceRoot: (workspaceId: string) => string;
  /** OS capabilities. `null` = absent, stated at the construction site. */
  processes: ProcessManager | null;
  browsers: BrowserManager | null;
  worktrees: WorktreeManager | null;
  routing: SessionRouting;
  lanes: AgentLanePool;
  worktree: WorktreeBinding;
  transfer: Transfer;
  /** `AgentRuntime.snapshotProfile` — the runtime owns snapshot semantics. */
  snapshotProfile: (profile: AgentProfile) => AgentProfile;
  /** `Mailroom.patchDelivery`, for cancelling active deliveries at archive. */
  patchDelivery: (session: AgentSessionRow, delivery: MailboxDeliveryRow, status: "queued" | "acknowledged" | "cancelled") => void;
  /** Console-path delivery, for the boot wake sweep. */
  deliver: Deliver;
  /** `NestingBroker.redriveChildBoundary` — boot replay of an unacked child-boundary row. */
  redriveChildBoundary: (session: AgentSessionRow, delivery: MailboxDeliveryRow) => void;
  /** `OperatorSurface.forget` — part of the ONE cleanup fan-out. */
  forgetOperator: (agentSessionId: string) => void;
  recordFailure: RecordFailure;
}

export class SessionLifecycle {
  readonly #deps: SessionLifecycleDeps;

  constructor(deps: SessionLifecycleDeps) { this.#deps = deps; }

  createSession(input: CreateAgentSessionInput): { agentSessionId: string; agents: string[]; entryAgent: string; coordinatorName?: string } {
    const { repo, bus } = this.#deps;
    const user = repo.getUserSession(input.userSessionId);
    if (!user) throw new NotFoundError(`no user session ${input.userSessionId}`);
    // The pattern builder owns roster bounds, role assignment, prompts and
    // wiring; the lifecycle only executes what comes out.
    const build = buildContract(input.pattern ?? "hub_and_spoke", {
      agents: input.agents, config: input.patternConfig,
      resolveProfile: (id) => this.profile(id, user.workspaceId),
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
      const profile = this.profile(agent.profileId ?? "explorer", user.workspaceId);
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
      if (this.profile(agent.profileId ?? "explorer", user.workspaceId).exemptFromOwnership) continue;
      for (const scope of agent.owns ?? []) {
        const normalized = scope.trim(); if (!normalized) continue;
        const owner = ownedScopes.get(normalized);
        if (owner) throw new InvalidInputError(`ownership scope \"${normalized}\" is assigned to both ${owner} and ${agent.name}`);
        ownedScopes.set(normalized, agent.name);
      }
    }
    // Worktree isolation needs a repository; ensured at session creation, not
    // lazily at agent spawn.
    this.#deps.worktree.ensureWorkspaceRepo(user.workspaceId, input.userSessionId);
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
      const profile = this.#deps.snapshotProfile(this.profile(plan.profileId, parent.workspaceId));
      repo.insertAgent(this.agentRow(row.id, plan.name, plan.role, profile, plan.instructions ?? "", plan.model, plan.owns, plan.ord, now));
    }
    const specialists = input.agents.map((agent) => agent.name);
    bus.append({ type: "agent_session.created", userSessionId: row.userSessionId, agentSessionId: row.id,
      payload: { session: toWireAgentSession(row, specialists, false), agents: specialists } });
    bus.append({ type: "agent_session.delegation.sent", userSessionId: row.userSessionId, agentSessionId: row.id,
      payload: { userSessionId: row.userSessionId, agentSessionId: row.id, kind: "created", preview: title } });
    const entry = this.#deps.routing.contractOf(row).contract.entry;
    const entrySeats = this.#deps.routing.agentsOfRole(row.id, entry.role);
    if (input.briefing) {
      for (const seat of entry.broadcast ? entrySeats : entrySeats.slice(0, 1)) {
        this.#deps.transfer({ agentSessionId: row.id, speaker: { kind: "orchestrator", name: MAIN_RECIPIENT }, to: seat.name, handoff: input.briefing, category: "assignment" });
      }
    }
    return { agentSessionId: row.id, agents: specialists, entryAgent: entrySeats[0]?.name ?? COORDINATOR_AGENT,
      ...(build.coordinatorName !== undefined ? { coordinatorName: build.coordinatorName } : {}) };
  }

  /** The agent main steers: the contract entry role's first agent. */
  entryAgent(agentSessionId: string): string {
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (!session) throw new NotFoundError(`no agent session ${agentSessionId}`);
    const entry = this.#deps.routing.contractOf(session).contract.entry;
    return this.#deps.routing.agentsOfRole(agentSessionId, entry.role)[0]?.name ?? COORDINATOR_AGENT;
  }

  /** Whole-session stop (archive/shutdown): every lane closes hard. */
  interrupt(agentSessionId: string): void {
    this.#deps.lanes.closeAllForSession(agentSessionId);
  }

  async closeAll(): Promise<void> {
    await this.#deps.lanes.closeAll();
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
    for (const session of open) this.archiveOne(session);
  }

  /** The ONE teardown path — the nesting broker archives through this too. */
  archiveOne(session: AgentSessionRow): void {
    this.interrupt(session.id);
    this.#deps.processes?.stopSession(session.id);
    void this.#deps.browsers?.closeSession(session.id);
    this.#deps.worktree.removeForSession(session);
    for (const delivery of this.#deps.repo.listActiveDeliveries(session.id)) this.#deps.patchDelivery(session, delivery, "cancelled");
    this.#deps.repo.patchAgentSession(session.id, { lifecycle: "archived" });
    this.#forget(session.id);
    this.#deps.bus.append({ type: "agent_session.status.changed", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, status: "archived" } });
  }

  /** The ONE cleanup point for every per-session in-memory structure. */
  #forget(agentSessionId: string): void {
    this.#deps.lanes.forget(agentSessionId);
    this.#deps.forgetOperator(agentSessionId);
    this.#deps.routing.forget(agentSessionId);
  }

  boot(): void {
    const wakes = new Set<string>();
    for (const delivery of this.#deps.repo.listQueuedDeliveries()) {
      if (delivery.recipient === MAIN_RECIPIENT) {
        const session = this.#deps.repo.getAgentSession(delivery.agentSessionId);
        if (session && session.lifecycle === "open" && session.parentAgentSessionId !== null) this.#deps.redriveChildBoundary(session, delivery);
        continue;
      }
      wakes.add(`${delivery.agentSessionId} ${delivery.recipient}`);
    }
    for (const key of wakes) {
      const [agentSessionId, recipient] = key.split(" ") as [string, string];
      void this.#deps.deliver(agentSessionId, recipient).catch((error) => this.#deps.recordFailure(agentSessionId, error));
    }
  }

  agentRow(agentSessionId: string, name: string, role: string, profile: AgentProfile, extra: string, model: string | undefined, ownership: string[], ord: number, createdAt: string): AgentRow {
    const instructions = [profile.instructions, extra.trim()].filter(Boolean).join("\n\nAssigned role context:\n");
    return { agentSessionId, name, role, instructions, model: model ?? profile.model ?? null,
      profileId: profile.id, profileSnapshot: profile, ownership, sdkSessionId: null, lastActiveAt: null,
      generation: 0, turnCount: 0,
      contextTokens: 0, latestHandoffId: null,
      cumulativeCostUsd: 0, cumulativeApiDurationMs: 0, lastDecisionAt: null,
      worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null,
      ord, createdAt };
  }

  profile(id: string, workspaceId?: string): AgentProfile {
    if (this.#deps.profiles) return this.#deps.profiles.get(id, workspaceId);
    return { id, title: id, purpose: id, instructions: `You are the ${id} specialist.`, tools: ["Read", "Glob", "Grep"], permissionMode: "default", exemptFromOwnership: false, maxTurns: 30, sandboxRequired: true, runtime: { shell: false, browser: false, screenshots: false, network: [] } };
  }
}
