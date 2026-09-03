/**
 * The immutable input of one compilation: every fact the compiler needs,
 * resolved ahead of time by the plan-revision service, so that compilation
 * is a pure function of this value alone. The compiler never queries the
 * database, mints database ids, writes Events, reserves Budget, or mutates
 * persisted state.
 */
import type {
  AcceptanceCriterionId,
  AgentCapabilities,
  AgentDefaultLimits,
  AgentDefinitionProvenance,
  AgentDefinitionRevisionId,
  Allocation,
  ArtifactId,
  ConversationId,
  CoordinatorWorkerBounds,
  DecisionId,
  ExecutionPlanSource,
  PlanEdgeType,
  PlanLimits,
  PlanNodeDefinition,
  PlanRejectionReason,
  RequirementId,
  RequirementRevisionId,
  RequirementStatus,
  RequirementTreeEntry,
  RunId,
  TaskId,
  ToolPolicy,
} from "@agentique-console/core";

/**
 * What the compiler knows about an Agent Definition revision the source
 * names: immutable facts of a revision the plan-revision service has already
 * resolved as executable by the Run (provenance ownership checked). The
 * compiler validates role bindings against these facts and never queries
 * persistence.
 */
export interface CompileAgentDefinitionRevision {
  id: AgentDefinitionRevisionId;
  /** The logical definition's name; the default title of an operation bound to it. */
  definitionName: string;
  provenanceKind: AgentDefinitionProvenance["kind"];
  capabilities: AgentCapabilities;
  toolPolicy: ToolPolicy;
  defaultLimits: AgentDefaultLimits;
}

/** One pinned Requirement revision the source names, with the tree as of that revision. */
export interface CompileRequirementRevision {
  id: RequirementRevisionId;
  conversationId: ConversationId;
  tree: RequirementTreeEntry[];
}

/** A Requirement's stable identity and current status, for retirement checks. */
export interface CompileRequirement {
  id: RequirementId;
  conversationId: ConversationId;
  status: RequirementStatus;
}

/** The ids of this Run's (and its Conversation's) objects that operations may reference. */
export interface CompileReferences {
  taskIds: readonly TaskId[];
  decisionIds: readonly DecisionId[];
  artifactIds: readonly ArtifactId[];
  acceptanceCriterionIds: readonly AcceptanceCriterionId[];
}

/** The configured defaults an expression falls back to when it omits a value. */
export interface CompileDefaults {
  nodeAllocation: Allocation;
  coordinatorWorkerBounds: CoordinatorWorkerBounds;
}

export interface CompileInput {
  runId: RunId;
  conversationId: ConversationId;
  /** The candidate revision number; recorded for traceability, never used to mint ids. */
  revisionNumber: number;
  /** A source that already passed `validateExecutionPlanSource`. */
  source: ExecutionPlanSource;
  agentDefinitionRevisions: readonly CompileAgentDefinitionRevision[];
  requirementRevisions: readonly CompileRequirementRevision[];
  requirements: readonly CompileRequirement[];
  references: CompileReferences;
  defaults: CompileDefaults;
  limits: PlanLimits;
}

/** A compiled node keyed by its source path; ids are minted only at materialization. */
export interface CompiledDraftNode {
  key: string;
  definition: PlanNodeDefinition;
}

export interface CompiledDraftEdge {
  sourceKey: string;
  targetKey: string;
  type: PlanEdgeType;
  label?: string;
  round?: number;
  /** Fan-in order among edges into the same target, from 0. */
  position: number;
}

/**
 * The deterministic output of compilation: nodes in emission order (the
 * order of the source's expressions, depth first), edges in emission order.
 * For identical normalized input the draft is byte-for-byte identical.
 */
export interface CompiledDraft {
  nodes: CompiledDraftNode[];
  edges: CompiledDraftEdge[];
}

export type CompileResult = { accepted: true; draft: CompiledDraft } | { accepted: false; reasons: PlanRejectionReason[] };
