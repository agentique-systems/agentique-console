/**
 * The agent runtime: SDK-event translation and turn lifecycle over pool lanes.
 * One machine — the pump dispatches every mapped SDK event, the watchdog trips
 * inside it, and settle closes the turn. Everything a settle touches beyond
 * the lane itself (mailroom delivery transitions, escalation and relay posts,
 * operator-status refresh) arrives as the typed
 * `SettleHooks` bundle wired by the composition root — the mailroom↔runtime
 * dependency is a cycle only that root may close, and this module never
 * imports the service.
 */
import type { HandoffDraft } from "@agentique-console/shared";
import fs from "node:fs";
import path from "node:path";
import type { AgentProfile } from "../agent-profiles/registry.ts";
import { toWireMessage } from "../api/wire.ts";
import { AsyncQueue } from "../async-queue.ts";
import type { Config } from "../config.ts";
import type { AgentRow, AgentSessionRow, MailboxDeliveryRow, Repo } from "../db/repo.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import type { ArtifactStore } from "../events/artifact-store.ts";
import type { EventBus } from "../events/bus.ts";
import { RuntimeBroadcaster } from "../events/runtime.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { newId, nowIso } from "../ids.ts";
import { advanceUsageWatermark } from "../lane-runtime/usage.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import type { EffortLevel } from "../sdk/effort.ts";
import { sdkEnv } from "../sdk/env.ts";
import { isCapacityFailure, isTransportFailure } from "../sdk/failure-classifier.ts";
import { mapSdkMessage } from "../sdk/mapping.ts";
import type { SqliteSessionStore } from "../sdk/session-store.ts";
import type { CapacityService } from "../capacity/service.ts";
import type { ConsoleSdk, QueryHandle, SdkOptions, SdkToolResult, SdkUserMessageLike } from "../sdk/types.ts";
import type { AssignmentScheduler } from "../tasks/scheduler.ts";
import type { TaskService } from "../tasks/service.ts";
import { buildAgentTools, type AgentToolsContext, type AskOperatorArgs } from "./agent-tools.ts";
import { declaredMcpServers, mcpGrantNames, seatUserMessage, type PromptComposer } from "./composer.ts";
import { effectiveNativeTools, seatDisallowedNativeTools } from "../sdk/native-capability-policy.ts";
import { grantedTools, runtimeToolNames, type AgentToolName } from "./grants.ts";
import type { ActiveTurn, AgentLane, AgentLanePool } from "./lanes.ts";
import type { DispatchWorkItemsInput } from "./patterns/engine.ts";
import type { AssumptionService } from "../orchestrator/assumptions.ts";
import type { RequirementService } from "../orchestrator/requirements.ts";
import type { SessionRouting } from "./routing.ts";
import type { Deliver, Injector, RecordFailure, Transfer } from "./seams.ts";
import { hubContract, roleOfAgent, speakerKindOf } from "./topology.ts";
import type { WorktreeBinding } from "./worktree-binding.ts";

/** JSON with recursively sorted object keys — a stable identity for tool inputs. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/** Prefix for the first prompt a seat sees after an operator pause cut its turn. */
export function pauseResumeNoteText(pausedAt: string): string {
  return `[Console: the operator paused the whole system at ${pausedAt} while you were mid-turn on the handoffs below; it resumed at ${nowIso()}. Your provider session and worktree are intact — CONTINUE the work in progress; do not restart it. The handoffs are re-delivered only so you have them in context.]`;
}

/** The turn-attribution facts the agent tools bind (send attribution). */
export interface TurnTracker {
  /** The agent's in-flight turn id, if a turn is open right now. */
  currentTurnId(agentSessionId: string, agent: string): string | undefined;
  /** Mark the agent's in-flight turn as having sent a handoff. */
  markSawSend(agentSessionId: string, agent: string): void;
}

/**
 * Settle's side effects beyond the lane itself. Typed callbacks: the mailroom
 * needs the runtime's injector while settle needs the mailroom's transitions,
 * a cycle only the composition root closes — so the runtime never imports the
 * modules these belong to.
 */
