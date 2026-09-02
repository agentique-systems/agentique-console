/**
 * The one HTTP contract of the console (migration-contract §5): every route
 * the server serves and the web application calls, its request schemas, and
 * its response shapes. Nothing else defines a route table. Routes live under
 * `/api/` with the final resource names; every mutation dispatches to the
 * canonical owning service on the server, and no request field names a
 * privileged actor, a producer, a storage key, or a filesystem path outside
 * the configured browse roots.
 *
 * Errors are one envelope (`ApiErrorBody`) with a closed code set; an
 * unknown route — every legacy path included — is the standard `not_found`
 * body with no redirect and no hint. Lists page deterministically by id
 * cursor with a bounded limit; bodies and content responses are bounded by
 * the constants below.
 */
import { z } from "zod";
import type { AgentDefinition, AgentDefinitionRevision } from "./agents.ts";
import type { Artifact } from "./artifacts.ts";
import { allocationSchema, budgetLimitsSchema, BUDGET_INCREASE_PARTITIONS, type Allocation, type AllocationExtension, type BudgetIncrease, type BudgetIncreasePartition, type BudgetLimits, type PlanNodeAllocationProjection, type RunCapacity } from "./budgets.ts";
import type { CompletionRequest } from "./completion.ts";
import type { Conversation, ConversationMessage } from "./conversations.ts";
import { BUDGET_INCREASE_OPTIONS, PUBLISH_OPTIONS, type BudgetIncreaseOption, type Decision, type DecisionResolver, type PublishOption } from "./decisions.ts";
import type { Event } from "./events.ts";
import type { Handoff } from "./handoffs.ts";
import type {
  AcceptanceCriterionId,
  AgentDefinitionId,
  AgentDefinitionRevisionId,
  ArtifactId,
  AttemptId,
  ChangesetId,
  ConversationId,
  ConversationMessageId,
  DecisionId,
  EvaluationId,
  GateId,
  HandoffId,
  InvocationId,
  PlanNodeId,
  PublicationId,
  RequirementId,
  RequirementProposalId,
  RequirementRevisionId,
  RunId,
  SnapshotId,
  TaskId,
  WorkspaceId,
} from "./ids.ts";
import type { Attempt, ContextManifest, Invocation, InvocationRole } from "./invocations.ts";
import type { OrchestratorInput } from "./orchestrator-inputs.ts";
import type { ExecutionPlanRevision, PlanGraph, PlanNode, PlanNodeStatus } from "./plans.ts";
import type { Publication, PublicationReport } from "./publication.ts";
import { acceptanceCheckSchema, proposedRequirementTreeSchema, REQUIREMENT_TREE_MAX_ENTRIES, type AcceptanceCheck, type AcceptanceCriterion, type ProposedRequirement, type Requirement, type RequirementProposal, type RequirementRevision, type RequirementStatusChange, type RequirementTreeEntry } from "./requirements.ts";
import { OPERATOR_PAUSE_MODES, RUN_KINDS, runTargetSchema, type OperatorPauseMode, type Run, type RunKind, type RunStatus, type RunTarget, type RunWaitReason } from "./runs.ts";
import type { RuntimeToolCall } from "./runtime-tools.ts";
import type { SignoffResolution } from "./signoff.ts";
import type { Task, TaskBlockReason, TaskDependency } from "./tasks.ts";
import type { Usage, UsageTotals } from "./usage.ts";
import { idSchema } from "./validation.ts";
import type { Evaluation, Gate } from "./verification.ts";
import { publicationStrategyRequestSchema, type Changeset, type PublicationStrategy, type PublicationStrategyRequest, type Snapshot } from "./workspace-state.ts";
import { WORKSPACE_KINDS, type Workspace, type WorkspaceKind } from "./workspaces.ts";

export const API_PREFIX = "/api";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The closed HTTP error codes: validation, absence, a canonical conflict or typed refusal, a capability the Workspace lacks, an oversized request or response, admission closed, and the rest. */
export const API_ERROR_CODES = ["bad_request", "forbidden", "not_found", "conflict", "refused", "unsupported", "payload_too_large", "unavailable", "internal"] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Closed facts of the refusal (ids, codes, statuses); never content, paths, or stacks. */
    details: Record<string, unknown> | null;
  };
}

/** The HTTP status of each error code. */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = Object.freeze({
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  refused: 409,
  unsupported: 409,
  payload_too_large: 413,
  unavailable: 503,
  internal: 500,
});

/** The one body every unknown route returns, legacy paths included: no redirect, no hint. */
export const STANDARD_NOT_FOUND: Readonly<ApiErrorBody> = Object.freeze({ error: { code: "not_found" as const, message: "no such route", details: null } });

// ---------------------------------------------------------------------------
// Bounds and pagination
// ---------------------------------------------------------------------------

/** The bound on any JSON request body. */
export const API_BODY_MAX_BYTES = 262_144;
/** The default and maximum page sizes of every list route. */
export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;
/** Artifact bytes an inline content read returns per page (`offset`/`maxBytes`); larger Artifacts page or download. */
export const ARTIFACT_CONTENT_MAX_BYTES = 1_048_576;
/** The bound on a download response. */
export const ARTIFACT_DOWNLOAD_MAX_BYTES = 268_435_456;
/** The bound on an operator message body (the same as the Orchestrator input bound). */
export const OPERATOR_MESSAGE_MAX_BYTES = 32_768;
/** Events one replay page carries; a subscription pages until it is caught up. */
export const EVENT_REPLAY_PAGE = 500;

