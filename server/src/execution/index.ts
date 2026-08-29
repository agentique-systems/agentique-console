/**
 * The final provider-neutral execution boundary. Everything here depends
 * only on `@agentique-console/core`, the persistence boundary, and the
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
