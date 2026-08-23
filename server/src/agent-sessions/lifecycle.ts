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
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import type { AgentLanePool } from "./lanes.ts";
import { CHILD_SENDER_PREFIX, CONSOLE_SENDER, COORDINATOR_AGENT, MAIN_RECIPIENT } from "./names.ts";
import { buildContract } from "./patterns/catalog.ts";
import type { SessionRouting } from "./routing.ts";
import type { Deliver, RecordFailure, SimpleHandoff, Transfer } from "./seams.ts";
import { sessionTree } from "./session-tree.ts";
import { AGENT_NAME_RE, RESERVED_NAMES } from "./topology.ts";
import { consoleTaskListId, type TaskService } from "../tasks/service.ts";
import type { RequirementService } from "../orchestrator/requirements.ts";
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
   * waking the runner. Nesting is capped by `config.policy.maxSessionDepth`;
   * sessions at the cap never get the spawn grant.
   */
  parent?: { agentSessionId: string; controllerAgent: string };
  /** Grants the entry agent create_child_session (depth cap still applies). */
  allowChildSessions?: boolean;
  /**
   * Requirement ids this session is commissioned against — its delegated
   * sub-scope. Recorded BEFORE the briefing dispatches so the very first
   * delivery renders the delegated block. Child sessions pass a subset down.
   */
  requirements?: string[];
  agents: { name: string; profileId?: string; instructions?: string; model?: string; owns?: string[]; skills?: string[] }[];
  briefing?: HandoffDraft;
  /**
   * Ledger units created WITH the session, before its briefing dispatches —
   * the old "task_create before the briefing" instruction was impossible to
   * follow (the briefing posts synchronously inside creation), so no
   * assignment could ever reference a task and the auto-sync never fired.
   */
  tasks?: { taskId: string; subject: string; description?: string; owner?: string; blockedBy?: string[]; requirementId?: string }[];
}

