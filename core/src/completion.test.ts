/**
 * Completion contracts (execution-model §10 `run_completion`): the closed
 * Completion Request lifecycle, the completion-only Gate identity and
 * failure kinds, the typed final report, the `signoff` Decision subject, the
 * read-only `final_synthesis` capability policy, and the executable
 * `request_completion` runtime tool.
 */
import { describe, expect, it } from "vitest";
import { capabilityPolicyFor, effectiveCapabilityPolicy } from "./capability-policy.ts";
import { canonicalFinalReport, COMPLETION_REQUEST_MACHINE, completionRequestSchema, FINAL_REPORT_MEDIA_TYPE, finalReportSchema, finalSynthesisResultSchema, FINAL_SYNTHESIS_MAX_ITEMS } from "./completion.ts";
import { decisionRequestSchema, SIGNOFF_OPTIONS, signoffSubjectOf } from "./decisions.ts";
import { newId } from "./ids.ts";
import { gateOwnershipDefects, invocationResultSchema, manifestInputSchema } from "./invocations.ts";
import { verificationPolicySchema, MAX_RUN_COMPLETION_CYCLES } from "./runs.ts";
import { canonicalRuntimeToolCall, effectiveRuntimeTools, RUNTIME_TOOL_HANDLER_BINDINGS, runtimeToolCallRequestSchema, runtimeToolsFor } from "./runtime-tools.ts";
import { gateInputSchema, gateSchema } from "./verification.ts";

const runId = newId("run");
const invocationId = newId("invocation");
const callId = newId("runtimeToolCall");
const gateId = newId("gate");
const artifactId = newId("artifact");
const snapshotId = newId("snapshot");
const revisionId = newId("requirementRevision");
const requestId = newId("completionRequest");
const now = "2026-01-01T00:00:00.000Z";

describe("verification policy", () => {
  it("declares completion cycles and criteria, bounded and canonically ordered", () => {
    const a = newId("acceptanceCriterion");
    const b = newId("acceptanceCriterion");
    const [first, second] = [a, b].sort();
    const base = { evaluatorAgentDefinitionRevisionId: null, maxNodeGateCycles: 3 };
    expect(verificationPolicySchema.safeParse({ ...base, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [first, second] }).success).toBe(true);
    expect(verificationPolicySchema.safeParse({ ...base, maxRunCompletionCycles: 0, runCompletionAcceptanceCriterionIds: [] }).success).toBe(false);
    expect(verificationPolicySchema.safeParse({ ...base, maxRunCompletionCycles: MAX_RUN_COMPLETION_CYCLES + 1, runCompletionAcceptanceCriterionIds: [] }).success).toBe(false);
    expect(verificationPolicySchema.safeParse({ ...base, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [second, first] }).success).toBe(false);
    expect(verificationPolicySchema.safeParse({ ...base, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [first, first] }).success).toBe(false);
    expect(verificationPolicySchema.safeParse(base).success).toBe(false);
  });
});