export interface SettleHooks {
  /** Mailroom delivery-status transition (ack / cancel / requeue). */
  patchDelivery(session: AgentSessionRow, delivery: MailboxDeliveryRow, status: "queued" | "acknowledged" | "cancelled"): void;
  /** Console-path redelivery of rows a failed turn requeued. */
  deliver: Deliver;
  /** The failure handoff to the seat's escalation target. */
  escalateFailure(session: AgentSessionRow, seatName: string, seat: AgentRow | undefined, turn: ActiveTurn, reason: string): void;
  /** The relay decision: carry a silent settled turn's text to its collector. */
  carryReport(session: AgentSessionRow, seatName: string, turn: ActiveTurn): void;
  /** The once-per-assignment turn-budget notice to the escalation target. */
  turnBudgetNotice(session: AgentSessionRow, seat: AgentRow, turn: ActiveTurn, spentTurns: number): void;
  /** Re-derive the session's operator-facing status after the turn settles. */
  refreshStatus(agentSessionId: string): void;
  /** Journal a host-side failure as a runtime notice on the session. */
  recordFailure: RecordFailure;
}

export interface AgentRuntimeDeps {
  repo: Repo;
  bus: EventBus;
  config: Config;
  sdk: () => Promise<ConsoleSdk>;
  sessionStore: SqliteSessionStore;
  getWorkspaceRoot: (workspaceId: string) => string;
  artifacts: ArtifactStore;
  tasks: TaskService;
  handoffs: HandoffService;
  /** The governing requirements (legacy-spec fallback inside), for the seats' requirement tools. */
  requirements: RequirementService;
  /** Recorded premises, for the seats' assumption tools. */
  assumptions: AssumptionService;
  /** OS capabilities. `null` = absent, stated at the construction site. */
  worktrees: WorktreeManager | null;
  /** Lazy — the scheduler posts through the service, composed after it. */
  scheduler: () => AssignmentScheduler;
  /** Pause/resume on provider capacity and budget ceilings. */
  capacity: CapacityService;
  lanes: AgentLanePool;
  worktree: WorktreeBinding;
  routing: SessionRouting;
  composer: PromptComposer;
  /** The ONE transfer path (`AgentSessionService.post`), as a capability. */
  transfer: Transfer;
  /** `OperatorSurface.askOperator`, bound to the asking seat's turn. */
  askOperator: (session: AgentSessionRow, seat: AgentRow, args: AskOperatorArgs) => Promise<SdkToolResult>;
  /** Lifecycle/nesting capabilities — facade-wired: both post back through the mailroom. */
  createChildSession: (session: AgentSessionRow, controller: AgentRow, input: Parameters<AgentToolsContext["createChildSession"]>[0]) => ReturnType<AgentToolsContext["createChildSession"]>;
  abandonChildSession: (session: AgentSessionRow, controller: AgentRow, childAgentSessionId: string, reason: string) => void;
  dispatchWorkItems: (dispatcherAgent: string, input: DispatchWorkItemsInput) => { joinId: string; agents: string[] };
  /** Turn minting marks the session working (operator status). */
  markWorking: (agentSessionId: string) => void;
  /** Commission-budget check (session + ancestors), beside the run-level capacity check. */
  checkCommissionBudget: (session: AgentSessionRow) => void;
  hooks: SettleHooks;
}

/** Pump, watchdog, mint/settle, and the mint-or-steer injector — one machine. */
export class AgentRuntime implements Injector, TurnTracker {
  readonly #deps: AgentRuntimeDeps;

