/**
 * The deterministic Context Manifest renderer (execution-model §6.2): a
 * pure projection from one persisted manifest (plus, for a retry, a bounded
 * appendix) to the bytes the provider receives. Byte-for-byte deterministic
 * for the same manifest: no clock, no database query, no path ordering, no
 * environment. The manifest is the record; this text is regenerable.
 *
 * Renderer format version 1, field order:
 *
 *   header      manifest id and digest, invocation, run, plan node, position,
 *               predecessor invocation, agent definition, model, allocation,
 *               limits, snapshot, worktree
 *   Instructions   the Agent Definition instructions verbatim
 *   Inputs         the queued logical inputs, in queue order
 *   Tasks          by id
 *   Requirements   in scope order, with the pinned revision
 *   Acceptance Criteria   by id
 *   Decisions      by id
 *   Handoffs       by id
 *   Artifacts      by id, bounded metadata only (content is read by tool)
 *   Capabilities   tools and MCP servers
 *   Tool Policy    every declared tool with its effective disposition
 *   Runtime Tools  the role's runtime tools
 *   Approved Calls the approval grants (calls the operator approved once, by tool, digest, Decision;
 *                  whether each is still claimable is decided by the canonical approval use)
 *   Retry          (only for a retry) prior Attempt, failure class, bounded
 *                  detail, exact violations, ordinal and remaining Attempts
 *
 * Every collection is rendered in the manifest's canonical order; a collection
 * that is empty renders as `none`. Lines end with `\n`.
 */
import {
  MANIFEST_RENDERER_VERSION,
  type CompletionCondition,
  renderPatternPosition,
  type AttemptFailureClass,
  type AttemptFailureDetail,
  type AttemptId,
  type ContextManifest,
  type Evidence,
  type ManifestInput,
} from "@agentique-console/core";
import { sha256Hex } from "../../persistence/blob-store.ts";
import type { RenderedInput } from "../../provider/adapter.ts";

/** What a retry Attempt receives in addition to the unchanged manifest (execution-model §7.2). */
export interface RetryAppendix {
  priorAttemptId: AttemptId;
  /** The ordinal of the Attempt being rendered, from 1. */
  attemptNumber: number;
  /** The Invocation's Attempt allocation. */
  maxAttempts: number;
  failureClass: AttemptFailureClass;
  detail: AttemptFailureDetail;
}

const NONE = "none";

function line(label: string, value: string | number | null): string {
  return `${label}: ${value === null ? NONE : String(value)}`;
}

function list(values: readonly string[]): string {
  return values.length === 0 ? NONE : values.join(", ");
}

/** Multi-line text is rendered inside a fence so its bytes stay verbatim and unambiguous. */
function fenced(text: string): string[] {
  return ["```", ...text.split("\n"), "```"];
}

