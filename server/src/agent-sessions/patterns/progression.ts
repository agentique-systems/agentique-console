/**
 * Pattern progression: session-level counters and the composite
 * TerminationPolicy — the engine every pattern shares. Free functions over a
 * bound context (the attempts.ts shape): host-private operations arrive as
 * closures and nothing here reaches back into the host.
 *
 * Enforcement points:
 * - `onPatternPost` — synchronously after every journaled hop; handoff budget
 *   and oscillation. A trip's ACTION defers a microtask so the in-flight
 *   `post()` returns success first — a trip is never an error and never an
 *   interrupt; running turns finish and the console asks for the close-out.
 * - `sweep` — the 30s governance sweep: the quiet-time stall. Wall-clock time
 *   since the last hop, not settled-turn counting — a counter that advanced
 *   only on turn settles froze forever on a fully quiet session, which was
 *   exactly the failure mode it existed to catch (live run 3's debate).
 */
import type { HandoffDraft, Speaker } from "@agentique-console/shared";
import type { TerminationPolicy, TopologyContract } from "../topology-contract.ts";
import type { AgentProfile } from "../../agent-profiles/registry.ts";
import { InvalidInputError } from "../../errors.ts";
import type { Config } from "../../config.ts";
import type { AgentSessionRow, MessageRow, ParticipantRow, Repo } from "../../db/repo.ts";
import type { EventBus } from "../../events/bus.ts";
import { nowIso } from "../../ids.ts";
import type { Category } from "../governance.ts";
import { CONSOLE_SENDER } from "../peer-names.ts";
import { SEAT_NAME_RE, roleOfSeat, speakerKindOf } from "../topology.ts";

export interface PatternContext {
  deps: { repo: Repo; bus: EventBus; config: Config };
  // Host-private operations, bound as closures so nothing becomes public.
  contract(session: AgentSessionRow): TopologyContract;
  completionSeat(session: AgentSessionRow, which: "finalFrom" | "voice"): string;
  post(input: { agentSessionId: string; speaker: Speaker; to: string; handoff: HandoffDraft; category?: Category; dedupeKey?: string }): MessageRow;
  simpleHandoff(action: string, status: HandoffDraft["core"]["status"], summary: string, nextAction: string | null): HandoffDraft;
  /** Deliver every queued row for `recipient` in one minted turn (#deliverConsole). */
  deliverNow(agentSessionId: string, recipient: string): void;
  /** Any lane of this session has a turn in flight right now. */
  hasActivity(agentSessionId: string): boolean;
  /** The session already delivered its report to main (#statusOf === "reported"). */
  sessionReported(session: AgentSessionRow): boolean;
  // Seat minting, for replicable roles — the attempts.ts precedent.
  profile(id: string, workspaceId?: string): AgentProfile;
  snapshotProfile(profile: AgentProfile): AgentProfile;
  participant(agentSessionId: string, name: string, role: "orchestrator" | "agent", profile: AgentProfile, extra: string, model: string | undefined, ownership: string[], ord: number, createdAt: string, patternRole: string): ParticipantRow;
}

export interface PatternHop {
  sender: string;
  recipient: string;
  category: Category;
  /** The handoff's own status — join arrivals count terminal reports. */
  status: HandoffDraft["core"]["status"];
  /** Console-authored traffic never counts against the seat-facing budgets. */
  consoleSynthesized: boolean;
  /** The traversed edge completes a pattern round (EdgeSpec.countsRound). */
  countsRound: boolean;
  /** EdgeSpec.advance — console edges are progression-delivered. */
  advance: "router" | "console";
}

/** Runtime state of one fan-in, stored in pattern_state.joins. */
interface JoinState {
  over: string;
  /** Seat name (contract deliverTo roles are single-seat). */
  deliverTo: string;
  expected: string[];
  reports: Record<string, "completed" | "failed">;
  settled: boolean;
}

