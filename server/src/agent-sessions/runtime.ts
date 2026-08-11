/**
 * The agent runtime: SDK-event translation and turn lifecycle over pool lanes.
 * One machine — the pump dispatches every mapped SDK event, the watchdog trips
 * inside it, and settle closes the turn. Everything a settle touches beyond
 * the lane itself (mailroom delivery transitions, escalation and relay posts,
 * operator-status refresh, the rotation check) arrives as the typed
 * `SettleHooks` bundle wired by the composition root — the mailroom↔runtime
 * dependency is a cycle only that root may close, and this module never
 * imports the service.
 */
import type { AgentProfile } from "../agent-profiles/registry.ts";
import { toWireMessage } from "../api/wire.ts";
import type { Config } from "../config.ts";
import type { AgentRow, AgentSessionRow, MailboxDeliveryRow, Repo } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { RuntimeBroadcaster } from "../events/runtime.ts";
import { newId, nowIso } from "../ids.ts";
import { advanceUsageWatermark } from "../lane-runtime/usage.ts";
import { isTransportFailure } from "../sdk/failure-classifier.ts";
import { mapSdkMessage } from "../sdk/mapping.ts";
import type { QueryHandle } from "../sdk/types.ts";
import { seatUserMessage } from "./composer.ts";
import type { ActiveTurn, AgentLane, AgentLanePool } from "./lanes.ts";
import type { Deliver, Injector, RecordFailure } from "./seams.ts";
import { speakerKindOf } from "./topology.ts";
import type { WorktreeBinding } from "./worktree-binding.ts";

/** JSON with recursively sorted object keys — a stable identity for tool inputs. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
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
  /** The post-settle context-rotation check. */
  maybeRotate(agentSessionId: string, seatName: string): Promise<void>;
  /** Journal a host-side failure as a runtime notice on the session. */
  recordFailure: RecordFailure;
}

export interface AgentRuntimeDeps {
  repo: Repo;
  bus: EventBus;
  config: Config;
  lanes: AgentLanePool;
  worktree: WorktreeBinding;
  /** Turn minting marks the session working (operator status). */
  markWorking: (agentSessionId: string) => void;
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
    if (lane.activeTurn) {
      lane.activeTurn.deliveries.push(...rows);
      lane.input.push(seatUserMessage(`New addressed handoffs arrived while you were working — fold them into the work in progress.\n\n${prompt}`));
      this.#deps.bus.append({ type: "agent_session.runtime.noted", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { agentSessionId: session.id, agent: recipient, turnId: lane.activeTurn.turnId, detail: `steered mid-turn (${rows.length} deliveries)` } });
    } else {
      this.#mintTurn(session, recipient, lane, rows);
      lane.input.push(seatUserMessage(prompt));
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
              this.recordUsage(session, seat, lane.lastCumulative, turnId || newId("turn"), event, "completed", turn ? Date.now() - turn.startedAt : undefined);
            }
            this.#settleSeatTurn(session, seatName, lane, runtime, "completed");
          } else if (event.kind === "error") {
            const seat = repo.getAgent(session.id, seatName);
            if (seat) {
              repo.patchAgent(session.id, seatName, { contextTokens: Math.max(seat.contextTokens, lane.contextTokens) });
              this.recordUsage(session, seat, lane.lastCumulative, turnId || newId("turn"), event, event.aborted ? "aborted" : "error", turn ? Date.now() - turn.startedAt : undefined);
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
      toolStarts: new Map(), lastNarration: "", watchdog: { lastKey: "", identical: 0, errorStreak: 0, tripped: null }, awaitingOperator: null };
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
    let requeued = false;
    if (status === "completed") {
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
      const transport = isTransportFailure(errorMessage ?? null);
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
    lane.assignmentTurns += 1;
    lane.lastActiveAt = Date.now();
    if (status === "error" && repo.getAgentSession(session.id)?.lifecycle === "open") {
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
    runtime.idle();
    if (requeued && repo.getAgentSession(session.id)?.lifecycle === "open") {
      void hooks.deliver(session.id, seatName).catch((error) => hooks.recordFailure(session.id, error));
    }
    hooks.refreshStatus(session.id);
    this.#deps.lanes.armIdleTimer(session.id, seatName, lane);
    void hooks.maybeRotate(session.id, seatName).catch((error) => hooks.recordFailure(session.id, error));
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
  recordUsage(session: AgentSessionRow, seat: AgentRow, cumulative: { costUsd: number; apiDurationMs: number }, turnId: string, usageEvent: { inputTokens?: number; uncachedInputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; outputTokens?: number; cumulativeCostUsd?: number; modelId?: string; cumulativeApiDurationMs?: number; sdkDurationMs?: number; stopReason?: string }, status: "completed" | "error" | "aborted" = "completed", durationMs?: number, trigger = "delivery"): void {
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
}
