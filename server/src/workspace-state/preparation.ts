/**
 * The Run Workspace preparation port (execution-model §9.1; ports/
 * workspace-preparation.ts): the base Snapshot of the Target and the Run's
 * Integration Workspace, created from it on a Run-owned branch, without
 * modifying the Target or the operator's checkout. Synchronous, because it
 * runs inside Run creation's transaction; `discard` removes exactly what
 * `prepare` created and tolerates a partial removal.
 */
import type { PreparedRunWorkspace, RunWorkspacePreparationPort, RunWorkspacePreparationRequest } from "../execution/ports/workspace-preparation.ts";
import { gitSync } from "./git.ts";
import { exists, integrationDir, removeOwned, runDir, WorkspaceStateError, type WorkspaceStateLayout } from "./paths.ts";
import { assertDirectoryRootSync, assertDirectoryTarget, importDirectorySync, shadowRepositoryOf } from "./providers/directory.ts";
import { assertRepositoryRootSync, branchCommitSync, branchRefOf, runBranchOf } from "./providers/git.ts";
import { identityOfCommitSync } from "./snapshots.ts";
import { addWorktreeSync, removeWorktreeSync } from "./worktrees.ts";

export class WorkspaceRunPreparation implements RunWorkspacePreparationPort {
  constructor(private readonly layout: WorkspaceStateLayout) {}

  prepare(request: RunWorkspacePreparationRequest): PreparedRunWorkspace {
    const { workspace, target, runId } = request;
    const integrationWorkspacePath = integrationDir(this.layout, workspace.id, runId);
    if (workspace.kind === "git") {
      assertRepositoryRootSync(workspace.rootPath);
      const ref = branchRefOf(target);
      const baseCommit = branchCommitSync(workspace.rootPath, ref);
      if (baseCommit === null) throw new WorkspaceStateError("target_mismatch", `the Target branch ${target.kind === "branch" ? target.branch : ""} does not exist`);
      addWorktreeSync(this.layout, { fromCwd: workspace.rootPath, worktreePath: integrationWorkspacePath, commit: baseCommit, branch: runBranchOf(runId) });
      return { baseSnapshot: identityOfCommitSync(workspace.rootPath, baseCommit, "git"), integrationWorkspacePath };
    }
    assertDirectoryTarget(target);
    assertDirectoryRootSync(workspace.rootPath);
    const imported = importDirectorySync(this.layout, workspace.id, workspace.rootPath, `Agentique Console: base Snapshot of Run ${runId}`);
    addWorktreeSync(this.layout, { fromCwd: shadowRepositoryOf(this.layout, workspace.id), worktreePath: integrationWorkspacePath, commit: imported.commit, branch: runBranchOf(runId) });
    return { baseSnapshot: imported.identity, integrationWorkspacePath };
  }

  discard(request: RunWorkspacePreparationRequest, prepared: PreparedRunWorkspace): void {
    const { workspace, runId } = request;
    const repository = workspace.kind === "git" ? workspace.rootPath : shadowRepositoryOf(this.layout, workspace.id);
    removeWorktreeSync(this.layout, repository, prepared.integrationWorkspacePath);
    if (exists(repository)) gitSync(["branch", "-D", runBranchOf(runId)], { cwd: repository, allowFailure: true });
    removeOwned(this.layout, runDir(this.layout, workspace.id, runId));
  }
}