describe("Completion Request", () => {
  const base = { id: requestId, runId, invocationId, runtimeToolCallId: callId, status: "requested" as const, gateId: null, reportArtifactId: null, outcome: null, createdAt: now, startedAt: null, endedAt: null };
  const ok = (value: unknown) => completionRequestSchema.safeParse(value).success;

  it("has a closed lifecycle: requested → verifying → passed | failed, requested → cancelled, terminal states final", () => {
    expect(COMPLETION_REQUEST_MACHINE.table.requested).toEqual(["verifying", "cancelled"]);
    expect(COMPLETION_REQUEST_MACHINE.table.verifying).toEqual(["passed", "failed"]);
    expect(COMPLETION_REQUEST_MACHINE.isTerminal("passed")).toBe(true);
    expect(COMPLETION_REQUEST_MACHINE.isTerminal("failed")).toBe(true);
    expect(COMPLETION_REQUEST_MACHINE.isTerminal("cancelled")).toBe(true);
    expect(COMPLETION_REQUEST_MACHINE.isTerminal("verifying")).toBe(false);
  });

  it("ties every status to its facts: the Gate from verifying on, the report exactly when passed, the outcome exactly when failed or cancelled", () => {
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, gateId })).toBe(false);
    expect(ok({ ...base, status: "verifying", gateId, startedAt: now })).toBe(true);
    expect(ok({ ...base, status: "verifying", gateId: null, startedAt: now })).toBe(false);
    expect(ok({ ...base, status: "verifying", gateId, startedAt: null })).toBe(false);
    expect(ok({ ...base, status: "passed", gateId, startedAt: now, endedAt: now, reportArtifactId: artifactId })).toBe(true);
    expect(ok({ ...base, status: "passed", gateId, startedAt: now, endedAt: now, reportArtifactId: null })).toBe(false);
    expect(ok({ ...base, status: "passed", gateId, startedAt: now, endedAt: null, reportArtifactId: artifactId })).toBe(false);
    const failed = { ...base, status: "failed" as const, gateId, startedAt: now, endedAt: now, outcome: { kind: "criteria_failed" as const, acceptanceCriterionIds: [newId("acceptanceCriterion")] } };
    expect(ok(failed)).toBe(true);
    expect(ok({ ...failed, outcome: null })).toBe(false);
    // A verification failure outcome belongs to `failed`; a cancellation outcome to `cancelled`.
    expect(ok({ ...failed, outcome: { kind: "preconditions_changed", codes: ["node_active"] } })).toBe(false);
    const cancelled = { ...base, status: "cancelled" as const, endedAt: now, outcome: { kind: "requesting_turn_failed" as const, invocationId } };
    expect(ok(cancelled)).toBe(true);
    expect(ok({ ...cancelled, outcome: { kind: "criteria_failed", acceptanceCriterionIds: [newId("acceptanceCriterion")] } })).toBe(false);
    expect(ok({ ...cancelled, outcome: { kind: "preconditions_changed", codes: [] } })).toBe(false);
    expect(ok({ ...cancelled, outcome: { kind: "final_reserve_exhausted", use: "final_synthesis" } })).toBe(false);
    expect(ok({ ...failed, outcome: { kind: "final_reserve_exhausted", use: "run_completion" } })).toBe(true);
    expect(ok({ ...failed, outcome: { kind: "conditions_unmet", conditions: [] } })).toBe(false);
    expect(ok({ ...failed, outcome: { kind: "conditions_unmet", conditions: [{ kind: "task_unfinished", taskId: newId("task"), status: "blocked" }] } })).toBe(true);
  });
});

