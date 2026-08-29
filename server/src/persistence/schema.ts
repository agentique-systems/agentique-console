/**
 * The final SQLite schema. Column design mirrors the `@agentique-console/core`
 * types; closed value sets are enforced by CHECK constraints so that no
 * arbitrary string can be persisted for a status, kind, purpose, or policy.
 * JSON columns hold canonical JSON validated by the core schemas in the
 * store layer. Foreign keys encode ownership; the store layer additionally
 * validates that foreign ids belong to the correct Run or Conversation.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import {
  ACCEPTANCE_CRITERION_KINDS,
  ATTEMPT_FAILURE_CLASSES,
  ATTEMPT_KINDS,
  ATTEMPT_START_MODES,
  ATTEMPT_STATUSES,
  CHANGESET_INTEGRATION_STATUSES,
  CONVERSATION_MESSAGE_AUTHORS,
  COORDINATOR_PURPOSES,
  DECISION_KINDS,
  DECISION_RESOLVERS,
  DECISION_STATUSES,
  EVALUATOR_PURPOSES,
  FAN_IN_POLICIES,
  GATE_KINDS,
  GATE_STATUSES,
  HANDOFF_MAX_SUMMARY_LENGTH,
  HANDOFF_STATUSES,
  INVOCATION_FAILURE_REASONS,
  INVOCATION_PURPOSES,
  INVOCATION_ROLES,
  INVOCATION_STATUSES,
  INVOCATION_WAIT_REASONS,
  LEASE_STATUSES,
  MODEL_EFFORTS,
  ON_ALLOCATION_EXHAUSTED_POLICIES,
  ORCHESTRATOR_PURPOSES,
  PATTERNS,
  PLAN_EDGE_TYPES,
  PLAN_NODE_KINDS,
  PLAN_NODE_STATUSES,
  PLAN_NODE_WAIT_REASONS,
  PUBLICATION_OUTCOMES,
  REQUIREMENT_STATUSES,
  REQUIREMENT_STATUS_ACTORS,
  RESERVATION_CHILD_TYPES,
  RESERVATION_PARENT_TYPES,
  RESERVATION_RELEASE_REASONS,
  RESERVATION_STATUSES,
  RESOLUTION_POLICIES,
  RUN_KINDS,
  RUN_STATUSES,
  RUN_WAIT_REASONS,
  SNAPSHOT_REASONS,
  TASK_FAILURE_REASONS,
  TASK_ORIGINS,
  TASK_STATUSES,
  VERDICTS,
  WORKER_PURPOSES,
  WORKSPACE_KINDS,
  type ActivationCondition,
  type AgentCapabilities,
  type AgentDefaultLimits,
  type AgentDefinitionProvenance,
  type ArtifactProducer,
  type ContextManifestContent,
  type DecisionAffects,
  type DecisionOption,
  type DecisionRequester,
  type EvaluationProducer,
  type EvaluationSubject,
  type EventActor,
  type Evidence,
  type ExecutionPlanSource,
  type HandoffEndpoint,
  type InvocationResult,
  type LeasedResources,
  type ManifestTemplate,
  type ModelPolicy,
  type PatternBounds,
  type PlanNodeAgents,
  type PublicationStrategy,
  type RequirementTreeEntry,
  type RunFailure,
  type RunTarget,
  type TaskBlockReason,
  type ToolPolicy,
} from "@agentique-console/core";

/** Renders a closed value set as a SQL `IN (...)` list. */
function inList(values: readonly string[]) {
  return sql.raw(values.map((v) => `'${v}'`).join(", "));
}

const timestamp = (name: string) => text(name);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const schemaInfo = sqliteTable(
  "schema_info",
  {
    id: integer("id").primaryKey(),
    application: text("application").notNull(),
    schema: text("schema").notNull(),
    version: integer("version").notNull(),
  },
  (t) => [check("schema_info_single_row", sql`${t.id} = 1`)],
);

// ---------------------------------------------------------------------------
// Scope objects
// ---------------------------------------------------------------------------

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    rootPath: text("root_path").notNull().unique(),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [check("workspaces_kind", sql`${t.kind} IN (${inList(WORKSPACE_KINDS)})`)],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    title: text("title"),
    activeRunId: text("active_run_id").references((): AnySQLiteColumn => runs.id),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [index("conversations_workspace").on(t.workspaceId)],
);