function renderInput(input: ManifestInput): string[] {
  switch (input.kind) {
    case "operator_message":
      return [`- operator_message ${input.conversationMessageId}`, ...fenced(input.content)];
    case "node_result":
      return [`- node_result ${input.planNodeId} status ${input.status} output_artifacts ${list(input.outputArtifactIds)}`];
    case "decision_resolution":
      return [`- decision_resolution ${input.decisionId}`];
    case "side_effect_approval_resolution":
      return [`- side_effect_approval_resolution ${input.decisionId} ${input.outcome}: ${input.tool} call ${input.callDigest} (artifact ${input.callArtifactId}) from invocation ${input.blockedInvocationId} attempt ${input.attemptId}`];
    case "gate_result":
      return [
        `- gate_result ${input.gateId} ${input.gateKind} cycle ${input.ordinal} ${input.passed ? "passed" : "failed"} plan_node ${input.planNodeId ?? NONE} snapshot ${input.snapshotId ?? NONE} artifacts ${list(input.artifactIds)} failed_criteria ${list(input.failedAcceptanceCriterionIds)} evaluations ${list(input.evaluationIds)} remediation_task ${input.remediationTaskId ?? NONE}`,
      ];
    case "gate_candidate":
      return [
        `- gate_candidate ${input.gateId} ${input.gateKind} snapshot ${input.snapshotId} artifacts ${list(input.artifactIds)} evaluated_criteria ${list(input.acceptanceCriterionIds)}${input.completionRequestId === null ? "" : ` completion_request ${input.completionRequestId} requirement_revision ${input.requirementRevisionId ?? NONE}`}`,
        ...(input.gateKind !== "run_completion" ? [] : input.tasks.length === 0 ? ["  tasks: none"] : input.tasks.map((t) => `  - ${t.taskId} [${t.status}]${t.replacesTaskId === null ? "" : ` replaces ${t.replacesTaskId}`}${t.supersededByTaskId === null ? "" : ` superseded_by ${t.supersededByTaskId}`} outputs ${list(t.outputArtifactIds)}: ${t.subject}`)),
      ];
    case "final_synthesis":
      return [
        `- final_synthesis completion_request ${input.completionRequestId} gate ${input.gateId} snapshot ${input.snapshotId} requirement_revision ${input.requirementRevisionId} artifacts ${list(input.artifactIds)}`,
        `  usage cost_usd ${input.usage.costUsd} tokens ${input.usage.tokens} attempts ${input.usage.attempts}; final_reserve limit cost_usd ${input.finalReserve.limit.costUsd} tokens ${input.finalReserve.limit.tokens} attempts ${input.finalReserve.limit.attempts} consumed cost_usd ${input.finalReserve.consumed.costUsd} tokens ${input.finalReserve.consumed.tokens} attempts ${input.finalReserve.consumed.attempts}`,
        ...(input.requirements.length === 0 ? ["  requirements: none"] : input.requirements.map((r) => `  - requirement ${r.requirementId} [${r.status}]${r.waiverDecisionId === null ? "" : ` waived_by ${r.waiverDecisionId}`}`)),
        ...(input.evaluations.length === 0 ? ["  evaluations: none"] : input.evaluations.map((e) => `  - evaluation ${e.evaluationId} criterion ${e.acceptanceCriterionId} ${e.verdict} by ${e.producedBy}${e.evidence.length === 0 ? "" : `: ${e.evidence.map(renderEvidence).join("; ")}`}`)),
        ...(input.tasks.length === 0 ? ["  tasks: none"] : input.tasks.map((t) => `  - task ${t.taskId} [${t.status}]${t.replacesTaskId === null ? "" : ` replaces ${t.replacesTaskId}`}${t.supersededByTaskId === null ? "" : ` superseded_by ${t.supersededByTaskId}`} outputs ${list(t.outputArtifactIds)}: ${t.subject}`)),
        ...(input.unresolved.length === 0 ? ["  unresolved: none"] : input.unresolved.map((c) => `  - unresolved ${renderCondition(c)}`)),
      ];
    case "signoff_resolution":
      return [`- signoff_resolution ${input.signoffResolutionId} ${input.outcome} gate ${input.gateId} decision ${input.decisionId} completion_gate ${input.completionGateId} verified_snapshot ${input.verifiedSnapshotId} report ${input.reportArtifactId} operator_message ${input.operatorMessageId}`];
    case "plan_revision":
      return [
        `- plan_revision ${input.accepted ? `accepted revision ${input.revisionNumber ?? NONE}` : "rejected"}`,
        ...input.reasons.map((r) => `  - ${r.code}${r.path === null ? "" : ` at ${r.path}`}: ${r.message}`),
      ];
    case "route_selection":
      return [`- route_selection ${input.evaluationId} selected ${input.selectedLabel}`];
    case "coordinator_turn":
      return [
        `- coordinator_turn ${input.purpose} turn ${input.turnsUsed} of ${input.bounds.maxCoordinatorInvocations} max_tasks ${input.bounds.maxTasks} max_concurrent_workers ${input.bounds.maxConcurrentWorkers} unresolved ${list(input.blockerKeys)}`,
        ...(input.tasks.length === 0 ? ["  tasks: none"] : input.tasks.map((t) => `  - ${t.taskId} [${t.status}]${t.replacesTaskId === null ? "" : ` replaces ${t.replacesTaskId}`}${t.supersededByTaskId === null ? "" : ` superseded_by ${t.supersededByTaskId}`} outputs ${list(t.outputArtifactIds)}: ${t.subject}`)),
      ];
    case "coordinator_blocker": {
      const b = input.blocker;
      if (b.kind === "task_failed") return [`- coordinator_blocker task_failed ${b.taskId} ${b.failureReason}`];
      if (b.kind === "task_blocked") return [`- coordinator_blocker task_blocked ${b.taskId} ${b.blockReason.kind}${"taskId" in b.blockReason ? ` ${b.blockReason.taskId}` : ""}${"decisionId" in b.blockReason ? ` ${b.blockReason.decisionId}` : ""}${"description" in b.blockReason ? `: ${b.blockReason.description}` : ""}`];
      if (b.kind === "gate_failed") return [`- coordinator_blocker gate_failed ${b.gateId} remediation_task ${b.taskId}`];
      return [`- coordinator_blocker integration_conflict ${b.taskId} invocation ${b.invocationId} changeset ${b.changesetId} conflict_task ${b.conflictTaskId} report ${b.reportArtifactId ?? NONE}`];
    }
    case "optimizer_candidate":
      return [`- optimizer_candidate round ${input.round} of ${input.maxRounds} snapshot ${input.snapshotId} artifacts ${list(input.artifactIds)} evaluated_criteria ${list(input.acceptanceCriterionIds)}`];
    case "optimizer_feedback":
      return [`- optimizer_feedback round ${input.round} verdict ${input.verdict} evaluation ${input.evaluationId}`, ...(input.evidence.length === 0 ? ["  evidence: none"] : input.evidence.map((e) => `  - ${renderEvidence(e)}`))];
  }
}