export interface SessionLifecycleDeps {
  repo: Repo;
  bus: EventBus;
  config: Config;
  profiles: AgentProfileRegistry;
  getWorkspaceRoot: (workspaceId: string) => string;
  /** OS capabilities. `null` = absent, stated at the construction site. */
  worktrees: WorktreeManager | null;
  routing: SessionRouting;
  lanes: AgentLanePool;
  worktree: WorktreeBinding;
  transfer: Transfer;
  simpleHandoff: SimpleHandoff;
  /** Ledger upserts for creation-time task units. */
  tasks: TaskService;
  /** Delegation recording for commission-time requirement sub-scopes. */
  requirements: RequirementService;
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
      if (parentRow.depth + 1 > this.#deps.config.policy.maxSessionDepth) throw new InvalidInputError(`session nesting is capped at depth ${this.#deps.config.policy.maxSessionDepth}`);
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
      // LINEAGE-scoped disjointness: the ancestor chain (whose scopes are
      // being delegated from) and open SIBLINGS (concurrent writers under the
      // same parent). Cousins under other branches are deliberately not
      // consulted — flat sibling sessions never were, and the old whole-tree
      // scan made a child session strictly harder to create than the flat
      // session it replaced (one of five structural reasons a 12-hour live
      // run created zero child sessions).
      const lineage: AgentSessionRow[] = [];
      for (let cursor: AgentSessionRow | null = parentRow; cursor !== null;
        cursor = cursor.parentAgentSessionId === null ? null : repo.getAgentSession(cursor.parentAgentSessionId) ?? null) {
        lineage.push(cursor);
      }
      const siblings = repo.listChildSessions(parentRow.id);
      const treeSessions = [...lineage, ...siblings].filter((row) => row.lifecycle === "open");
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
      depth: parentRow ? parentRow.depth + 1 : 0,
      allowChildSessions: input.allowChildSessions === true,
    };
    repo.insertAgentSession(row);
    if (parentRow) {
      bus.append({ type: "agent_session.child.spawned", userSessionId: row.userSessionId, agentSessionId: parentRow.id,
        payload: { agentSessionId: parentRow.id, childAgentSessionId: row.id, pattern: row.pattern,
          byAgent: input.parent!.controllerAgent, title } });
    }
    for (const plan of build.agents) {
      const profile = this.#deps.snapshotProfile(this.profile(plan.profileId, parent.workspaceId));
      // Commission-time skills pin into THIS seat's snapshot: rotation
      // respawns the same skill set; the base profile is untouched.
      const seatProfile = plan.skills === undefined || plan.skills.length === 0 ? profile
        : { ...profile, skills: [...new Set([...(profile.skills ?? []), ...plan.skills])] };
      repo.insertAgent(this.agentRow(row.id, plan.name, plan.role, seatProfile, plan.instructions ?? "", plan.model, plan.owns, plan.ord, now));
    }
    // The delegated sub-scope lands BEFORE the briefing so the first
    // delivery renders it; source reflects who commissioned (main or a
    // controller spawning a child).
    if (input.requirements !== undefined && input.requirements.length > 0) {
      this.#deps.requirements.delegate(
        input.userSessionId, row.id, input.requirements, parentRow ? "child" : "commission");
    }
    // Units land BEFORE the briefing so the briefing's taskId resolves and
    // syncLedgerFromHandoff can mark the entry assignment in_progress.
    const roster = new Set(build.agents.map((plan) => plan.name));
    for (const unit of input.tasks ?? []) {
      if (unit.owner !== undefined && !roster.has(unit.owner)) {
        throw new InvalidInputError(`task "${unit.taskId}" names owner "${unit.owner}", who is not in this session`);
      }
      this.#deps.tasks.upsertFromCreate({
        sdkSessionId: consoleTaskListId(row.id), sdkTaskId: unit.taskId, subject: unit.subject,
        ...(unit.description === undefined ? {} : { description: unit.description }),
        ...(unit.owner === undefined ? {} : { owner: unit.owner }),
        ...(unit.blockedBy === undefined ? {} : { blockedBy: unit.blockedBy }),
        ...(unit.requirementId === undefined ? {} : { requirementId: unit.requirementId }),
        attribution: { workspaceId: user.workspaceId, userSessionId: input.userSessionId, agentSessionId: row.id, agent: null },
      });
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

  /**
   * Mid-run roster growth, for exactly the patterns whose contracts have an
   * open multi-seat role that is neither the completion voice nor
   * join-collected nor runtime-minted: hub specialists, plan_execute
   * executors, peer_to_peer peers. Everything else refuses — a late debate
   * position would never be join-collected, a pipeline's stages ARE its
   * shape, and mappers are the reducer's to mint. The contract stays frozen;
   * `agents.role` is the binding, which is what makes a late seat honest.
   */
  addAgent(agentSessionId: string, input: { name: string; profileId: string; instructions?: string; model?: string; owns?: string[]; skills?: string[]; why?: string }): { agent: string; role: string } {
    const { repo, bus } = this.#deps;
    const session = repo.getAgentSession(agentSessionId);
    if (!session) throw new NotFoundError(`no agent session ${agentSessionId}`);
    if (session.lifecycle !== "open") throw new InvalidInputError(`agent session ${agentSessionId} is archived`);
    const contract = this.#deps.routing.contractOf(session).contract;
    const joinRoles = new Set(contract.joins.map((join) => join.over));
    const candidates = Object.entries(contract.roles).filter(([role, spec]) =>
      spec.max > 1 && !spec.replicable && !joinRoles.has(role) &&
      role !== contract.completion.finalFrom && role !== contract.completion.voice);
    if (candidates.length !== 1) {
      throw new InvalidInputError(`the ${session.pattern} roster is fixed; spawn a follow-up session with create_agent_session instead`);
    }
    const [role, spec] = candidates[0]!;
    const existing = repo.listAgents(agentSessionId);
    const inRole = existing.filter((seat) => seat.role === role).length;
    if (inRole >= spec.max) throw new InvalidInputError(`role ${role} is at its cap of ${spec.max}`);
    const name = input.name.trim();
    if (!AGENT_NAME_RE.test(name) || RESERVED_NAMES.has(name.toLowerCase()) || name.toLowerCase().startsWith(CHILD_SENDER_PREFIX)) {
      throw new InvalidInputError(`invalid or reserved agent name "${name}"`);
    }
    if (existing.some((seat) => seat.name === name)) throw new InvalidInputError(`duplicate agent name "${name}"`);
    const user = repo.getUserSession(session.userSessionId);
    if (!user) throw new NotFoundError("unknown user session");
    const profile = this.profile(input.profileId, user.workspaceId);
    const owns = (input.owns ?? []).map((scope) => scope.trim()).filter((scope) => scope !== "");
    const writes = profile.tools.includes("Edit") || profile.tools.includes("Write");
    if (writes && owns.length === 0) {
      throw new InvalidInputError(`agent "${name}" (${profile.id}) writes files, so it must declare what it owns`);
    }
    // Ownership disjointness across the whole TRUE-root session tree, same
    // rule as creation: every seat merges into one workspace.
    if (!profile.exemptFromOwnership) {
      const treeSessions = sessionTree(repo, session.id).filter((row) => row.lifecycle === "open");
      for (const treeSession of treeSessions) {
        for (const seat of repo.listAgents(treeSession.id)) {
          if ((seat.profileSnapshot as AgentProfile | undefined)?.exemptFromOwnership === true) continue;
          for (const scope of seat.ownership) {
            if (owns.includes(scope.trim()) && scope.trim() !== "") {
              throw new InvalidInputError(`ownership scope "${scope.trim()}" is assigned to both ${seat.name} and ${name}`);
            }
          }
        }
      }
    }
    const ord = existing.reduce((max, seat) => Math.max(max, seat.ord), -1) + 1;
    const snapshot = this.#deps.snapshotProfile(profile);
    const seatSnapshot = input.skills === undefined || input.skills.length === 0 ? snapshot
      : { ...snapshot, skills: [...new Set([...(snapshot.skills ?? []), ...input.skills])] };
    repo.insertAgent(this.agentRow(agentSessionId, name, role, seatSnapshot, input.instructions ?? "", input.model, owns, ord, nowIso()));
    const why = input.why?.trim();
    bus.append({ type: "agent_session.agent.added", userSessionId: session.userSessionId, agentSessionId,
      payload: { agentSessionId, agent: name, role, profileId: profile.id, ...(why ? { why } : {}) } });
    // The entry agent learns immediately — roster lines refresh per delivery,
    // but an unannounced teammate is a coordination trap. Main's rationale
    // rides the notice: the seat's PURPOSE shapes what work it gets.
    try {
      this.#deps.transfer({ agentSessionId, speaker: { kind: "system", name: CONSOLE_SENDER }, to: this.entryAgent(agentSessionId),
        handoff: this.#deps.simpleHandoff(`New agent "${name}" (${profile.id}) joined as ${role}`, "in_progress",
          `Main added "${name}" to this session mid-run${owns.length > 0 ? `; it owns ${owns.join(", ")}` : ""}${why ? `. Why: ${why}` : ""}. Assign it work as you would any ${role}.`,
          null), category: "update", dedupeKey: `agent-added:${agentSessionId}:${name}` });
    } catch { /* best effort — the seat exists and the roster shows it */ }
    return { agent: name, role };
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
   * afterwards. Returns what it released, so the summary can state it.
   *
   * Closing a seat's lane closes its CLI subprocess, and everything the agent
   * started — a background `Bash` dev server, an MCP server's browser — is a
   * child of that process. There is no separate console-owned process table to
   * sweep: the console stopped owning capability, so it stopped owning the
   * leaks too.
   */
  reapForUserSession(userSessionId: string): ReapResult {
    const seats: ReapResult["seats"] = [];
    for (const session of this.#deps.repo.listAgentSessions(userSessionId)) {
      if (session.lifecycle !== "open") continue;
      for (const seat of this.#deps.repo.listAgents(session.id)) {
        if (this.#deps.lanes.hasLane(session.id, seat.name)) seats.push({ agentSessionId: session.id, agent: seat.name });
      }
      this.#deps.lanes.closeAllForSession(session.id);
    }
    return { seats };
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
      salvageBranch: null, salvageArtifactId: null, pendingCheckpointHandoffId: null,
      ord, createdAt };
  }

  profile(id: string, workspaceId?: string): AgentProfile {
    if (this.#deps.profiles) return this.#deps.profiles.get(id, workspaceId);
    return { id, title: id, purpose: id, instructions: `You are the ${id} specialist.`, tools: ["Read", "Glob", "Grep"], permissionMode: "default", exemptFromOwnership: false, maxTurns: 30, mcpServers: {} };
  }
}