export const conversationMessages = sqliteTable(
  "conversation_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    runId: text("run_id").references((): AnySQLiteColumn => runs.id),
    invocationId: text("invocation_id").references((): AnySQLiteColumn => invocations.id),
    author: text("author").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    index("conversation_messages_conversation").on(t.conversationId, t.createdAt),
    check("conversation_messages_author", sql`${t.author} IN (${inList(CONVERSATION_MESSAGE_AUTHORS)})`),
    check("conversation_messages_invocation", sql`${t.author} = 'orchestrator' OR ${t.invocationId} IS NULL`),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    waitReason: text("wait_reason"),
    target: text("target", { mode: "json" }).$type<RunTarget>().notNull(),
    maxCostUsd: real("max_cost_usd").notNull(),
    maxTokens: integer("max_tokens").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    maxWallClockMs: integer("max_wall_clock_ms"),
    maxConcurrency: integer("max_concurrency"),
    baseSnapshotId: text("base_snapshot_id").references((): AnySQLiteColumn => snapshots.id),
    integrationSnapshotId: text("integration_snapshot_id").references((): AnySQLiteColumn => snapshots.id),
    finalSnapshotId: text("final_snapshot_id").references((): AnySQLiteColumn => snapshots.id),
    integrationWorkspacePath: text("integration_workspace_path"),
    failure: text("failure", { mode: "json" }).$type<RunFailure>(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    endedAt: timestamp("ended_at"),
  },
  (t) => [
    index("runs_conversation").on(t.conversationId, t.createdAt),
    index("runs_status").on(t.status),
    check("runs_kind", sql`${t.kind} IN (${inList(RUN_KINDS)})`),
    check("runs_status", sql`${t.status} IN (${inList(RUN_STATUSES)})`),
    check("runs_wait_reason", sql`${t.waitReason} IS NULL OR ${t.waitReason} IN (${inList(RUN_WAIT_REASONS)})`),
    check("runs_waiting_has_reason", sql`(${t.status} = 'waiting') = (${t.waitReason} IS NOT NULL)`),
    check("runs_failed_has_failure", sql`(${t.status} = 'failed') = (${t.failure} IS NOT NULL)`),
    check(
      "runs_terminal_has_ended_at",
      sql`(${t.status} IN ('completed', 'failed', 'cancelled')) = (${t.endedAt} IS NOT NULL)`,
    ),
    check("runs_budget_non_negative", sql`${t.maxCostUsd} >= 0 AND ${t.maxTokens} >= 0 AND ${t.maxAttempts} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Execution Plan
// ---------------------------------------------------------------------------

export const executionPlanRevisions = sqliteTable(
  "execution_plan_revisions",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    number: integer("number").notNull(),
    source: text("source", { mode: "json" }).$type<ExecutionPlanSource>().notNull(),
    proposedByInvocationId: text("proposed_by_invocation_id").references((): AnySQLiteColumn => invocations.id),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.number] }),
    check("execution_plan_revisions_number", sql`${t.number} >= 1`),
  ],
);

export const planNodes = sqliteTable(
  "plan_nodes",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    revisionNumber: integer("revision_number").notNull(),
    kind: text("kind").notNull(),
    pattern: text("pattern"),
    title: text("title").notNull(),
    sourcePath: text("source_path").notNull(),
    status: text("status").notNull(),
    waitReason: text("wait_reason"),
    fanInPolicy: text("fan_in_policy"),
    input: text("input", { mode: "json" }).$type<ManifestTemplate>(),
    agents: text("agents", { mode: "json" }).$type<PlanNodeAgents>(),
    allocCostUsd: real("alloc_cost_usd").notNull(),
    allocTokens: integer("alloc_tokens").notNull(),
    allocAttempts: integer("alloc_attempts").notNull(),
    maxConcurrency: integer("max_concurrency"),
    maxWallClockMs: integer("max_wall_clock_ms"),
    bounds: text("bounds", { mode: "json" }).$type<PatternBounds>(),
    onAllocationExhausted: text("on_allocation_exhausted"),
    runOnDependencyFailure: integer("run_on_dependency_failure", { mode: "boolean" }).notNull(),
    gateAcceptanceCriterionIds: text("gate_acceptance_criterion_ids", { mode: "json" }).$type<string[]>(),
    outputArtifactIds: text("output_artifact_ids", { mode: "json" }).$type<string[]>(),
    createdAt: timestamp("created_at").notNull(),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
  },
  (t) => [
    index("plan_nodes_run_status").on(t.runId, t.status),
    index("plan_nodes_run_source_path").on(t.runId, t.sourcePath),
    check("plan_nodes_kind", sql`${t.kind} IN (${inList(PLAN_NODE_KINDS)})`),
    check("plan_nodes_status", sql`${t.status} IN (${inList(PLAN_NODE_STATUSES)})`),
    check("plan_nodes_pattern", sql`${t.pattern} IS NULL OR ${t.pattern} IN (${inList(PATTERNS)})`),
    check("plan_nodes_fan_in_policy", sql`${t.fanInPolicy} IS NULL OR ${t.fanInPolicy} IN (${inList(FAN_IN_POLICIES)})`),
    check(
      "plan_nodes_on_allocation_exhausted",
      sql`${t.onAllocationExhausted} IS NULL OR ${t.onAllocationExhausted} IN (${inList(ON_ALLOCATION_EXHAUSTED_POLICIES)})`,
    ),
    check("plan_nodes_wait_reason", sql`${t.waitReason} IS NULL OR ${t.waitReason} IN (${inList(PLAN_NODE_WAIT_REASONS)})`),
    check("plan_nodes_waiting_has_reason", sql`(${t.status} = 'waiting') = (${t.waitReason} IS NOT NULL)`),
    check(
      "plan_nodes_pattern_shape",
      sql`${t.kind} <> 'pattern' OR (${t.pattern} IS NOT NULL AND ${t.fanInPolicy} IS NULL AND ${t.agents} IS NOT NULL AND ${t.input} IS NOT NULL AND ${t.bounds} IS NOT NULL AND ${t.onAllocationExhausted} IS NOT NULL AND ${t.gateAcceptanceCriterionIds} IS NOT NULL)`,
    ),
    check(
      "plan_nodes_join_shape",
      sql`${t.kind} <> 'join' OR (${t.pattern} IS NULL AND ${t.fanInPolicy} IS NOT NULL AND ${t.agents} IS NULL AND ${t.input} IS NULL AND ${t.bounds} IS NULL AND ${t.onAllocationExhausted} IS NULL AND ${t.gateAcceptanceCriterionIds} IS NULL AND ${t.allocCostUsd} = 0 AND ${t.allocTokens} = 0 AND ${t.allocAttempts} = 0)`,
    ),
    check("plan_nodes_join_never_runs", sql`${t.kind} <> 'join' OR ${t.status} NOT IN ('running', 'waiting')`),
    check("plan_nodes_alloc_non_negative", sql`${t.allocCostUsd} >= 0 AND ${t.allocTokens} >= 0 AND ${t.allocAttempts} >= 0`),
    check(
      "plan_nodes_terminal_has_ended_at",
      sql`(${t.status} IN ('succeeded', 'failed', 'cancelled', 'skipped')) = (${t.endedAt} IS NOT NULL)`,
    ),
  ],
);

export const planEdges = sqliteTable(
  "plan_edges",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    sourceNodeId: text("source_node_id")
      .notNull()
      .references(() => planNodes.id),
    targetNodeId: text("target_node_id")
      .notNull()
      .references(() => planNodes.id),
    type: text("type").notNull(),
    label: text("label"),
    round: integer("round"),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    index("plan_edges_source").on(t.sourceNodeId),
    index("plan_edges_target").on(t.targetNodeId, t.position),
    // SQLite treats NULL label/round as distinct here; the store layer also
    // rejects a duplicate (source, target, type, label, round) edge.
    uniqueIndex("plan_edges_unique").on(t.sourceNodeId, t.targetNodeId, t.type, t.label, t.round),
    check("plan_edges_type", sql`${t.type} IN (${inList(PLAN_EDGE_TYPES)})`),
    check("plan_edges_no_self_loop", sql`${t.sourceNodeId} <> ${t.targetNodeId}`),
    check("plan_edges_branch_label", sql`(${t.type} = 'branch') = (${t.label} IS NOT NULL)`),
    check("plan_edges_retry_round", sql`(${t.type} = 'retry') = (${t.round} IS NOT NULL)`),
    check("plan_edges_round_min", sql`${t.round} IS NULL OR ${t.round} >= 2`),
    check("plan_edges_position", sql`${t.position} >= 0`),
  ],
);

export const planNodeRequirements = sqliteTable(
  "plan_node_requirements",
  {
    planNodeId: text("plan_node_id")
      .notNull()
      .references(() => planNodes.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    requirementId: text("requirement_id")
      .notNull()
      .references((): AnySQLiteColumn => requirements.id),
    requirementRevisionId: text("requirement_revision_id")
      .notNull()
      .references((): AnySQLiteColumn => requirementRevisions.id),
  },
  (t) => [
    primaryKey({ columns: [t.planNodeId, t.requirementId, t.requirementRevisionId] }),
    index("plan_node_requirements_requirement").on(t.requirementId, t.requirementRevisionId),
  ],
);

// ---------------------------------------------------------------------------
// Specification
// ---------------------------------------------------------------------------

export const requirementRevisions = sqliteTable(
  "requirement_revisions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    number: integer("number").notNull(),
    approvedByDecisionId: text("approved_by_decision_id").references((): AnySQLiteColumn => decisions.id),
    tree: text("tree", { mode: "json" }).$type<RequirementTreeEntry[]>().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("requirement_revisions_conversation_number").on(t.conversationId, t.number),
    check("requirement_revisions_number", sql`${t.number} >= 1`),
  ],
);

export const requirements = sqliteTable(
  "requirements",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    status: text("status").notNull(),
    createdInRevisionId: text("created_in_revision_id")
      .notNull()
      .references(() => requirementRevisions.id),
    retiredInRevisionId: text("retired_in_revision_id").references(() => requirementRevisions.id),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    index("requirements_conversation").on(t.conversationId, t.status),
    check("requirements_status", sql`${t.status} IN (${inList(REQUIREMENT_STATUSES)})`),
    check("requirements_retired_revision", sql`(${t.status} = 'retired') = (${t.retiredInRevisionId} IS NOT NULL)`),
  ],
);

export const requirementStatusChanges = sqliteTable(
  "requirement_status_changes",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    runId: text("run_id").references(() => runs.id),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    actor: text("actor").notNull(),
    evidence: text("evidence", { mode: "json" }).$type<Evidence[]>().notNull(),
    gateId: text("gate_id").references((): AnySQLiteColumn => gates.id),
    decisionId: text("decision_id").references((): AnySQLiteColumn => decisions.id),
    rationale: text("rationale"),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    index("requirement_status_changes_requirement").on(t.requirementId, t.seq),
    check("requirement_status_changes_from", sql`${t.fromStatus} IN (${inList(REQUIREMENT_STATUSES)})`),
    check("requirement_status_changes_to", sql`${t.toStatus} IN (${inList(REQUIREMENT_STATUSES)})`),
    check("requirement_status_changes_actor", sql`${t.actor} IN (${inList(REQUIREMENT_STATUS_ACTORS)})`),
    check("requirement_status_changes_waiver", sql`${t.toStatus} <> 'waived' OR (${t.decisionId} IS NOT NULL AND ${t.actor} = 'operator')`),
    check("requirement_status_changes_satisfied", sql`${t.toStatus} <> 'satisfied' OR (${t.gateId} IS NOT NULL AND ${t.actor} = 'runtime')`),
  ],
);

export const acceptanceCriteria = sqliteTable(
  "acceptance_criteria",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    requirementId: text("requirement_id").references(() => requirements.id),
    requirementRevisionId: text("requirement_revision_id").references(() => requirementRevisions.id),
    taskId: text("task_id").references((): AnySQLiteColumn => tasks.id),
    kind: text("kind").notNull(),
    check: text("check", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    index("acceptance_criteria_requirement").on(t.requirementId),
    index("acceptance_criteria_task").on(t.taskId),
    check("acceptance_criteria_kind", sql`${t.kind} IN (${inList(ACCEPTANCE_CRITERION_KINDS)})`),
    check("acceptance_criteria_owner", sql`(${t.requirementId} IS NOT NULL) <> (${t.taskId} IS NOT NULL)`),
    check("acceptance_criteria_revision", sql`(${t.requirementId} IS NOT NULL) = (${t.requirementRevisionId} IS NOT NULL)`),
  ],
);

export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    runId: text("run_id").references(() => runs.id),
    kind: text("kind").notNull(),
    resolutionPolicy: text("resolution_policy").notNull(),
    status: text("status").notNull(),
    requestedBy: text("requested_by", { mode: "json" }).$type<DecisionRequester>().notNull(),
    question: text("question").notNull(),
    options: text("options", { mode: "json" }).$type<DecisionOption[]>().notNull(),
    recommendedOptionId: text("recommended_option_id"),
    rationale: text("rationale"),
    affects: text("affects", { mode: "json" }).$type<DecisionAffects>().notNull(),
    deadlineAt: timestamp("deadline_at"),
    activationCondition: text("activation_condition", { mode: "json" }).$type<ActivationCondition>(),
    resolvedBy: text("resolved_by"),
    chosenOptionId: text("chosen_option_id"),
    resolutionRationale: text("resolution_rationale"),
    resolutionArtifactIds: text("resolution_artifact_ids", { mode: "json" }).$type<string[]>(),
    resolvedAt: timestamp("resolved_at"),
    supersedesDecisionId: text("supersedes_decision_id").references((): AnySQLiteColumn => decisions.id),
    supersededByDecisionId: text("superseded_by_decision_id").references((): AnySQLiteColumn => decisions.id),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    index("decisions_conversation_status").on(t.conversationId, t.status),
    index("decisions_run").on(t.runId),
    check("decisions_kind", sql`${t.kind} IN (${inList(DECISION_KINDS)})`),
    check("decisions_policy", sql`${t.resolutionPolicy} IN (${inList(RESOLUTION_POLICIES)})`),
    check("decisions_status", sql`${t.status} IN (${inList(DECISION_STATUSES)})`),
    check("decisions_resolver", sql`${t.resolvedBy} IS NULL OR ${t.resolvedBy} IN (${inList(DECISION_RESOLVERS)})`),
    check("decisions_waiver_operator_required", sql`${t.kind} <> 'requirement_waiver' OR ${t.resolutionPolicy} = 'operator_required'`),
    check(
      "decisions_operator_only_kinds",
      sql`${t.kind} NOT IN ('requirement_waiver', 'side_effect_approval', 'signoff', 'publish') OR ${t.resolvedBy} IS NULL OR ${t.resolvedBy} = 'operator'`,
    ),
    check(
      "decisions_default_policy_shape",
      sql`${t.resolutionPolicy} <> 'use_default_after_deadline' OR (${t.kind} = 'operator_choice' AND ${t.recommendedOptionId} IS NOT NULL AND ${t.rationale} IS NOT NULL AND (${t.deadlineAt} IS NOT NULL OR ${t.activationCondition} IS NOT NULL))`,
    ),
    check(
      "decisions_policy_resolver",
      sql`${t.resolvedBy} IS NULL OR ${t.resolvedBy} <> 'policy:use_default_after_deadline' OR (${t.resolutionPolicy} = 'use_default_after_deadline' AND ${t.chosenOptionId} = ${t.recommendedOptionId})`,
    ),
    check(
      "decisions_resolution_shape",
      sql`(${t.status} = 'open' AND ${t.resolvedBy} IS NULL AND ${t.chosenOptionId} IS NULL AND ${t.resolvedAt} IS NULL) OR (${t.status} = 'resolved' AND ${t.resolvedBy} IS NOT NULL AND ${t.chosenOptionId} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL) OR ${t.status} = 'superseded'`,
    ),
    check("decisions_superseded_by", sql`(${t.status} = 'superseded') = (${t.supersededByDecisionId} IS NOT NULL)`),
    check("decisions_no_self_supersede", sql`${t.supersedesDecisionId} IS NULL OR ${t.supersedesDecisionId} <> ${t.id}`),
  ],
);

// ---------------------------------------------------------------------------
// Work objects
// ---------------------------------------------------------------------------

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    planNodeId: text("plan_node_id").references(() => planNodes.id),
    invocationId: text("invocation_id").references((): AnySQLiteColumn => invocations.id),
    origin: text("origin").notNull(),
    subject: text("subject").notNull(),
    requirementIds: text("requirement_ids", { mode: "json" }).$type<string[]>().notNull(),
    requirementRevisionId: text("requirement_revision_id").references(() => requirementRevisions.id),
    inputArtifactIds: text("input_artifact_ids", { mode: "json" }).$type<string[]>().notNull(),
    requiredOutputs: text("required_outputs", { mode: "json" }).$type<string[]>().notNull(),
    outputArtifactIds: text("output_artifact_ids", { mode: "json" }).$type<string[]>().notNull(),
    evidence: text("evidence", { mode: "json" }).$type<Evidence[]>().notNull(),
    status: text("status").notNull(),
    blockReason: text("block_reason", { mode: "json" }).$type<TaskBlockReason>(),
    failureReason: text("failure_reason"),
    replacesTaskId: text("replaces_task_id").references((): AnySQLiteColumn => tasks.id),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    endedAt: timestamp("ended_at"),
  },
  (t) => [
    index("tasks_run_status").on(t.runId, t.status),
    index("tasks_plan_node").on(t.planNodeId, t.status),
    check("tasks_status", sql`${t.status} IN (${inList(TASK_STATUSES)})`),
    check("tasks_origin", sql`${t.origin} IN (${inList(TASK_ORIGINS)})`),
    check("tasks_failure_reason", sql`${t.failureReason} IS NULL OR ${t.failureReason} IN (${inList(TASK_FAILURE_REASONS)})`),
    check("tasks_blocked_has_reason", sql`(${t.status} = 'blocked') = (${t.blockReason} IS NOT NULL)`),
    check("tasks_failed_has_reason", sql`(${t.status} = 'failed') = (${t.failureReason} IS NOT NULL)`),
    check("tasks_terminal_has_ended_at", sql`(${t.status} IN ('completed', 'failed', 'cancelled')) = (${t.endedAt} IS NOT NULL)`),
    check(
      "tasks_coordinator_scope",
      sql`${t.origin} <> 'coordinator' OR (${t.planNodeId} IS NOT NULL AND ${t.requirementRevisionId} IS NOT NULL)`,
    ),
    check("tasks_no_self_replace", sql`${t.replacesTaskId} IS NULL OR ${t.replacesTaskId} <> ${t.id}`),
  ],
);

export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    dependsOnTaskId: text("depends_on_task_id")
      .notNull()
      .references(() => tasks.id),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
    index("task_dependencies_depends_on").on(t.dependsOnTaskId),
    check("task_dependencies_no_self", sql`${t.taskId} <> ${t.dependsOnTaskId}`),
  ],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    mediaType: text("media_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    digest: text("digest").notNull(),
    producer: text("producer", { mode: "json" }).$type<ArtifactProducer>().notNull(),
    invocationId: text("invocation_id").references((): AnySQLiteColumn => invocations.id),
    attemptId: text("attempt_id").references((): AnySQLiteColumn => attempts.id),
    taskId: text("task_id").references(() => tasks.id),
    title: text("title"),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    index("artifacts_run").on(t.runId, t.createdAt),
    index("artifacts_digest").on(t.digest),
    index("artifacts_invocation").on(t.invocationId),
    check("artifacts_byte_size", sql`${t.byteSize} >= 0`),
    check("artifacts_digest_shape", sql`length(${t.digest}) = 64`),
  ],
);

export const handoffs = sqliteTable(
  "handoffs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    source: text("source", { mode: "json" }).$type<HandoffEndpoint>().notNull(),
    target: text("target", { mode: "json" }).$type<HandoffEndpoint>().notNull(),
    taskIds: text("task_ids", { mode: "json" }).$type<string[]>().notNull(),
    artifactIds: text("artifact_ids", { mode: "json" }).$type<string[]>().notNull(),
    summary: text("summary").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at").notNull(),
    deliveredAt: timestamp("delivered_at"),
  },
  (t) => [
    index("handoffs_run").on(t.runId, t.createdAt),
    check("handoffs_status", sql`${t.status} IN (${inList(HANDOFF_STATUSES)})`),
    check("handoffs_summary_length", sql`length(${t.summary}) <= ${sql.raw(String(HANDOFF_MAX_SUMMARY_LENGTH))}`),
    check("handoffs_delivered_at", sql`(${t.status} = 'delivered') = (${t.deliveredAt} IS NOT NULL)`),
  ],
);

// ---------------------------------------------------------------------------
// Agent Definitions
// ---------------------------------------------------------------------------

export const agentDefinitions = sqliteTable("agent_definitions", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
});

export const agentDefinitionRevisions = sqliteTable(
  "agent_definition_revisions",
  {
    id: text("id").primaryKey(),
    definitionId: text("definition_id")
      .notNull()
      .references(() => agentDefinitions.id),
    contentHash: text("content_hash").notNull(),
    provenance: text("provenance", { mode: "json" }).$type<AgentDefinitionProvenance>().notNull(),
    modelPolicy: text("model_policy", { mode: "json" }).$type<ModelPolicy>().notNull(),
    instructions: text("instructions").notNull(),
    capabilities: text("capabilities", { mode: "json" }).$type<AgentCapabilities>().notNull(),
    toolPolicy: text("tool_policy", { mode: "json" }).$type<ToolPolicy>().notNull(),
    defaultLimits: text("default_limits", { mode: "json" }).$type<AgentDefaultLimits>().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("agent_definition_revisions_hash").on(t.definitionId, t.contentHash),
    check("agent_definition_revisions_hash_shape", sql`length(${t.contentHash}) = 64`),
  ],
);

// ---------------------------------------------------------------------------
// Invocations and Attempts
// ---------------------------------------------------------------------------

const rolePurposeCheck = sql`(${sql.raw("role")} = 'orchestrator' AND ${sql.raw("purpose")} IN (${inList(ORCHESTRATOR_PURPOSES)})) OR (${sql.raw("role")} = 'worker' AND ${sql.raw("purpose")} IN (${inList(WORKER_PURPOSES)})) OR (${sql.raw("role")} = 'evaluator' AND ${sql.raw("purpose")} IN (${inList(EVALUATOR_PURPOSES)})) OR (${sql.raw("role")} = 'coordinator' AND ${sql.raw("purpose")} IN (${inList(COORDINATOR_PURPOSES)}))`;

export const invocations = sqliteTable(
  "invocations",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    planNodeId: text("plan_node_id")
      .notNull()
      .references(() => planNodes.id),
    role: text("role").notNull(),
    purpose: text("purpose").notNull(),
    agentDefinitionRevisionId: text("agent_definition_revision_id")
      .notNull()
      .references(() => agentDefinitionRevisions.id),
    continuedFromInvocationId: text("continued_from_invocation_id").references((): AnySQLiteColumn => invocations.id),
    taskIds: text("task_ids", { mode: "json" }).$type<string[]>().notNull(),
    allocCostUsd: real("alloc_cost_usd").notNull(),
    allocTokens: integer("alloc_tokens").notNull(),
    allocAttempts: integer("alloc_attempts").notNull(),
    status: text("status").notNull(),
    waitReason: text("wait_reason"),
    failureReason: text("failure_reason"),
    result: text("result", { mode: "json" }).$type<InvocationResult>(),
    createdAt: timestamp("created_at").notNull(),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
  },
  (t) => [
    index("invocations_plan_node_status").on(t.planNodeId, t.status),
    index("invocations_run_status").on(t.runId, t.status),
    check("invocations_role", sql`${t.role} IN (${inList(INVOCATION_ROLES)})`),
    check("invocations_purpose", sql`${t.purpose} IN (${inList(INVOCATION_PURPOSES)})`),
    check("invocations_role_purpose", rolePurposeCheck),
    check("invocations_status", sql`${t.status} IN (${inList(INVOCATION_STATUSES)})`),
    check("invocations_wait_reason", sql`${t.waitReason} IS NULL OR ${t.waitReason} IN (${inList(INVOCATION_WAIT_REASONS)})`),
    check("invocations_failure_reason", sql`${t.failureReason} IS NULL OR ${t.failureReason} IN (${inList(INVOCATION_FAILURE_REASONS)})`),
    check("invocations_waiting_has_reason", sql`(${t.status} = 'waiting') = (${t.waitReason} IS NOT NULL)`),
    check("invocations_failed_has_reason", sql`(${t.status} = 'failed') = (${t.failureReason} IS NOT NULL)`),
    check("invocations_terminal_has_ended_at", sql`(${t.status} IN ('succeeded', 'failed', 'cancelled')) = (${t.endedAt} IS NOT NULL)`),
    check("invocations_alloc_attempts", sql`${t.allocAttempts} >= 1 AND ${t.allocCostUsd} >= 0 AND ${t.allocTokens} >= 0`),
    check("invocations_no_self_continue", sql`${t.continuedFromInvocationId} IS NULL OR ${t.continuedFromInvocationId} <> ${t.id}`),
  ],
);

export const attempts = sqliteTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    invocationId: text("invocation_id")
      .notNull()
      .references(() => invocations.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    planNodeId: text("plan_node_id")
      .notNull()
      .references(() => planNodes.id),
    number: integer("number").notNull(),
    kind: text("kind").notNull(),
    startMode: text("start_mode").notNull(),
    resumedFromAttemptId: text("resumed_from_attempt_id").references((): AnySQLiteColumn => attempts.id),
    status: text("status").notNull(),
    failureClass: text("failure_class"),
    transcriptArtifactId: text("transcript_artifact_id").references(() => artifacts.id),
    capacityLeaseId: text("capacity_lease_id").references((): AnySQLiteColumn => capacityLeases.id),
    result: text("result", { mode: "json" }).$type<InvocationResult>(),
    createdAt: timestamp("created_at").notNull(),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
  },
  (t) => [
    uniqueIndex("attempts_invocation_number").on(t.invocationId, t.number),
    index("attempts_run_status").on(t.runId, t.status),
    check("attempts_kind", sql`${t.kind} IN (${inList(ATTEMPT_KINDS)})`),
    check("attempts_start_mode", sql`${t.startMode} IN (${inList(ATTEMPT_START_MODES)})`),
    check("attempts_status", sql`${t.status} IN (${inList(ATTEMPT_STATUSES)})`),
    check("attempts_failure_class", sql`${t.failureClass} IS NULL OR ${t.failureClass} IN (${inList(ATTEMPT_FAILURE_CLASSES)})`),
    check("attempts_number", sql`${t.number} >= 1`),
    check("attempts_initial_is_first", sql`(${t.number} = 1) = (${t.kind} = 'initial')`),
    check("attempts_resumed_from", sql`(${t.startMode} = 'resumed') = (${t.resumedFromAttemptId} IS NOT NULL)`),
    check("attempts_no_self_resume", sql`${t.resumedFromAttemptId} IS NULL OR ${t.resumedFromAttemptId} <> ${t.id}`),
    check(
      "attempts_terminal_has_ended_at",
      sql`(${t.status} IN ('succeeded', 'failed', 'timed_out', 'interrupted', 'cancelled')) = (${t.endedAt} IS NOT NULL)`,
    ),
    check("attempts_succeeded_shape", sql`${t.status} <> 'succeeded' OR (${t.result} IS NOT NULL AND ${t.failureClass} IS NULL)`),
    check("attempts_failure_classified", sql`${t.status} NOT IN ('failed', 'timed_out', 'interrupted') OR ${t.failureClass} IS NOT NULL`),
  ],
);

/** Index only: the payload lives in the adapter-owned continuation payload store. */
export const providerContinuations = sqliteTable(
  "provider_continuations",
  {
    attemptId: text("attempt_id")
      .primaryKey()
      .references(() => attempts.id),
    provider: text("provider").notNull(),
    storageKey: text("storage_key").notNull(),
    digest: text("digest").notNull(),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at"),
  },
  (t) => [
    index("provider_continuations_expires").on(t.expiresAt),
    check("provider_continuations_digest_shape", sql`length(${t.digest}) = 64`),
  ],
);

export const contextManifests = sqliteTable(
  "context_manifests",
  {
    id: text("id").primaryKey(),
    invocationId: text("invocation_id")
      .notNull()
      .unique()
      .references(() => invocations.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    content: text("content", { mode: "json" }).$type<ContextManifestContent>().notNull(),
    digest: text("digest").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [check("context_manifests_digest_shape", sql`length(${t.digest}) = 64`)],
);

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export const evaluations = sqliteTable(
  "evaluations",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    planNodeId: text("plan_node_id").references(() => planNodes.id),
    gateId: text("gate_id").references((): AnySQLiteColumn => gates.id),
    subject: text("subject", { mode: "json" }).$type<EvaluationSubject>().notNull(),
    verdict: text("verdict").notNull(),
    evidence: text("evidence", { mode: "json" }).$type<Evidence[]>().notNull(),
    producedBy: text("produced_by", { mode: "json" }).$type<EvaluationProducer>().notNull(),
    artifactIds: text("artifact_ids", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    index("evaluations_run").on(t.runId, t.createdAt),
    index("evaluations_gate").on(t.gateId),
    check("evaluations_verdict", sql`${t.verdict} IN (${inList(VERDICTS)})`),
  ],
);

export const gates = sqliteTable(
  "gates",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    planNodeId: text("plan_node_id").references(() => planNodes.id),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    acceptanceCriterionIds: text("acceptance_criterion_ids", { mode: "json" }).$type<string[]>().notNull(),
    snapshotId: text("snapshot_id").references((): AnySQLiteColumn => snapshots.id),
    openedAt: timestamp("opened_at").notNull(),
    closedAt: timestamp("closed_at"),
  },
  (t) => [
    index("gates_run").on(t.runId, t.kind, t.status),
    check("gates_kind", sql`${t.kind} IN (${inList(GATE_KINDS)})`),
    check("gates_status", sql`${t.status} IN (${inList(GATE_STATUSES)})`),
    check("gates_node_exit_has_node", sql`(${t.kind} = 'node_exit') = (${t.planNodeId} IS NOT NULL)`),
    check("gates_closed_at", sql`(${t.status} = 'open') = (${t.closedAt} IS NULL)`),
  ],
);

// ---------------------------------------------------------------------------
// Workspace state
// ---------------------------------------------------------------------------

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    runId: text("run_id").references(() => runs.id),
    kind: text("kind").notNull(),
    commitId: text("commit_id"),
    treeId: text("tree_id"),
    contentDigest: text("content_digest"),
    reason: text("reason").notNull(),
    takenAt: timestamp("taken_at").notNull(),
  },
  (t) => [
    index("snapshots_run").on(t.runId, t.takenAt),
    check("snapshots_kind", sql`${t.kind} IN (${inList(WORKSPACE_KINDS)})`),
    check("snapshots_reason", sql`${t.reason} IN (${inList(SNAPSHOT_REASONS)})`),
    check(
      "snapshots_identity",
      sql`(${t.kind} = 'git' AND ${t.commitId} IS NOT NULL AND ${t.treeId} IS NOT NULL AND ${t.contentDigest} IS NULL) OR (${t.kind} = 'directory' AND ${t.contentDigest} IS NOT NULL AND ${t.commitId} IS NULL AND ${t.treeId} IS NULL)`,
    ),
  ],
);

export const changesets = sqliteTable(
  "changesets",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    invocationId: text("invocation_id").references(() => invocations.id),
    beforeSnapshotId: text("before_snapshot_id")
      .notNull()
      .references(() => snapshots.id),
    afterSnapshotId: text("after_snapshot_id")
      .notNull()
      .references(() => snapshots.id),
    diffArtifactId: text("diff_artifact_id")
      .notNull()
      .references(() => artifacts.id),
    integrationStatus: text("integration_status").notNull(),
    integratedSnapshotId: text("integrated_snapshot_id").references(() => snapshots.id),
    conflictTaskId: text("conflict_task_id").references(() => tasks.id),
    createdAt: timestamp("created_at").notNull(),
    integratedAt: timestamp("integrated_at"),
  },
  (t) => [
    index("changesets_run").on(t.runId, t.createdAt),
    check("changesets_status", sql`${t.integrationStatus} IN (${inList(CHANGESET_INTEGRATION_STATUSES)})`),
    check(
      "changesets_integrated_shape",
      sql`(${t.integrationStatus} = 'integrated') = (${t.integratedSnapshotId} IS NOT NULL AND ${t.integratedAt} IS NOT NULL)`,
    ),
    check("changesets_conflict_shape", sql`(${t.integrationStatus} = 'conflict') = (${t.conflictTaskId} IS NOT NULL)`),
  ],
);

export const publications = sqliteTable(
  "publications",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    decisionId: text("decision_id")
      .notNull()
      .references(() => decisions.id),
    changesetId: text("changeset_id")
      .notNull()
      .references(() => changesets.id),
    targetBeforeSnapshotId: text("target_before_snapshot_id")
      .notNull()
      .references(() => snapshots.id),
    targetAfterSnapshotId: text("target_after_snapshot_id").references(() => snapshots.id),
    strategy: text("strategy", { mode: "json" }).$type<PublicationStrategy>().notNull(),
    outcome: text("outcome").notNull(),
    failureReason: text("failure_reason"),
    artifactId: text("artifact_id").references(() => artifacts.id),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    index("publications_run").on(t.runId, t.createdAt),
    check("publications_outcome", sql`${t.outcome} IN (${inList(PUBLICATION_OUTCOMES)})`),
    check("publications_failure_reason", sql`(${t.outcome} = 'failed') = (${t.failureReason} IS NOT NULL)`),
    check("publications_after_snapshot", sql`(${t.outcome} = 'succeeded') = (${t.targetAfterSnapshotId} IS NOT NULL)`),
  ],
);

// ---------------------------------------------------------------------------
// Capacity, Budget, Usage
// ---------------------------------------------------------------------------

export const capacityLeases = sqliteTable(
  "capacity_leases",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    resources: text("resources", { mode: "json" }).$type<LeasedResources>().notNull(),
    status: text("status").notNull(),
    grantedAt: timestamp("granted_at").notNull(),
    releasedAt: timestamp("released_at"),
  },
  (t) => [
    index("capacity_leases_run_status").on(t.runId, t.status),
    uniqueIndex("capacity_leases_active_attempt")
      .on(t.attemptId)
      .where(sql`status = 'active'`),
    check("capacity_leases_status", sql`${t.status} IN (${inList(LEASE_STATUSES)})`),
    check("capacity_leases_released_at", sql`(${t.status} = 'released') = (${t.releasedAt} IS NOT NULL)`),
  ],
);

export const budgetReservations = sqliteTable(
  "budget_reservations",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    parentType: text("parent_type").notNull(),
    parentId: text("parent_id").notNull(),
    childType: text("child_type").notNull(),
    childId: text("child_id").notNull(),
    reservedCostUsd: real("reserved_cost_usd").notNull(),
    reservedTokens: integer("reserved_tokens").notNull(),
    reservedAttempts: integer("reserved_attempts").notNull(),
    consumedCostUsd: real("consumed_cost_usd"),
    consumedTokens: integer("consumed_tokens"),
    consumedAttempts: integer("consumed_attempts"),
    status: text("status").notNull(),
    transferredFromReservationId: text("transferred_from_reservation_id").references(
      (): AnySQLiteColumn => budgetReservations.id,
    ),
    createdAt: timestamp("created_at").notNull(),
    releasedAt: timestamp("released_at"),
    releaseReason: text("release_reason"),
  },
  (t) => [
    index("budget_reservations_parent").on(t.parentType, t.parentId, t.status),
    index("budget_reservations_child").on(t.childType, t.childId),
    uniqueIndex("budget_reservations_active_child")
      .on(t.childType, t.childId)
      .where(sql`status = 'active'`),
    check("budget_reservations_parent_type", sql`${t.parentType} IN (${inList(RESERVATION_PARENT_TYPES)})`),
    check("budget_reservations_child_type", sql`${t.childType} IN (${inList(RESERVATION_CHILD_TYPES)})`),
    check(
      "budget_reservations_pair",
      sql`(${t.parentType} = 'run' AND ${t.childType} = 'plan_node') OR (${t.parentType} = 'plan_node' AND ${t.childType} IN ('invocation', 'task'))`,
    ),
    check("budget_reservations_status", sql`${t.status} IN (${inList(RESERVATION_STATUSES)})`),
    check(
      "budget_reservations_release_reason",
      sql`${t.releaseReason} IS NULL OR ${t.releaseReason} IN (${inList(RESERVATION_RELEASE_REASONS)})`,
    ),
    check(
      "budget_reservations_release_shape",
      sql`(${t.status} = 'released') = (${t.releasedAt} IS NOT NULL AND ${t.releaseReason} IS NOT NULL AND ${t.consumedCostUsd} IS NOT NULL AND ${t.consumedTokens} IS NOT NULL AND ${t.consumedAttempts} IS NOT NULL)`,
    ),
    check(
      "budget_reservations_non_negative",
      sql`${t.reservedCostUsd} >= 0 AND ${t.reservedTokens} >= 0 AND ${t.reservedAttempts} >= 0`,
    ),
    check("budget_reservations_no_self_transfer", sql`${t.transferredFromReservationId} IS NULL OR ${t.transferredFromReservationId} <> ${t.id}`),
  ],
);

export const usage = sqliteTable(
  "usage",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    planNodeId: text("plan_node_id")
      .notNull()
      .references(() => planNodes.id),
    invocationId: text("invocation_id")
      .notNull()
      .references(() => invocations.id),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    model: text("model").notNull(),
    effort: text("effort"),
    inputTokensUncached: integer("input_tokens_uncached").notNull(),
    cacheCreationTokens: integer("cache_creation_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costUsd: real("cost_usd").notNull(),
    wallClockMs: integer("wall_clock_ms").notNull(),
    providerMs: integer("provider_ms"),
    recordedAt: timestamp("recorded_at").notNull(),
  },
  (t) => [
    index("usage_run").on(t.runId),
    index("usage_plan_node").on(t.planNodeId),
    index("usage_invocation").on(t.invocationId),
    index("usage_attempt").on(t.attemptId),
    check("usage_effort", sql`${t.effort} IS NULL OR ${t.effort} IN (${inList(MODEL_EFFORTS)})`),
    check(
      "usage_non_negative",
      sql`${t.inputTokensUncached} >= 0 AND ${t.cacheCreationTokens} >= 0 AND ${t.cacheReadTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.costUsd} >= 0 AND ${t.wallClockMs} >= 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * The append-only journal. Scope columns are indexed, not foreign keys, so
 * an Event can be appended before its projection row in the same
 * transaction and the journal never blocks a projection write.
 */
export const events = sqliteTable(
  "events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    workspaceId: text("workspace_id"),
    conversationId: text("conversation_id"),
    runId: text("run_id"),
    planNodeId: text("plan_node_id"),
    invocationId: text("invocation_id"),
    attemptId: text("attempt_id"),
    actor: text("actor", { mode: "json" }).$type<EventActor>().notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
    correlationId: text("correlation_id"),
    causationSeq: integer("causation_seq").references((): AnySQLiteColumn => events.seq),
  },
  (t) => [
    index("events_run").on(t.runId, t.seq),
    index("events_conversation").on(t.conversationId, t.seq),
    index("events_workspace").on(t.workspaceId, t.seq),
    index("events_type").on(t.type, t.seq),
    check(
      "events_scope",
      sql`${t.workspaceId} IS NOT NULL OR ${t.conversationId} IS NOT NULL OR ${t.runId} IS NOT NULL`,
    ),
  ],
);

export const TABLE_NAMES = [
  "schema_info",
  "workspaces",
  "conversations",
  "conversation_messages",
  "runs",
  "execution_plan_revisions",
  "plan_nodes",
  "plan_edges",
  "plan_node_requirements",
  "requirements",
  "requirement_revisions",
  "requirement_status_changes",
  "acceptance_criteria",
  "decisions",
  "tasks",
  "task_dependencies",
  "artifacts",
  "handoffs",
  "agent_definitions",
  "agent_definition_revisions",
  "invocations",
  "attempts",
  "provider_continuations",
  "context_manifests",
  "evaluations",
  "gates",
  "snapshots",
  "changesets",
  "publications",
  "capacity_leases",
  "budget_reservations",
  "usage",
  "events",
] as const;