export interface Page<T> {
  items: T[];
  /** The cursor of the next page, or `null` at the end; pass it back as `cursor`. */
  nextCursor: string | null;
}

export const pageQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** Pages an id-sorted list deterministically: the cursor is the last id of the previous page. */
export function pageOf<T>(items: readonly T[], idOf: (item: T) => string, query: PageQuery): Page<T> {
  const sorted = [...items].sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
  const start = query.cursor === undefined ? 0 : sorted.findIndex((item) => idOf(item) > query.cursor!);
  const from = start < 0 ? sorted.length : start;
  const limit = query.limit ?? PAGE_LIMIT_DEFAULT;
  const page = sorted.slice(from, from + limit);
  const last = page.at(-1);
  return { items: page, nextCursor: last !== undefined && from + limit < sorted.length ? idOf(last) : null };
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PATCH";

export interface ApiRoute {
  method: HttpMethod;
  path: `/api/${string}`;
}

export const API_ROUTES = {
  // system
  health: { method: "GET", path: "/api/health" },
  config: { method: "GET", path: "/api/config" },
  capacity: { method: "GET", path: "/api/system/capacity" },
  events: { method: "GET", path: "/api/events" },
  fsRoots: { method: "GET", path: "/api/fs/roots" },
  fsDirs: { method: "GET", path: "/api/fs/dirs" },
  // workspaces
  listWorkspaces: { method: "GET", path: "/api/workspaces" },
  createWorkspace: { method: "POST", path: "/api/workspaces" },
  getWorkspace: { method: "GET", path: "/api/workspaces/:workspaceId" },
  updateWorkspace: { method: "PATCH", path: "/api/workspaces/:workspaceId" },
  listWorkspaceConversations: { method: "GET", path: "/api/workspaces/:workspaceId/conversations" },
  listWorkspaceRuns: { method: "GET", path: "/api/workspaces/:workspaceId/runs" },
  listWorkspaceAgentDefinitions: { method: "GET", path: "/api/workspaces/:workspaceId/agent-definitions" },
  loadWorkspaceAgentDefinitions: { method: "POST", path: "/api/workspaces/:workspaceId/agent-definitions/load" },
  // agent definitions
  getAgentDefinition: { method: "GET", path: "/api/agent-definitions/:agentDefinitionId" },
  listAgentDefinitionRevisions: { method: "GET", path: "/api/agent-definitions/:agentDefinitionId/revisions" },
  getAgentDefinitionRevision: { method: "GET", path: "/api/agent-definitions/:agentDefinitionId/revisions/:revisionId" },
  // conversations
  listConversations: { method: "GET", path: "/api/conversations" },
  createConversation: { method: "POST", path: "/api/conversations" },
  getConversation: { method: "GET", path: "/api/conversations/:conversationId" },
  updateConversation: { method: "PATCH", path: "/api/conversations/:conversationId" },
  listConversationMessages: { method: "GET", path: "/api/conversations/:conversationId/messages" },
  postConversationMessage: { method: "POST", path: "/api/conversations/:conversationId/messages" },
  listConversationRequirements: { method: "GET", path: "/api/conversations/:conversationId/requirements" },
  createRequirementRevision: { method: "POST", path: "/api/conversations/:conversationId/requirements" },
  listConversationDecisions: { method: "GET", path: "/api/conversations/:conversationId/decisions" },
  listConversationRuns: { method: "GET", path: "/api/conversations/:conversationId/runs" },
  createRun: { method: "POST", path: "/api/conversations/:conversationId/runs" },
  // requirements
  getRequirement: { method: "GET", path: "/api/requirements/:requirementId" },
  createAcceptanceCriterion: { method: "POST", path: "/api/requirements/:requirementId/acceptance-criteria" },
  getAcceptanceCriterion: { method: "GET", path: "/api/acceptance-criteria/:acceptanceCriterionId" },
  listRunRequirementProposals: { method: "GET", path: "/api/runs/:runId/requirement-proposals" },
  getRequirementProposal: { method: "GET", path: "/api/requirement-proposals/:proposalId" },
  approveRequirementProposal: { method: "POST", path: "/api/requirement-proposals/:proposalId/approve" },
  rejectRequirementProposal: { method: "POST", path: "/api/requirement-proposals/:proposalId/reject" },
  // runs
  getRun: { method: "GET", path: "/api/runs/:runId" },
  startRun: { method: "POST", path: "/api/runs/:runId/start" },
  cancelRun: { method: "POST", path: "/api/runs/:runId/cancel" },
  pauseRun: { method: "POST", path: "/api/runs/:runId/pause" },
  resumeRun: { method: "POST", path: "/api/runs/:runId/resume" },
  getRunPlan: { method: "GET", path: "/api/runs/:runId/plan" },
  listRunPlanRevisions: { method: "GET", path: "/api/runs/:runId/plan/revisions" },
  listRunInvocations: { method: "GET", path: "/api/runs/:runId/invocations" },
  listRunTasks: { method: "GET", path: "/api/runs/:runId/tasks" },
  listRunHandoffs: { method: "GET", path: "/api/runs/:runId/handoffs" },
  listRunDecisions: { method: "GET", path: "/api/runs/:runId/decisions" },
  getRunBudget: { method: "GET", path: "/api/runs/:runId/budget" },
  requestBudgetIncrease: { method: "POST", path: "/api/runs/:runId/budget-increases" },
  resolveBudgetIncrease: { method: "POST", path: "/api/runs/:runId/budget-increases/:decisionId/resolve" },
  listRunEvaluations: { method: "GET", path: "/api/runs/:runId/evaluations" },
  listRunGates: { method: "GET", path: "/api/runs/:runId/gates" },
  listRunSnapshots: { method: "GET", path: "/api/runs/:runId/snapshots" },
  listRunChangesets: { method: "GET", path: "/api/runs/:runId/changesets" },
  listRunArtifacts: { method: "GET", path: "/api/runs/:runId/artifacts" },
  getRunUsage: { method: "GET", path: "/api/runs/:runId/usage" },
  listRunCompletionRequests: { method: "GET", path: "/api/runs/:runId/completion-requests" },
  listRunOrchestratorInputs: { method: "GET", path: "/api/runs/:runId/orchestrator-inputs" },
  getRunSignoff: { method: "GET", path: "/api/runs/:runId/signoff" },
  acceptSignoff: { method: "POST", path: "/api/runs/:runId/signoff/accept" },
  requestSignoffChanges: { method: "POST", path: "/api/runs/:runId/signoff/request-changes" },
  getRunPublications: { method: "GET", path: "/api/runs/:runId/publications" },
  requestPublication: { method: "POST", path: "/api/runs/:runId/publications" },
  resolvePublication: { method: "POST", path: "/api/runs/:runId/publications/:decisionId/resolve" },
  // plan nodes, invocations, attempts
  getPlanNode: { method: "GET", path: "/api/plan-nodes/:planNodeId" },
  getInvocation: { method: "GET", path: "/api/invocations/:invocationId" },
  listInvocationAttempts: { method: "GET", path: "/api/invocations/:invocationId/attempts" },
  getAttempt: { method: "GET", path: "/api/attempts/:attemptId" },
  getAttemptTranscript: { method: "GET", path: "/api/attempts/:attemptId/transcript" },
  // tasks, handoffs, decisions
  getTask: { method: "GET", path: "/api/tasks/:taskId" },
  getHandoff: { method: "GET", path: "/api/handoffs/:handoffId" },
  getDecision: { method: "GET", path: "/api/decisions/:decisionId" },
  resolveDecision: { method: "POST", path: "/api/decisions/:decisionId/resolve" },
  supersedeDecision: { method: "POST", path: "/api/decisions/:decisionId/supersede" },
  // verification records
  getEvaluation: { method: "GET", path: "/api/evaluations/:evaluationId" },
  getGate: { method: "GET", path: "/api/gates/:gateId" },
  getSnapshot: { method: "GET", path: "/api/snapshots/:snapshotId" },
  getChangeset: { method: "GET", path: "/api/changesets/:changesetId" },
  getArtifact: { method: "GET", path: "/api/artifacts/:artifactId" },
  getArtifactContent: { method: "GET", path: "/api/artifacts/:artifactId/content" },
  downloadArtifact: { method: "GET", path: "/api/artifacts/:artifactId/download" },
  // publications
  getPublication: { method: "GET", path: "/api/publications/:publicationId" },
  advancePublication: { method: "POST", path: "/api/publications/:publicationId/advance" },
} as const satisfies Record<string, ApiRoute>;

export type ApiRouteName = keyof typeof API_ROUTES;
export const API_ROUTE_NAMES = Object.keys(API_ROUTES) as ApiRouteName[];

/** The `:param` names of a route path, in order. */
export function routeParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
}

