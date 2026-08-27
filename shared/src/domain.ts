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
  /**
   * The coverage report's scalars, so the collapsed card can say "N
   * exceptions require acceptance" without a fetch. Absent on events emitted
   * before coverage existed; null when no requirement graph governs.
   */
  coverage?: { readiness: "ready" | "ready_with_exceptions"; exceptions: number } | null;
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
  /** NULL = top-level; set = a child session nested under that parent (any depth the configured cap permits). */
  parentAgentSessionId: string | null;
  /** Nesting level: 0 = top-level, each child one deeper, bounded by CONSOLE_MAX_SESSION_DEPTH. */
  depth: number;
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
  /** The project-level decision issue this ask participates in; null for asks that predate the issue layer, native AskUserQuestion cards, and plan approvals. */
  issueId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

// ---------------------------------------------------------------------------
// Decision issues: the project-level unresolved human choice that one or more
// asks refer to. An ask (an interaction row) is one agent's attempt to get the
// answer; the issue is the durable shared question — it outlives its askers,
// carries the resolution history, and is what one operator answer resolves.

export type DecisionIssueStatus = "open" | "resolved" | "superseded";

/** One entry in an issue's resolution history. The LAST entry is the current answer; earlier entries are retained history, never rewritten. */
export interface DecisionIssueResolution {
  /** What the operator actually said — free text is preserved verbatim, never normalized to an option. */
  answer: string;
  note?: string;
  /** How the answer arrived: an answered card, chat bound to the single open issue, or main explicitly binding the operator's chat words. */
  via: "card" | "chat" | "main";
  /** The answered card (card path) or the ask whose card carried the binding. */
  interactionId?: string;
  /** True when this entry replaced an earlier resolution — a reversal, not the first answer. */
  supersedes?: boolean;
  at: string;
}

/** One participating ask, projected from its interaction row. */
export interface DecisionIssueAskWire {
  interactionId: string;
  /** Null = the main lane. */
  agentSessionId: string | null;
  asker: string;
  question: string;
  status: InteractionStatus;
  urgency: InteractionUrgency;
  /** The ask provisionally proceeded on its own recommendation — visible as NOT a human answer. */
  autoProceeded: boolean;
  recommendation: string | null;
  createdAt: string;
}