describe("Run Gates", () => {
  const nodeExit = { runId, planNodeId: newId("planNode"), kind: "node_exit" as const, acceptanceCriterionIds: [], snapshotId, candidateArtifactIds: [] };
  const completion = { runId, planNodeId: null, kind: "run_completion" as const, acceptanceCriterionIds: [], snapshotId, candidateArtifactIds: [], completionRequestId: requestId, requirementRevisionId: revisionId, requirementIds: [] };
  const ok = (value: unknown) => gateInputSchema.safeParse(value).success;

  it("names the Completion Request, pinned Requirement revision, and leaf Requirements of a Run Gate and nothing of them on a node_exit Gate", () => {
    expect(ok(nodeExit)).toBe(true);
    expect(ok({ ...nodeExit, snapshotId: null })).toBe(false);
    expect(ok({ ...nodeExit, completionRequestId: requestId })).toBe(false);
    expect(ok({ ...nodeExit, requirementIds: [newId("requirement")] })).toBe(false);
    expect(ok(completion)).toBe(true);
    expect(ok({ ...completion, completionRequestId: null })).toBe(false);
    expect(ok({ ...completion, requirementRevisionId: null })).toBe(false);
    expect(ok({ ...completion, snapshotId: null })).toBe(false);
    expect(ok({ ...completion, planNodeId: newId("planNode") })).toBe(false);
    expect(ok({ ...completion, completionGateId: gateId })).toBe(false);
    expect(ok({ ...completion, reportArtifactId: artifactId })).toBe(false);
    const [a, b] = [newId("requirement"), newId("requirement")].sort();
    expect(ok({ ...completion, requirementIds: [a, b] })).toBe(true);
    expect(ok({ ...completion, requirementIds: [b, a] })).toBe(false);
    const signoff = { ...completion, kind: "operator_signoff" as const, completionGateId: gateId, reportArtifactId: artifactId };
    expect(ok(signoff)).toBe(true);
    expect(ok({ ...signoff, completionGateId: null })).toBe(false);
    expect(ok({ ...signoff, reportArtifactId: null })).toBe(false);
    expect(ok({ ...signoff, acceptanceCriterionIds: [newId("acceptanceCriterion")] })).toBe(false);
  });

  it("records the final report exactly when a run_completion Gate passed, and admits the completion-only failure kinds on a run_completion Gate alone", () => {
    const open = { id: gateId, ...completion, ordinal: 1, status: "open" as const, completionGateId: null, reportArtifactId: null, failure: null, openedAt: now, closedAt: null };
    expect(gateSchema.safeParse(open).success).toBe(true);
    expect(gateSchema.safeParse({ ...open, status: "passed", closedAt: now, reportArtifactId: artifactId }).success).toBe(true);
    expect(gateSchema.safeParse({ ...open, status: "passed", closedAt: now }).success).toBe(false);
    expect(gateSchema.safeParse({ ...open, reportArtifactId: artifactId }).success).toBe(false);
    const conditions = { kind: "conditions_unmet" as const, conditions: [{ kind: "snapshot_moved" as const, pinnedSnapshotId: snapshotId, currentSnapshotId: null }] };
    expect(gateSchema.safeParse({ ...open, status: "failed", closedAt: now, failure: conditions }).success).toBe(true);
    expect(gateSchema.safeParse({ ...open, status: "failed", closedAt: now, failure: { kind: "final_reserve_exhausted", use: "final_synthesis" } }).success).toBe(true);
    const node = { id: newId("gate"), ...nodeExit, ordinal: 1, status: "failed" as const, completionRequestId: null, requirementRevisionId: null, requirementIds: [], completionGateId: null, reportArtifactId: null, failure: conditions, openedAt: now, closedAt: now };
    expect(gateSchema.safeParse(node).success).toBe(false);
    expect(gateSchema.safeParse({ ...node, failure: { kind: "evaluator_failed", invocationId } }).success).toBe(true);
  });
});