/** The concrete path of a route with its parameters substituted (each encoded); a query is appended when given. */
export function apiPath(name: ApiRouteName, params: Record<string, string> = {}, query: Record<string, string | number | undefined> = {}): string {
  let path: string = API_ROUTES[name].path;
  for (const param of routeParamNames(path)) {
    const value = params[param];
    if (value === undefined) throw new Error(`route ${name} needs the ${param} parameter`);
    path = path.replace(`:${param}`, encodeURIComponent(value));
  }
  const pairs = Object.entries(query)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return pairs.length === 0 ? path : `${path}?${pairs.join("&")}`;
}

// ---------------------------------------------------------------------------
// Request schemas (strict: an unknown field is a bad request)
// ---------------------------------------------------------------------------

const boundedText = (max: number) => z.string().min(1).max(max);
const rationale = z.string().max(4_000).nullable().optional();

export const workspaceCreateBodySchema = z.strictObject({
  name: boundedText(200).optional(),
  /** An absolute path under one of the configured browse roots; created when `create` is true and absent. */
  rootPath: boundedText(4_096),
  /** Detected from the directory when omitted (`git` when it is a repository root, `directory` otherwise); a stated kind must match. */
  kind: z.enum(WORKSPACE_KINDS).optional(),
  create: z.boolean().optional(),
});
export type WorkspaceCreateBody = z.infer<typeof workspaceCreateBodySchema>;

export const workspaceUpdateBodySchema = z.strictObject({ name: boundedText(200) });
export type WorkspaceUpdateBody = z.infer<typeof workspaceUpdateBodySchema>;

export const conversationCreateBodySchema = z.strictObject({ workspaceId: idSchema("workspace"), title: boundedText(200).nullable().optional() });
export type ConversationCreateBody = z.infer<typeof conversationCreateBodySchema>;

export const conversationUpdateBodySchema = z.strictObject({ title: boundedText(200).nullable() });
export type ConversationUpdateBody = z.infer<typeof conversationUpdateBodySchema>;