export interface DecisionIssueWire {
  id: string;
  /** Normalized explicit key askers use to attach to the same issue; null = unkeyed. */
  issueKey: string | null;
  /** The shared human question — the first asker's wording until merged/edited. */
  subject: string;
  status: DecisionIssueStatus;
  /** Derived: open, and at least one ask auto-proceeded on its recommendation. */
  provisional: boolean;
  /** Union of the participating asks' requirement ids. */
  requirementIds: string[];
  asks: DecisionIssueAskWire[];
  /** Pending blocking asks whose asker's session is still open (main-lane counts) — the live blocking weight. */
  blockingAsksActive: number;
  /** All pending asks whose asker's session is still open. */
  pendingAsksActive: number;
  resolutions: DecisionIssueResolution[];
  /** The current answer (last resolution entry), null while open. */
  resolution: DecisionIssueResolution | null;
  /** Set when this issue was merged into another; the target carries the asks now. */
  supersededById: string | null;
  createdBy: string;
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
  /** Open agent sessions whose delegations or requirement-linked tasks intersect the affected set — plus, via workstream links, open consumers of any affected session (`via` says which producer coupled them in). */
  sessions: { agentSessionId: string; title: string; via?: string }[];
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

/**
 * A workstream dependency link's DERIVED status — computed from console-owned
 * facts at read time, never stored:
 * - `pending`: the producer session is open and has not reported its final.
 * - `satisfied`: the producer's final voice has reported terminally (a later
 *   non-terminal report from it regresses the link to pending — satisfaction
 *   is a current projection, not a ratchet).
 * - `broken`: the producer was archived without ever reporting — abandoned or
 *   closed; the consumer is visibly stale, never silently satisfied.
 * - `released`: main recorded a judgment (superseded, re-pointed) and the row
 *   is a historical record.
 */
export type WorkstreamLinkStatus = "pending" | "satisfied" | "broken" | "released";

export interface WorkstreamLinkWire {
  id: string;
  consumerAgentSessionId: string;
  consumerTitle: string;
  producerAgentSessionId: string;
  producerTitle: string;
  /** The interface/artifact that crosses the boundary, in one line. */
  subject: string;
  status: WorkstreamLinkStatus;
  createdBy: string;
  note: string | null;
  createdAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
  releaseNote: string | null;
}

// ---------------------------------------------------------------------------
// Completion coverage. Before a run reaches sign-off the Console derives — from
// durable state only, never from a model's claim — how the current objective is
// accounted for: every live root-affecting requirement leaf exactly once, plus
// execution debt and defaulted human choices. Anything unmet becomes a TYPED
// exception the operator must explicitly waive (under the waiver_required
// policy) rather than a prose caveat. The operator remains the gate; the report
// changes what they are asked to accept, not who decides.

/**
 * How strictly sign-off consumes the coverage report. `waiver_required`
 * (default): accepting a run with outstanding exceptions requires a typed
 * waiver per exception. `advisory`: exceptions are enumerated on the card but
 * one-click accept remains legal. Snapshotted into every report so a later
 * configuration change cannot reinterpret why a completed run was accepted.
 */
export type CompletionPolicy = "advisory" | "waiver_required";

/**
 * One obligation's state. `moot` marks a leaf under a satisfied `any` ancestor
 * whose own chain did not produce that satisfaction — accounted for exactly
 * once, classified, never an exception (the chosen alternative discharged it).
 */
export type CoverageObligationState = "satisfied" | "open" | "violated" | "infeasible" | "moot";

/**
 * One live requirement LEAF the current objective still answers for. Parents
 * are derived, so counting leaves counts every obligation exactly once;
 * retired nodes are out of scope entirely.
 */
export interface CoverageObligation {
  requirementId: string;
  statement: string;
  state: CoverageObligationState;
  /** True when the terminal claim carries a deterministic invalidation flag (depends_changed / rests_on_falsified) — terminal but revalidation-required. */
  stale: boolean;
  /** The latest terminal claim behind the state, with its actual evidence refs; null while open/moot-without-claim. */
  claim: {
    verifiedBy: import("./requirements.ts").RequirementVerifiedBy;
    actor: string;
    at: string;
    evidence: { kind: string; ref: string; label?: string }[];
  } | null;
  /** The effective declared verification expectation (own or inherited, strongest wins) and whether the recorded tier meets it. Only set on satisfied leaves with a declaration. */
  verification: { expected: import("./requirements.ts").RequirementVerifyExpectation; met: boolean } | null;
}

/** The typed unmet-condition vocabulary — each kind is a distinct waiver target. */
export type CoverageExceptionKind =
  /** A required frontier leaf is open or violated. */
  | "requirement_unsatisfied"
  /** A terminal claim is flagged stale (dependency moved / assumption falsified after it). */
  | "requirement_stale"
  /** Satisfied below its declared verification expectation. */
  | "verification_below_declared"
  /** A non-operator terminal claim carries no evidence ref. */
  | "evidence_missing"
  /** An open task in an open session still discharges a live requirement. */
  | "task_debt"
  /** An open decision issue proceeded provisionally on a recommendation — not a human answer. */
  | "decision_provisional"
  /** A previously landed worktree result is no longer reachable from the canonical workspace HEAD. */
  | "landing_invalidated";

export interface CoverageException {
  kind: CoverageExceptionKind;
  /** The semantic object waived: requirement id, task id, or decision issue id by kind. */
  ref: string;
  /** The concrete condition, human-readable — becomes the waiver's accepted consequence. */
  detail: string;
}

/**
 * The machine-checkable completion accounting, derived from durable state and
 * persisted verbatim with the run summary (never truncated — the card bounds
 * its DISPLAY, not this object).
 */
export interface CompletionCoverageReport {
  /** The governing requirement revision this coverage was computed against. */
  revision: number;
  policy: CompletionPolicy;
  computedAt: string;
  /** Every live root-affecting leaf, exactly once. */
  obligations: CoverageObligation[];
  counts: { satisfied: number; open: number; violated: number; infeasible: number; moot: number; stale: number };
  /** Unmet conditions requiring explicit operator acceptance under waiver_required. */
  exceptions: CoverageException[];
  /** Non-blocking findings (e.g. unresolved decision issues nobody can act on). */
  advisories: string[];
  /** Reconciliation preconditions — held to zero at proposal time by the completion predicate; recorded for audit and for mid-run (tail) reads. */
  reconciliation: { openChangeImpacts: number; brokenWorkstreamLinks: number };
  readiness: "ready" | "ready_with_exceptions";
}

/**
 * A typed operator acceptance of one specific unmet completion condition,
 * recorded at sign-off. Scoped to the exception's semantic object AND the
 * revision accepted: a waiver never outlives the meaning it was granted
 * against — a later proposal recomputes coverage and asks again.
 */
export interface CompletionWaiver {
  kind: CoverageExceptionKind;
  ref: string;
  /** The exception detail as accepted — the consequence the operator took on. */
  detail: string;
  /** The governing requirement revision the waiver was granted against. */
  revision: number;
  /** The policy in force when it was granted. */
  policy: CompletionPolicy;
  decidedBy: "operator";
  at: string;
  /** Optional operator-supplied reason. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Continuation checkpoints. When a UserSession is archived, the Console
// persists one project-level operational handoff for the NEXT session on the
// same project: what strategy was in force and why (copied from the prior
// main's own last recorded working state — model-authored, advisory), plus
// console-derived facts about what was left unresolved (unreported
// workstreams, standing suspect claims, open decision issues, accepted
// waivers, salvage pointers). Project truth — requirements, decisions,
// assumptions — stays authoritative in its own stores; the checkpoint carries
// only references and bounded summaries, never copies of governing meaning.
// One immutable checkpoint per source session; the latest prior one is
// injected (bounded) into a continued session's orchestrator context.

/**
 * The model-authored slice, snapshotted verbatim from the source session's
 * latest orchestration-state revision. Null when that run never recorded
 * working state — the checkpoint degrades to facts, it never invents strategy.
 */
export interface ContinuationSynthesis {
  /** The orchestration-state revision the snapshot was taken from. */
  stateRevision: number;
  strategy: string;
  strategyWhy: string;
  uncertainties: string[];
  /** Main's informal working assumptions — durable assumption ROWS continue on their own. */
  assumptions: string[];
  risks: string[];
}

/** Console-derived facts at the run boundary — references and bounded summaries only. */
export interface ContinuationFacts {
  /** The latest run-summary proposal, when one exists. */
  completion: { summaryId: string; status: "proposed" | "accepted" | "changes_requested"; verdict: string; headline: string } | null;
  /** Typed operator waivers granted at accept — accepted gaps, not future obligations. */
  waivers: { kind: CoverageExceptionKind; ref: string; detail: string; note?: string }[];
  /** From main's latest record_completion, when one exists (model-authored, recorded in-run). */
  knownGaps: string[];
  nonGoals: string[];
  /** AgentSessions of the source run that never reported a final — unfinished or abandoned workstreams. */
  unfinishedWorkstreams: { agentSessionId: string; title: string; openTasks: number }[];
  /** Live workstream links not satisfied at the boundary — declared couplings the next run should know. */
  pendingWorkstreamLinks: { linkId: string; subject: string; consumerTitle: string; producerTitle: string; status: WorkstreamLinkStatus }[];
  /** Change impacts whose suspect terminal claims still stand — prior evidence awaiting judgment. */
  openChangeImpacts: { id: string; sourceKind: ChangeImpactSourceKind; sourceRef: string; suspectClaims: string[] }[];
  /** Open project decision issues at the boundary (ids + subjects; list_decision_issues has detail). */
  openDecisionIssues: { id: string; subject: string }[];
  /** Unlanded work preserved at archival: renamed branches and diff artifacts. */
  salvage: { agentSessionId: string; agent: string; branch: string | null; artifactId: string | null }[];
}

export interface ContinuationCheckpointWire {
  id: string;
  projectId: string;
  sourceUserSessionId: string;
  /** The source session's title at record time — how the operator knows the run. */
  sourceTitle: string | null;
  /** The source session's runState at the boundary: completed = accepted sign-off; anything else ended early. */
  runState: "active" | "awaiting_signoff" | "completed";
  /**
   * Why the source run stopped, when a pause held at its archival. Derived at
   * read time from the archived session row (resume never touches archived
   * rows, so the value is frozen at the boundary): "capacity" = the provider
   * usage window closed on it; "budget" = its spend ceiling; "operator" = the
   * operator's own pause. Null = archived without a pause holding.
   */
  sourcePauseReason: PauseReason | null;
  /** The governing requirement revision when the checkpoint was written (0 = none governed). */
  atRevision: number;
  /** Ledger length at record time — a currency hint beside atRevision. */
  decisionCount: number;
  synthesis: ContinuationSynthesis | null;
  facts: ContinuationFacts;
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