/** One structural completion condition as ids and closed facts. */
function renderCondition(condition: CompletionCondition): string {
  switch (condition.kind) {
    case "requirement_unsatisfied":
      return `requirement ${condition.requirementId} ${condition.status}`;
    case "task_unfinished":
      return `task ${condition.taskId} ${condition.status}`;
    case "decision_unresolved":
      return `decision ${condition.decisionId}`;
    case "changeset_unintegrated":
      return `changeset ${condition.changesetId} ${condition.status}`;
    case "node_gate_open":
      return `gate ${condition.gateId} of plan_node ${condition.planNodeId}`;
    case "node_unfinished":
      return `plan_node ${condition.planNodeId} ${condition.status}`;
    case "criterion_unjudged":
      return `criterion ${condition.acceptanceCriterionId}`;
    case "snapshot_moved":
      return `snapshot ${condition.pinnedSnapshotId} moved to ${condition.currentSnapshotId ?? NONE}`;
  }
}

/** One Evidence reference as ids and closed facts; never content. */
function renderEvidence(evidence: Evidence): string {
  switch (evidence.kind) {
    case "artifact":
      return `artifact ${evidence.artifactId}`;
    case "command":
      return `command exit ${evidence.exitCode} output ${evidence.outputArtifactId}${evidence.outputTruncated ? " (truncated)" : ""}: ${evidence.command}`;
    case "evaluation":
      return `evaluation ${evidence.evaluationId}`;
    case "file":
      return `file ${evidence.path} at ${evidence.snapshotId}`;
    case "snapshot":
      return `snapshot ${evidence.snapshotId}`;
    case "url":
      return `url ${evidence.url}`;
  }
}

