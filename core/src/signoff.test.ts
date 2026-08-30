import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import { manifestInputSchema } from "./invocations.ts";
import { runSchema, type Run } from "./runs.ts";
import { SIGNOFF_REFUSAL_CODES, SIGNOFF_RESOLUTION_OUTCOMES, SignoffRefusedError, signoffResolutionInputSchema, signoffResolutionSchema, type SignoffResolution } from "./signoff.ts";
import { gateSchema, type Gate } from "./verification.ts";
import { CHANGESET_INTEGRATION_STATUSES, CHANGESET_KINDS, changesetInputSchema, changesetSchema, finalChangesetInputSchema, INVOCATION_CHANGESET_STATUSES, type Changeset } from "./workspace-state.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const resolution = (overrides: Partial<SignoffResolution> = {}): SignoffResolution => ({
  id: newId("signoffResolution"),
  runId: newId("run"),
  gateId: newId("gate"),
  decisionId: newId("decision"),
  outcome: "accept",
  operatorMessageId: null,
  finalChangesetId: newId("changeset"),
  followUpInvocationId: null,
  resolvedAt: NOW,
  ...overrides,
});

const changeset = (overrides: Partial<Changeset> = {}): Changeset => ({
  id: newId("changeset"),
  runId: newId("run"),
  kind: "invocation",
  invocationId: newId("invocation"),
  beforeSnapshotId: newId("snapshot"),
  afterSnapshotId: newId("snapshot"),
  diffArtifactId: newId("artifact"),
  integrationStatus: "pending",
  integratedSnapshotId: null,
  conflictTaskId: null,
  createdAt: NOW,
  integratedAt: null,
  ...overrides,
});

const run = (overrides: Partial<Run> = {}): Run => ({
  id: newId("run"),
  conversationId: newId("conversation"),
  workspaceId: newId("workspace"),
  kind: "code",
  status: "awaiting_signoff",
  waitReason: null,
  target: { kind: "branch", branch: "main" },
  budget: { maxCostUsd: 10, maxTokens: 1000, maxAttempts: 10, maxWallClockMs: null, maxConcurrency: null },
  finalReserve: { costUsd: 1, tokens: 100, attempts: 1 },
  verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, maxNodeGateCycles: 3, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [] },
  baseSnapshotId: newId("snapshot"),
  integrationSnapshotId: null,
  finalSnapshotId: null,
  finalChangesetId: null,
  integrationWorkspacePath: "/w",
  failure: null,
  createdAt: NOW,
  updatedAt: NOW,
  endedAt: null,
  ...overrides,
});

const gate = (overrides: Partial<Gate> = {}): Gate => ({
  id: newId("gate"),
  runId: newId("run"),
  planNodeId: null,
  kind: "operator_signoff",
  ordinal: 1,
  status: "failed",
  acceptanceCriterionIds: [],
  snapshotId: newId("snapshot"),
  candidateArtifactIds: [],
  completionRequestId: newId("completionRequest"),
  requirementRevisionId: newId("requirementRevision"),
  requirementIds: [],
  completionGateId: newId("gate"),
  reportArtifactId: newId("artifact"),
  failure: { kind: "changes_requested", decisionId: newId("decision") },
  openedAt: NOW,
  closedAt: NOW,
  ...overrides,
});