/** An operator message: recorded on the Conversation and, while a Run is active, queued as a typed input of the Orchestrator's next turn. */
export const messageBodySchema = z.strictObject({ content: z.string().min(1).max(OPERATOR_MESSAGE_MAX_BYTES) });
export type MessageBody = z.infer<typeof messageBodySchema>;

/**
 * The operator authors a Requirement revision: kept Requirements name their id and keep the Acceptance Criteria they hold at the
 * current revision (an entry's `acceptanceCriteria` are added beside them, never a replacement); new Requirements are minted with
 * exactly the criteria stated; Requirements left out are retired.
 */
export const requirementRevisionBodySchema = z.strictObject({ entries: proposedRequirementTreeSchema, rationale });
export type RequirementRevisionBody = z.infer<typeof requirementRevisionBodySchema>;

export const acceptanceCriterionBodySchema = z.strictObject({ check: acceptanceCheckSchema });
export type AcceptanceCriterionBody = z.infer<typeof acceptanceCriterionBodySchema>;

export const proposalApproveBodySchema = z.strictObject({ entries: proposedRequirementTreeSchema.optional(), rationale });
export type ProposalApproveBody = z.infer<typeof proposalApproveBodySchema>;

export const proposalRejectBodySchema = z.strictObject({ rationale });
export type ProposalRejectBody = z.infer<typeof proposalRejectBodySchema>;

/** A deterministic completion check the coding Run declares: authored as an Acceptance Criterion on the operator's Requirement. */
export const completionCheckSchema = z.strictObject({ command: boundedText(4_000), expectedExitCode: z.number().int().min(0).max(255).optional() });
export type CompletionCheck = z.infer<typeof completionCheckSchema>;

/**
 * Creates (and, unless `start` is false, starts) a Run in the Conversation. Everything but the goal has a validated
 * server default: the Target (the Workspace's default branch or the directory), the Budget, the Orchestrator allocation,
 * the final reserve (at least one Orchestrator allocation, from the canonical allocation rules), and the completion
 * check. The goal becomes the operator's first message and, with the completion check, a Requirement of the Conversation.
 */
export const runCreateBodySchema = z.strictObject({
  goal: z.string().min(1).max(OPERATOR_MESSAGE_MAX_BYTES),
  kind: z.enum(RUN_KINDS).optional(),
  target: runTargetSchema.optional(),
  budget: budgetLimitsSchema.optional(),
  finalReserve: allocationSchema.optional(),
  orchestratorAllocation: allocationSchema.optional(),
  /** `null` declares no completion check (only valid for a Run of kind `other`); omitted uses the configured default. */
  completionCheck: completionCheckSchema.nullable().optional(),
  /** The Gate Evaluator: the built-in reviewer, or none (deterministic-only Gates). */
  evaluator: z.enum(["reviewer", "none"]).optional(),
  start: z.boolean().optional(),
});
export type RunCreateBody = z.infer<typeof runCreateBodySchema>;

/** Starts a created Run: from the goal message the creation recorded (omitted), or from a replacement message recorded now and delivered instead. */
export const runStartBodySchema = z.strictObject({ message: z.string().min(1).max(OPERATOR_MESSAGE_MAX_BYTES).optional() });
export type RunStartBody = z.infer<typeof runStartBodySchema>;

export const runPauseBodySchema = z.strictObject({ mode: z.enum(OPERATOR_PAUSE_MODES) });
export type RunPauseBody = z.infer<typeof runPauseBodySchema>;

export const decisionResolveBodySchema = z.strictObject({ optionId: boundedText(200), rationale, artifactIds: z.array(idSchema("artifact")).max(50).optional() });
export type DecisionResolveBody = z.infer<typeof decisionResolveBodySchema>;

export const budgetIncreaseRequestBodySchema = z.strictObject({ partition: z.enum(BUDGET_INCREASE_PARTITIONS), added: allocationSchema });
export type BudgetIncreaseRequestBody = z.infer<typeof budgetIncreaseRequestBodySchema>;

export const budgetIncreaseResolveBodySchema = z.strictObject({ option: z.enum(BUDGET_INCREASE_OPTIONS) });
export type BudgetIncreaseResolveBody = z.infer<typeof budgetIncreaseResolveBodySchema>;

export const signoffAcceptBodySchema = z.strictObject({ gateId: idSchema("gate"), decisionId: idSchema("decision") });
export type SignoffAcceptBody = z.infer<typeof signoffAcceptBodySchema>;

export const signoffRequestChangesBodySchema = z.strictObject({ gateId: idSchema("gate"), decisionId: idSchema("decision"), message: z.string().min(1).max(OPERATOR_MESSAGE_MAX_BYTES) });
export type SignoffRequestChangesBody = z.infer<typeof signoffRequestChangesBodySchema>;

export const publicationRequestBodySchema = z.strictObject({ requestedStrategy: publicationStrategyRequestSchema.optional() });
export type PublicationRequestBody = z.infer<typeof publicationRequestBodySchema>;

export const publicationResolveBodySchema = z.strictObject({ option: z.enum(PUBLISH_OPTIONS) });
export type PublicationResolveBody = z.infer<typeof publicationResolveBodySchema>;

export const artifactContentQuerySchema = z.strictObject({
  offset: z.coerce.number().int().min(0).optional(),
  maxBytes: z.coerce.number().int().min(1).max(ARTIFACT_CONTENT_MAX_BYTES).optional(),
});
export type ArtifactContentQuery = z.infer<typeof artifactContentQuerySchema>;

export const fsDirsQuerySchema = z.strictObject({ path: boundedText(4_096), showHidden: z.enum(["0", "1"]).optional() });
export type FsDirsQuery = z.infer<typeof fsDirsQuerySchema>;

