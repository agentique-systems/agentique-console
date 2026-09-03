/**
 * The production Workspace providers (execution-model §9; glossary
 * "Workspace provider"): the six execution-runtime Workspace ports over real
 * git and plain-directory Workspaces, sharing the low-level git mechanics
 * while each port keeps its own authority. Nothing here imports persistence,
 * a database, or the Blob Store: every port receives identities, paths, and
 * content capabilities from the runtime and returns typed outcomes.
 */
import type { AcceptanceCriterionExecutionPort } from "../execution/ports/acceptance-criterion-execution.ts";
import type { ExecutionWorkspacePort } from "../execution/ports/execution-workspace.ts";
import type { IntegrationWorkspacePort } from "../execution/ports/integration-workspace.ts";
import type { PublicationWorkspacePort } from "../execution/ports/publication-workspace.ts";
import type { RunFinalizationWorkspacePort } from "../execution/ports/run-finalization-workspace.ts";
import type { RunWorkspacePreparationPort } from "../execution/ports/workspace-preparation.ts";
import { WorkspaceChecks } from "./checks.ts";
import { WorkspaceExecution } from "./execution.ts";
import { WorkspaceFinalization } from "./finalization.ts";
import { WorkspaceIntegration } from "./integration.ts";
import type { WorkspaceStateLayout } from "./paths.ts";
import { WorkspaceRunPreparation } from "./preparation.ts";
import { WorkspacePublication, type PublicationHooks } from "./publish.ts";

export { WORKSPACE_CAPABILITIES, supportsStrategy, type WorkspaceKindCapabilities } from "./capabilities.ts";
export { WorkspaceChecks, checkEnvironment } from "./checks.ts";
export { WorkspaceExecution } from "./execution.ts";
export { WorkspaceFinalization } from "./finalization.ts";
export { GitError, gitEnvironment } from "./git.ts";
export { WorkspaceIntegration } from "./integration.ts";
export { WorkspaceStateError, integrationDir, runDir, workspaceDir, type WorkspaceStateLayout } from "./paths.ts";
export { WorkspaceRunPreparation } from "./preparation.ts";
export { WorkspacePublication, selectStrategy, type PublicationHooks } from "./publish.ts";
export { identitiesEqual } from "./snapshots.ts";

export interface WorkspacePorts {
  preparation: RunWorkspacePreparationPort;
  execution: ExecutionWorkspacePort;
  integration: IntegrationWorkspacePort;
  checks: AcceptanceCriterionExecutionPort;
  finalization: RunFinalizationWorkspacePort;
  publication: PublicationWorkspacePort;
}

/** The six ports over one state root; `publicationHooks` are the test barriers of the publication port (production passes none). */
export function createWorkspacePorts(layout: WorkspaceStateLayout, options: { publicationHooks?: PublicationHooks } = {}): WorkspacePorts {
  return {
    preparation: new WorkspaceRunPreparation(layout),
    execution: new WorkspaceExecution(layout),
    integration: new WorkspaceIntegration(layout),
    checks: new WorkspaceChecks(layout),
    finalization: new WorkspaceFinalization(layout),
    publication: new WorkspacePublication(layout, options.publicationHooks ?? {}),
  };
}