describe("Signoff Resolution", () => {
  it("has exactly the signoff Decision's two outcomes and a closed refusal set", () => {
    expect(SIGNOFF_RESOLUTION_OUTCOMES).toEqual(["accept", "request_changes"]);
    expect(SIGNOFF_REFUSAL_CODES).toEqual(["run_not_awaiting_signoff", "gate_mismatch", "decision_mismatch", "boundary_inconsistent", "conflicting_resolution", "active_state", "workspace_drifted", "finalization_failed", "operator_message_invalid", "ordinary_capacity_insufficient"]);
    const error = new SignoffRefusedError("workspace_drifted", "drifted", { gateId: "gate_x" });
    expect(error).toMatchObject({ code: "conflict", refusal: "workspace_drifted", details: { refusal: "workspace_drifted", gateId: "gate_x" } });
  });

  it("an accept names the final Changeset and no message or follow-up; a request_changes names the message and no final Changeset", () => {
    expect(signoffResolutionSchema.safeParse(resolution()).success).toBe(true);
    expect(signoffResolutionSchema.safeParse(resolution({ finalChangesetId: null })).success).toBe(false);
    expect(signoffResolutionSchema.safeParse(resolution({ operatorMessageId: newId("conversationMessage") })).success).toBe(false);
    expect(signoffResolutionSchema.safeParse(resolution({ followUpInvocationId: newId("invocation") })).success).toBe(false);
    const changes = resolution({ outcome: "request_changes", finalChangesetId: null, operatorMessageId: newId("conversationMessage") });
    expect(signoffResolutionSchema.safeParse(changes).success).toBe(true);
    expect(signoffResolutionSchema.safeParse({ ...changes, followUpInvocationId: newId("invocation") }).success).toBe(true);
    expect(signoffResolutionSchema.safeParse({ ...changes, operatorMessageId: null }).success).toBe(false);
    expect(signoffResolutionSchema.safeParse({ ...changes, finalChangesetId: newId("changeset") }).success).toBe(false);
    expect(signoffResolutionSchema.safeParse(resolution({ outcome: "reject" as never })).success).toBe(false);
    // The input is a closed discriminated union: an outcome never carries the other outcome's field.
    expect(signoffResolutionInputSchema.safeParse({ runId: newId("run"), gateId: newId("gate"), decisionId: newId("decision"), outcome: "accept", finalChangesetId: newId("changeset") }).success).toBe(true);
    expect(signoffResolutionInputSchema.safeParse({ runId: newId("run"), gateId: newId("gate"), decisionId: newId("decision"), outcome: "accept", operatorMessageId: newId("conversationMessage") }).success).toBe(false);
    expect(signoffResolutionInputSchema.safeParse({ runId: newId("run"), gateId: newId("gate"), decisionId: newId("decision"), outcome: "request_changes", operatorMessageId: newId("conversationMessage") }).success).toBe(true);
  });

  it("the signoff_resolution manifest input carries ids and the closed outcome only, with distinct Gates", () => {
    const input = { kind: "signoff_resolution", signoffResolutionId: newId("signoffResolution"), gateId: newId("gate"), decisionId: newId("decision"), completionGateId: newId("gate"), outcome: "request_changes", operatorMessageId: newId("conversationMessage"), verifiedSnapshotId: newId("snapshot"), reportArtifactId: newId("artifact") };
    expect(manifestInputSchema.safeParse(input).success).toBe(true);
    expect(manifestInputSchema.safeParse({ ...input, outcome: "accept" }).success).toBe(false);
    expect(manifestInputSchema.safeParse({ ...input, completionGateId: input.gateId }).success).toBe(false);
    expect(manifestInputSchema.safeParse({ ...input, content: "please change" }).success).toBe(false);
  });
});

