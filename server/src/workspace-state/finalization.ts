/**
 * The Run finalization Workspace port (execution-model §9.3; ports/
 * run-finalization-workspace.ts): a read-only observation of the Run's
 * Integration Workspace — the Snapshot it holds now, whether its working
 * state is clean, and the exact base-to-verified diff bytes. It commits,
 * resets, repairs, and publishes nothing, and records no marker.
 */
import type { RunFinalizationOutcome, RunFinalizationRequest, RunFinalizationWorkspacePort } from "../execution/ports/run-finalization-workspace.ts";
import { boundedStderr, git, GitError, text } from "./git.ts";
import { exists, type WorkspaceStateLayout } from "./paths.ts";
import { commitOfIdentity, diffBetween, identityOfCommit, isClean } from "./snapshots.ts";

export class WorkspaceFinalization implements RunFinalizationWorkspacePort {
  constructor(private readonly layout: WorkspaceStateLayout) {}

  async inspect(request: RunFinalizationRequest): Promise<RunFinalizationOutcome> {
    const cwd = request.integrationWorkspacePath;
    if (cwd === null || !exists(cwd)) return { kind: "failed", failure: "workspace_unavailable", message: "the Run has no Integration Workspace to inspect" };
    let currentSnapshot;
    let clean: boolean;
    try {
      const head = text(await git(["rev-parse", "HEAD"], { cwd }));
      currentSnapshot = await identityOfCommit(cwd, head, request.baseSnapshot.kind, { record: false });
      clean = await isClean(cwd);
    } catch (error) {
      return { kind: "failed", failure: "snapshot_unreadable", message: messageOf(error) };
    }
    try {
      const base = await commitOfIdentity(cwd, request.baseSnapshot);
      const verified = await commitOfIdentity(cwd, request.verifiedSnapshot);
      return { kind: "inspected", currentSnapshot, diff: await diffBetween(cwd, base, verified), workspace: { clean } };
    } catch (error) {
      return { kind: "failed", failure: "diff_unavailable", message: messageOf(error) };
    }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof GitError) return boundedStderr(error.message, 500);
  return boundedStderr(error instanceof Error ? error.message : String(error), 500);
}
