/**
 * The Acceptance Criterion execution port: the final boundary between the
 * runtime's deterministic verification and the Workspace provider that runs
 * one deterministic Acceptance Criterion's command (execution-model §5.6,
 * §10; glossary Acceptance Criterion), for an `evaluator_optimizer` round
 * and for a `node_exit` Gate alike.
 *
 * Ownership rule: the execution runtime selects the criterion, the exact
 * Snapshot to verify, and the output bound, and records every outcome
 * canonically. The port receives exactly those facts and nothing else: no
 * store, database handle, Blob Store, Artifact lookup, transcript, provider
 * continuation state, or Target write access. An implementation imports no
 * persistence module.
 *
 * Isolation contract for implementations:
 *
 * - The command runs against a disposable, isolated view of exactly
 *   `workspace.snapshot`, derived from the Run's Integration Workspace and
 *   keyed by `workspace.isolationKey`; it never runs in the Integration
 *   Workspace, in an Invocation worktree, or in the Target. Whatever the
 *   command writes is discarded with the view; two executions never share a
 *   view. A stale view under the same key (a previous process died mid-run)
 *   is discarded before a fresh one is created.
 * - `output` holds at most `maxOutputBytes` bytes of the combined command
 *   output; when more was produced the port keeps a prefix and reports
 *   `truncated: true`, never silently.
 * - The port stops the command at `deadlineAt` or when `signal` aborts and
 *   reports an infrastructure failure; a command that could not be started,
 *   a view that could not be created, or output that could not be captured
 *   is likewise an infrastructure failure, never an exit code.
 *
 * The provider implementation arrives in the Workspace phase; tests use a
 * deterministic fake.
 */
import type { AcceptanceCriterionId, GateId, PlanNodeId, PublicationId, RunId, SnapshotIdentity, Timestamp } from "@agentique-console/core";

export interface AcceptanceCriterionExecutionRequest {
  runId: RunId;
  /** The Plan Node whose round or `node_exit` Gate the check belongs to; `null` for a Run-level `run_completion` Gate check and for a Publication check. */
  planNodeId: PlanNodeId | null;
  acceptanceCriterionId: AcceptanceCriterionId;
  /** The optimizer round the check belongs to; `null` for a Gate or Publication check. */
  round: number | null;
  /** The `node_exit` or `run_completion` Gate the check belongs to; `null` for an optimizer round's or Publication's check. */
  gateId: GateId | null;
  /** The Publication whose prepared candidate the check verifies; `null` otherwise. Exactly one of `round`, `gateId`, and `publicationId` is set. */
  publicationId: PublicationId | null;
  command: string;
  expectedExitCode: number;
  workspace: {
    /**
     * The workspace the isolated view is derived from — the Run's Integration Workspace for a round or Gate check,
     * the Publication's verification workspace for a Publication check; `null` for a Run without one. Never the Target.
     */
    integrationWorkspacePath: string | null;
    /** The exact Snapshot the command verifies; the view holds this state and nothing newer. */
    snapshot: SnapshotIdentity;
    /** A stable key for the isolated view (Run, node, round, Gate, or Publication, and criterion), so a stale view is discarded rather than reused. */
    isolationKey: string;
  };
  /** The most output bytes the runtime records; the port bounds what it returns and reports truncation. */
  maxOutputBytes: number;
  deadlineAt: Timestamp | null;
  signal: AbortSignal;
}

export const ACCEPTANCE_CRITERION_EXECUTION_FAILURES = ["start_failed", "timed_out", "aborted", "workspace_unavailable", "output_unavailable"] as const;
export type AcceptanceCriterionExecutionFailure = (typeof ACCEPTANCE_CRITERION_EXECUTION_FAILURES)[number];

export type AcceptanceCriterionExecutionOutcome =
  /** The command ran to an exit code; `output` is the captured bytes (a bounded prefix when `truncated`). */
  | { kind: "exited"; exitCode: number; output: Uint8Array; truncated: boolean }
  /** The check could not be carried out: not a verdict on the criterion, and never recorded as one. `message` is bounded and never output. */
  | { kind: "failed"; failure: AcceptanceCriterionExecutionFailure; message: string };

export interface AcceptanceCriterionExecutionPort {
  execute(request: AcceptanceCriterionExecutionRequest): Promise<AcceptanceCriterionExecutionOutcome>;
}