export const listConversationsQuerySchema = pageQuerySchema.extend({ workspaceId: idSchema("workspace").optional() });
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

/** The event stream: replay from `afterSeq` (0 for everything), optionally scoped; then live. */
export const eventsQuerySchema = z.strictObject({
  afterSeq: z.coerce.number().int().min(0).optional(),
  workspaceId: idSchema("workspace").optional(),
  conversationId: idSchema("conversation").optional(),
  runId: idSchema("run").optional(),
});
export type EventsQuery = z.infer<typeof eventsQuerySchema>;

/** The body schema of every route that accepts one; a GET has none. */
export const API_BODY_SCHEMAS: Readonly<Partial<Record<ApiRouteName, z.ZodType>>> = Object.freeze({
  createWorkspace: workspaceCreateBodySchema,
  updateWorkspace: workspaceUpdateBodySchema,
  createConversation: conversationCreateBodySchema,
  updateConversation: conversationUpdateBodySchema,
  postConversationMessage: messageBodySchema,
  createRequirementRevision: requirementRevisionBodySchema,
  createAcceptanceCriterion: acceptanceCriterionBodySchema,
  approveRequirementProposal: proposalApproveBodySchema,
  rejectRequirementProposal: proposalRejectBodySchema,
  createRun: runCreateBodySchema,
  startRun: runStartBodySchema,
  pauseRun: runPauseBodySchema,
  resolveDecision: decisionResolveBodySchema,
  supersedeDecision: decisionResolveBodySchema,
  requestBudgetIncrease: budgetIncreaseRequestBodySchema,
  resolveBudgetIncrease: budgetIncreaseResolveBodySchema,
  acceptSignoff: signoffAcceptBodySchema,
  requestSignoffChanges: signoffRequestChangesBodySchema,
  requestPublication: publicationRequestBodySchema,
  resolvePublication: publicationResolveBodySchema,
});

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** Whether the process admits work: `ready` after a complete startup recovery; the other states refuse mutations that admit execution. */
export const ADMISSION_STATES = ["starting", "recovering", "ready", "recovery_incomplete", "stopping"] as const;
export type AdmissionState = (typeof ADMISSION_STATES)[number];

export interface HealthResponse {
  ok: boolean;
  admission: AdmissionState;
  database: { disposition: "initialized" | "opened"; schemaVersion: number };
  /** The startup recovery's bounded facts, once it ran. */
  recovery: { interruptedAttempts: number; cancelledAttempts: number; releasedLeases: number; failedInvocations: number; retryEligible: number; workspaceReleased: number; workspaceReleaseFailed: number; blobsComplete: boolean; blobFailures: number; outstandingPublications: number } | null;
  startedAt: string;
}

/** What each Workspace kind can do, from the provider's capability matrix (the server fills it; the contract only names it). */
export interface WorkspaceCapabilities {
  kind: WorkspaceKind;
  target: "branch" | "directory";
  snapshotIdentity: string;
  /** The publication strategies the kind can honor; empty when the kind cannot publish at all. */
  publicationStrategies: PublicationStrategy["kind"][];
  atomicPublication: boolean;
  /** The one-line statement of how (or that not) the Target is updated. */
  publicationApply: string;
}

/** Safe configuration: defaults and limits only; never a credential, a key, or a filesystem path outside the browse roots. */
export interface ConfigResponse {
  defaults: {
    model: string;
    effort: string;
    runKind: RunKind;
    budget: BudgetLimits;
    finalReserve: Record<RunKind, Allocation>;
    orchestratorAllocation: Allocation;
    nodeAllocation: Allocation;
    completionCheck: CompletionCheck | null;
    evaluator: "reviewer" | "none";
  };
  limits: { operatorMessageMaxBytes: number; bodyMaxBytes: number; pageLimitMax: number; artifactContentMaxBytes: number };
  provider: { name: string; continuation: boolean };
  workspaceKinds: WorkspaceCapabilities[];
}

export interface CapacityResponse {
  providers: { provider: string; maxConcurrency: number; active: number; availability: { available: true } | { available: false; retryAfter: string | null } }[];
  process: { maxConcurrency: number; active: number };
  worktrees: { max: number | null; active: number };
  /** Active leases by Run and Attempt. */
  activeLeases: { leaseId: string; runId: RunId; attemptId: AttemptId; grantedAt: string }[];
}

export interface FsRootsResponse {
  roots: { path: string; label: string }[];
}

export interface FsDirsResponse {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; hidden: boolean }[];
}

export interface WorkspaceResponse {
  workspace: Workspace;
  capabilities: WorkspaceCapabilities;
  /** The default Target of a new Run: the checked-out branch of a git Workspace, the directory itself otherwise. */
  defaultTarget: RunTarget | null;
}

export interface AgentDefinitionSummary {
  definition: AgentDefinition;
  latestRevision: AgentDefinitionRevision;
  revisionCount: number;
}

export interface WorkspaceAgentDefinitionsResponse {
  builtins: AgentDefinitionSummary[];
  /** Workspace-file definitions read from a pinned Snapshot of this Workspace, latest revision each. */
  workspaceFiles: AgentDefinitionSummary[];
}

export interface AgentDefinitionLoadResponse {
  snapshotId: SnapshotId;
  files: ({ kind: "loaded"; path: string; name: string; definitionId: AgentDefinitionId; revisionId: AgentDefinitionRevisionId; reused: boolean; informational: string[] } | { kind: "rejected"; path: string; reasons: { field: string; reason: string }[] })[];
}