describe("final synthesis", () => {
  const report = { summary: "Added the flag.", completed: ["--version prints the version"], verification: ["npm test passed"], risks: [], followUps: ["document the flag"] };

  it("bounds the typed report and serializes the canonical final-report Artifact deterministically", () => {
    expect(finalSynthesisResultSchema.safeParse(report).success).toBe(true);
    expect(finalSynthesisResultSchema.safeParse({ ...report, summary: "" }).success).toBe(false);
    expect(finalSynthesisResultSchema.safeParse({ ...report, completed: Array.from({ length: FINAL_SYNTHESIS_MAX_ITEMS + 1 }, () => "x") }).success).toBe(false);
    expect(finalSynthesisResultSchema.safeParse({ ...report, risks: ["y".repeat(301)] }).success).toBe(false);
    expect(finalSynthesisResultSchema.safeParse({ ...report, extra: 1 }).success).toBe(false);
    const document = { version: 1 as const, runId, completionRequestId: requestId, gateId, snapshotId, requirementRevisionId: revisionId, report };
    expect(finalReportSchema.safeParse(document).success).toBe(true);
    expect(canonicalFinalReport(document)).toBe(canonicalFinalReport({ ...document, report: { followUps: report.followUps, risks: [], verification: report.verification, completed: report.completed, summary: report.summary } }));
    expect(canonicalFinalReport(document).startsWith('{"completionRequestId":')).toBe(true);
    expect(FINAL_REPORT_MEDIA_TYPE).toBe("application/vnd.agentique.final-report.v1+json");
  });

  it("returns the report only from a completed result, exclusive with the other typed members and never with a Run outcome", () => {
    const base = { status: "completed" as const, artifactIds: [], tasks: [], evidence: [], summary: "ok", openItems: [], blocker: null, runOutcome: null, routeSelection: null, evaluation: null, finalReport: null };
    expect(invocationResultSchema.safeParse({ ...base, finalReport: report }).success).toBe(true);
    expect(invocationResultSchema.safeParse({ ...base, status: "failed", finalReport: report }).success).toBe(false);
    expect(invocationResultSchema.safeParse({ ...base, finalReport: report, routeSelection: { selectedLabel: "a" } }).success).toBe(false);
    expect(invocationResultSchema.safeParse({ ...base, finalReport: report, runOutcome: { kind: "infeasible", evidence: [{ kind: "artifact", artifactId }] } }).success).toBe(false);
  });

  it("is Gate-owned at the orchestrator position and read-only by purpose, whatever the definition declares", () => {
    const synthesis = { role: "orchestrator" as const, purpose: "final_synthesis" as const, patternPosition: { kind: "orchestrator" as const }, gateId, taskIds: [] };
    expect(gateOwnershipDefects(synthesis)).toEqual([]);
    expect(gateOwnershipDefects({ ...synthesis, gateId: null })).toHaveLength(1);
    expect(gateOwnershipDefects({ ...synthesis, purpose: "operator_input", gateId })).not.toEqual([]);
    expect(gateOwnershipDefects({ ...synthesis, taskIds: [newId("task")] })).not.toEqual([]);
    expect(capabilityPolicyFor("orchestrator", "final_synthesis")).toEqual({ tools: ["read", "search"], mcpServers: false });
    expect(capabilityPolicyFor("orchestrator", "operator_input")).toEqual({ tools: null, mcpServers: true });
    const revision = { capabilities: { tools: ["read", "write", "shell", "search"], mcpServers: ["github"] }, toolPolicy: { shell: "approval_required" as const } };
    const workspace = { deniedTools: [], approvalRequiredTools: [], deniedMcpServers: [] };
    expect(effectiveCapabilityPolicy(revision, "orchestrator", workspace, "final_synthesis")).toEqual({ capabilities: { tools: ["read", "search"], mcpServers: [] }, toolPolicy: { read: "allowed", search: "allowed", shell: "denied", write: "denied" } });
    expect(effectiveCapabilityPolicy(revision, "orchestrator", workspace, "operator_input").capabilities).toEqual({ tools: ["read", "search", "shell", "write"], mcpServers: ["github"] });
    // The final-synthesis manifest input is typed and canonically ordered.
    const input = { kind: "final_synthesis", completionRequestId: requestId, gateId, snapshotId, requirementRevisionId: revisionId, requirements: [], evaluations: [], tasks: [], artifactIds: [], usage: { costUsd: 1, tokens: 10, attempts: 1 }, finalReserve: { limit: { costUsd: 2, tokens: 20, attempts: 2 }, consumed: { costUsd: 0, tokens: 0, attempts: 0 } }, unresolved: [] };
    expect(manifestInputSchema.safeParse(input).success).toBe(true);
    const [a, b] = [newId("requirement"), newId("requirement")].sort();
    expect(manifestInputSchema.safeParse({ ...input, requirements: [{ requirementId: b, status: "satisfied", waiverDecisionId: null }, { requirementId: a, status: "waived", waiverDecisionId: newId("decision") }] }).success).toBe(false);
    // A run_completion candidate names its request and revision; a node_exit candidate names neither and carries no ledger.
    const candidate = { kind: "gate_candidate", gateId, gateKind: "run_completion", snapshotId, artifactIds: [], acceptanceCriterionIds: [], completionRequestId: requestId, requirementRevisionId: revisionId, tasks: [] };
    expect(manifestInputSchema.safeParse(candidate).success).toBe(true);
    expect(manifestInputSchema.safeParse({ ...candidate, completionRequestId: null }).success).toBe(false);
    expect(manifestInputSchema.safeParse({ ...candidate, gateKind: "node_exit", completionRequestId: null, requirementRevisionId: null }).success).toBe(true);
    expect(manifestInputSchema.safeParse({ ...candidate, gateKind: "node_exit" }).success).toBe(false);
  });
});

