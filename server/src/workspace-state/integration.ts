/**
 * The integration Workspace port (execution-model §9.2; ports/
 * integration-workspace.ts): applies exactly the verified diff bytes of a
 * Changeset onto the Run's Integration Workspace with a three-way
 * `git apply --index`, commits the result, and records the Changeset id in
 * the commit trailer and in a Changeset-keyed integration ref. Idempotent by
 * Changeset id across a lost response, a restart before the database record,
 * and a repeated settlement: an existing ref (or a HEAD whose trailer names
 * the Changeset) answers `alreadyApplied` with the recorded identity, and
 * nothing is recomputed from the writer's commits. A conflict resets the
 * Integration Workspace to its current commit and leaves no partial
 * application; a workspace that drifted from the Snapshot the runtime
 * recorded is an infrastructure error, never a guess. Integration within one
 * Run is serialized by the integration service.
 */
import type { IntegrationApplyOutcome, IntegrationApplyRequest, IntegrationWorkspacePort } from "../execution/ports/integration-workspace.ts";
import { boundedStderr, git, text } from "./git.ts";
import { exists, WorkspaceStateError, type WorkspaceStateLayout } from "./paths.ts";
import { INTEGRATION_REF_PREFIX } from "./providers/git.ts";
import { commitOfIdentity, identityOfCommit } from "./snapshots.ts";

const TRAILER = "Agentique-Changeset";

export class WorkspaceIntegration implements IntegrationWorkspacePort {
  constructor(private readonly layout: WorkspaceStateLayout) {}

  async apply(request: IntegrationApplyRequest): Promise<IntegrationApplyOutcome> {
    const cwd = request.integrationWorkspacePath;
    if (cwd === null || !exists(cwd)) throw new WorkspaceStateError("workspace_missing", "the Run has no Integration Workspace");
    const kind = request.currentSnapshot.kind;
    const ref = `${INTEGRATION_REF_PREFIX}${request.runId}/${request.changesetId}`;
    // 1. A recorded integration of this Changeset answers first, whatever the workspace holds now.
    const recorded = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd, allowFailure: true });
    if (recorded.exitCode === 0) return { kind: "integrated", snapshot: await identityOfCommit(cwd, text(recorded), kind), alreadyApplied: true };
    // 2. A crash between the commit and the ref: HEAD's trailer names the Changeset.
    const head = text(await git(["rev-parse", "HEAD"], { cwd }));
    const trailer = text(await git(["log", "-1", "--format=%(trailers:key=Agentique-Changeset,valueonly)", head], { cwd, allowFailure: true }));
    if (trailer === request.changesetId) {
      await git(["update-ref", ref, head], { cwd });
      return { kind: "integrated", snapshot: await identityOfCommit(cwd, head, kind), alreadyApplied: true };
    }
    // 3. The workspace must hold exactly the Snapshot the runtime recorded; a leftover of a crashed apply is reset first.
    const current = await commitOfIdentity(cwd, request.currentSnapshot);
    if (head !== current) throw new WorkspaceStateError("drifted", `the Integration Workspace holds ${head}, not the recorded integration Snapshot ${current}`);
    await this.resetTo(cwd, current);
    const bytes = await request.changeset.diff.read();
    if (bytes.byteLength === 0) {
      // An empty Changeset integrates to the current state; the ref makes the repeat idempotent.
      await git(["update-ref", ref, current], { cwd });
      return { kind: "integrated", snapshot: await identityOfCommit(cwd, current, kind), alreadyApplied: false };
    }
    const applied = await git(["apply", "--3way", "--index", "--whitespace=nowarn"], { cwd, input: bytes, allowFailure: true, timeoutMs: 300_000 });
    if (applied.exitCode !== 0) {
      await this.resetTo(cwd, current);
      return { kind: "conflict", report: boundedStderr(applied.stderr === "" ? "the Changeset does not apply cleanly" : applied.stderr) };
    }
    const staged = await git(["diff", "--cached", "--quiet"], { cwd, allowFailure: true });
    if (staged.exitCode === 0) {
      await git(["update-ref", ref, current], { cwd });
      return { kind: "integrated", snapshot: await identityOfCommit(cwd, current, kind), alreadyApplied: false };
    }
    await git(["commit", "--quiet", "--no-verify", "-m", `Agentique Console: integrate Changeset ${request.changesetId}`, "-m", `${TRAILER}: ${request.changesetId}`], { cwd, identity: true });
    const next = text(await git(["rev-parse", "HEAD"], { cwd }));
    await git(["update-ref", ref, next], { cwd });
    return { kind: "integrated", snapshot: await identityOfCommit(cwd, next, kind), alreadyApplied: false };
  }

  /** The Integration Workspace is runtime-owned: whatever a crashed apply left behind is discarded back to the recorded commit. */
  private async resetTo(cwd: string, commit: string): Promise<void> {
    await git(["reset", "--hard", "--quiet", commit], { cwd, identity: true });
    await git(["clean", "-fdq"], { cwd });
  }
}