  constructor(deps: AgentRuntimeDeps) { this.#deps = deps; }

  // ── Injector — the mailroom's console-delivery seam ──────────────────────

  ready(agentSessionId: string, recipient: string): boolean {
    return this.#deps.lanes.laneOf(agentSessionId, recipient).input !== null;
  }

  inject(session: AgentSessionRow, recipient: string, rows: MailboxDeliveryRow[], prompt: string): void {
    const lane = this.#deps.lanes.laneOf(session.id, recipient);
    if (!lane.input) return;
    // A seat the operator paused mid-turn gets its handoffs back as CONTEXT
    // for work already under way, not as a fresh assignment to restart.
    const note = lane.pauseResumeNote;
    lane.pauseResumeNote = null;
    const text = note === null ? prompt : `${pauseResumeNoteText(note.pausedAt)}\n\n${prompt}`;
    if (lane.activeTurn) {
      lane.activeTurn.deliveries.push(...rows);
      lane.input.push(seatUserMessage(`New addressed handoffs arrived while you were working — fold them into the work in progress.\n\n${text}`));
      this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: recipient, turnId: lane.activeTurn.turnId, detail: `steered mid-turn (${rows.length} deliveries)` } });
    } else {
      this.#mintTurn(session, recipient, lane, rows);
      lane.input.push(seatUserMessage(text));
    }
  }

  resetAssignmentTurns(agentSessionId: string, recipient: string): void {
    const lane = this.#deps.lanes.laneOf(agentSessionId, recipient);
    lane.assignmentTurns = 0; lane.turnBudgetNotified = false;
  }

  // ── TurnTracker — send attribution for the agent tools ───────────────────

  currentTurnId(agentSessionId: string, agent: string): string | undefined {
    return this.#deps.lanes.laneOf(agentSessionId, agent).activeTurn?.turnId;
  }

  markSawSend(agentSessionId: string, agent: string): void {
    const lane = this.#deps.lanes.laneOf(agentSessionId, agent);
    if (lane.activeTurn) lane.activeTurn.sawSend = true;
  }

  // ── The spawn path ───────────────────────────────────────────────────────

  /** Spawn or unpark an agent so its peer session is registered and accepting input. */
  async ensureSeatLive(agentSessionId: string, seat: string, deadline?: number): Promise<void> {
    const { repo } = this.#deps;
    const until = deadline ?? Date.now() + (this.#deps.config.policy.agentSpawnTimeoutMs ?? 30_000);
    const lane = this.#deps.lanes.laneOf(agentSessionId, seat);
    if (lane.state === "live" || lane.state === "waking") { await lane.ready; return; }
    const session = repo.getAgentSession(agentSessionId);
    if (!session || session.lifecycle !== "open") throw new ConflictError(`agent session ${agentSessionId} is not open`);
    const seatRow = repo.getAgent(agentSessionId, seat);
    if (!seatRow) throw new NotFoundError(`no agent ${seat} in ${agentSessionId}`);
    await this.#deps.lanes.reserveCapacity(agentSessionId, until);
    const raced = lane.state as AgentLane["state"];
    if (raced === "live" || raced === "waking") { await lane.ready; return; }
    this.#spawnSeat(session, seatRow, lane);
    await lane.ready;
    // A respawn may inherit rows the previous process took delivery of but
    // never consumed; requeue them so the console path re-carries exactly once.
    const stale = repo.listUnackedDeliveries(agentSessionId, seat).filter((row) => row.status === "delivered");
    for (const row of stale) repo.patchDelivery(row.id, { status: "queued", deliveredAt: null });
  }

  #spawnSeat(session: AgentSessionRow, seatRow: AgentRow, lane: AgentLane): void {
    if (!this.#deps.sdk || !this.#deps.config || !this.#deps.getWorkspaceRoot) throw new Error("SDK unavailable");
    lane.state = "waking";
    lane.deliberateStop = false;
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
    // (a fresh seat has none), so its baseline is zero.
    lane.lastCumulative = seatRow.sdkSessionId === null
      ? { costUsd: 0, apiDurationMs: 0 }
      : { costUsd: seatRow.cumulativeCostUsd, apiDurationMs: seatRow.cumulativeApiDurationMs };
    lane.ready = (async () => {
      const sdk = await this.#deps.sdk!();
      const user = this.#deps.repo.getUserSession(session.userSessionId);
      if (!user) throw new Error("workspace unavailable");
      const workspaceRoot = this.#deps.getWorkspaceRoot!(user.workspaceId);
      const latestSeat = this.#deps.worktree.ensureAgentWorktree(session, this.#deps.repo.getAgent(session.id, seatRow.name) ?? seatRow, workspaceRoot);
      const profile = latestSeat.profileSnapshot as AgentProfile;
      const seatRoot = latestSeat.worktreePath ?? workspaceRoot;
      const contract = this.#deps.routing.contractOf(session);
      const seatRole = roleOfAgent(latestSeat);
      // Builders must supply a prompt for every role; the hub specialist pack
      // is the conservative fallback for a snapshot that somehow lacks one.
      const rolePrompt = contract.prompt(seatRole) ?? hubContract().promptPack.specialist!;
      const granted = grantedTools(contract.role(seatRole), profile, {
        tasks: Boolean(this.#deps.tasks), handoffs: Boolean(this.#deps.handoffs),
        worktrees: Boolean(this.#deps.worktrees), user: Boolean(user), specs: Boolean(this.#deps.requirements),
        // Session-delegation path: the entry agent of a session commissioned
        // against requirement ids holds the report/decompose tools.
        requirementsEntrySeat: seatRole === contract.contract.entry.role,
        childSessions: this.#deps.config.policy.enableChildSessions !== false && session.depth < this.#deps.config.policy.maxSessionDepth,
        // Commission-time opt-in: the orchestrator flagged this session as
        // one whose ENTRY agent may nest, whatever the pattern.
        sessionAllowsChildren: session.allowChildSessions && seatRole === contract.contract.entry.role,
      });
      const mcp = this.#buildParticipantMcp(sdk, session, latestSeat, granted);
      const declared = declaredMcpServers(profile, this.#deps.config);
      // Four separate layers, combined only here: (1) the author's native
      // ceiling ∩ (2) console policy = `native`; (3) console tool grants from
      // the topology contract; (4) the worktree, which is containment and
      // never widens a grant — the same profile spawns with the same surface
      // isolated or not.
      const native = effectiveNativeTools(profile, "seat");
      const options: SdkOptions = {
        cwd: seatRoot,
        systemPrompt: { type: "preset", preset: "claude_code", append: this.#deps.composer.systemPromptAppend(session, latestSeat, profile, rolePrompt) },
        // CLI parity (see orchestrator/options.ts): CLAUDE.md, user/project
        // settings and skills load exactly as they would for the operator.
        settingSources: ["user", "project", "local"], includePartialMessages: true,
        permissionMode: profile.permissionMode,
        ...(profile.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        allowedTools: [...native,
          // A declared server's whole surface is auto-approved — the profile
          // granting the server IS the permission decision, and there is no
          // console-side list of its tool names to drift out of date. The
          // grant covers ref declarations too (natively launched, console
          // granted); the launch map below carries only the executed forms.
          ...mcpGrantNames(profile, this.#deps.config).map((name) => `mcp__${name}`),
          ...runtimeToolNames(granted)],
        // `allowedTools` is only an auto-approval list, so everything
        // classified that the seat does not hold is denied BY NAME — one
        // formula covering console policy (native coordination, task state,
        // scheduling, human/host surfaces), the author's disallowedTools, and
        // every tool an explicit `tools:` list left out.
        disallowedTools: seatDisallowedNativeTools(native),
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
        // Coordination is the console's own in-process server; CAPABILITY is
        // whatever the profile declared. The console launches those and owns
        // nothing about them.
        mcpServers: { console_agent: mcp as never, ...declared } as never,
        ...(latestSeat.model ? { model: latestSeat.model } : {}),
        // The console's skills plugin loads for EVERY seat, alongside
        // whatever user/project skills the settings sources discover.
        plugins: [
          { type: "local" as const, path: this.#deps.config.infra.skillsPluginDir },
          ...((profile.pluginPath && profile.source === "workspace") ? [{ type: "local" as const, path: profile.pluginPath }] : []),
        ],
        // Every discovered skill is visible, like the CLI: the listing costs
        // frontmatter only, bodies load on invocation. `profile.skills` is the
        // RECOMMENDED list the capability brief names, not a filter.
        skills: "all",
        // The operator's CONSOLE_EFFORT is an install-wide override, so it
        // outranks the profile's own pin; unset, the profile decides.
        ...(this.#seatEffort(profile) === undefined ? {} : { effort: this.#seatEffort(profile) }),
        ...(latestSeat.sdkSessionId ? { resume: latestSeat.sdkSessionId } : {}),
      };
      const query = sdk.query({ prompt: lane.input as AsyncIterable<SdkUserMessageLike>, options });
      lane.query = query;
      lane.state = "live";
      lane.pump = this.pumpSeat(session, latestSeat.name, lane, query).catch((error) => this.#deps.hooks.recordFailure(session.id, error));
    })().catch((error) => {
      lane.state = "parked";
      lane.input?.close(); lane.input = null;
      this.#deps.lanes.signalCapacity();
      throw error;
    });
  }

  /**
   * Never hands a tool `lane.abort.signal`: the pool's park nulls `lane.abort`
   * WITHOUT aborting, so a wait tied to the lane-wide signal would strand on
   * park/watchdog. Each operator ask mints its own controller,
   * bound to the CURRENT turn through the LaneActivity seam.
   */
  #buildParticipantMcp(sdk: ConsoleSdk, session: AgentSessionRow, seat: AgentRow, granted: ReadonlySet<AgentToolName>): unknown {
    const user = this.#deps.repo.getUserSession(session.userSessionId);
    const workspaceRoot = user && this.#deps.getWorkspaceRoot ? this.#deps.getWorkspaceRoot(user.workspaceId) : "";
    const tools = buildAgentTools({
      sdk, deps: this.#deps, session, agent: seat, profile: seat.profileSnapshot as AgentProfile, user, workspaceRoot,
      granted,
      legalRecipient: (candidate) => {
        const fresh = this.#deps.repo.getAgentSession(session.id) ?? session;
        const toRole = this.#deps.routing.roleOf(session.id, candidate);
        const fromRole = this.#deps.routing.roleOf(session.id, seat.name);
        if (toRole !== "" && candidate !== seat.name && this.#deps.routing.contractOf(fresh).edge(fromRole, toRole)) return candidate;
        return this.#deps.routing.escalationTarget(fresh, seat.name);
      },
      post: (input) => this.#deps.transfer(input),
      interceptAssignment: (input) => {
        // Route legality first, exactly as post would assert it — an illegal
        // recipient must fail NOW, not at dispatch.
        const fresh = this.#deps.repo.getAgentSession(session.id);
        if (!fresh || fresh.lifecycle !== "open") throw new ConflictError(`agent session ${session.id} is not open`);
        this.#deps.routing.assertRoute(fresh, seat.name, input.to, input.category);
        return this.#deps.scheduler().intercept({
          agentSessionId: session.id, sender: seat.name, recipient: input.to,
          category: input.category, handoff: input.handoff,
        });
      },
      cancelAssignment: (assignmentId) =>
        this.#deps.scheduler().cancel(assignmentId, { actor: seat.name, agentSessionId: session.id }),
      askOperator: (args) => this.#deps.askOperator(session, seat, args),
      currentTurnId: () => this.currentTurnId(session.id, seat.name),
      markSawSend: () => this.markSawSend(session.id, seat.name),
      agentWorkState: (row) => this.#deps.composer.agentWorkState(row),
      dispatchWorkItems: (input) => this.#deps.dispatchWorkItems(seat.name, input),
      createChildSession: (input) => this.#deps.createChildSession(session, seat, input),
      abandonChildSession: (childAgentSessionId, reason) => this.#deps.abandonChildSession(session, seat, childAgentSessionId, reason),
    });
    // alwaysLoad: the profile already decided this agent's tools; deferring
    // them behind ToolSearch costs a round-trip rediscovering what was granted.
    return sdk.createSdkMcpServer({ name: "console_agent", version: "2", tools, alwaysLoad: true });
  }

  snapshotProfile(profile: AgentProfile): AgentProfile {
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
   * Scoped stop: abort one specialist's in-flight turn without touching its
   * siblings. Its delivered work is cancelled so redelivery does not restart
   * the same assignment; the lane survives for the corrected one.
   */
  interruptAgent(agentSessionId: string, agent: string, reason: string): void {
    const session = this.#deps.repo.getAgentSession(agentSessionId);
    if (!session) throw new NotFoundError(`no agent session ${agentSessionId}`);
    const lane = this.#deps.lanes.peek(agentSessionId, agent);
    if (!lane || lane.activeTurn === null) throw new ConflictError(`${agent} has no turn in flight`);
    for (const delivery of this.#deps.repo.listUnackedDeliveries(agentSessionId, agent)) {
      if (delivery.status === "delivered") this.#deps.hooks.patchDelivery(session, delivery, "cancelled");
    }
    this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId,
      payload: { agentSessionId, agent, turnId: lane.activeTurn.turnId, detail: `stopped: ${reason}` } });
    if (lane.activeTurn) lane.activeTurn.watchdog.tripped = `stopped: ${reason}`;
    void lane.query?.interrupt?.().catch(() => undefined);
  }

  /**
   * The operator's whole-system pause, seat side: interrupt every in-flight
   * turn WITHOUT a verdict on its work. Unlike `interruptAgent`, deliveries
   * are not cancelled — settle returns them to `queued` and they redeliver on
   * resume with a note that the seat should continue, not restart. Turns
   * parked in `ask_operator` cost nothing and are left alone (the question
   * stays open); turns already dying are left to die.
   */
  interruptAllForPause(reason: string): number {
    let count = 0;
    for (const snap of this.#deps.lanes.laneSnapshots()) {
      const lane = this.#deps.lanes.peek(snap.agentSessionId, snap.agent);
      const turn = lane?.activeTurn;
      if (!lane || !turn || !lane.query) continue;
      if (turn.pauseInterrupt !== null || turn.watchdog.tripped !== null || turn.awaitingOperator !== null) continue;
      const session = this.#deps.repo.getAgentSession(snap.agentSessionId);
      if (!session) continue;
      turn.pauseInterrupt = reason;
      lane.pauseResumeNote = { pausedAt: nowIso() };
      this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: snap.agent, turnId: turn.turnId, detail: `paused by the operator mid-turn — deliveries requeue and redeliver on resume` } });
      void lane.query.interrupt?.().catch(() => undefined);
      count += 1;
    }
    return count;
  }

  // ── The SDK-event loop ───────────────────────────────────────────────────

  async pumpSeat(session: AgentSessionRow, seatName: string, lane: AgentLane, query: QueryHandle): Promise<void> {
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
          if (event.kind === "limit") {
            if (event.status !== "allowed") {
              bus.append({ type: "agent_session.retry.recorded", userSessionId: session.userSessionId, agentSessionId: session.id,
                payload: { userSessionId: session.userSessionId, agentSessionId: session.id, agent: seatName, kind: "rate_limited", retryInMs: 0,
                  detail: `limit ${event.status}${event.limitType === undefined ? "" : ` (${event.limitType})`}` } });
            }
            this.#deps.capacity.noteLimit(event);
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
          // Any stream event proves the turn is alive; the liveness sweep
          // reads this clock to tell a quiet-but-working turn from a dead one.
          if (turn) turn.lastEventAt = Date.now();
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
            turn?.toolStarts.set(event.callId, { startedAt: Date.now(), name: event.name,
              inputPreview: stableStringify(event.input).slice(0, 200) });
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
            const startedAt = turn?.toolStarts.get(event.callId)?.startedAt; turn?.toolStarts.delete(event.callId);
            runtime.set("thinking");
            bus.append({ type: "agent_session.tool.completed", userSessionId: session.userSessionId, agentSessionId: session.id, payload: { agentSessionId: session.id, agent: seatName, turnId, callId: event.callId, output: captured.value, bytes: captured.bytes, ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }), ...(event.isError ? { isError: true } : {}) } });
            // An alarmed call that returned was a false alarm; record the
            // resolution for the UI and forensics WITHOUT waking main — a
            // resolution wake would double the cost of every false positive.
            if (turn?.alarmsFired.has(`tool:${turnId}:${event.callId}`)) {
              bus.append({ type: "agent_session.liveness.resolved", userSessionId: session.userSessionId, agentSessionId: session.id,
                payload: { agentSessionId: session.id, agent: seatName, turnId, callId: event.callId,
                  ...(startedAt === undefined ? {} : { elapsedMs: Date.now() - startedAt }) } });
            }
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
      if (lane.state === "live" || lane.state === "waking") { lane.state = "parked"; lane.input = null; lane.query = null; this.#deps.lanes.signalCapacity(); }
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
      toolStarts: new Map(), lastEventAt: Date.now(), alarmsFired: new Set(), lastNarration: "",
      watchdog: { lastKey: "", identical: 0, errorStreak: 0, tripped: null }, awaitingOperator: null, pauseInterrupt: null };
    lane.lastActiveAt = Date.now();
    if (lane.idleTimer) { clearTimeout(lane.idleTimer); lane.idleTimer = null; }
    this.#deps.bus.append({ type: "agent_session.turn.started", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, agent: seatName, turnId: lane.activeTurn.turnId } });
    this.#deps.markWorking(session.id);
  }

  #settleSeatTurn(session: AgentSessionRow, seatName: string, lane: AgentLane, runtime: RuntimeBroadcaster, status: "completed" | "error" | "aborted", errorMessage?: string): void {
    const turn = lane.activeTurn;
    if (!turn) return;
    lane.activeTurn = null;
    const { repo, bus, hooks } = this.#deps;
    if (turn.watchdog.tripped !== null) { status = "error"; errorMessage = turn.watchdog.tripped; }
    // An operator pause cut this turn: no verdict on the work. Deliveries go
    // back to `queued` at their CURRENT attempt count (no attempt spent, no
    // escalation, no assignment-turn spend) and redeliver on resume.
    const pausedMidTurn = turn.pauseInterrupt !== null;
    let requeued = false;
    if (pausedMidTurn) {
      status = "aborted"; errorMessage = "paused by operator";
      for (const delivery of turn.deliveries) hooks.patchDelivery(session, delivery, "queued");
      requeued = turn.deliveries.length > 0;
    } else if (status === "completed") {
      for (const delivery of turn.deliveries) hooks.patchDelivery(session, delivery, "acknowledged");
      for (const delivery of turn.deliveries) lane.redeliveryAttempts.delete(delivery.id);
    } else {
      // A watchdog trip means the agent malfunctioned ON THIS INPUT and an
      // operator abort is a deliberate stop; redelivering either just
      // reproduces the failure. Those cancel, and the coordinator decides
      // from the failure handoff.
      const retryable = status === "error" && turn.watchdog.tripped === null;
      // A transport failure says nothing about the delivery — the request
      // never reached the model — so it does not spend a redelivery attempt.
      // A capacity failure is the same class (the provider will take the work
      // later), and it ALSO pauses the run so the redelivery waits for
      // capacity instead of hot-spinning.
      const capacityFailure = isCapacityFailure(errorMessage ?? null);
      if (capacityFailure) this.#deps.capacity.noteCapacityFailure(errorMessage ?? "provider capacity failure");
      const transport = isTransportFailure(errorMessage ?? null) || capacityFailure;
      for (const delivery of turn.deliveries) {
        const attempts = (lane.redeliveryAttempts.get(delivery.id) ?? 0) + (transport ? 0 : 1);
        if (!retryable || attempts > this.#deps.config.policy.maxRedeliveryAttempts) {
          lane.redeliveryAttempts.delete(delivery.id);
          hooks.patchDelivery(session, delivery, "cancelled");
          continue;
        }
        lane.redeliveryAttempts.set(delivery.id, attempts);
        hooks.patchDelivery(session, delivery, "queued");
        requeued = true;
      }
    }
    const seat = repo.getAgent(session.id, seatName);
    if (seat) {
      repo.patchAgent(session.id, seatName, { turnCount: seat.turnCount + 1, lastActiveAt: nowIso() });
    }
    if (!pausedMidTurn) lane.assignmentTurns += 1;
    lane.lastActiveAt = Date.now();
    // Aborted-but-NOT-deliberate = the stream/process died under a live turn
    // (in-process CLI death). Before this it settled silently — no failure
    // handoff, no escalation, a run that just stopped.
    const infraDeath = status === "aborted" && !lane.deliberateStop && !pausedMidTurn;
    // Escalate only when the console has given up on the deliveries. While a
    // redelivery is queued the failure is still being handled here; escalating
    // every attempt produced three differently-worded failure handoffs for
    // one dead turn in a live run, each a delivery into the coordinator.
    if ((status === "error" || infraDeath) && !requeued && repo.getAgentSession(session.id)?.lifecycle === "open") {
      const reason = turn.watchdog.tripped ?? `Provider turn failed: ${errorMessage}`;
      hooks.escalateFailure(session, seatName, seat, turn, reason);
    }
    // Error settles already reached the collector above (escalateTo IS the
    // fan-in collector); aborted settles are teardown paths that must not
    // post. Only a clean completion can leave a join waiting.
    if (status === "completed" && !turn.sawSend && repo.getAgentSession(session.id)?.lifecycle === "open") {
      try { hooks.carryReport(session, seatName, turn); } catch (error) { hooks.recordFailure(session.id, error); }
    }
    const profile = seat?.profileSnapshot as AgentProfile | undefined;
    if (status === "completed" && seat && profile && lane.assignmentTurns >= profile.maxTurns + 1 && !lane.turnBudgetNotified && repo.getAgentSession(session.id)?.lifecycle === "open") {
      lane.turnBudgetNotified = true;
      hooks.turnBudgetNotice(session, seat, turn, lane.assignmentTurns - 1);
    }
    bus.append({ type: "agent_session.turn.settled", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, agent: seatName, turnId: turn.turnId, status, durationMs: Date.now() - turn.startedAt, ...(errorMessage ? { errorMessage } : {}) } });
    this.#deps.worktree.snapshotTurn(session.id, seatName, turn.turnId);
    this.#deps.worktree.flushDeferredLanding(session, seatName);
    runtime.idle();
    // Paused seats wait for the resume hook's redelivery sweep instead.
    if (requeued && !pausedMidTurn && repo.getAgentSession(session.id)?.lifecycle === "open") {
      void hooks.deliver(session.id, seatName).catch((error) => hooks.recordFailure(session.id, error));
    }
    hooks.refreshStatus(session.id);
    this.#deps.lanes.armIdleTimer(session.id, seatName, lane);
  }

  /** CONSOLE_EFFORT (operator override) > the profile's own pin > SDK default. */
  #seatEffort(profile: AgentProfile): EffortLevel | undefined {
    return this.#deps.config.infra.effort ?? profile.effort;
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
      model: usageEvent.modelId ?? seat.model, effort: this.#seatEffort(seat.profileSnapshot as AgentProfile) ?? null,
      trigger, durationMs: durationMs ?? null, apiDurationMs, sdkDurationMs: usageEvent.sdkDurationMs ?? null, status, stopReason: usageEvent.stopReason ?? null, createdAt: nowIso() };
    this.#deps.repo.insertUsage(usage);
    this.#deps.capacity.checkBudget(session.userSessionId);
    this.#deps.checkCommissionBudget(session);
    this.#deps.bus.append({ type: "usage.recorded", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { userSessionId: session.userSessionId, agentSessionId: session.id, agent: seat.name, profileId: seat.profileId, generation: seat.generation, turnId,
        inputTokens: usage.inputTokens, uncachedInputTokens: usage.uncachedInputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens, outputTokens: usage.outputTokens, ...(costUsd === null ? {} : { costUsd }),
        model: usage.model ?? undefined, effort: usage.effort ?? undefined, trigger, durationMs: usage.durationMs ?? undefined,
        apiDurationMs: usage.apiDurationMs ?? undefined, sdkDurationMs: usage.sdkDurationMs ?? undefined, status, stopReason: usage.stopReason ?? undefined } });
  }
}