describe("signoff Decision", () => {
  const subject = { kind: "signoff" as const, runId, gateId, completionGateId: newId("gate"), completionRequestId: requestId, snapshotId, reportArtifactId: artifactId };
  const request = {
    conversationId: newId("conversation"),
    runId,
    kind: "signoff" as const,
    resolutionPolicy: "operator_required" as const,
    requestedBy: { kind: "runtime" as const },
    question: "Accept the verified result?",
    options: SIGNOFF_OPTIONS.map((id) => ({ id, label: id, description: null })),
    recommendedOptionId: null,
    rationale: null,
    affects: { requirementIds: [], taskIds: [], planNodeIds: [] },
    deadlineAt: null,
    activationCondition: null,
    subject,
    supersedesDecisionId: null,
  };

  it("carries exactly its typed subject and the accept / request_changes options, is operator_required, and names its own Run", () => {
    expect(decisionRequestSchema.safeParse(request).success).toBe(true);
    expect(decisionRequestSchema.safeParse({ ...request, subject: null }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request, options: [{ id: "accept", label: "accept", description: null }] }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request, resolutionPolicy: "use_default_after_deadline", recommendedOptionId: "accept", rationale: "r", deadlineAt: now }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request, runId: null }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request, subject: { ...subject, runId: newId("run") } }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request, subject: { ...subject, completionGateId: gateId } }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request, kind: "operator_choice" }).success).toBe(false);
    expect(signoffSubjectOf({ id: newId("decision"), kind: "signoff", subject })).toEqual(subject);
    expect(() => signoffSubjectOf({ id: newId("decision"), kind: "operator_choice", subject: null })).toThrow(/not a signoff/);
  });
});

describe("request_completion runtime tool", () => {
  it("is executable for the root Orchestrator's ordinary turns only, with an empty canonical input", () => {
    expect(RUNTIME_TOOL_HANDLER_BINDINGS.request_completion).toEqual({ role: "orchestrator", purposes: ["operator_input", "plan_revision", "node_result", "decision_resolution", "gate_result"] });
    expect(runtimeToolsFor("orchestrator", "final_synthesis")).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions", "write_artifact", "return_result"]);
    for (const purpose of ["operator_input", "node_result", "decision_resolution", "gate_result", "plan_revision"] as const) {
      expect(effectiveRuntimeTools(runtimeToolsFor("orchestrator", purpose), "orchestrator", purpose)).toEqual(["request_completion"]);
    }
    expect(effectiveRuntimeTools(runtimeToolsFor("orchestrator", "final_synthesis"), "orchestrator", "final_synthesis")).toEqual([]);
    expect(effectiveRuntimeTools(runtimeToolsFor("coordinator", "decompose"), "coordinator", "decompose")).toEqual(["propose_tasks", "update_task"]);
    expect(effectiveRuntimeTools(runtimeToolsFor("worker", "step"), "worker", "step")).toEqual([]);
    expect(effectiveRuntimeTools(runtimeToolsFor("evaluator", "evaluate"), "evaluator", "evaluate")).toEqual([]);
    expect(runtimeToolCallRequestSchema.safeParse({ tool: "request_completion", input: {} }).success).toBe(true);
    expect(runtimeToolCallRequestSchema.safeParse({ tool: "request_completion", input: { summary: "done" } }).success).toBe(false);
    expect(canonicalRuntimeToolCall({ tool: "request_completion", input: {} })).toBe('{"input":{},"tool":"request_completion"}');
  });
});
