/**
 * The final provider-neutral execution boundary. Everything here depends
 * only on `@agentique-console/core`, the persistence boundary, the
 * provider-neutral adapter contract under `server/src/provider/`, and the
 * narrow ports declared under `ports/` for capabilities implemented in
 * later phases.
 */
export { compileExecutionPlan, collectSourceReferences, rawSourceRejections, PlanRejection } from "./compiler/compile.ts";
export type {
  CompileAgentDefinitionRevision,
  CompileDefaults,
  CompileInput,
  CompileReferences,
  CompileRequirement,
  CompileRequirementRevision,
  CompileResult,
  CompiledDraft,
  CompiledDraftEdge,
  CompiledDraftNode,
} from "./compiler/input.ts";
export { encodeLabel, decodeLabel, parseSourcePath, sourcePath } from "./compiler/source-path.ts";
export type { ParsedSourcePath, SourcePathSegment } from "./compiler/source-path.ts";
export { PlanRevisionService } from "./plan-revision-service.ts";
export type { PlanRevisionOutcome, PlanRevisionProposal, PlanRevisionServiceConfig } from "./plan-revision-service.ts";
export { DEFAULT_RUN_CREATION_POLICY, RunCreationService } from "./run-creation-service.ts";
export type { CreatedRun, RunCreationPolicy, RunCreationRequest } from "./run-creation-service.ts";
export type { PreparedRunWorkspace, RunWorkspacePreparationPort, RunWorkspacePreparationRequest } from "./ports/workspace-preparation.ts";
export type { CollectedChangeset, ExecutionWorkspacePort, ExecutionWorkspaceRequest, PreparedExecutionWorkspace } from "./ports/execution-workspace.ts";
export { ContextManifestAssembler } from "./manifest/assembler.ts";
export type { ManifestAssemblyRequest } from "./manifest/assembler.ts";
export { renderManifest } from "./manifest/renderer.ts";
export type { RetryAppendix } from "./manifest/renderer.ts";
export { InvocationPreparationService } from "./invocation-preparation-service.ts";
export type { InvocationFunding, InvocationPreparationConfig, InvocationPreparationRequest, PreparedInvocation, PreparedWorkspace } from "./invocation-preparation-service.ts";
export { ResourceGovernor } from "./governor.ts";
export type { GovernorConfig, GovernorStatus, LeaseOutcome, LeaseRequest, ProviderAvailability } from "./governor.ts";
export { InvocationResultValidator } from "./result-validator.ts";
export type { ResultValidation, ResultValidationContext } from "./result-validator.ts";
export { classifyAttempt, decideRetry, DEFAULT_RETRY_POLICY } from "./retry-policy.ts";
export type { ClassifiedAttempt, ClassificationInput, RetryDecisionInput, RetryPolicyConfig, RuntimeInterruption } from "./retry-policy.ts";
export { continuationCandidate, manifestContinuationContext } from "./continuation-policy.ts";
export type { ContinuationCandidate, ContinuationPolicyConfig } from "./continuation-policy.ts";
export { settleInvocation, invocationFailureReasonFor } from "./invocation-lifecycle.ts";
export type { Settlement, SettleInvocationInput } from "./invocation-lifecycle.ts";
export { AttemptExecutor, DEFAULT_EXECUTOR_CONFIG } from "./attempt-executor.ts";
export type { AdvanceOutcome, AttemptExecutorConfig, ExecutionOutcome, InvocationInspection, NotPermittedReason, PrepareOutcome } from "./attempt-executor.ts";
export { canonicalizeToolCall, ToolCallAuthorizer } from "./tool-call-authorization.ts";
export { RuntimeToolExecutor, logicalTurnInvocationIds } from "./runtime-tools.ts";
export type { RuntimeToolBinding } from "./runtime-tools.ts";
export { TaskProposalService } from "./task-proposals.ts";
export type { HandlerOutcome, RuntimeToolCaller } from "./task-proposals.ts";
export { projectTasks, projectNodeTasks } from "./task-projection.ts";
export type { CurrentTaskState, TaskProjection, TaskProjectionInput, TaskReadinessDecision } from "./task-projection.ts";
export type { CanonicalizedToolCall, ToolCallAuthorizationBinding } from "./tool-call-authorization.ts";
export { WorkspaceCleanup } from "./workspace-cleanup.ts";
export type { ExecutionDiagnostic, ExecutionDiagnosticSink, WorkspaceReleaseOutcome } from "./workspace-cleanup.ts";
export { RecoveryService } from "./recovery-service.ts";
export type { RecoveryConfig, RecoveryReport } from "./recovery-service.ts";
export { RunStartService } from "./run-start-service.ts";
export type { RunStartRequest, StartedRun } from "./run-start-service.ts";
export { evaluateReadiness, decideReadiness, edgeActivation, predecessorEdges, successorEdges, schedulingOrder, ReadinessFactError, SUPPORTED_EDGE_TYPES, SUPPORTED_PATTERNS } from "./readiness.ts";
export type { DeferralReason, EdgeActivation, ReadinessDecision, ReadinessEvaluation, ReadinessInput, RouteSelectionFact, SkipCause } from "./readiness.ts";
export { currentReadinessInput, projectReadinessInput } from "./readiness-facts.ts";
export type { AcceptanceCriterionExecutionFailure, AcceptanceCriterionExecutionOutcome, AcceptanceCriterionExecutionPort, AcceptanceCriterionExecutionRequest } from "./ports/acceptance-criterion-execution.ts";
export { ACCEPTANCE_CRITERION_EXECUTION_FAILURES } from "./ports/acceptance-criterion-execution.ts";
export { AcceptanceCheckService, COMMAND_OUTPUT_MEDIA_TYPE, DEFAULT_ACCEPTANCE_CHECK_CONFIG } from "./acceptance-checks.ts";
export type { AcceptanceCheckConfig, AcceptanceCheckOutcome, AcceptanceCheckRequest, RecordedAcceptanceCheck } from "./acceptance-checks.ts";
export { JoinNodeSettler } from "./join.ts";
export type { JoinOutcome } from "./join.ts";
export { HandoffRouter, boundedHandoffSummary } from "./handoff-routing.ts";
export type { EnsuredHandoff } from "./handoff-routing.ts";
export type { ArtifactContentSource, IntegrationApplyOutcome, IntegrationApplyRequest, IntegrationWorkspacePort } from "./ports/integration-workspace.ts";
export { ChangesetContentError, ChangesetIntegrationService, CONFLICT_REPORT_MAX_BYTES } from "./integration-service.ts";
export type { ChangesetContentFailure, IntegrationOutcome } from "./integration-service.ts";
export { ChainPatternRunner, CoordinatorWorkerPatternRunner, ParallelPatternRunner, PatternNodeSupport, RootNodeSupport, RoutePatternRunner, SinglePatternRunner, SequentialStepEngine, createPatternRunners, runnerFor } from "./patterns/index.ts";
export type { NodeAdvice, PatternRunner, PatternRunnerDependencies, PatternRunnerOutcome, PatternRunners, RootAdvice, RootOutcome } from "./patterns/index.ts";
export { RunScheduler, DEFAULT_SCHEDULER_CONFIG } from "./scheduler.ts";
export type { DeferredWork, NodeProjection, PerformedAction, SchedulerAction, SchedulerConfig, SchedulerOutcome, SchedulerProjection, SchedulerStopReason, WaitingCondition } from "./scheduler.ts";