/** Contract bounds, with the config ceilings as fallbacks. 0 = off. */
export function effectivePolicy(contract: TopologyContract, config: Config): TerminationPolicy {
  const termination = contract.termination;
  const fallback = (own: number | undefined, ceiling: number): number | undefined =>
    own ?? (ceiling > 0 ? ceiling : undefined);
  return {
    ...(fallback(termination.maxHandoffs, config.patternHandoffCap) !== undefined ? { maxHandoffs: fallback(termination.maxHandoffs, config.patternHandoffCap) } : {}),
    ...(termination.maxRounds !== undefined ? { maxRounds: termination.maxRounds } : {}),
    ...(termination.oscillationWindow !== undefined ? { oscillationWindow: termination.oscillationWindow } : {}),
  };
}

/** Round trips (A→B then B→A) repeating at the tail of the edge ring. */
export function oscillating(recentEdges: readonly string[], window: number): boolean {
  const last = recentEdges[recentEdges.length - 1];
  if (last === undefined) return false;
  const [a, b] = last.split(">");
  if (a === undefined || b === undefined) return false;
  const inverse = `${b}>${a}`;
  let alternation = 0;
  for (let i = recentEdges.length - 1; i >= 0; i -= 1) {
    const expected = (recentEdges.length - 1 - i) % 2 === 0 ? last : inverse;
    if (recentEdges[i] !== expected) break;
    alternation += 1;
  }
  return Math.floor(alternation / 2) >= window;
}

export function onPatternPost(ctx: PatternContext, session: AgentSessionRow, hop: PatternHop): void {
  const { repo } = ctx.deps;
  const state = repo.getPatternState(session.id);
  if (state?.tripped) {
    // Counters stop at the trip; deliveries do not — reports still flow.
    if (hop.advance === "console") advanceConsoleHop(ctx, session, hop);
    return;
  }
  const recentEdges = [...(state?.recentEdges ?? []), `${hop.sender}>${hop.recipient}`].slice(-16);
  const countsRound = hop.countsRound && !hop.consoleSynthesized;
  const next = repo.upsertPatternState(session.id, {
    recentEdges,
    lastProgressAt: nowIso(),
    ...(countsRound ? { rounds: (state?.rounds ?? 0) + 1 } : {}),
    ...(hop.consoleSynthesized ? {} : { handoffCount: (state?.handoffCount ?? 0) + 1 }),
  });
  const policy = effectivePolicy(ctx.contract(session), ctx.deps.config);
  if (policy.maxHandoffs !== undefined && next.handoffCount >= policy.maxHandoffs) {
    trip(ctx, session, "max_handoffs", `${next.handoffCount} handoffs have been sent; the session budget is ${policy.maxHandoffs}`);
    return;
  }
  if (countsRound && policy.maxRounds !== undefined && next.rounds >= policy.maxRounds) {
    trip(ctx, session, "max_rounds", `round ${next.rounds} of at most ${policy.maxRounds} has completed`);
    return;
  }
  if (policy.oscillationWindow !== undefined && oscillating(next.recentEdges, policy.oscillationWindow)) {
    trip(ctx, session, "oscillation", `the last hops ping-pong between ${hop.sender} and ${hop.recipient} (${policy.oscillationWindow} round trips)`);
    return;
  }
  if (hop.advance === "console") advanceConsoleHop(ctx, session, hop);
}

/**
 * A console-advanced hop: a joined fan-in waits until every expected seat has
 * reported (completed or failed), then one flush delivers every held report
 * in a single minted turn; an unjoined console edge just advances. Late
 * arrivals after settle deliver immediately — stragglers reach the collector,
 * they just don't reopen the join.
 */
