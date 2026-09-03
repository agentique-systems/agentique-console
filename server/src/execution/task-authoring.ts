/**
 * The Orchestrator's Run-level Task authoring and the full `update_task`
 * (execution-model §5.5.1): the executable handlers behind `create_tasks`
 * and every `update_task` operation of every role.
 *
 * `create_tasks` mirrors a Coordinator's proposal form but the Tasks belong
 * to the Run: no owning node, no Task reservation (the operation that later
 * runs a Task is funded by its own node), origin `orchestrator`, pinned to
 * the Conversation's current Requirement revision. Requirement scope is that
 * revision's live leaves; dependencies and replacements name the Run's
 * current Tasks; a Coordinator's ledger is never replaced from here.
 *
 * `update_task` enforces, per operation: visibility (the Orchestrator sees
 * the Run's current Tasks, a Coordinator its node's, a Worker the Tasks
 * assigned to it; a superseded Task is history), ownership (a Coordinator's
 * cancellation keeps its existing rule; the Orchestrator cancels the Run's
 * own unstarted or blocked Tasks; a Worker cancels nothing), terminal
 * immutability, Evidence scope (the Run's Snapshots and Evaluations, the
 * caller's readable Artifacts; `command` Evidence is the runtime's alone),
 * and output provenance (a readable Artifact of the Run not already the
 * output of another Task). Repeated associations are deduplicated by the
 * store and write nothing. A Task never completes through this tool.
 */
