/**
 * Crash-safe Execution Workspace cleanup (execution-model §9.1). The
 * unavoidable ordering of a destructive external side effect against
 * canonical state is: (1) terminal Invocation settlement commits; (2) the
 * port releases the worktree outside any transaction; (3) the obligation
 * is recorded `released` in its own transaction. A crash or failure after
 * (1) leaves the obligation `pending` on a terminal Invocation, which is
 * exactly what restart recovery scans for and retries; because the port's
 * release is idempotent, a crash after (2) but before (3) is closed by the
 * same retry. A release failure never touches the canonical Attempt or
 * Invocation outcome: it is reported through a bounded diagnostic and left
 * for the next reconciliation.
 */
import { boundedFailureMessage, INVOCATION_MACHINE, grantsWriteCapability, type Invocation, type InvocationId } from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import type { ExecutionWorkspacePort, ExecutionWorkspaceRequest, PreparedExecutionWorkspace } from "./ports/execution-workspace.ts";

/** A bounded, non-sensitive operational report from the execution boundary; never a prompt, payload, path secret, or stack trace. */
export type ExecutionDiagnostic = { kind: "workspace_release_failed"; invocationId: InvocationId; message: string };

export type ExecutionDiagnosticSink = (diagnostic: ExecutionDiagnostic) => void;

export type WorkspaceReleaseOutcome = "released" | "already_released" | "not_due" | "failed";

export class WorkspaceCleanup {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
    private readonly port: ExecutionWorkspacePort,
    private readonly diagnostics: ExecutionDiagnosticSink,
  ) {}

  /** Reconstructs the port's request and prepared facts from the manifest, never from memory. */
  workspaceOf(invocation: Invocation): { request: ExecutionWorkspaceRequest; prepared: PreparedExecutionWorkspace } {
    const manifest = this.stores.invocations.getManifest(invocation.id);
    const run = this.stores.runs.get(invocation.runId);
    const writes = grantsWriteCapability(manifest.content);
    const startingSnapshot = writes && manifest.content.startingSnapshotId !== null ? this.stores.snapshots.get(manifest.content.startingSnapshotId).identity : null;
    return {
      request: { runId: run.id, invocationId: invocation.id, role: invocation.role, writes, integrationWorkspacePath: run.integrationWorkspacePath },
      prepared: { worktreePath: manifest.content.worktreePath, startingSnapshot },
    };
  }

  /**
   * Releases one Invocation's worktree when the obligation is due (terminal
   * and `pending`): external release first, then the `released` record. Never
   * runs inside a transaction; never throws for a release failure.
   */
  release(invocationId: InvocationId, options: WriteOptions = {}): WorkspaceReleaseOutcome {
    if (this.ctx.tx.inTransaction) throw new Error("Workspace release is an external side effect and never runs inside a transaction");
    const invocation = this.stores.invocations.get(invocationId);
    if (invocation.workspaceCleanup === "released") return "already_released";
    if (invocation.workspaceCleanup !== "pending" || !INVOCATION_MACHINE.isTerminal(invocation.status)) return "not_due";
    const workspace = this.workspaceOf(invocation);
    try {
      this.port.release(workspace.request, workspace.prepared);
    } catch (error) {
      this.diagnostics({ kind: "workspace_release_failed", invocationId, message: boundedFailureMessage(error instanceof Error ? error.message : String(error)) });
      return "failed";
    }
    this.stores.invocations.recordWorkspaceReleased(invocationId, options);
    return "released";
  }

  /** Retries every outstanding obligation (restart reconciliation); repeated runs are harmless. */
  releaseOutstanding(options: WriteOptions = {}): { releasedInvocationIds: InvocationId[]; failedInvocationIds: InvocationId[] } {
    const releasedInvocationIds: InvocationId[] = [];
    const failedInvocationIds: InvocationId[] = [];
    for (const invocation of this.stores.invocations.listPendingWorkspaceCleanup()) {
      const outcome = this.release(invocation.id, options);
      if (outcome === "released") releasedInvocationIds.push(invocation.id);
      else if (outcome === "failed") failedInvocationIds.push(invocation.id);
    }
    return { releasedInvocationIds, failedInvocationIds };
  }
}