describe("final and invocation Changesets", () => {
  it("are the two closed kinds; the final Changeset is recorded and names no Invocation, an invocation Changeset names its writer and lives in the integration lifecycle", () => {
    expect(CHANGESET_KINDS).toEqual(["invocation", "final"]);
    expect(CHANGESET_INTEGRATION_STATUSES).toEqual(["pending", "integrated", "conflict", "recorded"]);
    expect(INVOCATION_CHANGESET_STATUSES).toEqual(["pending", "integrated", "conflict"]);
    expect(changesetSchema.safeParse(changeset()).success).toBe(true);
    expect(changesetSchema.safeParse(changeset({ integrationStatus: "integrated", integratedSnapshotId: newId("snapshot"), integratedAt: NOW })).success).toBe(true);
    // An invocation Changeset cannot claim the final state and always names its Invocation.
    expect(changesetSchema.safeParse(changeset({ integrationStatus: "recorded" })).success).toBe(false);
    expect(changesetSchema.safeParse(changeset({ invocationId: null })).success).toBe(false);
    // The final Changeset is recorded from creation and never pending, integrated, or in conflict; it has no Invocation, integration, or conflict fact.
    const final = changeset({ kind: "final", invocationId: null, integrationStatus: "recorded" });
    expect(changesetSchema.safeParse(final).success).toBe(true);
    expect(changesetSchema.safeParse({ ...final, integrationStatus: "pending" }).success).toBe(false);
    expect(changesetSchema.safeParse({ ...final, integrationStatus: "integrated", integratedSnapshotId: newId("snapshot"), integratedAt: NOW }).success).toBe(false);
    expect(changesetSchema.safeParse({ ...final, integrationStatus: "conflict", conflictTaskId: newId("task") }).success).toBe(false);
    expect(changesetSchema.safeParse({ ...final, invocationId: newId("invocation") }).success).toBe(false);
    expect(changesetSchema.safeParse({ ...final, conflictTaskId: newId("task") }).success).toBe(false);
    // Inputs: an invocation Changeset input requires its Invocation; the final input has none.
    expect(changesetInputSchema.safeParse({ runId: newId("run"), invocationId: null, beforeSnapshotId: newId("snapshot"), afterSnapshotId: newId("snapshot"), diffArtifactId: newId("artifact") }).success).toBe(false);
    expect(finalChangesetInputSchema.safeParse({ runId: newId("run"), beforeSnapshotId: newId("snapshot"), afterSnapshotId: newId("snapshot"), diffArtifactId: newId("artifact") }).success).toBe(true);
    expect(finalChangesetInputSchema.safeParse({ runId: newId("run"), invocationId: null, beforeSnapshotId: newId("snapshot"), afterSnapshotId: newId("snapshot"), diffArtifactId: newId("artifact") }).success).toBe(false);
  });

  it("a completed Run carries both final references and no other Run carries either", () => {
    expect(runSchema.safeParse(run()).success).toBe(true);
    expect(runSchema.safeParse(run({ finalSnapshotId: newId("snapshot") })).success).toBe(false);
    expect(runSchema.safeParse(run({ finalChangesetId: newId("changeset") })).success).toBe(false);
    const completed = run({ status: "completed", endedAt: NOW, finalSnapshotId: newId("snapshot"), finalChangesetId: newId("changeset") });
    expect(runSchema.safeParse(completed).success).toBe(true);
    expect(runSchema.safeParse({ ...completed, finalChangesetId: null }).success).toBe(false);
    expect(runSchema.safeParse({ ...completed, finalSnapshotId: null }).success).toBe(false);
    expect(runSchema.safeParse({ ...completed, status: "failed", failure: { kind: "root_node_failed", summary: "x", evidenceArtifactIds: [] } }).success).toBe(false);
  });

  it("changes_requested is the one failure of an operator_signoff Gate and of no other Gate", () => {
    expect(gateSchema.safeParse(gate()).success).toBe(true);
    expect(gateSchema.safeParse(gate({ failure: { kind: "criteria_failed", acceptanceCriterionIds: [newId("acceptanceCriterion")] } })).success).toBe(false);
    expect(gateSchema.safeParse(gate({ failure: { kind: "evaluator_failed", invocationId: newId("invocation") } })).success).toBe(false);
    expect(gateSchema.safeParse(gate({ kind: "run_completion", completionGateId: null, reportArtifactId: null, acceptanceCriterionIds: [newId("acceptanceCriterion")] })).success).toBe(false);
    expect(gateSchema.safeParse(gate({ kind: "node_exit", planNodeId: newId("planNode"), completionRequestId: null, requirementRevisionId: null, completionGateId: null, reportArtifactId: null })).success).toBe(false);
    // A passed signoff Gate records no failure.
    expect(gateSchema.safeParse(gate({ status: "passed", failure: null })).success).toBe(true);
  });
});
