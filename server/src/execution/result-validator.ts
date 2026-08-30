/**
 * The authoritative Invocation result validator (execution-model §6.3):
 * more than shape. Every referenced id must exist and belong to this Run
 * (or Conversation); Task reports must be permitted for the role and
 * assigned where required; completed Tasks carry Evidence and their
 * required outputs; only the Orchestrator returns a `runOutcome`; a writing
 * Invocation has a Changeset record. A failure is a bounded, closed list of
 * violations for the failed Attempt; it mutates nothing.
 */
import {
  boundResultViolations,
  invocationResultSchema,
  NotFoundError,
  type ContextManifest,
  type Evidence,
  type Invocation,
  type InvocationResult,
  type ResultViolation,
  type Run,
  type TaskId,
} from "@agentique-console/core";
import type { Stores } from "../persistence/stores/index.ts";
import type { CollectedChangeset } from "./ports/execution-workspace.ts";

export interface ResultValidationContext {
  run: Run;
  invocation: Invocation;
  manifest: ContextManifest;
  /** True when the effective capability policy granted write capability. */
  writes: boolean;
  /** The Changeset the execution-workspace port collected for a writing Invocation; `null` when it produced none. */
  changeset: CollectedChangeset | null;
}

export type ResultValidation = { ok: true; result: InvocationResult } | { ok: false; violations: ResultViolation[] };

export class InvocationResultValidator {
  constructor(private readonly stores: Stores) {}

  validate(candidate: unknown, context: ResultValidationContext): ResultValidation {
    const parsed = invocationResultSchema.safeParse(candidate);
    if (!parsed.success) {
      const violations: ResultViolation[] =
        candidate === null || candidate === undefined
          ? [{ code: "malformed", message: "the Attempt ended without returning a result through return_result", path: null }]
          : parsed.error.issues.map((issue) => ({ code: "malformed", message: issue.message, path: issue.path.length > 0 ? issue.path.map(String).join(".") : null }));
      return { ok: false, violations: boundResultViolations(violations) };
    }
    const result = parsed.data;
    const violations: ResultViolation[] = [];
    const { run, invocation } = context;
    const add = (code: ResultViolation["code"], message: string, path: string | null = null) => violations.push({ code, message, path });

    result.artifactIds.forEach((id, index) => {
      const artifact = this.artifact(id);
      if (!artifact) add("unknown_artifact", `Artifact ${id} does not exist`, `artifactIds.${index}`);
      else if (artifact.runId !== run.id) add("foreign_artifact", `Artifact ${id} belongs to Run ${artifact.runId}`, `artifactIds.${index}`);
    });

    if (invocation.role === "evaluator" && result.tasks.length > 0) add("task_report_not_permitted", "an Evaluator cannot change Task state", "tasks");
    result.tasks.forEach((report, index) => {
      const path = `tasks.${index}`;
      let task;
      try {
        task = this.stores.tasks.get(report.taskId);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        add("unknown_task", `Task ${report.taskId} does not exist`, path);
        return;
      }
      if (task.runId !== run.id) {
        add("foreign_task", `Task ${report.taskId} belongs to Run ${task.runId}`, path);
        return;
      }
      const assigned = invocation.taskIds.includes(report.taskId);
      if (invocation.role === "worker" && !assigned) add("task_not_assigned", `Task ${report.taskId} is not assigned to this Invocation`, path);
      if (invocation.role === "coordinator" && task.planNodeId !== invocation.planNodeId) add("task_not_assigned", `Task ${report.taskId} belongs to another Plan Node`, path);
      if (report.status === "completed") {
        if (report.evidence.length === 0) add("task_without_evidence", `completed Task ${report.taskId} carries no Evidence`, `${path}.evidence`);
        const outputs = new Set<string>(task.outputArtifactIds);
        for (const id of result.artifactIds) {
          const artifact = this.artifact(id);
          if (artifact && artifact.taskId === task.id) outputs.add(id);
        }
        if (task.requiredOutputs.length > 0 && outputs.size < task.requiredOutputs.length) {
          add("task_missing_outputs", `completed Task ${report.taskId} requires ${task.requiredOutputs.length} output Artifact(s) but ${outputs.size} were produced`, `${path}.taskId`);
        }
      }
      report.evidence.forEach((evidence, i) => this.evidence(evidence, context, `${path}.evidence.${i}`, add));
    });
    // A completed Invocation reports every Task it owns, so ownership always ends in a canonical Task state.
    if (invocation.taskIds.length > 0 && result.status === "completed") {
      for (const taskId of invocation.taskIds as TaskId[]) {
        if (!result.tasks.some((t) => t.taskId === taskId)) add("status_incompatible", `a completed Invocation reports its owned Task ${taskId}`, "tasks");
      }
    }

    result.evidence.forEach((evidence, i) => this.evidence(evidence, context, `evidence.${i}`, add));

    if (result.runOutcome !== null) {
      if (invocation.role !== "orchestrator") add("run_outcome_not_permitted", "only the Orchestrator returns a runOutcome", "runOutcome");
      else {
        if (result.runOutcome.evidence.length === 0) add("run_outcome_without_evidence", "an infeasible Run outcome carries Evidence", "runOutcome.evidence");
        result.runOutcome.evidence.forEach((evidence, i) => this.evidence(evidence, context, `runOutcome.evidence.${i}`, add));
      }
    }

    if (invocation.role === "evaluator" && result.status === "blocked") add("status_incompatible", "an Evaluator cannot return blocked; it has no Decision channel", "status");

    if (context.writes && context.changeset === null) add("changeset_missing", "a writing Invocation records a Changeset, an explicitly empty one when nothing changed", null);

    return violations.length === 0 ? { ok: true, result } : { ok: false, violations: boundResultViolations(violations) };
  }

  private artifact(id: string) {
    try {
      return this.stores.artifacts.get(id as never);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  private evidence(evidence: Evidence, context: ResultValidationContext, path: string, add: (code: ResultViolation["code"], message: string, path: string | null) => void): void {
    const { run } = context;
    switch (evidence.kind) {
      case "artifact":
      case "command": {
        const id = evidence.kind === "artifact" ? evidence.artifactId : evidence.outputArtifactId;
        const artifact = this.artifact(id);
        if (!artifact) add("unknown_evidence_reference", `Evidence Artifact ${id} does not exist`, path);
        else if (artifact.runId !== run.id) add("foreign_evidence_reference", `Evidence Artifact ${id} belongs to Run ${artifact.runId}`, path);
        return;
      }
      case "evaluation": {
        try {
          const evaluation = this.stores.evaluations.get(evidence.evaluationId);
          if (evaluation.runId !== run.id) add("foreign_evidence_reference", `Evaluation ${evidence.evaluationId} belongs to Run ${evaluation.runId}`, path);
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
          add("unknown_evidence_reference", `Evaluation ${evidence.evaluationId} does not exist`, path);
        }
        return;
      }
      case "file":
      case "snapshot": {
        try {
          const snapshot = this.stores.snapshots.get(evidence.snapshotId);
          if (snapshot.workspaceId !== run.workspaceId) add("foreign_evidence_reference", `Snapshot ${evidence.snapshotId} belongs to another Workspace`, path);
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
          add("unknown_evidence_reference", `Snapshot ${evidence.snapshotId} does not exist`, path);
        }
        return;
      }
      case "url":
        return;
    }
  }
}