function advanceConsoleHop(ctx: PatternContext, session: AgentSessionRow, hop: PatternHop): void {
  const { repo, bus } = ctx.deps;
  const senderRole = roleOf(ctx, session, hop.sender);
  const recipientRole = roleOf(ctx, session, hop.recipient);
  const spec = ctx.contract(session).joins.find((join) => join.over === senderRole && join.deliverTo === recipientRole);
  if (!spec) { ctx.deliverNow(session.id, hop.recipient); return; }

  const state = repo.getPatternState(session.id);
  const joins = { ...(state?.joins ?? {}) } as Record<string, JoinState>;
  let joinId = Object.keys(joins).find((id) => joins[id]?.over === senderRole && !joins[id]?.settled);
  if (!joinId) {
    if (Object.values(joins).some((join) => join.over === senderRole && join.settled)) {
      // The join already settled — a straggler; deliver it on its own.
      ctx.deliverNow(session.id, hop.recipient);
      return;
    }
    // First arrival with no dispatch-registered join (debate): expect every
    // seat the over-role has right now.
    joinId = `${senderRole}#1`;
    joins[joinId] = { over: senderRole, deliverTo: hop.recipient,
      expected: repo.listParticipants(session.id).filter((seat) => roleOfSeat(seat) === senderRole).map((seat) => seat.name),
      reports: {}, settled: false };
  }
  const join = joins[joinId]!;
  if (hop.status === "completed") join.reports[hop.sender] = "completed";
  else if (hop.status === "failed") join.reports[hop.sender] = "failed";
  const failed = Object.values(join.reports).filter((status) => status === "failed").length;
  const met = join.expected.every((seat) => join.reports[seat] !== undefined);
  if (met) join.settled = true;
  repo.upsertPatternState(session.id, { joins: joins as unknown as Record<string, unknown> });
  if (met) {
    bus.append({ type: "agent_session.join.completed", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, joinId, arrived: Object.keys(join.reports), of: join.expected.length, failed } });
    ctx.deliverNow(session.id, join.deliverTo);
  }
}

function roleOf(ctx: PatternContext, session: AgentSessionRow, name: string): string {
  if (name === "main") return "main";
  const seat = ctx.deps.repo.getParticipant(session.id, name);
  return seat ? roleOfSeat(seat) : "";
}

export interface DispatchWorkItemsInput {
  agentSessionId: string;
  items: { assignment: string; name?: string; owns?: string[] }[];
  profileId?: string;
  instructions?: string;
  model?: string;
}

/**
 * Fan-out for a replicable role: mint one seat per work item, register the
 * join so the collector's flush waits for every item, then post each item as
 * its own assignment. One unsettled dispatch at a time — the join IS the
 * dispatch's lifecycle.
 */