/** Renders one manifest (and, for a retry, its appendix) to the exact provider input. */
export function renderManifest(manifest: ContextManifest, appendix: RetryAppendix | null = null): RenderedInput {
  if (manifest.rendererVersion !== MANIFEST_RENDERER_VERSION) {
    throw new Error(`Context Manifest ${manifest.id} was assembled for renderer version ${manifest.rendererVersion}; this runtime renders version ${MANIFEST_RENDERER_VERSION}`);
  }
  const c = manifest.content;
  const lines: string[] = [
    `# Context Manifest v${manifest.rendererVersion}`,
    line("manifest", `${manifest.id} digest ${manifest.digest}`),
    line("invocation", `${manifest.invocationId} role ${c.role} purpose ${c.purpose}`),
    line("run", c.runId),
    line("plan_node", c.planNodeId),
    line("pattern_position", c.patternPosition === null ? null : renderPatternPosition(c.patternPosition)),
    line("predecessor_invocation", c.continuedFromInvocationId),
    line("agent_definition", `${c.agentDefinitionRevisionId} hash ${c.agentDefinitionContentHash}`),
    line("model", `${c.modelPolicy.model} effort ${c.modelPolicy.effort} max_context_occupancy ${c.modelPolicy.maxContextOccupancy}`),
    line("allocation", `cost_usd ${c.allocation.costUsd} tokens ${c.allocation.tokens} attempts ${c.allocation.attempts} source ${c.allocationSource} final_reserve_use ${c.finalReserveUse ?? NONE}`),
    line("max_wall_clock_ms", c.maxWallClockMs),
    line("starting_snapshot", c.startingSnapshotId),
    line("worktree", c.worktreePath),
    "",
    "## Instructions",
    ...fenced(c.instructions),
    "",
    "## Inputs",
    ...(c.inputs.length === 0 ? [NONE] : c.inputs.flatMap(renderInput)),
    "",
    "## Tasks",
    ...(c.tasks.length === 0 ? [NONE] : c.tasks.map((t) => `- ${t.taskId}: ${t.subject}`)),
    "",
    `## Requirements (revision ${c.requirementRevisionId ?? NONE})`,
    ...(c.requirements.length === 0 ? [NONE] : c.requirements.map((r) => `- ${r.requirementId} [${r.status}] criteria ${list(r.acceptanceCriterionIds)}: ${r.statement}`)),
    "",
    "## Acceptance Criteria",
    ...(c.acceptanceCriteria.length === 0
      ? [NONE]
      : c.acceptanceCriteria.map((a) => {
          const owner = a.requirementId !== null ? `requirement ${a.requirementId}` : `task ${a.taskId ?? NONE}`;
          const check = a.check.kind === "deterministic" ? `deterministic exit ${a.check.expectedExitCode}: ${a.check.command}` : `evaluated: ${a.check.question}${a.check.rubric === null ? "" : ` (rubric: ${a.check.rubric})`}`;
          return `- ${a.acceptanceCriterionId} (${owner}) ${check}`;
        })),
    "",
    "## Decisions",
    ...(c.decisions.length === 0 ? [NONE] : c.decisions.map((d) => `- ${d.decisionId} ${d.kind}: ${d.chosenOptionId ?? "open"}${d.resolvedSincePrevious ? " (resolved since previous invocation)" : ""}`)),
    "",
    "## Handoffs",
    ...(c.handoffs.length === 0
      ? [NONE]
      : c.handoffs.map((h) => {
          const source = h.source.kind === "plan_node" ? `plan_node ${h.source.planNodeId}` : `invocation ${h.source.invocationId}`;
          return `- ${h.handoffId} from ${source} tasks ${list(h.taskIds)} artifacts ${list(h.artifactIds)}: ${h.summary}`;
        })),
    "",
    "## Artifacts",
    ...(c.artifacts.length === 0 ? [NONE] : c.artifacts.map((a) => `- ${a.artifactId} ${a.mediaType} ${a.byteSize} bytes: ${a.title ?? "untitled"}`)),
    "",
    "## Capabilities",
    line("tools", list(c.capabilities.tools)),
    line("mcp_servers", list(c.capabilities.mcpServers)),
    "",
    "## Tool Policy",
    ...(Object.keys(c.toolPolicy).length === 0 ? [NONE] : Object.keys(c.toolPolicy).sort().map((tool) => `- ${tool}: ${c.toolPolicy[tool]}`)),
    "",
    "## Runtime Tools",
    ...(c.runtimeTools.length === 0 ? [NONE] : c.runtimeTools.map((t) => `- ${t}`)),
    "",
    "## Approved Calls",
    ...(c.approvedCalls.length === 0 ? [NONE] : c.approvedCalls.map((a) => `- ${a.tool} ${a.callDigest} once, by decision ${a.decisionId}`)),
  ];
  if (appendix !== null) {
    lines.push(
      "",
      "## Retry",
      line("attempt", `${appendix.attemptNumber} of ${appendix.maxAttempts} (${Math.max(0, appendix.maxAttempts - appendix.attemptNumber)} remaining after this one)`),
      line("prior_attempt", appendix.priorAttemptId),
      line("failure_class", appendix.failureClass),
      line("detail", appendix.detail.message),
      line("tool", appendix.detail.tool),
      "violations:",
      ...(appendix.detail.violations.length === 0 ? [NONE] : appendix.detail.violations.map((v) => `- ${v.code}${v.path === null ? "" : ` at ${v.path}`}: ${v.message}`)),
    );
  }
  const text = `${lines.join("\n")}\n`;
  return { rendererVersion: manifest.rendererVersion, text, digest: sha256Hex(text) };
}