export interface AgentDefinitionResponse {
  definition: AgentDefinition;
  revisions: AgentDefinitionRevision[];
}

export interface ConversationResponse {
  conversation: Conversation;
  activeRun: Run | null;
  runs: number;
}

export interface MessagePostResponse {
  message: ConversationMessage;
  /** The Orchestrator input the message was queued as, when a Run was active. */
  queued: OrchestratorInput | null;
}

export interface RequirementView {
  requirement: Requirement;
  /** The Requirement's entry in the current revision, or `null` when it left the tree. */
  entry: RequirementTreeEntry | null;
  criteria: AcceptanceCriterion[];
  /** The most recent status changes, newest last (bounded). */
  history: RequirementStatusChange[];
  waiverDecisionId: DecisionId | null;
}

export interface RequirementsResponse {
  revision: RequirementRevision | null;
  requirements: RequirementView[];
}

export interface RequirementRevisionResponse {
  revision: RequirementRevision;
  criteria: AcceptanceCriterion[];
}

export interface RequirementProposalResolveResponse {
  kind: "approved" | "rejected";
  proposalId: RequirementProposalId;
  requirementRevisionId: RequirementRevisionId | null;
  edited: boolean;
  replayed: boolean;
}

/** One waiting condition of the Run, as the scheduler projects it. */
export interface RunWaitingCondition {
  planNodeId: PlanNodeId;
  reason: RunWaitReason;
  wakeAt: string | null;
}

/** The scheduler's read-only projection of the Run, reduced to what an operator acts on. */
export interface RunProjection {
  revisionNumber: number;
  stop: "quiescent" | "waiting" | "run_terminal";
  /** The kinds of the next canonical actions, in scheduling order. */
  nextActions: string[];
  waiting: RunWaitingCondition[];
  remediating: { planNodeId: PlanNodeId; gateId: GateId; taskId: TaskId }[];
  /** Nodes held back by the Run's concurrency limit. */
  limited: PlanNodeId[];
  inFlight: InvocationId[];
  wakeAt: string | null;
  concurrency: { active: number; max: number | null };
  nodes: { planNodeId: PlanNodeId; status: PlanNodeStatus; current: boolean; advice: string | null }[];
}

