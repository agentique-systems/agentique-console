import type { HandoffSummary } from "./handoffs.ts";

// Domain rows as they appear on the wire. The server owns persistence shapes;
// these are the JSON forms REST and the event spine agree on.

export type SessionMode = "execute" | "plan_execute";
export type SessionPhase = "planning" | "executing";

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UserSession {
  id: string;
  workspaceId: string;
  /** The project this session works on — the requirement graph's durable scope. */
  projectId: string;
  title: string | null;
  mode: SessionMode;
  phase: SessionPhase;
  /** Is this in the operator's active list. Orthogonal to `runState`. */
  lifecycle: "open" | "archived";
  /**
   * Is the work done. `awaiting_signoff` is the Console asserting it believes
   * the run is finished while the operator has not yet agreed.
   */
  runState: RunState;
  /**
   * The orchestrator model this session runs on. `null` means the server's
   * configured default — the client renders that default rather than the word
   * "null", so it reads `/api/config` for it.
   */
  model: string | null;
  /** "away": proceed on recommendations; queue only irreversible decisions. */
  autonomy: "standard" | "away";
  /** Set while a provider-capacity, budget, or operator pause holds. */
  pauseReason: PauseReason | null;
  /** Auto-resume time for a capacity pause (ISO); null otherwise. */
  pausedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RunState = "active" | "awaiting_signoff" | "completed";

/**
 * Why the system is paused. One process-wide pause covers every run:
 * `capacity` (provider usage window; auto-resumes), `budget` (a session's
 * spend ceiling; operator resumes), `operator` (the top-bar Pause; holds
 * until Resume and outranks the other two).
 */
export type PauseReason = "capacity" | "budget" | "operator";

/**
 * The whole-system pause as the web reads it. `since` is null after a
 * server restart restored a persisted pause (the start time is not
 * persisted); `until` is the auto-resume time of a capacity pause.
 */
export interface SystemPauseState {
  paused: boolean;
  reason: PauseReason | null;
  since: string | null;
  until: string | null;
  detail?: string;
}

/**
 * The render-ready projection of a run summary — ONE shape shared by the
 * `run.completion.proposed` payload and the web fold's card, so copies cannot
 * drift.
 */
export interface RunSummaryStats {
  headline: string;
  verdict: "completed" | "completed_with_caveats" | "failed" | "infeasible";
  filesChanged: number;
  tasks: { completed: number; total: number };
  durationMs: number;
  deadAirMs: number;
  costUsd: number | null;
  /** 1 = every observed turn has a usage row. Below 0.9 the cost reads "partial". */
  costCoverage: number;
  openUncertainty: number;
  /** Seats whose provider process the Console released when the run settled. */
  reaped: { seats: number };
}


/**
 * `reported` is derived, not stored: the coordinator has delivered a result to
 * main and nothing is in flight. Without it a finished session renders with the
 * same grey dot as one that died.
 */
export type AgentSessionStatus = "working" | "idle" | "reported" | "archived";

export type AgentSessionLifecycle = "open" | "archived";
/** Derived busy state — never stored. */
export type AgentSessionActivity = "working" | "idle" | "reported";

export interface AgentSessionBudget {
  /** The commission ceiling in USD (session + children). */
  budgetUsd: number;
  /** Summed provider cost of the session's subtree so far. */
  spendUsd: number;
}

export interface AgentSession {
  id: string;
  userSessionId: string;
  title: string;
  lifecycle: AgentSessionLifecycle;
  activity: AgentSessionActivity;
  /** Orchestration-pattern catalog id (hub_and_spoke, pipeline, …). */
  pattern: string;
  /** NULL = top-level; set = this is a child session nested one level down. */
  parentAgentSessionId: string | null;
  /** Specialist agent names in seating order (excludes the coordinator). */
  agents: string[];
  /** Commission budget + subtree spend; null when no budget was set. */
  budget: AgentSessionBudget | null;
  /**
   * Commissioned while requirements govern, with zero delegated requirement
   * ids — untraceable to any obligation. Derived, displayed, never rejected.
   */
  unscoped: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface AgentRunSummary {
  agent: string;
  profileId: string;
  profile: Record<string, unknown>;
  ownership: string[];
  generation: number;
  /** Turns of the CURRENT generation only — resets at every rotation. */
  turnCount: number;
  /** Current-generation context occupancy — resets at every rotation, never sum it. */
  contextTokens: number;
  /** Lifetime totals across all generations, from usage samples. */
  totalCostUsd: number;
  totalTurns: number;
  providerSessionId: string | null;
}

export type SpeakerKind = "operator" | "orchestrator" | "agent" | "system";

export interface Speaker {
  kind: SpeakerKind;
  /** "operator" | "orchestrator" (the main lane) | agent name | "system" */
  name: string;
}

export type MessageKind = "message" | "notice" | "plan";

export interface SessionMessage {
  seq: number;
  speaker: Speaker;
  to?: string;
  kind: MessageKind;
  text: string;
  /** Present only for structured v2 handoff rows; legacy rows remain plain text. */
  handoff?: HandoffSummary;
  createdAt: string;
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface Task {
  /** Stable Console-owned identity; provider ids remain reconciliation keys. */
  id: string;
  /** SDK session that owns the task list this task lives in. */
  sdkSessionId: string;
  /** The SDK's task id, unique within that session's list. */
  sdkTaskId: string;
  workspaceId: string;
  userSessionId: string;
  /** null = the orchestrator's own list. */
  agentSessionId: string | null;
  /** Agent name whose SDK session owns the list; null for the orchestrator. */
  agent: string | null;
  subject: string;
  description: string;
  activeForm: string | null;
  status: TaskStatus;
  owner: string | null;
  /** The requirement this unit of work discharges; null = unlinked. */
  requirementId: string | null;
  blocks: string[];
  blockedBy: string[];
  dependencyIds: string[];
  dependentIds: string[];
  /** `pending` with every dependency completed — the scheduler's dispatch predicate. */
  ready: boolean;
  /** The live scheduled assignment awaiting this task's dependencies, if any. */
  scheduledAssignment: {
    id: string;
    sender: string;
    recipient: string;
    createdAt: string;
  } | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ScheduledAssignmentStatus = "scheduled" | "dispatched" | "canceled";

export type ScheduledAssignmentStatusReason =
  | "replaced"
  | "task_deleted"
  | "task_completed"
  | "session_archived"
  | "canceled";

/** A durable assignment awaiting its task's dependencies; no handoff body on the wire. */
export interface ScheduledAssignment {
  id: string;
  workspaceId: string;
  userSessionId: string;
  agentSessionId: string;
  taskId: string;
  sender: string;
  recipient: string;
  category: string;
  status: ScheduledAssignmentStatus;
  statusReason: ScheduledAssignmentStatusReason | null;
  dispatchedMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDependency {
  blockerTaskId: string;
  blockedTaskId: string;
  source: "console" | "provider" | "migration";
  createdAt: string;
}

export interface SessionTreeBranch {
  session: UserSession;
  agentSessions: AgentSession[];
}

export interface ProfileValidationIssue {
  level: "error" | "warning";
  path: string | null;
  message: string;
}

export interface AgentProfileSummary {
  id: string;
  title: string;
  purpose: string;
  /** Role archetype; null for profiles authored before archetypes existed. */
  role: AgentProfileRole | null;
  source: "builtin" | "workspace";
  revision: string;
  /**
   * Three independent states. `claudeValid`: parses as a legitimate native
   * definition. `agentiqueCompatible`: the console can instantiate it with
   * every native field's semantics preserved — a valid definition using a
   * native feature the console cannot reproduce is compatible=false with
   * reasons, NEVER "invalid". `trusted`: the operator approved this exact
   * source revision. Runnable = all three.
   */
  trusted: boolean;
  /** Kept as the alias UIs already read; equals claudeValid. */
  valid: boolean;
  claudeValid: boolean;
  agentiqueCompatible: boolean;
  incompatibilityReasons: string[];
  tools: string[];
  skills: string[];
  componentCounts: Record<string, number>;
}

/**
 * The five role archetypes. A profile's archetype names what kind of operator
 * it is — an orchestrator decomposes and integrates, an explorer produces
 * knowledge, a planner produces strategy, an implementer changes the artifact,
 * a reviewer produces verification evidence. Main is the run-level
 * orchestrator archetype.
 */
export type AgentProfileRole = "orchestrator" | "explorer" | "planner" | "implementer" | "reviewer";

export interface AgentProfileComponent {
  kind: "prompt" | "skill" | "hook" | "mcp" | "agent" | "command" | "monitor" | "settings" | "other";
  name: string;
  path: string;
  supported: boolean;
  summary: string;
}

export interface AgentProfileDetail extends AgentProfileSummary {
  instructions: string;
  permissionMode: "default" | "plan" | "bypassPermissions";
  model: string | null;
  effort: string | null;
  maxTurns: number;
  /**
   * Capability comes from declared MCP servers, never from console-built
   * tools. The full native surface: console-executed stdio/sse/http forms
   * and `ref` names the workspace's own `.mcp.json` launches.
   */
  mcpServers: Record<string, { transport?: "stdio" | "sse" | "http" | "ref"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }>;
  handoffExtension: string | null;
  pluginPath: string | null;
  components: AgentProfileComponent[];
  files: { path: string; content: string }[];
  issues: ProfileValidationIssue[];
}

export type TimelineLaneKind = "operator" | "orchestrator" | "agent_session" | "agent";
export interface TimelineLane {
  id: string;
  kind: TimelineLaneKind;
  label: string;
  parentId: string | null;
  order: number;
}

export interface TimelineItem {
  id: string;
  laneId: string;
  kind: "message" | "turn" | "tool" | "task" | "handoff" | "decision" | "rotation" | "runtime" | "usage" | "state";
  label: string;
  start: string;
  end: string | null;
  status: string | null;
  eventSeqs: number[];
  detail: Record<string, unknown>;
}

export type InteractionKind = "question" | "plan_approval";
export type InteractionStatus =
  | "pending"
  | "answered"
  | "rejected"
  | "dismissed"
  | "stale";

/**
 * Blocking parks the asker until the operator answers; deferred renders the
 * card immediately and hands the answer over at the asker's next delivery.
 * A column rather than a status, because `status`'s CHECK cannot be widened on
 * an existing database.
 */
export type InteractionUrgency = "blocking" | "deferred";
/** Who raised it: an agent directly, the uncertainty classifier, or the Console. */
export type InteractionSource = "agent" | "console";

/** One AskUserQuestion question block, as the SDK tool shapes it. */
export interface InteractionQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
  /**
   * Which option the asker recommends, and why. `request_decision` accepted
   * this and then dropped it on the blocking path, so the operator never saw
   * the asker's own read of its own question.
   */
  recommendation?: string;
  /** Why they are asking and what they already tried. Never an option. */
  context?: string;
}

export interface Interaction {
  id: string;
  userSessionId: string;
  /** Null = the main lane. Otherwise the AgentSession the asker sits in. */
  agentSessionId: string | null;
  /** Null = the main lane. Otherwise the asking agent's name. */
  agent: string | null;
  kind: InteractionKind;
  status: InteractionStatus;
  urgency: InteractionUrgency;
  source: InteractionSource;
  /** Card-level recommendation for Console-generated cards. */
  recommendation: string | null;
  allowFreeText: boolean;
  /**
   * The asker's parked promise died (park, rotation, watchdog, restart). The
   * row is still answerable — the answer is delivered by mailbox instead of
   * returned from the tool call.
   */
  detached: boolean;
  payload:
    | {
        questions: InteractionQuestion[];
        /** Requirement ids the question resolves or gates; the answer pins to them. */
        requirementIds?: string[];
      }
    | {
        plan: string;
        /** Marks a legacy spec-revision approval. */
        spec?: { revision: number; changeNote?: string };
        /** Marks a requirement-revision approval (the canonical spec). */
        requirements?: {
          revision: number;
          changeNote?: string;
          nodeCount: number;
          /** What the proposal patches: prose + structure, prose alone, or one subtree. */
          kind?: "full" | "intent" | "subtree";
          /** Subtree context for the card: the scope node and its ancestor chain. */
          scope?: { scopeId: string; statement: string; ancestors: { id: string; statement: string }[] };
          /** Server-computed change summary the operator approves against. */
          summary?: { added: string[]; changed: { id: string; statement: string }[]; retired: { id: string; statement: string }[] };
        };
      };
  response: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt: string | null;
}

// ---------------------------------------------------------------------------
// Requirement graph wire shapes. The graph itself (nodes, parser, renderers)
// lives in ./requirements.ts; these are the REST/event projections.

/**
 * One live requirement node as the API serves it. `status` is the node's own
 * recorded status; `derivedStatus` is the console's mechanical roll-up over
 * live children (equal to `status` on a leaf).
 */
export interface RequirementNodeWire {
  id: string;
  parentId: string | null;
  ord: number;
  statement: string;
  composition: import("./requirements.ts").RequirementComposition;
  /** The node's OWN declared expectation; ancestors' declarations inherit at gap derivation. */
  verifyExpectation: import("./requirements.ts").RequirementVerifyExpectation | null;
  status: import("./requirements.ts").RequirementStatus;
  derivedStatus: import("./requirements.ts").RequirementStatus;
  /** "committed" = part of an approved revision; "refinement" = decomposed below a delegated node during the run. */
  origin: "committed" | "refinement";
  introducedInRevision: number;
  retiredInRevision: number | null;
  /** Session that authored a refinement node; null for committed nodes. */
  refinedByAgentSessionId: string | null;
  /** Open agent sessions currently delegated this node. */
  delegatedTo: string[];
  /** The most recent status change, for verification chips. */
  latestChange: {
    status: import("./requirements.ts").RequirementStatus;
    verifiedBy: import("./requirements.ts").RequirementVerifiedBy;
    actor: string;
    evidenceCount: number;
    at: string;
  } | null;
  /** Outgoing depends_on targets (requirement ids). */
  dependsOn: string[];
  /** Incoming depends_on sources — who is waiting on this node. */
  dependents: string[];
  /** conflicts_with partners (symmetric; both directions merged). */
  conflictsWith: string[];
  /** Assumptions this node rests on, with their current status. */
  restsOn: { id: string; status: AssumptionStatus }[];
  /**
   * Deterministic invalidation marks, computed from the shared ordinal clock
   * — never stored, never part of derivation: `depends_changed` when a direct
   * dependency moved after this node's latest terminal claim;
   * `rests_on_falsified` when a linked assumption was falsified after it.
   * Record-and-display: reopening remains a model or operator act.
   */
  flags: ("depends_changed" | "rests_on_falsified")[];
}

export type AssumptionStatus = "open" | "confirmed" | "falsified" | "retired";

/** A recorded premise the work proceeds on — see the assumptions table. */
export interface AssumptionWire {
  id: string;
  text: string;
  status: AssumptionStatus;
  source: "operator" | "main" | "agent";
  actor: string;
  agentSessionId: string | null;
  interactionId: string | null;
  resolutionNote: string | null;
  resolutionEvidenceCount: number;
  /** Requirement ids linked rests_on to this assumption. */
  requirementIds: string[];
  createdAt: string;
  resolvedAt: string | null;
}

/** Why an open requirement is still open — derived from console-owned facts. */
export type RequirementFrontierAnnotation = "in_progress" | "blocked" | "awaiting_operator" | "unassigned";

export interface RequirementFrontierEntry {
  requirementId: string;
  statement: string;
  annotations: RequirementFrontierAnnotation[];
}

/**
 * A leaf recorded `satisfied` below its declared verification expectation
 * (its own or an ancestor's `(verify: …)` marker). Derived at read time,
 * displayed everywhere statuses appear, never a gate — the operator remains
 * the gate.
 */
export interface RequirementVerificationGap {
  requirementId: string;
  statement: string;
  /** The effective (own or inherited, strongest-wins) declared expectation. */
  expected: import("./requirements.ts").RequirementVerifyExpectation;
  /** The claim that fell short of it. */
  recorded: {
    verifiedBy: import("./requirements.ts").RequirementVerifiedBy;
    actor: string;
    at: string;
  };
}

/**
 * A terminal claim (satisfied / violated / infeasible) that the run itself
 * later withdrew — derived from the status journal, excluding the console's
 * mechanical resets. The honest measure of verification quality: a reversed
 * `satisfied` is an acceptance that turned out wrong, attributed to the tier
 * and actor that stood behind it.
 */
export interface RequirementReversal {
  requirementId: string;
  /** The statement at read time (amendments keep ids stable). */
  statement: string;
  from: "satisfied" | "violated" | "infeasible";
  to: import("./requirements.ts").RequirementStatus;
  at: string;
  reversedBy: { actor: string; verifiedBy: import("./requirements.ts").RequirementVerifiedBy };
  /** The claim being withdrawn; null when history began terminal (defensive). */
  original: {
    actor: string;
    verifiedBy: import("./requirements.ts").RequirementVerifiedBy;
    evidenceCount: number;
    at: string;
  } | null;
}

// ---------------------------------------------------------------------------
// Change-impact ledger wire shapes. A change impact is the console-computed
// blast radius of one meaning-changing event — an approved amendment, a
// falsified assumption, a withdrawn terminal claim — persisted at the moment
// of the change so affected work and prior evidence cannot silently drop out
// of attention. The console computes consequences; main and the operator
// judge meaning (reopen, steer, waive) and record that judgment as
// dispositions. Reconciliation state is DERIVED, never stored: a later claim
// on a suspect requirement or an archived session clears its item
// mechanically.

export type ChangeImpactSourceKind = "amendment" | "assumption_falsified" | "claim_withdrawn";

/** How a requirement entered the affected set (with `via` naming the cause). */
export type ChangeImpactBasis = "changed" | "retired" | "reopened" | "falsified" | "descendant" | "dependent";

/** The affected set snapshotted at computation time — console facts only. */
export interface ChangeImpactAffected {
  /** The ids whose meaning/validity changed — the closure's starting set. */
  seedIds: string[];
  /** The transitive closure: seeds, their descendants, dependents (via depends_on, including edges onto ancestors of affected nodes), and the dependents' descendants. */
  requirements: { id: string; basis: ChangeImpactBasis; via: string }[];
  /** Terminal claims inside the affected set recorded BEFORE the change — prior evidence the change may have invalidated. */
  suspectClaims: {
    requirementId: string;
    status: "satisfied" | "violated" | "infeasible";
    verifiedBy: import("./requirements.ts").RequirementVerifiedBy;
    actor: string;
    ord: number;
    at: string;
  }[];
  /** Open agent sessions whose delegations or requirement-linked tasks intersect the affected set. */
  sessions: { agentSessionId: string; title: string }[];
  /** Incomplete requirement-linked tasks inside the affected set (visibility for the judge; their session's disposition covers them). */
  tasks: { taskId: string; subject: string; status: string; agentSessionId: string | null }[];
  /** Live scheduled assignments waiting on affected tasks. */
  scheduledAssignments: { id: string; taskId: string; agentSessionId: string; recipient: string }[];
}

/** For a suspect claim: it still holds under the change, or stopped mattering. Reopening/re-verifying is an ACT (report_requirement) and clears mechanically. */
export type ChangeImpactClaimDisposition = "stands" | "superseded";
/** For an affected session: judged untouched, steered with an update, interrupted, or overtaken by events. Archiving clears mechanically. */
export type ChangeImpactSessionDisposition = "unaffected" | "steered" | "interrupted" | "superseded";

/** One recorded judgment on one affected item — journaled, last-wins per item. */
export interface ChangeImpactDispositionEntry {
  kind: "claim" | "session";
  /** Requirement id (claim) or agent session id (session). */
  id: string;
  disposition: ChangeImpactClaimDisposition | ChangeImpactSessionDisposition;
  note: string;
  actor: string;
  at: string;
}

export interface ChangeImpactWire {
  id: string;
  sourceKind: ChangeImpactSourceKind;
  /** "rev:<n>" for amendments, the assumption id, or the status-change id. */
  sourceRef: string;
  /** The governing requirement revision when the impact was computed. */
  atRevision: number;
  /** The shared invalidation-clock ordinal at computation; claims with a later ord postdate the change. */
  computedAtOrd: number;
  note: string | null;
  affected: ChangeImpactAffected;
  dispositions: ChangeImpactDispositionEntry[];
  /** Items still holding the impact open: standing suspect claims and open sessions without a disposition or mechanical clearance. */
  outstanding: { claims: string[]; sessions: string[] };
  status: "open" | "reconciled";
  createdAt: string;
}

/** Orchestration-pattern catalog ids — the create-session wire vocabulary. */
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