export function dispatchWorkItems(ctx: PatternContext, session: AgentSessionRow, dispatcher: ParticipantRow, input: DispatchWorkItemsInput): { joinId: string; seats: string[] } {
  const { repo } = ctx.deps;
  const contract = ctx.contract(session);
  const replicableEntry = Object.entries(contract.roles).find(([, role]) => role.replicable);
  if (!replicableEntry) throw new InvalidInputError(`pattern ${contract.pattern} has no replicable role to dispatch to`);
  const [mapperRole, mapperSpec] = replicableEntry;
  const spec = contract.joins.find((join) => join.over === mapperRole);
  if (!spec) throw new InvalidInputError(`pattern ${contract.pattern} declares no join over ${mapperRole}`);
  if (input.items.length < 1 || input.items.length > mapperSpec.max) {
    throw new InvalidInputError(`dispatch takes 1 to ${mapperSpec.max} work items`);
  }
  const state = repo.getPatternState(session.id);
  const joins = { ...(state?.joins ?? {}) } as Record<string, JoinState>;
  if (Object.values(joins).some((join) => !join.settled)) {
    throw new InvalidInputError("a dispatch is already in flight; wait for its join to settle before fanning out again");
  }
  const dispatchOrdinal = Object.keys(joins).length + 1;
  const now = nowIso();
  const user = repo.getUserSession(session.userSessionId);
  const profile = ctx.snapshotProfile(ctx.profile(input.profileId ?? "explorer", user?.workspaceId));
  const existing = new Set(repo.listParticipants(session.id).map((seat) => seat.name));
  const baseOrd = repo.listParticipants(session.id).length;
  const seats = input.items.map((item, index) => {
    const name = item.name ?? `map.${dispatchOrdinal}.${index + 1}`;
    if (!SEAT_NAME_RE.test(name) || existing.has(name)) throw new InvalidInputError(`invalid or duplicate work-item seat name "${name}"`);
    existing.add(name);
    return { name, item };
  });
  for (const [index, seat] of seats.entries()) {
    repo.insertParticipant(ctx.participant(session.id, seat.name, "agent", profile,
      input.instructions ?? "", input.model, seat.item.owns ?? [], baseOrd + index, now, mapperRole));
  }
  const joinId = `${mapperRole}#${dispatchOrdinal}`;
  joins[joinId] = { over: mapperRole,
    deliverTo: dispatcher.name, expected: seats.map((seat) => seat.name), reports: {}, settled: false };
  repo.upsertPatternState(session.id, { joins: joins as unknown as Record<string, unknown> });
  for (const seat of seats) {
    ctx.post({ agentSessionId: session.id, speaker: { kind: speakerKindOf(dispatcher), name: dispatcher.name },
      to: seat.name, category: "assignment", dedupeKey: `dispatch:${joinId}:${seat.name}`,
      handoff: ctx.simpleHandoff(seat.item.assignment, "pending", seat.item.assignment,
        `Do exactly this item and report the result to ${dispatcher.name} with a terminal status.`) });
  }
  return { joinId, seats: seats.map((seat) => seat.name) };
}


/**
 * The 30s quiet-time stall check. An open, unreported session with no hop for
 * `patternStallMs` and no turn in flight is stalled — every seat has gone
 * quiet without anyone delivering a result. Trips the same close-out ask as
 * every other bound. `lastProgressAt` starts at session creation (the first
 * assignment hop sets it), so a session that never moves at all still trips.
 */
export function sweep(ctx: PatternContext, session: AgentSessionRow): void {
  const { repo, config } = { repo: ctx.deps.repo, config: ctx.deps.config };
  if (config.patternStallMs <= 0) return;
  const state = repo.getPatternState(session.id);
  if (state?.tripped) return;
  if (ctx.sessionReported(session) || ctx.hasActivity(session.id)) return;
  const last = Date.parse(state?.lastProgressAt ?? session.createdAt);
  if (!Number.isFinite(last) || Date.now() - last < config.patternStallMs) return;
  trip(ctx, session, "stall",
    `no participant has sent a handoff for ${Math.round((Date.now() - last) / 60_000)} minutes and no turn is in flight`);
}

/**
 * Set the tripped flag, tell the bus, and — deferred — ask the reporting seat
 * to close out. The dedupe key makes every rule's ask collapse into one.
 */
export function trip(ctx: PatternContext, session: AgentSessionRow, rule: string, detail: string): void {
  const { repo, bus } = ctx.deps;
  const state = repo.getPatternState(session.id);
  if (state?.tripped) return;
  repo.upsertPatternState(session.id, { tripped: rule });
  bus.append({ type: "agent_session.termination.tripped", userSessionId: session.userSessionId, agentSessionId: session.id,
    payload: { agentSessionId: session.id, pattern: session.pattern, rule, detail } });
  queueMicrotask(() => {
    try {
      const finalSeat = ctx.completionSeat(session, "finalFrom");
      ctx.post({ agentSessionId: session.id, speaker: { kind: "system", name: CONSOLE_SENDER }, to: finalSeat,
        handoff: ctx.simpleHandoff(`Termination policy tripped: ${rule}`, "blocked",
          `${detail}. This is a Console-imposed bound, not a judgement on the work.`,
          "Compile and send your final report now from what exists; include what is unverified rather than continuing."),
        category: "decision", dedupeKey: `termination:${session.id}` });
    } catch { /* best effort — the tripped flag already stops the counters */ }
  });
}
