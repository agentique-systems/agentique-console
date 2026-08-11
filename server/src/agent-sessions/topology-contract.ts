/**
 * Topology contracts — the compiled form of an orchestration pattern.
 *
 * A pattern (hub-and-spoke, pipeline, …) is a pure builder that runs once, at
 * session creation, and emits this JSON-serializable contract. The contract is
 * snapshotted onto the agent-session row (the `profileSnapshot` precedent) and
 * is the ONLY thing the service executes: route legality, tool grants, prompt
 * text, escalation targets, join gates, termination and completion all read it.
 * Service logic never branches on the pattern name — `pattern` is a forensic
 * label, and a session created before contracts existed compiles to the
 * hub-and-spoke default lazily, so old rows never need rewriting.
 *
 * Agent→role binding deliberately lives OUTSIDE the contract, on
 * `agents.role`: replicable roles (a map-reduce mapper) mint agents at
 * runtime, and the snapshot must stay immutable while the roster grows.
 */
import type { HandoffExtensionKind, PatternId } from "@agentique-console/shared";

/**
 * Console-tool grant atoms: the single vocabulary that both agent-tool
 * registration and the runtime allow-list compile from. Profile-derived
 * capabilities (shell, browser, screenshots) are computed from the profile
 * and are not part of the pattern's say.
 */
export type ConsoleToolGrant =
  | "tasks_write"      // task_create / task_update
  | "forward_message"  // verbatim passthrough of an agent report to main
  | "map_dispatch"     // dispatch_work_items (map_reduce fan-out)
  | "child_sessions";  // create_child_session / abandon_child_session (depth 0 only)

export interface RoleSpec {
  /** Agents of this role are minted at runtime rather than all seated at creation. */
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
   * immediate: the hop delivers as soon as it is journaled. join: the hop is
   * journaled and held; the pattern engine flushes every held report to the
   * join's collector in one turn once all expected agents have reported.
   */
  advance: "immediate" | "join";
  /** Categories this edge carries; omitted = all six. */
  categories?: ("assignment" | "update" | "milestone" | "failure" | "final" | "decision")[];
  /** Traversing this edge completes one pattern round (an evaluator critique). */
  countsRound?: boolean;
}

export interface JoinSpec {
  id: string;
  /** Role whose terminal reports are collected. */
  over: string;
  /** Role whose held deliveries flush when every expected agent has reported. */
  deliverTo: string;
}

/**
 * Session-level termination. Complements — never replaces — the per-agent
 * machinery (watchdog, retry budget, rotation, per-profile maxTurns). Every
 * field is optional; absence means that bound is not in force.
 */
export interface TerminationPolicy {
  /** Non-checkpoint handoffs, session-wide. */
  maxHandoffs?: number;
  /** Pattern rounds: evaluator cycles, debate critique rounds. */
  maxRounds?: number;
  /** A→B→A→B repeats between one sender/recipient pair before tripping. */
  oscillationWindow?: number;
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
  /** Optional role brief appended to the agent's instructions (rubric, closer duty, …). */
  brief?: string;
}

export interface TopologyContract {
  schemaVersion: 1;
  /** Forensic label — service logic never reads it. */
  pattern: PatternId;
  roles: Record<string, RoleSpec>;
  edges: EdgeSpec[];
  joins: JoinSpec[];
  /** Who receives the creation briefing; broadcast = every agent of that role. */
  entry: { role: string; broadcast: boolean };
  termination: TerminationPolicy;
  completion: CompletionSpec;
  promptPack: Record<string, RolePrompt>;
  /** Rendered into route-denial messages; hub's is the legacy literal. */
  routeSummary: string;
  limits: { minAgents: number; maxAgents: number };
  /** Pattern config echo (rubric, maxRounds, …) — forensics, not read at runtime. */
  config: Record<string, unknown>;
}
