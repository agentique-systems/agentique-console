/**
 * Topology contracts — the compiled form of an orchestration pattern.
 *
 * A pattern (hub-and-spoke, pipeline, …) is a pure builder that runs once, at
 * session creation, and emits this JSON-serializable contract. The contract is
 * snapshotted onto the agent-session row (the `profileSnapshot` precedent) and
 * is the ONLY thing the host executes: route legality, tool grants, prompt
 * text, escalation targets, join gates, termination and completion all read it.
 * Host logic never branches on the pattern name — `pattern` is a forensic
 * label, and a session created before contracts existed compiles to the
 * hub-and-spoke default lazily, so old rows never need rewriting.
 *
 * Seat→role binding deliberately lives OUTSIDE the contract, on
 * `participants.pattern_role`: replicable roles (a map-reduce mapper) mint
 * seats at runtime, and the snapshot must stay immutable while the roster
 * grows.
 */
import type { HandoffExtensionKind } from "./handoffs.ts";

export const PATTERN_IDS = [
  "hub_and_spoke",
  "pipeline",
  "evaluator_optimizer",
  "map_reduce",
  "peer_to_peer",
  "plan_execute",
  "debate",
] as const;
export type PatternId = (typeof PATTERN_IDS)[number];

/** The six delivery categories — frozen by the mailbox CHECK constraint. */
export type DeliveryCategory = "assignment" | "update" | "milestone" | "failure" | "final" | "decision";

/**
 * Console-tool grant atoms: the single vocabulary that both seat-tool
 * registration and the runtime allow-list compile from. Profile-derived
 * capabilities (shell, browser, screenshots) are computed from the profile
 * and are not part of the pattern's say.
 */
export type ConsoleToolGrant =
  | "tasks_write"      // task_create / task_update
  | "contracts_admin"  // declare_contract / supersede_contract
  | "attempts_start"   // start_attempts (best-of-N)
  | "forward_message"  // verbatim passthrough of a seat report to main
  | "map_dispatch"     // dispatch_work_items (map_reduce fan-out)
  | "child_sessions";  // create_child_session / abandon_child_session (depth 0 only)

export interface RoleSpec {
  /** Seats of this role are minted at runtime rather than all seated at creation. */
  replicable: boolean;
  min: number;
  max: number;
  grants: ConsoleToolGrant[];
  /** Default extension kind for this role's handoffs; a profile's own `handoffExtension` wins. */
  extensionKind?: HandoffExtensionKind;
  /** Target of console-synthesized turn-failure/budget handoffs: a role name, or "main". */
  escalateTo: string;
}

export interface EdgeSpec {
  /** Role name, or "main" for the user-session lane. */
  from: string;
  to: string;
  /**
   * router: the sender addresses the recipient itself and delivery is
   * immediate. console: the hop is journaled and queued; the pattern
   * progression decides when (and whether) it delivers — joins, rounds,
   * stage advancement.
   */
  advance: "router" | "console";
  /** Categories this edge carries; omitted = all six. */
  categories?: DeliveryCategory[];
  /** Traversing this edge completes one pattern round (an evaluator critique). */
  countsRound?: boolean;
}

export type JoinMode = "all" | "any" | { quorum: number };

export interface JoinSpec {
  id: string;
  /** Role whose terminal reports are collected. */
  over: string;
  mode: JoinMode;
  /** What a failed branch does to the join once the mode can no longer be met. */
  onPartialFailure: "proceed" | "halt_escalate" | "retry_once";
  /** Role whose held deliveries flush when the join settles. */
  deliverTo: string;
}

/**
 * Session-level termination. Complements — never replaces — the per-seat
 * machinery (watchdog, retry budget, rotation, per-profile maxTurns). Every
 * field is optional; absence means that bound is not in force.
 */
export interface TerminationPolicy {
  /** Non-checkpoint handoffs, session-wide. */
  maxHandoffs?: number;
  /** Pattern rounds: evaluator cycles, debate critique rounds. */
  maxRounds?: number;
  wallClockMs?: number;
  costBudgetUsd?: number;
  /** Settled turns in a row that journaled no terminal report. */
  stallTurns?: number;
  /** A→B→A→B repeats between one sender/recipient pair before tripping. */
  oscillationWindow?: number;
  /** Semantic stop: a review-extension verdict of "approved" from this role. */
  qualityPredicate?: { kind: "review_accept"; role: string };
}

export interface CompletionSpec {
  /** Role whose final→main marks the session "reported". */
  finalFrom: string;
  /** Role the console speaks AS for discharge/clearance notices — usually finalFrom. */
  voice: string;
}

export interface RolePrompt {
  /** The role's addressing sentence inside the messaging brief ("You may address …"). */
  addressing: string;
  /** The pattern-specific half of the session protocol; the operator-path core is invariant. */
  protocol: string;
  /** Optional role brief appended to the seat's instructions (rubric, closer duty, …). */
  brief?: string;
}

export interface TopologyContract {
  schemaVersion: 1;
  /** Forensic label — host logic never reads it. */
  pattern: PatternId;
  roles: Record<string, RoleSpec>;
  edges: EdgeSpec[];
  joins: JoinSpec[];
  /** Who receives the creation briefing; broadcast = every seat of that role. */
  entry: { role: string; broadcast: boolean };
  termination: TerminationPolicy;
  completion: CompletionSpec;
  promptPack: Record<string, RolePrompt>;
  /** Rendered into route-denial messages; hub's is the legacy literal. */
  routeSummary: string;
  limits: { minSeats: number; maxSeats: number };
  /** Pattern config echo (rubric, maxRounds, …) — forensics, not read at runtime. */
  config: Record<string, unknown>;
}