/** The operator-facing state of a Run: one closed phase beside the canonical status. */
export const RUN_PHASES = [
  "created",
  "running",
  "waiting_decision",
  "waiting_budget",
  "waiting_capacity",
  "waiting_conflict",
  "paused",
  "verifying",
  "awaiting_signoff",
  "completed_unpublished",
  "publishing",
  "publish_failed",
  "publish_unsupported",
  "published",
  "failed",
  "cancelled",
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

export interface RunOverview {
  run: Run;
  conversation: Conversation;
  workspace: Workspace;
  phase: RunPhase;
  capacity: RunCapacity;
  usage: UsageTotals;
  projection: RunProjection | null;
  /** Why the projection is unavailable (a contradictory row set), when it is. */
  projectionError: string | null;
  /** Decisions of the Run the operator can act on now. */
  openDecisions: Decision[];
  openProposal: RequirementProposal | null;
  completion: { request: CompletionRequest; gate: Gate | null } | null;
  signoff: { gateId: GateId; decisionId: DecisionId } | null;
  finalReportArtifactId: ArtifactId | null;
  publication: { supported: boolean; latest: Publication | null; openDecisionId: DecisionId | null };
  /** The Run's operator messages and Orchestrator inputs still queued for the next turn. */
  pendingInputs: number;
  /** The wall-clock deadline of the Run, when it has one. */
  deadlineAt: string | null;
}

export interface RunControlResponse {
  run: Run;
  outcome: Record<string, unknown>;
}

export interface PlanNodeSummary {
  node: PlanNode;
  invocations: { id: InvocationId; role: InvocationRole; purpose: string; status: string; attempts: number }[];
  tasks: number;
  gates: { id: GateId; kind: string; status: string }[];
  usage: UsageTotals;
  allocation: PlanNodeAllocationProjection | null;
}

export interface PlanResponse {
  revisionNumber: number;
  revisionCount: number;
  graph: PlanGraph;
  nodes: PlanNodeSummary[];
}

export interface PlanNodeResponse {
  node: PlanNode;
  invocations: Invocation[];
  tasks: Task[];
  gates: Gate[];
  evaluations: Evaluation[];
  usage: UsageTotals;
  allocation: PlanNodeAllocationProjection | null;
  extensions: AllocationExtension[];
}

export interface InvocationResponse {
  invocation: Invocation;
  /** The immutable manifest, with the worktree path withheld. */
  manifest: ContextManifest;
  attempts: Attempt[];
  runtimeToolCalls: RuntimeToolCall[];
  usage: UsageTotals;
  artifacts: Artifact[];
  definition: AgentDefinitionRevision;
}

export interface AttemptResponse {
  attempt: Attempt;
  usage: Usage[];
  runtimeToolCalls: RuntimeToolCall[];
  /** The transcript Artifact, when one was recorded (diagnostic only). */
  transcript: Artifact | null;
}

export interface TaskView {
  task: Task;
  dependencies: TaskId[];
  dependents: TaskId[];
  supersededBy: TaskId | null;
  /** The runtime's projected state for a Coordinator Task; `null` for other Tasks. */
  state: { kind: string; awaiting?: TaskId[]; blockReason?: TaskBlockReason } | null;
  outputs: Artifact[];
}

export interface TaskLedgerResponse {
  tasks: TaskView[];
  dependencies: TaskDependency[];
}

/** What a Decision needs from the operator, and through which operation. */
export const DECISION_ACTIONS = ["resolve", "supersede", "budget_increase", "signoff", "publish", "none"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export interface DecisionView {
  decision: Decision;
  action: DecisionAction;
}

export interface DecisionResolveResponse {
  kind: "resolved" | "superseded";
  decisionId: DecisionId;
  chosenOptionId: string | null;
  resolvedBy: DecisionResolver | null;
  supersedingDecisionId: DecisionId | null;
  replayed: boolean;
}

export interface BudgetResponse {
  runId: RunId;
  runStatus: RunStatus;
  capacity: RunCapacity;
  openDecision: { decisionId: DecisionId; partition: BudgetIncreasePartition; added: Allocation } | null;
  decisions: { decisionId: DecisionId; partition: BudgetIncreasePartition; added: Allocation; status: string; chosenOptionId: string | null; budgetIncreaseId: string | null }[];
  increases: BudgetIncrease[];
  extensions: AllocationExtension[];
  allowedActions: ("request_ordinary" | "request_final_reserve" | "resolve")[];
  /** The least final-reserve allocation the Run's completion needs, from the canonical rule. */
  requiredFinalAllocation: Allocation;
}

export interface BudgetIncreaseResolveResponse {
  kind: "approved" | "denied";
  decisionId: DecisionId;
  budgetIncreaseId: string | null;
  replayed: boolean;
}

export interface UsageResponse {
  run: UsageTotals;
  byPlanNode: { planNodeId: PlanNodeId; totals: UsageTotals }[];
  byInvocation: { invocationId: InvocationId; planNodeId: PlanNodeId; totals: UsageTotals }[];
}

export interface SignoffView {
  runId: RunId;
  runStatus: RunStatus;
  gate: { id: GateId; status: string };
  decision: { id: DecisionId; status: string; chosenOptionId: string | null };
  verifiedSnapshotId: SnapshotId;
  completionRequestId: string;
  completionGateId: GateId;
  report: { artifactId: ArtifactId; mediaType: string; byteSize: number; digest: string; title: string | null };
  requirementRevisionId: string;
  requirements: { requirementId: RequirementId; status: string; waiverDecisionId: DecisionId | null }[];
  waiverDecisionIds: DecisionId[];
  evaluationIds: EvaluationId[];
  usage: UsageTotals;
  candidate: { artifactId: ArtifactId; mediaType: string; byteSize: number; digest: string; title: string | null }[];
  resolution: SignoffResolution | { id: string; outcome: string; resolvedAt: string; operatorMessageId: ConversationMessageId | null; finalChangesetId: ChangesetId | null; followUpInvocationId: InvocationId | null } | null;
  finalSnapshotId: SnapshotId | null;
  finalChangesetId: ChangesetId | null;
  blockers: unknown[];
  allowedActions: string[];
}

export interface SignoffResponse {
  /** `null` while the Run has no signoff boundary yet. */
  signoff: SignoffView | null;
  resolutions: SignoffResolution[];
}

export interface SignoffResolveResponse {
  kind: string;
  replayed: boolean;
  run: Run;
}

export interface PublicationView {
  publication: Publication;
  /** The parsed terminal report, for a terminal Publication. */
  report: PublicationReport | null;
  evaluationIds: EvaluationId[];
}

export interface PublicationsResponse {
  runId: RunId;
  runStatus: RunStatus;
  target: RunTarget;
  capability: { supported: boolean; strategies: PublicationStrategy["kind"][]; reason: string | null };
  finalSnapshotId: SnapshotId | null;
  finalChangesetId: ChangesetId | null;
  openDecision: { decisionId: DecisionId; requestedStrategy: PublicationStrategyRequest } | null;
  publications: PublicationView[];
  allowedActions: ("request_publish" | "resolve_publish" | "advance_publication")[];
}

export interface PublicationRequestResponse {
  decision: Decision;
  replayed: boolean;
}

export interface PublicationResolveResponse {
  kind: "cancelled" | "publishing";
  decisionId: DecisionId;
  publicationId: PublicationId | null;
  replayed: boolean;
}

export interface PublicationAdvanceResponse {
  outcome: Record<string, unknown>;
  publication: Publication;
}

export interface ArtifactResponse {
  artifact: Artifact;
  /** How the content routes serve it: inline text for a text-like media type, otherwise download only. */
  presentation: "text" | "json" | "binary";
}

/** The event stream frames (SSE): journaled Events carry their sequence as the SSE id; transient output never does. */
export type EventStreamFrame =
  | { kind: "connected"; lastSeq: number }
  | { kind: "event"; event: Event }
  | { kind: "caught_up"; seq: number }
  | { kind: "output"; attemptId: AttemptId; runId: RunId; invocationId: InvocationId; chunk: { kind: "text" | "tool_call"; text: string } };

/** The response types of every route; a content route streams bytes and has none here. */
export interface ApiResponses {
  health: HealthResponse;
  config: ConfigResponse;
  capacity: CapacityResponse;
  fsRoots: FsRootsResponse;
  fsDirs: FsDirsResponse;
  listWorkspaces: Page<WorkspaceResponse>;
  createWorkspace: WorkspaceResponse;
  getWorkspace: WorkspaceResponse;
  updateWorkspace: WorkspaceResponse;
  listWorkspaceConversations: Page<ConversationResponse>;
  listWorkspaceRuns: Page<Run>;
  listWorkspaceAgentDefinitions: WorkspaceAgentDefinitionsResponse;
  loadWorkspaceAgentDefinitions: AgentDefinitionLoadResponse;
  getAgentDefinition: AgentDefinitionResponse;
  listAgentDefinitionRevisions: Page<AgentDefinitionRevision>;
  getAgentDefinitionRevision: AgentDefinitionRevision;
  listConversations: Page<ConversationResponse>;
  createConversation: ConversationResponse;
  getConversation: ConversationResponse;
  updateConversation: ConversationResponse;
  listConversationMessages: Page<ConversationMessage>;
  postConversationMessage: MessagePostResponse;
  listConversationRequirements: RequirementsResponse;
  createRequirementRevision: RequirementRevisionResponse;
  listConversationDecisions: Page<DecisionView>;
  listConversationRuns: Page<Run>;
  createRun: RunOverview;
  getRequirement: RequirementView;
  createAcceptanceCriterion: AcceptanceCriterion;
  getAcceptanceCriterion: AcceptanceCriterion;
  listRunRequirementProposals: Page<RequirementProposal>;
  getRequirementProposal: RequirementProposal;
  approveRequirementProposal: RequirementProposalResolveResponse;
  rejectRequirementProposal: RequirementProposalResolveResponse;
  getRun: RunOverview;
  startRun: RunOverview;
  cancelRun: RunControlResponse;
  pauseRun: RunControlResponse;
  resumeRun: RunControlResponse;
  getRunPlan: PlanResponse;
  listRunPlanRevisions: Page<ExecutionPlanRevision>;
  listRunInvocations: Page<Invocation>;
  listRunTasks: TaskLedgerResponse;
  listRunHandoffs: Page<Handoff>;
  listRunDecisions: Page<DecisionView>;
  getRunBudget: BudgetResponse;
  requestBudgetIncrease: { decision: Decision; replayed: boolean };
  resolveBudgetIncrease: BudgetIncreaseResolveResponse;
  listRunEvaluations: Page<Evaluation>;
  listRunGates: Page<Gate>;
  listRunSnapshots: Page<Snapshot>;
  listRunChangesets: Page<Changeset>;
  listRunArtifacts: Page<Artifact>;
  getRunUsage: UsageResponse;
  listRunCompletionRequests: Page<CompletionRequest>;
  listRunOrchestratorInputs: Page<OrchestratorInput>;
  getRunSignoff: SignoffResponse;
  acceptSignoff: SignoffResolveResponse;
  requestSignoffChanges: SignoffResolveResponse;
  getRunPublications: PublicationsResponse;
  requestPublication: PublicationRequestResponse;
  resolvePublication: PublicationResolveResponse;
  getPlanNode: PlanNodeResponse;
  getInvocation: InvocationResponse;
  listInvocationAttempts: Page<Attempt>;
  getAttempt: AttemptResponse;
  getTask: TaskView;
  getHandoff: Handoff;
  getDecision: DecisionView;
  resolveDecision: DecisionResolveResponse;
  supersedeDecision: DecisionResolveResponse;
  getEvaluation: Evaluation;
  getGate: Gate;
  getSnapshot: Snapshot;
  getChangeset: Changeset;
  getArtifact: ArtifactResponse;
  getPublication: PublicationView;
  advancePublication: PublicationAdvanceResponse;
}

/** Media types the content route serves inline as text (UTF-8); everything else is served through the download route only. */
export function artifactPresentationOf(mediaType: string): ArtifactResponse["presentation"] {
  const type = mediaType.split(";")[0]!.trim().toLowerCase();
  if (type.endsWith("+json") || type === "application/json") return "json";
  if (type.startsWith("text/") || type === "application/x-agent-transcript" || type === "application/x-ndjson") return "text";
  return "binary";
}

/** Type-level guard: every route has a response entry or is one of the byte-streaming routes. */
type ByteRoutes = "events" | "getArtifactContent" | "downloadArtifact" | "getAttemptTranscript";
type _ResponsesCoverEveryRoute = Exclude<ApiRouteName, ByteRoutes> extends keyof ApiResponses ? true : never;
const _responsesCoverEveryRoute: _ResponsesCoverEveryRoute = true;
void _responsesCoverEveryRoute;

// Re-exported for convenience of the web client: the ids the contract names.
export type ApiIds = {
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
  runId: RunId;
  planNodeId: PlanNodeId;
  invocationId: InvocationId;
  attemptId: AttemptId;
  taskId: TaskId;
  handoffId: HandoffId;
  decisionId: DecisionId;
  requirementId: RequirementId;
  acceptanceCriterionId: AcceptanceCriterionId;
  proposalId: RequirementProposalId;
  evaluationId: EvaluationId;
  gateId: GateId;
  snapshotId: SnapshotId;
  changesetId: ChangesetId;
  artifactId: ArtifactId;
  publicationId: PublicationId;
  agentDefinitionId: AgentDefinitionId;
  revisionId: AgentDefinitionRevisionId;
};

/** The closed inputs the contract re-uses from the domain, for the web client's convenience. */
export type ApiInputs = { acceptanceCheck: AcceptanceCheck; proposedRequirement: ProposedRequirement; budgetIncreaseOption: BudgetIncreaseOption; publishOption: PublishOption; operatorPauseMode: OperatorPauseMode };
export const API_REQUIREMENT_TREE_MAX_ENTRIES = REQUIREMENT_TREE_MAX_ENTRIES;