import {
  NotFoundError,
  ROOT_SOURCE_PATH,
  runIsRunningOrDraining,
  runtimeToolHandlerBound,
  TASK_MACHINE,
  type ArtifactId,
  type CreateTasksInput,
  type Evidence,
  type ExecutableRuntimeTool,
  type Run,
  type Task,
  type TaskId,
  type TaskUpdateRequest,
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import { readableArtifactIds } from "./decision-requests.ts";
import { findCycle, reject, Rejected, TaskProposalService, type HandlerOutcome, type RuntimeToolCaller } from "./task-proposals.ts";

const CANCELLABLE_STATUSES: readonly Task["status"][] = ["pending", "ready", "blocked"];

export class TaskAuthoringService {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
    private readonly proposals: TaskProposalService,
  ) {}

  // ---------------------------------------------------------------------------
  // create_tasks
  // ---------------------------------------------------------------------------

  createTasks(caller: RuntimeToolCaller, input: CreateTasksInput, options: WriteOptions): HandlerOutcome {
    try {
      const { invocation, node } = caller;
      const run = this.admit("create_tasks", caller);
      if (invocation.role !== "orchestrator" || node.sourcePath !== ROOT_SOURCE_PATH) reject("caller_not_permitted", `Invocation ${invocation.id} is not the root Orchestrator; only the Orchestrator creates Run-level Tasks`);
      const revision = this.stores.requirements.currentRevision(run.conversationId);
      const leaves = new Set(revision === null ? [] : revision.tree.filter((entry) => !revision.tree.some((child) => child.parentId === entry.id)).map((entry) => entry.id));
      const current = this.stores.tasks.listByRun(run.id).filter((task) => this.stores.tasks.replacementOf(task.id) === null);
      const currentById = new Map(current.map((task) => [task.id, task] as const));
      const keys = new Set<string>();
      const replacedInBatch = new Set<TaskId>();
      input.tasks.forEach((proposal, index) => {
        const at = (field: string) => `tasks.${index}.${field}`;
        if (keys.has(proposal.key)) reject("duplicate_key", `proposal key ${proposal.key} appears twice in the batch`, at("key"));
        keys.add(proposal.key);
        for (const requirementId of proposal.requirementIds) {
          if (!leaves.has(requirementId)) reject("requirement_out_of_scope", `Requirement ${requirementId} is not a leaf of the Conversation's current Requirement revision`, at("requirementIds"));
          if (this.stores.requirements.get(requirementId).status === "retired") reject("requirement_retired", `Requirement ${requirementId} is retired`, at("requirementIds"));
        }
        for (const artifactId of proposal.inputArtifactIds) {
          let artifact;
          try {
            artifact = this.stores.artifacts.get(artifactId);
          } catch (error) {
            if (error instanceof NotFoundError) reject("unknown_artifact", `Artifact ${artifactId} does not exist`, at("inputArtifactIds"));
            throw error;
          }
          if (artifact.runId !== run.id) reject("foreign_artifact", `Artifact ${artifactId} belongs to Run ${artifact.runId}`, at("inputArtifactIds"));
        }
        for (const key of proposal.dependsOnKeys) {
          if (key === proposal.key) reject("dependency_cycle", `Task ${proposal.key} depends on itself`, at("dependsOnKeys"));
          if (!input.tasks.some((t) => t.key === key)) reject("unknown_dependency_key", `dependency key ${key} is not in the batch`, at("dependsOnKeys"));
        }
        for (const taskId of proposal.dependsOnTaskIds) {
          if (!currentById.has(taskId)) reject("foreign_dependency", `Task ${taskId} is not a current Task of Run ${run.id}`, at("dependsOnTaskIds"));
        }
        if (proposal.replacesTaskId !== null) {
          const replaced = currentById.get(proposal.replacesTaskId);
          if (!replaced) reject("invalid_replacement", `Task ${proposal.replacesTaskId} is not a current Task of Run ${run.id}`, at("replacesTaskId"));
          if (replaced.origin === "coordinator") reject("invalid_replacement", `Task ${replaced.id} belongs to a Coordinator's ledger; its Coordinator replaces it`, at("replacesTaskId"));
          if (replaced.status !== "blocked" && replaced.status !== "failed") reject("invalid_replacement", `Task ${replaced.id} is ${replaced.status}; only a blocked or failed Task can be replaced`, at("replacesTaskId"));
          if (replacedInBatch.has(replaced.id)) reject("invalid_replacement", `Task ${replaced.id} is replaced twice in the batch`, at("replacesTaskId"));
          replacedInBatch.add(replaced.id);
        }
      });
      // The resulting dependency graph — the Run's current edges, the batch's, and the edges dependents of replaced Tasks inherit — is acyclic.
      const edges: [string, string][] = this.stores.tasks
        .dependencies(run.id)
        .filter((d) => currentById.has(d.taskId) && currentById.has(d.dependsOnTaskId))
        .map((d) => [d.taskId, d.dependsOnTaskId]);
      const keyNode = (key: string) => `key:${key}`;
      const dependents = new Map<TaskId, TaskId[]>();
      for (const [from, to] of edges) {
        const list = dependents.get(to as TaskId) ?? [];
        list.push(from as TaskId);
        dependents.set(to as TaskId, list);
      }
      for (const proposal of input.tasks) {
        for (const key of proposal.dependsOnKeys) edges.push([keyNode(proposal.key), keyNode(key)]);
        for (const taskId of proposal.dependsOnTaskIds) edges.push([keyNode(proposal.key), taskId]);
        if (proposal.replacesTaskId !== null) {
          for (const dependent of dependents.get(proposal.replacesTaskId) ?? []) {
            if (!TASK_MACHINE.isTerminal(currentById.get(dependent)!.status)) edges.push([dependent, keyNode(proposal.key)]);
          }
        }
      }
      const cycle = findCycle(edges);
      if (cycle !== null) reject("dependency_cycle", `the proposed dependencies form a cycle through ${cycle.replace(/^key:/, "")}`, "tasks");

      // Application, inside the caller's transaction: replaced blocked Tasks end first, then every Task, then every edge.
      for (const proposal of input.tasks) {
        if (proposal.replacesTaskId === null) continue;
        const replaced = currentById.get(proposal.replacesTaskId)!;
        if (replaced.status === "blocked") this.proposals.cancelTask(replaced, options);
      }
      const created = new Map<string, Task>();
      for (const proposal of input.tasks) {
        const task = this.stores.tasks.create(
          {
            runId: run.id,
            planNodeId: null,
            origin: "orchestrator",
            subject: proposal.subject,
            requirementIds: proposal.requirementIds,
            requirementRevisionId: revision!.id,
            inputArtifactIds: proposal.inputArtifactIds,
            requiredOutputs: proposal.requiredOutputs,
            replacesTaskId: proposal.replacesTaskId,
          },
          options,
        );
        created.set(proposal.key, task);
      }
      for (const proposal of input.tasks) {
        const task = created.get(proposal.key)!;
        for (const key of proposal.dependsOnKeys) this.stores.tasks.addDependency(task.id, created.get(key)!.id, options);
        for (const taskId of proposal.dependsOnTaskIds) this.stores.tasks.addDependency(task.id, taskId, options);
        if (proposal.replacesTaskId !== null) {
          for (const dependent of dependents.get(proposal.replacesTaskId) ?? []) {
            const dependentTask = this.stores.tasks.get(dependent);
            if (!TASK_MACHINE.isTerminal(dependentTask.status)) this.stores.tasks.addDependency(dependentTask.id, task.id, options);
          }
        }
      }
      const taskIds = input.tasks.map((p) => created.get(p.key)!.id);
      return { kind: "applied", result: { tool: "create_tasks", taskIds, taskIdsByKey: Object.fromEntries(input.tasks.map((p) => [p.key, created.get(p.key)!.id])) } };
    } catch (error) {
      if (error instanceof Rejected) return { kind: "rejected", reasons: error.reasons };
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // update_task
  // ---------------------------------------------------------------------------

  updateTask(caller: RuntimeToolCaller, request: TaskUpdateRequest, options: WriteOptions): HandlerOutcome {
    try {
      const { invocation } = caller;
      const run = this.admit("update_task", caller);
      // A Coordinator's cancellation keeps its own rule (its node's unstarted or blocked current Tasks).
      if (invocation.role === "coordinator" && request.update.kind === "cancel") return this.proposals.cancel(caller, request, options);
      // A Worker never cancels a Task, whichever Task it names.
      if (request.update.kind === "cancel" && invocation.role !== "orchestrator") reject("caller_not_permitted", `a ${invocation.role} Invocation never cancels a Task`, "update");
      const task = this.visibleTask(caller, run, request.taskId);
      switch (request.update.kind) {
        case "cancel": {
          if (task.origin === "coordinator") reject("task_not_cancellable", `Task ${task.id} belongs to a Coordinator's ledger; its Coordinator cancels it`, "taskId");
          if (!CANCELLABLE_STATUSES.includes(task.status)) reject("task_not_cancellable", `Task ${task.id} is ${task.status}; only a pending, ready, or blocked Task can be cancelled`, "taskId");
          const cancelled = this.proposals.cancelTask(task, options);
          return { kind: "applied", result: { tool: "update_task", taskId: cancelled.id, status: cancelled.status } };
        }
        case "add_evidence": {
          if (TASK_MACHINE.isTerminal(task.status)) reject("task_terminal", `Task ${task.id} is ${task.status}; a terminal Task is immutable`, "taskId");
          const readable = readableArtifactIds(this.stores, invocation, this.stores.invocations.getManifest(invocation.id));
          request.update.evidence.forEach((evidence, i) => this.checkEvidence(run, evidence, readable, `update.evidence.${i}`));
          const updated = this.stores.tasks.recordEvidence(task.id, { evidence: request.update.evidence, outputArtifactIds: [] }, options);
          return { kind: "applied", result: { tool: "update_task", taskId: updated.id, status: updated.status } };
        }
        case "add_outputs": {
          if (TASK_MACHINE.isTerminal(task.status)) reject("task_terminal", `Task ${task.id} is ${task.status}; a terminal Task is immutable`, "taskId");
          const readable = readableArtifactIds(this.stores, invocation, this.stores.invocations.getManifest(invocation.id));
          const others = this.stores.tasks.listByRun(run.id).filter((t) => t.id !== task.id);
          request.update.artifactIds.forEach((artifactId, i) => {
            const path = `update.artifactIds.${i}`;
            const artifact = this.artifactOrNull(artifactId);
            if (artifact === null || artifact.runId !== run.id) reject("artifact_provenance_invalid", `Artifact ${artifactId} does not exist in Run ${run.id}`, path);
            if (!readable.has(artifactId)) reject("artifact_provenance_invalid", `Artifact ${artifactId} is not readable by Invocation ${invocation.id}`, path);
            if (artifact.taskId !== null && artifact.taskId !== task.id) reject("artifact_provenance_invalid", `Artifact ${artifactId} was produced for Task ${artifact.taskId}`, path);
            const owner = others.find((t) => t.outputArtifactIds.includes(artifactId));
            if (owner !== undefined) reject("artifact_provenance_invalid", `Artifact ${artifactId} is already an output of Task ${owner.id}`, path);
          });
          const updated = this.stores.tasks.recordEvidence(task.id, { evidence: [], outputArtifactIds: request.update.artifactIds }, options);
          return { kind: "applied", result: { tool: "update_task", taskId: updated.id, status: updated.status } };
        }
      }
    } catch (error) {
      if (error instanceof Rejected) return { kind: "rejected", reasons: error.reasons };
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Rules (read-only)
  // ---------------------------------------------------------------------------

  /** The caller re-validated from rows: bound to the handler, running, not Gate-owned, of a running node of a Run that admits execution. */
  private admit(tool: ExecutableRuntimeTool, caller: RuntimeToolCaller): Run {
    const { invocation, node } = caller;
    if (!runtimeToolHandlerBound(tool, invocation.role, invocation.purpose)) reject("caller_not_permitted", `a ${invocation.role} Invocation with purpose ${invocation.purpose} never calls ${tool}`);
    if (invocation.gateId !== null || invocation.role === "evaluator") reject("caller_not_permitted", `Invocation ${invocation.id} is Gate-owned; a Gate evaluation never authors Tasks`);
    if (invocation.status !== "running" || invocation.planNodeId !== node.id || invocation.runId !== node.runId) reject("caller_not_running", `Invocation ${invocation.id} is ${invocation.status} or does not belong to PlanNode ${node.id}`);
    const run = this.stores.runs.get(invocation.runId);
    if (!runIsRunningOrDraining(run)) reject("caller_not_permitted", `Run ${run.id} is ${run.status}${run.operatorPause === null ? "" : ` and paused (${run.operatorPause})`}; Tasks are authored in a running Run`);
    if (node.status !== "running") reject("caller_not_permitted", `PlanNode ${node.id} is ${node.status}; Tasks are authored from running executable work`);
    return run;
  }

  /** The Task the caller may see: of the Run, not superseded, and within the role's visibility. */
  private visibleTask(caller: RuntimeToolCaller, run: Run, taskId: TaskId): Task {
    const { invocation, node } = caller;
    let task: Task;
    try {
      task = this.stores.tasks.get(taskId);
    } catch (error) {
      if (error instanceof NotFoundError) reject("task_not_visible", `Task ${taskId} does not exist`, "taskId");
      throw error;
    }
    if (task.runId !== run.id) reject("task_not_visible", `Task ${taskId} belongs to another Run`, "taskId");
    if (this.stores.tasks.replacementOf(task.id) !== null) reject("task_not_visible", `Task ${taskId} is superseded by a replacement`, "taskId");
    switch (invocation.role) {
      case "orchestrator":
        return task;
      case "coordinator":
        if (task.planNodeId !== node.id) reject("task_not_visible", `Task ${taskId} does not belong to PlanNode ${node.id}`, "taskId");
        return task;
      case "worker":
        if (!invocation.taskIds.includes(task.id)) reject("task_not_visible", `Task ${taskId} is not assigned to Invocation ${invocation.id}`, "taskId");
        return task;
      case "evaluator":
        return reject("caller_not_permitted", "an Evaluator never updates a Task", "taskId");
    }
  }

  /** Evidence within the Run and the caller's scope; `command` Evidence is recorded by the runtime from a check it ran. */
  private checkEvidence(run: Run, evidence: Evidence, readable: Set<ArtifactId>, path: string): void {
    switch (evidence.kind) {
      case "artifact": {
        const artifact = this.artifactOrNull(evidence.artifactId);
        if (artifact === null || artifact.runId !== run.id) reject("evidence_out_of_scope", `Artifact ${evidence.artifactId} does not exist in Run ${run.id}`, path);
        if (!readable.has(evidence.artifactId)) reject("evidence_out_of_scope", `Artifact ${evidence.artifactId} is not readable by the caller`, path);
        return;
      }
      case "command":
        return reject("evidence_out_of_scope", "command Evidence is recorded by the runtime from a check it ran", path);
      case "evaluation": {
        let evaluation;
        try {
          evaluation = this.stores.evaluations.get(evidence.evaluationId);
        } catch (error) {
          if (error instanceof NotFoundError) reject("evidence_out_of_scope", `Evaluation ${evidence.evaluationId} does not exist`, path);
          throw error;
        }
        if (evaluation.runId !== run.id) reject("evidence_out_of_scope", `Evaluation ${evidence.evaluationId} belongs to another Run`, path);
        return;
      }
      case "file":
      case "snapshot": {
        let snapshot;
        try {
          snapshot = this.stores.snapshots.get(evidence.snapshotId);
        } catch (error) {
          if (error instanceof NotFoundError) reject("evidence_out_of_scope", `Snapshot ${evidence.snapshotId} does not exist`, path);
          throw error;
        }
        if (snapshot.workspaceId !== run.workspaceId || (snapshot.runId !== null && snapshot.runId !== run.id)) reject("evidence_out_of_scope", `Snapshot ${evidence.snapshotId} belongs to another Workspace or Run`, path);
        return;
      }
      case "url":
        return;
    }
  }

  private artifactOrNull(artifactId: ArtifactId) {
    try {
      return this.stores.artifacts.get(artifactId);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }
}
